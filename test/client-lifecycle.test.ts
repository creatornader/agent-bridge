import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adoptClient, inspectClient } from "../src/client-lifecycle.js";
import { resolveDesktopLaunchContract } from "../src/client-installer.js";
import { securePrivatePath } from "../src/private-path.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(runtime: "codex" | "claude-code" = "codex") {
  const home = mkdtempSync(join(tmpdir(), "agent-bridge-lifecycle-"));
  directories.push(home);
  securePrivatePath(home, "directory");
  const backendConfigPath = join(home, ".agent-bridge", "clients", `${runtime}-existing.config`);
  mkdirSync(join(home, ".agent-bridge", "clients"), { recursive: true, mode: 0o700 });
  securePrivatePath(join(home, ".agent-bridge"), "directory");
  securePrivatePath(join(home, ".agent-bridge", "clients"), "directory");
  writeFileSync(backendConfigPath, "AGENT_BRIDGE_TOKEN=must-not-leak\n", { mode: 0o600 });
  securePrivatePath(backendConfigPath, "file");
  return { home, backendConfigPath };
}

function codexRegistration(identity: string, instance: string, backendConfigPath: string) {
  return JSON.stringify({
    startup_timeout_sec: 10,
    tool_timeout_sec: 60,
    name: "agent-bridge",
    status: { state: "ready", transport: "stdio" },
    disabled_reason: null,
    enabled_tools: null,
    disabled_tools: null,
    enabled: true,
    transport: {
      cwd: null,
      env_vars: [],
      type: "stdio",
      command: "agent-bridge-mcp",
      args: [],
      env: {
        AGENT_BRIDGE_AGENT: identity,
        AGENT_BRIDGE_INSTANCE: instance,
        AGENT_BRIDGE_CONFIG: backendConfigPath,
      },
    },
  });
}

describe("client lifecycle", () => {
  it("classifies an absent registration without writing local state", () => {
    const { home, backendConfigPath } = fixture();
    rmSync(backendConfigPath);
    const before = statSync(join(home, ".agent-bridge", "clients")).mtimeMs;
    const result = inspectClient("codex", "codex-work", {
      instance: "codex-existing",
      backendConfigPath,
      env: { HOME: home },
    }, () => ({ pid: 1, output: [], stdout: "Error: No MCP server named 'agent-bridge' found.\n", stderr: "", status: 1, signal: null }));

    expect(result).toMatchObject({ state: "absent", managed: false, exact: false });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(statSync(join(home, ".agent-bridge", "clients")).mtimeMs).toBe(before);
  });

  it("classifies backend residue without a registration as drifted", () => {
    const { home, backendConfigPath } = fixture();
    const result = inspectClient("codex", " codex-work ", {
      instance: " codex-existing ", backendConfigPath: ` ${backendConfigPath} `,
      env: { HOME: home },
    }, () => ({ pid: 1, output: [], stdout: "Error: No MCP server named 'agent-bridge' found.\n", stderr: "", status: 1, signal: null }));
    expect(result).toMatchObject({ state: "drifted", identity: "codex-work", instance: "codex-existing" });
  });

  it("plans adoption for an exact unmanaged registration without writing metadata", () => {
    const { home, backendConfigPath } = fixture();
    const execute = () => ({ pid: 1, output: [], stdout: codexRegistration("codex-work", "codex-existing", backendConfigPath), stderr: "", status: 0, signal: null });
    const inspection = inspectClient("codex", "codex-work", {
      instance: "codex-existing", backendConfigPath, env: { HOME: home },
    }, execute);
    const plan = adoptClient("codex", "codex-work", {
      instance: "codex-existing", backendConfigPath, env: { HOME: home },
    }, execute);

    expect(inspection).toMatchObject({ state: "unmanaged", managed: false, exact: true });
    expect(plan).toMatchObject({ action: "adopt", applied: false, before: "unmanaged", after: "managed" });
    expect(plan.metadataPath).toBeDefined();
    expect(() => statSync(plan.metadataPath)).toThrow();
  });

  it("applies adoption with owner-only secret-free metadata and then reports managed", () => {
    const { home, backendConfigPath } = fixture();
    const execute = () => ({ pid: 1, output: [], stdout: codexRegistration("codex-work", "codex-existing", backendConfigPath), stderr: "", status: 0, signal: null });
    const adopted = adoptClient("codex", "codex-work", {
      instance: "codex-existing", backendConfigPath, apply: true, env: { HOME: home },
    }, execute);
    const metadata = readFileSync(adopted.metadataPath, "utf8");

    expect(adopted).toMatchObject({ action: "adopt", applied: true, before: "unmanaged", after: "managed" });
    expect(metadata).not.toContain("must-not-leak");
    expect(metadata).not.toContain("TOKEN");
    if (process.platform !== "win32") expect(statSync(adopted.metadataPath).mode & 0o077).toBe(0);
    expect(inspectClient("codex", "codex-work", {
      instance: "codex-existing", backendConfigPath, env: { HOME: home },
    }, execute).state).toBe("managed");

    const parsed = JSON.parse(metadata);
    const reordered = {
      launch: { scope: parsed.launch.scope, args: parsed.launch.args, command: parsed.launch.command },
      backendConfigPath: parsed.backendConfigPath,
      instance: parsed.instance,
      identity: parsed.identity,
      runtime: parsed.runtime,
      version: parsed.version,
      schema: parsed.schema,
      locator: parsed.locator,
    };
    writeFileSync(adopted.metadataPath, JSON.stringify(reordered), { mode: 0o600 });
    expect(inspectClient("codex", "codex-work", {
      instance: "codex-existing", backendConfigPath, env: { HOME: home },
    }, execute).state).toBe("managed");
  });

  it("keeps inspect and plan-only adoption byte, inode, and mtime stable", () => {
    const { home, backendConfigPath } = fixture();
    const execute = () => ({ pid: 1, output: [], stdout: codexRegistration("codex-work", "codex-existing", backendConfigPath), stderr: "", status: 0, signal: null });
    const before = statSync(backendConfigPath);
    const content = readFileSync(backendConfigPath);
    inspectClient("codex", "codex-work", { instance: "codex-existing", backendConfigPath, env: { HOME: home } }, execute);
    adoptClient("codex", "codex-work", { instance: "codex-existing", backendConfigPath, env: { HOME: home } }, execute);
    const after = statSync(backendConfigPath);
    expect(readFileSync(backendConfigPath)).toEqual(content);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("rejects insecure or linked backend residue", () => {
    if (process.platform === "win32") return;
    const insecure = fixture();
    chmodSync(join(insecure.home, ".agent-bridge", "clients"), 0o755);
    const exact = () => ({ pid: 1, output: [], stdout: codexRegistration("codex-work", "codex-existing", insecure.backendConfigPath), stderr: "", status: 0, signal: null });
    expect(inspectClient("codex", "codex-work", { instance: "codex-existing", backendConfigPath: insecure.backendConfigPath, env: { HOME: insecure.home } }, exact).state).toBe("drifted");

    const looseFile = fixture();
    chmodSync(looseFile.backendConfigPath, 0o644);
    const looseExact = () => ({ pid: 1, output: [], stdout: codexRegistration("codex-work", "codex-existing", looseFile.backendConfigPath), stderr: "", status: 0, signal: null });
    expect(inspectClient("codex", "codex-work", { instance: "codex-existing", backendConfigPath: looseFile.backendConfigPath, env: { HOME: looseFile.home } }, looseExact).state).toBe("drifted");

    const linked = fixture();
    const target = join(linked.home, "target.config");
    writeFileSync(target, "safe\n", { mode: 0o600 });
    rmSync(linked.backendConfigPath);
    symlinkSync(target, linked.backendConfigPath);
    const linkedExact = () => ({ pid: 1, output: [], stdout: codexRegistration("codex-work", "codex-existing", linked.backendConfigPath), stderr: "", status: 0, signal: null });
    expect(inspectClient("codex", "codex-work", { instance: "codex-existing", backendConfigPath: linked.backendConfigPath, env: { HOME: linked.home } }, linkedExact).state).toBe("drifted");
  });

  it("rejects managed metadata reached through a linked management root", () => {
    if (process.platform === "win32") return;
    const { home, backendConfigPath } = fixture();
    const execute = () => ({ pid: 1, output: [], stdout: codexRegistration("codex-work", "codex-existing", backendConfigPath), stderr: "", status: 0, signal: null });
    adoptClient("codex", "codex-work", {
      instance: "codex-existing", backendConfigPath, apply: true, env: { HOME: home },
    }, execute);
    const external = mkdtempSync(join(tmpdir(), "agent-bridge-lifecycle-external-"));
    directories.push(external);
    const relocated = join(external, "agent-bridge");
    renameSync(join(home, ".agent-bridge"), relocated);
    symlinkSync(relocated, join(home, ".agent-bridge"), "dir");

    expect(inspectClient("codex", "codex-work", {
      instance: "codex-existing", backendConfigPath, env: { HOME: home },
    }, execute).state).toBe("drifted");
  });

  it("fails adoption when the registration changes before the postcondition", () => {
    const { home, backendConfigPath } = fixture();
    let calls = 0;
    const execute = () => ({
      pid: 1, output: [], stderr: "", status: 0, signal: null,
      stdout: codexRegistration(calls++ === 0 ? "codex-work" : "raced-work", "codex-existing", backendConfigPath),
    });
    expect(() => adoptClient("codex", "codex-work", {
      instance: "codex-existing", backendConfigPath, apply: true, env: { HOME: home },
    }, execute)).toThrow("client registration changed while adoption was applied");
  });

  it("reports drift and refuses adoption when identity or launch contract is inexact", () => {
    const { home, backendConfigPath } = fixture();
    const execute = () => ({ pid: 1, output: [], stdout: codexRegistration("somebody-else", "codex-existing", backendConfigPath), stderr: "", status: 0, signal: null });
    const inspection = inspectClient("codex", "codex-work", {
      instance: "codex-existing", backendConfigPath, env: { HOME: home },
    }, execute);

    expect(inspection).toMatchObject({ state: "drifted", managed: false, exact: false });
    expect(() => adoptClient("codex", "codex-work", {
      instance: "codex-existing", backendConfigPath, apply: true, env: { HOME: home },
    }, execute)).toThrow("only an exact unmanaged registration can be adopted");
  });

  it("records the requested Claude Code scope and rejects another scope", () => {
    const { home, backendConfigPath } = fixture("claude-code");
    const execute = () => ({
      pid: 1, output: [], stderr: "", status: 0, signal: null,
      stdout: [
        "agent-bridge:",
        "  Scope: User config (available in all your projects)",
        "  Status: disconnected",
        "  Type: stdio",
        "  Command: agent-bridge-mcp",
        "  Args:",
        "  Environment:",
        "    AGENT_BRIDGE_CONFIG=" + backendConfigPath,
        "    AGENT_BRIDGE_AGENT=claude-work",
        "    AGENT_BRIDGE_INSTANCE=claude-existing",
        "",
        "To remove this server, run: claude mcp remove agent-bridge -s user",
      ].join("\n"),
    });

    const options = {
      instance: "claude-existing", backendConfigPath, scope: "user", env: { HOME: home },
    } as const;
    const adopted = adoptClient("claude-code", "claude-work", { ...options, apply: true }, execute);
    const metadata = JSON.parse(readFileSync(adopted.metadataPath, "utf8"));

    expect(adopted.after).toBe("managed");
    expect(adopted.inspection.registrationLocator).toEqual({
      kind: "claude-code-scope", scope: "user", contextPath: null,
    });
    expect(metadata.locator).toEqual({
      kind: "claude-code-scope", scope: "user", contextPath: null,
    });
    expect(inspectClient("claude-code", "claude-work", {
      instance: "claude-existing", backendConfigPath, scope: "project", env: { HOME: home },
    }, execute).state).toBe("drifted");
  });

  it("binds Claude Code project scope to its invocation directory", () => {
    const { home, backendConfigPath } = fixture("claude-code");
    const projectContext = join(home, "project-context");
    const otherContext = join(home, "other-context");
    mkdirSync(projectContext);
    mkdirSync(otherContext);
    const execute = () => ({
      pid: 1, output: [], stderr: "", status: 0, signal: null,
      stdout: [
        "agent-bridge:",
        "  Scope: Project config (shared via .mcp.json)",
        "  Type: stdio",
        "  Command: agent-bridge-mcp",
        "  Args:",
        "  Environment:",
        "    AGENT_BRIDGE_CONFIG=" + backendConfigPath,
        "    AGENT_BRIDGE_AGENT=claude-work",
        "    AGENT_BRIDGE_INSTANCE=claude-project",
        "",
        "To remove this server, run: claude mcp remove agent-bridge -s project",
      ].join("\n"),
    });
    const originalContext = process.cwd();
    try {
      process.chdir(projectContext);
      const adopted = adoptClient("claude-code", "claude-work", {
        instance: "claude-project", backendConfigPath, scope: "project",
        apply: true, env: { HOME: home },
      }, execute);

      expect(adopted.inspection.registrationLocator).toEqual({
        kind: "claude-code-scope", scope: "project", contextPath: process.cwd(),
      });
      expect(inspectClient("claude-code", "claude-work", {
        instance: "claude-project", backendConfigPath, scope: "project",
        env: { HOME: home },
      }, execute).state).toBe("managed");
      process.chdir(otherContext);
      expect(inspectClient("claude-code", "claude-work", {
        instance: "claude-project", backendConfigPath, scope: "project",
        env: { HOME: home },
      }, execute).state).toBe("drifted");
    } finally {
      process.chdir(originalContext);
    }
  });

  it("binds Codex adoption to the canonical profile config", () => {
    const { home, backendConfigPath } = fixture();
    const codexHome = join(home, "codex-profile");
    const alternateCodexHome = join(home, "other-codex-profile");
    const execute = () => ({
      pid: 1, output: [], stderr: "", status: 0, signal: null,
      stdout: codexRegistration("codex-work", "codex-existing", backendConfigPath),
    });
    const adopted = adoptClient("codex", "codex-work", {
      instance: "codex-existing", backendConfigPath, apply: true,
      env: { HOME: home, CODEX_HOME: codexHome },
    }, execute);
    const metadata = JSON.parse(readFileSync(adopted.metadataPath, "utf8"));

    expect(metadata.locator).toEqual({
      kind: "codex-profile", configPath: join(codexHome, "config.toml"),
    });
    expect(adopted.inspection.registrationLocator).toEqual(metadata.locator);
    expect(inspectClient("codex", "codex-work", {
      instance: "codex-existing", backendConfigPath,
      env: { HOME: home, CODEX_HOME: alternateCodexHome },
    }, execute).state).toBe("drifted");
  });

  it("verifies the exact Claude Desktop absolute launch contract", () => {
    const { home, backendConfigPath } = fixture("claude-code");
    const executable = join(home, "agent-bridge-mcp");
    writeFileSync(executable, "#!/bin/sh\n");
    if (process.platform !== "win32") chmodSync(executable, 0o755);
    const configPath = join(home, "desktop.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { "agent-bridge": {
      command: executable,
      args: [],
      env: {
        AGENT_BRIDGE_AGENT: "desktop-work",
        AGENT_BRIDGE_INSTANCE: "desktop-existing",
        AGENT_BRIDGE_CONFIG: backendConfigPath,
      },
    } } }));

    expect(inspectClient("claude-desktop", "desktop-work", {
      instance: "desktop-existing", backendConfigPath, command: executable,
      configPath, env: { HOME: home },
    }).state).toBe("unmanaged");
    expect(inspectClient("claude-desktop", "desktop-work", {
      instance: "desktop-existing", backendConfigPath, command: process.execPath,
      configPath, env: { HOME: home },
    }).state).toBe("drifted");
  });

  it("uses the installer's default Desktop launch contract and rejects invalid launchers", () => {
    const { home, backendConfigPath } = fixture("claude-code");
    const launch = resolveDesktopLaunchContract(undefined, { HOME: home });
    const configPath = join(home, "desktop-default.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { "agent-bridge": {
      command: launch.command, args: launch.args,
      env: { AGENT_BRIDGE_AGENT: "desktop-work", AGENT_BRIDGE_INSTANCE: "desktop-existing", AGENT_BRIDGE_CONFIG: backendConfigPath },
    } } }));
    expect(inspectClient("claude-desktop", "desktop-work", {
      instance: "desktop-existing", backendConfigPath, configPath, env: { HOME: home },
    }).state).toBe("unmanaged");
    expect(() => inspectClient("claude-desktop", "desktop-work", {
      instance: "desktop-existing", backendConfigPath, command: join(home, "missing"), configPath,
      env: { HOME: home },
    })).toThrow("Claude Desktop MCP executable does not exist");
  });

  it("keeps Desktop host JSON unchanged during inspect and plan-only adoption", () => {
    const { home, backendConfigPath } = fixture("claude-code");
    const executable = join(home, "agent-bridge-mcp");
    writeFileSync(executable, "#!/bin/sh\n");
    if (process.platform !== "win32") chmodSync(executable, 0o755);
    const configPath = join(home, "desktop-stable.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { "agent-bridge": {
      command: executable, args: [],
      env: { AGENT_BRIDGE_AGENT: "desktop-work", AGENT_BRIDGE_INSTANCE: "desktop-existing", AGENT_BRIDGE_CONFIG: backendConfigPath },
    } } }));
    const options = {
      instance: "desktop-existing", backendConfigPath, command: executable,
      configPath, env: { HOME: home },
    };
    const before = statSync(configPath);
    const content = readFileSync(configPath);
    const inspection = inspectClient("claude-desktop", "desktop-work", options);
    const plan = adoptClient("claude-desktop", "desktop-work", options);
    const after = statSync(configPath);

    expect(inspection.state).toBe("unmanaged");
    expect(plan.applied).toBe(false);
    expect(readFileSync(configPath)).toEqual(content);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(plan.metadataPath)).toBe(false);
  });

  it("binds Desktop adoption to the inspected custom config path", () => {
    const { home, backendConfigPath } = fixture("claude-code");
    const executable = join(home, "agent-bridge-mcp");
    writeFileSync(executable, "#!/bin/sh\n");
    if (process.platform !== "win32") chmodSync(executable, 0o755);
    const adoptedConfigPath = join(home, "desktop-adopted.json");
    const otherConfigPath = join(home, "desktop-other.json");
    const registration = {
      command: executable,
      args: [],
      env: {
        AGENT_BRIDGE_AGENT: "desktop-work",
        AGENT_BRIDGE_INSTANCE: "desktop-existing",
        AGENT_BRIDGE_CONFIG: backendConfigPath,
      },
    };
    writeFileSync(adoptedConfigPath, JSON.stringify({ mcpServers: { "agent-bridge": registration } }));
    writeFileSync(otherConfigPath, JSON.stringify({ mcpServers: { "agent-bridge": registration } }));
    const options = {
      instance: "desktop-existing", backendConfigPath, command: executable,
      configPath: adoptedConfigPath, env: { HOME: home },
    };
    const adopted = adoptClient("claude-desktop", "desktop-work", { ...options, apply: true });
    const metadata = JSON.parse(readFileSync(adopted.metadataPath, "utf8"));
    const adoptedBefore = statSync(adoptedConfigPath);
    const otherBefore = statSync(otherConfigPath);

    expect(metadata.locator).toEqual({
      kind: "claude-desktop-config", configPath: adoptedConfigPath,
    });
    expect(adopted.inspection.registrationLocator).toEqual(metadata.locator);
    expect(inspectClient("claude-desktop", "desktop-work", {
      ...options, configPath: otherConfigPath,
    }).state).toBe("drifted");
    expect(inspectClient("claude-desktop", "desktop-work", options).state).toBe("managed");
    expect(statSync(adoptedConfigPath).mtimeMs).toBe(adoptedBefore.mtimeMs);
    expect(statSync(otherConfigPath).mtimeMs).toBe(otherBefore.mtimeMs);
  });
});
