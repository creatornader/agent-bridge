import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentBridgeServer, configFromEnv } from "../src/server.js";
import { privateTestDirectory } from "./private-test-path.js";

describe("createAgentBridgeServer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes manual gateway sync through MCP while offline", async () => {
    const root = privateTestDirectory("agent-bridge-mcp-edge-");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const server = createAgentBridgeServer({
      provider: "gateway",
      gatewayUrl: "https://bridge.example.test",
      gatewayToken: "bound-token",
      edgeDatabasePath: join(root, "edge.sqlite3"),
      workspace: "workspace-a",
      agent: "codex",
      instance: "desktop",
    });
    const client = new Client({ name: "factory-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("sync");
      const sync = tools.tools.find((tool) => tool.name === "sync");
      expect(sync?.outputSchema?.required).toEqual([
        "online", "pushed", "deduplicated", "pulled", "pending", "blocked", "cached",
      ]);
      const result = await client.callTool({
        name: "sync",
        arguments: { maxPush: 1, maxPages: 1 },
      });
      expect(result.structuredContent).toMatchObject({ online: false, pending: 0 });
      expect(JSON.parse(String(result.content[0]?.text))).toEqual(result.structuredContent);
    } finally {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("connect starts replay, reconnect commits queued work, and close stays bounded", async () => {
    const root = privateTestDirectory("agent-bridge-mcp-replay-");
    let online = false;
    const published: any[] = [];
    const protocolHeaders = {
      "x-agent-bridge-protocol-version": "2.1",
      "x-agent-bridge-supported-protocol-versions": "2.0,2.1",
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (!online) throw new Error("offline");
      const url = String(input);
      if (url.endsWith("/readyz")) return Response.json({ status: "ok" });
      if (url.includes("/v2/status")) return Response.json({
        schemaVersion: "postgres-v2", deliverySupported: true,
        pending: 0, claimed: 0, retrying: 0, dead: 0,
        principal: { workspace: "workspace-a", agent: "codex" },
      }, { headers: protocolHeaders });
      if (url.includes("/v2/messages")) {
        const body = JSON.parse(String(init?.body));
        const message = {
          ...body, id: body.id, workspace: "workspace-a", source: "codex", sequence: "1",
          createdAt: new Date(0).toISOString(),
        };
        published.push(message);
        return Response.json({ message, created: true }, { headers: protocolHeaders });
      }
      if (url.includes("/v2/history")) return Response.json({ messages: [] }, { headers: protocolHeaders });
      throw new Error(`unexpected request: ${url}`);
    });
    const server = createAgentBridgeServer({
      provider: "gateway", gatewayUrl: "https://bridge.example.test",
      gatewayToken: "bound-token", edgeDatabasePath: join(root, "edge.sqlite3"),
      workspace: "workspace-a", agent: "codex", instance: "desktop",
    });
    const client = new Client({ name: "factory-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const queued = await client.callTool({
        name: "send", arguments: { type: "work", content: "replay me" },
      });
      expect(queued.structuredContent).toMatchObject({ disposition: "queued", authoritative: false });
      online = true;
      await vi.waitFor(() => expect(published).toHaveLength(1), { timeout: 2_000 });
    } finally {
      await client.close();
      await expect(Promise.race([
        server.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout")), 500)),
      ])).resolves.toBeUndefined();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts an active gateway HTTP request and closes the MCP factory within a bound", async () => {
    const root = privateTestDirectory("agent-bridge-mcp-close-");
    let requestSignal: AbortSignal | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? null;
        requestSignal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      }));
    const server = createAgentBridgeServer({
      provider: "gateway", gatewayUrl: "https://bridge.example.test",
      gatewayToken: "bound-token", edgeDatabasePath: join(root, "edge.sqlite3"),
      workspace: "workspace-a", agent: "codex", instance: "desktop",
    });
    const client = new Client({ name: "factory-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const activeCall = client.callTool({ name: "sync", arguments: { maxPages: 1 } });
    await vi.waitFor(() => expect(requestSignal).not.toBeNull());
    await expect(Promise.race([
      server.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout")), 500)),
    ])).resolves.toBeUndefined();
    expect(requestSignal?.aborted).toBe(true);
    await expect(activeCall).rejects.toBeDefined();
    await client.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it("advertises delivery tools and complete history filters for local v2", async () => {
    const server = createAgentBridgeServer({
      provider: "local",
      databasePath: ":memory:",
      workspace: "workspace-a",
      agent: "codex",
      instance: "codex-desktop",
    });
    const client = new Client({ name: "factory-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("claim");
      expect(tools.tools.map((tool) => tool.name)).toContain("list_deliveries");
      expect(tools.tools.map((tool) => tool.name)).toContain("list_delivery_events");
      const send = tools.tools.find((tool) => tool.name === "send");
      const history = tools.tools.find((tool) => tool.name === "history");
      const claimTool = tools.tools.find((tool) => tool.name === "claim");
      const nackTool = tools.tools.find((tool) => tool.name === "negative_acknowledge");
      const getContext = tools.tools.find((tool) => tool.name === "get_context");
      const postContext = tools.tools.find((tool) => tool.name === "post_context");
      expect(getContext?.outputSchema?.required).toEqual(["entries"]);
      expect(getContext?.outputSchema?.properties).toMatchObject({
        entries: { type: "array" },
        acknowledgements: { enum: ["authoritative", "unknown"] },
      });
      expect(history?.inputSchema.properties).toHaveProperty("threadId");
      expect(history?.inputSchema.properties).toHaveProperty("latest");
      expect(history?.inputSchema.properties).toMatchObject({
        mailbox: { enum: ["inbox", "sent", "all"] },
        receiptState: { enum: ["any", "unread", "read"] },
      });
      expect(send?.inputSchema.properties).toHaveProperty("project");
      expect(send?.inputSchema.properties.deliveryPolicy.properties).toHaveProperty("retryBaseDelayMs");
      expect(claimTool?.inputSchema.properties).toHaveProperty("maxAttempts");
      expect(nackTool?.inputSchema.properties).toHaveProperty("retryPolicy");
      expect(history?.inputSchema.properties).toHaveProperty("project");
      expect(getContext?.inputSchema.properties).toHaveProperty("project");
      expect(postContext?.inputSchema.properties).toHaveProperty("project");
      expect(history?.outputSchema).toBeDefined();
      expect(history?.outputSchema?.properties).toMatchObject({
        stale: { type: "boolean" },
        degraded: { type: "boolean" },
        acknowledgements: { enum: ["authoritative", "unknown"] },
        lastSyncedAt: { type: "string" },
      });
      await expect(client.callTool({ name: "get_context", arguments: { limit: -1 } }))
        .rejects.toThrow();
      await expect(client.callTool({
        name: "send",
        arguments: { type: "note", content: "   " },
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      const heartbeat = await client.callTool({
        name: "heartbeat",
        arguments: { runtimeType: "codex", capabilities: ["mcp"] },
      });
      expect(heartbeat.structuredContent).toMatchObject({
        agent: "codex",
        instance: "codex-desktop",
      });
      const sent = await client.callTool({
        name: "send",
        arguments: {
          type: "work",
          content: "exercise delivery tools",
          targets: ["codex"],
        },
      });
      const sentId = (sent.structuredContent as any).message.id as string;
      const listed = await client.callTool({
        name: "history",
        arguments: { types: ["work"], source: "codex" },
      });
      expect((listed.structuredContent as any).messages[0].id).toBe(sentId);
      expect(JSON.parse(String(listed.content[0]?.text))).toEqual(listed.structuredContent);
      const sentView = await client.callTool({
        name: "history",
        arguments: { mailbox: "sent" },
      });
      expect((sentView.structuredContent as any).messages[0].id).toBe(sentId);
      await expect(client.callTool({
        name: "history",
        arguments: { unacknowledgedBy: "other-agent" },
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      const claimed = await client.callTool({
        name: "claim",
        arguments: { leaseMs: 30_000 },
      });
      const delivery = (claimed.structuredContent as any).delivery;
      const leaseToken = (claimed.structuredContent as any).leaseToken;
      const extended = await client.callTool({
        name: "extend",
        arguments: { deliveryId: delivery.id, leaseToken, leaseMs: 60_000 },
      });
      expect((extended.structuredContent as any).delivery.state).toBe("claimed");
      await expect(client.callTool({
        name: "negative_acknowledge",
        arguments: {
          deliveryId: delivery.id,
          leaseToken,
          error: "must stay retryable",
          dead: "false",
        } as any,
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      const nacked = await client.callTool({
        name: "negative_acknowledge",
        arguments: {
          deliveryId: delivery.id,
          leaseToken,
          error: "stop this test delivery",
          dead: true,
        },
      });
      expect((nacked.structuredContent as any).delivery.state).toBe("dead");

      await client.callTool({
        name: "send",
        arguments: { type: "work", content: "ack this delivery", targets: ["codex"] },
      });
      const secondClaim = await client.callTool({
        name: "claim",
        arguments: { leaseMs: 30_000 },
      });
      const second = secondClaim.structuredContent as any;
      const acknowledged = await client.callTool({
        name: "acknowledge",
        arguments: {
          deliveryId: second.delivery.id,
          leaseToken: second.leaseToken,
        },
      });
      expect((acknowledged.structuredContent as any).delivery.state).toBe("acked");

      await expect(client.callTool({
        name: "claim",
        arguments: { leaseMs: 30_000, maxAttempts: 0 },
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await client.callTool({
        name: "send",
        arguments: {
          type: "work", content: "deprecated consumer policy", targets: ["codex"],
          deliveryPolicy: { mode: "leased", maxAttempts: 1, retryJitterRatio: 0 },
        },
      });
      const compatibilityClaim = await client.callTool({
        name: "claim",
        arguments: { leaseMs: 30_000, maxAttempts: 99 },
      });
      const compatibility = compatibilityClaim.structuredContent as any;
      await expect(client.callTool({
        name: "negative_acknowledge",
        arguments: {
          deliveryId: compatibility.delivery.id,
          leaseToken: compatibility.leaseToken,
          error: "invalid compatibility policy",
          disposition: "retry",
          retryPolicy: { maxAttempts: 0 },
        },
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      const compatibilityNack = await client.callTool({
        name: "negative_acknowledge",
        arguments: {
          deliveryId: compatibility.delivery.id,
          leaseToken: compatibility.leaseToken,
          error: "stored policy wins",
          disposition: "retry",
          retryPolicy: {
            maxAttempts: 99, baseDelayMs: 1,
            maxDelayMs: 60_000, jitterRatio: 0,
          },
        },
      });
      expect((compatibilityNack.structuredContent as any).delivery.state).toBe("dead");
      const presence = await client.callTool({ name: "presence", arguments: {} });
      expect((presence.structuredContent as any).agents).toHaveLength(1);
      const legacyId = "00000000-0000-8000-8000-000000000003";
      await client.callTool({
        name: "post_context",
        arguments: {
          category: "operational",
          content: "migrated legacy row",
          message_id: legacyId,
        },
      });
      const legacyAck = await client.callTool({
        name: "ack_context",
        arguments: { ids: [3] },
      });
      expect(legacyAck.structuredContent).toMatchObject({ acknowledged: 1 });

      const projectPost = await client.callTool({
        name: "post_context",
        arguments: {
          category: "operational",
          content: "project alpha context",
          project: "project-alpha",
        },
      });
      expect(projectPost.structuredContent).toMatchObject({
        message: { project: "project-alpha" },
      });
      await client.callTool({
        name: "post_context",
        arguments: { category: "operational", content: "unlabeled context" },
      });
      const projectContext = await client.callTool({
        name: "get_context",
        arguments: { project: "project-alpha" },
      });
      expect((projectContext.structuredContent as any).entries).toMatchObject([{
        project: "project-alpha",
        content: "project alpha context",
      }]);
      const allContext = await client.callTool({ name: "get_context", arguments: {} });
      expect((allContext.structuredContent as any).entries.map(
        (entry: { content: string }) => entry.content,
      )).toEqual(expect.arrayContaining(["project alpha context", "unlabeled context"]));

      const projectSend = await client.callTool({
        name: "send",
        arguments: { type: "note", content: "star project", project: "*" },
      });
      expect(projectSend.structuredContent).toMatchObject({ message: { project: "*" } });
      const projectHistory = await client.callTool({
        name: "history",
        arguments: { project: "*" },
      });
      expect((projectHistory.structuredContent as any).messages).toMatchObject([{
        project: "*",
        content: "star project",
      }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("configFromEnv", () => {
  function withBridgeConfig(contents: string): string {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-home-"));
    const configDir = join(home, ".agent-bridge");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config"), contents);
    return home;
  }

  it("normalizes gateway environment values", () => {
    expect(configFromEnv({
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: "https://bridge.example.test",
      AGENT_BRIDGE_TOKEN: "bound-token",
      AGENT_BRIDGE_AGENT: " codex ",
      AGENT_BRIDGE_WORKSPACE: "workspace-a",
      AGENT_BRIDGE_INSTANCE: "desktop-a",
    })).toMatchObject({
      provider: "gateway",
      gatewayUrl: "https://bridge.example.test",
      gatewayToken: "bound-token",
      agent: "codex",
      workspace: "workspace-a",
      instance: "desktop-a",
    });
  });

  it("combines a tokenless shared gateway config with process authority", () => {
    const home = withBridgeConfig([
      "AGENT_BRIDGE_PROVIDER=gateway",
      "AGENT_BRIDGE_URL=\"https://bridge.example.test\"",
      "AGENT_BRIDGE_WORKSPACE='workspace-a'",
      "AGENT_BRIDGE_AGENT=stale-agent",
      "AGENT_BRIDGE_INSTANCE=stale-instance",
      "",
    ].join("\n"));
    try {
      expect(configFromEnv({
        HOME: home,
        AGENT_BRIDGE_AGENT: "codex",
        AGENT_BRIDGE_INSTANCE: "desktop-a",
        AGENT_BRIDGE_TOKEN: "bound-token",
      })).toMatchObject({
        provider: "gateway",
        gatewayUrl: "https://bridge.example.test",
        gatewayToken: "bound-token",
        agent: "codex",
        workspace: "workspace-a",
        instance: "desktop-a",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects retired legacy provider names and key-only configs", () => {
    for (const provider of ["legacy", "supabase", "legacy-supabase"]) {
      expect(() => configFromEnv({
        AGENT_BRIDGE_PROVIDER: provider,
        AGENT_BRIDGE_URL: "https://bridge.example.test",
        AGENT_BRIDGE_KEY: "publishable-key",
        AGENT_BRIDGE_AGENT: "codex",
      })).toThrow("legacy Supabase provider was removed");
    }
    const home = withBridgeConfig("");
    try {
      expect(() => configFromEnv({
        HOME: home,
        AGENT_BRIDGE_URL: "https://bridge.example.test",
        AGENT_BRIDGE_KEY: "publishable-key",
        AGENT_BRIDGE_AGENT: "codex",
      })).toThrow("legacy Supabase provider was removed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects provider typos and incomplete gateway configuration", () => {
    expect(() => configFromEnv({
      AGENT_BRIDGE_PROVIDER: "gatewy",
      AGENT_BRIDGE_AGENT: "codex",
    })).toThrow("Unsupported AGENT_BRIDGE_PROVIDER: gatewy");
    expect(() => configFromEnv({
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_AGENT: "codex",
    })).toThrow("gateway requires AGENT_BRIDGE_URL and AGENT_BRIDGE_TOKEN");
  });

  it("supports an explicit local config path", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-home-"));
    const configPath = join(home, "bridge.env");
    writeFileSync(configPath, "AGENT_BRIDGE_PROVIDER=local\nAGENT_BRIDGE_WORKSPACE=workspace-a\n");
    try {
      expect(configFromEnv({
        AGENT_BRIDGE_CONFIG: configPath,
        AGENT_BRIDGE_AGENT: "codex",
        HOME: join(home, "unused"),
      })).toMatchObject({ provider: "local", agent: "codex", workspace: "workspace-a" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
