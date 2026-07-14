import type { AgentPresence, BridgeDelivery, BridgeDeliveryEvent, BridgeMessage, BridgePrincipal, DeliveryState, RetryPolicy } from "./bridge-domain.js";

export interface InsertMessageResult { message: BridgeMessage; created: boolean; }
export interface MessageQuery {
  cursor?: string;
  limit?: number;
  types?: string[];
  includeExpired?: boolean;
  source?: string;
  since?: string;
  unacknowledgedBy?: string;
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
  oldestAvailableAt?: string;
  principal?: { workspace: string; agent: string };
}
export interface ClaimOptions { leaseMs: number; maxAttempts?: number; now?: Date; }
export interface BridgeStore {
  initialize(options?: { signal?: AbortSignal }): Promise<void>;
  insertMessage(message: Omit<BridgeMessage, "sequence" | "createdAt">, options?: { signal?: AbortSignal }): Promise<InsertMessageResult>;
  listMessages(principal: BridgePrincipal, query?: MessageQuery, options?: { signal?: AbortSignal }): Promise<MessagePage>;
  recordReceipt(workspace: string, messageIds: string[], principal: string, readAt?: Date): Promise<number>;
  recordLegacyReceipt?(legacyIds: string[], principal: string): Promise<number>;
  claimDelivery(principal: BridgePrincipal, options: ClaimOptions): Promise<BridgeDelivery | null>;
  renewDelivery(principal: BridgePrincipal, deliveryId: string, leaseToken: string, leaseMs: number): Promise<BridgeDelivery | null>;
  settleDelivery(principal: BridgePrincipal, deliveryId: string, leaseToken: string, state: Extract<DeliveryState, "acked" | "retrying" | "dead">, error: string | undefined, retryPolicy: RetryPolicy): Promise<BridgeDelivery | null>;
  diagnostics?(principal: BridgePrincipal): Promise<BridgeDiagnostics>;
  heartbeat?(principal: BridgePrincipal, leaseMs: number, runtimeType?: string, capabilities?: string[]): Promise<AgentPresence>;
  listPresence?(principal: BridgePrincipal): Promise<AgentPresence[]>;
  listDeliveryEvents?(deliveryId: string): Promise<BridgeDeliveryEvent[]>;
  sync?(options?: { maxPush?: number; maxPages?: number; signal?: AbortSignal }): Promise<unknown>;
  verifyRemote?(): Promise<void>;
  close?(): Promise<void>;
}
