import {
  BridgePrincipalMismatchError,
  BridgeValidationError,
  encodeCursor,
  validateMessageDraft,
  validatePrincipal,
  validateProject,
  validateUuid,
  type BridgeDelivery,
  type BridgeMessage,
  type BridgePrincipal,
  type MessageDraft,
  type AgentPresence,
  type DeliveryState,
} from "./bridge-domain.js";
import type {
  BridgeStore,
  DeliveryQuery,
  InsertMessageResult,
  MessagePage,
  MessageQuery,
} from "./bridge-store.js";

function validateDeprecatedMaxAttempts(value: unknown): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 100) {
    throw new BridgeValidationError("maxAttempts must be between 1 and 100");
  }
}

function validateDeprecatedRetryPolicy(value: unknown): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeValidationError("retryPolicy must be an object");
  }
  const allowed = new Set(["maxAttempts", "baseDelayMs", "maxDelayMs", "jitterRatio"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new BridgeValidationError(`retryPolicy.${key} is not supported`);
  }
  const policy = value as Record<string, unknown>;
  validateDeprecatedMaxAttempts(policy.maxAttempts);
  for (const [key, maximum] of [["baseDelayMs", 3_600_000], ["maxDelayMs", 86_400_000]] as const) {
    if (policy[key] !== undefined && (!Number.isSafeInteger(policy[key]) || Number(policy[key]) < 1 || Number(policy[key]) > maximum)) {
      throw new BridgeValidationError(`${key} is invalid`);
    }
  }
  if (policy.jitterRatio !== undefined && (!Number.isFinite(policy.jitterRatio) || Number(policy.jitterRatio) < 0 || Number(policy.jitterRatio) > 1)) {
    throw new BridgeValidationError("jitterRatio must be between 0 and 1");
  }
}

function validateLeaseMs(value = 30_000): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 15 * 60_000) {
    throw new BridgeValidationError("leaseMs must be between 1000 and 900000");
  }
  return value;
}

export type PublicMessageQuery = MessageQuery & { unacknowledgedBy?: string };

function validateQuery(query: PublicMessageQuery, principal: BridgePrincipal): MessageQuery {
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
  if (unacknowledgedBy !== undefined && unacknowledgedBy !== principal.agent) {
    throw new BridgePrincipalMismatchError("unacknowledgedBy must equal the configured principal");
  }
  const mailbox = query.mailbox ?? "inbox";
  if (!["inbox", "sent", "all"].includes(mailbox)) throw new BridgeValidationError("mailbox is invalid");
  const receiptState = query.receiptState ?? (unacknowledgedBy ? "unread" : "any");
  if (!["any", "unread", "read"].includes(receiptState)) throw new BridgeValidationError("receiptState is invalid");
  if (mailbox !== "inbox" && receiptState !== "any") {
    throw new BridgeValidationError("receiptState is valid only for inbox");
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
  const { unacknowledgedBy: _compat, ...storeQuery } = query;
  return { ...storeQuery, mailbox, receiptState, project: validateProject(query.project), limit, source, since, threadId, latest: query.latest === true };
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
    query: PublicMessageQuery = {},
  ): Promise<MessagePage> {
    const principal = validatePrincipal(principalInput);
    return this.store.listMessages(principal, validateQuery(query, principal));
  }

  async acknowledge(principalInput: BridgePrincipal, messageIds: string[]): Promise<number> {
    const principal = validatePrincipal(principalInput);
    if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 200) {
      throw new BridgeValidationError("messageIds must contain between 1 and 200 entries");
    }
    const ids = messageIds.map((id) => validateUuid(id, "messageId"));
    return this.store.recordReceipt(principal, ids);
  }

  async claim(
    principalInput: BridgePrincipal,
    options: { leaseMs?: number; messageId?: string; maxAttempts?: number } = {},
  ): Promise<{ delivery: BridgeDelivery; leaseToken: string } | null> {
    const principal = validatePrincipal(principalInput);
    validateDeprecatedMaxAttempts(options.maxAttempts);
    const delivery = await this.store.claimDelivery(principal, {
      leaseMs: validateLeaseMs(options.leaseMs),
      messageId: options.messageId === undefined ? undefined : validateUuid(options.messageId, "messageId"),
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
    );
  }

  async nack(
    principalInput: BridgePrincipal,
    deliveryId: string,
    leaseToken: string,
    error: string,
    disposition: "retry" | "dead" | boolean = "retry",
    deprecatedRetryPolicy?: unknown,
  ): Promise<BridgeDelivery | null> {
    const principal = validatePrincipal(principalInput);
    if (!["retry", "dead", true, false].includes(disposition as never)) {
      throw new BridgeValidationError("disposition must be retry or dead");
    }
    if (typeof error !== "string" || !error.trim()) {
      throw new BridgeValidationError("error is required");
    }
    validateDeprecatedRetryPolicy(deprecatedRetryPolicy);
    return this.store.settleDelivery(
      principal,
      validateUuid(deliveryId, "deliveryId"),
      validateUuid(leaseToken, "leaseToken"),
      disposition === "dead" || disposition === true ? "dead" : "retrying",
      error.slice(0, 1_024),
    );
  }

  async deliveries(principalInput: BridgePrincipal, query: DeliveryQuery = {}) {
    const principal = validatePrincipal(principalInput);
    if (!this.store.listDeliveries) throw new BridgeValidationError("delivery listing is not supported by this provider");
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new BridgeValidationError("limit must be between 1 and 200");
    const role = query.role ?? "all";
    if (!["recipient", "publisher", "all"].includes(role)) throw new BridgeValidationError("role is invalid");
    const validStates: DeliveryState[] = ["pending", "claimed", "acked", "retrying", "dead", "cancelled"];
    if (query.states !== undefined && (!Array.isArray(query.states) || query.states.some((state) => !validStates.includes(state)))) {
      throw new BridgeValidationError("states contains an invalid delivery state");
    }
    const recipient = query.recipient?.trim();
    if (recipient !== undefined && (!recipient || recipient.length > 128)) throw new BridgeValidationError("recipient is invalid");
    return this.store.listDeliveries(principal, {
      ...query,
      role,
      limit,
      messageId: query.messageId ? validateUuid(query.messageId, "messageId") : undefined,
      recipient,
      states: query.states ? [...new Set(query.states)].sort() : undefined,
    });
  }

  async deliveryEvents(principalInput: BridgePrincipal, deliveryId: string, query: { cursor?: string; limit?: number } = {}) {
    const principal = validatePrincipal(principalInput);
    if (!this.store.listDeliveryEvents) throw new BridgeValidationError("delivery event listing is not supported by this provider");
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new BridgeValidationError("limit must be between 1 and 200");
    return this.store.listDeliveryEvents(principal, validateUuid(deliveryId, "deliveryId"), { ...query, limit });
  }

  async cancel(principalInput: BridgePrincipal, deliveryId: string) {
    const principal = validatePrincipal(principalInput);
    if (!this.store.cancelDelivery) throw new BridgeValidationError("delivery cancellation is not supported by this provider");
    return this.store.cancelDelivery(principal, validateUuid(deliveryId, "deliveryId"));
  }

  async requeue(principalInput: BridgePrincipal, deliveryId: string) {
    const principal = validatePrincipal(principalInput);
    if (!this.store.requeueDelivery) throw new BridgeValidationError("delivery requeue is not supported by this provider");
    return this.store.requeueDelivery(principal, validateUuid(deliveryId, "deliveryId"));
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
