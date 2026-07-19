import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { adoptClient } from "../src/client-lifecycle.js";
import { repairManagedClient, updateManagedClient } from "../src/client-maintenance.js";
import { listClientOperations } from "../src/client-operation.js";
import { securePrivatePath } from "../src/private-path.js";
import { privatePathIt } from "./private-path-policy.js";

const it = privatePathIt;

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

interface NativeRegistration {
  present: boolean;
  command: string;
  identity: string;
  instance: string;
  backendConfigPath: string;
}

function codexOutput(registration: NativeRegistration): string {
  return JSON.stringify({
    name: "agent-bridge", enabled: true,
    transport: {
      type: "stdio", command: registration.command, args: [],
      env: {
        AGENT_BRIDGE_AGENT: registration.identity,
        AGENT_BRIDGE_INSTANCE: registration.instance,
        AGENT_BRIDGE_CONFIG: registration.backendConfigPath,
      },
    },
  });
}

function claudeOutput(registration: NativeRegistration, scope: "local" | "user" | "project"): string {
  const scopeLine = {
    local: "  Scope: Local config (private to you in this project)",
    user: "  Scope: User config (available in all your projects)",
    project: "  Scope: Project config (shared via .mcp.json)",
  }[scope];
  return [
    "agent-bridge:", scopeLine, "  Type: stdio", `  Command: ${registration.command}`,
    "  Args:", "  Environment:",
    `    AGENT_BRIDGE_AGENT=${registration.identity}`,
    `    AGENT_BRIDGE_INSTANCE=${registration.instance}`,
    `    AGENT_BRIDGE_CONFIG=${registration.backendConfigPath}`,
    "", `To remove this server, run: claude mcp remove agent-bridge -s ${scope}`,
  ].join("\n");
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "agent-bridge-maintenance-"));
  homes.push(home); securePrivatePath(home, "directory");
  const clients = join(home, ".agent-bridge", "clients");
  mkdirSync(clients, { recursive: true, mode: 0o700 });
  securePrivatePath(join(home, ".agent-bridge"), "directory"); securePrivatePath(clients, "directory");
  const backendConfigPath = join(clients, "codex-existing.config");
  writeFileSync(backendConfigPath, "AGENT_BRIDGE_TOKEN=credential-sentinel-must-not-leak\n", { mode: 0o600 });
  securePrivatePath(backendConfigPath, "file");
  const registration: NativeRegistration = {
    present: true, command: "agent-bridge-mcp", identity: "codex-work",
    instance: "codex-existing", backendConfigPath,
  };
  const calls: Array<{ command: string; args: string[]; context?: { cwd?: string; env?: NodeJS.ProcessEnv } }> = [];
  let failAdd = false;
  const execute = (command: string, args: string[], context?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, context });
    if (args[0] === "mcp" && args[1] === "get") {
      return registration.present
        ? { pid: 1, output: [], stdout: codexOutput(registration), stderr: "", status: 0, signal: null }
        : { pid: 1, output: [], stdout: "Error: No MCP server named 'agent-bridge' found.\n", stderr: "", status: 1, signal: null };
    }
    if (args[0] === "mcp" && args[1] === "remove") {
      registration.present = false;
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
    }
    if (args[0] === "mcp" && args[1] === "add") {
      if (failAdd) throw new Error("intended add crash");
      registration.present = true;
      registration.command = args[args.length - 1]!;
      registration.identity = args.find((arg) => arg.startsWith("AGENT_BRIDGE_AGENT="))!.slice(19);
      registration.instance = args.find((arg) => arg.startsWith("AGENT_BRIDGE_INSTANCE="))!.slice(22);
      registration.backendConfigPath = args.find((arg) => arg.startsWith("AGENT_BRIDGE_CONFIG="))!.slice(20);
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
    }
    throw new Error(`unexpected native command: ${command} ${args.join(" ")}`);
  };
  const codexHome = join(home, "recorded-codex-home");
  const adopted = adoptClient("codex", "codex-work", {
    instance: registration.instance, backendConfigPath, apply: true,
    env: { HOME: home, CODEX_HOME: codexHome },
  }, execute);
  return {
    home, backendConfigPath, registration, calls, execute, adopted,
    setFailAdd(value: boolean) { failAdd = value; }, codexHome,
  };
}

function desktopFixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-bridge-maintenance-desktop-")));
  homes.push(home); securePrivatePath(home, "directory");
  const clients = join(home, ".agent-bridge", "clients"); mkdirSync(clients, { recursive: true, mode: 0o700 });
  securePrivatePath(join(home, ".agent-bridge"), "directory"); securePrivatePath(clients, "directory");
  const backendConfigPath = join(clients, "desktop-existing.config");
  writeFileSync(backendConfigPath, "AGENT_BRIDGE_TOKEN=desktop-sentinel\n", { mode: 0o600 }); securePrivatePath(backendConfigPath, "file");
  const oldCommand = join(home, "old-bridge"); const newCommand = join(home, "new-bridge");
  writeFileSync(oldCommand, "#!/bin/sh\n"); writeFileSync(newCommand, "#!/bin/sh\n");
  if (process.platform !== "win32") { chmodSync(oldCommand, 0o755); chmodSync(newCommand, 0o755); }
  const configPath = join(home, "desktop.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {
    "agent-bridge": { command: oldCommand, args: [], env: {
      AGENT_BRIDGE_AGENT: "desktop-work", AGENT_BRIDGE_INSTANCE: "desktop-existing", AGENT_BRIDGE_CONFIG: backendConfigPath,
    } },
  } }), { mode: 0o600 });
  const adopted = adoptClient("claude-desktop", "desktop-work", {
    instance: "desktop-existing", backendConfigPath, command: oldCommand, configPath, apply: true, env: { HOME: home },
  });
  return { home, backendConfigPath, oldCommand, newCommand, configPath, adopted };
}

describe("managed client repair and update", () => {
  it("uses strict metadata authority, leaves plan-only calls untouched, and reports no-op", () => {
    const state = fixture();
    chmodSync(state.backendConfigPath, 0o644);
    const before = lstatSync(state.backendConfigPath);
    const plan = repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work",
      env: { HOME: state.home }, execute: state.execute,
    });
    const after = lstatSync(state.backendConfigPath);
    expect(plan).toMatchObject(process.platform === "win32"
      ? { action: "none", applied: false, steps: [] }
      : { action: "repair", applied: false, steps: [{ action: "backend" }] });
    expect(after.ino).toBe(before.ino); expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(join(state.home, ".agent-bridge", "operations"))).toBe(false);

    repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      env: { HOME: state.home }, execute: state.execute,
    });
    if (process.platform !== "win32") expect(lstatSync(state.backendConfigPath).mode & 0o777).toBe(0o600);
    expect(repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work",
      env: { HOME: state.home }, execute: state.execute,
    }).action).toBe("none");

    const metadata = JSON.parse(readFileSync(state.adopted.metadataPath, "utf8"));
    metadata.unrecognized = true;
    writeFileSync(state.adopted.metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work",
      env: { HOME: state.home }, execute: state.execute,
    })).toThrow("managed metadata is invalid");
  });

  it("replays an interrupted native remove/add without snapshotting credentials", () => {
    const state = fixture();
    state.registration.command = "unexpected-command";
    state.setFailAdd(true);
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      env: { HOME: state.home }, execute: state.execute,
    })).toThrow("intended add crash");
    const [operation] = listClientOperations({ HOME: state.home });
    expect(operation).toMatchObject({ operation: "repair", inspectionState: "classification-required" });
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      env: { HOME: state.home }, execute: state.execute,
    })).toThrow("unfinished operation");
    const removeAt = state.calls.findIndex((call) => call.args[1] === "remove");
    const addAt = state.calls.findIndex((call) => call.args[1] === "add");
    expect(removeAt).toBeGreaterThanOrEqual(0); expect(addAt).toBeGreaterThan(removeAt);
    const snapshots = readdirSync(join(state.home, ".agent-bridge", "operations", operation.operationId, "snapshots"));
    for (const name of snapshots) {
      expect(readFileSync(join(state.home, ".agent-bridge", "operations", operation.operationId, "snapshots", name), "utf8"))
        .not.toContain("credential-sentinel-must-not-leak");
    }
    state.setFailAdd(false);
    const resumed = repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      resume: operation.operationId, env: { HOME: state.home }, execute: state.execute,
    });
    expect(resumed).toMatchObject({ action: "repair", applied: true });
    expect(state.registration.command).toBe("agent-bridge-mcp");
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "somebody-else", apply: true,
      resume: operation.operationId, env: { HOME: state.home }, execute: state.execute,
    })).toThrow("--identity must exactly match");
  }, 20_000);

  it("uses recorded Codex home and updates metadata only after native replacement", () => {
    const state = fixture();
    const suppliedEnv = { HOME: state.home, PATH: "/test/bin", PRESERVE_ME: "yes" };
    let metadataDuringAdd = "";
    const updateStart = state.calls.length;
    const execute = (command: string, args: string[], context?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      if (args[0] === "mcp" && args[1] === "add") metadataDuringAdd = readFileSync(state.adopted.metadataPath, "utf8");
      return state.execute(command, args, context);
    };
    const updated = updateManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", command: "new-agent-bridge-mcp",
      apply: true, env: suppliedEnv, execute,
    });
    expect(updated).toMatchObject({ action: "update", applied: true });
    expect(metadataDuringAdd).toContain('"command": "agent-bridge-mcp"');
    expect(readFileSync(state.adopted.metadataPath, "utf8")).toContain('"command": "new-agent-bridge-mcp"');
    for (const call of state.calls.slice(updateStart)) {
      expect(call.context?.env?.CODEX_HOME).toBe(state.codexHome);
      expect(call.context?.env?.PATH).toBe("/test/bin");
      expect(call.context?.env?.PRESERVE_ME).toBe("yes");
    }
  }, 20_000);

  it("uses the recorded Claude Code project scope and working directory", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-maintenance-claude-"));
    homes.push(home); securePrivatePath(home, "directory");
    const clients = join(home, ".agent-bridge", "clients");
    mkdirSync(clients, { recursive: true, mode: 0o700 });
    securePrivatePath(join(home, ".agent-bridge"), "directory"); securePrivatePath(clients, "directory");
    const backendConfigPath = join(clients, "claude-existing.config");
    writeFileSync(backendConfigPath, "AGENT_BRIDGE_TOKEN=claude-sentinel\n", { mode: 0o600 }); securePrivatePath(backendConfigPath, "file");
    const project = join(home, "recorded-project"); mkdirSync(project);
    const registration: NativeRegistration = {
      present: true, command: "agent-bridge-mcp", identity: "claude-work",
      instance: "claude-existing", backendConfigPath,
    };
    const calls: Array<{ args: string[]; context?: { cwd?: string } }> = [];
    const execute = (_command: string, args: string[], context?: { cwd?: string }) => {
      calls.push({ args, context });
      if (args[1] === "get") return registration.present
        ? { pid: 1, output: [], stdout: claudeOutput(registration, "project"), stderr: "", status: 0, signal: null }
        : { pid: 1, output: [], stdout: 'No MCP server named "agent-bridge".\n', stderr: "", status: 1, signal: null };
      if (args[1] === "remove") { registration.present = false; return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null }; }
      registration.present = true; registration.command = args[args.length - 1]!;
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
    };
    const original = process.cwd();
    let updateStart = 0;
    let recordedContext = "";
    try {
      process.chdir(project);
      recordedContext = process.cwd();
      adoptClient("claude-code", "claude-work", {
        instance: registration.instance, backendConfigPath, scope: "project", apply: true, env: { HOME: home },
      }, execute);
      updateStart = calls.length;
      updateManagedClient({
        runtime: "claude-code", instance: registration.instance, identity: "claude-work",
        command: "new-agent-bridge-mcp", apply: true, env: { HOME: home }, execute,
      });
    } finally { process.chdir(original); }
    const updateCalls = calls.slice(updateStart);
    const add = updateCalls.find((call) => call.args.join(" ").includes("mcp add --scope project agent-bridge"));
    expect(add?.context?.cwd).toBe(recordedContext);
  }, 20_000);

  it("replaces only the Desktop bridge entry and preserves unrelated JSON", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-maintenance-desktop-"));
    homes.push(home); securePrivatePath(home, "directory");
    const clients = join(home, ".agent-bridge", "clients"); mkdirSync(clients, { recursive: true, mode: 0o700 });
    securePrivatePath(join(home, ".agent-bridge"), "directory"); securePrivatePath(clients, "directory");
    const backendConfigPath = join(clients, "desktop-existing.config");
    writeFileSync(backendConfigPath, "AGENT_BRIDGE_TOKEN=desktop-sentinel\n", { mode: 0o600 }); securePrivatePath(backendConfigPath, "file");
    const oldCommand = join(home, "old-bridge"); const newCommand = join(home, "new-bridge");
    writeFileSync(oldCommand, "#!/bin/sh\n"); writeFileSync(newCommand, "#!/bin/sh\n");
    if (process.platform !== "win32") { chmodSync(oldCommand, 0o755); chmodSync(newCommand, 0o755); }
    const configPath = join(realpathSync(home), "desktop.json");
    const unrelated = { command: "/other-server", env: { TOKEN: "unrelated-sentinel" } };
    writeFileSync(configPath, JSON.stringify({ preserved: { value: true }, mcpServers: {
      other: unrelated,
      "agent-bridge": { command: oldCommand, args: [], env: {
        AGENT_BRIDGE_AGENT: "desktop-work", AGENT_BRIDGE_INSTANCE: "desktop-existing", AGENT_BRIDGE_CONFIG: backendConfigPath,
      } },
    } }));
    adoptClient("claude-desktop", "desktop-work", {
      instance: "desktop-existing", backendConfigPath, command: oldCommand, configPath, apply: true, env: { HOME: home },
    });
    updateManagedClient({
      runtime: "claude-desktop", instance: "desktop-existing", identity: "desktop-work",
      command: newCommand, apply: true, env: { HOME: home },
    });
    const updated = JSON.parse(readFileSync(configPath, "utf8"));
    expect(updated.preserved).toEqual({ value: true });
    expect(updated.mcpServers.other).toEqual(unrelated);
    expect(updated.mcpServers["agent-bridge"].command).toBe(newCommand);
    if (process.platform !== "win32") expect(lstatSync(configPath).mode & 0o077).toBe(0);
  }, 20_000);

  it("refuses a concurrent Desktop replacement and removes its known temporary file", () => {
    const state = desktopFixture();
    const replacement = join(state.home, "replacement.json");
    writeFileSync(replacement, JSON.stringify({ mcpServers: { other: { command: "/other" } } }), { mode: 0o600 });
    expect(() => updateManagedClient({
      runtime: "claude-desktop", instance: "desktop-existing", identity: "desktop-work",
      command: state.newCommand, apply: true, env: { HOME: state.home },
      testHooks: { desktop: { beforeRename: () => renameSync(replacement, state.configPath) } },
    })).toThrow("changed before publication");
    expect(JSON.parse(readFileSync(state.configPath, "utf8"))).toEqual({ mcpServers: { other: { command: "/other" } } });
    expect(readdirSync(state.home).some((name) => name.startsWith(".ab-"))).toBe(false);
  });

  it("cleans a failed Desktop temporary file and resumes a private post-rename publication", () => {
    const state = desktopFixture();
    expect(() => updateManagedClient({
      runtime: "claude-desktop", instance: "desktop-existing", identity: "desktop-work",
      command: state.newCommand, apply: true, env: { HOME: state.home },
      testHooks: { desktop: { afterTemporarySync: () => { throw new Error("temporary write failure"); } } },
    })).toThrow("temporary write failure");
    expect(readdirSync(state.home).some((name) => name.startsWith(".ab-"))).toBe(false);
    const [failed] = listClientOperations({ HOME: state.home });
    expect(() => updateManagedClient({
      runtime: "claude-desktop", instance: "desktop-existing", identity: "desktop-work",
      command: state.newCommand, apply: true, resume: failed.operationId, env: { HOME: state.home },
      testHooks: { desktop: { afterRename: () => { throw new Error("simulated post-rename crash"); } } },
    })).toThrow("simulated post-rename crash");
    if (process.platform !== "win32") expect(lstatSync(state.configPath).mode & 0o077).toBe(0);
    const [renamed] = listClientOperations({ HOME: state.home });
    const resumed = updateManagedClient({
      runtime: "claude-desktop", instance: "desktop-existing", identity: "desktop-work",
      command: state.newCommand, apply: true, resume: renamed.operationId, env: { HOME: state.home },
    });
    expect(resumed).toMatchObject({ action: "update", applied: true });
    expect(JSON.parse(readFileSync(state.configPath, "utf8")).mcpServers["agent-bridge"].command).toBe(state.newCommand);
  }, 20_000);

  it("repairs a Desktop update when only the recorded safe launch arguments differ", () => {
    const state = desktopFixture();
    const oldEntry = join(state.home, "old-entry.js");
    writeFileSync(oldEntry, "export {};\n");
    const metadata = JSON.parse(readFileSync(state.adopted.metadataPath, "utf8"));
    metadata.launch.args = [oldEntry];
    writeFileSync(state.adopted.metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    const config = JSON.parse(readFileSync(state.configPath, "utf8"));
    config.mcpServers["agent-bridge"].args = [oldEntry];
    writeFileSync(state.configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const updated = updateManagedClient({
      runtime: "claude-desktop", instance: "desktop-existing", identity: "desktop-work",
      command: state.newCommand, apply: true, env: { HOME: state.home },
    });
    expect(updated).toMatchObject({ action: "update", applied: true });
    expect(JSON.parse(readFileSync(state.configPath, "utf8")).mcpServers["agent-bridge"].args).toEqual([]);
  });

  it("rejects linked backend paths", () => {
    const state = fixture();
    const target = join(state.home, "linked-backend-target");
    writeFileSync(target, "AGENT_BRIDGE_TOKEN=other\n", { mode: 0o600 });
    rmSync(state.backendConfigPath);
    symlinkSync(target, state.backendConfigPath);
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work",
      env: { HOME: state.home }, execute: state.execute,
    })).toThrow("managed backend path cannot be a link");
  });

  it("refuses unsafe registration environment values before it creates a journal", () => {
    const state = fixture();
    const execute = (command: string, args: string[], context?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      if (args[1] !== "get" || !state.registration.present) return state.execute(command, args, context);
      const unsafe = JSON.parse(codexOutput(state.registration));
      unsafe.transport.env.AGENT_BRIDGE_TOKEN = "credential-sentinel-must-not-leak";
      return { pid: 1, output: [], stdout: JSON.stringify(unsafe), stderr: "", status: 0, signal: null };
    };
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      env: { HOME: state.home }, execute,
    })).toThrow("cannot be represented safely");
    expect(existsSync(join(state.home, ".agent-bridge", "operations"))).toBe(false);
  });

  it("refuses unsupported Codex execution settings before it creates a journal", () => {
    const state = fixture();
    const execute = (command: string, args: string[], context?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      if (args[1] !== "get" || !state.registration.present) return state.execute(command, args, context);
      const unsafe = JSON.parse(codexOutput(state.registration));
      unsafe.transport.cwd = state.home;
      return { pid: 1, output: [], stdout: JSON.stringify(unsafe), stderr: "", status: 0, signal: null };
    };
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      env: { HOME: state.home }, execute,
    })).toThrow("cannot be represented safely");
    expect(existsSync(join(state.home, ".agent-bridge", "operations"))).toBe(false);
  });

  it("rejects shell-like or credential-like native update commands before journaling", () => {
    for (const command of [
      "agent-bridge-mcp --token=secret",
      "https://example.test/mcp",
      "agent-bridge-mcp?token=secret",
      "agent-bridge-mcp#credential",
    ]) {
      const state = fixture();
      expect(() => updateManagedClient({
        runtime: "codex", instance: "codex-existing", identity: "codex-work", command, apply: true,
        env: { HOME: state.home }, execute: state.execute,
      })).toThrow("--command");
      expect(existsSync(join(state.home, ".agent-bridge", "operations"))).toBe(false);
    }
  });

  it("blocks resume when the safe registration observation changed during downtime", () => {
    const state = fixture();
    state.registration.command = "unexpected-command";
    state.setFailAdd(true);
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      env: { HOME: state.home }, execute: state.execute,
    })).toThrow("intended add crash");
    const [operation] = listClientOperations({ HOME: state.home });
    state.registration.present = true;
    state.registration.command = "different-safe-command";
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      resume: operation.operationId, env: { HOME: state.home }, execute: state.execute,
    })).toThrow("pending step state is ambiguous");
    expect(state.calls.filter((call) => call.args[1] === "add")).toHaveLength(1);
  }, 20_000);

  it("keeps registration proofs stable when safe host JSON key order changes", () => {
    const state = fixture();
    state.registration.command = "unexpected-command";
    let reverseEnvironment = false;
    const execute = (command: string, args: string[], context?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      if (args[1] !== "get" || !state.registration.present) return state.execute(command, args, context);
      const output = JSON.parse(codexOutput(state.registration));
      if (reverseEnvironment) {
        output.transport.env = {
          AGENT_BRIDGE_CONFIG: state.registration.backendConfigPath,
          AGENT_BRIDGE_INSTANCE: state.registration.instance,
          AGENT_BRIDGE_AGENT: state.registration.identity,
        };
      }
      return { pid: 1, output: [], stdout: JSON.stringify(output), stderr: "", status: 0, signal: null };
    };
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      env: { HOME: state.home }, execute,
      testHooks: { beforeApply: ({ action }) => { if (action === "native-remove") throw new Error("pause before remove"); } },
    })).toThrow("pause before remove");
    const [operation] = listClientOperations({ HOME: state.home });
    reverseEnvironment = true;
    expect(repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      resume: operation.operationId, env: { HOME: state.home }, execute,
    })).toMatchObject({ action: "repair", applied: true });
  }, 20_000);

  it("blocks resume when non-launch managed metadata changed", () => {
    const state = fixture();
    state.registration.command = "unexpected-command";
    state.setFailAdd(true);
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      env: { HOME: state.home }, execute: state.execute,
    })).toThrow("intended add crash");
    const [operation] = listClientOperations({ HOME: state.home });
    const metadata = JSON.parse(readFileSync(state.adopted.metadataPath, "utf8"));
    metadata.locator.configPath = join(realpathSync(state.home), "other-profile", "config.toml");
    writeFileSync(state.adopted.metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      resume: operation.operationId, env: { HOME: state.home }, execute: state.execute,
    })).toThrow("pending step state is ambiguous");
  }, 20_000);

  it("binds resume to the journaled identity before it runs a host command", () => {
    const state = fixture();
    state.registration.command = "unexpected-command";
    state.setFailAdd(true);
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      env: { HOME: state.home }, execute: state.execute,
    })).toThrow("intended add crash");
    const [operation] = listClientOperations({ HOME: state.home });
    const before = state.calls.length;
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "somebody-else", apply: true,
      resume: operation.operationId, env: { HOME: state.home }, execute: state.execute,
    })).toThrow("--identity must exactly match");
    expect(state.calls).toHaveLength(before);
  }, 20_000);

  it("rechecks full metadata authority after the lock and before every non-metadata write", () => {
    const state = fixture();
    state.registration.command = "drifted-agent-bridge-mcp";
    const metadata = JSON.parse(readFileSync(state.adopted.metadataPath, "utf8"));
    let hostMutation = false;
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      env: { HOME: state.home }, execute: (...args) => {
        if (args[1][1] !== "get") hostMutation = true;
        return state.execute(...args);
      },
      testHooks: {
        afterLock: () => {
          metadata.locator.configPath = join(realpathSync(state.home), "changed", "config.toml");
          writeFileSync(state.adopted.metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
        },
      },
    })).toThrow("while acquiring the client lock");
    expect(hostMutation).toBe(false);
  });

  it("does not chmod a backend replaced after its descriptors are pinned", () => {
    if (process.platform === "win32") return;
    const state = fixture();
    chmodSync(state.backendConfigPath, 0o644);
    const original = `${state.backendConfigPath}.original`;
    expect(() => repairManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", apply: true,
      env: { HOME: state.home }, execute: state.execute,
      testHooks: {
        afterBackendPin: () => {
          renameSync(state.backendConfigPath, original);
          writeFileSync(state.backendConfigPath, "AGENT_BRIDGE_TOKEN=replacement\n", { mode: 0o644 });
        },
      },
    })).toThrow("privacy repair failed");
    expect(lstatSync(state.backendConfigPath).mode & 0o777).toBe(0o644);
  });

  it("advances a post-metadata crash only while the full metadata target still matches", () => {
    const first = fixture();
    expect(() => updateManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", command: "new-agent-bridge-mcp",
      apply: true, env: { HOME: first.home }, execute: first.execute,
      testHooks: { afterApply: ({ action }) => { if (action === "metadata") throw new Error("pause after metadata"); } },
    })).toThrow("pause after metadata");
    const [matching] = listClientOperations({ HOME: first.home });
    expect(updateManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", command: "new-agent-bridge-mcp",
      apply: true, resume: matching.operationId, env: { HOME: first.home }, execute: first.execute,
    })).toMatchObject({ action: "update", applied: true });

    const changed = fixture();
    expect(() => updateManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", command: "new-agent-bridge-mcp",
      apply: true, env: { HOME: changed.home }, execute: changed.execute,
      testHooks: { afterApply: ({ action }) => { if (action === "metadata") throw new Error("pause after metadata"); } },
    })).toThrow("pause after metadata");
    const [mismatched] = listClientOperations({ HOME: changed.home });
    const metadata = JSON.parse(readFileSync(changed.adopted.metadataPath, "utf8"));
    metadata.locator.configPath = join(realpathSync(changed.home), "changed", "config.toml");
    writeFileSync(changed.adopted.metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    expect(() => updateManagedClient({
      runtime: "codex", instance: "codex-existing", identity: "codex-work", command: "new-agent-bridge-mcp",
      apply: true, resume: mismatched.operationId, env: { HOME: changed.home }, execute: changed.execute,
    })).toThrow("completed operation step");
  }, 30_000);
});
