import type { PgQueryable, PgTransactionClient } from "./postgres-bridge-store.js";
import { normalizeArchiveTimestamp, validatePortableArchiveRequestId } from "./portable-archive-format.js";
import type {
  PortableArchiveExportStart,
  PortableArchiveExportSession,
  PortableArchiveImportPasses,
  PortableArchiveMessage,
  PortableArchiveMetadata,
  PortableArchiveReceipt,
  PortableArchiveResult,
  PortableArchiveStore,
} from "./portable-archive-store.js";

type Row = Record<string, any>;
type Connection = PgQueryable | PgTransactionClient;
const parse = (value: unknown): any => typeof value === "string" ? JSON.parse(value) : value;
const nullable = (value: unknown): string | null => value == null ? null : String(value);

function message(row: Row): PortableArchiveMessage {
  const deliveryPolicy: PortableArchiveMessage["deliveryPolicy"] = row.delivery_mode === "mailbox"
    ? { mode: "mailbox" }
    : {
        mode: "leased", maxAttempts: Number(row.delivery_max_attempts),
        retryBaseDelayMs: Number(row.delivery_retry_base_delay_ms), retryMaxDelayMs: Number(row.delivery_retry_max_delay_ms),
        retryJitterRatio: Number(row.delivery_retry_jitter_ratio),
        ...(row.delivery_not_before ? { notBefore: normalizeArchiveTimestamp(String(row.delivery_not_before), "deliveryPolicy.notBefore") } : {}),
      };
  return {
    id: String(row.id), project: nullable(row.project), source: String(row.source), type: String(row.type),
    content: String(row.content), contentType: String(row.content_type), data: parse(row.data) ?? null,
    targets: parse(row.targets) ?? [], threadId: nullable(row.thread_id), replyToId: nullable(row.reply_to_id),
    correlationId: nullable(row.correlation_id), causationId: nullable(row.causation_id),
    priority: row.priority, expiresAt: row.expires_at ? normalizeArchiveTimestamp(String(row.expires_at), "expiresAt") : null,
    idempotencyKey: nullable(row.idempotency_key), atribReceiptId: nullable(row.atrib_receipt_id),
    informedBy: parse(row.informed_by) ?? [], metadata: parse(row.metadata) ?? null, deliveryPolicy,
    createdAt: normalizeArchiveTimestamp(String(row.created_at), "createdAt"),
  };
}

function receipt(row: Row): PortableArchiveReceipt {
  return {
    messageId: String(row.message_id), principal: String(row.principal),
    readAt: normalizeArchiveTimestamp(String(row.read_at), "readAt"),
  };
}

export class PostgresPortableArchiveStore implements PortableArchiveStore {
  constructor(private readonly db: PgQueryable) {}

  async beginExport(requestId: string, workspace: string): Promise<PortableArchiveExportStart> {
    const normalizedRequestId = validatePortableArchiveRequestId(requestId);
    const connection = this.db.connect ? await this.db.connect() : this.db;
    let snapshotOpen = false;
    let beginCommitted = false;
    let beginReplayed = false;
    let released = false;
    let final = false;
    let messagesRead = false;
    let receiptsRead = false;
    const release = () => {
      if (!released && connection !== this.db && typeof connection.release === "function") connection.release();
      released = true;
    };
    try {
      await connection.query("BEGIN");
      const begun = await connection.query<Row>(
        "SELECT * FROM agent_bridge.archive_begin_operation($1,'export',$2,NULL,NULL,NULL)",
        [normalizedRequestId, workspace],
      );
      const prior = begun.rows[0];
      beginReplayed = Boolean(prior?.replayed);
      await connection.query("COMMIT");
      beginCommitted = true;
      if (prior?.completed) {
        release();
        return {
          status: "completed",
          metadata: {
            exportRequestId: normalizedRequestId,
            workspace,
            digest: `sha256:${String(prior.client_verified_digest)}`,
            messageCount: Number(prior.message_count),
            receiptCount: Number(prior.receipt_count),
            publishedAt: normalizeArchiveTimestamp(String(prior.published_at), "publishedAt"),
          },
        };
      }
      if (beginReplayed) {
        const unavailable = async function* (): AsyncIterable<never> {
          throw new Error("replayed archive export is reconciliation-only");
        };
        const reconciliationSession: PortableArchiveExportSession = {
          messages: unavailable,
          receipts: unavailable,
          complete: async () => { throw new Error("replayed archive export cannot be published again"); },
          reconcile: async (result) => {
            if (final || result.exportRequestId !== normalizedRequestId || result.workspace !== workspace) {
              throw new Error("archive export session cannot be reconciled");
            }
            await connection.query(
              "SELECT * FROM agent_bridge.archive_reconcile_export($1,$2,$3,$4,$5,$6::timestamptz)",
              [normalizedRequestId, workspace, result.digest.slice("sha256:".length), result.messageCount, result.receiptCount, result.publishedAt],
            );
            final = true;
          },
          abandon: async (reason) => {
            if (final) return;
            await connection.query(
              "SELECT * FROM agent_bridge.archive_abandon_operation($1,$2,$3)",
              [normalizedRequestId, workspace, reason],
            );
            final = true;
          },
          close: release,
        };
        return { status: "active", session: reconciliationSession, replayed: true };
      }
      await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      snapshotOpen = true;
      await connection.query(
        "SELECT agent_bridge.archive_authorize_transaction($1,'export',$2,NULL)",
        [normalizedRequestId, workspace],
      );
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => undefined);
      let abandonmentError: unknown;
      if (beginCommitted) {
        try {
          await connection.query(
            "SELECT * FROM agent_bridge.archive_abandon_operation($1,$2,'snapshot_failed')",
            [normalizedRequestId, workspace],
          );
        } catch (failure) { abandonmentError = failure; }
      }
      release();
      if (abandonmentError) {
        const combined = new Error("archive snapshot and abandonment both failed") as Error & { errors: unknown[] };
        combined.errors = [error, abandonmentError];
        throw combined;
      }
      throw error;
    }

    const endSnapshot = async (commit: boolean): Promise<void> => {
      if (!snapshotOpen) return;
      if (commit) {
        await connection.query(
          "SELECT agent_bridge.archive_close_transaction_authorization($1)",
          [normalizedRequestId],
        );
        await connection.query("COMMIT");
      } else {
        await connection.query("ROLLBACK");
      }
      snapshotOpen = false;
    };
    const session: PortableArchiveExportSession = {
      messages: async function* () {
        if (final || messagesRead) throw new Error("archive export message pass is unavailable");
        messagesRead = true;
        let createdAt: string | null = null;
        let id: string | null = null;
        for (;;) {
          const result: { rows: Row[]; rowCount: number | null } = await connection.query<Row>(
            "SELECT * FROM agent_bridge.archive_export_messages($1,$2,$3::timestamptz,$4::uuid,200)",
            [normalizedRequestId, workspace, createdAt, id],
          );
          for (const row of result.rows) yield message(row);
          if (result.rows.length === 0) return;
          const last: Row = result.rows[result.rows.length - 1]!;
          createdAt = String(last.created_at);
          id = String(last.id);
        }
      },
      receipts: async function* () {
        if (final || receiptsRead) throw new Error("archive export receipt pass is unavailable");
        receiptsRead = true;
        let createdAt: string | null = null;
        let messageId: string | null = null;
        let principal: string | null = null;
        for (;;) {
          const result: { rows: Row[]; rowCount: number | null } = await connection.query<Row>(
            "SELECT * FROM agent_bridge.archive_export_receipts($1,$2,$3::timestamptz,$4::uuid,$5,500)",
            [normalizedRequestId, workspace, createdAt, messageId, principal],
          );
          for (const row of result.rows) yield receipt(row);
          if (result.rows.length === 0) return;
          const last: Row = result.rows[result.rows.length - 1]!;
          createdAt = String(last.message_created_at);
          messageId = String(last.message_id);
          principal = String(last.principal);
        }
      },
      complete: async (result) => {
        if (final || result.exportRequestId !== normalizedRequestId || result.workspace !== workspace
          || !messagesRead || !receiptsRead) {
          throw new Error("archive export session cannot be completed");
        }
        await connection.query(
          "SELECT * FROM agent_bridge.archive_complete_export($1,$2,$3,$4,$5,$6::timestamptz,$7)",
          [normalizedRequestId, workspace, result.digest.slice("sha256:".length), result.messageCount, result.receiptCount, result.publishedAt, "published"],
        );
        await endSnapshot(true);
        final = true;
      },
      reconcile: async () => {
        throw new Error("fresh archive export cannot be reconciled");
      },
      abandon: async (reason) => {
        if (final) return;
        await endSnapshot(false);
        await connection.query(
          "SELECT * FROM agent_bridge.archive_abandon_operation($1,$2,$3)",
          [normalizedRequestId, workspace, reason],
        );
        final = true;
      },
      close: async () => {
        if (snapshotOpen) {
          await connection.query("ROLLBACK").catch(() => undefined);
          snapshotOpen = false;
        }
        release();
      },
    };
    return { status: "active", session, replayed: beginReplayed };
  }

  async importWorkspace(
    requestId: string,
    metadata: PortableArchiveMetadata,
    passes: PortableArchiveImportPasses,
    options: { apply: boolean },
  ): Promise<PortableArchiveResult> {
    const normalizedRequestId = validatePortableArchiveRequestId(requestId);
    const connection = this.db.connect ? await this.db.connect() : this.db;
    try {
      await connection.query("BEGIN");
      const digest = metadata.digest.slice("sha256:".length);
      const begun = await connection.query<Row>(
        "SELECT * FROM agent_bridge.archive_begin_operation($1,'import',$2,$3,$4,$5)",
        [normalizedRequestId, metadata.workspace, digest, metadata.messageCount, metadata.receiptCount],
      );
      const prior = begun.rows[0];
      if (prior?.completed) {
        await connection.query("COMMIT");
        return {
          requestId: normalizedRequestId, workspace: metadata.workspace, digest: metadata.digest, apply: Boolean(prior.apply),
          messages: {
            created: Number(prior.message_inserted_count),
            replayed: Number(prior.message_count) - Number(prior.message_inserted_count),
          },
          receipts: {
            created: Number(prior.receipt_inserted_count),
            replayed: Number(prior.receipt_count) - Number(prior.receipt_inserted_count),
          },
        };
      }
      await connection.query(
        "SELECT agent_bridge.archive_authorize_transaction($1,'import',$2,$3)",
        [normalizedRequestId, metadata.workspace, digest],
      );
      let messageOrdinal = 0;
      for await (const batch of passes.messageBatches()) {
        await connection.query(
          "SELECT * FROM agent_bridge.archive_import_messages($1,$2,$3,$4,$5::jsonb)",
          [normalizedRequestId, metadata.workspace, digest, messageOrdinal, JSON.stringify(batch)],
        );
        messageOrdinal += 1;
      }
      let receiptOrdinal = 0;
      for await (const batch of passes.receiptBatches()) {
        await connection.query(
          "SELECT * FROM agent_bridge.archive_import_receipts($1,$2,$3,$4,$5::jsonb)",
          [normalizedRequestId, metadata.workspace, digest, receiptOrdinal, JSON.stringify(batch)],
        );
        receiptOrdinal += 1;
      }
      const completed = await connection.query<Row>(
        "SELECT * FROM agent_bridge.archive_complete_import($1,$2,$3)",
        [normalizedRequestId, metadata.workspace, options.apply],
      );
      const result = completed.rows[0]!;
      await connection.query(options.apply ? "COMMIT" : "ROLLBACK");
      return {
        requestId: normalizedRequestId, workspace: metadata.workspace, digest: metadata.digest, apply: options.apply,
        messages: {
          created: Number(result.message_inserted_count),
          replayed: Number(result.message_count) - Number(result.message_inserted_count),
        },
        receipts: {
          created: Number(result.receipt_inserted_count),
          replayed: Number(result.receipt_count) - Number(result.receipt_inserted_count),
        },
      };
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      if (connection !== this.db && typeof connection.release === "function") connection.release();
    }
  }
}
