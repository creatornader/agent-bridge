import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchdPlist, startLoopbackHost, type LoopbackHost } from "../src/loopback-host.js";
import { securePrivatePath } from "../src/private-path.js";
import { createStdioHttpProxyRuntime } from "../src/stdio-http-proxy.js";

const previous = new Map<string, string | undefined>();
const hosts: LoopbackHost[] = [];
const roots: string[] = [];

function setEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!previous.has(key)) previous.set(key, process.env[key]);
    process.env[key] = value;
  }
}

function localConfig(agent = "loopback-test"): string {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-loopback-host-"));
  roots.push(root);
  securePrivatePath(root, "directory");
  const config = join(root, "client.config");
  writeFileSync(config, [
    "AGENT_BRIDGE_PROVIDER=local",
    "AGENT_BRIDGE_WORKSPACE=loopback-test",
    `AGENT_BRIDGE_DB=${join(root, "bridge.sqlite3")}`,
  ].join("\n"));
  securePrivatePath(config, "file");
  setEnv({ AGENT_BRIDGE_CONFIG: config, AGENT_BRIDGE_AGENT: agent, AGENT_BRIDGE_INSTANCE: "host-test" });
  return config;
}

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previous.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loopback MCP host", () => {
  it("proves a bound health socket and serves a local MCP session", async () => {
    localConfig();
    const host = await startLoopbackHost({ port: 0, sessionIdleMs: 30_000 });
    hosts.push(host);

    const health = await fetch(host.healthEndpoint);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      status: "healthy",
      report: { bridgeRuntime: "agent-bridge", sessions: { active: 0 } },
    });

    const transport = new StreamableHTTPClientTransport(new URL(host.endpoint));
    const client = new Client({ name: "loopback-host-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["get_context", "post_context"]));
      const post = await client.callTool({
        name: "post_context",
        arguments: { category: "operational", content: "loopback host test" },
      });
      expect(post.isError).not.toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("rejects exposed bindings and unknown MCP sessions", async () => {
    await expect(startLoopbackHost({ host: "0.0.0.0", port: 0 })).rejects.toThrow("--host must be");
    localConfig("second-host-test");
    const host = await startLoopbackHost({ port: 0 });
    hosts.push(host);
    const response = await fetch(host.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": "missing" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { message: "Session not found" } });
  });

  it("creates a minimal public launchd contract without scheduler priority hints", () => {
    const plist = launchdPlist({
      serviceName: "codex",
      configPath: "/private/client.config",
      agent: "codex",
      instance: "codex-host",
      host: "127.0.0.1",
      port: 8794,
      path: "/mcp",
      sessionIdleMs: 30_000,
      home: "/private/home",
      executablePath: "/private/package/dist/loopback-host.js",
    });
    expect(plist).toContain("com.creatornader.agent-bridge.codex");
    expect(plist).toContain("/private/package/dist/loopback-host.js");
    expect(plist).toContain("<key>AGENT_BRIDGE_AGENT</key>");
    expect(plist).not.toContain("ProcessType");
    expect(plist).not.toContain("LowPriorityIO");
  });

  it("serves Claude Desktop's stdio proxy path from the public package", async () => {
    localConfig("desktop-host-test");
    const host = await startLoopbackHost({ port: 0 });
    hosts.push(host);
    const runtime = await createStdioHttpProxyRuntime(host.endpoint);
    const client = new Client({ name: "desktop-proxy-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), runtime.server.connect(serverTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("post_context");
      const post = await client.callTool({
        name: "post_context",
        arguments: { category: "operational", content: "public desktop proxy test" },
      });
      expect(post.isError).not.toBe(true);
    } finally {
      await client.close();
      await runtime.close();
    }
  });

  it("serializes concurrent MCP sessions through the shared local authority", async () => {
    localConfig("concurrent-host-test");
    const host = await startLoopbackHost({ port: 0 });
    hosts.push(host);
    const results = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
      const transport = new StreamableHTTPClientTransport(new URL(host.endpoint));
      const client = new Client({ name: `concurrent-host-test-${index}`, version: "0.0.0" });
      await client.connect(transport);
      try {
        return await client.callTool({
          name: "post_context",
          arguments: { category: "operational", content: `concurrent host write ${index}` },
        });
      } finally {
        await client.close();
        await transport.close();
      }
    }));
    expect(results.every((result) => result.isError !== true)).toBe(true);
    const health = await fetch(host.healthEndpoint);
    await expect(health.json()).resolves.toMatchObject({ report: { sessions: { opened: 16 } } });
  });
});
