import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as Database, SQLInputValue } from "node:sqlite";
import { DeliveryStateConflictError, cursorScope, decodeCursor, decodeScopedCursor, encodeCursor, encodeScopedCursor, scopedCursorScope, validateDeliveryCursorPosition, validateEventCursorPosition, type AgentPresence, type BridgeDelivery, type BridgeDeliveryEvent, type BridgeMessage, type BridgePrincipal } from "./bridge-domain.js";
import type { BridgeDiagnostics, BridgeStore, ClaimOptions, DeliveryQuery, InsertMessageResult, MessagePage, MessageQuery } from "./bridge-store.js";
import { assertIdempotentReplay } from "./idempotency.js";
import { retrySqliteBusy } from "./sqlite-retry.js";
import { preparePrivateSqliteLocation, securePrivatePath, securePrivateSqliteSidecar, verifyPrivatePathAccess } from "./private-path.js";
import { assertLocalUpgradeCandidate, installLocalAuthorityMarkers } from "./sqlite-database-contract.js";

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
 idempotency_key TEXT, atrib_receipt_id TEXT, informed_by TEXT, metadata TEXT, delivery_policy TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(workspace, id), CHECK(json_valid(targets) AND json_type(targets) = 'array'),
 CHECK(priority IN ('info', 'high', 'urgent')),
 CHECK(json_valid(delivery_policy) AND json_type(delivery_policy)='object'),
 CHECK(
   (json_extract(delivery_policy,'$.mode')='mailbox'
     AND json_type(delivery_policy,'$.maxAttempts') IS NULL
     AND json_type(delivery_policy,'$.retryBaseDelayMs') IS NULL
     AND json_type(delivery_policy,'$.retryMaxDelayMs') IS NULL
     AND json_type(delivery_policy,'$.retryJitterRatio') IS NULL
     AND json_type(delivery_policy,'$.notBefore') IS NULL)
   OR
   (json_extract(delivery_policy,'$.mode')='leased'
     AND json_array_length(targets)>0
     AND json_type(delivery_policy,'$.maxAttempts')='integer'
     AND json_extract(delivery_policy,'$.maxAttempts') BETWEEN 1 AND 100
     AND json_type(delivery_policy,'$.retryBaseDelayMs')='integer'
     AND json_extract(delivery_policy,'$.retryBaseDelayMs') BETWEEN 1 AND 3600000
     AND json_type(delivery_policy,'$.retryMaxDelayMs')='integer'
     AND json_extract(delivery_policy,'$.retryMaxDelayMs') BETWEEN json_extract(delivery_policy,'$.retryBaseDelayMs') AND 86400000
     AND json_type(delivery_policy,'$.retryJitterRatio') IN ('integer','real')
     AND json_extract(delivery_policy,'$.retryJitterRatio') BETWEEN 0 AND 1
     AND (json_type(delivery_policy,'$.notBefore') IS NULL OR (
       json_type(delivery_policy,'$.notBefore')='text'
       AND julianday(json_extract(delivery_policy,'$.notBefore')) IS NOT NULL
       AND (expires_at IS NULL OR julianday(json_extract(delivery_policy,'$.notBefore'))<julianday(expires_at))
     )))
 )
);
CREATE UNIQUE INDEX IF NOT EXISTS bridge_messages_idempotency ON bridge_messages(workspace, source, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS bridge_messages_cursor ON bridge_messages(workspace, sequence);
CREATE INDEX IF NOT EXISTS bridge_messages_source ON bridge_messages(workspace, source, sequence);
CREATE INDEX IF NOT EXISTS bridge_messages_thread ON bridge_messages(workspace, thread_id, sequence) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bridge_messages_created ON bridge_messages(workspace, created_at, sequence);
CREATE TABLE IF NOT EXISTS bridge_receipts (workspace TEXT NOT NULL, message_id TEXT NOT NULL, principal TEXT NOT NULL, read_at TEXT NOT NULL, PRIMARY KEY(workspace, message_id, principal), FOREIGN KEY(workspace, message_id) REFERENCES bridge_messages(workspace, id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS bridge_deliveries (
 id TEXT PRIMARY KEY, message_id TEXT NOT NULL, workspace TEXT NOT NULL, recipient TEXT NOT NULL,
 state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, cycle_attempt INTEGER NOT NULL DEFAULT 0, requeue_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, priority_rank INTEGER NOT NULL, available_at TEXT NOT NULL,
 lease_token TEXT, lease_owner TEXT, lease_expires_at TEXT, last_error TEXT, last_actor TEXT, last_action TEXT NOT NULL,
 UNIQUE(message_id, recipient), FOREIGN KEY(workspace, message_id) REFERENCES bridge_messages(workspace, id) ON DELETE CASCADE,
 CHECK(state IN ('pending', 'claimed', 'acked', 'retrying', 'dead', 'cancelled')), CHECK(attempt >= 0 AND cycle_attempt >= 0 AND cycle_attempt <= attempt AND requeue_count >= 0),
 CHECK(priority_rank BETWEEN 0 AND 2),
 CHECK((state = 'claimed' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state <> 'claimed' AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL))
);
CREATE TABLE IF NOT EXISTS bridge_delivery_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL,
 message_id TEXT NOT NULL, workspace TEXT NOT NULL, recipient TEXT NOT NULL,
 from_state TEXT, to_state TEXT NOT NULL, attempt INTEGER NOT NULL, cycle_attempt INTEGER NOT NULL,
 requeue_count INTEGER NOT NULL, lease_owner TEXT, error TEXT, actor TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL
);
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
function optionalString(value: unknown): string | undefined { return value == null ? undefined : String(value); }
function message(row: Row): BridgeMessage { const policy=parse(row.delivery_policy);if(policy?.notBefore==null)delete policy?.notBefore;return { id: String(row.id), workspace: String(row.workspace), project: optionalString(row.project), source: String(row.source), sequence: String(row.sequence), type: String(row.type), content: String(row.content), contentType: String(row.content_type), data: parse(row.data), targets: parse(row.targets) ?? [], threadId: optionalString(row.thread_id), replyToId: optionalString(row.reply_to_id), correlationId: optionalString(row.correlation_id), causationId: optionalString(row.causation_id), priority: row.priority as BridgeMessage["priority"], expiresAt: optionalString(row.expires_at), idempotencyKey: optionalString(row.idempotency_key), atribReceiptId: optionalString(row.atrib_receipt_id), informedBy: parse(row.informed_by), metadata: parse(row.metadata), deliveryPolicy: policy, createdAt: String(row.created_at) }; }
function delivery(row: Row): BridgeDelivery { return { id: String(row.id), messageId: String(row.message_id), workspace: String(row.workspace), recipient: String(row.recipient), state: row.state as BridgeDelivery["state"], attempt: Number(row.attempt), cycleAttempt: Number(row.cycle_attempt), requeueCount: Number(row.requeue_count), createdAt: String(row.created_at), priorityRank: Number(row.priority_rank), availableAt: String(row.available_at), leaseToken: optionalString(row.lease_token), leaseOwner: optionalString(row.lease_owner), leaseExpiresAt: optionalString(row.lease_expires_at), lastError: optionalString(row.last_error), lastActor: optionalString(row.last_actor), lastAction: row.last_action as BridgeDelivery["lastAction"] }; }
function presence(row: Row): AgentPresence { return { workspace: String(row.workspace), agent: String(row.agent), instance: String(row.instance), runtimeType: optionalString(row.runtime_type), capabilities: parse(row.capabilities) ?? [], leaseExpiresAt: String(row.lease_expires_at), lastSeenAt: String(row.last_seen_at) }; }
function deliveryEvent(row: Row): BridgeDeliveryEvent { return { sequence: String(row.sequence), deliveryId: String(row.delivery_id), messageId: String(row.message_id), workspace: String(row.workspace), recipient: String(row.recipient), fromState: row.from_state == null ? undefined : row.from_state as BridgeDeliveryEvent["fromState"], toState: row.to_state as BridgeDeliveryEvent["toState"], attempt: Number(row.attempt), cycleAttempt: Number(row.cycle_attempt), requeueCount: Number(row.requeue_count), leaseOwner: optionalString(row.lease_owner), error: optionalString(row.error), actor: String(row.actor), action: row.action as BridgeDeliveryEvent["action"], createdAt: String(row.created_at) }; }

export class SQLiteBridgeStore implements BridgeStore {
  private readonly db: Database;
  private readonly databasePath: string;
  private readonly preexistingFiles: ReadonlySet<string>;
  private initialized = false;
  private initialization?: Promise<void>;
  constructor(private readonly path = ":memory:", private readonly busyTimeoutMs = 2_000) {
    const selected = preparePrivateSqliteLocation(path);
    this.databasePath = selected;
    this.preexistingFiles = new Set(selected === ":memory:" ? [] : [selected, `${selected}-wal`, `${selected}-shm`].filter(existsSync));
    const before = selected === ":memory:" || !existsSync(selected) ? undefined : lstatSync(selected);
    this.db = openDatabase(selected);
    try {
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.trunc(this.busyTimeoutMs))}`);
      this.restrictFiles();
      if (before) {
        const after = lstatSync(selected);
        if (after.dev !== before.dev || after.ino !== before.ino) throw new Error("SQLite database path identity changed while opening");
      }
    } catch (error) { this.db.close(); throw error; }
  }
  private restrictFiles(): void {
    if (this.databasePath === ":memory:") return;
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (!existsSync(path)) continue;
      if (path === this.databasePath && this.preexistingFiles.has(path)) verifyPrivatePathAccess(path, "file");
      else if (path === this.databasePath) securePrivatePath(path, "file");
      else securePrivateSqliteSidecar(path);
    }
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
    const versionRow = this.db.prepare("SELECT sqlite_version() AS version").get() as Row;
    const parts = String(versionRow.version).split(".").map(Number);
    const encoded = (parts[0] ?? 0) * 1_000_000 + (parts[1] ?? 0) * 1_000 + (parts[2] ?? 0);
    if (encoded < 3_051_003) throw new Error("SQLite 3.51.3 or newer is required");
    assertLocalUpgradeCandidate(this.db);
    await retrySqliteBusy(() => this.db.exec(schema), this.busyTimeoutMs);
    await retrySqliteBusy(() => this.db.exec("BEGIN IMMEDIATE"), this.busyTimeoutMs);
    try {
      const columns = this.db.prepare("PRAGMA table_info(bridge_messages)").all() as Row[];
      if (!columns.some((column) => column.name === "project")) {
        this.db.exec("ALTER TABLE bridge_messages ADD COLUMN project TEXT");
      }
      const addedDeliveryPolicy = !columns.some((column) => column.name === "delivery_policy");
      if (addedDeliveryPolicy) {
        this.db.exec("DROP TRIGGER IF EXISTS bridge_messages_no_update");
        this.db.exec(`ALTER TABLE bridge_messages ADD COLUMN delivery_policy TEXT NOT NULL DEFAULT '{"mode":"leased","maxAttempts":5,"retryBaseDelayMs":1000,"retryMaxDelayMs":60000,"retryJitterRatio":0.2}'`);
        this.db.exec("CREATE TRIGGER bridge_messages_no_update BEFORE UPDATE ON bridge_messages BEGIN SELECT RAISE(ABORT, 'bridge messages are immutable'); END");
      }
      const legacyPolicy = addedDeliveryPolicy || Boolean((this.db.prepare(`SELECT 1 FROM bridge_messages
        WHERE json_type(delivery_policy,'$.publisherOwned') IS NOT NULL
           OR json_type(delivery_policy,'$.baseDelayMs') IS NOT NULL
           OR json_type(delivery_policy,'$.maxDelayMs') IS NOT NULL
           OR json_type(delivery_policy,'$.jitterRatio') IS NOT NULL
        LIMIT 1`).get() as Row | undefined));
      if (legacyPolicy) {
        this.db.exec("DROP TRIGGER IF EXISTS bridge_messages_no_update");
        if (addedDeliveryPolicy) {
          this.db.exec(`UPDATE bridge_messages SET delivery_policy=CASE
            WHEN json_array_length(targets)=0 THEN '{"mode":"mailbox"}'
            ELSE '{"mode":"leased","maxAttempts":5,"retryBaseDelayMs":1000,"retryMaxDelayMs":60000,"retryJitterRatio":0.2}' END`);
        } else {
          this.db.exec(`UPDATE bridge_messages SET delivery_policy=CASE
            WHEN json_extract(delivery_policy,'$.mode')='mailbox' THEN
              json_remove(delivery_policy,'$.publisherOwned','$.maxAttempts','$.baseDelayMs','$.maxDelayMs','$.jitterRatio','$.retryBaseDelayMs','$.retryMaxDelayMs','$.retryJitterRatio','$.notBefore')
            ELSE json_set(
              json_remove(delivery_policy,'$.publisherOwned','$.baseDelayMs','$.maxDelayMs','$.jitterRatio'),
              '$.mode','leased',
              '$.maxAttempts',coalesce(json_extract(delivery_policy,'$.maxAttempts'),5),
              '$.retryBaseDelayMs',coalesce(json_extract(delivery_policy,'$.retryBaseDelayMs'),json_extract(delivery_policy,'$.baseDelayMs'),1000),
              '$.retryMaxDelayMs',coalesce(json_extract(delivery_policy,'$.retryMaxDelayMs'),json_extract(delivery_policy,'$.maxDelayMs'),60000),
              '$.retryJitterRatio',coalesce(json_extract(delivery_policy,'$.retryJitterRatio'),json_extract(delivery_policy,'$.jitterRatio'),0.2)
            ) END
            WHERE json_type(delivery_policy,'$.publisherOwned') IS NOT NULL
               OR json_type(delivery_policy,'$.baseDelayMs') IS NOT NULL
               OR json_type(delivery_policy,'$.maxDelayMs') IS NOT NULL
               OR json_type(delivery_policy,'$.jitterRatio') IS NOT NULL`);
        }
        this.db.exec("CREATE TRIGGER bridge_messages_no_update BEFORE UPDATE ON bridge_messages BEGIN SELECT RAISE(ABORT, 'bridge messages are immutable'); END");
      }
      const deliveryColumns = this.db.prepare("PRAGMA table_info(bridge_deliveries)").all() as Row[];
      if (!deliveryColumns.some((column) => column.name === "last_action")) {
        this.db.exec("DROP TRIGGER IF EXISTS bridge_delivery_events_insert; DROP TRIGGER IF EXISTS bridge_delivery_events_update; DROP INDEX IF EXISTS bridge_deliveries_claim");
        const eventColumns = this.db.prepare("PRAGMA table_info(bridge_delivery_events)").all() as Row[];
        this.db.exec(`CREATE TABLE bridge_delivery_events_v10 (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL,
          message_id TEXT NOT NULL, workspace TEXT NOT NULL, recipient TEXT NOT NULL,
          from_state TEXT, to_state TEXT NOT NULL, attempt INTEGER NOT NULL,
          cycle_attempt INTEGER NOT NULL, requeue_count INTEGER NOT NULL,
          lease_owner TEXT, error TEXT, actor TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL)`);
        if (eventColumns.length) {
          this.db.exec(`INSERT INTO bridge_delivery_events_v10
            (sequence,delivery_id,message_id,workspace,recipient,from_state,to_state,attempt,cycle_attempt,requeue_count,lease_owner,error,actor,action,created_at)
            SELECT event.sequence,event.delivery_id,event.message_id,event.workspace,event.recipient,
              event.from_state,event.to_state,event.attempt,event.attempt,0,event.lease_owner,event.error,
              CASE
                WHEN event.from_state IS NULL THEN message.source
                WHEN event.to_state='dead' AND event.error IN ('message expired','maximum attempts reached') THEN 'agent-bridge'
                WHEN event.to_state IN ('acked','retrying','dead') THEN coalesce(
                  event.lease_owner,
                  (SELECT claim.lease_owner FROM bridge_delivery_events claim
                   WHERE claim.delivery_id=event.delivery_id AND claim.to_state='claimed'
                     AND claim.attempt=event.attempt AND claim.sequence<event.sequence
                     AND claim.lease_owner IS NOT NULL
                   ORDER BY claim.sequence DESC LIMIT 1),
                  event.recipient)
                ELSE coalesce(event.lease_owner,event.recipient)
              END,CASE
                WHEN event.from_state IS NULL THEN 'created'
                WHEN event.to_state='claimed' THEN 'claim'
                WHEN event.to_state='acked' THEN 'ack'
                WHEN event.to_state='retrying' THEN 'nack_retry'
                WHEN event.to_state='dead' AND event.error='message expired' THEN 'message_expired'
                WHEN event.to_state='dead' AND event.error='maximum attempts reached' THEN 'attempts_exhausted'
                WHEN event.to_state='dead' THEN 'nack_dead'
                WHEN event.to_state='cancelled' THEN 'cancel'
                ELSE 'created' END,event.created_at
            FROM bridge_delivery_events event JOIN bridge_messages message
              ON message.workspace=event.workspace AND message.id=event.message_id`);
          this.db.exec("DROP TABLE bridge_delivery_events");
        }
        this.db.exec(`CREATE TABLE bridge_deliveries_v10 (
          id TEXT PRIMARY KEY, message_id TEXT NOT NULL, workspace TEXT NOT NULL, recipient TEXT NOT NULL,
          state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, cycle_attempt INTEGER NOT NULL DEFAULT 0,
          requeue_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, priority_rank INTEGER NOT NULL,
          available_at TEXT NOT NULL, lease_token TEXT, lease_owner TEXT,
          lease_expires_at TEXT, last_error TEXT, last_actor TEXT, last_action TEXT NOT NULL, UNIQUE(message_id, recipient),
          FOREIGN KEY(workspace,message_id) REFERENCES bridge_messages(workspace,id) ON DELETE CASCADE,
          CHECK(state IN ('pending','claimed','acked','retrying','dead','cancelled')),
          CHECK(attempt>=0 AND cycle_attempt>=0 AND cycle_attempt<=attempt AND requeue_count>=0),
          CHECK(priority_rank BETWEEN 0 AND 2),
          CHECK((state='claimed' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state<>'claimed' AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)))`);
        this.db.exec(`INSERT INTO bridge_deliveries_v10
          (id,message_id,workspace,recipient,state,attempt,cycle_attempt,requeue_count,created_at,priority_rank,available_at,lease_token,lease_owner,lease_expires_at,last_error,last_actor,last_action)
          SELECT delivery.id,delivery.message_id,delivery.workspace,delivery.recipient,delivery.state,delivery.attempt,delivery.attempt,0,
            message.created_at,CASE message.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
            delivery.available_at,delivery.lease_token,delivery.lease_owner,delivery.lease_expires_at,delivery.last_error,
            CASE
              WHEN delivery.state='pending' AND delivery.attempt=0 THEN message.source
              WHEN delivery.state='dead' AND delivery.last_error IN ('message expired','maximum attempts reached') THEN 'agent-bridge'
              ELSE coalesce(
                delivery.lease_owner,
                (SELECT event.lease_owner FROM bridge_delivery_events_v10 event
                 WHERE event.delivery_id=delivery.id AND event.to_state='claimed'
                   AND event.attempt=delivery.attempt AND event.lease_owner IS NOT NULL
                 ORDER BY event.sequence DESC LIMIT 1),
                delivery.recipient)
            END,CASE
              WHEN delivery.state='pending' AND delivery.attempt=0 THEN 'created'
              WHEN delivery.state='claimed' THEN 'claim'
              WHEN delivery.state='acked' THEN 'ack'
              WHEN delivery.state='retrying' THEN 'nack_retry'
              WHEN delivery.state='dead' AND delivery.last_error='message expired' THEN 'message_expired'
              WHEN delivery.state='dead' AND delivery.last_error='maximum attempts reached' THEN 'attempts_exhausted'
              WHEN delivery.state='dead' THEN 'nack_dead'
              WHEN delivery.state='cancelled' THEN 'cancel'
              ELSE 'created' END
          FROM bridge_deliveries delivery JOIN bridge_messages message
            ON message.workspace=delivery.workspace AND message.id=delivery.message_id`);
        this.db.exec("DROP TABLE bridge_deliveries; ALTER TABLE bridge_deliveries_v10 RENAME TO bridge_deliveries");
        this.db.exec("ALTER TABLE bridge_delivery_events_v10 RENAME TO bridge_delivery_events");
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS bridge_deliveries_claim ON bridge_deliveries(workspace,recipient,priority_rank,available_at,created_at,id) WHERE state IN ('pending','retrying','claimed'); CREATE INDEX IF NOT EXISTS bridge_deliveries_publisher ON bridge_deliveries(workspace,message_id,created_at,id); CREATE INDEX IF NOT EXISTS bridge_deliveries_terminal ON bridge_deliveries(workspace,recipient,state,created_at,id) WHERE state IN ('dead','cancelled'); CREATE INDEX IF NOT EXISTS bridge_delivery_events_lookup ON bridge_delivery_events(workspace,delivery_id,sequence)");
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS bridge_delivery_events_insert AFTER INSERT ON bridge_deliveries BEGIN INSERT INTO bridge_delivery_events (delivery_id,message_id,workspace,recipient,from_state,to_state,attempt,cycle_attempt,requeue_count,lease_owner,error,actor,action,created_at) VALUES (NEW.id,NEW.message_id,NEW.workspace,NEW.recipient,NULL,NEW.state,NEW.attempt,NEW.cycle_attempt,NEW.requeue_count,NEW.lease_owner,NEW.last_error,coalesce(NEW.last_actor,NEW.recipient),NEW.last_action,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
        CREATE TRIGGER IF NOT EXISTS bridge_delivery_events_update AFTER UPDATE ON bridge_deliveries WHEN OLD.state IS NOT NEW.state OR OLD.attempt IS NOT NEW.attempt OR OLD.requeue_count IS NOT NEW.requeue_count OR OLD.last_action IS NOT NEW.last_action BEGIN INSERT INTO bridge_delivery_events (delivery_id,message_id,workspace,recipient,from_state,to_state,attempt,cycle_attempt,requeue_count,lease_owner,error,actor,action,created_at) VALUES (NEW.id,NEW.message_id,NEW.workspace,NEW.recipient,OLD.state,NEW.state,NEW.attempt,NEW.cycle_attempt,NEW.requeue_count,NEW.lease_owner,NEW.last_error,coalesce(NEW.last_actor,NEW.recipient),NEW.last_action,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END`);
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS bridge_messages_policy_insert BEFORE INSERT ON bridge_messages
        WHEN NOT (
          json_valid(NEW.delivery_policy) AND json_type(NEW.delivery_policy)='object'
          AND NOT EXISTS (SELECT 1 FROM json_each(NEW.delivery_policy) WHERE key NOT IN ('mode','maxAttempts','retryBaseDelayMs','retryMaxDelayMs','retryJitterRatio','notBefore'))
          AND (
            (json_extract(NEW.delivery_policy,'$.mode')='mailbox' AND json_array_length(NEW.targets)>=0
              AND (SELECT count(*) FROM json_each(NEW.delivery_policy))=1)
            OR
            (json_extract(NEW.delivery_policy,'$.mode')='leased' AND json_array_length(NEW.targets)>0
              AND json_type(NEW.delivery_policy,'$.maxAttempts')='integer' AND json_extract(NEW.delivery_policy,'$.maxAttempts') BETWEEN 1 AND 100
              AND json_type(NEW.delivery_policy,'$.retryBaseDelayMs')='integer' AND json_extract(NEW.delivery_policy,'$.retryBaseDelayMs') BETWEEN 1 AND 3600000
              AND json_type(NEW.delivery_policy,'$.retryMaxDelayMs')='integer' AND json_extract(NEW.delivery_policy,'$.retryMaxDelayMs') BETWEEN json_extract(NEW.delivery_policy,'$.retryBaseDelayMs') AND 86400000
              AND json_type(NEW.delivery_policy,'$.retryJitterRatio') IN ('integer','real') AND json_extract(NEW.delivery_policy,'$.retryJitterRatio') BETWEEN 0 AND 1
              AND (json_type(NEW.delivery_policy,'$.notBefore') IS NULL OR (
                json_type(NEW.delivery_policy,'$.notBefore')='text'
                AND julianday(json_extract(NEW.delivery_policy,'$.notBefore')) IS NOT NULL
                AND (NEW.expires_at IS NULL OR julianday(json_extract(NEW.delivery_policy,'$.notBefore'))<julianday(NEW.expires_at))
              ))
            )
          )
        ) BEGIN SELECT RAISE(ABORT,'invalid delivery policy'); END`);
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS bridge_messages_domain_insert BEFORE INSERT ON bridge_messages
        WHEN NOT (json_valid(NEW.targets) AND json_type(NEW.targets)='array' AND NEW.priority IN ('info','high','urgent'))
        BEGIN SELECT RAISE(ABORT,'invalid message domain'); END`);
      this.db.exec("CREATE INDEX IF NOT EXISTS bridge_messages_project ON bridge_messages(workspace, project, sequence)");
      installLocalAuthorityMarkers(this.db);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.restrictFiles();
  }
  private async ready() { await this.initialize(); }
  async insertMessage(input: Omit<BridgeMessage, "sequence" | "createdAt">): Promise<InsertMessageResult> {
    await this.ready(); const createdAt = new Date().toISOString(); const storedPolicy = input.deliveryPolicy ?? (input.targets.length ? { mode: "leased" as const, maxAttempts: 5, retryBaseDelayMs: 1_000, retryMaxDelayMs: 60_000, retryJitterRatio: 0.2 } : { mode: "mailbox" as const });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.idempotencyKey) { const existing = this.db.prepare("SELECT * FROM bridge_messages WHERE workspace = ? AND source = ? AND idempotency_key = ?").get(input.workspace, input.source, input.idempotencyKey) as Row | undefined; if (existing) { const replay = message(existing); assertIdempotentReplay(replay, input); this.db.exec("COMMIT"); return { message: replay, created: false }; } }
      this.db.prepare(`INSERT INTO bridge_messages (id,workspace,project,source,type,content,content_type,data,targets,thread_id,reply_to_id,correlation_id,causation_id,priority,expires_at,idempotency_key,atrib_receipt_id,informed_by,metadata,delivery_policy,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id,input.workspace,input.project ?? null,input.source,input.type,input.content,input.contentType,stringify(input.data),JSON.stringify(input.targets),input.threadId ?? null,input.replyToId ?? null,input.correlationId ?? null,input.causationId ?? null,input.priority,input.expiresAt ?? null,input.idempotencyKey ?? null,input.atribReceiptId ?? null,stringify(input.informedBy),stringify(input.metadata),JSON.stringify(storedPolicy),createdAt);
      if (storedPolicy.mode === "leased") {
        const availableAt = storedPolicy.notBefore && storedPolicy.notBefore > createdAt ? storedPolicy.notBefore : createdAt;
        const priorityRank = input.priority === "urgent" ? 0 : input.priority === "high" ? 1 : 2;
        for (const recipient of input.targets) {
          this.db.prepare("INSERT INTO bridge_deliveries (id,message_id,workspace,recipient,state,created_at,priority_rank,available_at,last_actor,last_action) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .run(randomUUID(), input.id, input.workspace, recipient, "pending", createdAt, priorityRank, availableAt, input.source, "created");
        }
      }
      const row = this.db.prepare("SELECT * FROM bridge_messages WHERE id = ?").get(input.id) as Row; this.db.exec("COMMIT"); return { message: message(row), created: true };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  async listMessages(principal: BridgePrincipal, query: MessageQuery = {}): Promise<MessagePage> {
    await this.ready(); const scope = cursorScope(principal, query); const cursor = decodeCursor(query.cursor, scope); const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200); const now = new Date().toISOString();
    const highWaterRow = query.latest ? undefined : this.db.prepare("SELECT max(sequence) AS sequence FROM bridge_messages WHERE workspace=?").get(principal.workspace) as Row;
    const highWater = highWaterRow?.sequence === null || highWaterRow?.sequence === undefined
      ? undefined
      : String(highWaterRow.sequence);
    const mailbox = query.mailbox ?? "inbox"; const visibility = mailbox === "sent" ? "source = ?" : mailbox === "all" ? "(source = ? OR targets = '[]' OR EXISTS (SELECT 1 FROM json_each(targets) WHERE value = ?))" : "(targets = '[]' OR EXISTS (SELECT 1 FROM json_each(targets) WHERE value = ?))"; const clauses = ["workspace = ?", query.latest ? "1=1" : "sequence > ?", visibility]; const args: SQLInputValue[] = query.latest ? [principal.workspace] : [principal.workspace, cursor ?? "0"]; if (mailbox === "all") args.push(principal.agent, principal.agent); else args.push(principal.agent);
    if (highWater) { clauses.push("sequence <= ?"); args.push(highWater); }
    if (!query.includeExpired) { clauses.push("(expires_at IS NULL OR expires_at > ?)"); args.push(now); }
    if (query.types?.length) { clauses.push(`type IN (${query.types.map(() => "?").join(",")})`); args.push(...query.types); }
    if (query.source) { clauses.push("source = ?"); args.push(query.source); }
    if (query.project) { clauses.push("project = ?"); args.push(query.project); }
    if (query.since) { clauses.push("created_at >= ?"); args.push(query.since); }
    if (query.receiptState && query.receiptState !== "any") {
      clauses.push(`${query.receiptState === "unread" ? "NOT " : ""}EXISTS (SELECT 1 FROM bridge_receipts receipt WHERE receipt.workspace=bridge_messages.workspace AND receipt.message_id=bridge_messages.id AND receipt.principal=?)`);
      args.push(principal.agent);
    }
    if (query.threadId) { clauses.push("thread_id = ?"); args.push(query.threadId); }
    const rows = this.db.prepare(`SELECT * FROM bridge_messages WHERE ${clauses.join(" AND ")} ORDER BY sequence ${query.latest ? "DESC" : "ASC"} LIMIT ?`).all(...args, limit) as Row[];
    const messages = rows.map(message);
    const last = messages[messages.length - 1];
    if (query.latest) return { messages, cursor: messages[0] ? encodeCursor(messages[0].sequence, scope) : query.cursor };
    if (messages.length === limit) return { messages, cursor: encodeCursor(last!.sequence, scope) };
    return { messages, cursor: highWater ? encodeCursor(highWater, scope) : query.cursor };
  }
  async recordReceipt(principal: BridgePrincipal, messageIds: string[], readAt = new Date()): Promise<number> { await this.ready(); const stmt = this.db.prepare("INSERT OR IGNORE INTO bridge_receipts (workspace,message_id,principal,read_at) SELECT workspace,id,?,? FROM bridge_messages WHERE workspace=? AND id=? AND (targets='[]' OR EXISTS (SELECT 1 FROM json_each(targets) WHERE value=?))"); let changed = 0; this.db.exec("BEGIN IMMEDIATE"); try { for (const id of messageIds) changed += Number(stmt.run(principal.agent,readAt.toISOString(),principal.workspace,id,principal.agent).changes); this.db.exec("COMMIT"); return changed; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }
  async claimDelivery(principal: BridgePrincipal, options: ClaimOptions): Promise<BridgeDelivery | null> {
    await this.ready(); const now = options.now ?? new Date(); const nowText = now.toISOString(); const expires = new Date(now.getTime() + options.leaseMs).toISOString(); const owner = principal.instance ?? principal.agent;
    this.db.exec("BEGIN IMMEDIATE"); try {
      this.db.prepare("UPDATE bridge_deliveries SET state='dead',last_error='message expired',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_actor='agent-bridge',last_action='message_expired' WHERE workspace=? AND recipient=? AND state IN ('pending','retrying','claimed') AND EXISTS (SELECT 1 FROM bridge_messages message WHERE message.workspace=bridge_deliveries.workspace AND message.id=bridge_deliveries.message_id AND message.expires_at IS NOT NULL AND message.expires_at<=?)").run(principal.workspace,principal.agent,nowText);
      this.db.prepare("UPDATE bridge_deliveries SET state='dead',last_error='maximum attempts reached',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_actor='agent-bridge',last_action='attempts_exhausted' WHERE workspace=? AND recipient=? AND cycle_attempt>=(SELECT json_extract(delivery_policy,'$.maxAttempts') FROM bridge_messages WHERE workspace=bridge_deliveries.workspace AND id=bridge_deliveries.message_id) AND (state IN ('pending','retrying') OR (state='claimed' AND lease_expires_at<=?))").run(principal.workspace,principal.agent,nowText);
      this.db.prepare("UPDATE bridge_deliveries SET state='retrying',available_at=?,last_error='lease expired',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_actor='agent-bridge',last_action='lease_expired' WHERE workspace=? AND recipient=? AND state='claimed' AND lease_expires_at<=? AND cycle_attempt<(SELECT json_extract(delivery_policy,'$.maxAttempts') FROM bridge_messages WHERE workspace=bridge_deliveries.workspace AND id=bridge_deliveries.message_id)").run(nowText,principal.workspace,principal.agent,nowText);
      const candidate = this.db.prepare("SELECT delivery.id FROM bridge_deliveries delivery JOIN bridge_messages message ON message.workspace=delivery.workspace AND message.id=delivery.message_id WHERE delivery.workspace=? AND delivery.recipient=? AND delivery.state IN ('pending','retrying') AND delivery.available_at<=? AND delivery.cycle_attempt<json_extract(message.delivery_policy,'$.maxAttempts') AND (message.expires_at IS NULL OR message.expires_at>?) ORDER BY delivery.priority_rank,delivery.available_at,delivery.created_at,delivery.id LIMIT 1").get(principal.workspace,principal.agent,nowText,nowText) as Row | undefined;
      if (!candidate) { this.db.exec("COMMIT"); return null; }
      const candidateId = String(candidate.id);
      const token = randomUUID(); this.db.prepare("UPDATE bridge_deliveries SET state='claimed',attempt=attempt+1,cycle_attempt=cycle_attempt+1,lease_token=?,lease_owner=?,lease_expires_at=?,last_error=NULL,last_actor=?,last_action='claim' WHERE id=?").run(token,owner,expires,principal.agent,candidateId);
      const claimed = this.db.prepare("SELECT * FROM bridge_deliveries WHERE id=?").get(candidateId) as Row; this.db.exec("COMMIT"); return delivery(claimed);
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  async renewDelivery(principal: BridgePrincipal, id: string, token: string, leaseMs: number): Promise<BridgeDelivery | null> { await this.ready(); const now = new Date(); const expires = new Date(now.getTime() + leaseMs).toISOString(); const owner = principal.instance ?? principal.agent; const result = this.db.prepare("UPDATE bridge_deliveries SET lease_expires_at=? WHERE workspace=? AND recipient=? AND lease_owner=? AND id=? AND lease_token=? AND state='claimed' AND lease_expires_at > ?").run(expires,principal.workspace,principal.agent,owner,id,token,now.toISOString()); if (!result.changes) return null; return delivery(this.db.prepare("SELECT * FROM bridge_deliveries WHERE id=?").get(id) as Row); }
  async settleDelivery(principal: BridgePrincipal, id: string, token: string, state: "acked" | "retrying" | "dead", error?: string, _retryPolicy?: import("./bridge-domain.js").RetryPolicy): Promise<BridgeDelivery | null> {
    await this.ready(); const now = new Date(); const owner = principal.instance ?? principal.agent;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT delivery.*,message.delivery_policy FROM bridge_deliveries delivery JOIN bridge_messages message ON message.workspace=delivery.workspace AND message.id=delivery.message_id WHERE delivery.workspace=? AND delivery.recipient=? AND delivery.lease_owner=? AND delivery.id=? AND delivery.lease_token=? AND delivery.state='claimed' AND delivery.lease_expires_at>?").get(principal.workspace,principal.agent,owner,id,token,now.toISOString()) as Row | undefined;
      if (!current) { this.db.exec("COMMIT"); return null; }
      const policy = parse(current.delivery_policy);
      const exhausted = state === "retrying" && Number(current.cycle_attempt) >= Number(policy.maxAttempts);
      const nextState = exhausted ? "dead" : state;
      const exponential = Math.min(policy.retryMaxDelayMs, policy.retryBaseDelayMs * 2 ** Math.max(0, Number(current.cycle_attempt) - 1));
      const jitter = 1 + (Math.random() * 2 - 1) * policy.retryJitterRatio;
      const delay = nextState === "retrying" ? Math.max(1, Math.round(exponential * jitter)) : 0;
      const available = nextState === "retrying" ? new Date(now.getTime() + delay).toISOString() : String(current.available_at);
      const action = state === "acked" ? "ack" : state === "dead" ? "nack_dead" : exhausted ? "attempts_exhausted" : "nack_retry";
      this.db.prepare("UPDATE bridge_deliveries SET state=?,available_at=?,last_error=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_actor=?,last_action=? WHERE id=?").run(nextState,available,error?.slice(0,1024) ?? null,principal.agent,action,id);
      const result = delivery(this.db.prepare("SELECT * FROM bridge_deliveries WHERE id=?").get(id) as Row); this.db.exec("COMMIT"); return result;
    } catch (caught) { this.db.exec("ROLLBACK"); throw caught; }
  }
  async diagnostics(principal: BridgePrincipal): Promise<BridgeDiagnostics> {
    await this.ready();
    const now = new Date();
    const nowText = now.toISOString();
    const queue = this.db.prepare(`SELECT
      sum(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN state='claimed' THEN 1 ELSE 0 END) AS claimed,
      sum(CASE WHEN state='retrying' THEN 1 ELSE 0 END) AS retrying,
      sum(CASE WHEN state='dead' THEN 1 ELSE 0 END) AS dead,
      sum(CASE WHEN state='cancelled' THEN 1 ELSE 0 END) AS cancelled,
      min(CASE WHEN state IN ('pending','retrying') THEN available_at END) AS oldest_available,
      sum(CASE WHEN state IN ('pending','retrying') AND available_at<=? THEN 1 ELSE 0 END) AS due,
      sum(CASE WHEN state IN ('pending','retrying') AND available_at>? THEN 1 ELSE 0 END) AS scheduled,
      sum(CASE WHEN state='claimed' AND lease_expires_at<=? THEN 1 ELSE 0 END) AS expired_leases,
      min(CASE WHEN state IN ('pending','retrying') AND available_at<=? THEN available_at END) AS oldest_due
      FROM bridge_deliveries WHERE workspace=? AND recipient=?`).get(nowText, nowText, nowText, nowText, principal.workspace, principal.agent) as Row;
    const oldestDueAt = queue.oldest_due ? String(queue.oldest_due) : undefined;
    return { schemaVersion: "local-v2", deliverySupported: true, pending: Number(queue.pending ?? 0), claimed: Number(queue.claimed ?? 0), retrying: Number(queue.retrying ?? 0), dead: Number(queue.dead ?? 0), cancelled: Number(queue.cancelled ?? 0), oldestAvailableAt: queue.oldest_available ? String(queue.oldest_available) : undefined, due: Number(queue.due ?? 0), scheduled: Number(queue.scheduled ?? 0), expiredLeases: Number(queue.expired_leases ?? 0), oldestDueAt, queueLagMs: oldestDueAt ? Math.max(0, now.getTime() - Date.parse(oldestDueAt)) : 0 };
  }
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
  async listDeliveries(principal: BridgePrincipal, query: DeliveryQuery = {}) {
    await this.ready();
    const filters = { role: query.role ?? "all", states: [...(query.states ?? [])].sort(), messageId: query.messageId ?? null, recipient: query.recipient ?? null };
    const scope = scopedCursorScope("deliveries", principal, filters);
    const position = validateDeliveryCursorPosition(decodeScopedCursor(query.cursor, scope));
    const limit = query.limit ?? 50;
    const clauses = ["delivery.workspace=?"];
    const args: SQLInputValue[] = [principal.workspace];
    const role = query.role ?? "all";
    clauses.push(role === "recipient" ? "delivery.recipient=?" : role === "publisher" ? "message.source=?" : "(delivery.recipient=? OR message.source=?)");
    args.push(principal.agent); if (role === "all") args.push(principal.agent);
    if (position) { clauses.push("(delivery.created_at>? OR (delivery.created_at=? AND delivery.id>?))"); args.push(position.createdAt as string, position.createdAt as string, position.id as string); }
    if (query.messageId) { clauses.push("delivery.message_id=?"); args.push(query.messageId); }
    if (query.recipient) { clauses.push("delivery.recipient=?"); args.push(query.recipient); }
    if (query.states?.length) { clauses.push(`delivery.state IN (${query.states.map(() => "?").join(",")})`); args.push(...query.states); }
    const rows = this.db.prepare(`SELECT delivery.* FROM bridge_deliveries delivery JOIN bridge_messages message ON message.workspace=delivery.workspace AND message.id=delivery.message_id WHERE ${clauses.join(" AND ")} ORDER BY delivery.created_at,delivery.id LIMIT ?`).all(...args, limit) as Row[];
    const deliveries = rows.map(delivery); const last = deliveries[deliveries.length - 1];
    return { deliveries, cursor: deliveries.length === limit && last ? encodeScopedCursor(scope, { createdAt: last.createdAt, id: last.id }) : undefined };
  }
  async listDeliveryEvents(principal: BridgePrincipal, deliveryId: string, query: {cursor?:string;limit?:number} = {}) {
    await this.ready(); const limit = query.limit ?? 50;
    const scope = scopedCursorScope("delivery-events", principal, { deliveryId });
    const position = validateEventCursorPosition(decodeScopedCursor(query.cursor, scope));
    const rows = this.db.prepare("SELECT event.* FROM bridge_delivery_events event JOIN bridge_messages message ON message.workspace=event.workspace AND message.id=event.message_id WHERE event.workspace=? AND event.delivery_id=? AND event.sequence>? AND (event.recipient=? OR message.source=?) ORDER BY event.sequence LIMIT ?").all(principal.workspace,deliveryId,position ?? "0",principal.agent,principal.agent,limit) as Row[];
    const events = rows.map(deliveryEvent); const last = events[events.length - 1];
    return { events, cursor: events.length === limit && last ? encodeScopedCursor(scope, last.sequence) : undefined };
  }
  async cancelDelivery(principal: BridgePrincipal,id:string) {
    await this.ready(); this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT delivery.* FROM bridge_deliveries delivery JOIN bridge_messages message ON message.workspace=delivery.workspace AND message.id=delivery.message_id WHERE delivery.id=? AND delivery.workspace=? AND message.source=?").get(id,principal.workspace,principal.agent) as Row | undefined;
      if (!current) { this.db.exec("COMMIT"); return null; }
      if (current.state === "cancelled") { this.db.exec("COMMIT"); return delivery(current); }
      if (!["pending","retrying","claimed"].includes(String(current.state))) throw new DeliveryStateConflictError(`cannot cancel a ${current.state} delivery`);
      this.db.prepare("UPDATE bridge_deliveries SET state='cancelled',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,last_actor=?,last_action='cancel' WHERE id=?").run(principal.agent,id);
      const result = delivery(this.db.prepare("SELECT * FROM bridge_deliveries WHERE id=?").get(id) as Row); this.db.exec("COMMIT"); return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  async requeueDelivery(principal: BridgePrincipal,id:string) {
    await this.ready(); this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT delivery.*,message.expires_at,message.delivery_policy FROM bridge_deliveries delivery JOIN bridge_messages message ON message.workspace=delivery.workspace AND message.id=delivery.message_id WHERE delivery.id=? AND delivery.workspace=? AND message.source=?").get(id,principal.workspace,principal.agent) as Row | undefined;
      if (!current) { this.db.exec("COMMIT"); return null; }
      if (!["dead","cancelled"].includes(String(current.state))) throw new DeliveryStateConflictError(`cannot requeue a ${current.state} delivery`);
      const now = new Date().toISOString(); if (current.expires_at && String(current.expires_at) <= now) throw new DeliveryStateConflictError("cannot requeue an expired message");
      const policy = parse(current.delivery_policy); const availableAt = policy.notBefore && policy.notBefore > now ? policy.notBefore : now;
      this.db.prepare("UPDATE bridge_deliveries SET state='pending',available_at=?,cycle_attempt=0,requeue_count=requeue_count+1,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,last_actor=?,last_action='requeue' WHERE id=?").run(availableAt,principal.agent,id);
      const result = delivery(this.db.prepare("SELECT * FROM bridge_deliveries WHERE id=?").get(id) as Row); this.db.exec("COMMIT"); return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  async close(): Promise<void> { this.db.close(); }
}
