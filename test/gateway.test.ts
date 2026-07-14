import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteBridgeStore } from "../src/sqlite-bridge-store.js";
import { BridgeService } from "../src/bridge-service.js";
import { createGateway } from "../src/gateway.js";
import type { CredentialResolver } from "../src/gateway-auth.js";
import { BridgeHttpError, HttpBridgeStore } from "../src/http-bridge-store.js";
import { installClient } from "../src/client-installer.js";
import { resolveClientConfig } from "../src/client-config.js";

const servers: Array<ReturnType<typeof createGateway>> = [];
const stores: SQLiteBridgeStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function gateway(
  resolver?: CredentialResolver,
  options: Record<string, unknown> = {},
  storeOverride?: SQLiteBridgeStore,
) {
  const store = storeOverride ?? new SQLiteBridgeStore();
  await store.initialize(); stores.push(store);
  const credentials = resolver ?? { resolve: async (token: string) => token === "good" ? {
    id: "credential", principal: { workspace: "workspace-a", agent: "agent-a" },
  } : null };
  const server = createGateway({ store, credentials, ...options });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function auth(token = "good") { return { authorization: `Bearer ${token}`, "content-type": "application/json", "x-agent-bridge-protocol-version": "2.1" }; }

describe("authenticated v2 gateway", () => {
  it("preserves HTTP error metadata and classifies protocol failures", async () => {
    const principal = { workspace: "workspace-a", agent: "agent-a" };
    const protocolHeaders = {
      "content-type": "application/json",
      "x-agent-bridge-protocol-version": "2.1",
      "x-agent-bridge-supported-protocol-versions": "2.0,2.1",
    };
    const rejected = new HttpBridgeStore({
      baseUrl: "https://bridge.example.test",
      token: "token",
      principal,
      fetch: async () => Response.json({
        error: { code: "invalid_input", requestId: "request-one", details: { field: "type" } },
      }, { status: 400, headers: protocolHeaders }),
    });
    await expect(rejected.capabilities()).rejects.toMatchObject({
      status: 400,
      code: "invalid_input",
      requestId: "request-one",
      details: { field: "type" },
    });

    const incompatible = new HttpBridgeStore({
      baseUrl: "https://bridge.example.test",
      token: "token",
      principal,
      fetch: async () => Response.json({}, { headers: {
        ...protocolHeaders,
        "x-agent-bridge-protocol-version": "2.7",
      } }),
    });
    await expect(incompatible.capabilities()).rejects.toMatchObject({
      status: 502,
      code: "protocol_mismatch",
    });

    const invalidSuccess = new HttpBridgeStore({
      baseUrl: "https://bridge.example.test",
      token: "token",
      principal,
      fetch: async () => Response.json({}, { headers: protocolHeaders }),
    });
    await expect(invalidSuccess.capabilities()).rejects.toMatchObject({
      status: 502,
      code: "protocol_mismatch",
      details: { operation: "capabilities" },
    });

    for (const headers of [
      { "content-type": "application/json", "x-agent-bridge-protocol-version": "2.1" },
      { "content-type": "application/json", "x-agent-bridge-supported-protocol-versions": "2.0,2.1" },
      { ...protocolHeaders, "x-agent-bridge-protocol-version": "2.0" },
    ]) {
      const partial = new HttpBridgeStore({
        baseUrl: "https://bridge.example.test",
        token: "token",
        principal,
        fetch: async () => Response.json({}, { headers }),
      });
      await expect(partial.capabilities()).rejects.toMatchObject({ status: 502, code: "protocol_mismatch" });
    }
  });

  it("rejects headerless and explicit 2.0 gateways before mutation", async () => {
    const principal = { workspace: "workspace-a", agent: "sender" };
    const baseMessage = {
      id: "00000000-0000-7000-8000-000000000001", workspace: principal.workspace,
      source: principal.agent, type: "note", content: "safe", contentType: "text/plain",
      targets: [], priority: "info" as const, deliveryPolicy: { mode: "mailbox" as const },
    };

    for (const { headers, selected } of [
      { headers: undefined, selected: null },
      {
        headers: {
          "content-type": "application/json",
          "x-agent-bridge-protocol-version": "2.0",
          "x-agent-bridge-supported-protocol-versions": "2.0,2.1",
        },
        selected: "2.0",
      },
    ]) {
      const calls: string[] = [];
      const store = new HttpBridgeStore({
        baseUrl: "https://bridge.example.test", token: "token", principal,
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          calls.push(`${init?.method ?? "GET"} ${path}`);
          if (!path.endsWith("/status")) throw new Error(`unexpected mutation ${path}`);
          return Response.json({
            schemaVersion: "postgres-v2", deliverySupported: true,
            pending: 0, claimed: 0, retrying: 0, dead: 0, principal,
          }, { headers });
        },
      });

      await expect(store.insertMessage(baseMessage)).rejects.toMatchObject({
        status: 502,
        code: "protocol_mismatch",
        details: { expected: "2.1", selected },
      });
      expect(calls).toEqual(["GET /v2/status"]);
    }
  });

  it("probes a complete 2.1 gateway once before mutations", async () => {
    const principal = { workspace: "workspace-a", agent: "sender" };
    const calls: string[] = [];
    const drafts: Array<Record<string, unknown>> = [];
    const responseHeaders = {
      "content-type": "application/json",
      "x-agent-bridge-protocol-version": "2.1",
      "x-agent-bridge-supported-protocol-versions": "2.0,2.1",
    };
    const store = new HttpBridgeStore({
      baseUrl: "https://bridge.example.test", token: "token", principal,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path.endsWith("/status")) return Response.json({
          schemaVersion: "postgres-v2", deliverySupported: true,
          pending: 0, claimed: 0, retrying: 0, dead: 0, principal,
        }, { headers: responseHeaders });
        if (path.endsWith("/messages")) {
          const draft = JSON.parse(String(init?.body)) as Record<string, unknown>;
          drafts.push(draft);
          return Response.json({ created: true, message: {
            ...draft, workspace: principal.workspace, source: principal.agent,
            contentType: "text/plain", targets: [], priority: "info", sequence: "1",
            createdAt: "2026-07-08T00:00:00.000Z",
          } }, { headers: responseHeaders });
        }
        throw new Error(`unexpected ${path}`);
      },
    });
    const baseMessage = {
      id: "00000000-0000-7000-8000-000000000001", workspace: principal.workspace,
      source: principal.agent, type: "note", content: "safe", contentType: "text/plain",
      targets: [], priority: "info" as const, deliveryPolicy: { mode: "mailbox" as const },
    };

    await store.insertMessage(baseMessage);
    await store.insertMessage({
      ...baseMessage,
      id: "00000000-0000-7000-8000-000000000002",
      project: "current-contract",
    });

    expect(calls).toEqual(["GET /v2/status", "POST /v2/messages", "POST /v2/messages"]);
    expect(drafts).toMatchObject([
      { deliveryPolicy: { mode: "mailbox" } },
      { deliveryPolicy: { mode: "mailbox" }, project: "current-contract" },
    ]);
  });

  it("discovers capabilities and negotiates protocol versions", async () => {
    const base = await gateway();
    const capabilities = await fetch(`${base}/v2/capabilities`, { headers: auth() });
    expect(capabilities.status).toBe(200);
    expect(capabilities.headers.get("x-agent-bridge-protocol-version")).toBe("2.1");
    expect(capabilities.headers.get("x-agent-bridge-supported-protocol-versions")).toBe("2.0,2.1");
    expect(await capabilities.json()).toMatchObject({ protocolVersion: "2.1", supportedProtocolVersions: ["2.0", "2.1"], scopeEnforcement: false });

    const legacy = await fetch(`${base}/v2/capabilities`, { headers: { authorization: "Bearer good" } });
    expect(legacy.status).toBe(404);
    expect(legacy.headers.get("x-agent-bridge-protocol-version")).toBe("2.0");
    expect(await legacy.json()).toMatchObject({ error: { code: "not_found" } });

    const incompatible = await fetch(`${base}/v2/history`, { headers: { ...auth(), "x-agent-bridge-protocol-version": "3.0" } });
    expect(incompatible.status).toBe(426);
    expect(await incompatible.json()).toMatchObject({ error: { code: "unsupported_protocol_version", supportedProtocolVersions: ["2.0", "2.1"] } });
  });

  it("returns 404 for 2.1-only routes selected as 2.0", async () => {
    const base = await gateway();
    const routes = [
      { method: "GET", path: "/v2/capabilities" },
      { method: "GET", path: "/v2/deliveries" },
      { method: "GET", path: "/v2/deliveries/delivery-one/events" },
      { method: "POST", path: "/v2/deliveries/delivery-one/cancel" },
      { method: "POST", path: "/v2/deliveries/delivery-one/requeue" },
    ];
    const legacyHeaders = [
      { authorization: "Bearer good", "content-type": "application/json" },
      {
        authorization: "Bearer good",
        "content-type": "application/json",
        "x-agent-bridge-protocol-version": "2.0",
      },
    ];

    for (const headers of legacyHeaders) {
      for (const route of routes) {
        const response = await fetch(`${base}${route.path}`, {
          method: route.method,
          headers,
          body: route.method === "POST" ? "{}" : undefined,
        });
        expect(response.status).toBe(404);
        expect(response.headers.get("x-agent-bridge-protocol-version")).toBe("2.0");
        expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
      }
    }
  });

  it("rejects unknown request properties with a stable schema error", async () => {
    const base = await gateway();
    const response = await fetch(`${base}/v2/messages`, { method: "POST", headers: auth(), body: JSON.stringify({ type: "note", content: "hello", surprise: true }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_input", operation: "publish_message" } });
  });

  it("rejects non-boolean query values", async () => {
    const base = await gateway();
    for (const query of ["includeExpired=banana", "latest=banana"]) {
      const response = await fetch(`${base}/v2/history?${query}`, { headers: auth() });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_input" } });
    }
  });
  it("checks the source assertion and rejects client-selected workspace", async () => {
    const base = await gateway();
    const created = await fetch(`${base}/v2/messages`, {
      method: "POST", headers: auth(), body: JSON.stringify({ type: "note", content: "hello", source: "agent-a" }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).message).toMatchObject({ workspace: "workspace-a", source: "agent-a" });

    const sourceMismatch = await fetch(`${base}/v2/messages`, {
      method: "POST", headers: auth(), body: JSON.stringify({ type: "note", content: "wrong source", source: "evil" }),
    });
    expect(sourceMismatch.status).toBe(403);
    const workspace = await fetch(`${base}/v2/messages`, {
      method: "POST", headers: auth(), body: JSON.stringify({ type: "note", content: "wrong workspace", workspace: "evil" }),
    });
    expect(workspace.status).toBe(400);

    const history = await fetch(`${base}/v2/history`, { headers: auth() });
    expect((await history.json()).messages).toHaveLength(1);
  });

  it("binds mailbox views and receipt state to the credential principal", async () => {
    const store = new SQLiteBridgeStore();
    const service = new BridgeService(store);
    const sender = { workspace: "workspace-a", agent: "sender" };
    const worker = { workspace: "workspace-a", agent: "worker" };
    const targeted = await service.publish(sender, {
      type: "work",
      content: "for worker",
      targets: ["worker"],
    });
    const broadcast = await service.publish(sender, {
      type: "context",
      content: "for everyone",
    });
    const principals = new Map([
      ["sender-token", sender],
      ["worker-token", worker],
      ["other-token", { workspace: "workspace-a", agent: "other" }],
    ]);
    const base = await gateway({
      resolve: async (token) => {
        const principal = principals.get(token);
        return principal ? { id: `${principal.agent}-credential`, principal } : null;
      },
    }, {}, store);

    const senderInbox = await fetch(`${base}/v2/history`, { headers: auth("sender-token") });
    expect((await senderInbox.json()).messages.map((message: { id: string }) => message.id))
      .toEqual([broadcast.message.id]);
    const senderSent = await fetch(`${base}/v2/history?mailbox=sent`, {
      headers: auth("sender-token"),
    });
    expect((await senderSent.json()).messages.map((message: { id: string }) => message.id))
      .toEqual([targeted.message.id, broadcast.message.id]);
    const otherInbox = await fetch(`${base}/v2/history`, { headers: auth("other-token") });
    expect((await otherInbox.json()).messages.map((message: { id: string }) => message.id))
      .toEqual([broadcast.message.id]);

    const recorded = await fetch(`${base}/v2/receipts`, {
      method: "POST",
      headers: auth("worker-token"),
      body: JSON.stringify({ messageIds: [targeted.message.id] }),
    });
    expect(await recorded.json()).toMatchObject({ recorded: 1 });
    const read = await fetch(`${base}/v2/history?receiptState=read`, {
      headers: auth("worker-token"),
    });
    expect((await read.json()).messages.map((message: { id: string }) => message.id))
      .toEqual([targeted.message.id]);

    const mismatch = await fetch(
      `${base}/v2/history?unacknowledgedBy=${encodeURIComponent(worker.agent)}`,
      { headers: auth("sender-token") },
    );
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toMatchObject({ error: { code: "principal_mismatch" } });
    const unauthorizedReceipt = await fetch(`${base}/v2/receipts`, {
      method: "POST",
      headers: auth("other-token"),
      body: JSON.stringify({ messageIds: [targeted.message.id] }),
    });
    expect(await unauthorizedReceipt.json()).toMatchObject({ recorded: 0 });
  });

  it("binds identity while preserving and filtering optional project labels", async () => {
    const base = await gateway();
    for (const body of [
      { type: "note", content: "alpha", project: "project-alpha" },
      { type: "note", content: "beta", project: "project-beta" },
      { type: "note", content: "unlabeled" },
    ]) {
      const response = await fetch(`${base}/v2/messages`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ ...body, source: "agent-a" }),
      });
      expect(response.status).toBe(201);
      expect((await response.json()).message).toMatchObject({
        workspace: "workspace-a",
        source: "agent-a",
        ...(body.project ? { project: body.project } : {}),
      });
    }

    const filtered = await fetch(`${base}/v2/history?project=project-alpha`, { headers: auth() });
    expect((await filtered.json()).messages.map((message: { content: string }) => message.content))
      .toEqual(["alpha"]);

    const unfiltered = await fetch(`${base}/v2/history`, { headers: auth() });
    expect((await unfiltered.json()).messages.map((message: { content: string }) => message.content))
      .toEqual(["alpha", "beta", "unlabeled"]);
  });

  it("accepts the legacy-compatible asterisk project label", async () => {
    const base = await gateway();
    const created = await fetch(`${base}/v2/messages`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ type: "note", content: "legacy scope", project: "*" }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).message.project).toBe("*");
  });

  it("rejects missing and revoked credentials identically", async () => {
    const base = await gateway({ resolve: async () => null });
    for (const headers of [{}, auth("revoked")]) {
      const response = await fetch(`${base}/v2/history`, { headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
  });

  it("authenticates and verifies the configured principal during initialization", async () => {
    const base = await gateway();
    const valid = new HttpBridgeStore({
      baseUrl: base,
      token: "good",
      principal: { workspace: "workspace-a", agent: "agent-a" },
    });
    await expect(valid.initialize()).resolves.toBeUndefined();
    const invalid = new HttpBridgeStore({
      baseUrl: base,
      token: "bad",
      principal: { workspace: "workspace-a", agent: "agent-a" },
    });
    await expect(invalid.initialize()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    const mismatched = new HttpBridgeStore({
      baseUrl: base,
      token: "good",
      principal: { workspace: "workspace-a", agent: "other" },
    });
    await expect(mismatched.initialize()).rejects.toMatchObject({ status: 403, code: "principal_mismatch" });
  });

  it("enforces origins, JSON shape, and body limits with stable errors", async () => {
    const base = await gateway(undefined, { allowedOrigins: ["https://allowed.test"], bodyLimitBytes: 48 });
    const forbidden = await fetch(`${base}/v2/history`, { headers: { ...auth(), origin: "https://evil.test" } });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe("origin_forbidden");

    const malformed = await fetch(`${base}/v2/messages`, { method: "POST", headers: auth(), body: "{" });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("malformed_json");

    const large = await fetch(`${base}/v2/messages`, { method: "POST", headers: auth(), body: JSON.stringify({ content: "x".repeat(100) }) });
    expect(large.status).toBe(413);
    expect((await large.json()).error.code).toBe("body_too_large");

    const missingType = await fetch(`${base}/v2/messages`, {
      method: "POST",
      headers: { authorization: "Bearer good" },
      body: JSON.stringify({ type: "note", content: "hello" }),
    });
    expect(missingType.status).toBe(415);
    expect((await missingType.json()).error.code).toBe("unsupported_media_type");
  });

  it("rejects typed delivery and presence fields before mutation", async () => {
    const base = await gateway();
    const created = await fetch(`${base}/v2/messages`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ type: "work", content: "typed boundary", targets: ["agent-a"] }),
    });
    expect(created.status).toBe(201);
    const claim = await fetch(`${base}/v2/deliveries/claim`, {
      method: "POST",
      headers: { ...auth(), "x-agent-bridge-instance": "one" },
      body: JSON.stringify({ leaseMs: 30_000 }),
    });
    const claimed = await claim.json();

    for (const body of [
      { leaseToken: claimed.leaseToken, error: "retry", dead: "false" },
      { leaseToken: claimed.leaseToken, error: "retry", retryPolicy: null },
    ]) {
      const response = await fetch(`${base}/v2/deliveries/${claimed.delivery.id}/nack`, {
        method: "POST",
        headers: { ...auth(), "x-agent-bridge-instance": "one" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_input");
    }

    for (const body of [
      { runtimeType: 7, capabilities: [] },
      { runtimeType: "codex", capabilities: "mcp" },
    ]) {
      const response = await fetch(`${base}/v2/presence/heartbeat`, {
        method: "POST",
        headers: { ...auth(), "x-agent-bridge-instance": "one" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_input");
    }
  });

  it("exposes caller-bound delivery listing and publisher controls", async () => {
    const principals = new Map([
      ["publisher-token", { workspace: "workspace-a", agent: "publisher" }],
      ["worker-token", { workspace: "workspace-a", agent: "worker" }],
      ["other-token", { workspace: "workspace-a", agent: "other" }],
    ]);
    const base = await gateway({
      resolve: async (token) => {
        const principal = principals.get(token);
        return principal ? { id: `${principal.agent}-credential`, principal } : null;
      },
    });
    const sent = await fetch(`${base}/v2/messages`, {
      method: "POST", headers: auth("publisher-token"),
      body: JSON.stringify({ type: "work", content: "controlled", targets: ["worker"] }),
    });
    expect(sent.status).toBe(201);
    const claimed = await fetch(`${base}/v2/deliveries/claim`, {
      method: "POST", headers: { ...auth("worker-token"), "x-agent-bridge-instance": "one" },
      body: JSON.stringify({ leaseMs: 1_000 }),
    });
    const claim = await claimed.json();
    const listed = await fetch(`${base}/v2/deliveries?role=recipient&recipient=worker`, {
      headers: auth("worker-token"),
    });
    expect((await listed.json()).deliveries).toHaveLength(1);
    const hidden = await fetch(`${base}/v2/deliveries/${claim.delivery.id}/cancel`, {
      method: "POST", headers: auth("other-token"), body: "{}",
    });
    expect(hidden.status).toBe(404);
    const contradictory = await fetch(`${base}/v2/deliveries/${claim.delivery.id}/cancel`, {
      method: "POST", headers: auth("publisher-token"), body: JSON.stringify({ deliveryId: "other-delivery" }),
    });
    expect(contradictory.status).toBe(400);
    expect(await contradictory.json()).toMatchObject({ error: { code: "invalid_input", operation: "cancel_delivery" } });
    const cancelled = await fetch(`${base}/v2/deliveries/${claim.delivery.id}/cancel`, {
      method: "POST", headers: auth("publisher-token"),
    });
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).delivery.state).toBe("cancelled");
    const requeued = await fetch(`${base}/v2/deliveries/${claim.delivery.id}/requeue`, {
      method: "POST", headers: auth("publisher-token"),
    });
    expect(requeued.status).toBe(200);
    const conflict = await fetch(`${base}/v2/deliveries/${claim.delivery.id}/requeue`, {
      method: "POST", headers: auth("publisher-token"), body: "{}",
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "delivery_state_conflict" } });
  });

  it("serves released delivery operations to a headerless 2.0 client", async () => {
    const base = await gateway({
      resolve: async (token) => token === "sender-token"
        ? { id: "sender", principal: { workspace: "workspace-a", agent: "sender" } }
        : token === "worker-token"
          ? { id: "worker", principal: { workspace: "workspace-a", agent: "worker" } }
          : null,
    });
    await fetch(`${base}/v2/messages`, {
      method: "POST",
      headers: auth("sender-token"),
      body: JSON.stringify({ type: "work", content: "legacy worker", targets: ["worker"] }),
    });
    const legacyHeaders = {
      authorization: "Bearer worker-token",
      "content-type": "application/json",
      "x-agent-bridge-instance": "legacy-instance",
    };
    const claimed = await fetch(`${base}/v2/deliveries/claim`, {
      method: "POST", headers: legacyHeaders, body: "{}",
    });
    expect(claimed.headers.get("x-agent-bridge-protocol-version")).toBe("2.0");
    const claim = await claimed.json();
    expect(claim).toMatchObject({ delivery: { state: "claimed" }, leaseToken: expect.any(String) });

    const contradictory = await fetch(`${base}/v2/deliveries/${claim.delivery.id}/nack`, {
      method: "POST",
      headers: legacyHeaders,
      body: JSON.stringify({ deliveryId: "other", leaseToken: claim.leaseToken }),
    });
    expect(contradictory.status).toBe(400);
    expect(await contradictory.json()).toMatchObject({ error: { code: "invalid_input", operation: "negative_acknowledge_delivery" } });

    const nacked = await fetch(`${base}/v2/deliveries/${claim.delivery.id}/nack`, {
      method: "POST",
      headers: legacyHeaders,
      body: JSON.stringify({ leaseToken: claim.leaseToken, disposition: "dead" }),
    });
    expect(nacked.status).toBe(200);
    expect(await nacked.json()).toMatchObject({ state: "dead", lastError: "negative acknowledgment" });
  });

  it("requires authentication for metrics", async () => {
    const base = await gateway();
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    const response = await fetch(`${base}/metrics`, { headers: auth() });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("agent_bridge_gateway_requests_total");
  });

  it("reports readiness failures as unavailable", async () => {
    const base = await gateway(undefined, { ready: async () => { throw new Error("database down"); } });
    const response = await fetch(`${base}/readyz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready" });
  });

  it("returns a redacted stable error when authentication storage fails", async () => {
    const sensitiveDetail = ["postgres", "://", "secret", "@db/raw detail"].join("");
    const base = await gateway({ resolve: async () => { throw new Error(sensitiveDetail); } });
    const response = await fetch(`${base}/v2/history`, { headers: auth() });
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).toContain("internal_error");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("raw detail");
  });

  it("terminates slow requests at the configured deadline", async () => {
    let aborted = false;
    const base = await gateway({
      resolve: async (_token, signal) => new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        });
      }),
    }, { requestDeadlineMs: 25 });
    const response = await fetch(`${base}/v2/history`, { headers: auth() });
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe("request_timeout");
    expect(aborted).toBe(true);
  });

  it("does not continue after a resolver ignores the deadline", async () => {
    let calls = 0;
    const base = await gateway({
      resolve: async () => {
        calls += 1;
        const credential = {
          id: "late",
          principal: { workspace: "workspace-a", agent: "agent-a" },
        };
        return calls === 1
          ? new Promise((resolve) => setTimeout(() => resolve(credential), 40))
          : credential;
      },
    }, { requestDeadlineMs: 10 });
    const response = await fetch(`${base}/v2/messages`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ type: "note", content: "must not be stored" }),
    });
    expect(response.status).toBe(504);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const history = await fetch(`${base}/v2/history`, { headers: auth() });
    expect((await history.json()).messages).toHaveLength(0);
  });

  it("closes an incomplete request body after the deadline", async () => {
    const base = await gateway(undefined, { requestDeadlineMs: 25 });
    const url = new URL(`${base}/v2/messages`);
    let clientRequest: ReturnType<typeof request>;
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      clientRequest = request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: auth(),
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => resolve({
          status: incoming.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      clientRequest.on("error", reject);
      clientRequest.write('{"type":"note","content":"');
    });
    clientRequest!.destroy();
    expect(response.status).toBe(504);
    expect(JSON.parse(response.body).error.code).toBe("request_timeout");
  });

  it("reports an unknown outcome when a mutation outlives its deadline", async () => {
    class SlowStore extends SQLiteBridgeStore {
      override async insertMessage(
        ...args: Parameters<SQLiteBridgeStore["insertMessage"]>
      ): ReturnType<SQLiteBridgeStore["insertMessage"]> {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return super.insertMessage(...args);
      }
    }
    const base = await gateway(undefined, { requestDeadlineMs: 10 }, new SlowStore());
    const started = Date.now();
    const response = await fetch(`${base}/v2/messages`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ type: "note", content: "commit before response" }),
    });
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe("mutation_outcome_unknown");
    expect(Date.now() - started).toBeLessThan(35);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const history = await fetch(`${base}/v2/history`, { headers: auth() });
    expect((await history.json()).messages).toHaveLength(1);
  });

  it("bounds a store mutation that never settles", async () => {
    class HungStore extends SQLiteBridgeStore {
      override async insertMessage(
        ..._args: Parameters<SQLiteBridgeStore["insertMessage"]>
      ): ReturnType<SQLiteBridgeStore["insertMessage"]> {
        return new Promise(() => {});
      }
    }
    const base = await gateway(undefined, { requestDeadlineMs: 20 }, new HungStore());
    const response = await fetch(`${base}/v2/messages`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ type: "note", content: "never returns" }),
    });
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe("mutation_outcome_unknown");
  });

  it("requires HTTPS when the gateway is not on loopback", () => {
    expect(() => new HttpBridgeStore({
      baseUrl: "http://bridge.example.test",
      token: "secret",
      principal: { workspace: "workspace-a", agent: "agent-a" },
    })).toThrow(/requires HTTPS/);
    expect(() => new HttpBridgeStore({
      baseUrl: "https://bridge.example.test",
      token: "secret",
      principal: { workspace: "workspace-a", agent: "agent-a" },
    })).not.toThrow();
  });

  it("runs a two-principal HTTP store round trip", async () => {
    const base = await gateway({
      resolve: async (token) => {
        if (token === "sender") {
          return { id: "sender", principal: { workspace: "workspace-a", agent: "sender" } };
        }
        if (token === "worker") {
          return { id: "worker", principal: { workspace: "workspace-a", agent: "worker" } };
        }
        return null;
      },
    });
    const senderPrincipal = { workspace: "workspace-a", agent: "sender", instance: "one" };
    const workerPrincipal = { workspace: "workspace-a", agent: "worker", instance: "two" };
    const sender = new BridgeService(new HttpBridgeStore({
      baseUrl: base,
      token: "sender",
      principal: senderPrincipal,
    }));
    const worker = new BridgeService(new HttpBridgeStore({
      baseUrl: base,
      token: "worker",
      principal: workerPrincipal,
    }));

    const present = await worker.heartbeat(workerPrincipal, {
      leaseMs: 5_000,
      runtimeType: "worker-runtime",
      capabilities: ["claim"],
    });
    expect(present).toMatchObject({ agent: "worker", instance: "two", capabilities: ["claim"] });
    expect((await worker.presence(workerPrincipal)).map((entry) => entry.agent)).toContain("worker");

    const messageId = "11111111-1111-7111-8111-111111111111";
    const created = await sender.publish(senderPrincipal, {
      id: messageId,
      type: "agent-bridge.work",
      content: "run through HTTP",
      targets: ["worker"],
      idempotencyKey: "http-explicit-id",
    });
    expect(created.message.id).toBe(messageId);
    const replay = await sender.publish(senderPrincipal, {
      id: messageId,
      type: "agent-bridge.work",
      content: "run through HTTP",
      targets: ["worker"],
      idempotencyKey: "http-explicit-id",
    });
    expect(replay).toMatchObject({ created: false, message: { id: messageId } });
    expect((await worker.history(workerPrincipal)).messages[0]?.id).toBe(created.message.id);
    expect(await worker.acknowledge(workerPrincipal, [created.message.id])).toBe(1);
    const claim = await worker.claim(workerPrincipal, { leaseMs: 1_000 });
    expect((await worker.ack(workerPrincipal, claim!.delivery.id, claim!.leaseToken))?.state).toBe("acked");
    expect(await worker.ack(workerPrincipal, claim!.delivery.id, claim!.leaseToken)).toBeNull();

    await expect(
      sender.history({ ...senderPrincipal, agent: "impersonated" }),
    ).rejects.toMatchObject<Partial<BridgeHttpError>>({ status: 403, code: "principal_mismatch" });
  });

  it("connects two installed clients with distinct scoped credentials", async () => {
    const base = await gateway({
      resolve: async (token) => {
        if (token === "codex-token") {
          return { id: "codex", principal: { workspace: "workspace-a", agent: "codex" } };
        }
        if (token === "claude-token") {
          return { id: "claude", principal: { workspace: "workspace-a", agent: "claude-code" } };
        }
        return null;
      },
    });
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installed-"));
    directories.push(home);
    const env = {
      HOME: home,
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: base,
      AGENT_BRIDGE_WORKSPACE: "workspace-a",
    };
    const execute = () => ({
      pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null,
    });
    const codexInstall = installClient("codex", "codex", {
      env, token: "codex-token", instance: "codex-machine",
    }, execute);
    const claudeInstall = installClient("claude-code", "claude-code", {
      env, token: "claude-token", instance: "claude-machine",
    }, execute);
    const codexConfig = resolveClientConfig({
      HOME: home,
      AGENT_BRIDGE_CONFIG: codexInstall.backendConfigPath,
      AGENT_BRIDGE_AGENT: "codex",
      AGENT_BRIDGE_INSTANCE: codexInstall.instance,
    });
    const claudeConfig = resolveClientConfig({
      HOME: home,
      AGENT_BRIDGE_CONFIG: claudeInstall.backendConfigPath,
      AGENT_BRIDGE_AGENT: "claude-code",
      AGENT_BRIDGE_INSTANCE: claudeInstall.instance,
    });
    const codexStore = new HttpBridgeStore({
      baseUrl: codexConfig.url!, token: codexConfig.credential!, principal: codexConfig.principal,
    });
    const claudeStore = new HttpBridgeStore({
      baseUrl: claudeConfig.url!, token: claudeConfig.credential!, principal: claudeConfig.principal,
    });
    await Promise.all([codexStore.initialize(), claudeStore.initialize()]);
    const codex = new BridgeService(codexStore);
    const claude = new BridgeService(claudeStore);
    await codex.publish(codexConfig.principal, {
      type: "request", content: "cross-client credential proof", targets: ["claude-code"],
    });
    expect((await claude.history(claudeConfig.principal)).messages).toMatchObject([{
      source: "codex",
      content: "cross-client credential proof",
    }]);
  });
});
