import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createGateway } from "../src/gateway.js";
import { SQLiteBridgeStore } from "../src/sqlite-bridge-store.js";
import {
  AUTHORIZATION_SCOPES,
  type AuthorizationScope,
  type OperationId,
} from "../src/contracts/registry.js";
import type { GatewaySecurity, RateLimitDecision } from "../src/gateway-security.js";

const servers: ReturnType<typeof createGateway>[] = [];
const stores: SQLiteBridgeStore[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

const allowed: RateLimitDecision = {
  allowed: true,
  policyId: null,
  limit: 10,
  remaining: 9,
  retryAfterSeconds: 0,
};

async function start(
  scopes: readonly AuthorizationScope[] | undefined,
  security: GatewaySecurity,
): Promise<string> {
  const store = new SQLiteBridgeStore();
  await store.initialize();
  stores.push(store);
  const server = createGateway({
    store,
    credentials: { resolve: async () => ({
      id: "00000000-0000-4000-8000-000000000001",
      principal: { workspace: "workspace-a", agent: "agent-a" },
      scopes: scopes!,
    }) },
    security,
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function security(options: {
  audit?: (operation: OperationId) => Promise<void>;
  consume?: (operation: OperationId) => RateLimitDecision | Promise<RateLimitDecision>;
} = {}): GatewaySecurity {
  return {
    recordScopeDenial: async (_credential, operation) => {
      await options.audit?.(operation);
    },
    consume: async (_credential, operation) =>
      await options.consume?.(operation) ?? allowed,
  };
}

const currentHeaders = {
  authorization: "Bearer scoped-token",
  "x-agent-bridge-protocol-version": "2.1",
};

describe("gateway credential security", () => {
  it("requires an active credential but no named scope for capabilities", async () => {
    const operations: OperationId[] = [];
    const base = await start([], security({ consume: (operation) => {
      operations.push(operation);
      return allowed;
    } }));
    const response = await fetch(`${base}/v2/capabilities`, { headers: currentHeaders });
    expect(response.status).toBe(200);
    expect(operations).toEqual(["capabilities"]);
  });

  it("fails closed when a resolver omits its required scope set", async () => {
    const base = await start(undefined, security());
    const response = await fetch(`${base}/v2/history`, { headers: currentHeaders });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "security_unavailable" } });
  });

  it("enforces every gateway route through the canonical operation scope", async () => {
    const audited: OperationId[] = [];
    const consumed: OperationId[] = [];
    const base = await start([], security({
      audit: async (operation) => { audited.push(operation); },
      consume: (operation) => { consumed.push(operation); return allowed; },
    }));
    const routes: Array<{ operation: OperationId; method: "GET" | "POST"; path: string }> = [
      { operation: "status", method: "GET", path: "/v2/status" },
      { operation: "gateway_metrics", method: "GET", path: "/metrics" },
      { operation: "publish_message", method: "POST", path: "/v2/messages" },
      { operation: "history", method: "GET", path: "/v2/history" },
      { operation: "record_receipt", method: "POST", path: "/v2/receipts" },
      { operation: "claim_delivery", method: "POST", path: "/v2/deliveries/claim" },
      { operation: "list_deliveries", method: "GET", path: "/v2/deliveries" },
      { operation: "list_delivery_events", method: "GET", path: "/v2/deliveries/00000000-0000-4000-8000-000000000002/events" },
      { operation: "cancel_delivery", method: "POST", path: "/v2/deliveries/00000000-0000-4000-8000-000000000002/cancel" },
      { operation: "requeue_delivery", method: "POST", path: "/v2/deliveries/00000000-0000-4000-8000-000000000002/requeue" },
      { operation: "extend_delivery", method: "POST", path: "/v2/deliveries/00000000-0000-4000-8000-000000000002/extend" },
      { operation: "acknowledge_delivery", method: "POST", path: "/v2/deliveries/00000000-0000-4000-8000-000000000002/ack" },
      { operation: "negative_acknowledge_delivery", method: "POST", path: "/v2/deliveries/00000000-0000-4000-8000-000000000002/nack" },
      { operation: "heartbeat", method: "POST", path: "/v2/presence/heartbeat" },
      { operation: "presence", method: "GET", path: "/v2/presence" },
    ];
    for (const route of routes) {
      const response = await fetch(`${base}${route.path}`, {
        method: route.method,
        headers: currentHeaders,
      });
      expect(response.status, route.operation).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "insufficient_scope" },
      });
    }
    expect(audited).toEqual(routes.map((route) => route.operation));
    expect(consumed).toEqual([]);
  });

  it("returns scope details without exposing granted scopes or credential data", async () => {
    const base = await start(["messages:write"], security());
    const response = await fetch(`${base}/v2/history`, { headers: currentHeaders });
    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload).toMatchObject({
      error: { code: "insufficient_scope", details: { requiredScopes: ["messages:read"] } },
    });
    expect(JSON.stringify(payload)).not.toContain("messages:write");
    expect(JSON.stringify(payload)).not.toContain("00000000-0000-4000-8000-000000000001");
  });

  it("returns 503 when a scope denial cannot be audited", async () => {
    const base = await start([], security({ audit: async () => { throw new Error("audit unavailable"); } }));
    const response = await fetch(`${base}/v2/history`, { headers: currentHeaders });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "security_unavailable" } });
  });

  it("returns 503 when rate policy state is unavailable", async () => {
    const base = await start(["messages:read"], security({
      consume: async () => { throw new Error("policy unavailable"); },
    }));
    const response = await fetch(`${base}/v2/history`, { headers: currentHeaders });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "security_unavailable" } });
  });

  it("returns Retry-After and a stable rate_limited error", async () => {
    const base = await start(["messages:read"], security({ consume: () => ({
      allowed: false,
      policyId: "operation:history",
      limit: 10,
      remaining: 0,
      retryAfterSeconds: 2.2,
    }) }));
    const response = await fetch(`${base}/v2/history`, { headers: currentHeaders });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.json()).toMatchObject({
      error: { code: "rate_limited", details: { retryAfterSeconds: 3 } },
    });
  });

  it("checks scope and rate limits before media type or body parsing", async () => {
    const underScoped = await start([], security());
    for (const request of [
      { headers: { ...currentHeaders, "content-type": "text/plain" }, body: "not-json" },
      { headers: { ...currentHeaders, "content-type": "application/json" }, body: "x".repeat(256 * 1024) },
    ]) {
      const response = await fetch(`${underScoped}/v2/messages`, {
        method: "POST",
        headers: request.headers,
        body: request.body,
      });
      expect(response.status).toBe(403);
    }

    const rateLimited = await start(AUTHORIZATION_SCOPES, security({ consume: () => ({
      allowed: false,
      policyId: "global",
      limit: 1,
      remaining: 0,
      retryAfterSeconds: 1,
    }) }));
    const response = await fetch(`${rateLimited}/v2/messages`, {
      method: "POST",
      headers: { ...currentHeaders, "content-type": "text/plain" },
      body: "not-json",
    });
    expect(response.status).toBe(429);
  });

  it("enforces scopes for headerless 2.0 and gates 2.1-only routes first", async () => {
    const audited: OperationId[] = [];
    const consumed: OperationId[] = [];
    const base = await start([], security({
      audit: async (operation) => { audited.push(operation); },
      consume: (operation) => { consumed.push(operation); return allowed; },
    }));
    const legacyHistory = await fetch(`${base}/v2/history`, {
      headers: { authorization: "Bearer scoped-token" },
    });
    expect(legacyHistory.status).toBe(403);
    const legacyCapabilities = await fetch(`${base}/v2/capabilities`, {
      headers: { authorization: "Bearer scoped-token" },
    });
    expect(legacyCapabilities.status).toBe(404);
    expect(audited).toEqual(["history"]);
    expect(consumed).toEqual([]);
  });
});
