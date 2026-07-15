import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeService } from "../src/bridge-service.js";
import { decodePortableArchive, encodePortableArchive, exportPortableArchive, importPortableArchive } from "../src/archive.js";
import { SQLiteBridgeStore } from "../src/sqlite-bridge-store.js";
import { SQLitePortableArchiveStore } from "../src/sqlite-portable-archive-store.js";

const require = createRequire(import.meta.url);
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

async function database(name: string): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), `agent-bridge-archive-${name}-`)); directories.push(directory);
  const path = join(directory, "bridge.sqlite3");
  const store = new SQLiteBridgeStore(path); await store.initialize(); await store.close(); return path;
}

async function seededDatabase(): Promise<string> {
  const path = await database("source");
  const store = new SQLiteBridgeStore(path); await store.initialize();
  const service = new BridgeService(store);
  const principal = { workspace: "acme", agent: "codex" };
  const published = await service.publish(principal, {
    id: "018f4a70-0000-7000-8000-000000000001", type: "context", content: "portable",
    targets: ["worker"], idempotencyKey: "portable-1",
    deliveryPolicy: { mode: "leased", maxAttempts: 3, retryBaseDelayMs: 100, retryMaxDelayMs: 1000, retryJitterRatio: 0 },
  });
  await store.recordReceipt({ workspace: "acme", agent: "worker" }, [published.message.id], new Date("2026-07-14T12:00:00.123Z"));
  await store.close(); return path;
}

function counts(path: string): Record<string, number> {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const count = (table: string) => Number((db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);
    return { messages: count("bridge_messages"), receipts: count("bridge_receipts"), deliveries: count("bridge_deliveries"), events: count("bridge_delivery_events"), presence: count("bridge_presence") };
  } finally { db.close(); }
}

describe("SQLite portable archives", () => {
  it("holds a WAL snapshot while concurrent messages are published", async () => {
    const path = await seededDatabase();
    const archive = new SQLitePortableArchiveStore(path);
    const start = await archive.beginExport("018f4a70-0000-7000-8000-000000000020", "acme");
    if (start.status !== "active") throw new Error("SQLite export unexpectedly completed before streaming");
    const session = start.session;
    const iterator = session.messages()[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    const writer = new SQLiteBridgeStore(path); await writer.initialize();
    await new BridgeService(writer).publish({ workspace: "acme", agent: "codex" }, { type: "context", content: "concurrent" });
    await writer.close();
    expect((await iterator.next()).done).toBe(true);
    await session.abandon("not_published"); await session.close(); archive.close();
  });

  it("dry-runs and applies the same exact import without delivery side effects", async () => {
    const sourcePath = await seededDatabase(); const targetPath = await database("target");
    const source = new SQLitePortableArchiveStore(sourcePath);
    const bytes = await exportPortableArchive(source, "acme", "018f4a70-0000-7000-8000-000000000060"); source.close();
    const target = new SQLitePortableArchiveStore(targetPath);
    const dryRun = await importPortableArchive(target, bytes, { requestId: "018f4a70-0000-7000-8000-000000000010" });
    expect(dryRun).toMatchObject({ apply: false, messages: { created: 1, replayed: 0 }, receipts: { created: 1, replayed: 0 } });
    expect(counts(targetPath)).toEqual({ messages: 0, receipts: 0, deliveries: 0, events: 0, presence: 0 });
    const applied = await importPortableArchive(target, bytes, { requestId: "018f4a70-0000-7000-8000-000000000011", apply: true });
    expect(applied).toMatchObject({ apply: true, messages: { created: 1, replayed: 0 }, receipts: { created: 1, replayed: 0 } });
    expect(counts(targetPath)).toEqual({ messages: 1, receipts: 1, deliveries: 0, events: 0, presence: 0 });
    const replay = await importPortableArchive(target, bytes, { requestId: "018f4a70-0000-7000-8000-000000000012", apply: true });
    expect(replay).toMatchObject({ messages: { created: 0, replayed: 1 }, receipts: { created: 0, replayed: 1 } });
    target.close();
  });

  it("re-exports byte-identically even though local sequence changes", async () => {
    const sourcePath = await seededDatabase(); const targetPath = await database("target");
    const targetBridge = new SQLiteBridgeStore(targetPath); await targetBridge.initialize();
    await new BridgeService(targetBridge).publish({ workspace: "other", agent: "codex" }, { type: "noise", content: "takes sequence one" });
    await targetBridge.close();
    const exportRequestId = "018f4a70-0000-7000-8000-000000000061";
    const source = new SQLitePortableArchiveStore(sourcePath); const original = await exportPortableArchive(source, "acme", exportRequestId); source.close();
    const target = new SQLitePortableArchiveStore(targetPath);
    await importPortableArchive(target, original, { requestId: "018f4a70-0000-7000-8000-000000000013", apply: true });
    const roundTrip = await exportPortableArchive(target, "acme", exportRequestId); target.close();
    expect(roundTrip).toEqual(original);
    expect(decodePortableArchive(roundTrip).messages).toHaveLength(1);
  });

  it("canonicalizes new API message IDs and replays the same database exactly", async () => {
    const path = await database("uppercase-api");
    const bridge = new SQLiteBridgeStore(path); await bridge.initialize();
    const id = "018F4A70-0000-7000-8000-0000000000AA";
    const published = await new BridgeService(bridge).publish(
      { workspace: "acme", agent: "codex" },
      { id, type: "context", content: "canonical id" },
    );
    expect(published.message.id).toBe(id.toLowerCase());
    await bridge.close();
    const archiveStore = new SQLitePortableArchiveStore(path);
    const bytes = await exportPortableArchive(archiveStore, "acme", "018f4a70-0000-7000-8000-000000000062");
    expect(decodePortableArchive(bytes).messages[0]!.id).toBe(id.toLowerCase());
    const replay = await importPortableArchive(archiveStore, bytes, {
      requestId: "018F4A70-0000-7000-8000-0000000000BB", apply: true,
    });
    expect(replay).toMatchObject({
      requestId: "018f4a70-0000-7000-8000-0000000000bb",
      messages: { created: 0, replayed: 1 },
    });
    archiveStore.close();
  });

  it("rejects invalid request IDs and domain records at the store boundary", async () => {
    const path = await database("domain-guard"); const target = new SQLitePortableArchiveStore(path);
    const invalid = decodePortableArchive(encodePortableArchive({ exportRequestId: "018f4a70-0000-7000-8000-000000000063", workspace: "acme", messages: [
      {
        id: "018f4a70-0000-7000-8000-000000000001", project: null, source: "codex", type: "context",
        content: "valid", contentType: "text/plain", data: null, targets: [], threadId: null,
        replyToId: null, correlationId: null, causationId: null, priority: "info", expiresAt: null,
        idempotencyKey: null, atribReceiptId: null, informedBy: [], metadata: null,
        deliveryPolicy: { mode: "mailbox" }, createdAt: "2026-07-14T10:20:30.123456Z",
      },
    ], receipts: [] }));
    await expect(target.importWorkspace("00000000-0000-0000-0000-000000000000", {
      exportRequestId: invalid.exportRequestId, workspace: "acme", digest: invalid.digest, messageCount: 1, receiptCount: 0,
    }, { async *messageBatches() { yield invalid.messages; }, async *receiptBatches() {} }, { apply: true }))
      .rejects.toThrow(/exportRequestId/);
    invalid.messages[0]!.source = " codex";
    await expect(target.importWorkspace("018f4a70-0000-7000-8000-000000000099", {
      exportRequestId: invalid.exportRequestId, workspace: "acme", digest: invalid.digest, messageCount: 1, receiptCount: 0,
    }, { async *messageBatches() { yield invalid.messages; }, async *receiptBatches() {} }, { apply: true }))
      .rejects.toThrow(/domain constraints/);
    expect(counts(path).messages).toBe(0); target.close();
  });

  it("rolls back conflicts and rejects edge databases", async () => {
    const sourcePath = await seededDatabase(); const targetPath = await database("target");
    const source = new SQLitePortableArchiveStore(sourcePath); const bytes = await exportPortableArchive(source, "acme", "018f4a70-0000-7000-8000-000000000064"); source.close();
    const target = new SQLitePortableArchiveStore(targetPath);
    await importPortableArchive(target, bytes, { requestId: "018f4a70-0000-7000-8000-000000000014", apply: true });
    const archive = decodePortableArchive(bytes); archive.messages[0]!.content = "changed";
    const changed = Buffer.from(JSON.stringify(archive));
    await expect(target.importWorkspace("018f4a70-0000-7000-8000-000000000015", {
      exportRequestId: archive.exportRequestId, workspace: archive.workspace, digest: `sha256:${"0".repeat(64)}`,
      messageCount: archive.messages.length, receiptCount: archive.receipts.length,
    }, {
      async *messageBatches() { yield archive.messages; },
      async *receiptBatches() { if (archive.receipts.length) yield archive.receipts; },
    }, { apply: true })).rejects.toThrow(/message conflict/);
    const ineligible = { messageId: archive.messages[0]!.id, principal: "intruder", readAt: "2026-07-14T12:00:00.123000Z" };
    await expect(target.importWorkspace("018f4a70-0000-7000-8000-000000000016", {
      exportRequestId: archive.exportRequestId, workspace: archive.workspace, digest: `sha256:${"1".repeat(64)}`,
      messageCount: 1, receiptCount: 1,
    }, {
      async *messageBatches() { const restored = { ...archive.messages[0]!, content: "portable" }; yield [restored]; },
      async *receiptBatches() { yield [ineligible]; },
    }, { apply: true })).rejects.toThrow(/not eligible/);
    expect(counts(targetPath).messages).toBe(1); target.close();
    expect(changed.length).toBeGreaterThan(0);

    const directory = mkdtempSync(join(tmpdir(), "agent-bridge-edge-")); directories.push(directory);
    const edge = join(directory, "edge.sqlite3");
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(edge); db.exec("CREATE TABLE edge_outbox(id TEXT); CREATE TABLE bridge_messages(id TEXT); CREATE TABLE bridge_receipts(id TEXT)"); db.close();
    expect(() => new SQLitePortableArchiveStore(edge)).toThrow(/edge databases/);
  });
});
