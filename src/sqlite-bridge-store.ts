import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as Database, SQLInputValue } from "node:sqlite";
import { decodeCursor, encodeCursor, type AgentPresence, type BridgeDelivery, type BridgeDeliveryEvent, type BridgeMessage, type BridgePrincipal, type RetryPolicy } from "./bridge-domain.js";
import type { BridgeDiagnostics, BridgeStore, ClaimOptions, InsertMessageResult, MessagePage, MessageQuery } from "./bridge-store.js";
import { assertIdempotentReplay } from "./idempotency.js";

type Row = Record<string, unknown>;
const require = createRequire(import.meta.url);
function openDatabase(path: string): Database {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(path);
}
const schema = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS bridge_messages (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, workspace TEXT NOT NULL, project TEXT, source TEXT NOT NULL,
 type TEXT NOT NULL, content TEXT NOT NULL, content_type TEXT NOT NULL, data TEXT, targets TEXT NOT NULL DEFAULT '[]',
 thread_id TEXT, reply_to_id TEXT, correlation_id TEXT, causation_id TEXT, priority TEXT NOT NULL, expires_at TEXT,
 idempotency_key TEXT, atrib_receipt_id TEXT, informed_by TEXT, metadata TEXT, created_at TEXT NOT NULL,
 UNIQUE(workspace, id), CHECK(json_valid(targets) AND json_type(targets) = 'array'),
 CHECK(priority IN ('info', 'high', 'urgent'))
);
CREATE UNIQUE INDEX IF NOT EXISTS bridge_messages_idempotency ON bridge_messages(workspace, source, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS bridge_messages_cursor ON bridge_messages(workspace, sequence);
CREATE INDEX IF NOT EXISTS bridge_messages_source ON bridge_messages(workspace, source, sequence);
CREATE INDEX IF NOT EXISTS bridge_messages_thread ON bridge_messages(workspace, thread_id, sequence) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bridge_messages_created ON bridge_messages(workspace, created_at, sequence);
CREATE TABLE IF NOT EXISTS bridge_receipts (workspace TEXT NOT NULL, message_id TEXT NOT NULL, principal TEXT NOT NULL, read_at TEXT NOT NULL, PRIMARY KEY(workspace, message_id, principal), FOREIGN KEY(workspace, message_id) REFERENCES bridge_messages(workspace, id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS bridge_deliveries (
 id TEXT PRIMARY KEY, message_id TEXT NOT NULL, workspace TEXT NOT NULL, recipient TEXT NOT NULL,
 state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, lease_token TEXT, lease_owner TEXT, lease_expires_at TEXT, last_error TEXT,
 UNIQUE(message_id, recipient), FOREIGN KEY(workspace, message_id) REFERENCES bridge_messages(workspace, id) ON DELETE CASCADE,
 CHECK(state IN ('pending', 'claimed', 'acked', 'retrying', 'dead')), CHECK(attempt >= 0),
 CHECK((state = 'claimed' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state <> 'claimed' AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS bridge_deliveries_claim ON bridge_deliveries(workspace, recipient, state, available_at);
CREATE TABLE IF NOT EXISTS bridge_delivery_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL,
 message_id TEXT NOT NULL, workspace TEXT NOT NULL, recipient TEXT NOT NULL,
 from_state TEXT, to_state TEXT NOT NULL, attempt INTEGER NOT NULL,
 lease_owner TEXT, error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bridge_delivery_events_lookup
 ON bridge_delivery_events(workspace, delivery_id, sequence);
CREATE TRIGGER IF NOT EXISTS bridge_delivery_events_insert
 AFTER INSERT ON bridge_deliveries BEGIN
  INSERT INTO bridge_delivery_events
   (delivery_id,message_id,workspace,recipient,from_state,to_state,attempt,lease_owner,error,created_at)
  VALUES
   (NEW.id,NEW.message_id,NEW.workspace,NEW.recipient,NULL,NEW.state,NEW.attempt,NEW.lease_owner,NEW.last_error,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 END;
CREATE TRIGGER IF NOT EXISTS bridge_delivery_events_update
 AFTER UPDATE ON bridge_deliveries
 WHEN OLD.state IS NOT NEW.state OR OLD.attempt IS NOT NEW.attempt BEGIN
  INSERT INTO bridge_delivery_events
   (delivery_id,message_id,workspace,recipient,from_state,to_state,attempt,lease_owner,error,created_at)
  VALUES
   (NEW.id,NEW.message_id,NEW.workspace,NEW.recipient,OLD.state,NEW.state,NEW.attempt,NEW.lease_owner,NEW.last_error,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 END;
CREATE TABLE IF NOT EXISTS bridge_presence (
 workspace TEXT NOT NULL, agent TEXT NOT NULL, instance TEXT NOT NULL, runtime_type TEXT,
 capabilities TEXT NOT NULL DEFAULT '[]', lease_expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
 PRIMARY KEY(workspace, agent, instance), CHECK(json_valid(capabilities) AND json_type(capabilities)='array')
);
CREATE INDEX IF NOT EXISTS bridge_presence_active ON bridge_presence(workspace, lease_expires_at);
CREATE TRIGGER IF NOT EXISTS bridge_messages_no_update BEFORE UPDATE ON bridge_messages BEGIN SELECT RAISE(ABORT, 'bridge messages are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bridge_messages_no_delete BEFORE DELETE ON bridge_messages BEGIN SELECT RAISE(ABORT, 'bridge messages are immutable'); END;
`;

function stringify(value: unknown): string | null { return value === undefined ? null : JSON.stringify(value); }
function parse(value: unknown): any { return typeof value === "string" ? JSON.parse(value) : undefined; }
function message(row: Row): BridgeMessage { return { id: String(row.id), workspace: String(row.workspace), project: row.project == null ? undefined : String(row.project), source: String(row.source), sequence: String(row.sequence), type: String(row.type), content: String(row.content), contentType: String(row.content_type), data: parse(row.data), targets: parse(row.targets) ?? [], threadId: row.thread_id as string | undefined, replyToId: row.reply_to_id as string | undefined, correlationId: row.correlation_id as string | undefined, causationId: row.causation_id as string | undefined, priority: row.priority as BridgeMessage["priority"], expiresAt: row.expires_at as string | undefined, idempotencyKey: row.idempotency_key as string | undefined, atribReceiptId: row.atrib_receipt_id as string | undefined, informedBy: parse(row.informed_by), metadata: parse(row.metadata), createdAt: String(row.created_at) }; }
function delivery(row: Row): BridgeDelivery { return { id: String(row.id), messageId: String(row.message_id), workspace: String(row.workspace), recipient: String(row.recipient), state: row.state as BridgeDelivery["state"], attempt: Number(row.attempt), availableAt: String(row.available_at), leaseToken: row.lease_token as string | undefined, leaseOwner: row.lease_owner as string | undefined, leaseExpiresAt: row.lease_expires_at as string | undefined, lastError: row.last_error as string | undefined }; }
function presence(row: Row): AgentPresence { return { workspace: String(row.workspace), agent: String(row.agent), instance: String(row.instance), runtimeType: row.runtime_type as string | undefined, capabilities: parse(row.capabilities) ?? [], leaseExpiresAt: String(row.lease_expires_at), lastSeenAt: String(row.last_seen_at) }; }
function deliveryEvent(row: Row): BridgeDeliveryEvent { return { sequence: String(row.sequence), deliveryId: String(row.delivery_id), messageId: String(row.message_id), workspace: String(row.workspace), recipient: String(row.recipient), fromState: row.from_state as BridgeDeliveryEvent["fromState"], toState: row.to_state as BridgeDeliveryEvent["toState"], attempt: Number(row.attempt), leaseOwner: row.lease_owner as string | undefined, error: row.error as string | undefined, createdAt: String(row.created_at) }; }

export class SQLiteBridgeStore implements BridgeStore {
  private readonly db: Database;
  private initialized = false;
  constructor(private readonly path = ":memory:", private readonly busyTimeoutMs = 2_000) { this.db = openDatabase(path); this.db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.trunc(this.busyTimeoutMs))}`); this.restrictFiles(); }
  private restrictFiles(): void {
    if (this.path === ":memory:") return;
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }
  async initialize(): Promise<void> { if (this.initialized) return; const versionRow = this.db.prepare("SELECT sqlite_version() AS version").get() as Row; const parts = String(versionRow.version).split(".").map(Number); const encoded = (parts[0] ?? 0) * 1_000_000 + (parts[1] ?? 0) * 1_000 + (parts[2] ?? 0); if (encoded < 3_051_003) throw new Error("SQLite 3.51.3 or newer is required"); this.db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.trunc(this.busyTimeoutMs))}; ${schema}`); this.db.exec("BEGIN IMMEDIATE"); try { const columns = this.db.prepare("PRAGMA table_info(bridge_messages)").all() as Row[]; if (!columns.some((column) => column.name === "project")) this.db.exec("ALTER TABLE bridge_messages ADD COLUMN project TEXT"); this.db.exec("CREATE INDEX IF NOT EXISTS bridge_messages_project ON bridge_messages(workspace, project, sequence)"); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } this.restrictFiles(); this.initialized = true; }
  private async ready() { await this.initialize(); }
  async insertMessage(input: Omit<BridgeMessage, "sequence" | "createdAt">): Promise<InsertMessageResult> {
    await this.ready(); const createdAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.idempotencyKey) { const existing = this.db.prepare("SELECT * FROM bridge_messages WHERE workspace = ? AND source = ? AND idempotency_key = ?").get(input.workspace, input.source, input.idempotencyKey) as Row | undefined; if (existing) { const replay = message(existing); assertIdempotentReplay(replay, input); this.db.exec("COMMIT"); return { message: replay, created: false }; } }
      this.db.prepare(`INSERT INTO bridge_messages (id,workspace,project,source,type,content,content_type,data,targets,thread_id,reply_to_id,correlation_id,causation_id,priority,expires_at,idempotency_key,atrib_receipt_id,informed_by,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id,input.workspace,input.project ?? null,input.source,input.type,input.content,input.contentType,stringify(input.data),JSON.stringify(input.targets),input.threadId ?? null,input.replyToId ?? null,input.correlationId ?? null,input.causationId ?? null,input.priority,input.expiresAt ?? null,input.idempotencyKey ?? null,input.atribReceiptId ?? null,stringify(input.informedBy),stringify(input.metadata),createdAt);
      for (const recipient of input.targets) this.db.prepare("INSERT INTO bridge_deliveries (id,message_id,workspace,recipient,state,available_at) VALUES (?,?,?,?,?,?)").run(randomUUID(), input.id, input.workspace, recipient, "pending", createdAt);
      const row = this.db.prepare("SELECT * FROM bridge_messages WHERE id = ?").get(input.id) as Row; this.db.exec("COMMIT"); return { message: message(row), created: true };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  async listMessages(principal: BridgePrincipal, query: MessageQuery = {}): Promise<MessagePage> {
    await this.ready(); const cursor = decodeCursor(query.cursor); const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200); const now = new Date().toISOString();
    const highWaterRow = query.latest ? undefined : this.db.prepare("SELECT max(sequence) AS sequence FROM bridge_messages WHERE workspace=?").get(principal.workspace) as Row;
    const highWater = highWaterRow?.sequence === null || highWaterRow?.sequence === undefined
      ? undefined
      : String(highWaterRow.sequence);
    const clauses = ["workspace = ?", query.latest ? "1=1" : "sequence > ?", "(targets = '[]' OR EXISTS (SELECT 1 FROM json_each(targets) WHERE value = ?))"]; const args: SQLInputValue[] = query.latest ? [principal.workspace, principal.agent] : [principal.workspace, cursor ?? "0", principal.agent];
    if (highWater) { clauses.push("sequence <= ?"); args.push(highWater); }
    if (!query.includeExpired) { clauses.push("(expires_at IS NULL OR expires_at > ?)"); args.push(now); }
    if (query.types?.length) { clauses.push(`type IN (${query.types.map(() => "?").join(",")})`); args.push(...query.types); }
    if (query.source) { clauses.push("source = ?"); args.push(query.source); }
    if (query.project) { clauses.push("project = ?"); args.push(query.project); }
    if (query.since) { clauses.push("created_at >= ?"); args.push(query.since); }
    if (query.unacknowledgedBy) {
      clauses.push("NOT EXISTS (SELECT 1 FROM bridge_receipts receipt WHERE receipt.workspace=bridge_messages.workspace AND receipt.message_id=bridge_messages.id AND receipt.principal=?)");
      args.push(query.unacknowledgedBy);
    }
    if (query.threadId) { clauses.push("thread_id = ?"); args.push(query.threadId); }
    const rows = this.db.prepare(`SELECT * FROM bridge_messages WHERE ${clauses.join(" AND ")} ORDER BY sequence ${query.latest ? "DESC" : "ASC"} LIMIT ?`).all(...args, limit) as Row[];
    const messages = rows.map(message);
    const last = messages[messages.length - 1];
    if (query.latest) return { messages, cursor: messages[0] ? encodeCursor(messages[0].sequence) : query.cursor };
    if (messages.length === limit) return { messages, cursor: encodeCursor(last!.sequence) };
    return { messages, cursor: highWater ? encodeCursor(highWater) : query.cursor };
  }
  async recordReceipt(workspace: string, messageIds: string[], principal: string, readAt = new Date()): Promise<number> { await this.ready(); const stmt = this.db.prepare("INSERT OR IGNORE INTO bridge_receipts (workspace,message_id,principal,read_at) SELECT workspace,id,?,? FROM bridge_messages WHERE workspace=? AND id=? AND (targets='[]' OR EXISTS (SELECT 1 FROM json_each(targets) WHERE value=?))"); let changed = 0; this.db.exec("BEGIN IMMEDIATE"); try { for (const id of messageIds) changed += Number(stmt.run(principal,readAt.toISOString(),workspace,id,principal).changes); this.db.exec("COMMIT"); return changed; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }
  async claimDelivery(principal: BridgePrincipal, options: ClaimOptions): Promise<BridgeDelivery | null> {
    await this.ready(); const now = options.now ?? new Date(); const nowText = now.toISOString(); const expires = new Date(now.getTime() + options.leaseMs).toISOString(); const owner = principal.instance ?? principal.agent; const maxAttempts = options.maxAttempts ?? 5;
    this.db.exec("BEGIN IMMEDIATE"); try {
      this.db.prepare("UPDATE bridge_deliveries SET state='dead', last_error='message expired', lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL WHERE workspace=? AND recipient=? AND state IN ('pending','retrying','claimed') AND EXISTS (SELECT 1 FROM bridge_messages message WHERE message.workspace=bridge_deliveries.workspace AND message.id=bridge_deliveries.message_id AND message.expires_at IS NOT NULL AND message.expires_at <= ?)").run(principal.workspace,principal.agent,nowText);
      this.db.prepare("UPDATE bridge_deliveries SET state='dead', last_error='maximum attempts reached', lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL WHERE workspace=? AND recipient=? AND attempt>=? AND (state IN ('pending','retrying') OR (state='claimed' AND lease_expires_at<=?))").run(principal.workspace,principal.agent,maxAttempts,nowText);
      this.db.prepare("UPDATE bridge_deliveries SET state='retrying', lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL WHERE workspace=? AND recipient=? AND state='claimed' AND lease_expires_at <= ? AND attempt<?").run(principal.workspace,principal.agent,nowText,maxAttempts);
      const candidate = this.db.prepare("SELECT delivery.id FROM bridge_deliveries delivery JOIN bridge_messages message ON message.workspace=delivery.workspace AND message.id=delivery.message_id WHERE delivery.workspace=? AND delivery.recipient=? AND delivery.state IN ('pending','retrying') AND delivery.available_at <= ? AND delivery.attempt<? AND (message.expires_at IS NULL OR message.expires_at > ?) ORDER BY delivery.available_at,delivery.id LIMIT 1").get(principal.workspace,principal.agent,nowText,maxAttempts,nowText) as Row | undefined;
      if (!candidate) { this.db.exec("COMMIT"); return null; }
      const candidateId = String(candidate.id);
      const token = randomUUID(); this.db.prepare("UPDATE bridge_deliveries SET state='claimed', attempt=attempt+1, lease_token=?, lease_owner=?, lease_expires_at=? WHERE id=?").run(token,owner,expires,candidateId);
      const claimed = this.db.prepare("SELECT * FROM bridge_deliveries WHERE id=?").get(candidateId) as Row; this.db.exec("COMMIT"); return delivery(claimed);
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  async renewDelivery(principal: BridgePrincipal, id: string, token: string, leaseMs: number): Promise<BridgeDelivery | null> { await this.ready(); const now = new Date(); const expires = new Date(now.getTime() + leaseMs).toISOString(); const owner = principal.instance ?? principal.agent; const result = this.db.prepare("UPDATE bridge_deliveries SET lease_expires_at=? WHERE workspace=? AND recipient=? AND lease_owner=? AND id=? AND lease_token=? AND state='claimed' AND lease_expires_at > ?").run(expires,principal.workspace,principal.agent,owner,id,token,now.toISOString()); if (!result.changes) return null; return delivery(this.db.prepare("SELECT * FROM bridge_deliveries WHERE id=?").get(id) as Row); }
  async settleDelivery(principal: BridgePrincipal, id: string, token: string, state: "acked" | "retrying" | "dead", error: string | undefined, retryPolicy: RetryPolicy): Promise<BridgeDelivery | null> { await this.ready(); const now = new Date(); const owner = principal.instance ?? principal.agent; this.db.exec("BEGIN IMMEDIATE"); try { const current = this.db.prepare("SELECT * FROM bridge_deliveries WHERE workspace=? AND recipient=? AND lease_owner=? AND id=? AND lease_token=? AND state='claimed' AND lease_expires_at > ?").get(principal.workspace,principal.agent,owner,id,token,now.toISOString()) as Row | undefined; if (!current) { this.db.exec("COMMIT"); return null; } const attempt = Number(current.attempt); const nextState = state === "retrying" && attempt >= retryPolicy.maxAttempts ? "dead" : state; const exponential = Math.min(retryPolicy.maxDelayMs, retryPolicy.baseDelayMs * 2 ** Math.max(0, attempt - 1)); const jitter = 1 + (Math.random() * 2 - 1) * retryPolicy.jitterRatio; const delay = nextState === "retrying" ? Math.max(1, Math.round(exponential * jitter)) : 0; const available = new Date(now.getTime() + delay).toISOString(); this.db.prepare("UPDATE bridge_deliveries SET state=?, available_at=?, last_error=?, lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL WHERE id=?").run(nextState,available,error?.slice(0,1024) ?? null,id); const result = delivery(this.db.prepare("SELECT * FROM bridge_deliveries WHERE id=?").get(id) as Row); this.db.exec("COMMIT"); return result; } catch (caught) { this.db.exec("ROLLBACK"); throw caught; } }
  async diagnostics(principal: BridgePrincipal): Promise<BridgeDiagnostics> { await this.ready(); const rows = this.db.prepare("SELECT state, count(*) AS count, min(available_at) AS oldest FROM bridge_deliveries WHERE workspace=? AND recipient=? GROUP BY state").all(principal.workspace, principal.agent) as Row[]; const counts = new Map(rows.map((row) => [String(row.state), Number(row.count)])); const oldest = rows.filter((row) => row.state === "pending" || row.state === "retrying").map((row) => row.oldest ? String(row.oldest) : undefined).filter(Boolean).sort()[0]; return { schemaVersion: "local-v2", deliverySupported: true, pending: counts.get("pending") ?? 0, claimed: counts.get("claimed") ?? 0, retrying: counts.get("retrying") ?? 0, dead: counts.get("dead") ?? 0, oldestAvailableAt: oldest }; }
  async heartbeat(principal: BridgePrincipal, leaseMs: number, runtimeType?: string, capabilities: string[] = []): Promise<AgentPresence> {
    await this.ready();
    const now = new Date();
    const nowText = now.toISOString();
    const expires = new Date(now.getTime() + leaseMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM bridge_presence WHERE workspace=? AND lease_expires_at<=?")
        .run(principal.workspace, nowText);
      const current = this.db.prepare("SELECT 1 FROM bridge_presence WHERE workspace=? AND agent=? AND instance=?")
        .get(principal.workspace, principal.agent, principal.instance!) as Row | undefined;
      const agentCount = this.db.prepare("SELECT count(*) AS count FROM bridge_presence WHERE workspace=? AND agent=?")
        .get(principal.workspace, principal.agent) as Row;
      const workspaceCount = this.db.prepare("SELECT count(*) AS count FROM bridge_presence WHERE workspace=?")
        .get(principal.workspace) as Row;
      if (!current && (Number(agentCount.count) >= 128 || Number(workspaceCount.count) >= 4096)) {
        throw Object.assign(new Error("active instance limit reached"), {
          status: 429,
          code: "presence_limit",
        });
      }
      this.db.prepare("INSERT INTO bridge_presence (workspace,agent,instance,runtime_type,capabilities,lease_expires_at,last_seen_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace,agent,instance) DO UPDATE SET runtime_type=excluded.runtime_type, capabilities=excluded.capabilities, lease_expires_at=excluded.lease_expires_at, last_seen_at=excluded.last_seen_at")
        .run(principal.workspace,principal.agent,principal.instance!,runtimeType ?? null,JSON.stringify(capabilities),expires,nowText);
      const result = presence(this.db.prepare("SELECT * FROM bridge_presence WHERE workspace=? AND agent=? AND instance=?")
        .get(principal.workspace,principal.agent,principal.instance!) as Row);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async listPresence(principal: BridgePrincipal): Promise<AgentPresence[]> {
    await this.ready();
    const now = new Date().toISOString();
    this.db.prepare("DELETE FROM bridge_presence WHERE workspace=? AND lease_expires_at<=?")
      .run(principal.workspace, now);
    const rows = this.db.prepare("SELECT * FROM bridge_presence WHERE workspace=? ORDER BY agent,instance")
      .all(principal.workspace) as Row[];
    return rows.map(presence);
  }
  async listDeliveryEvents(deliveryId: string): Promise<BridgeDeliveryEvent[]> { await this.ready(); const rows = this.db.prepare("SELECT * FROM bridge_delivery_events WHERE delivery_id=? ORDER BY sequence").all(deliveryId) as Row[]; return rows.map(deliveryEvent); }
  async close(): Promise<void> { this.db.close(); }
}
