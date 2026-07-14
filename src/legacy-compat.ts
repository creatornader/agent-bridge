import type { BridgeMessage, JsonValue } from "./bridge-domain.js";

export function legacyMessageIdFromSequence(value: string | number): string {
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new Error("legacy message ID must be an integer");
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("legacy message ID must be decoded without precision loss");
  }
  const numeric = BigInt(text);
  if (numeric >= 0n && numeric <= 0xffffffffffffn) {
    return `00000000-0000-8000-8000-${numeric.toString(16).padStart(12, "0")}`;
  }
  if (numeric < -0x8000000000000000n || numeric > 0x7fffffffffffffffn) {
    throw new Error("legacy message ID exceeds bigint range");
  }
  const unsigned = numeric < 0 ? numeric + 0x10000000000000000n : numeric;
  const encoded = unsigned.toString(16).padStart(16, "0").padStart(18, "0");
  return `00000000-0000-8${encoded.slice(0, 3)}-9${encoded.slice(3, 6)}-${encoded.slice(6)}`;
}

export function legacySequenceFromMessageId(value: string): string | undefined {
  const small = value.match(/^00000000-0000-8000-8000-([0-9a-f]{12})$/i);
  if (small) return BigInt(`0x${small[1]}`).toString();
  const large = value.match(/^00000000-0000-8([0-9a-f]{3})-9([0-9a-f]{3})-([0-9a-f]{12})$/i);
  if (!large) return undefined;
  const encoded = `${large[1]}${large[2]}${large[3]}`;
  if (!encoded.startsWith("00")) return undefined;
  const unsigned = BigInt(`0x${encoded.slice(2)}`);
  return (unsigned >= 0x8000000000000000n
    ? unsigned - 0x10000000000000000n
    : unsigned).toString();
}

export function legacyNumericMessageId(value: string | number): string {
  const text = String(value);
  return /^-?\d+$/.test(text) ? legacyMessageIdFromSequence(value) : text;
}

export function legacyContextMetadata(message: BridgeMessage): Record<string, JsonValue> {
  const metadata = message.metadata &&
    typeof message.metadata === "object" &&
    !Array.isArray(message.metadata)
    ? message.metadata
    : {};
  const existingEnvelope = metadata.message_envelope &&
    typeof metadata.message_envelope === "object" &&
    !Array.isArray(metadata.message_envelope)
    ? metadata.message_envelope
    : {};
  const envelope: Record<string, JsonValue> = {
    ...existingEnvelope,
    schema: "agent-bridge.message-envelope.v1",
    message_id: message.id,
    source_agent: message.source,
    kind: message.type,
    priority: message.priority,
    target_agents: message.targets,
    payload_mime: message.contentType,
  };
  if (message.project) envelope.project = message.project;
  if (message.threadId) envelope.thread_id = message.threadId;
  if (message.replyToId) envelope.reply_to_id = message.replyToId;
  if (message.correlationId) envelope.correlation_id = message.correlationId;
  if (message.causationId) envelope.causation_id = message.causationId;
  if (message.data !== undefined) envelope.payload = message.data;
  if (message.expiresAt) envelope.expires_at = message.expiresAt;
  if (message.atribReceiptId) envelope.atrib_receipt_id = message.atribReceiptId;
  if (message.informedBy?.length) envelope.informed_by = message.informedBy;
  return { ...metadata, message_envelope: envelope };
}
