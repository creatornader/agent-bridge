import Type, { type TSchema } from "@sinclair/typebox";
import { Check, Errors } from "@sinclair/typebox/value";

export const PROTOCOL_VERSION = "2.1";
export const LEGACY_PROTOCOL_VERSION = "2.0";
export const SUPPORTED_PROTOCOL_VERSIONS = [LEGACY_PROTOCOL_VERSION, PROTOCOL_VERSION] as const;
export const SUPPORTED_PROTOCOL_RANGE = SUPPORTED_PROTOCOL_VERSIONS.join(",");
export const PROTOCOL_HEADER = "x-agent-bridge-protocol-version";
export const SUPPORTED_PROTOCOL_HEADER = "x-agent-bridge-supported-protocol-versions";
export const SCOPE_ENFORCEMENT = true;

const StringArray = Type.Array(Type.String());
const Empty = Type.Object({}, { additionalProperties: false });
const OptionalString = () => Type.Optional(Type.String());
const OptionalNumber = (options: Record<string, unknown> = {}) => Type.Optional(Type.Number(options));
const OptionalBoolean = () => Type.Optional(Type.Boolean());
const NullableString = () => Type.Union([Type.String(), Type.Null()]);
const NullableNumber = () => Type.Union([Type.Number(), Type.Null()]);
const UUID_V7_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

export const ErrorIssueSchema = Type.Object({
  path: Type.String(),
  message: Type.String(),
}, { additionalProperties: true });

export const ErrorEnvelopeSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    requestId: Type.String(),
    message: OptionalString(),
    operation: OptionalString(),
    issues: Type.Optional(Type.Array(ErrorIssueSchema)),
    details: Type.Optional(Type.Any()),
    supportedProtocolVersions: Type.Optional(StringArray),
  }, { additionalProperties: true }),
}, { additionalProperties: true });

const DeliveryPolicySchema = Type.Union([
  Type.Object({ mode: Type.Literal("mailbox") }, { additionalProperties: false }),
  Type.Object({
    mode: Type.Literal("leased"),
    maxAttempts: Type.Number(),
    retryBaseDelayMs: Type.Number(),
    retryMaxDelayMs: Type.Number(),
    retryJitterRatio: Type.Number(),
    notBefore: OptionalString(),
  }, { additionalProperties: false }),
]);

const DeliveryPolicyInputSchema = Type.Object({
  mode: Type.Optional(Type.Enum(["mailbox", "leased"])),
  maxAttempts: OptionalNumber(),
  retryBaseDelayMs: OptionalNumber(),
  retryMaxDelayMs: OptionalNumber(),
  retryJitterRatio: OptionalNumber(),
  notBefore: OptionalString(),
}, { additionalProperties: false });

const MessageDraftSchema = Type.Object({
  id: Type.Optional(Type.String({ pattern: UUID_V7_PATTERN })),
  source: OptionalString(),
  project: OptionalString(),
  type: Type.String(),
  content: Type.String(),
  contentType: OptionalString(),
  data: Type.Optional(Type.Any()),
  targets: Type.Optional(StringArray),
  threadId: OptionalString(),
  replyToId: OptionalString(),
  correlationId: OptionalString(),
  causationId: OptionalString(),
  priority: Type.Optional(Type.Enum(["info", "high", "urgent"])),
  expiresAt: OptionalString(),
  idempotencyKey: OptionalString(),
  atribReceiptId: OptionalString(),
  informedBy: Type.Optional(StringArray),
  metadata: Type.Optional(Type.Any()),
  deliveryPolicy: Type.Optional(DeliveryPolicyInputSchema),
}, { additionalProperties: false });

// Exact field set released by package 0.2.0 at d8184fe. A headerless
// gateway response selects this wire contract, not the current one.
export const LegacyMessageDraftSchema = Type.Object({
  id: OptionalString(), source: OptionalString(), type: Type.String(), content: Type.String(),
  contentType: OptionalString(), data: Type.Optional(Type.Any()), targets: Type.Optional(StringArray),
  threadId: OptionalString(), replyToId: OptionalString(), correlationId: OptionalString(),
  causationId: OptionalString(), priority: Type.Optional(Type.Enum(["info", "high", "urgent"])),
  expiresAt: OptionalString(), idempotencyKey: OptionalString(), atribReceiptId: OptionalString(),
  informedBy: Type.Optional(StringArray), metadata: Type.Optional(Type.Any()),
}, { additionalProperties: false });

const MessageSchema = Type.Object({
  id: Type.String(),
  workspace: Type.String(),
  project: OptionalString(),
  source: Type.String(),
  type: Type.String(),
  content: Type.String(),
  contentType: Type.String(),
  sequence: Type.String(),
  createdAt: Type.String(),
  data: Type.Optional(Type.Any()),
  targets: StringArray,
  threadId: OptionalString(),
  replyToId: OptionalString(),
  correlationId: OptionalString(),
  causationId: OptionalString(),
  priority: Type.Enum(["info", "high", "urgent"]),
  expiresAt: OptionalString(),
  idempotencyKey: OptionalString(),
  atribReceiptId: OptionalString(),
  informedBy: Type.Optional(StringArray),
  metadata: Type.Optional(Type.Any()),
  deliveryPolicy: DeliveryPolicySchema,
}, { additionalProperties: true });

export const LegacyMessageSchema = Type.Object({
  id: Type.String(), workspace: Type.String(), source: Type.String(), type: Type.String(),
  content: Type.String(), contentType: Type.String(), sequence: Type.String(), createdAt: Type.String(),
  data: Type.Optional(Type.Any()), targets: StringArray, threadId: OptionalString(), replyToId: OptionalString(),
  correlationId: OptionalString(), causationId: OptionalString(), priority: Type.Enum(["info", "high", "urgent"]),
  expiresAt: OptionalString(), idempotencyKey: OptionalString(), atribReceiptId: OptionalString(),
  informedBy: Type.Optional(StringArray), metadata: Type.Optional(Type.Any()),
}, { additionalProperties: true });

const DeliveryStateSchema = Type.Enum(["pending", "claimed", "acked", "retrying", "dead", "cancelled"]);
const DeliveryActionSchema = Type.Enum(["created", "claim", "ack", "nack_retry", "nack_dead", "lease_expired", "attempts_exhausted", "message_expired", "cancel", "requeue"]);
const DeliverySchema = Type.Object({
  id: Type.String(),
  messageId: Type.String(),
  workspace: Type.String(),
  recipient: Type.String(),
  state: DeliveryStateSchema,
  attempt: Type.Number(),
  cycleAttempt: Type.Number(),
  requeueCount: Type.Number(),
  createdAt: Type.String(),
  priorityRank: Type.Number(),
  availableAt: Type.String(),
  leaseToken: OptionalString(),
  leaseOwner: OptionalString(),
  leaseExpiresAt: OptionalString(),
  lastError: OptionalString(),
  lastActor: OptionalString(),
  lastAction: DeliveryActionSchema,
}, { additionalProperties: true });

export const LegacyDeliverySchema = Type.Object({
  id: Type.String(), messageId: Type.String(), workspace: Type.String(), recipient: Type.String(),
  state: Type.Enum(["pending", "claimed", "acked", "retrying", "dead"]), attempt: Type.Number(),
  availableAt: Type.String(), leaseToken: OptionalString(), leaseOwner: OptionalString(),
  leaseExpiresAt: OptionalString(), lastError: OptionalString(),
}, { additionalProperties: true });

const DeliveryEventSchema = Type.Object({
  sequence: Type.String(),
  deliveryId: Type.String(),
  messageId: Type.String(),
  workspace: Type.String(),
  recipient: Type.String(),
  fromState: Type.Optional(DeliveryStateSchema),
  toState: DeliveryStateSchema,
  attempt: Type.Number(),
  cycleAttempt: Type.Number(),
  requeueCount: Type.Number(),
  leaseOwner: OptionalString(),
  error: OptionalString(),
  actor: Type.String(),
  action: DeliveryActionSchema,
  createdAt: Type.String(),
}, { additionalProperties: true });

const PresenceSchema = Type.Object({
  workspace: Type.String(),
  agent: Type.String(),
  instance: Type.String(),
  runtimeType: OptionalString(),
  capabilities: StringArray,
  leaseExpiresAt: Type.String(),
  lastSeenAt: Type.String(),
}, { additionalProperties: true });

const DiagnosticsSchema = Type.Object({
  schemaVersion: Type.Enum(["local-v2", "postgres-v2", "legacy-v1"]),
  deliverySupported: Type.Boolean(),
  pending: NullableNumber(),
  claimed: NullableNumber(),
  retrying: NullableNumber(),
  dead: NullableNumber(),
  cancelled: Type.Optional(NullableNumber()),
  oldestAvailableAt: OptionalString(),
  principal: Type.Optional(Type.Object({ workspace: Type.String(), agent: Type.String() }, { additionalProperties: true })),
  remoteReachable: OptionalBoolean(),
  outboxPending: OptionalNumber(),
  outboxBlocked: OptionalNumber(),
  cachedMessages: OptionalNumber(),
  lastSyncAt: OptionalString(),
  lastSyncError: OptionalString(),
}, { additionalProperties: true });

const ClientStatusSchema = Type.Object({
  status: Type.Enum(["ok", "degraded"]),
  localHealthy: Type.Boolean(),
  connected: Type.Boolean(),
  remoteReachable: Type.Union([Type.Boolean(), Type.Null()]),
  provider: Type.Enum(["local", "gateway", "legacy-supabase"]),
  workspace: Type.String(),
  agent: Type.String(),
  instance: Type.Union([Type.String(), Type.Null()]),
  schemaVersion: Type.Enum(["local-v2", "postgres-v2", "legacy-v1"]),
  endpoint: Type.Union([Type.String(), Type.Null()]),
  database: Type.Union([Type.String(), Type.Null()]),
  cursorPath: Type.String(),
  lastCursor: Type.Union([Type.String(), Type.Null()]),
  queue: DiagnosticsSchema,
}, { additionalProperties: true });

const HistoryRequestSchema = Type.Object({
  cursor: OptionalString(),
  limit: OptionalNumber({ minimum: 1, maximum: 200 }),
  types: Type.Optional(StringArray),
  mailbox: Type.Optional(Type.Enum(["inbox", "sent", "all"])),
  receiptState: Type.Optional(Type.Enum(["any", "unread", "read"])),
  includeExpired: OptionalBoolean(),
  source: OptionalString(),
  project: OptionalString(),
  since: OptionalString(),
  unacknowledgedBy: OptionalString(),
  threadId: OptionalString(),
  latest: OptionalBoolean(),
}, { additionalProperties: false });

const MessagePageSchema = Type.Object({
  messages: Type.Array(MessageSchema),
  cursor: OptionalString(),
  source: Type.Optional(Type.Enum(["remote", "cache"])),
  stale: OptionalBoolean(),
  degraded: OptionalBoolean(),
  acknowledgements: Type.Optional(Type.Enum(["authoritative", "unknown"])),
  lastSyncedAt: OptionalString(),
}, { additionalProperties: true });

const DeliveryPageSchema = Type.Object({ deliveries: Type.Array(DeliverySchema), cursor: OptionalString() }, { additionalProperties: true });
const DeliveryEventPageSchema = Type.Object({ events: Type.Array(DeliveryEventSchema), cursor: OptionalString() }, { additionalProperties: true });
const DeliveryIdSchema = Type.Object({ deliveryId: Type.String() }, { additionalProperties: false });
const LeaseSchema = Type.Object({ deliveryId: Type.String(), leaseToken: Type.String() }, { additionalProperties: false });
const RetryPolicySchema = Type.Object({
  maxAttempts: OptionalNumber(),
  baseDelayMs: OptionalNumber(),
  maxDelayMs: OptionalNumber(),
  jitterRatio: OptionalNumber(),
}, { additionalProperties: false });

const NegativeAcknowledgeRequestSchema = Type.Object({
  deliveryId: Type.String(),
  leaseToken: Type.String(),
  error: Type.String(),
  disposition: Type.Optional(Type.Enum(["retry", "dead"])),
  dead: OptionalBoolean(),
  retryPolicy: Type.Optional(RetryPolicySchema),
}, { additionalProperties: false });

const LegacyNegativeAcknowledgeRequestSchema = Type.Object({
  deliveryId: Type.String(),
  leaseToken: Type.String(),
  error: OptionalString(),
  disposition: Type.Optional(Type.Enum(["retry", "dead"])),
  dead: OptionalBoolean(),
  retryPolicy: Type.Optional(RetryPolicySchema),
}, { additionalProperties: false });

const SyncResponseSchema = Type.Object({
  online: Type.Boolean(),
  pushed: Type.Number(),
  deduplicated: Type.Number(),
  pulled: Type.Number(),
  pending: Type.Number(),
  blocked: Type.Number(),
  cached: Type.Number(),
  cursor: Type.Optional(NullableString()),
  lastSyncedAt: Type.Optional(NullableString()),
  lastError: Type.Optional(NullableString()),
  failureRetryable: OptionalBoolean(),
}, { additionalProperties: true });

const ClaimResponseSchema = Type.Object({
  delivery: Type.Union([DeliverySchema, Type.Null()]),
  leaseToken: OptionalString(),
}, {
  additionalProperties: true,
  oneOf: [
    { properties: { delivery: { type: "null" }, leaseToken: false }, required: ["delivery"] },
    { properties: { delivery: DeliverySchema, leaseToken: { type: "string" } }, required: ["delivery", "leaseToken"] },
  ],
});

export const AUTHORIZATION_SCOPES = [
  "deliveries:claim",
  "deliveries:manage",
  "deliveries:read",
  "deliveries:settle",
  "gateway:metrics",
  "messages:read",
  "messages:write",
  "presence:read",
  "presence:write",
  "receipts:write",
  "status:read",
] as const;

export type AuthorizationScope = typeof AUTHORIZATION_SCOPES[number];

export type ContractProvider = "local" | "gateway" | "legacy-supabase";
export type ContractSurface = "mcp" | "http" | "cli";
export type OperationId =
  | "capabilities" | "status" | "client_status" | "gateway_metrics" | "publish_message" | "history"
  | "record_receipt" | "claim_delivery" | "list_deliveries" | "list_delivery_events"
  | "cancel_delivery" | "requeue_delivery" | "extend_delivery" | "acknowledge_delivery"
  | "negative_acknowledge_delivery" | "heartbeat" | "presence" | "sync";

export interface HttpContract {
  method: "GET" | "POST";
  path: string;
  successStatus?: 200 | 201;
  responseContentType?: "application/json" | "text/plain";
  queryAliases?: Readonly<Record<string, readonly string[]>>;
}

export interface CliContract {
  command: string;
  aliases?: readonly string[];
  options: readonly string[];
  response?: TSchema;
  variants?: readonly CliCompatibilityVariant[];
}

export interface CliCompatibilityVariant {
  command: string;
  condition: { kind: "always" } | { kind: "option-present"; option: string };
  routesTo: OperationId;
  options: readonly string[];
  response: TSchema;
}

export interface OperationContract {
  id: OperationId;
  summary: string;
  request: TSchema;
  response: TSchema;
  scopes: readonly AuthorizationScope[];
  providers: readonly ContractProvider[];
  mcp?: { name: string };
  http?: HttpContract;
  cli?: CliContract;
}

const ALL_PROVIDERS = ["local", "gateway", "legacy-supabase"] as const;
const DELIVERY_PROVIDERS = ["local", "gateway"] as const;
const GATEWAY_PROVIDER = ["gateway"] as const;
const operation = (entry: OperationContract): OperationContract => entry;
const HistoryCliOptions = ["cursor", "limit", "type", "category", "mailbox", "receipt-state", "source", "project", "since", "unacked-by", "thread-id", "latest"] as const;
const LegacyGetRowSchema = Type.Object({
  id: Type.Union([Type.String(), Type.Number()]),
  source: Type.String(),
  category: Type.String(),
  content: Type.String(),
  priority: Type.Enum(["info", "high", "urgent"]),
  project: NullableString(),
  metadata: Type.Any(),
  created_at: Type.String(),
}, { additionalProperties: false });
const ReceiptCliResponseSchema = Type.Object({
  acknowledged: Type.Number(),
  agent: Type.String(),
}, { additionalProperties: true });

export const operations: readonly OperationContract[] = [
  operation({ id: "capabilities", summary: "Discover operations available on the current surface.", request: Empty, response: Type.Object({ protocolVersion: Type.String(), currentProtocolVersion: Type.String(), selectedProtocolVersion: Type.String(), supportedProtocolVersions: StringArray, scopeEnforcement: Type.Boolean(), requestAuthority: Type.Boolean(), rowIsolation: Type.Boolean(), authorizationModel: Type.Enum(["scoped-credential", "credential-wide", "process-identity", "legacy-key"]), surface: Type.Enum(["mcp", "http", "cli"]), provider: Type.Enum(["local", "gateway", "legacy-supabase"]), operations: Type.Array(Type.Object({ id: Type.String(), summary: Type.String(), requiredScopes: StringArray, mcp: Type.Optional(Type.Any()), http: Type.Optional(Type.Any()), cli: Type.Optional(Type.Any()) }, { additionalProperties: true })) }, { additionalProperties: true }), scopes: [], providers: ALL_PROVIDERS, mcp: { name: "capabilities" }, http: { method: "GET", path: "/v2/capabilities" }, cli: { command: "capabilities", options: [] } }),
  operation({ id: "status", summary: "Read gateway delivery diagnostics.", request: Empty, response: DiagnosticsSchema, scopes: ["status:read"], providers: ALL_PROVIDERS, http: { method: "GET", path: "/v2/status" } }),
  operation({ id: "client_status", summary: "Read client connectivity and provider diagnostics.", request: Empty, response: ClientStatusSchema, scopes: ["status:read"], providers: ALL_PROVIDERS, cli: { command: "status", aliases: ["doctor"], options: [] } }),
  operation({ id: "gateway_metrics", summary: "Read Prometheus gateway counters.", request: Empty, response: Type.String(), scopes: ["gateway:metrics"], providers: GATEWAY_PROVIDER, http: { method: "GET", path: "/metrics", responseContentType: "text/plain" } }),
  operation({ id: "publish_message", summary: "Create an immutable Agent Bridge v2 message.", request: MessageDraftSchema, response: Type.Object({ created: Type.Boolean(), message: MessageSchema, disposition: Type.Optional(Type.Enum(["committed", "queued"])), authoritative: OptionalBoolean() }, { additionalProperties: true }), scopes: ["messages:write"], providers: ALL_PROVIDERS, mcp: { name: "send" }, http: { method: "POST", path: "/v2/messages", successStatus: 201 }, cli: { command: "send", aliases: ["post"], options: ["source", "project", "type", "kind", "category", "content", "content-type", "data", "payload", "payload-mime", "payload-ref", "payload-ciphertext", "target", "target-agent", "target-agents", "thread-id", "reply-to-id", "correlation-id", "causation-id", "priority", "expires-at", "idempotency-key", "atrib-receipt-id", "informed-by", "metadata", "delivery-mode", "delivery-policy", "delivery-max-attempts", "retry-base-ms", "retry-max-ms", "retry-jitter", "not-before", "message-id"] } }),
  operation({ id: "history", summary: "Read visible messages after an opaque cursor.", request: HistoryRequestSchema, response: MessagePageSchema, scopes: ["messages:read"], providers: ALL_PROVIDERS, mcp: { name: "history" }, http: { method: "GET", path: "/v2/history", queryAliases: { unacknowledgedBy: ["unacked_by"] } }, cli: { command: "history", aliases: ["inbox", "sent"], options: HistoryCliOptions, variants: [{ command: "get", condition: { kind: "always" }, routesTo: "history", options: HistoryCliOptions, response: Type.Array(LegacyGetRowSchema) }] } }),
  operation({ id: "record_receipt", summary: "Record caller-bound inbox read receipts.", request: Type.Object({ messageIds: Type.Array(Type.String(), { minItems: 1, maxItems: 200 }) }, { additionalProperties: false }), response: Type.Object({ recorded: Type.Number() }, { additionalProperties: true }), scopes: ["receipts:write"], providers: ALL_PROVIDERS, http: { method: "POST", path: "/v2/receipts" }, cli: { command: "acknowledge", aliases: ["receipt"], options: ["ids"], response: ReceiptCliResponseSchema, variants: [{ command: "ack", condition: { kind: "option-present", option: "ids" }, routesTo: "record_receipt", options: ["ids"], response: ReceiptCliResponseSchema }] } }),
  operation({ id: "claim_delivery", summary: "Atomically claim the next targeted delivery.", request: Type.Object({ leaseMs: OptionalNumber(), maxAttempts: OptionalNumber() }, { additionalProperties: false }), response: ClaimResponseSchema, scopes: ["deliveries:claim"], providers: DELIVERY_PROVIDERS, mcp: { name: "claim" }, http: { method: "POST", path: "/v2/deliveries/claim" }, cli: { command: "claim", options: ["lease-ms", "max-attempts"], response: Type.Union([Type.Object({ delivery: DeliverySchema, leaseToken: Type.String() }, { additionalProperties: true }), Type.Null()]) } }),
  operation({ id: "list_deliveries", summary: "List caller-visible deliveries.", request: Type.Object({ cursor: OptionalString(), limit: OptionalNumber(), role: Type.Optional(Type.Enum(["recipient", "publisher", "all"])), messageId: OptionalString(), recipient: OptionalString(), states: Type.Optional(Type.Array(DeliveryStateSchema)) }, { additionalProperties: false }), response: DeliveryPageSchema, scopes: ["deliveries:read"], providers: DELIVERY_PROVIDERS, mcp: { name: "list_deliveries" }, http: { method: "GET", path: "/v2/deliveries" }, cli: { command: "deliveries", aliases: ["dead-letters"], options: ["cursor", "limit", "role", "message-id", "recipient", "state"] } }),
  operation({ id: "list_delivery_events", summary: "List the append-only event history for a delivery.", request: Type.Object({ deliveryId: Type.String(), cursor: OptionalString(), limit: OptionalNumber() }, { additionalProperties: false }), response: DeliveryEventPageSchema, scopes: ["deliveries:read"], providers: DELIVERY_PROVIDERS, mcp: { name: "list_delivery_events" }, http: { method: "GET", path: "/v2/deliveries/{deliveryId}/events" }, cli: { command: "delivery-events", options: ["delivery-id", "cursor", "limit"] } }),
  operation({ id: "cancel_delivery", summary: "Cancel a delivery as its publisher.", request: DeliveryIdSchema, response: Type.Object({ delivery: Type.Union([DeliverySchema, Type.Null()]) }, { additionalProperties: true }), scopes: ["deliveries:manage"], providers: DELIVERY_PROVIDERS, mcp: { name: "cancel_delivery" }, http: { method: "POST", path: "/v2/deliveries/{deliveryId}/cancel" }, cli: { command: "cancel", options: ["delivery-id"], response: Type.Union([DeliverySchema, Type.Null()]) } }),
  operation({ id: "requeue_delivery", summary: "Requeue a delivery as its publisher.", request: DeliveryIdSchema, response: Type.Object({ delivery: Type.Union([DeliverySchema, Type.Null()]) }, { additionalProperties: true }), scopes: ["deliveries:manage"], providers: DELIVERY_PROVIDERS, mcp: { name: "requeue_delivery" }, http: { method: "POST", path: "/v2/deliveries/{deliveryId}/requeue" }, cli: { command: "requeue", options: ["delivery-id"], response: Type.Union([DeliverySchema, Type.Null()]) } }),
  operation({ id: "extend_delivery", summary: "Extend a claimed delivery lease.", request: Type.Object({ deliveryId: Type.String(), leaseToken: Type.String(), leaseMs: Type.Number() }, { additionalProperties: false }), response: Type.Object({ delivery: Type.Union([DeliverySchema, Type.Null()]) }, { additionalProperties: true }), scopes: ["deliveries:settle"], providers: DELIVERY_PROVIDERS, mcp: { name: "extend" }, http: { method: "POST", path: "/v2/deliveries/{deliveryId}/extend" }, cli: { command: "extend", options: ["delivery-id", "lease-token", "lease-ms"], response: Type.Union([DeliverySchema, Type.Null()]) } }),
  operation({ id: "acknowledge_delivery", summary: "Settle a claimed delivery successfully.", request: LeaseSchema, response: Type.Object({ delivery: Type.Union([DeliverySchema, Type.Null()]) }, { additionalProperties: true }), scopes: ["deliveries:settle"], providers: DELIVERY_PROVIDERS, mcp: { name: "acknowledge" }, http: { method: "POST", path: "/v2/deliveries/{deliveryId}/ack" }, cli: { command: "ack", options: ["delivery-id", "lease-token"], response: Type.Union([DeliverySchema, Type.Null()]) } }),
  operation({ id: "negative_acknowledge_delivery", summary: "Settle a claimed delivery for retry or dead letter.", request: NegativeAcknowledgeRequestSchema, response: Type.Object({ delivery: Type.Union([DeliverySchema, Type.Null()]) }, { additionalProperties: true }), scopes: ["deliveries:settle"], providers: DELIVERY_PROVIDERS, mcp: { name: "negative_acknowledge" }, http: { method: "POST", path: "/v2/deliveries/{deliveryId}/nack" }, cli: { command: "nack", options: ["delivery-id", "lease-token", "error", "disposition", "dead"], response: Type.Union([DeliverySchema, Type.Null()]) } }),
  operation({ id: "heartbeat", summary: "Publish a leased runtime presence record.", request: Type.Object({ leaseMs: OptionalNumber({ minimum: 1000, maximum: 900000 }), runtimeType: OptionalString(), capabilities: Type.Optional(StringArray) }, { additionalProperties: false }), response: PresenceSchema, scopes: ["presence:write"], providers: DELIVERY_PROVIDERS, mcp: { name: "heartbeat" }, http: { method: "POST", path: "/v2/presence/heartbeat" }, cli: { command: "join", options: ["lease-ms", "runtime", "capability"] } }),
  operation({ id: "presence", summary: "List active agent runtime instances.", request: Empty, response: Type.Object({ agents: Type.Array(PresenceSchema) }, { additionalProperties: true }), scopes: ["presence:read"], providers: DELIVERY_PROVIDERS, mcp: { name: "presence" }, http: { method: "GET", path: "/v2/presence" }, cli: { command: "presence", options: [] } }),
  operation({ id: "sync", summary: "Replay a gateway outbox and refresh its inbox cache.", request: Type.Object({ maxPush: OptionalNumber(), maxPages: OptionalNumber() }, { additionalProperties: false }), response: SyncResponseSchema, scopes: ["messages:write", "messages:read"], providers: GATEWAY_PROVIDER, mcp: { name: "sync" }, cli: { command: "sync", options: ["max-push", "max-pages", "limit"] } }),
];

const byId = new Map(operations.map((entry) => [entry.id, entry]));

export class ContractValidationError extends Error {
  readonly code = "invalid_input";
  readonly status = 400;
  constructor(readonly operation: string, readonly issues: readonly { path: string; message: string }[]) {
    super(`Request does not match the ${operation} schema`);
  }
}

export class ContractResponseError extends Error {
  readonly code = "protocol_mismatch";
  readonly status = 502;
  constructor(readonly operation: string, readonly issues: readonly { path: string; message: string }[]) {
    super(`Response does not match the ${operation} schema`);
  }
}

function issues(schema: TSchema, value: unknown): readonly { path: string; message: string }[] {
  return [...Errors(schema, value)].map((entry) => ({ path: entry.instancePath || "/", message: entry.message }));
}

export function operationContract(operationId: string): OperationContract {
  const contract = byId.get(operationId as OperationId);
  if (!contract) throw new Error(`Unknown operation contract: ${operationId}`);
  return contract;
}

export function validateRequest(operationId: string, value: unknown): Record<string, unknown> {
  const contract = operationContract(operationId);
  if (!Check(contract.request, value)) throw new ContractValidationError(operationId, issues(contract.request, value));
  return value as Record<string, unknown>;
}

export function validateRequestForProtocol(operationId: string, value: unknown, protocolVersion: string): Record<string, unknown> {
  if (protocolVersion === LEGACY_PROTOCOL_VERSION) {
    if (operationId === "publish_message") {
      if (!Check(LegacyMessageDraftSchema, value)) throw new ContractValidationError(operationId, issues(LegacyMessageDraftSchema, value));
      return value as Record<string, unknown>;
    }
    if (["list_deliveries", "list_delivery_events", "cancel_delivery", "requeue_delivery", "capabilities"].includes(operationId)) {
      throw new ContractValidationError(operationId, [{ path: "/", message: `Operation is not supported by protocol ${LEGACY_PROTOCOL_VERSION}` }]);
    }
    if (operationId === "history" && value && typeof value === "object") {
      const unsupported = ["mailbox", "receiptState", "project"].find((field) => (value as Record<string, unknown>)[field] !== undefined);
      if (unsupported) throw new ContractValidationError(operationId, [{ path: `/${unsupported}`, message: `Field is not supported by protocol ${LEGACY_PROTOCOL_VERSION}` }]);
    }
  }
  if (operationId !== "negative_acknowledge_delivery" || protocolVersion !== LEGACY_PROTOCOL_VERSION) {
    return validateRequest(operationId, value);
  }
  if (!Check(LegacyNegativeAcknowledgeRequestSchema, value)) {
    throw new ContractValidationError(operationId, issues(LegacyNegativeAcknowledgeRequestSchema, value));
  }
  return value as Record<string, unknown>;
}

export function parseResponse(operationId: string, value: unknown): unknown {
  const contract = operationContract(operationId);
  const serialized = JSON.stringify(value);
  const wireValue = serialized === undefined ? value : JSON.parse(serialized);
  if (!Check(contract.response, wireValue)) throw new ContractResponseError(operationId, issues(contract.response, wireValue));
  return wireValue;
}

export function parseResponseForProtocol(operationId: string, value: unknown, protocolVersion: string): unknown {
  if (protocolVersion !== LEGACY_PROTOCOL_VERSION) return parseResponse(operationId, value);
  let schema: TSchema | undefined;
  let normalized = value;
  if (operationId === "publish_message") schema = Type.Object({ created: Type.Boolean(), message: LegacyMessageSchema }, { additionalProperties: true });
  else if (operationId === "history") schema = Type.Object({ messages: Type.Array(LegacyMessageSchema), cursor: OptionalString() }, { additionalProperties: true });
  else if (operationId === "claim_delivery") {
    schema = Type.Union([Type.Object({ delivery: LegacyDeliverySchema, leaseToken: Type.String() }, { additionalProperties: true }), Type.Null()]);
    normalized = value === null ? { delivery: null } : value;
  } else if (["extend_delivery", "acknowledge_delivery", "negative_acknowledge_delivery"].includes(operationId)) {
    schema = LegacyDeliverySchema;
    normalized = { delivery: value };
  }
  if (!schema) return parseResponse(operationId, value);
  if (!Check(schema, value)) throw new ContractResponseError(operationId, issues(schema, value));
  return normalized;
}

export function parseCliResponse(
  operationId: string,
  value: unknown,
  invocation?: { command: string; optionNames?: readonly string[] },
): unknown {
  const contract = operationContract(operationId);
  const optionNames = new Set(invocation?.optionNames ?? []);
  const variant = contract.cli?.variants?.find((entry) =>
    entry.command === invocation?.command && cliVariantMatches(entry, optionNames));
  const schema = variant?.response ?? contract.cli?.response ?? contract.response;
  const serialized = JSON.stringify(value);
  const wireValue = serialized === undefined ? value : JSON.parse(serialized);
  if (!Check(schema, wireValue)) throw new ContractResponseError(operationId, issues(schema, wireValue));
  return wireValue;
}

export function availableOperations(context: { surface: ContractSurface; provider: ContractProvider }): readonly OperationContract[] {
  return operations.filter((entry) => entry.providers.includes(context.provider) && Boolean(entry[context.surface]));
}

export function operationForMcp(name: string, provider: ContractProvider): OperationContract | undefined {
  return availableOperations({ surface: "mcp", provider }).find((entry) => entry.mcp?.name === name);
}

export function operationForHttp(method: string, path: string): OperationContract | undefined {
  return availableOperations({ surface: "http", provider: "gateway" }).find((entry) => entry.http?.method === method && entry.http.path === path);
}

function cliVariantMatches(
  variant: CliCompatibilityVariant,
  optionNames: ReadonlySet<string>,
): boolean {
  return variant.condition.kind === "always" || optionNames.has(variant.condition.option);
}

export function operationForCli(
  command: string,
  provider: ContractProvider,
  optionNames: readonly string[] = [],
): OperationContract | undefined {
  const selectedOptions = new Set(optionNames);
  return availableOperations({ surface: "cli", provider }).find((entry) =>
    entry.cli?.command === command ||
    entry.cli?.aliases?.includes(command) ||
    entry.cli?.variants?.some((variant) =>
      variant.command === command && cliVariantMatches(variant, selectedOptions)));
}

export function capabilityDocument(context: { surface: ContractSurface; provider: ContractProvider; selectedProtocolVersion?: string; requestAuthority?: boolean } = { surface: "http", provider: "gateway" }) {
  const selectedProtocolVersion = context.selectedProtocolVersion ?? PROTOCOL_VERSION;
  return {
    protocolVersion: selectedProtocolVersion,
    currentProtocolVersion: PROTOCOL_VERSION,
    selectedProtocolVersion,
    supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    scopeEnforcement: context.provider === "gateway" ? SCOPE_ENFORCEMENT : false,
    requestAuthority: context.provider === "gateway" && context.requestAuthority === true,
    rowIsolation: false,
    authorizationModel: context.provider === "gateway"
      ? "scoped-credential"
      : context.provider === "local"
        ? "process-identity"
        : "legacy-key",
    surface: context.surface,
    provider: context.provider,
    operations: availableOperations(context).map(({ request: _request, response, providers: _providers, scopes, cli, ...entry }) => ({
      ...entry,
      ...(cli ? {
        cli: {
          command: cli.command,
          ...(cli.aliases ? { aliases: cli.aliases } : {}),
          options: cli.options,
          outputSchema: cli.response ?? response,
          ...(cli.variants ? {
            variants: cli.variants.map((variant) => ({
              command: variant.command,
              condition: variant.condition,
              routesTo: variant.routesTo,
              options: variant.options,
              outputSchema: variant.response,
            })),
          } : {}),
        },
      } : {}),
      requiredScopes: [...scopes],
    })),
  };
}

export function negotiateProtocolVersion(value: string | string[] | undefined): string {
  const requested = Array.isArray(value) ? value[0] : value;
  if (requested === undefined || requested.trim() === "") return LEGACY_PROTOCOL_VERSION;
  if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested.trim())) return requested.trim();
  const error = new Error("Unsupported Agent Bridge protocol version") as Error & { status: number; code: string; supported: string };
  error.status = 426;
  error.code = "unsupported_protocol_version";
  error.supported = SUPPORTED_PROTOCOL_RANGE;
  throw error;
}
