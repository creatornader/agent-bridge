import { describe, expect, it } from "vitest";
import { streamPortableArchive } from "../src/portable-archive.js";
import { PostgresPortableArchiveStore } from "../src/postgres-portable-archive-store.js";

class FakeDatabase {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  constructor(
    private readonly failSnapshot = false,
    private readonly replayedActive = false,
    private readonly completed = false,
  ) {}
  async query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    this.calls.push({ sql, values });
    if (this.failSnapshot && sql === "BEGIN ISOLATION LEVEL REPEATABLE READ") {
      throw new Error("snapshot failed");
    }
    if (sql.includes("archive_begin_operation")) {
      return { rows: [{
        replayed: this.replayedActive || this.completed,
        completed: this.completed,
        client_verified_digest: "a".repeat(64), message_count: "1", receipt_count: "0",
        published_at: "2026-07-14T10:20:31.123456Z",
      }], rowCount: 1 };
    }
    if (sql.includes("archive_export_messages") && values?.[2] == null) return { rows: [{
      id: "018f4a70-0000-7000-8000-000000000001", project: null, source: "codex", type: "context",
      content: "hello", content_type: "text/plain", data: null, targets: [], thread_id: null,
      reply_to_id: null, correlation_id: null, causation_id: null, priority: "info", expires_at: null,
      idempotency_key: null, atrib_receipt_id: null, informed_by: [], metadata: null,
      delivery_mode: "mailbox", delivery_max_attempts: null, delivery_retry_base_delay_ms: null,
      delivery_retry_max_delay_ms: null, delivery_retry_jitter_ratio: null, delivery_not_before: null,
      created_at: "2026-07-14T10:20:30.123456Z",
    }], rowCount: 1 };
    if (sql.includes("archive_export_receipts")) return { rows: [], rowCount: 0 };
    if (sql.includes("archive_complete_import")) return { rows: [{
      replayed: false, message_count: "1", receipt_count: "0",
      message_inserted_count: "1", receipt_inserted_count: "0",
    }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
}

const metadata = {
  exportRequestId: "018f4a70-0000-7000-8000-000000000010",
  workspace: "acme", digest: `sha256:${"a".repeat(64)}`, messageCount: 1, receiptCount: 0,
};
const archivedMessage = {
  id: "018f4a70-0000-7000-8000-000000000001", project: null, source: "codex", type: "context",
  content: "hello", contentType: "text/plain", data: null, targets: [], threadId: null,
  replyToId: null, correlationId: null, causationId: null, priority: "info" as const, expiresAt: null,
  idempotencyKey: null, atribReceiptId: null, informedBy: [], metadata: null,
  deliveryPolicy: { mode: "mailbox" as const }, createdAt: "2026-07-14T10:20:30.123456Z",
};

describe("PostgreSQL portable archive adapter", () => {
  it("holds one snapshot, pages both streams, and completes only after publication", async () => {
    const db = new FakeDatabase();
    const started = await new PostgresPortableArchiveStore(db).beginExport(
      "018f4a70-0000-7000-8000-000000000010", "acme",
    );
    if (started.status !== "active") throw new Error("expected active export");
    const { session } = started;
    const chunks: Buffer[] = [];
    const streamed = await streamPortableArchive(
      session, "acme", "018f4a70-0000-7000-8000-000000000010",
      (bytes) => { chunks.push(bytes); },
    );
    await session.complete({
      ...streamed, publishedAt: "2026-07-14T10:20:31.123456Z",
    });
    await session.close();
    expect(Buffer.concat(chunks).toString()).toContain("hello");
    expect(db.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "SELECT * FROM agent_bridge.archive_begin_operation($1,'export',$2,NULL,NULL,NULL)",
      "COMMIT",
      "BEGIN ISOLATION LEVEL REPEATABLE READ",
      "SELECT agent_bridge.archive_authorize_transaction($1,'export',$2,NULL)",
      "SELECT * FROM agent_bridge.archive_export_messages($1,$2,$3::timestamptz,$4::uuid,200)",
      "SELECT * FROM agent_bridge.archive_export_receipts($1,$2,$3::timestamptz,$4::uuid,$5,500)",
      "SELECT * FROM agent_bridge.archive_export_messages($1,$2,$3::timestamptz,$4::uuid,200)",
      "SELECT * FROM agent_bridge.archive_complete_export($1,$2,$3,$4,$5,$6::timestamptz,$7)",
      "SELECT agent_bridge.archive_close_transaction_authorization($1)",
      "COMMIT",
    ]);
    expect(db.calls.find((call) => call.sql.includes("archive_complete_export"))?.values).toEqual([
      "018f4a70-0000-7000-8000-000000000010", "acme", streamed.digest.slice("sha256:".length),
      streamed.messageCount, streamed.receiptCount, "2026-07-14T10:20:31.123456Z", "published",
    ]);
  });

  it("records a bounded abandonment code", async () => {
    const db = new FakeDatabase();
    const started = await new PostgresPortableArchiveStore(db).beginExport(
      "018f4a70-0000-7000-8000-000000000010", "acme",
    );
    if (started.status !== "active") throw new Error("expected active export");
    const { session } = started;
    await session.abandon("publication_failed");
    await session.close();
    expect(db.calls.find((call) => call.sql.includes("archive_abandon_operation"))?.values)
      .toEqual(["018f4a70-0000-7000-8000-000000000010", "acme", "publication_failed"]);
  });

  it("finalizes a committed begin when the read-only snapshot cannot open", async () => {
    const db = new FakeDatabase(true);
    await expect(new PostgresPortableArchiveStore(db).beginExport(
      "018f4a70-0000-7000-8000-000000000010", "acme",
    )).rejects.toThrow(/snapshot failed/);
    expect(db.calls.find((call) => call.sql.includes("archive_abandon_operation"))?.values)
      .toEqual(["018f4a70-0000-7000-8000-000000000010", "acme"]);
    expect(db.calls.find((call) => call.sql.includes("snapshot_failed"))).toBeTruthy();
  });

  it("returns replayed active exports for reconciliation without opening a snapshot", async () => {
    const db = new FakeDatabase(true, true);
    const started = await new PostgresPortableArchiveStore(db).beginExport(
      "018f4a70-0000-7000-8000-000000000010", "acme",
    );
    if (started.status !== "active") throw new Error("expected active export");
    expect(started.replayed).toBe(true);
    await started.session.reconcile({
      ...metadata, publishedAt: "2026-07-14T10:20:31.123456Z",
    });
    await started.session.close();
    expect(db.calls.some((call) => call.sql.startsWith("BEGIN ISOLATION"))).toBe(false);
    expect(db.calls.find((call) => call.sql.includes("archive_reconcile_export"))?.values).toEqual([
      "018f4a70-0000-7000-8000-000000000010", "acme", "a".repeat(64), 1, 0,
      "2026-07-14T10:20:31.123456Z",
    ]);
  });

  it("rejects reconciliation metadata from a different export request", async () => {
    const db = new FakeDatabase(false, true);
    const started = await new PostgresPortableArchiveStore(db).beginExport(
      "018f4a70-0000-7000-8000-000000000010", "acme",
    );
    if (started.status !== "active") throw new Error("expected active export");
    await expect(started.session.reconcile({
      ...metadata,
      exportRequestId: "018f4a70-0000-7000-8000-000000000099",
      publishedAt: "2026-07-14T10:20:31.123456Z",
    })).rejects.toThrow(/cannot be reconciled/);
    expect(db.calls.some((call) => call.sql.includes("archive_reconcile_export"))).toBe(false);
    await started.session.close();
  });

  it("returns normalized terminal replay metadata without opening a snapshot", async () => {
    const db = new FakeDatabase(false, false, true);
    await expect(new PostgresPortableArchiveStore(db).beginExport(
      "018F4A70-0000-7000-8000-000000000010", "acme",
    )).resolves.toEqual({
      status: "completed",
      metadata: {
        exportRequestId: "018f4a70-0000-7000-8000-000000000010",
        workspace: "acme", digest: `sha256:${"a".repeat(64)}`,
        messageCount: 1, receiptCount: 0, publishedAt: "2026-07-14T10:20:31.123456Z",
      },
    });
    expect(db.calls.some((call) => call.sql.startsWith("BEGIN ISOLATION"))).toBe(false);
    expect(db.calls.find((call) => call.sql.includes("archive_begin_operation"))?.values?.[0])
      .toBe("018f4a70-0000-7000-8000-000000000010");
  });

  it("uses one transaction for bounded import passes and rolls dry-runs back", async () => {
    const db = new FakeDatabase(); const store = new PostgresPortableArchiveStore(db);
    const result = await store.importWorkspace(
      "018f4a70-0000-7000-8000-000000000011", metadata,
      {
        async *messageBatches() { yield [archivedMessage]; },
        async *receiptBatches() {},
      },
      { apply: false },
    );
    expect(result).toMatchObject({
      apply: false, messages: { created: 1, replayed: 0 }, receipts: { created: 0, replayed: 0 },
    });
    expect(db.calls[0]?.sql).toBe("BEGIN");
    expect(db.calls[db.calls.length - 1]?.sql).toBe("ROLLBACK");
    expect(db.calls.find((call) => call.sql.includes("archive_authorize_transaction"))?.values)
      .toEqual(["018f4a70-0000-7000-8000-000000000011", "acme", "a".repeat(64)]);
    expect(db.calls.find((call) => call.sql.includes("archive_import_messages"))?.values?.[3]).toBe(0);
  });
});
