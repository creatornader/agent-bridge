import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as Database, SQLInputValue } from "node:sqlite";
import {
  cursorScope,
  decodeCursor,
  encodeCursor,
  type BridgeMessage,
  type BridgePrincipal,
  type JsonValue,
} from "./bridge-domain.js";
import type { MessagePage, MessageQuery } from "./bridge-store.js";
import { retrySqliteBusy } from "./sqlite-retry.js";
import { preparePrivateSqliteLocation, securePrivatePath, verifyPrivatePathAccess } from "./private-path.js";
import { assertEdgeUpgradeCandidate, installEdgeMarkers } from "./sqlite-database-contract.js";

const require = createRequire(import.meta.url);
function openDatabase(path: string): Database {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(path);
}
const MAX_SEQUENCE = 9_223_372_036_854_775_807n;

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS edge_scopes (
  scope_key TEXT PRIMARY KEY,
  endpoint_hash TEXT NOT NULL,
  workspace TEXT NOT NULL,
  agent TEXT NOT NULL,
  pull_cursor TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  last_outbound_sync_at TEXT,
  last_inbound_sync_at TEXT,
  last_attempt_at TEXT,
  cache_contract INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS edge_outbox (
  position INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key TEXT NOT NULL REFERENCES edge_scopes(scope_key),
  message_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'blocked')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  blocked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(scope_key, message_id),
  UNIQUE(scope_key, idempotency_key)
);
CREATE INDEX IF NOT EXISTS edge_outbox_due
  ON edge_outbox(scope_key, state, available_at, position);
CREATE TABLE IF NOT EXISTS edge_inbox (
  scope_key TEXT NOT NULL REFERENCES edge_scopes(scope_key),
  message_id TEXT NOT NULL,
  remote_sequence TEXT NOT NULL,
  sequence_key TEXT NOT NULL,
  workspace TEXT NOT NULL,
  project TEXT,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  thread_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  message_json TEXT NOT NULL,
  PRIMARY KEY(scope_key, message_id),
  UNIQUE(scope_key, sequence_key)
);
CREATE INDEX IF NOT EXISTS edge_inbox_cursor
  ON edge_inbox(scope_key, sequence_key);
CREATE INDEX IF NOT EXISTS edge_inbox_source
  ON edge_inbox(scope_key, source, sequence_key);
CREATE INDEX IF NOT EXISTS edge_inbox_thread
  ON edge_inbox(scope_key, thread_id, sequence_key);
CREATE INDEX IF NOT EXISTS edge_inbox_created
  ON edge_inbox(scope_key, created_at, sequence_key);
`;

type Row = Record<string, unknown>;
export type PendingMessage = Omit<BridgeMessage, "sequence" | "createdAt">;

export interface EdgeScope {
  endpoint: string;
  principal: BridgePrincipal;
}

export interface EdgeOutboxRecord {
  position: number;
  draft: PendingMessage;
  payloadHash: string;
  attempts: number;
  leaseToken: string;
  createdAt: string;
}

export interface EdgeEnqueueResult {
  draft: PendingMessage;
  created: boolean;
}

export interface EdgeStats {
  pending: number;
  due: number;
  scheduled: number;
  leased: number;
  blocked: number;
  cached: number;
  pullCursor?: string;
  lastSyncAt?: string;
  lastError?: string;
  oldestDueAt?: string;
  queueLagMs: number;
  oldestBlockedAt?: string;
  blockedAgeMs: number | null;
  blockedMaxAttempts: number;
  blockedLastError?: string;
  nextRetryAt?: string;
  lastOutboundSyncAt?: string;
  lastInboundSyncAt?: string;
  lastAttemptAt?: string;
}

export class EdgeConflictError extends Error {
  readonly code = "edge_idempotency_conflict";
}

function canonical(value: JsonValue | undefined): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function intent(message: PendingMessage | BridgeMessage): JsonValue {
  const deliveryPolicy = message.deliveryPolicy ?? (message.targets.length
    ? { mode: "leased", maxAttempts: 5, retryBaseDelayMs: 1_000, retryMaxDelayMs: 60_000, retryJitterRatio: 0.2 }
    : { mode: "mailbox" });
  return {
    workspace: message.workspace,
    project: message.project ?? null,
    source: message.source,
    type: message.type,
    content: message.content,
    contentType: message.contentType,
    data: message.data ?? null,
    targets: [...message.targets].sort(),
    threadId: message.threadId ?? null,
    replyToId: message.replyToId ?? null,
    correlationId: message.correlationId ?? null,
    causationId: message.causationId ?? null,
    priority: message.priority,
    expiresAt: message.expiresAt ?? null,
    atribReceiptId: message.atribReceiptId ?? null,
    informedBy: [...(message.informedBy ?? [])].sort(),
    metadata: message.metadata ?? null,
    deliveryPolicy: deliveryPolicy as unknown as JsonValue,
  };
}

export function edgeMessageFingerprint(message: PendingMessage | BridgeMessage): string {
  return createHash("sha256").update(canonical(intent(message))).digest("hex");
}

export function stableIdempotency(message: PendingMessage): PendingMessage {
  return message.idempotencyKey
    ? message
    : { ...message, idempotencyKey: `agent-bridge:id:${message.id}` };
}

export function edgeScopeKey(scope: EdgeScope): string {
  return createHash("sha256")
    .update(`${scope.endpoint.replace(/\/$/, "")}\0${scope.principal.workspace}\0${scope.principal.agent}`)
    .digest("hex");
}

function sequenceKey(sequence: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(sequence) || BigInt(sequence) > MAX_SEQUENCE) {
    throw new EdgeConflictError("remote sequence is invalid");
  }
  return sequence.padStart(19, "0");
}

function parseDraft(value: unknown): PendingMessage {
  return JSON.parse(String(value)) as PendingMessage;
}

function parseMessage(value: unknown): BridgeMessage {
  return JSON.parse(String(value)) as BridgeMessage;
}

export class SQLiteEdgeStore {
  private readonly db: Database;
  private readonly databasePath: string;
  private readonly preexistingFiles: ReadonlySet<string>;
  private readonly key: string;
  private initialized = false;
  private initialization?: Promise<void>;

  constructor(private readonly path: string, private readonly scope: EdgeScope, private readonly busyTimeoutMs = 2_000) {
    const selected = preparePrivateSqliteLocation(path, true);
    this.databasePath = selected;
    this.preexistingFiles = new Set(selected === ":memory:" ? [] : [selected, `${selected}-wal`, `${selected}-shm`].filter(existsSync));
    const before = selected === ":memory:" || !existsSync(selected) ? undefined : lstatSync(selected);
    this.db = openDatabase(selected);
    try {
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.trunc(this.busyTimeoutMs))}`);
      this.restrictFiles();
      if (before) {
        const after = lstatSync(selected);
        if (after.dev !== before.dev || after.ino !== before.ino) throw new Error("SQLite edge database path identity changed while opening");
      }
    } catch (error) { this.db.close(); throw error; }
    this.key = edgeScopeKey(scope);
  }

  private restrictFiles(): void {
    if (this.databasePath === ":memory:") return;
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (!existsSync(path)) continue;
      if (this.preexistingFiles.has(path)) verifyPrivatePathAccess(path, "file");
      else securePrivatePath(path, "file");
    }
  }

  get scopeKey(): string {
    return this.key;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initialization) {
      this.initialization = this.initializeOnce().then(() => {
        this.initialized = true;
      }).catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    assertEdgeUpgradeCandidate(this.db);
    await retrySqliteBusy(() => this.db.exec(schema), this.busyTimeoutMs);
    await retrySqliteBusy(() => this.db.exec("BEGIN IMMEDIATE"), this.busyTimeoutMs);
    try {
      const scopeColumns = this.db.prepare("PRAGMA table_info(edge_scopes)").all() as Row[];
      if (!scopeColumns.some((column) => column.name === "cache_contract")) {
        this.db.exec("ALTER TABLE edge_scopes ADD COLUMN cache_contract INTEGER NOT NULL DEFAULT 0");
      }
      for (const name of ["last_outbound_sync_at", "last_inbound_sync_at", "last_attempt_at"]) {
        if (!scopeColumns.some((column) => column.name === name)) {
          this.db.exec(`ALTER TABLE edge_scopes ADD COLUMN ${name} TEXT`);
        }
      }
      const columns = this.db.prepare("PRAGMA table_info(edge_inbox)").all() as Row[];
      if (!columns.some((column) => column.name === "project")) {
        this.db.exec("ALTER TABLE edge_inbox ADD COLUMN project TEXT");
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS edge_inbox_project ON edge_inbox(scope_key, project, sequence_key)");
      const outboxColumns = this.db.prepare("PRAGMA table_info(edge_outbox)").all() as Row[];
      if (!outboxColumns.some((column) => column.name === "blocked_at")) {
        this.db.exec("ALTER TABLE edge_outbox ADD COLUMN blocked_at TEXT");
      }
      installEdgeMarkers(this.db);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.restrictFiles();
    const endpointHash = createHash("sha256").update(this.scope.endpoint.replace(/\/$/, "")).digest("hex");
    this.db.prepare(`INSERT INTO edge_scopes (scope_key, endpoint_hash, workspace, agent)
      VALUES (?, ?, ?, ?) ON CONFLICT(scope_key) DO NOTHING`)
      .run(this.key, endpointHash, this.scope.principal.workspace, this.scope.principal.agent);
    const contract = this.db.prepare("SELECT cache_contract FROM edge_scopes WHERE scope_key=?").get(this.key) as Row;
    if (Number(contract.cache_contract) < 1) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("UPDATE edge_scopes SET pull_cursor=NULL, cache_contract=1 WHERE scope_key=?").run(this.key);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
  }

  private async ready(): Promise<void> {
    await this.initialize();
  }

  async enqueue(input: PendingMessage, now = new Date()): Promise<EdgeEnqueueResult> {
    await this.ready();
    const draft = stableIdempotency(input);
    const payloadHash = edgeMessageFingerprint(draft);
    const serialized = canonical(draft as unknown as JsonValue);
    const nowText = now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(`SELECT * FROM edge_outbox
        WHERE scope_key=? AND (message_id=? OR idempotency_key=?) ORDER BY position LIMIT 1`)
        .get(this.key, draft.id, draft.idempotencyKey!) as Row | undefined;
      if (existing) {
        if (String(existing.payload_hash) !== payloadHash) {
          throw new EdgeConflictError("message ID or idempotency key is already bound to different content");
        }
        this.db.exec("COMMIT");
        return { draft: parseDraft(existing.draft_json), created: false };
      }
      this.db.prepare(`INSERT INTO edge_outbox
        (scope_key, message_id, idempotency_key, payload_hash, draft_json, state, available_at, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(this.key, draft.id, draft.idempotencyKey!, payloadHash, serialized, nowText, nowText);
      this.db.exec("COMMIT");
      return { draft, created: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async claimNext(now = new Date(), leaseMs = 30_000): Promise<EdgeOutboxRecord | undefined> {
    await this.ready();
    const nowText = now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const head = this.db.prepare(`SELECT * FROM edge_outbox
        WHERE scope_key=? AND state='pending' AND available_at<=?
          AND (lease_expires_at IS NULL OR lease_expires_at<=?)
        ORDER BY position LIMIT 1`).get(this.key, nowText, nowText) as Row | undefined;
      if (!head) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const updated = this.db.prepare(`UPDATE edge_outbox
        SET lease_token=?, lease_expires_at=? WHERE scope_key=? AND position=?
          AND (lease_expires_at IS NULL OR lease_expires_at<=?)`)
        .run(leaseToken, leaseExpiresAt, this.key, Number(head.position), nowText);
      if (!updated.changes) {
        this.db.exec("COMMIT");
        return undefined;
      }
      this.db.exec("COMMIT");
      return {
        position: Number(head.position),
        draft: parseDraft(head.draft_json),
        payloadHash: String(head.payload_hash),
        attempts: Number(head.attempts),
        leaseToken,
        createdAt: String(head.created_at),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async retry(record: EdgeOutboxRecord, error: string, availableAt: Date): Promise<void> {
    await this.ready();
    this.db.prepare(`UPDATE edge_outbox SET attempts=attempts+1, available_at=?,
      lease_token=NULL, lease_expires_at=NULL, last_error=?
      WHERE scope_key=? AND position=? AND lease_token=?`)
      .run(availableAt.toISOString(), error.slice(0, 256), this.key, record.position, record.leaseToken);
    await this.noteError(error);
  }

  async block(record: EdgeOutboxRecord, error: string, now = new Date()): Promise<void> {
    await this.ready();
    this.db.prepare(`UPDATE edge_outbox SET state='blocked', attempts=attempts+1,
      lease_token=NULL, lease_expires_at=NULL, last_error=?, blocked_at=?
      WHERE scope_key=? AND position=? AND lease_token=?`)
      .run(error.slice(0, 256), now.toISOString(), this.key, record.position, record.leaseToken);
    await this.noteError(error);
  }

  async commit(
    record: EdgeOutboxRecord,
    message: BridgeMessage,
    now = new Date(),
  ): Promise<void> {
    await this.ready();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.cacheOne(message);
      const deleted = this.db.prepare(`DELETE FROM edge_outbox
        WHERE scope_key=? AND position=? AND lease_token=?`)
        .run(this.key, record.position, record.leaseToken);
      if (deleted.changes !== 1) throw new EdgeConflictError("outbox lease was lost before commit");
      this.db.prepare(`UPDATE edge_scopes SET last_sync_at=?, last_error=NULL WHERE scope_key=?`)
        .run(now.toISOString(), this.key);
      this.db.prepare("UPDATE edge_scopes SET last_outbound_sync_at=? WHERE scope_key=?")
        .run(now.toISOString(), this.key);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private cacheOne(message: BridgeMessage): void {
    const serialized = canonical(message as unknown as JsonValue);
    const key = sequenceKey(message.sequence);
    const byId = this.db.prepare(`SELECT remote_sequence, message_json FROM edge_inbox
      WHERE scope_key=? AND message_id=?`).get(this.key, message.id) as Row | undefined;
    const bySequence = this.db.prepare(`SELECT message_id, message_json FROM edge_inbox
      WHERE scope_key=? AND sequence_key=?`).get(this.key, key) as Row | undefined;
    if (byId || bySequence) {
      if (
        !byId ||
        String(byId.remote_sequence) !== message.sequence ||
        String(byId.message_json) !== serialized ||
        (bySequence && String(bySequence.message_id) !== message.id)
      ) {
        throw new EdgeConflictError("cached message conflicts with immutable remote history");
      }
      return;
    }
    this.db.prepare(`INSERT INTO edge_inbox
      (scope_key, message_id, remote_sequence, sequence_key, workspace, project, source, type,
       thread_id, created_at, expires_at, message_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(this.key, message.id, message.sequence, key, message.workspace, message.project ?? null, message.source,
        message.type, message.threadId ?? null, message.createdAt, message.expiresAt ?? null, serialized);
  }

  async cachePage(messages: BridgeMessage[], cursor: string | undefined, now = new Date()): Promise<void> {
    await this.ready();
    const scope = cursorScope(this.scope.principal, { mailbox: "all", includeExpired: true });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const message of messages) this.cacheOne(message);
      const current = this.db.prepare("SELECT pull_cursor FROM edge_scopes WHERE scope_key=?")
        .get(this.key) as Row;
      const currentCursor = current.pull_cursor ? String(current.pull_cursor) : undefined;
      const nextCursor = !cursor
        ? currentCursor
        : !currentCursor || sequenceKey(decodeCursor(cursor, scope)!) >= sequenceKey(decodeCursor(currentCursor, scope)!)
          ? cursor
          : currentCursor;
      this.db.prepare(`UPDATE edge_scopes SET pull_cursor=?, last_sync_at=?, last_error=NULL
        WHERE scope_key=?`).run(nextCursor ?? null, now.toISOString(), this.key);
      this.db.prepare("UPDATE edge_scopes SET last_inbound_sync_at=? WHERE scope_key=?")
        .run(now.toISOString(), this.key);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async cacheLatest(messages: BridgeMessage[], now = new Date()): Promise<void> {
    await this.ready();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const message of messages) this.cacheOne(message);
      this.db.prepare(`UPDATE edge_scopes SET last_sync_at=?, last_error=NULL WHERE scope_key=?`)
        .run(now.toISOString(), this.key);
      this.db.prepare("UPDATE edge_scopes SET last_inbound_sync_at=? WHERE scope_key=?")
        .run(now.toISOString(), this.key);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async list(query: MessageQuery = {}): Promise<MessagePage> {
    await this.ready();
    const scope = cursorScope(this.scope.principal, query);
    const inputSequence = query.latest ? undefined : decodeCursor(query.cursor, scope) ?? "0";
    const cachedHighWater = query.latest ? undefined : this.db.prepare(`SELECT remote_sequence
      FROM edge_inbox WHERE scope_key=? ORDER BY sequence_key DESC LIMIT 1`)
      .get(this.key) as Row | undefined;
    const syncState = query.latest ? undefined : this.db.prepare(
      "SELECT pull_cursor FROM edge_scopes WHERE scope_key=?",
    ).get(this.key) as Row | undefined;
    const syncScope = cursorScope(this.scope.principal, {
      mailbox: "all",
      includeExpired: true,
    });
    const syncSequence = syncState?.pull_cursor
      ? decodeCursor(String(syncState.pull_cursor), syncScope) ?? "0"
      : "0";
    const highWaterSequence = query.latest ? undefined : [
      inputSequence ?? "0",
      syncSequence,
      cachedHighWater?.remote_sequence ? String(cachedHighWater.remote_sequence) : "0",
    ].reduce((highest, candidate) => (
      sequenceKey(candidate) > sequenceKey(highest) ? candidate : highest
    ), "0");
    // Receipts are remote authority and are deliberately not mirrored. During
    // an outage callers may still inspect the cached candidate set, but the
    // wrapping store must label acknowledgement state as unknown.
    const clauses = ["scope_key=?"];
    const args: SQLInputValue[] = [this.key];
    if (!query.latest) {
      clauses.push("sequence_key>?");
      args.push(sequenceKey(inputSequence ?? "0"));
    }
    if (!query.includeExpired) {
      clauses.push("(expires_at IS NULL OR expires_at>?)");
      args.push(new Date().toISOString());
    }
    if (query.types?.length) {
      clauses.push(`type IN (${query.types.map(() => "?").join(",")})`);
      args.push(...query.types);
    }
    if (query.source) {
      clauses.push("source=?");
      args.push(query.source);
    }
    const mailbox = query.mailbox ?? "inbox";
    if (mailbox === "sent") { clauses.push("source=?"); args.push(this.scope.principal.agent); }
    else if (mailbox !== "all") {
      clauses.push("(json_array_length(json_extract(message_json, '$.targets'))=0 OR EXISTS (SELECT 1 FROM json_each(json_extract(message_json, '$.targets')) WHERE value=?))");
      args.push(this.scope.principal.agent);
    } else {
      clauses.push("(source=? OR json_array_length(json_extract(message_json, '$.targets'))=0 OR EXISTS (SELECT 1 FROM json_each(json_extract(message_json, '$.targets')) WHERE value=?))");
      args.push(this.scope.principal.agent, this.scope.principal.agent);
    }
    if (query.project) {
      clauses.push("project=?");
      args.push(query.project);
    }
    if (query.since) {
      clauses.push("created_at>=?");
      args.push(query.since);
    }
    if (query.threadId) {
      clauses.push("thread_id=?");
      args.push(query.threadId);
    }
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
    const rows = this.db.prepare(`SELECT message_json FROM edge_inbox
      WHERE ${clauses.join(" AND ")} ORDER BY sequence_key ${query.latest ? "DESC" : "ASC"} LIMIT ?`)
      .all(...args, limit) as Row[];
    const messages = rows.map((row) => parseMessage(row.message_json));
    const cursorMessage = query.latest ? messages[0] : messages[messages.length - 1];
    if (query.latest || messages.length === limit) {
      return { messages, cursor: cursorMessage ? encodeCursor(cursorMessage.sequence, scope) : query.cursor };
    }
    return {
      messages,
      cursor: highWaterSequence && highWaterSequence !== "0"
        ? encodeCursor(highWaterSequence, scope)
        : query.cursor,
    };
  }

  async pullCursor(): Promise<string | undefined> {
    await this.ready();
    const row = this.db.prepare("SELECT pull_cursor FROM edge_scopes WHERE scope_key=?")
      .get(this.key) as Row;
    return row.pull_cursor ? String(row.pull_cursor) : undefined;
  }

  async noteError(error: string): Promise<void> {
    await this.ready();
    this.db.prepare("UPDATE edge_scopes SET last_error=? WHERE scope_key=?")
      .run(error.slice(0, 256), this.key);
  }

  async noteAttempt(now = new Date()): Promise<void> {
    await this.ready();
    this.db.prepare("UPDATE edge_scopes SET last_attempt_at=? WHERE scope_key=?")
      .run(now.toISOString(), this.key);
  }

  async stats(now = new Date()): Promise<EdgeStats> {
    await this.ready();
    const nowText = now.toISOString();
    const counts = this.db.prepare(`SELECT
      sum(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN state='pending' AND available_at<=? AND (lease_expires_at IS NULL OR lease_expires_at<=?) THEN 1 ELSE 0 END) AS due,
      sum(CASE WHEN state='pending' AND available_at>? AND (lease_expires_at IS NULL OR lease_expires_at<=?) THEN 1 ELSE 0 END) AS scheduled,
      sum(CASE WHEN state='pending' AND lease_expires_at>? THEN 1 ELSE 0 END) AS leased,
      sum(CASE WHEN state='blocked' THEN 1 ELSE 0 END) AS blocked,
      min(CASE WHEN state='pending' AND available_at<=? AND (lease_expires_at IS NULL OR lease_expires_at<=?) THEN available_at END) AS oldest_due,
      min(CASE WHEN state='pending' AND available_at>? AND (lease_expires_at IS NULL OR lease_expires_at<=?) THEN available_at END) AS next_retry,
      min(CASE WHEN state='blocked' THEN blocked_at END) AS oldest_blocked,
      sum(CASE WHEN state='blocked' AND blocked_at IS NULL THEN 1 ELSE 0 END) AS blocked_age_unknown,
      max(CASE WHEN state='blocked' THEN attempts ELSE 0 END) AS blocked_max_attempts
      FROM edge_outbox WHERE scope_key=?`).get(nowText, nowText, nowText, nowText, nowText, nowText, nowText, nowText, nowText, this.key) as Row;
    const blocked = this.db.prepare("SELECT last_error FROM edge_outbox WHERE scope_key=? AND state='blocked' ORDER BY coalesce(blocked_at,created_at) LIMIT 1").get(this.key) as Row | undefined;
    const cache = this.db.prepare("SELECT count(*) AS count FROM edge_inbox WHERE scope_key=?")
      .get(this.key) as Row;
    const state = this.db.prepare(`SELECT pull_cursor, last_sync_at, last_error,
      last_outbound_sync_at,last_inbound_sync_at,last_attempt_at
      FROM edge_scopes WHERE scope_key=?`).get(this.key) as Row;
    const oldestDueAt = counts.oldest_due ? String(counts.oldest_due) : undefined;
    const oldestBlockedAt = Number(counts.blocked_age_unknown ?? 0) > 0
      ? undefined
      : counts.oldest_blocked ? String(counts.oldest_blocked) : undefined;
    return {
      pending: Number(counts.pending ?? 0),
      due: Number(counts.due ?? 0),
      scheduled: Number(counts.scheduled ?? 0),
      leased: Number(counts.leased ?? 0),
      blocked: Number(counts.blocked ?? 0),
      cached: Number(cache.count ?? 0),
      pullCursor: state.pull_cursor ? String(state.pull_cursor) : undefined,
      lastSyncAt: state.last_sync_at ? String(state.last_sync_at) : undefined,
      lastError: state.last_error ? String(state.last_error) : undefined,
      oldestDueAt,
      queueLagMs: oldestDueAt ? Math.max(0, now.getTime() - Date.parse(oldestDueAt)) : 0,
      oldestBlockedAt,
      blockedAgeMs: oldestBlockedAt ? Math.max(0, now.getTime() - Date.parse(oldestBlockedAt)) : null,
      blockedMaxAttempts: Number(counts.blocked_max_attempts ?? 0),
      blockedLastError: blocked?.last_error ? String(blocked.last_error) : undefined,
      nextRetryAt: counts.next_retry ? String(counts.next_retry) : undefined,
      lastOutboundSyncAt: state.last_outbound_sync_at ? String(state.last_outbound_sync_at) : undefined,
      lastInboundSyncAt: state.last_inbound_sync_at ? String(state.last_inbound_sync_at) : undefined,
      lastAttemptAt: state.last_attempt_at ? String(state.last_attempt_at) : undefined,
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
