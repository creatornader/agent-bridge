import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgentBridgeServer, configFromEnv } from "../src/server.js";

describe("createAgentBridgeServer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an importable MCP server without reading process env", async () => {
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
  });
});

describe("configFromEnv", () => {
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
    });
  });

  it("throws a normal error when credentials are missing", () => {
    expect(() => configFromEnv({})).toThrow(
      "Missing AGENT_BRIDGE_URL or AGENT_BRIDGE_KEY environment variables",
    );
  });
});
