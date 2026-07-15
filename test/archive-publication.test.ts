import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArchiveCommandError, publishArchive, reconcileActiveExport, runArchiveCommand, verifyCompletedExport } from "../src/archive-cli.js";
import { SQLiteBridgeStore } from "../src/sqlite-bridge-store.js";
import {
  canonicalJson, decodePortableArchive, encodePortableArchive, PORTABLE_ARCHIVE_MAX_BYTES, streamPortableArchive,
  type PortableArchiveExportSession, type PortableArchiveMessage,
} from "../src/archive.js";
import { privateTestDirectory, secureTestFile } from "./private-test-path.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const message: PortableArchiveMessage = {
  id: "018f4a70-0000-7000-8000-000000000001", project: null, source: "codex", type: "context",
  content: "hello", contentType: "text/plain", data: null, targets: [], threadId: null, replyToId: null,
  correlationId: null, causationId: null, priority: "info", expiresAt: null, idempotencyKey: null,
  atribReceiptId: null, informedBy: [], metadata: null, deliveryPolicy: { mode: "mailbox" },
  createdAt: "2026-07-14T10:20:30.123456Z",
};
const encode = (
  contents: Omit<Parameters<typeof encodePortableArchive>[0], "exportRequestId">,
  exportRequestId = "018f4a70-0000-7000-8000-000000000030",
) => encodePortableArchive({ exportRequestId, ...contents });
function session(
  events: string[],
  failCompletion = false,
  exported: () => AsyncIterable<PortableArchiveMessage> = async function* () { yield message; },
  failAbandon = false,
): PortableArchiveExportSession {
  return {
    messages: exported, async *receipts() {},
    async complete() { events.push("complete"); if (failCompletion) throw new Error("audit unavailable"); },
    async reconcile() { events.push("reconcile"); },
    async abandon(code) { events.push(`abandon:${code}`); if (failAbandon) throw new Error("audit abandonment unavailable"); }, close() {},
  };
}
function root(): string { const value = privateTestDirectory("agent-bridge-publication-"); directories.push(value); return value; }
function writePrivateFile(path: string, data: string | NodeJS.ArrayBufferView): void {
  writeFileSync(path, data, { mode: 0o600 });
  secureTestFile(path);
}

describe("archive publication", () => {
  it("publishes no-replace atomically under a race", async () => {
    const target = join(root(), "archive.ndjson"); const left: string[] = []; const right: string[] = [];
    const settled = await Promise.allSettled([
      publishArchive(target, false, session(left), "acme", { requestId: "018f4a70-0000-7000-8000-000000000031" }),
      publishArchive(target, false, session(right), "acme", { requestId: "018f4a70-0000-7000-8000-000000000032" }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "OUTPUT_EXISTS" });
    expect([...left, ...right]).toContain("complete");
    expect([...left, ...right]).toContain("abandon:publication_failed");
    expect(decodePortableArchive(readFileSync(target)).messages).toHaveLength(1);
  });

  it("leaves a durable output visible and records audit failure ordering", async () => {
    const target = join(root(), "archive.ndjson"); const events: string[] = [];
    await expect(publishArchive(target, false, session(events, true), "acme", { requestId: "018f4a70-0000-7000-8000-000000000033" }))
      .rejects.toMatchObject({
        code: "ARCHIVE_AUDIT_ABANDONED",
        details: { requestId: "018f4a70-0000-7000-8000-000000000033", published: true, auditStatus: "abandoned" },
      });
    expect(existsSync(target)).toBe(true);
    expect(events).toEqual(["complete", "abandon:audit_failed"]);
    expect(decodePortableArchive(readFileSync(target)).messages).toHaveLength(1);
  });

  it("reports an unknown audit outcome when completion and abandonment both fail", async () => {
    const target = join(root(), "archive.ndjson"); const events: string[] = [];
    await expect(publishArchive(target, false, session(events, true, undefined, true), "acme", {
      requestId: "018f4a70-0000-7000-8000-000000000034",
    })).rejects.toMatchObject({
      code: "ARCHIVE_AUDIT_AMBIGUOUS",
      details: { requestId: "018f4a70-0000-7000-8000-000000000034", published: true, auditStatus: "unknown" },
    });
    expect(existsSync(target)).toBe(true);
    expect(events).toEqual(["complete", "abandon:audit_failed"]);
  });

  it("requires one explicit import disposition", async () => {
    await expect(runArchiveCommand(["import", "--provider", "local", "--file", "x", "--apply", "--dry-run"]))
      .rejects.toEqual(new ArchiveCommandError("INVALID_OPTION", "--apply and --dry-run are mutually exclusive"));
  });

  it.skipIf(process.platform === "win32")("reports an insecure archive directory without exposing policy details", async () => {
    const directory = root(); const target = join(directory, "archive.ndjson");
    const database = join(root(), "bridge.sqlite3");
    const store = new SQLiteBridgeStore(database); await store.initialize(); await store.close();
    chmodSync(directory, 0o755);
    await expect(runArchiveCommand([
      "export", "--provider", "local", "--workspace", "acme", "--db", database, "--output", target,
    ])).rejects.toEqual(new ArchiveCommandError(
      "INSECURE_PATH",
      "archive file or directory does not satisfy the private path policy",
    ));
  });

  it("abandons publication without an output when one row violates the domain limit", async () => {
    const directory = root(); const target = join(directory, "archive.ndjson"); const events: string[] = [];
    const oversized = { ...message, content: "x".repeat(64 * 1024 + 1) };
    await expect(publishArchive(target, false, session(events, false, async function* () { yield oversized; }), "acme", {
      requestId: "018f4a70-0000-7000-8000-000000000035",
    })).rejects.toThrow("content exceeds 65536 bytes");
    expect(events).toEqual(["abandon:publication_failed"]);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("abandons publication without an output when the stream exceeds the total limit", async () => {
    const directory = root(); const target = join(directory, "archive.ndjson"); const events: string[] = [];
    const content = "x".repeat(64 * 1024);
    const jsonValue = "x".repeat(64 * 1024 - Buffer.byteLength('{"value":""}'));
    const data = { value: jsonValue }; const metadata = { value: jsonValue };
    const fullRecord = canonicalJson({ kind: "message", message: { ...message, content, data, metadata } });
    const recordCount = Math.ceil(PORTABLE_ARCHIVE_MAX_BYTES / (Buffer.byteLength(fullRecord) + 1)) + 1;
    const exported = async function* () {
      for (let index = 1; index <= recordCount; index += 1) {
        yield { ...message, id: `018f4a70-0000-7000-8000-${index.toString(16).padStart(12, "0")}`, content, data, metadata };
      }
    };
    const discardFileWrites: typeof streamPortableArchive = (archiveSession, workspace, exportRequestId) =>
      streamPortableArchive(archiveSession, workspace, exportRequestId, () => undefined);
    await expect(publishArchive(target, false, session(events, false, exported), "acme", {
      requestId: "018f4a70-0000-7000-8000-000000000036", stream: discardFileWrites,
    }))
      .rejects.toThrow("archive export exceeds maximum size");
    expect(events).toEqual(["abandon:publication_failed"]);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  }, 15_000);

  it("restores the original force target when post-rename durability fails", async () => {
    const directory = root(); const target = join(directory, "archive.ndjson"); const events: string[] = [];
    const original = encode({ workspace: "acme", messages: [{ ...message, content: "original" }], receipts: [] });
    writePrivateFile(target, original);
    let syncs = 0;
    await expect(publishArchive(target, true, session(events), "acme", {
      requestId: "018f4a70-0000-7000-8000-000000000037",
      fileOperations: { syncDirectory() { syncs += 1; if (syncs === 2) throw new Error("post-rename fsync failed"); } },
    })).rejects.toThrow("post-rename fsync failed");
    expect(readFileSync(target)).toEqual(original);
    expect(events).toEqual(["abandon:publication_failed"]);
    expect(readdirSync(directory)).toEqual(["archive.ndjson"]);
  });

  it("preserves the backup and leaves the audit started when restoration fails", async () => {
    const directory = root(); const target = join(directory, "archive.ndjson"); const events: string[] = [];
    writePrivateFile(target, encode({ workspace: "acme", messages: [{ ...message, content: "original" }], receipts: [] }));
    let syncs = 0; let renames = 0;
    const result = publishArchive(target, true, session(events), "acme", {
      requestId: "018f4a70-0000-7000-8000-000000000038",
      fileOperations: {
        syncDirectory() { syncs += 1; if (syncs === 2) throw new Error("post-rename fsync failed"); },
        rename(source, destination) { renames += 1; if (renames === 2) throw new Error("restore failed"); renameSync(source, destination); },
      },
    });
    await expect(result).rejects.toMatchObject({
      code: "ARCHIVE_PUBLICATION_AMBIGUOUS",
      details: { requestId: "018f4a70-0000-7000-8000-000000000038", published: "unknown", auditStatus: "started" },
    });
    expect(events).toEqual([]);
    expect(readdirSync(directory).some((entry) => entry.endsWith(".backup"))).toBe(true);
  });

  it("reports a retained backup after the replacement is durable", async () => {
    const directory = root(); const target = join(directory, "archive.ndjson"); const events: string[] = [];
    writePrivateFile(target, encode({ workspace: "acme", messages: [{ ...message, content: "original" }], receipts: [] }));
    await expect(publishArchive(target, true, session(events), "acme", {
      requestId: "018f4a70-0000-7000-8000-000000000039",
      fileOperations: { unlink(path) { if (path.endsWith(".backup")) throw new Error("backup unlink failed"); unlinkSync(path); } },
    })).rejects.toMatchObject({
      code: "ARCHIVE_BACKUP_RETAINED",
      details: { requestId: "018f4a70-0000-7000-8000-000000000039", backupState: "retained", published: true, auditStatus: "started" },
    });
    expect(events).toEqual([]);
    expect(decodePortableArchive(readFileSync(target)).messages[0]!.content).toBe("hello");
    expect(readdirSync(directory).some((entry) => entry.endsWith(".backup"))).toBe(true);
  });

  it("reports unknown backup deletion durability without naming it as retained", async () => {
    const directory = root(); const target = join(directory, "archive.ndjson"); const events: string[] = [];
    writePrivateFile(target, encode({ workspace: "acme", messages: [{ ...message, content: "original" }], receipts: [] }));
    let syncs = 0;
    await expect(publishArchive(target, true, session(events), "acme", {
      requestId: "018f4a70-0000-7000-8000-000000000045",
      fileOperations: { syncDirectory() { syncs += 1; if (syncs === 3) throw new Error("backup deletion fsync failed"); } },
    })).rejects.toMatchObject({
      code: "ARCHIVE_BACKUP_CLEANUP_AMBIGUOUS",
      details: { backupState: "unknown", published: true, auditStatus: "started" },
    });
    expect(events).toEqual([]);
    expect(readdirSync(directory)).toEqual(["archive.ndjson"]);
  });

  it("reports an unknown audit when prepublication abandonment fails", async () => {
    const directory = root(); const target = join(directory, "archive.ndjson"); const events: string[] = [];
    const invalid = { ...message, content: "x".repeat(64 * 1024 + 1) };
    await expect(publishArchive(target, false, session(events, false, async function* () { yield invalid; }, true), "acme", {
      requestId: "018f4a70-0000-7000-8000-000000000046",
    })).rejects.toMatchObject({
      code: "ARCHIVE_AUDIT_AMBIGUOUS",
      details: { published: false, auditStatus: "unknown" },
    });
    expect(events).toEqual(["abandon:publication_failed"]);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("removes force backups on the clean path", async () => {
    const directory = root(); const target = join(directory, "archive.ndjson"); const events: string[] = [];
    writePrivateFile(target, encode({ workspace: "acme", messages: [{ ...message, content: "original" }], receipts: [] }));
    await publishArchive(target, true, session(events), "acme", { requestId: "018f4a70-0000-7000-8000-000000000040" });
    expect(events).toEqual(["complete"]);
    expect(readdirSync(directory)).toEqual(["archive.ndjson"]);
  });

  it("reconciles a replayed active request without streaming or replacing its file", async () => {
    const directory = root(); const target = join(directory, "archive.ndjson"); const events: string[] = [];
    const bytes = encode(
      { workspace: "acme", messages: [message], receipts: [] },
      "018f4a70-0000-7000-8000-000000000041",
    );
    writePrivateFile(target, bytes);
    const recoveryPrefix = join(directory, ".018f4a70-0000-7000-8000-000000000041.agent-bridge-archive");
    writePrivateFile(`${recoveryPrefix}.tmp`, "stale");
    writePrivateFile(`${recoveryPrefix}.backup`, "stale");
    const metadata = await reconcileActiveExport(
      target, "018f4a70-0000-7000-8000-000000000041", "acme", session(events),
    );
    expect(metadata.digest).toBe(decodePortableArchive(bytes).digest);
    expect(events).toEqual(["reconcile"]);
    expect(readFileSync(target)).toEqual(bytes);
    expect(readdirSync(directory)).toEqual(["archive.ndjson"]);
  });

  it("leaves replayed active requests started when the retained file is missing or mismatched", async () => {
    const directory = root(); const missing = join(directory, "missing.ndjson"); const missingEvents: string[] = [];
    const missingRecovery = join(directory, ".018f4a70-0000-7000-8000-000000000042.agent-bridge-archive.tmp");
    writePrivateFile(missingRecovery, "partial");
    await expect(reconcileActiveExport(
      missing, "018f4a70-0000-7000-8000-000000000042", "acme", session(missingEvents),
    )).rejects.toMatchObject({
      code: "ARCHIVE_RECONCILIATION_FILE_MISSING",
      details: { auditStatus: "started", recoveryPaths: [missingRecovery] },
    });
    expect(missingEvents).toEqual([]);
    expect(readFileSync(missingRecovery, "utf8")).toBe("partial");
    const mismatch = join(directory, "mismatch.ndjson"); const mismatchEvents: string[] = [];
    const bytes = encode(
      { workspace: "other", messages: [message], receipts: [] },
      "018f4a70-0000-7000-8000-000000000043",
    );
    writePrivateFile(mismatch, bytes);
    await expect(reconcileActiveExport(
      mismatch, "018f4a70-0000-7000-8000-000000000043", "acme", session(mismatchEvents),
    )).rejects.toMatchObject({ code: "ARCHIVE_RECONCILIATION_FILE_MISMATCH", details: { auditStatus: "started" } });
    expect(mismatchEvents).toEqual([]);
    expect(readFileSync(mismatch)).toEqual(bytes);
  });

  it("never reconciles an old valid target under a different export request", async () => {
    const directory = root(); const target = join(directory, "archive.ndjson"); const events: string[] = [];
    const bytes = encode(
      { workspace: "acme", messages: [message], receipts: [] },
      "018f4a70-0000-7000-8000-000000000047",
    );
    writePrivateFile(target, bytes);
    await expect(reconcileActiveExport(
      target, "018f4a70-0000-7000-8000-000000000048", "acme", session(events),
    )).rejects.toMatchObject({ code: "ARCHIVE_RECONCILIATION_FILE_MISMATCH", details: { auditStatus: "started" } });
    expect(events).toEqual([]);
    expect(readFileSync(target)).toEqual(bytes);
  });

  it("keeps a replayed active request started when a recovery artifact has the wrong type", async () => {
    const directory = root(); const target = join(directory, "archive.ndjson"); const events: string[] = [];
    const requestId = "018f4a70-0000-7000-8000-000000000049";
    writePrivateFile(target, encode({ workspace: "acme", messages: [message], receipts: [] }, requestId));
    const artifact = join(directory, `.${requestId}.agent-bridge-archive.backup`);
    mkdirSync(artifact, { mode: 0o700 });
    await expect(reconcileActiveExport(target, requestId, "acme", session(events)))
      .rejects.toMatchObject({ code: "ARCHIVE_RECOVERY_ARTIFACT_RETAINED", details: { auditStatus: "started" } });
    expect(events).toEqual([]);
    expect(existsSync(artifact)).toBe(true);
  });

  it("verifies completed replay metadata before returning success", () => {
    const target = join(root(), "archive.ndjson");
    const bytes = encode(
      { workspace: "acme", messages: [message], receipts: [] },
      "018f4a70-0000-7000-8000-000000000044",
    );
    writePrivateFile(target, bytes);
    const recoveryPrefix = join(dirname(target), ".018f4a70-0000-7000-8000-000000000044.agent-bridge-archive");
    writePrivateFile(`${recoveryPrefix}.tmp`, "stale");
    writePrivateFile(`${recoveryPrefix}.backup`, "stale");
    const archive = decodePortableArchive(bytes);
    expect(verifyCompletedExport(target, "018f4a70-0000-7000-8000-000000000044", {
      exportRequestId: archive.exportRequestId, workspace: "acme", digest: archive.digest, messageCount: 1, receiptCount: 0,
      publishedAt: "2026-07-14T12:00:00.000Z",
    })).toMatchObject({ digest: archive.digest, messageCount: 1 });
    expect(readdirSync(dirname(target))).toEqual(["archive.ndjson"]);
    expect(() => verifyCompletedExport(target, "018f4a70-0000-7000-8000-000000000044", {
      exportRequestId: archive.exportRequestId, workspace: "acme", digest: `sha256:${"0".repeat(64)}`, messageCount: 1, receiptCount: 0,
      publishedAt: "2026-07-14T12:00:00.000Z",
    })).toThrow(/does not match/);
    const wrongId = encode(
      { workspace: "acme", messages: [message], receipts: [] },
      "018f4a70-0000-7000-8000-00000000004a",
    );
    writePrivateFile(target, wrongId);
    const wrongArchive = decodePortableArchive(wrongId);
    expect(() => verifyCompletedExport(target, "018f4a70-0000-7000-8000-000000000044", {
      exportRequestId: "018f4a70-0000-7000-8000-000000000044",
      workspace: "acme", digest: wrongArchive.digest, messageCount: 1, receiptCount: 0,
      publishedAt: "2026-07-14T12:00:00.000Z",
    })).toThrow(/does not match/);
  });
});
