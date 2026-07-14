import type { AgentPresence, BridgeDelivery, BridgeMessage, BridgePrincipal, RetryPolicy } from "./bridge-domain.js";
import type { BridgeDiagnostics, BridgeStore, ClaimOptions, InsertMessageResult, MessagePage, MessageQuery } from "./bridge-store.js";

export interface HttpBridgeStoreOptions {
  baseUrl: string;
  token: string;
  principal: BridgePrincipal;
  timeoutMs?: number;
  allowInsecureRemoteHttp?: boolean;
  fetch?: typeof fetch;
}

export class BridgeHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Agent Bridge request failed: ${code}`); }
}

export class HttpBridgeStore implements BridgeStore {
  private readonly fetchImpl: typeof fetch;
  private readonly closeController = new AbortController();
  private closed = false;
  constructor(private readonly options: HttpBridgeStoreOptions) {
    const url = new URL(options.baseUrl);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback) && !options.allowInsecureRemoteHttp) {
      throw new Error("Agent Bridge requires HTTPS for non-loopback gateways");
    }
    this.fetchImpl = options.fetch ?? fetch;
  }
  async initialize(options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.request("/readyz", { authenticated: false, signal: options.signal });
    const status = await this.request("/v2/status", { signal: options.signal });
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

  private async request(path: string, options: { method?: string; body?: unknown; authenticated?: boolean; signal?: AbortSignal } = {}): Promise<any> {
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
          ...(options.authenticated === false ? {} : { authorization: `Bearer ${this.options.token}` }),
          ...(this.options.principal.instance ? { "x-agent-bridge-instance": this.options.principal.instance } : {}),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new BridgeHttpError(response.status, payload?.error?.code ?? "request_failed");
      return payload;
    } catch (error) {
      if (error instanceof BridgeHttpError) throw error;
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
    const { workspace: _workspace, source: _source, ...draft } = message;
    return this.request("/v2/messages", { method: "POST", body: draft, signal: options.signal });
  }
  async listMessages(principal: BridgePrincipal, query: MessageQuery = {}, options: { signal?: AbortSignal } = {}): Promise<MessagePage> {
    this.assertPrincipal(principal);
    const params = new URLSearchParams();
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit) params.set("limit", String(query.limit));
    if (query.includeExpired) params.set("includeExpired", "true");
    if (query.source) params.set("source", query.source);
    if (query.since) params.set("since", query.since);
    if (query.unacknowledgedBy) params.set("unacknowledgedBy", query.unacknowledgedBy);
    if (query.threadId) params.set("threadId", query.threadId);
    if (query.latest) params.set("latest", "true");
    for (const type of query.types ?? []) params.append("type", type);
    return this.request(`/v2/history${params.size ? `?${params}` : ""}`, { signal: options.signal });
  }
  async recordReceipt(workspace: string, ids: string[], principal: string): Promise<number> {
    this.assertPrincipal({ workspace, agent: principal }, false);
    return (await this.request("/v2/receipts", { method: "POST", body: { messageIds: ids } })).recorded;
  }
  async diagnostics(principal: BridgePrincipal): Promise<BridgeDiagnostics> {
    this.assertPrincipal(principal);
    const status = await this.request("/v2/status");
    this.assertBoundPrincipal(status);
    return status;
  }
  async claimDelivery(principal: BridgePrincipal, options: ClaimOptions): Promise<BridgeDelivery | null> {
    this.assertPrincipal(principal);
    return (await this.request("/v2/deliveries/claim", { method: "POST", body: options }))?.delivery ?? null;
  }
  async renewDelivery(principal: BridgePrincipal, id: string, token: string, leaseMs: number): Promise<BridgeDelivery | null> {
    this.assertPrincipal(principal);
    try {
      return await this.request(`/v2/deliveries/${id}/extend`, { method: "POST", body: { leaseToken: token, leaseMs } });
    } catch (error) {
      if (error instanceof BridgeHttpError && error.status === 409) return null;
      throw error;
    }
  }
  async settleDelivery(principal: BridgePrincipal, id: string, token: string, state: "acked" | "retrying" | "dead", error: string | undefined, retryPolicy: RetryPolicy): Promise<BridgeDelivery | null> {
    this.assertPrincipal(principal);
    const action = state === "acked" ? "ack" : "nack";
    try {
      return await this.request(`/v2/deliveries/${id}/${action}`, { method: "POST", body: { leaseToken: token, error, dead: state === "dead", retryPolicy } });
    } catch (caught) {
      if (caught instanceof BridgeHttpError && caught.status === 409) return null;
      throw caught;
    }
  }
  async heartbeat(principal: BridgePrincipal, leaseMs: number, runtimeType?: string, capabilities: string[] = []): Promise<AgentPresence> {
    this.assertPrincipal(principal);
    return this.request("/v2/presence/heartbeat", { method: "POST", body: { leaseMs, runtimeType, capabilities } });
  }
  async listPresence(principal: BridgePrincipal): Promise<AgentPresence[]> {
    this.assertPrincipal(principal);
    return (await this.request("/v2/presence")).agents;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort(new Error("store closed"));
  }
}
