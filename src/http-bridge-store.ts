import type { AgentPresence, BridgeDelivery, BridgeMessage, BridgePrincipal } from "./bridge-domain.js";
import type { BridgeDiagnostics, BridgeStore, ClaimOptions, InsertMessageResult, MessagePage, MessageQuery } from "./bridge-store.js";
import {
  ContractResponseError,
  parseResponse,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_HEADER,
  SUPPORTED_PROTOCOL_VERSIONS,
  type OperationId,
} from "./contracts/registry.js";

export interface HttpBridgeStoreOptions {
  baseUrl: string;
  token: string;
  principal: BridgePrincipal;
  timeoutMs?: number;
  allowInsecureRemoteHttp?: boolean;
  fetch?: typeof fetch;
}

export class BridgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    readonly details?: unknown,
    message = `Agent Bridge request failed: ${code}`,
  ) {
    super(message);
  }
}

export class HttpBridgeStore implements BridgeStore {
  private readonly fetchImpl: typeof fetch;
  private readonly closeController = new AbortController();
  private closed = false;
  private selectedProtocolVersion?: string;
  private protocolProbe?: Promise<string>;
  constructor(private readonly options: HttpBridgeStoreOptions) {
    const url = new URL(options.baseUrl);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback) && !options.allowInsecureRemoteHttp) {
      throw new Error("Agent Bridge requires HTTPS for non-loopback gateways");
    }
    this.fetchImpl = options.fetch ?? fetch;
  }
  async initialize(options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.request(undefined, "/readyz", { authenticated: false, signal: options.signal });
    const status = await this.request("status", "/v2/status", { signal: options.signal });
    this.assertBoundPrincipal(status);
  }

  private assertBoundPrincipal(status: any): void {
    const principal = status?.principal;
    if (
      !principal ||
      principal.workspace !== this.options.principal.workspace ||
      principal.agent !== this.options.principal.agent
    ) {
      throw new BridgeHttpError(403, "principal_mismatch");
    }
  }

  private async request(operationId: OperationId | undefined, path: string, options: { method?: string; body?: unknown; authenticated?: boolean; signal?: AbortSignal; skipProtocolProbe?: boolean } = {}): Promise<any> {
    if (options.method === "POST" && !options.skipProtocolProbe) await this.ensureProtocol(options.signal);
    if (this.closed) throw new BridgeHttpError(0, "store_closed");
    if (options.signal?.aborted) throw new BridgeHttpError(0, "request_cancelled");
    const requestController = new AbortController();
    const abort = () => requestController.abort(this.closeController.signal.reason);
    const abortRequest = () => requestController.abort(options.signal?.reason);
    this.closeController.signal.addEventListener("abort", abort, { once: true });
    options.signal?.addEventListener("abort", abortRequest, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      requestController.abort(new Error("request timeout"));
    }, this.options.timeoutMs ?? 10_000);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}${path}`, {
        method: options.method ?? "GET", signal: requestController.signal,
        headers: {
          [PROTOCOL_HEADER]: this.selectedProtocolVersion ?? PROTOCOL_VERSION,
          ...(options.authenticated === false ? {} : { authorization: `Bearer ${this.options.token}` }),
          ...(this.options.principal.instance ? { "x-agent-bridge-instance": this.options.principal.instance } : {}),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const requestId = response.headers.get("x-request-id") ?? undefined;
      const selectedHeader = response.headers.get(PROTOCOL_HEADER);
      const supportedHeader = response.headers.get(SUPPORTED_PROTOCOL_HEADER);
      const supportedProtocols = supportedHeader?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
      const inconsistentProtocol = (
        selectedHeader === null || supportedHeader === null ||
        !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(selectedHeader) ||
        !supportedProtocols.includes(selectedHeader) ||
        selectedHeader !== PROTOCOL_VERSION
      );
      if (operationId && inconsistentProtocol) {
        throw new BridgeHttpError(502, "protocol_mismatch", requestId, {
          expected: PROTOCOL_VERSION,
          selected: selectedHeader,
          supported: supportedHeader,
        });
      }
      const contentType = response.headers.get("content-type") ?? "";
      const payload = contentType.startsWith("application/json")
        ? await response.json().catch(() => ({}))
        : await response.text();
      if (!response.ok) {
        const envelope = payload && typeof payload === "object" ? (payload as any).error : undefined;
        throw new BridgeHttpError(
          response.status,
          envelope?.code ?? "request_failed",
          envelope?.requestId ?? requestId,
          envelope?.details ?? envelope,
          envelope?.message ?? `Agent Bridge request failed: ${envelope?.code ?? "request_failed"}`,
        );
      }
      if (operationId) this.selectedProtocolVersion = PROTOCOL_VERSION;
      if (!operationId) return payload;
      return parseResponse(operationId, payload);
    } catch (error) {
      if (error instanceof BridgeHttpError) throw error;
      if (error instanceof ContractResponseError) {
        throw new BridgeHttpError(error.status, error.code, undefined, {
          operation: error.operation,
          issues: error.issues,
        }, error.message);
      }
      if (this.closed) throw new BridgeHttpError(0, "store_closed");
      if (options.signal?.aborted) throw new BridgeHttpError(0, "request_cancelled");
      if (timedOut) throw new BridgeHttpError(504, "request_timeout");
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new BridgeHttpError(504, "request_timeout");
      }
      throw new BridgeHttpError(0, "network_error");
    } finally {
      clearTimeout(timeout);
      this.closeController.signal.removeEventListener("abort", abort);
      options.signal?.removeEventListener("abort", abortRequest);
    }
  }

  private ensureProtocol(signal?: AbortSignal): Promise<string> {
    if (this.selectedProtocolVersion) return Promise.resolve(this.selectedProtocolVersion);
    if (!this.protocolProbe) {
      this.protocolProbe = this.request("status", "/v2/status", { signal, skipProtocolProbe: true })
        .then(() => this.selectedProtocolVersion!)
        .finally(() => { this.protocolProbe = undefined; });
    }
    return this.protocolProbe;
  }
  async capabilities(): Promise<unknown> { return this.request("capabilities", "/v2/capabilities"); }

  private assertPrincipal(principal: BridgePrincipal, includeInstance = true): void {
    const expected = this.options.principal;
    if (
      principal.workspace !== expected.workspace ||
      principal.agent !== expected.agent ||
      (includeInstance && principal.instance !== expected.instance)
    ) {
      throw new BridgeHttpError(403, "principal_mismatch");
    }
  }

  async insertMessage(message: Omit<BridgeMessage, "sequence" | "createdAt">, options: { signal?: AbortSignal } = {}): Promise<InsertMessageResult> {
    this.assertPrincipal({ workspace: message.workspace, agent: message.source }, false);
    await this.ensureProtocol(options.signal);
    const { workspace: _workspace, source: _source, ...draft } = message;
    return this.request("publish_message", "/v2/messages", { method: "POST", body: draft, signal: options.signal });
  }
  async listMessages(principal: BridgePrincipal, query: MessageQuery = {}, options: { signal?: AbortSignal } = {}): Promise<MessagePage> {
    this.assertPrincipal(principal);
    const requestQuery = query;
    const params = new URLSearchParams();
    if (requestQuery.cursor) params.set("cursor", requestQuery.cursor);
    if (requestQuery.mailbox) params.set("mailbox", requestQuery.mailbox);
    if (requestQuery.receiptState) params.set("receiptState", requestQuery.receiptState);
    if (requestQuery.limit) params.set("limit", String(requestQuery.limit));
    if (requestQuery.includeExpired) params.set("includeExpired", "true");
    if (requestQuery.source) params.set("source", requestQuery.source);
    if (requestQuery.project) params.set("project", requestQuery.project);
    if (requestQuery.since) params.set("since", requestQuery.since);
    if (requestQuery.threadId) params.set("threadId", requestQuery.threadId);
    if (requestQuery.latest) params.set("latest", "true");
    for (const type of requestQuery.types ?? []) params.append("type", type);
    return this.request("history", `/v2/history${params.size ? `?${params}` : ""}`, { signal: options.signal });
  }
  async recordReceipt(principal: BridgePrincipal, ids: string[]): Promise<number> {
    this.assertPrincipal(principal, false);
    return (await this.request("record_receipt", "/v2/receipts", { method: "POST", body: { messageIds: ids } })).recorded;
  }
  async diagnostics(principal: BridgePrincipal): Promise<BridgeDiagnostics> {
    this.assertPrincipal(principal);
    const status = await this.request("status", "/v2/status");
    this.assertBoundPrincipal(status);
    return status;
  }
  async claimDelivery(principal: BridgePrincipal, options: ClaimOptions): Promise<BridgeDelivery | null> {
    this.assertPrincipal(principal);
    return (await this.request("claim_delivery", "/v2/deliveries/claim", { method: "POST", body: options }))?.delivery ?? null;
  }
  async listDeliveries(principal: BridgePrincipal, query: import("./bridge-store.js").DeliveryQuery = {}) {
    this.assertPrincipal(principal); const params=new URLSearchParams(); if(query.cursor)params.set("cursor",query.cursor);if(query.limit)params.set("limit",String(query.limit));if(query.role)params.set("role",query.role);if(query.messageId)params.set("messageId",query.messageId);if(query.recipient)params.set("recipient",query.recipient);for(const state of query.states??[])params.append("state",state);return this.request("list_deliveries",`/v2/deliveries${params.size?`?${params}`:""}`);
  }
  async listDeliveryEvents(principal: BridgePrincipal,id:string,query:{cursor?:string;limit?:number}={}) { this.assertPrincipal(principal);const params=new URLSearchParams();if(query.cursor)params.set("cursor",query.cursor);if(query.limit)params.set("limit",String(query.limit));return this.request("list_delivery_events",`/v2/deliveries/${id}/events${params.size?`?${params}`:""}`); }
  async cancelDelivery(principal:BridgePrincipal,id:string){this.assertPrincipal(principal);return (await this.request("cancel_delivery",`/v2/deliveries/${id}/cancel`,{method:"POST",body:{}})).delivery;}
  async requeueDelivery(principal:BridgePrincipal,id:string){this.assertPrincipal(principal);return (await this.request("requeue_delivery",`/v2/deliveries/${id}/requeue`,{method:"POST",body:{}})).delivery;}
  async renewDelivery(principal: BridgePrincipal, id: string, token: string, leaseMs: number): Promise<BridgeDelivery | null> {
    this.assertPrincipal(principal);
    try {
      return (await this.request("extend_delivery", `/v2/deliveries/${id}/extend`, { method: "POST", body: { leaseToken: token, leaseMs } })).delivery;
    } catch (error) {
      if (error instanceof BridgeHttpError && error.status === 409) return null;
      throw error;
    }
  }
  async settleDelivery(principal: BridgePrincipal, id: string, token: string, state: "acked" | "retrying" | "dead", error?: string, _retryPolicy?: import("./bridge-domain.js").RetryPolicy): Promise<BridgeDelivery | null> {
    this.assertPrincipal(principal);
    await this.ensureProtocol();
    const action = state === "acked" ? "ack" : "nack";
    try {
      const operationId = action === "ack" ? "acknowledge_delivery" : "negative_acknowledge_delivery";
      const nackBody = { leaseToken: token, error, disposition: state === "dead" ? "dead" : "retry" };
      return (await this.request(operationId, `/v2/deliveries/${id}/${action}`, { method: "POST", body: action === "ack" ? { leaseToken: token } : nackBody })).delivery;
    } catch (caught) {
      if (caught instanceof BridgeHttpError && caught.status === 409) return null;
      throw caught;
    }
  }
  async heartbeat(principal: BridgePrincipal, leaseMs: number, runtimeType?: string, capabilities: string[] = []): Promise<AgentPresence> {
    this.assertPrincipal(principal);
    return this.request("heartbeat", "/v2/presence/heartbeat", { method: "POST", body: { leaseMs, runtimeType, capabilities } });
  }
  async listPresence(principal: BridgePrincipal): Promise<AgentPresence[]> {
    this.assertPrincipal(principal);
    return (await this.request("presence", "/v2/presence")).agents;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort(new Error("store closed"));
  }
}
