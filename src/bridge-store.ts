import type { AgentPresence, BridgeDelivery, BridgeDeliveryEvent, BridgeMessage, BridgePrincipal, DeliveryState, RetryPolicy } from "./bridge-domain.js";

export interface InsertMessageResult { message: BridgeMessage; created: boolean; }
export interface MessageQuery {
  mailbox?: "inbox" | "sent" | "all";
  receiptState?: "any" | "unread" | "read";
  project?: string;
  cursor?: string;
  limit?: number;
  types?: string[];
  includeExpired?: boolean;
  source?: string;
  since?: string;
  threadId?: string;
  latest?: boolean;
}
export interface MessagePage { messages: BridgeMessage[]; cursor?: string; }
export interface BridgeDiagnostics {
  schemaVersion: "local-v2" | "postgres-v2" | "legacy-v1";
  deliverySupported: boolean;
  pending: number | null;
  claimed: number | null;
  retrying: number | null;
  dead: number | null;
  cancelled?: number | null;
  oldestAvailableAt?: string;
  due?: number | null;
  scheduled?: number | null;
  expiredLeases?: number | null;
  oldestDueAt?: string;
  queueLagMs?: number | null;
  gatewayAuthorityId?: string;
  credentialId?: string;
  principal?: { workspace: string; agent: string };
}
export interface ClaimOptions {
  leaseMs: number;
  messageId?: string;
  now?: Date;
  maxAttempts?: number;
}
export interface DeliveryQuery {
  role?: "recipient" | "publisher" | "all";
  states?: DeliveryState[];
  messageId?: string;
  recipient?: string;
  cursor?: string;
  limit?: number;
}
export interface DeliveryPage { deliveries: BridgeDelivery[]; cursor?: string; }
export interface DeliveryEventPage { events: BridgeDeliveryEvent[]; cursor?: string; }
export interface BridgeStore {
  initialize(options?: { signal?: AbortSignal; mode?: "active" | "passive" }): Promise<void>;
  insertMessage(message: Omit<BridgeMessage, "sequence" | "createdAt">, options?: { signal?: AbortSignal }): Promise<InsertMessageResult>;
  enqueueMessage?(message: Omit<BridgeMessage, "sequence" | "createdAt">): Promise<InsertMessageResult & { disposition: "queued"; authoritative: false }>;
  listMessages(principal: BridgePrincipal, query?: MessageQuery, options?: { signal?: AbortSignal }): Promise<MessagePage>;
  recordReceipt(principal: BridgePrincipal, messageIds: string[], readAt?: Date): Promise<number>;
  recordLegacyReceipt?(legacyIds: string[], principal: string): Promise<number>;
  claimDelivery(principal: BridgePrincipal, options: ClaimOptions): Promise<BridgeDelivery | null>;
  renewDelivery(principal: BridgePrincipal, deliveryId: string, leaseToken: string, leaseMs: number): Promise<BridgeDelivery | null>;
  settleDelivery(principal: BridgePrincipal, deliveryId: string, leaseToken: string, state: Extract<DeliveryState, "acked" | "retrying" | "dead">, error?: string, retryPolicy?: RetryPolicy): Promise<BridgeDelivery | null>;
  listDeliveries?(principal: BridgePrincipal, query?: DeliveryQuery): Promise<DeliveryPage>;
  listDeliveryEvents?(principal: BridgePrincipal, deliveryId: string, query?: { cursor?: string; limit?: number }): Promise<DeliveryEventPage>;
  cancelDelivery?(principal: BridgePrincipal, deliveryId: string): Promise<BridgeDelivery | null>;
  requeueDelivery?(principal: BridgePrincipal, deliveryId: string): Promise<BridgeDelivery | null>;
  diagnostics?(principal: BridgePrincipal, options?: { mode?: "snapshot" | "probe" }): Promise<BridgeDiagnostics>;
  heartbeat?(principal: BridgePrincipal, leaseMs: number, runtimeType?: string, capabilities?: string[]): Promise<AgentPresence>;
  listPresence?(principal: BridgePrincipal): Promise<AgentPresence[]>;
  sync?(options?: { maxPush?: number; maxPages?: number; signal?: AbortSignal }): Promise<unknown>;
  verifyRemote?(): Promise<void>;
  capabilities?(): Promise<unknown>;
  close?(): Promise<void>;
}
