import { chmodSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson, encodePortableArchive, PORTABLE_ARCHIVE_BATCH_BYTES, PORTABLE_ARCHIVE_MAX_BYTES,
  PortableArchiveFile, type PortableArchiveMessage,
} from "../src/archive.js";
import { privateTestDirectory, secureTestFile } from "./private-test-path.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory(): string { const path = privateTestDirectory("agent-bridge-archive-file-"); directories.push(path); return path; }
function message(index = 1, content = "hello"): PortableArchiveMessage {
  return {
    id: `018f4a70-0000-7000-8000-${String(index).padStart(12, "0")}`, project: null, source: "codex", type: "context",
    content, contentType: "text/plain", data: null, targets: [], threadId: null, replyToId: null,
    correlationId: null, causationId: null, priority: "info", expiresAt: null, idempotencyKey: null,
    atribReceiptId: null, informedBy: [], metadata: null, deliveryPolicy: { mode: "mailbox" },
    createdAt: `2026-07-14T10:20:${String(index).padStart(2, "0")}.000000Z`,
  };
}
function archiveFile(bytes: Buffer): string {
  const path = join(directory(), "archive.ndjson"); writeFileSync(path, bytes, { mode: 0o600 }); chmodSync(path, 0o600); secureTestFile(path); return path;
}
const encode = (contents: Omit<Parameters<typeof encodePortableArchive>[0], "exportRequestId">) =>
  encodePortableArchive({ exportRequestId: "018f4a70-0000-7000-8000-0000000000f1", ...contents });

describe("PortableArchiveFile", () => {
  it("recomputes the verified digest on every bounded pass", async () => {
    const original = encode({ workspace: "acme", messages: [message()], receipts: [] });
    const path = archiveFile(original); const file = new PortableArchiveFile(path);
    expect(file.verify().messageCount).toBe(1);
    const changed = Buffer.from(original); const offset = changed.indexOf("hello"); changed.write("jello", offset); writeFileSync(path, changed, { mode: 0o600 });
    await expect(async () => { for await (const _batch of file.messageBatches()) {} }).rejects.toThrow(/changed|digest/);
    file.close();
  });

  it("refuses to prove durability after the verified pathname is replaced", () => {
    const bytes = encode({ workspace: "acme", messages: [message()], receipts: [] });
    const path = archiveFile(bytes); const file = new PortableArchiveFile(path);
    expect(file.verify().exportRequestId).toBe("018f4a70-0000-7000-8000-0000000000f1");
    renameSync(path, `${path}.moved`); writeFileSync(path, bytes, { mode: 0o600 }); secureTestFile(path);
    expect(() => file.proveDurable()).toThrow(/path changed|changed between passes/);
    file.close();
  });

  it("bounds batches by canonical bytes as well as count", async () => {
    const content = "x".repeat(64 * 1024);
    const value = "x".repeat(64 * 1024 - Buffer.byteLength('{"value":""}'));
    const messages = Array.from({ length: 30 }, (_, index) => ({
      ...message(index + 1, content), data: { value }, metadata: { value },
    }));
    const path = archiveFile(encode({ workspace: "acme", messages, receipts: [] }));
    const file = new PortableArchiveFile(path); file.verify(); let seen = 0;
    for await (const batch of file.messageBatches()) {
      const bytes = batch.reduce((total, item) => total + Buffer.byteLength(canonicalJson({ kind: "message", message: item })) + 1, 0);
      expect(bytes).toBeLessThanOrEqual(PORTABLE_ARCHIVE_BATCH_BYTES); seen += batch.length;
    }
    expect(seen).toBe(30); file.close();
  });

  it("rejects oversized sparse files, symlinks, and forged receipt eligibility", () => {
    const root = directory(); const huge = join(root, "huge.ndjson"); writeFileSync(huge, "x", { mode: 0o600 }); secureTestFile(huge); truncateSync(huge, PORTABLE_ARCHIVE_MAX_BYTES + 1);
    expect(() => new PortableArchiveFile(huge)).toThrow(/size/);
    const valid = join(root, "valid.ndjson"); writeFileSync(valid, encode({ workspace: "acme", messages: [message()], receipts: [] }), { mode: 0o600 }); secureTestFile(valid);
    const linked = join(root, "linked.ndjson"); symlinkSync(valid, linked); expect(() => new PortableArchiveFile(linked)).toThrow();
    const targeted = message(); targeted.targets = ["worker"]; targeted.deliveryPolicy = { mode: "leased", maxAttempts: 2, retryBaseDelayMs: 100, retryMaxDelayMs: 200, retryJitterRatio: 0 };
    const forged = encode({ workspace: "acme", messages: [targeted], receipts: [{ messageId: targeted.id, principal: "worker", readAt: "2026-07-14T11:00:00.000000Z" }] });
    const text = forged.toString("utf8").replace('"principal":"worker"', '"principal":"hacker"');
    const forgedPath = join(root, "forged.ndjson"); writeFileSync(forgedPath, text, { mode: 0o600 }); secureTestFile(forgedPath);
    const file = new PortableArchiveFile(forgedPath); expect(() => file.verify()).toThrow(/not eligible/); file.close();
  });
});
