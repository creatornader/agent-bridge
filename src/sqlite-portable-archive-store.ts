import { existsSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";
import { canonicalJson, normalizeArchiveTimestamp, parsePortableArchiveMessage, parsePortableArchiveReceipt, PORTABLE_ARCHIVE_BATCH_BYTES, PORTABLE_ARCHIVE_BATCH_ROWS, PortableArchiveError, validateArchiveWorkspace, validatePortableArchiveRequestId } from "./portable-archive-format.js";
import { securePrivatePath, verifyPrivatePathAccess } from "./private-path.js";
import type {
  PortableArchiveExportSession,
  PortableArchiveExportStart,
  PortableArchiveImportPasses,
  PortableArchiveMessage,
  PortableArchiveMetadata,
  PortableArchiveReceipt,
  PortableArchiveResult,
  PortableArchiveStore,
} from "./portable-archive-store.js";

const require = createRequire(import.meta.url);
type Row = Record<string, unknown>;
const parse = (value: unknown): any => typeof value === "string" ? JSON.parse(value) : value;
const nullable = (value: unknown): string | null => value == null ? null : String(value);

function message(row: Row): PortableArchiveMessage {
  const policy = parse(row.delivery_policy) as PortableArchiveMessage["deliveryPolicy"];
  if (policy.mode === "leased" && policy.notBefore) policy.notBefore = normalizeArchiveTimestamp(policy.notBefore, "deliveryPolicy.notBefore");
  return {
    id: String(row.id), project: nullable(row.project), source: String(row.source), type: String(row.type),
    content: String(row.content), contentType: String(row.content_type), data: parse(row.data) ?? null,
    targets: parse(row.targets) ?? [], threadId: nullable(row.thread_id), replyToId: nullable(row.reply_to_id),
    correlationId: nullable(row.correlation_id), causationId: nullable(row.causation_id),
    priority: row.priority as PortableArchiveMessage["priority"],
    expiresAt: row.expires_at == null ? null : normalizeArchiveTimestamp(String(row.expires_at), "expiresAt"),
    idempotencyKey: nullable(row.idempotency_key), atribReceiptId: nullable(row.atrib_receipt_id),
    informedBy: parse(row.informed_by) ?? [], metadata: parse(row.metadata) ?? null, deliveryPolicy: policy,
    createdAt: normalizeArchiveTimestamp(String(row.created_at), "createdAt"),
  };
}

function receipt(row: Row): PortableArchiveReceipt {
  return { messageId: String(row.message_id), principal: String(row.principal), readAt: normalizeArchiveTimestamp(String(row.read_at), "readAt") };
}

function canonicalBatchBytes(kind: "message" | "receipt", batch: readonly unknown[]): number {
  return batch.reduce<number>((total, value) => total + Buffer.byteLength(canonicalJson({ kind, [kind]: value })) + 1, 0);
}

function assertPrivateDatabase(path: string) {
  if (path === ":memory:") return undefined;
  verifyPrivatePathAccess(dirname(path), "directory");
  securePrivatePath(path, "file");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new PortableArchiveError("local archive database must be a regular file");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new PortableArchiveError("local archive database is not owned by the current user");
  return stat;
}

export class SQLitePortableArchiveStore implements PortableArchiveStore {
  private readonly db: Database;
  constructor(private readonly path: string) {
    if (path !== ":memory:" && !existsSync(path)) throw new PortableArchiveError("local archive database does not exist");
    const before = assertPrivateDatabase(path);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    this.db = new DatabaseSync(path);
    try {
      if (before) {
        const after = lstatSync(path);
        if (before.dev !== after.dev || before.ino !== after.ino || before.isSymbolicLink() || !after.isFile()) {
          throw new PortableArchiveError("local archive database identity changed while opening");
        }
        verifyPrivatePathAccess(path, "file");
      }
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000");
      const tables = new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[]).map((row) => String(row.name)));
      if (!tables.has("bridge_messages") || !tables.has("bridge_receipts")) throw new PortableArchiveError("database is not a canonical local Agent Bridge store");
      if (tables.has("edge_outbox") || tables.has("edge_inbox")) throw new PortableArchiveError("edge databases cannot be used as portable archives");
    } catch (error) {
      try {
        this.db.close();
      } finally {
        throw error;
      }
    }
  }

  async beginExport(requestIdValue: string, workspaceValue: string): Promise<PortableArchiveExportStart> {
    validatePortableArchiveRequestId(requestIdValue);
    const workspace = validateArchiveWorkspace(workspaceValue);
    this.db.exec("BEGIN");
    let ended = false;
    const finish = (sql: "COMMIT" | "ROLLBACK") => { if (!ended) { this.db.exec(sql); ended = true; } };
    const db = this.db;
    const session: PortableArchiveExportSession = {
      async *messages() {
        for (const row of db.prepare("SELECT * FROM bridge_messages WHERE workspace=? ORDER BY created_at,id").iterate(workspace) as Iterable<Row>) yield message(row);
      },
      async *receipts() {
        for (const row of db.prepare(`SELECT receipt.message_id,receipt.principal,receipt.read_at
          FROM bridge_receipts receipt JOIN bridge_messages message
            ON message.workspace=receipt.workspace AND message.id=receipt.message_id
          WHERE receipt.workspace=? ORDER BY message.created_at,message.id,receipt.principal`).iterate(workspace) as Iterable<Row>) yield receipt(row);
      },
      async complete() { finish("COMMIT"); },
      async reconcile() { finish("COMMIT"); },
      async abandon() { finish("ROLLBACK"); },
      close() { finish("ROLLBACK"); },
    };
    return { status: "active", session, replayed: false };
  }

  async importWorkspace(requestId: string, archive: PortableArchiveMetadata, passes: PortableArchiveImportPasses, options: { apply: boolean }): Promise<PortableArchiveResult> {
    requestId = validatePortableArchiveRequestId(requestId);
    validateArchiveWorkspace(archive.workspace);
    this.db.exec("BEGIN IMMEDIATE");
    let messagesCreated = 0; let messagesReplayed = 0; let receiptsCreated = 0; let receiptsReplayed = 0;
    try {
      const selectMessage = this.db.prepare("SELECT * FROM bridge_messages WHERE workspace=? AND id=?");
      const selectIdempotent = this.db.prepare("SELECT id FROM bridge_messages WHERE workspace=? AND source=? AND idempotency_key=?");
      const insertMessage = this.db.prepare(`INSERT INTO bridge_messages (
        id,workspace,project,source,type,content,content_type,data,targets,thread_id,reply_to_id,
        correlation_id,causation_id,priority,expires_at,idempotency_key,atrib_receipt_id,informed_by,
        metadata,delivery_policy,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      let messageCount = 0;
      for await (const batch of passes.messageBatches()) {
        if (batch.length < 1 || batch.length > PORTABLE_ARCHIVE_BATCH_ROWS || canonicalBatchBytes("message", batch) > PORTABLE_ARCHIVE_BATCH_BYTES) throw new PortableArchiveError("archive message batch is invalid");
        for (const value of batch) {
        const archived = parsePortableArchiveMessage(value);
        messageCount += 1;
        const existingRow = selectMessage.get(archive.workspace, archived.id) as Row | undefined;
        if (existingRow) {
          if (canonicalJson(message(existingRow)) !== canonicalJson(archived)) throw new PortableArchiveError(`message conflict: ${archived.id}`);
          messagesReplayed += 1; continue;
        }
        if (archived.idempotencyKey) {
          const idempotent = selectIdempotent.get(archive.workspace, archived.source, archived.idempotencyKey) as Row | undefined;
          if (idempotent) throw new PortableArchiveError(`idempotency conflict: ${archived.idempotencyKey}`);
        }
        insertMessage.run(
          archived.id, archive.workspace, archived.project, archived.source, archived.type, archived.content,
          archived.contentType, archived.data === null ? null : JSON.stringify(archived.data), JSON.stringify(archived.targets),
          archived.threadId, archived.replyToId, archived.correlationId, archived.causationId, archived.priority,
          archived.expiresAt, archived.idempotencyKey, archived.atribReceiptId,
          archived.informedBy.length ? JSON.stringify(archived.informedBy) : null,
          archived.metadata === null ? null : JSON.stringify(archived.metadata), JSON.stringify(archived.deliveryPolicy), archived.createdAt,
        );
        messagesCreated += 1;
        }
      }
      if (messageCount !== archive.messageCount) throw new PortableArchiveError("archive message count changed between passes");
      const selectReceipt = this.db.prepare("SELECT read_at FROM bridge_receipts WHERE workspace=? AND message_id=? AND principal=?");
      const selectReceiptMessage = this.db.prepare("SELECT targets FROM bridge_messages WHERE workspace=? AND id=?");
      const insertReceipt = this.db.prepare("INSERT INTO bridge_receipts(workspace,message_id,principal,read_at) VALUES (?,?,?,?)");
      let receiptCount = 0;
      for await (const batch of passes.receiptBatches()) {
        if (batch.length < 1 || batch.length > PORTABLE_ARCHIVE_BATCH_ROWS || canonicalBatchBytes("receipt", batch) > PORTABLE_ARCHIVE_BATCH_BYTES) throw new PortableArchiveError("archive receipt batch is invalid");
        for (const value of batch) {
        const archived = parsePortableArchiveReceipt(value);
        receiptCount += 1;
        const receiptMessage = selectReceiptMessage.get(archive.workspace, archived.messageId) as Row | undefined;
        const targets = receiptMessage ? parse(receiptMessage.targets) as string[] : undefined;
        if (!targets || (targets.length > 0 && !targets.includes(archived.principal))) throw new PortableArchiveError(`receipt principal is not eligible: ${archived.messageId}/${archived.principal}`);
        const existing = selectReceipt.get(archive.workspace, archived.messageId, archived.principal) as Row | undefined;
        if (existing) {
          if (normalizeArchiveTimestamp(String(existing.read_at), "readAt") !== archived.readAt) throw new PortableArchiveError(`receipt conflict: ${archived.messageId}/${archived.principal}`);
          receiptsReplayed += 1;
        } else {
          insertReceipt.run(archive.workspace, archived.messageId, archived.principal, archived.readAt);
          receiptsCreated += 1;
        }
        }
      }
      if (receiptCount !== archive.receiptCount) throw new PortableArchiveError("archive receipt count changed between passes");
      this.db.exec(options.apply ? "COMMIT" : "ROLLBACK");
      return { requestId, workspace: archive.workspace, digest: archive.digest, apply: options.apply, messages: { created: messagesCreated, replayed: messagesReplayed }, receipts: { created: receiptsCreated, replayed: receiptsReplayed } };
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  close(): void { this.db.close(); }
}
