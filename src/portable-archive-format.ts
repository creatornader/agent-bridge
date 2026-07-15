import { createHash } from "node:crypto";
import { validateMessageDraft, validatePrincipal, type JsonValue } from "./bridge-domain.js";
import type {
  PortableArchiveContents,
  PortableArchiveMessage,
  PortableArchiveReceipt,
} from "./portable-archive-store.js";

export const PORTABLE_ARCHIVE_FORMAT = "agent-bridge.portable-archive";
export const PORTABLE_ARCHIVE_VERSION = 1;
export const PORTABLE_ARCHIVE_MAX_LINE_BYTES = 1024 * 1024;
export const PORTABLE_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
export const PORTABLE_ARCHIVE_BATCH_BYTES = 4 * 1024 * 1024;
export const PORTABLE_ARCHIVE_BATCH_ROWS = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export class PortableArchiveError extends Error {
  readonly code = "invalid_portable_archive";
  constructor(message: string) { super(message); }
}

function assertUnicode(value: string): void {
  if (value.includes("\0")) throw new PortableArchiveError("archive strings must not contain U+0000");
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new PortableArchiveError("archive contains a lone surrogate");
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new PortableArchiveError("archive contains a lone surrogate");
    }
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string") assertUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PortableArchiveError("archive contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === undefined) throw new PortableArchiveError("archive contains a non-JSON value");
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => {
    assertUnicode(key);
    return `${JSON.stringify(key)}:${canonicalJson(object[key])}`;
  }).join(",")}}`;
}

export function normalizeArchiveTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new PortableArchiveError(`${field} must be a timestamp`);
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) throw new PortableArchiveError(`${field} must be RFC 3339 with an explicit offset`);
  if (match[1]!.startsWith("0000-")) throw new PortableArchiveError(`${field} year must be between 0001 and 9999`);
  const milliseconds = (match[2] ?? "").padEnd(3, "0").slice(0, 3);
  const parsed = new Date(`${match[1]}.${milliseconds}${match[3]}`);
  if (Number.isNaN(parsed.getTime())) throw new PortableArchiveError(`${field} is invalid`);
  const converted = parsed.toISOString();
  if (!/^\d{4}-/.test(converted) || converted.startsWith("0000-")) throw new PortableArchiveError(`${field} conversion must remain between years 0001 and 9999`);
  const canonicalPrefix = converted.slice(0, 19);
  const micros = (match[2] ?? "").padEnd(6, "0");
  return `${canonicalPrefix}.${micros}Z`;
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PortableArchiveError(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PortableArchiveError(`${label} has unexpected fields`);
  }
  return object;
}

const MESSAGE_KEYS = [
  "atribReceiptId", "causationId", "content", "contentType", "correlationId", "createdAt",
  "data", "deliveryPolicy", "expiresAt", "id", "idempotencyKey", "informedBy", "metadata",
  "priority", "project", "replyToId", "source", "targets", "threadId", "type",
] as const;

export function validateArchiveWorkspace(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > 128) {
    throw new PortableArchiveError("workspace must be trimmed and between 1 and 128 characters");
  }
  assertUnicode(value);
  return value;
}

export function validatePortableArchiveRequestId(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !REQUEST_UUID.test(value)) {
    throw new PortableArchiveError("archive exportRequestId must be a UUID");
  }
  return value.toLowerCase();
}

function string(value: unknown, field: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new PortableArchiveError(`${field} must be a string${nullable ? " or null" : ""}`);
  assertUnicode(value);
  return value;
}

function json(value: unknown, field: string): JsonValue | null {
  if (value === null) return null;
  try { canonicalJson(value); } catch { throw new PortableArchiveError(`${field} must be JSON`); }
  return value as JsonValue;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new PortableArchiveError(`${field} must be a string array`);
  value.forEach((entry) => assertUnicode(entry));
  return value as string[];
}

export function parsePortableArchiveMessage(value: unknown): PortableArchiveMessage {
  const object = exactObject(value, MESSAGE_KEYS, "message");
  const id = string(object.id, "message.id")!;
  if (!UUID.test(id)) throw new PortableArchiveError("message.id must be a UUID");
  const priority = string(object.priority, "message.priority")!;
  if (!(["info", "high", "urgent"] as string[]).includes(priority)) throw new PortableArchiveError("message.priority is invalid");
  const deliveryPolicy = object.deliveryPolicy;
  if (!deliveryPolicy || typeof deliveryPolicy !== "object" || Array.isArray(deliveryPolicy)) throw new PortableArchiveError("message.deliveryPolicy must be an object");
  const policy = deliveryPolicy as Record<string, unknown>;
  if (policy.mode === "mailbox") {
    exactObject(policy, ["mode"], "message.deliveryPolicy");
  } else if (policy.mode === "leased") {
    const keys = Object.keys(policy);
    exactObject(policy, policy.notBefore === undefined
      ? ["maxAttempts", "mode", "retryBaseDelayMs", "retryJitterRatio", "retryMaxDelayMs"]
      : ["maxAttempts", "mode", "notBefore", "retryBaseDelayMs", "retryJitterRatio", "retryMaxDelayMs"], "message.deliveryPolicy");
    if (!Number.isSafeInteger(policy.maxAttempts) || Number(policy.maxAttempts) < 1 || Number(policy.maxAttempts) > 100
      || !Number.isSafeInteger(policy.retryBaseDelayMs) || Number(policy.retryBaseDelayMs) < 1 || Number(policy.retryBaseDelayMs) > 3_600_000
      || !Number.isSafeInteger(policy.retryMaxDelayMs) || Number(policy.retryMaxDelayMs) < Number(policy.retryBaseDelayMs) || Number(policy.retryMaxDelayMs) > 86_400_000
      || typeof policy.retryJitterRatio !== "number" || !Number.isFinite(policy.retryJitterRatio)
      || Number(policy.retryJitterRatio) < 0 || Number(policy.retryJitterRatio) > 1 || keys.length < 5) {
      throw new PortableArchiveError("message.deliveryPolicy is invalid");
    }
  } else throw new PortableArchiveError("message.deliveryPolicy.mode is invalid");
  const createdAt = string(object.createdAt, "message.createdAt")!;
  if (!CANONICAL_TIMESTAMP.test(createdAt) || normalizeArchiveTimestamp(createdAt, "message.createdAt") !== createdAt) throw new PortableArchiveError("message.createdAt is not canonical");
  const expiresAt = string(object.expiresAt, "message.expiresAt", true);
  if (expiresAt !== null && (!CANONICAL_TIMESTAMP.test(expiresAt) || normalizeArchiveTimestamp(expiresAt, "message.expiresAt") !== expiresAt)) throw new PortableArchiveError("message.expiresAt is not canonical");
  const notBefore = policy.notBefore;
  if (notBefore !== undefined && (typeof notBefore !== "string" || !CANONICAL_TIMESTAMP.test(notBefore) || normalizeArchiveTimestamp(notBefore, "message.deliveryPolicy.notBefore") !== notBefore)) throw new PortableArchiveError("message.deliveryPolicy.notBefore is not canonical");
  const targets = stringArray(object.targets, "message.targets");
  if (policy.mode === "leased" && targets.length === 0) throw new PortableArchiveError("leased delivery requires at least one target");
  if (typeof notBefore === "string" && expiresAt !== null && notBefore >= expiresAt) throw new PortableArchiveError("delivery notBefore must be before expiresAt");
  const project = string(object.project, "message.project", true);
  const source = string(object.source, "message.source")!;
  const type = string(object.type, "message.type")!;
  const content = string(object.content, "message.content")!;
  const contentType = string(object.contentType, "message.contentType")!;
  const data = json(object.data, "message.data");
  const threadId = string(object.threadId, "message.threadId", true);
  const replyToId = string(object.replyToId, "message.replyToId", true);
  const correlationId = string(object.correlationId, "message.correlationId", true);
  const causationId = string(object.causationId, "message.causationId", true);
  const idempotencyKey = string(object.idempotencyKey, "message.idempotencyKey", true);
  const atribReceiptId = string(object.atribReceiptId, "message.atribReceiptId", true);
  const informedBy = stringArray(object.informedBy, "message.informedBy");
  const metadata = json(object.metadata, "message.metadata");
  const parsedPolicy = deliveryPolicy as PortableArchiveMessage["deliveryPolicy"];
  let normalized: ReturnType<typeof validateMessageDraft>;
  try {
    const principal = validatePrincipal({ workspace: "archive", agent: source });
    if (principal.agent !== source) throw new Error("message.source is not canonical");
    normalized = validateMessageDraft({
      id, project: project ?? undefined, type, content, contentType, data, targets,
      threadId: threadId ?? undefined, replyToId: replyToId ?? undefined,
      correlationId: correlationId ?? undefined, causationId: causationId ?? undefined,
      priority: priority as PortableArchiveMessage["priority"], expiresAt: expiresAt ?? undefined,
      idempotencyKey: idempotencyKey ?? undefined, atribReceiptId: atribReceiptId ?? undefined,
      informedBy, metadata, deliveryPolicy: parsedPolicy,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid message";
    throw new PortableArchiveError(`message violates Agent Bridge domain constraints: ${reason}`);
  }
  const normalizedPolicy = normalized.deliveryPolicy.mode === "leased" && parsedPolicy.mode === "leased" && parsedPolicy.notBefore
    ? { ...normalized.deliveryPolicy, notBefore: parsedPolicy.notBefore }
    : normalized.deliveryPolicy;
  const actual = {
    project, type, content, contentType, data, targets, threadId, replyToId, correlationId,
    causationId, priority, idempotencyKey, atribReceiptId, informedBy, metadata,
    deliveryPolicy: parsedPolicy,
  };
  const expected = {
    project: normalized.project ?? null, type: normalized.type, content: normalized.content,
    contentType: normalized.contentType, data: normalized.data ?? null, targets: normalized.targets,
    threadId: normalized.threadId ?? null, replyToId: normalized.replyToId ?? null,
    correlationId: normalized.correlationId ?? null, causationId: normalized.causationId ?? null,
    priority: normalized.priority, idempotencyKey: normalized.idempotencyKey ?? null,
    atribReceiptId: normalized.atribReceiptId ?? null, informedBy: normalized.informedBy ?? [],
    metadata: normalized.metadata ?? null, deliveryPolicy: normalizedPolicy,
  };
  if (normalized.id !== id || canonicalJson(actual) !== canonicalJson(expected)) {
    throw new PortableArchiveError("message is not in canonical Agent Bridge domain form");
  }
  return {
    id, project, source, type, content, contentType, data, targets, threadId, replyToId,
    correlationId, causationId, priority: priority as PortableArchiveMessage["priority"], expiresAt,
    idempotencyKey, atribReceiptId, informedBy, metadata, deliveryPolicy: parsedPolicy, createdAt,
  };
}

export function parsePortableArchiveReceipt(value: unknown): PortableArchiveReceipt {
  const object = exactObject(value, ["messageId", "principal", "readAt"], "receipt");
  const messageId = string(object.messageId, "receipt.messageId")!;
  if (!UUID.test(messageId)) throw new PortableArchiveError("receipt.messageId must be a UUID");
  const readAt = string(object.readAt, "receipt.readAt")!;
  if (!CANONICAL_TIMESTAMP.test(readAt) || normalizeArchiveTimestamp(readAt, "receipt.readAt") !== readAt) throw new PortableArchiveError("receipt.readAt is not canonical");
  const principal = string(object.principal, "receipt.principal")!;
  if (principal !== principal.trim() || principal.length < 1 || principal.length > 128) throw new PortableArchiveError("receipt.principal is invalid");
  return { messageId, principal, readAt };
}

export function encodePortableArchive(contents: PortableArchiveContents): Buffer {
  const requestId = validatePortableArchiveRequestId(contents.exportRequestId);
  const workspace = validateArchiveWorkspace(contents.workspace);
  const messages = contents.messages.map(parsePortableArchiveMessage).sort((left, right) => left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (new Set(messages.map((message) => message.id)).size !== messages.length) throw new PortableArchiveError("duplicate message id");
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const byMessage = new Map<string, PortableArchiveReceipt[]>();
  for (const receipt of contents.receipts.map(parsePortableArchiveReceipt)) {
    const receiptMessage = messagesById.get(receipt.messageId);
    if (!receiptMessage) throw new PortableArchiveError("receipt references a missing message");
    if (receiptMessage.targets.length > 0 && !receiptMessage.targets.includes(receipt.principal)) throw new PortableArchiveError("receipt principal is not eligible for the message");
    const list = byMessage.get(receipt.messageId) ?? [];
    if (list.some((entry) => entry.principal === receipt.principal)) throw new PortableArchiveError("duplicate receipt");
    list.push(receipt); byMessage.set(receipt.messageId, list);
  }
  const lines = [canonicalJson({ exportRequestId: requestId, format: PORTABLE_ARCHIVE_FORMAT, kind: "header", version: PORTABLE_ARCHIVE_VERSION, workspace })];
  for (const message of messages) {
    lines.push(canonicalJson({ kind: "message", message }));
    for (const receipt of (byMessage.get(message.id) ?? []).sort((left, right) => left.principal < right.principal ? -1 : left.principal > right.principal ? 1 : 0)) lines.push(canonicalJson({ kind: "receipt", receipt }));
  }
  if (lines.some((line) => Buffer.byteLength(line) > PORTABLE_ARCHIVE_MAX_LINE_BYTES)) throw new PortableArchiveError("archive line exceeds 1 MiB");
  const body = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const footer = canonicalJson({ digest, kind: "footer", messages: messages.length, receipts: contents.receipts.length });
  const result = Buffer.concat([body, Buffer.from(`${footer}\n`, "utf8")]);
  if (result.length > PORTABLE_ARCHIVE_MAX_BYTES) throw new PortableArchiveError("archive exceeds maximum size");
  return result;
}

export function decodePortableArchive(input: Uint8Array): PortableArchiveContents & { digest: string } {
  const bytes = Buffer.from(input);
  if (!bytes.length || bytes.length > PORTABLE_ARCHIVE_MAX_BYTES) throw new PortableArchiveError("archive size is invalid");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new PortableArchiveError("archive must not contain a BOM");
  if (bytes[bytes.length - 1] !== 0x0a || bytes.includes(0x0d) || bytes.includes(0x00)) throw new PortableArchiveError("archive must use UTF-8 and LF framing");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new PortableArchiveError("archive is not valid UTF-8"); }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 2 || lines.some((line) => !line || Buffer.byteLength(line) > PORTABLE_ARCHIVE_MAX_LINE_BYTES)) throw new PortableArchiveError("archive contains an invalid line");
  const records = lines.map((line) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new PortableArchiveError("archive contains invalid JSON"); }
    if (canonicalJson(value) !== line) throw new PortableArchiveError("archive contains noncanonical JSON");
    return value;
  });
  const header = exactObject(records[0], ["exportRequestId", "format", "kind", "version", "workspace"], "header");
  if (header.kind !== "header" || header.format !== PORTABLE_ARCHIVE_FORMAT || header.version !== PORTABLE_ARCHIVE_VERSION) throw new PortableArchiveError("unsupported archive header");
  const requestId = validatePortableArchiveRequestId(header.exportRequestId);
  if (requestId !== header.exportRequestId) throw new PortableArchiveError("archive header exportRequestId is not canonical");
  const workspace = validateArchiveWorkspace(header.workspace);
  const footer = exactObject(records[records.length - 1], ["digest", "kind", "messages", "receipts"], "footer");
  if (footer.kind !== "footer" || typeof footer.digest !== "string" || !Number.isSafeInteger(footer.messages) || Number(footer.messages) < 0 || !Number.isSafeInteger(footer.receipts) || Number(footer.receipts) < 0) throw new PortableArchiveError("invalid archive footer");
  const footerOffset = Buffer.byteLength(`${lines.slice(0, -1).join("\n")}\n`);
  const digest = `sha256:${createHash("sha256").update(bytes.subarray(0, footerOffset)).digest("hex")}`;
  if (footer.digest !== digest) throw new PortableArchiveError("archive digest mismatch");
  const messages: PortableArchiveMessage[] = [];
  const receipts: PortableArchiveReceipt[] = [];
  const ids = new Set<string>();
  const receiptKeys = new Set<string>();
  let currentMessage: PortableArchiveMessage | undefined;
  let previousMessageKey = "";
  let previousPrincipal = "";
  for (const raw of records.slice(1, -1)) {
    const record = raw as Record<string, unknown>;
    if (record.kind === "message") {
      exactObject(record, ["kind", "message"], "message record");
      const message = parsePortableArchiveMessage(record.message);
      const orderKey = `${message.createdAt}\0${message.id}`;
      if (orderKey <= previousMessageKey || ids.has(message.id)) throw new PortableArchiveError("messages are duplicated or out of order");
      previousMessageKey = orderKey; currentMessage = message; previousPrincipal = ""; ids.add(message.id); messages.push(message);
    } else if (record.kind === "receipt") {
      exactObject(record, ["kind", "receipt"], "receipt record");
      const receipt = parsePortableArchiveReceipt(record.receipt);
      if (!currentMessage || receipt.messageId !== currentMessage.id || receipt.principal <= previousPrincipal) throw new PortableArchiveError("receipts are out of order or not adjacent to their message");
      if (currentMessage.targets.length > 0 && !currentMessage.targets.includes(receipt.principal)) throw new PortableArchiveError("receipt principal is not eligible for the message");
      const key = `${receipt.messageId}\0${receipt.principal}`;
      if (receiptKeys.has(key)) throw new PortableArchiveError("duplicate receipt");
      previousPrincipal = receipt.principal; receiptKeys.add(key); receipts.push(receipt);
    } else throw new PortableArchiveError("unknown archive record kind");
  }
  if (messages.length !== footer.messages || receipts.length !== footer.receipts) throw new PortableArchiveError("archive counts do not match footer");
  return { exportRequestId: requestId, workspace, messages, receipts, digest };
}
