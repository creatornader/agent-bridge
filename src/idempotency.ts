import { createHash } from "node:crypto";
import type { BridgeMessage, JsonValue } from "./bridge-domain.js";

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict";
  readonly status = 409;
}

function canonical(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function fingerprint(message: Omit<BridgeMessage, "sequence" | "createdAt">): string {
  const value: JsonValue = {
    workspace: message.workspace,
    source: message.source,
    type: message.type,
    content: message.content,
    contentType: message.contentType,
    data: message.data ?? null,
    targets: [...message.targets].sort(),
    threadId: message.threadId ?? null,
    replyToId: message.replyToId ?? null,
    correlationId: message.correlationId ?? null,
    causationId: message.causationId ?? null,
    priority: message.priority,
    expiresAt: message.expiresAt ?? null,
    atribReceiptId: message.atribReceiptId ?? null,
    informedBy: [...(message.informedBy ?? [])].sort(),
    metadata: message.metadata ?? null,
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function assertIdempotentReplay(
  existing: BridgeMessage,
  attempted: Omit<BridgeMessage, "sequence" | "createdAt">,
): void {
  if (fingerprint(existing) !== fingerprint(attempted)) {
    throw new IdempotencyConflictError("idempotency key is already bound to a different message");
  }
}
