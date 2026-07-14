import { randomBytes } from "node:crypto";
import { normalizeReceiptId } from "./atrib-receipt.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type DeliveryState = "pending" | "claimed" | "acked" | "retrying" | "dead";
export type MessagePriority = "info" | "high" | "urgent";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface BridgePrincipal {
  workspace: string;
  agent: string;
  instance?: string;
}

export interface MessageDraft {
  id?: string;
  type: string;
  content: string;
  contentType?: string;
  data?: JsonValue;
  targets?: string[];
  threadId?: string;
  replyToId?: string;
  correlationId?: string;
  causationId?: string;
  priority?: MessagePriority;
  expiresAt?: string;
  idempotencyKey?: string;
  atribReceiptId?: string;
  informedBy?: string[];
  metadata?: JsonValue;
}

export interface BridgeMessage
  extends Required<
    Pick<MessageDraft, "id" | "type" | "content" | "contentType" | "targets" | "priority">
  > {
  workspace: string;
  source: string;
  sequence: string;
  createdAt: string;
  data?: JsonValue;
  threadId?: string;
  replyToId?: string;
  correlationId?: string;
  causationId?: string;
  expiresAt?: string;
  idempotencyKey?: string;
  atribReceiptId?: string;
  informedBy?: string[];
  metadata?: JsonValue;
}

export interface BridgeDelivery {
  id: string;
  messageId: string;
  workspace: string;
  recipient: string;
  state: DeliveryState;
  attempt: number;
  availableAt: string;
  leaseToken?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastError?: string;
}

export interface BridgeDeliveryEvent {
  sequence: string;
  deliveryId: string;
  messageId: string;
  workspace: string;
  recipient: string;
  fromState?: DeliveryState;
  toState: DeliveryState;
  attempt: number;
  leaseOwner?: string;
  error?: string;
  createdAt: string;
}

export interface AgentPresence {
  workspace: string;
  agent: string;
  instance: string;
  runtimeType?: string;
  capabilities: string[];
  leaseExpiresAt: string;
  lastSeenAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEQUENCE_RE = /^(0|[1-9][0-9]*)$/;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const TEXT_LIMIT = 64 * 1024;
const JSON_DEPTH_LIMIT = 16;
const RECORD_HASH_RE = /^sha256:[a-f0-9]{64}$/i;

export class BridgeValidationError extends Error {
  readonly code = "invalid_input";
}

function clean(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BridgeValidationError(`${field} is required`);
  }

  const result = value.trim();
  if (result.length > max) {
    throw new BridgeValidationError(`${field} exceeds ${max} characters`);
  }
  return result;
}

function content(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BridgeValidationError("content is required");
  }
  if (Buffer.byteLength(value) > TEXT_LIMIT) {
    throw new BridgeValidationError(`content exceeds ${TEXT_LIMIT} bytes`);
  }
  return value;
}

function optional(value: unknown, field: string, max = 512): string | undefined {
  if (value === undefined || value === null) return undefined;
  return clean(value, field, max);
}

function timestamp(value: unknown, field: string): string | undefined {
  const raw = optional(value, field);
  if (!raw) return undefined;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new BridgeValidationError(`${field} must be an ISO timestamp`);
  }
  return date.toISOString();
}

function assertJsonDepth(value: JsonValue, depth = 0): void {
  if (depth > JSON_DEPTH_LIMIT) {
    throw new BridgeValidationError(`JSON exceeds ${JSON_DEPTH_LIMIT} levels`);
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonDepth(entry, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) assertJsonDepth(entry, depth + 1);
  }
}

function json(value: unknown, field: string): JsonValue | undefined {
  if (value === undefined) return undefined;

  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized) > TEXT_LIMIT) throw new Error();
    const parsed = JSON.parse(serialized) as JsonValue;
    assertJsonDepth(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof BridgeValidationError) throw error;
    throw new BridgeValidationError(`${field} must be JSON and at most ${TEXT_LIMIT} bytes`);
  }
}

function stringArray(value: unknown, field: string, limit: number, itemLimit: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new BridgeValidationError(`${field} must be an array`);
  }

  const result = [...new Set(value.map((entry) => clean(entry, field, itemLimit)))];
  if (result.length > limit) {
    throw new BridgeValidationError(`${field} exceeds ${limit} entries`);
  }
  return result;
}

export function uuidv7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new BridgeValidationError("UUIDv7 timestamp is out of range");
  }

  const bytes = randomBytes(16);
  let timestampValue = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestampValue & 0xffn);
    timestampValue >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function validatePrincipal(value: BridgePrincipal): BridgePrincipal {
  return {
    workspace: clean(value?.workspace, "workspace", 128),
    agent: clean(value?.agent, "agent", 128),
    instance: optional(value?.instance, "instance", 128),
  };
}

export function validateUuid(value: unknown, field: string): string {
  const result = clean(value, field, 64);
  if (!UUID_RE.test(result)) {
    throw new BridgeValidationError(`${field} must be a UUID`);
  }
  return result;
}

export function validateRetryPolicy(input: Partial<RetryPolicy> | null = {}): RetryPolicy {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BridgeValidationError("retryPolicy must be an object");
  }
  const result: RetryPolicy = {
    maxAttempts: input.maxAttempts ?? 5,
    baseDelayMs: input.baseDelayMs ?? 1_000,
    maxDelayMs: input.maxDelayMs ?? 60_000,
    jitterRatio: input.jitterRatio ?? 0.2,
  };

  if (!Number.isSafeInteger(result.maxAttempts) || result.maxAttempts < 1 || result.maxAttempts > 100) {
    throw new BridgeValidationError("maxAttempts must be between 1 and 100");
  }
  if (!Number.isSafeInteger(result.baseDelayMs) || result.baseDelayMs < 1 || result.baseDelayMs > 3_600_000) {
    throw new BridgeValidationError("baseDelayMs must be between 1 and 3600000");
  }
  if (!Number.isSafeInteger(result.maxDelayMs) || result.maxDelayMs < result.baseDelayMs || result.maxDelayMs > 86_400_000) {
    throw new BridgeValidationError("maxDelayMs must be at least baseDelayMs and at most 86400000");
  }
  if (!Number.isFinite(result.jitterRatio) || result.jitterRatio < 0 || result.jitterRatio > 1) {
    throw new BridgeValidationError("jitterRatio must be between 0 and 1");
  }
  return result;
}

export function validateMessageDraft(
  input: MessageDraft,
): Omit<BridgeMessage, "workspace" | "source" | "sequence" | "createdAt"> {
  const id = input.id ?? uuidv7();
  if (!UUID_RE.test(id)) throw new BridgeValidationError("id must be a UUID");

  const priority = input.priority ?? "info";
  if (!["info", "high", "urgent"].includes(priority)) {
    throw new BridgeValidationError("priority is invalid");
  }

  const atribReceiptId = optional(input.atribReceiptId, "atribReceiptId", 128);
  if (atribReceiptId && !normalizeReceiptId(atribReceiptId)) {
    throw new BridgeValidationError("atribReceiptId is invalid");
  }
  const informedBy = stringArray(input.informedBy, "informedBy", 64, 128);
  if (informedBy.some((hash) => !RECORD_HASH_RE.test(hash))) {
    throw new BridgeValidationError("informedBy must contain atrib record hashes");
  }

  return {
    id,
    type: clean(input.type, "type", 128),
    content: content(input.content),
    contentType: optional(input.contentType, "contentType", 128) ?? "text/plain",
    data: json(input.data, "data"),
    targets: stringArray(input.targets, "targets", 64, 128),
    threadId: optional(input.threadId, "threadId", 128),
    replyToId: optional(input.replyToId, "replyToId", 128),
    correlationId: optional(input.correlationId, "correlationId", 128),
    causationId: optional(input.causationId, "causationId", 128),
    priority,
    expiresAt: timestamp(input.expiresAt, "expiresAt"),
    idempotencyKey: optional(input.idempotencyKey, "idempotencyKey", 256),
    atribReceiptId,
    informedBy: informedBy.map((hash) => hash.toLowerCase()),
    metadata: json(input.metadata, "metadata"),
  };
}

export function encodeCursor(sequence: string): string {
  if (!SEQUENCE_RE.test(sequence)) {
    throw new BridgeValidationError("sequence is invalid");
  }
  return Buffer.from(JSON.stringify({ v: 1, sequence })).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;

  if (typeof cursor !== "string" || cursor.length > 256) {
    throw new BridgeValidationError("cursor is invalid");
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      parsed?.v !== 1 ||
      typeof parsed.sequence !== "string" ||
      !SEQUENCE_RE.test(parsed.sequence) ||
      BigInt(parsed.sequence) > POSTGRES_BIGINT_MAX
    ) {
      throw new Error();
    }
    return parsed.sequence;
  } catch {
    throw new BridgeValidationError("cursor is invalid");
  }
}
