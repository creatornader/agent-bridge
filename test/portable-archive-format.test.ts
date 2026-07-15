import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  decodePortableArchive,
  encodePortableArchive,
  normalizeArchiveTimestamp,
  streamPortableArchive,
  type PortableArchiveMessage,
} from "../src/archive.js";

const message = (overrides: Partial<PortableArchiveMessage> = {}): PortableArchiveMessage => ({
  id: "018f4a70-0000-7000-8000-000000000001", project: null, source: "codex", type: "context",
  content: "hello", contentType: "text/plain", data: null, targets: [], threadId: null,
  replyToId: null, correlationId: null, causationId: null, priority: "info", expiresAt: null,
  idempotencyKey: null, atribReceiptId: null, informedBy: [], metadata: null,
  deliveryPolicy: { mode: "mailbox" }, createdAt: "2026-07-14T10:20:30.123456Z", ...overrides,
});
const exportRequestId = "018f4a70-0000-7000-8000-0000000000f0";
const encode = (contents: Omit<Parameters<typeof encodePortableArchive>[0], "exportRequestId">) =>
  encodePortableArchive({ exportRequestId, ...contents });

describe("portable archive v1 format", () => {
  it("keeps the canonical golden file byte-stable", () => {
    const golden = readFileSync(new URL("./fixtures/portable-archive-v1.ndjson", import.meta.url));
    const archive = decodePortableArchive(golden);
    expect(encodePortableArchive(archive)).toEqual(golden);
  });

  it("orders by portable timestamps and places receipts next to each message", () => {
    const bytes = encode({
      workspace: "acme",
      messages: [message({ id: "018f4a70-0000-7000-8000-000000000002", createdAt: "2026-07-14T10:20:31.000000Z" }), message()],
      receipts: [
        { messageId: "018f4a70-0000-7000-8000-000000000001", principal: "zeta", readAt: "2026-07-14T11:00:00.000000Z" },
        { messageId: "018f4a70-0000-7000-8000-000000000001", principal: "alpha", readAt: "2026-07-14T10:59:00.000000Z" },
      ],
    });
    const lines = bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((record) => record.kind)).toEqual(["header", "message", "receipt", "receipt", "message", "footer"]);
    expect(lines[1].message).not.toHaveProperty("workspace");
    expect(lines[1].message).not.toHaveProperty("sequence");
    expect(lines[2].receipt.principal).toBe("alpha");
    expect(decodePortableArchive(bytes).digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("covers every byte before the footer in its digest", () => {
    const bytes = encode({ workspace: "acme", messages: [message()], receipts: [] });
    const text = bytes.toString("utf8");
    const footerStart = text.lastIndexOf("{\"digest\"");
    const footer = JSON.parse(text.slice(footerStart));
    expect(footer.digest).toBe(`sha256:${createHash("sha256").update(bytes.subarray(0, footerStart)).digest("hex")}`);
  });

  it.each([
    ["BOM", (bytes: Buffer) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])],
    ["CRLF", (bytes: Buffer) => Buffer.from(bytes.toString("utf8").replaceAll("\n", "\r\n"))],
    ["truncation", (bytes: Buffer) => bytes.subarray(0, -1)],
    ["trailing bytes", (bytes: Buffer) => Buffer.concat([bytes, Buffer.from("x")])],
    ["noncanonical JSON", (bytes: Buffer) => Buffer.from(bytes.toString("utf8").replace("{\"exportRequestId\"", "{ \"exportRequestId\""))],
  ])("rejects %s", (_label, mutate) => {
    const bytes = encode({ workspace: "acme", messages: [message()], receipts: [] });
    expect(() => decodePortableArchive(mutate(bytes))).toThrow();
  });

  it("rejects duplicate keys, duplicate records, invalid Unicode, and oversized lines", () => {
    const bytes = encode({ workspace: "acme", messages: [message()], receipts: [] });
    const duplicateKey = Buffer.from(bytes.toString("utf8").replace('{"exportRequestId":', '{"exportRequestId":"wrong","exportRequestId":'));
    expect(() => decodePortableArchive(duplicateKey)).toThrow(/noncanonical/);
    expect(() => encode({ workspace: "acme", messages: [message(), message()], receipts: [] })).toThrow(/duplicate message/);
    expect(() => encode({ workspace: "acme", messages: [message({ content: "\ud800" })], receipts: [] })).toThrow(/surrogate/);
    expect(() => encode({ workspace: "acme", messages: [message({ content: "x".repeat(1024 * 1024) })], receipts: [] })).toThrow(/65536 bytes/);
  });

  it("normalizes timestamps to six-digit UTC without losing microseconds", () => {
    expect(normalizeArchiveTimestamp("2026-07-14T05:20:30.123456-05:00", "value")).toBe("2026-07-14T10:20:30.123456Z");
    expect(normalizeArchiveTimestamp("2026-07-14T10:20:30.123Z", "value")).toBe("2026-07-14T10:20:30.123000Z");
  });

  it("rejects delivery policy extensions and invalid leased tuning", () => {
    expect(() => encode({
      workspace: "acme", messages: [message({ deliveryPolicy: { mode: "mailbox", extra: true } as any })], receipts: [],
    })).toThrow(/unexpected fields/);
    expect(() => encode({
      workspace: "acme", messages: [message({ deliveryPolicy: {
        mode: "leased", maxAttempts: 0, retryBaseDelayMs: 100, retryMaxDelayMs: 1000, retryJitterRatio: 0,
      } })], receipts: [],
    })).toThrow(/invalid/);
  });

  it("rejects cross-engine string, workspace, timestamp, and policy edge cases", () => {
    for (const workspace of ["", " acme", "a".repeat(129)]) {
      expect(() => encode({ workspace, messages: [message()], receipts: [] })).toThrow(/workspace/);
    }
    expect(() => encode({ workspace: "acme", messages: [message({ content: "nul\0byte" })], receipts: [] })).toThrow(/U\+0000/);
    for (const createdAt of ["0000-01-01T00:00:00.000000Z", "0001-01-01T00:00:00.000000+14:00", "9999-12-31T23:59:59.999999-14:00"]) {
      expect(() => encode({ workspace: "acme", messages: [message({ createdAt })], receipts: [] })).toThrow(/year|years|canonical/);
    }
    expect(() => encode({ workspace: "acme", messages: [message({
      targets: [], deliveryPolicy: { mode: "leased", maxAttempts: 2, retryBaseDelayMs: 100, retryMaxDelayMs: 200, retryJitterRatio: 0 },
    })], receipts: [] })).toThrow(/target/);
    expect(() => encode({ workspace: "acme", messages: [message({
      targets: ["worker"], expiresAt: "2026-07-14T10:20:30.500000Z",
      deliveryPolicy: { mode: "leased", maxAttempts: 2, retryBaseDelayMs: 100, retryMaxDelayMs: 200, retryJitterRatio: 0, notBefore: "2026-07-14T10:20:30.500000Z" },
    })], receipts: [] })).toThrow(/before expiresAt/);
  });

  it("rejects receipts from principals that could not read the message", () => {
    expect(() => encode({
      workspace: "acme", messages: [message({ targets: ["worker"], deliveryPolicy: { mode: "leased", maxAttempts: 2, retryBaseDelayMs: 100, retryMaxDelayMs: 200, retryJitterRatio: 0 } })],
      receipts: [{ messageId: message().id, principal: "intruder", readAt: "2026-07-14T11:00:00.000000Z" }],
    })).toThrow(/not eligible/);
  });

  it("rejects messages outside the canonical Agent Bridge domain", () => {
    let deep: any = "leaf";
    for (let depth = 0; depth < 18; depth += 1) deep = { nested: deep };
    const recordHash = `sha256:${"a".repeat(64)}`;
    const invalid: Partial<PortableArchiveMessage>[] = [
      { project: " ".repeat(129) }, { source: "" }, { source: " codex" }, { type: "" },
      { content: " " }, { content: "x".repeat(64 * 1024 + 1) }, { contentType: "" },
      { targets: [""] }, { targets: ["worker", "worker"] },
      { targets: Array.from({ length: 65 }, (_, index) => `worker-${index}`) },
      { informedBy: ["not-a-record-hash"] }, { informedBy: [recordHash, recordHash] },
      { threadId: "x".repeat(129) }, { idempotencyKey: "x".repeat(257) },
      { atribReceiptId: "invalid" }, { data: deep }, { metadata: { large: "x".repeat(64 * 1024) } },
    ];
    for (const overrides of invalid) {
      expect(() => encode({ workspace: "acme", messages: [message(overrides)], receipts: [] }))
        .toThrow(/domain constraints|domain form/);
    }
  });

  it("rejects uppercase UUID spelling instead of rewriting archive bytes", () => {
    const bytes = encode({ workspace: "acme", messages: [message()], receipts: [] });
    const lines = bytes.toString("utf8").trimEnd().split("\n");
    lines[1] = lines[1]!.replace(message().id, message().id.toUpperCase());
    const body = Buffer.from(`${lines.slice(0, -1).join("\n")}\n`);
    const footer = JSON.parse(lines[lines.length - 1]!);
    footer.digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const uppercase = Buffer.concat([body, Buffer.from(`${canonicalJson(footer)}\n`)]);
    expect(() => decodePortableArchive(uppercase)).toThrow(/UUID/);
    expect(() => encode({ workspace: "acme", messages: [message({ id: message().id.toUpperCase() })], receipts: [] })).toThrow(/UUID/);
  });

  it("requires a lowercase UUID exportRequestId in the signed header", () => {
    const rewrite = (value: string) => {
      const lines = encode({ workspace: "acme", messages: [message()], receipts: [] }).toString("utf8").trimEnd().split("\n");
      const header = JSON.parse(lines[0]!); header.exportRequestId = value; lines[0] = canonicalJson(header);
      const body = Buffer.from(`${lines.slice(0, -1).join("\n")}\n`);
      const footer = JSON.parse(lines[lines.length - 1]!);
      footer.digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
      return Buffer.concat([body, Buffer.from(`${canonicalJson(footer)}\n`)]);
    };
    expect(() => decodePortableArchive(rewrite(exportRequestId.toUpperCase()))).toThrow(/exportRequestId.*canonical/);
    expect(() => decodePortableArchive(rewrite("not-a-uuid"))).toThrow(/exportRequestId.*UUID/);
  });

  it("applies domain validation to streaming exports", async () => {
    const session = {
      async *messages() { yield message({ source: " codex" }); },
      async *receipts() {}, async complete() {}, async reconcile() {}, async abandon() {}, close() {},
    };
    const chunks: Buffer[] = [];
    await expect(streamPortableArchive(session, "acme", exportRequestId, (bytes) => { chunks.push(bytes); }))
      .rejects.toThrow(/domain constraints/);
    expect(canonicalJson(JSON.parse(chunks[0]!.toString("utf8")))).toContain('"kind":"header"');
  });
});
