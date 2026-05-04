// §1.5.2 propagation token: base64url(record_hash).base64url(creator_key),
// 43 + 1 + 43 = 87 chars. base64url alphabet is A-Z a-z 0-9 _ -.
const ATRIB_RECEIPT_ID_RE = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;

/**
 * Validate an atrib_receipt_id input. Returns the value if it matches the
 * §1.5.2 token format, otherwise undefined. The agent-bridge-atrib wrapper
 * always emits valid tokens, but the field is on the public tool surface —
 * any other producer could send arbitrary strings, and we do not want garbage
 * on the column.
 */
export function normalizeReceiptId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!ATRIB_RECEIPT_ID_RE.test(value)) return undefined;
  return value;
}
