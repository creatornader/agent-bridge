import {
  BridgeValidationError,
  encodeCursor,
  validateMessageDraft,
  validatePrincipal,
  validateRetryPolicy,
  validateUuid,
  type BridgeDelivery,
  type BridgeMessage,
  type BridgePrincipal,
  type MessageDraft,
  type RetryPolicy,
  type AgentPresence,
} from "./bridge-domain.js";
import type {
  BridgeStore,
  InsertMessageResult,
  MessagePage,
  MessageQuery,
} from "./bridge-store.js";

function validateLeaseMs(value = 30_000): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 15 * 60_000) {
    throw new BridgeValidationError("leaseMs must be between 1000 and 900000");
  }
  return value;
}

function validateQuery(query: MessageQuery): MessageQuery {
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new BridgeValidationError("limit must be between 1 and 200");
  }
  if (query.types !== undefined) {
    if (!Array.isArray(query.types) || query.types.length > 64) {
      throw new BridgeValidationError("types must contain at most 64 entries");
    }
    for (const type of query.types) {
      if (typeof type !== "string" || !type.trim() || type.length > 128) {
        throw new BridgeValidationError("type filter is invalid");
      }
    }
  }
  const source = query.source?.trim();
  if (source !== undefined && (!source || source.length > 128)) {
    throw new BridgeValidationError("source filter is invalid");
  }
  const unacknowledgedBy = query.unacknowledgedBy?.trim();
  if (
    unacknowledgedBy !== undefined &&
    (!unacknowledgedBy || unacknowledgedBy.length > 128)
  ) {
    throw new BridgeValidationError("unacknowledgedBy filter is invalid");
  }
  let since: string | undefined;
  if (query.since !== undefined) {
    const date = new Date(query.since);
    if (Number.isNaN(date.getTime())) throw new BridgeValidationError("since must be an ISO timestamp");
    since = date.toISOString();
  }
  const threadId = query.threadId?.trim();
  if (threadId !== undefined && (!threadId || threadId.length > 128)) {
    throw new BridgeValidationError("threadId filter is invalid");
  }
  if (query.latest && query.cursor) {
    throw new BridgeValidationError("latest cannot be combined with cursor");
  }
  return { ...query, limit, source, since, unacknowledgedBy, threadId, latest: query.latest === true };
}

export class BridgeService {
  constructor(private readonly store: BridgeStore) {}

  async publish(
    principalInput: BridgePrincipal,
    draftInput: MessageDraft,
  ): Promise<InsertMessageResult> {
    const principal = validatePrincipal(principalInput);
    const draft = validateMessageDraft(draftInput);
    return this.store.insertMessage({
      ...draft,
      workspace: principal.workspace,
      source: principal.agent,
    });
  }

  async history(
    principalInput: BridgePrincipal,
    query: MessageQuery = {},
  ): Promise<MessagePage> {
    return this.store.listMessages(validatePrincipal(principalInput), validateQuery(query));
  }

  async acknowledge(principalInput: BridgePrincipal, messageIds: string[]): Promise<number> {
    const principal = validatePrincipal(principalInput);
    if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 200) {
      throw new BridgeValidationError("messageIds must contain between 1 and 200 entries");
    }
    const ids = messageIds.map((id) => validateUuid(id, "messageId"));
    return this.store.recordReceipt(principal.workspace, ids, principal.agent);
  }

  async claim(
    principalInput: BridgePrincipal,
    options: { leaseMs?: number; maxAttempts?: number } = {},
  ): Promise<{ delivery: BridgeDelivery; leaseToken: string } | null> {
    const principal = validatePrincipal(principalInput);
    const delivery = await this.store.claimDelivery(principal, {
      leaseMs: validateLeaseMs(options.leaseMs),
      maxAttempts: validateRetryPolicy({ maxAttempts: options.maxAttempts }).maxAttempts,
    });
    return delivery?.leaseToken ? { delivery, leaseToken: delivery.leaseToken } : null;
  }

  async extend(
    principalInput: BridgePrincipal,
    deliveryId: string,
    leaseToken: string,
    leaseMs = 30_000,
  ): Promise<BridgeDelivery | null> {
    const principal = validatePrincipal(principalInput);
    return this.store.renewDelivery(
      principal,
      validateUuid(deliveryId, "deliveryId"),
      validateUuid(leaseToken, "leaseToken"),
      validateLeaseMs(leaseMs),
    );
  }

  async ack(
    principalInput: BridgePrincipal,
    deliveryId: string,
    leaseToken: string,
  ): Promise<BridgeDelivery | null> {
    const principal = validatePrincipal(principalInput);
    return this.store.settleDelivery(
      principal,
      validateUuid(deliveryId, "deliveryId"),
      validateUuid(leaseToken, "leaseToken"),
      "acked",
      undefined,
      validateRetryPolicy(),
    );
  }

  async nack(
    principalInput: BridgePrincipal,
    deliveryId: string,
    leaseToken: string,
    error: string,
    dead = false,
    retryPolicy: Partial<RetryPolicy> = {},
  ): Promise<BridgeDelivery | null> {
    const principal = validatePrincipal(principalInput);
    if (typeof dead !== "boolean") {
      throw new BridgeValidationError("dead must be a boolean");
    }
    if (typeof error !== "string" || !error.trim()) {
      throw new BridgeValidationError("error is required");
    }
    return this.store.settleDelivery(
      principal,
      validateUuid(deliveryId, "deliveryId"),
      validateUuid(leaseToken, "leaseToken"),
      dead ? "dead" : "retrying",
      error.slice(0, 1_024),
      validateRetryPolicy(retryPolicy),
    );
  }

  async heartbeat(
    principalInput: BridgePrincipal,
    options: { leaseMs?: number; runtimeType?: string; capabilities?: string[] } = {},
  ): Promise<AgentPresence> {
    const principal = validatePrincipal(principalInput);
    if (!principal.instance) throw new BridgeValidationError("instance is required for presence");
    if (!this.store.heartbeat) throw new BridgeValidationError("presence is not supported by this provider");
    if (
      options.runtimeType !== undefined &&
      typeof options.runtimeType !== "string"
    ) {
      throw new BridgeValidationError("runtimeType must be a string");
    }
    const runtimeType = options.runtimeType?.trim();
    if (runtimeType && runtimeType.length > 128) throw new BridgeValidationError("runtimeType exceeds 128 characters");
    if (options.capabilities !== undefined && !Array.isArray(options.capabilities)) {
      throw new BridgeValidationError("capabilities must be an array");
    }
    const capabilities = [...new Set(options.capabilities ?? [])].map((value) => {
      if (typeof value !== "string" || !value.trim() || value.length > 128) throw new BridgeValidationError("capability is invalid");
      return value.trim();
    });
    if (capabilities.length > 64) throw new BridgeValidationError("capabilities exceeds 64 entries");
    return this.store.heartbeat(principal, validateLeaseMs(options.leaseMs), runtimeType, capabilities);
  }

  async presence(principalInput: BridgePrincipal): Promise<AgentPresence[]> {
    const principal = validatePrincipal(principalInput);
    if (!this.store.listPresence) throw new BridgeValidationError("presence is not supported by this provider");
    return this.store.listPresence(principal);
  }
}

export { encodeCursor, type BridgeMessage };
