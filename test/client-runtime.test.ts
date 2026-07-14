import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveClientConfig } from "../src/client-config.js";
import { createStore } from "../src/client-runtime.js";
import { SQLiteBridgeStore } from "../src/sqlite-bridge-store.js";
import { SyncingBridgeStore } from "../src/syncing-bridge-store.js";
import { LegacySupabaseRestStore } from "../src/legacy-supabase-store.js";

describe("client runtime", () => {
  it("selects all provider-neutral stores", () => {
    const base = { principal: { workspace: "w", agent: "a" }, databasePath: ":memory:", edgeDatabasePath: ":memory:", cursorPath: "", configPath: "" };
    expect(createStore({ ...base, provider: "local" })).toBeInstanceOf(SQLiteBridgeStore);
    expect(createStore({ ...base, provider: "gateway", url: "https://bridge.test", credential: "token" })).toBeInstanceOf(SyncingBridgeStore);
    expect(createStore({ ...base, provider: "legacy-supabase", url: "https://supabase.test", credential: "key" })).toBeInstanceOf(LegacySupabaseRestStore);
  });
  it("keeps environment values ahead of the config file", () => {
    expect(resolveClientConfig({ HOME: "/unused", AGENT_BRIDGE_PROVIDER: "local", AGENT_BRIDGE_AGENT: "env-agent", AGENT_BRIDGE_WORKSPACE: "env-workspace" })).toMatchObject({ provider: "local", principal: { agent: "env-agent", workspace: "env-workspace" } });
  });

  it("accepts an explicit identity when the runtime environment has none", () => {
    expect(resolveClientConfig({ HOME: "/unused", AGENT_BRIDGE_PROVIDER: "local" }, "codex"))
      .toMatchObject({ principal: { agent: "codex" } });
  });

  it("rejects an explicit identity that conflicts with the runtime", () => {
    expect(() => resolveClientConfig({
      HOME: "/unused",
      AGENT_BRIDGE_PROVIDER: "local",
      AGENT_BRIDGE_AGENT: "codex",
    }, "claude-code")).toThrow("source must match AGENT_BRIDGE_AGENT (codex)");
  });

  it("keeps legacy Supabase unscoped unless a workspace is configured", () => {
    expect(resolveClientConfig({
      HOME: "/unused",
      AGENT_BRIDGE_PROVIDER: "legacy-supabase",
      AGENT_BRIDGE_AGENT: "codex",
      AGENT_BRIDGE_URL: "https://bridge.test",
      AGENT_BRIDGE_KEY: "key",
    }).principal.workspace).toBe("*");
  });

  it("scopes cursors by provider endpoint and principal", () => {
    const base = {
      HOME: "/unused",
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_AGENT: "codex",
      AGENT_BRIDGE_TOKEN: "token",
    };
    const first = resolveClientConfig({ ...base, AGENT_BRIDGE_URL: "https://one.test" });
    const second = resolveClientConfig({ ...base, AGENT_BRIDGE_URL: "https://two.test" });
    const worker = resolveClientConfig({ ...base, AGENT_BRIDGE_URL: "https://one.test", AGENT_BRIDGE_AGENT: "worker" });
    expect(new Set([first.cursorPath, second.cursorPath, worker.cursorPath]).size).toBe(3);
  });

  it("does not collapse distinct workspace names into one cursor path", () => {
    const base = {
      HOME: "/unused",
      AGENT_BRIDGE_PROVIDER: "local",
      AGENT_BRIDGE_AGENT: "codex",
    };
    const slash = resolveClientConfig({ ...base, AGENT_BRIDGE_WORKSPACE: "team/a" });
    const underscore = resolveClientConfig({ ...base, AGENT_BRIDGE_WORKSPACE: "team_a" });
    expect(slash.cursorPath).not.toBe(underscore.cursorPath);
  });

  it("keeps shared backend config separate from process identity", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-config-"));
    const path = join(home, "config");
    writeFileSync(path, "AGENT_BRIDGE_PROVIDER=local\nAGENT_BRIDGE_AGENT=stale-client\nAGENT_BRIDGE_INSTANCE=stale-instance\n");
    try {
      expect(() => resolveClientConfig({ HOME: home, AGENT_BRIDGE_CONFIG: path }))
        .toThrow("AGENT_BRIDGE_AGENT is required");
      const codex = resolveClientConfig({ HOME: home, AGENT_BRIDGE_CONFIG: path, AGENT_BRIDGE_AGENT: "codex" });
      const claude = resolveClientConfig({ HOME: home, AGENT_BRIDGE_CONFIG: path, AGENT_BRIDGE_AGENT: "claude-code" });
      expect(codex.databasePath).toBe(claude.databasePath);
      expect(codex.principal.agent).toBe("codex");
      expect(claude.principal.agent).toBe("claude-code");
      expect(codex.principal.instance).toBeUndefined();
      expect(claude.principal.instance).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
