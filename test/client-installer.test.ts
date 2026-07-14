import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installClient } from "../src/client-installer.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("client installer", () => {
  it("uses the Codex native MCP command with process-scoped identity", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installer-"));
    directories.push(home);
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = installClient("codex", "codex-work", {
      instance: "codex-machine-a",
      env: { HOME: home, AGENT_BRIDGE_PROVIDER: "local" },
    }, (command, args) => {
      calls.push({ command, args });
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
    });
    expect(calls).toEqual([{ command: "codex", args: [
      "mcp", "add", "agent-bridge",
      "--env", "AGENT_BRIDGE_AGENT=codex-work",
      "--env", "AGENT_BRIDGE_INSTANCE=codex-machine-a",
      "--env", `AGENT_BRIDGE_CONFIG=${result.backendConfigPath}`,
      "--", "agent-bridge-mcp",
    ] }]);
    expect(result.method).toBe("native-cli");
  });

  it("uses the Claude Code native MCP command", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installer-"));
    directories.push(home);
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = installClient("claude-code", "claude-work", {
      scope: "user",
      instance: "claude-machine-a",
      env: { HOME: home, AGENT_BRIDGE_PROVIDER: "local" },
    }, (command, args) => {
      calls.push({ command, args });
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
    });
    expect(calls[0]).toEqual({ command: "claude", args: [
      "mcp", "add", "--scope", "user", "agent-bridge",
      "-e", "AGENT_BRIDGE_AGENT=claude-work",
      "-e", "AGENT_BRIDGE_INSTANCE=claude-machine-a",
      "-e", `AGENT_BRIDGE_CONFIG=${result.backendConfigPath}`,
      "--", "agent-bridge-mcp",
    ] });
  });

  it("merges Claude Desktop JSON without replacing other servers", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-desktop-"));
    directories.push(home);
    const result = installClient("claude-desktop", "claude-desktop", {
      env: { HOME: home, APPDATA: join(home, "AppData", "Roaming") },
      instance: "desktop-machine-a",
    });
    const config = JSON.parse(readFileSync(result.configPath!, "utf8"));
    expect(config.mcpServers["agent-bridge"]).toEqual({
      command: "agent-bridge-mcp",
      env: {
        AGENT_BRIDGE_AGENT: "claude-desktop",
        AGENT_BRIDGE_INSTANCE: "desktop-machine-a",
        AGENT_BRIDGE_CONFIG: result.backendConfigPath,
      },
    });
  });

  it("rejects an invalid native client scope", () => {
    expect(() => installClient("claude-code", "claude-work", {
      scope: "machine" as "user",
    })).toThrow("scope must be local, user, or project");
  });

  it("stores separate gateway credentials in private client configs", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installer-"));
    directories.push(home);
    const env = {
      HOME: home,
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: "https://bridge.example.test",
      AGENT_BRIDGE_WORKSPACE: "team",
    };
    const execute = () => ({
      pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null,
    });
    const codex = installClient("codex", "codex", {
      env,
      token: "codex-token",
      instance: "codex-machine",
    }, execute);
    const claude = installClient("claude-code", "claude-code", {
      env,
      token: "claude-token",
      instance: "claude-machine",
    }, execute);

    expect(codex.backendConfigPath).not.toBe(claude.backendConfigPath);
    expect(readFileSync(codex.backendConfigPath, "utf8")).toContain(
      "AGENT_BRIDGE_TOKEN=codex-token",
    );
    expect(readFileSync(claude.backendConfigPath, "utf8")).toContain(
      "AGENT_BRIDGE_TOKEN=claude-token",
    );
    if (process.platform !== "win32") {
      expect(statSync(codex.backendConfigPath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(codex.backendConfigPath)).mode & 0o777).toBe(0o700);
    }
  });

  it("restores the previous client config when native registration fails", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installer-"));
    directories.push(home);
    const env = {
      HOME: home,
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: "https://bridge.example.test",
      AGENT_BRIDGE_WORKSPACE: "team",
    };
    const success = () => ({
      pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null,
    });
    const installed = installClient("codex", "codex", {
      env,
      token: "working-token",
      instance: "stable-instance",
    }, success);

    expect(() => installClient("codex", "codex", {
      env,
      token: "replacement-token",
      instance: "stable-instance",
    }, () => ({
      pid: 1, output: [], stdout: "", stderr: "registration failed", status: 1, signal: null,
    }))).toThrow("registration failed");
    const retained = readFileSync(installed.backendConfigPath, "utf8");
    expect(retained).toContain("AGENT_BRIDGE_TOKEN=working-token");
    expect(retained).not.toContain("replacement-token");
  });
});
