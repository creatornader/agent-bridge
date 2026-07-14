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

function auth(token = "good") { return { authorization: `Bearer ${token}`, "content-type": "application/json" }; }

describe("authenticated v2 gateway", () => {
  it("binds source and workspace to the credential and isolates history", async () => {
    const base = await gateway();
    const created = await fetch(`${base}/v2/messages`, {
      method: "POST", headers: auth(), body: JSON.stringify({ type: "note", content: "hello", workspace: "evil", source: "evil" }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).message).toMatchObject({ workspace: "workspace-a", source: "agent-a" });

    const history = await fetch(`${base}/v2/history`, { headers: auth() });
    expect((await history.json()).messages).toHaveLength(1);
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

    const created = await sender.publish(senderPrincipal, {
      type: "agent-bridge.work",
      content: "run through HTTP",
      targets: ["worker"],
    });
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
