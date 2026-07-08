import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentBridgeServer, configFromEnv } from "../src/server.js";

describe("createAgentBridgeServer", () => {
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
    });
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
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
