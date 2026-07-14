import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentBridgeServer, configFromEnv } from "../src/server.js";

describe("createAgentBridgeServer", () => {
  it("rejects plaintext non-loopback legacy providers without a configured agent", () => {
    expect(() => createAgentBridgeServer({
      supabaseUrl: "http://bridge.example.test",
      supabaseKey: "secret",
    })).toThrow("requires HTTPS");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "creates an importable MCP server without reading process env",
    async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify([{ id: 1, source: "codex" }]), {
          status: 200,
        });
      });

      const server = createAgentBridgeServer({
        supabaseUrl: "https://bridge.example.test/",
        supabaseKey: "anon-key",
        agent: "codex",
      });
      const client = new Client({ name: "factory-test", version: "0.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        const result = await client.callTool({
          name: "post_context",
          arguments: {
            source: "codex",
            category: "goal-update",
            content: "factory path works",
          },
        });

        expect(result.content[0]?.text).toContain('"source": "codex"');
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe(
          "https://bridge.example.test/rest/v1/shared_context",
        );
        expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
          source: "codex",
          category: "goal-update",
          content: "factory path works",
        });
      } finally {
        await client.close();
        await server.close();
      }
    },
    15_000,
  );

  it("normalizes legacy post_context project labels and rejects blank content before fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json([{
        id: 1,
        ...body,
        acked_by: [],
        created_at: "2026-07-14T00:00:00.000Z",
      }]);
    });
    const server = createAgentBridgeServer({
      supabaseUrl: "https://bridge.example.test",
      supabaseKey: "anon-key",
      agent: "codex",
    });
    const client = new Client({ name: "factory-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await expect(client.callTool({
        name: "post_context",
        arguments: {
          category: "goal-update",
          content: "   ",
          project: "project-alpha",
        },
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      expect(fetchSpy).not.toHaveBeenCalled();

      await client.callTool({
        name: "post_context",
        arguments: {
          category: "goal-update",
          content: "valid context",
          project: " alpha ",
        },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toMatchObject({
        content: "valid context",
        project: "alpha",
        metadata: { message_envelope: { project: "alpha" } },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns schema-conforming legacy context without a configured identity", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([
      { id: 7, source: "codex", category: "work", content: "ready" },
    ]));
    const server = createAgentBridgeServer({
      supabaseUrl: "https://bridge.example.test/", supabaseKey: "anon-key",
    });
    const client = new Client({ name: "factory-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "get_context", arguments: {} });
      const entries = [{ id: 7, source: "codex", category: "work", content: "ready" }];
      expect(result.structuredContent).toEqual({ entries });
      expect(JSON.parse(String(result.content[0]?.text))).toEqual(entries);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it(
    "defaults the configured identity across MCP tools without advertising it as required",
    async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const requestUrl = String(url);
        calls.push({ url: requestUrl, init });
        const response = requestUrl.includes("/rpc/")
          ? 1
          : requestUrl.includes("id=in.(7)")
            ? [{ id: 7, source: "sender", metadata: {} }]
            : [];
        return new Response(JSON.stringify(response), {
          status: 200,
        });
      });

      const server = createAgentBridgeServer({
        supabaseUrl: "https://bridge.example.test/",
        supabaseKey: "anon-key",
        agent: "codex",
      });
      const client = new Client({ name: "factory-test", version: "0.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        const tools = await client.listTools();
        const postContext = tools.tools.find((tool) => tool.name === "post_context");
        const ackContext = tools.tools.find((tool) => tool.name === "ack_context");

        expect(postContext?.inputSchema.required).toEqual(["category", "content"]);
        expect(ackContext?.inputSchema.required).toEqual(["ids"]);

        await client.callTool({
          name: "post_context",
          arguments: { category: "goal-update", content: "defaults source" },
        });
        await client.callTool({ name: "get_context", arguments: {} });
        await client.callTool({ name: "ack_context", arguments: { ids: [7] } });

        expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
          source: "codex",
        });
        expect(calls[1]?.url).toContain("acked_by=not.cs.%7Bcodex%7D");
        const receiptCall = calls.find((call) => call.url.includes("/rpc/ack_context"));
        expect(JSON.parse(String(receiptCall?.init?.body))).toEqual({
          entry_ids: ["7"],
          agent_name: "codex",
        });
      } finally {
        await client.close();
        await server.close();
      }
    },
    15_000,
  );

  it("does not advertise v2 delivery tools on the legacy provider", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    const server = createAgentBridgeServer({
      supabaseUrl: "https://bridge.example.test",
      supabaseKey: "anon-key",
      agent: "codex",
      provider: "legacy-supabase",
      workspace: "*",
      instance: undefined,
    });
    const client = new Client({ name: "factory-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(["post_context", "get_context", "ack_context", "send", "history"]);
      expect(names).not.toContain("claim");
      expect(names).not.toContain("negative_acknowledge");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("exposes manual gateway sync through MCP while offline", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-mcp-edge-"));
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
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-mcp-replay-"));
    let online = false;
    const published: any[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (!online) throw new Error("offline");
      const url = String(input);
      if (url.endsWith("/readyz")) return Response.json({ status: "ok" });
      if (url.includes("/v2/status")) return Response.json({
        schemaVersion: "postgres-v2", deliverySupported: true,
        pending: 0, claimed: 0, retrying: 0, dead: 0,
        principal: { workspace: "workspace-a", agent: "codex" },
      });
      if (url.includes("/v2/messages")) {
        const body = JSON.parse(String(init?.body));
        const message = {
          ...body, workspace: "workspace-a", source: "codex", sequence: "1",
          createdAt: new Date(0).toISOString(),
        };
        published.push(message);
        return Response.json({ message, created: true });
      }
      if (url.includes("/v2/history")) return Response.json({ messages: [] });
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
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-mcp-close-"));
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
      const send = tools.tools.find((tool) => tool.name === "send");
      const history = tools.tools.find((tool) => tool.name === "history");
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
      expect((extended.structuredContent as any).state).toBe("claimed");
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
      expect((nacked.structuredContent as any).state).toBe("dead");

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
      expect((acknowledged.structuredContent as any).state).toBe("acked");
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function withBridgeConfig(contents: string): string {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-home-"));
    const configDir = join(home, ".agent-bridge");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config"), contents);
    return home;
  }

  it("normalizes agent bridge env without exiting the process", () => {
    expect(
      configFromEnv({
        AGENT_BRIDGE_URL: "https://bridge.example.test",
        AGENT_BRIDGE_KEY: "anon-key",
        AGENT_BRIDGE_AGENT: " codex ",
      }),
    ).toEqual({
      supabaseUrl: "https://bridge.example.test",
      supabaseKey: "anon-key",
      agent: "codex",
      provider: "legacy-supabase",
      workspace: "*",
      instance: undefined,
    });
  });

  it("rejects a provider typo instead of falling back to legacy mode", () => {
    expect(() => configFromEnv({
      AGENT_BRIDGE_PROVIDER: "gatewy",
      AGENT_BRIDGE_URL: "https://bridge.example.test",
      AGENT_BRIDGE_KEY: "legacy-key",
      AGENT_BRIDGE_AGENT: "codex",
    })).toThrow("Unsupported AGENT_BRIDGE_PROVIDER: gatewy");
  });

  it("reads credentials from the shared config file when env is unset", () => {
    const home = withBridgeConfig(`
      # Shared by the CLI and MCP server
      AGENT_BRIDGE_URL=https://bridge.example.test
      AGENT_BRIDGE_KEY=anon-key
    `);

    try {
      expect(
        configFromEnv({
          HOME: home,
          AGENT_BRIDGE_AGENT: "codex",
        }),
      ).toEqual({
        supabaseUrl: "https://bridge.example.test",
        supabaseKey: "anon-key",
        agent: "codex",
        provider: "legacy-supabase",
        workspace: "*",
        instance: undefined,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores a legacy identity stored in the shared config file", () => {
    const home = withBridgeConfig(`
      AGENT_BRIDGE_URL=https://bridge.example.test
      AGENT_BRIDGE_KEY=anon-key
      AGENT_BRIDGE_AGENT=codex
    `);
    try {
      expect(configFromEnv({ HOME: home })).toEqual({
        supabaseUrl: "https://bridge.example.test",
        supabaseKey: "anon-key",
        agent: undefined,
        provider: "legacy-supabase",
        workspace: "*",
        instance: undefined,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps explicit env credentials ahead of the config file", () => {
    const home = withBridgeConfig(`
      AGENT_BRIDGE_URL=https://file.example.test
      AGENT_BRIDGE_KEY=file-key
    `);

    try {
      expect(
        configFromEnv({
          HOME: home,
          AGENT_BRIDGE_URL: "https://env.example.test",
          AGENT_BRIDGE_KEY: "env-key",
        }),
      ).toEqual({
        supabaseUrl: "https://env.example.test",
        supabaseKey: "env-key",
        agent: undefined,
        provider: "legacy-supabase",
        workspace: "*",
        instance: undefined,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("handles quoted values in the shared config file", () => {
    const home = withBridgeConfig(`
      AGENT_BRIDGE_URL="https://bridge.example.test"
      AGENT_BRIDGE_KEY='anon-key'
    `);

    try {
      expect(configFromEnv({ HOME: home })).toEqual({
        supabaseUrl: "https://bridge.example.test",
        supabaseKey: "anon-key",
        agent: undefined,
        provider: "legacy-supabase",
        workspace: "*",
        instance: undefined,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws a normal error when credentials are missing", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-home-"));

    try {
      expect(() => configFromEnv({ HOME: home })).toThrow(
        "Missing AGENT_BRIDGE_URL or AGENT_BRIDGE_KEY environment variables or ~/.agent-bridge/config",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("supports an explicit config file path", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-home-"));
    const configPath = join(home, "bridge.env");
    writeFileSync(
      configPath,
      `
        AGENT_BRIDGE_URL=https://explicit.example.test
        AGENT_BRIDGE_KEY=explicit-key
      `,
    );

    try {
      expect(
        configFromEnv({
          AGENT_BRIDGE_CONFIG: configPath,
          HOME: join(home, "unused"),
        }),
      ).toEqual({
        supabaseUrl: "https://explicit.example.test",
        supabaseKey: "explicit-key",
        agent: undefined,
        provider: "legacy-supabase",
        workspace: "*",
        instance: undefined,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
