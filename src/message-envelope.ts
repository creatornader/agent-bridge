import { randomUUID } from "node:crypto";

export const MESSAGE_ENVELOPE_SCHEMA = "agent-bridge.message-envelope.v1";

const RECORD_HASH_RE = /^sha256:[a-f0-9]{64}$/i;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const seen = new Set<string>();
  for (const item of raw) {
    const normalized = normalizeString(item);
    if (normalized) seen.add(normalized);
  }
  return seen.size ? [...seen] : undefined;
}

function normalizeRecordHashes(value: unknown): string[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const seen = new Set<string>();
  for (const item of raw) {
    const normalized = normalizeString(item);
    if (normalized && RECORD_HASH_RE.test(normalized)) {
      seen.add(normalized.toLowerCase());
    }
  }
  return seen.size ? [...seen] : undefined;
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  const text = normalizeString(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

export function normalizeMetadata(value: unknown): JsonRecord {
  return isRecord(value) ? { ...value } : {};
}

export function buildMessageEnvelope(
  args: JsonRecord | undefined,
  receiptId?: string
): JsonRecord {
  const source = normalizeString(args?.source) ?? "unknown";
  const category = normalizeString(args?.category);
  const kind = normalizeString(args?.kind) ?? category ?? "operational";
  const messageId = normalizeString(args?.message_id) ?? randomUUID();

  const envelope: JsonRecord = {
    schema: MESSAGE_ENVELOPE_SCHEMA,
    message_id: messageId,
    source_agent: source,
    kind,
    priority: normalizeString(args?.priority) ?? "info",
    payload_mime: normalizeString(args?.payload_mime) ?? "text/plain",
  };

  const targetAgents = normalizeStringList(args?.target_agents);
  if (targetAgents) envelope.target_agents = targetAgents;

  const project = normalizeString(args?.project);
  if (project) envelope.project = project;

  const threadId = normalizeString(args?.thread_id);
  if (threadId) envelope.thread_id = threadId;

  const replyToId = normalizeString(args?.reply_to_id);
  if (replyToId) envelope.reply_to_id = replyToId;

  if (Object.prototype.hasOwnProperty.call(args ?? {}, "payload")) {
    envelope.payload = args?.payload;
  }

  const payloadRef = normalizeString(args?.payload_ref);
  if (payloadRef) envelope.payload_ref = payloadRef;

  const payloadCiphertext = normalizeString(args?.payload_ciphertext);
  if (payloadCiphertext) envelope.payload_ciphertext = payloadCiphertext;

  if (receiptId) envelope.atrib_receipt_id = receiptId;

  const informedBy = normalizeRecordHashes(args?.informed_by);
  if (informedBy) envelope.informed_by = informedBy;

  const expiresAt = normalizeIsoTimestamp(args?.expires_at);
  if (expiresAt) envelope.expires_at = expiresAt;

  return envelope;
}

export function mergeEnvelopeMetadata(
  metadataInput: unknown,
  envelope: JsonRecord
): JsonRecord {
  return {
    ...normalizeMetadata(metadataInput),
    message_envelope: envelope,
  };
}

function getEnvelope(row: unknown): JsonRecord | undefined {
  if (!isRecord(row)) return undefined;
  const metadata = row.metadata;
  if (!isRecord(metadata)) return undefined;
  const envelope = metadata.message_envelope;
  return isRecord(envelope) ? envelope : undefined;
}

export function rowMatchesMessageFilters(
  row: unknown,
  filters: JsonRecord | undefined
): boolean {
  const targetAgent = normalizeString(filters?.target_agent);
  const threadId = normalizeString(filters?.thread_id);
  const kind = normalizeString(filters?.kind);

  if (!targetAgent && !threadId && !kind) return true;

  const envelope = getEnvelope(row);
  if (!envelope) {
    return !threadId && !kind;
  }

  if (targetAgent) {
    const targets = normalizeStringList(envelope.target_agents);
    if (targets && !targets.includes(targetAgent)) return false;
  }

  if (threadId && normalizeString(envelope.thread_id) !== threadId) {
    return false;
  }

  if (kind && normalizeString(envelope.kind) !== kind) {
    return false;
  }

  return true;
}

export function filterContextRows(
  rows: unknown,
  filters: JsonRecord | undefined,
  limit: number
): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.filter((row) => rowMatchesMessageFilters(row, filters)).slice(0, limit);
}
