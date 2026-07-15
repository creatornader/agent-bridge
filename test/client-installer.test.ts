import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installClient } from "../src/client-installer.js";
import {
  createPendingEnrollment,
  defaultEnrollmentPath,
  readEnrollment,
  transitionEnrollment,
  type EnrollmentFile,
} from "../src/enrollment-file.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("client installer", () => {
  function readyEnrollment(
    home: string,
    operation: "provision" | "rotate" = "provision",
    token = "enrolled-token",
    runtime: "codex" | "claude-code" | "claude-desktop" = "codex",
  ): { path: string; enrollment: EnrollmentFile } {
    const requestId = randomUUID();
    const env = { HOME: home };
    const enrollment: EnrollmentFile = {
      schema: "agent-bridge.enrollment",
      version: 1,
      provider: "gateway",
      revision: 0,
      state: "pending",
      operation,
      requestId,
      createdAt: new Date().toISOString(),
      completedAt: null,
      input: {
        gatewayUrl: "https://bridge.example.test",
        workspaceId: "team",
        principal: "codex",
        runtime,
        instance: runtime + "-enrolled-instance",
        credentialId: operation === "rotate" ? randomUUID() : null,
        workspaceName: operation === "provision" ? "Team" : null,
        displayName: null,
        runtimeType: runtime,
        label: null,
        scopeSetName: "release-a-full",
        expiresAt: null,
        graceUntil: null,
        invalidateImmediately: operation === "rotate",
      },
      token,
      result: null,
    };
    const path = defaultEnrollmentPath(requestId, env);
    createPendingEnrollment(path, enrollment, env);
    const ready = transitionEnrollment(path, enrollment, "ready", {
      completedAt: new Date().toISOString(),
      result: {
        workspaceId: "team",
        principal: "codex",
        agentId: operation === "provision" ? randomUUID() : null,
        credentialId: randomUUID(),
        replayed: false,
      },
    }, env);
    return { path, enrollment: ready };
  }

  function codexRegistration(enrollment: EnrollmentFile, backendConfigPath: string): string {
    return JSON.stringify({
      name: "agent-bridge",
      enabled: true,
      transport: {
        type: "stdio",
        command: "agent-bridge-mcp",
        args: [],
        env: {
          AGENT_BRIDGE_AGENT: enrollment.input.principal,
          AGENT_BRIDGE_INSTANCE: enrollment.input.instance,
          AGENT_BRIDGE_CONFIG: backendConfigPath,
        },
      },
    });
  }

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

  it("installs a provision enrollment without exposing its token in argv", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installer-"));
    directories.push(home);
    const { path, enrollment } = readyEnrollment(home);
    const calls: Array<{ command: string; args: string[] }> = [];
    let backendConfigPath = "";
    let inspections = 0;
    const result = installClient("codex", "", {
      enrollmentFile: path,
      env: { HOME: home },
    }, (command, args) => {
      calls.push({ command, args });
      const get = args.slice(0, 2).join(" ") === "mcp get";
      if (get) {
        inspections += 1;
        return {
          pid: 1,
          output: [],
          stdout: inspections === 1
            ? "Error: No MCP server named 'agent-bridge' found.\n"
            : codexRegistration(enrollment, backendConfigPath),
          stderr: "",
          status: inspections === 1 ? 1 : 0,
          signal: null,
        };
      }
      backendConfigPath = args.find((value) => value.startsWith("AGENT_BRIDGE_CONFIG="))!
        .slice("AGENT_BRIDGE_CONFIG=".length);
      return {
        pid: 1,
        output: [],
        stdout: "",
        stderr: "",
        status: 0,
        signal: null,
      };
    });
    expect(result).toMatchObject({
      installed: true,
      enrollmentDeleted: true,
      enrollmentStatus: "consumed",
    });
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(result.backendConfigPath, "utf8")).toContain(
      "AGENT_BRIDGE_TOKEN=enrolled-token",
    );
    expect(JSON.stringify(calls)).not.toContain("enrolled-token");
  });

  it("rolls a failed provision install back to ready for retry", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installer-"));
    directories.push(home);
    const { path } = readyEnrollment(home);
    expect(() => installClient("codex", "", {
      enrollmentFile: path,
      env: { HOME: home },
    }, (_command, args) => ({
      pid: 1,
      output: [],
      stdout: args.slice(0, 2).join(" ") === "mcp get"
        ? "Error: No MCP server named 'agent-bridge' found.\n"
        : "",
      stderr: args.slice(0, 2).join(" ") === "mcp get" ? "" : "registration failed",
      status: 1,
      signal: null,
    }))).toThrow(/registration failed/);
    expect(readEnrollment(path, { HOME: home }).state).toBe("ready");
  });

  it("recovers a consuming provision after exact host registration", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installer-"));
    directories.push(home);
    const { path, enrollment: ready } = readyEnrollment(home);
    const seeded = installClient("codex", "codex", {
      instance: ready.input.instance,
      token: ready.token!,
      backendBinding: {
        credentialId: ready.result!.credentialId,
        principal: ready.input.principal,
        instance: ready.input.instance,
      },
      env: {
        HOME: home,
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: ready.input.gatewayUrl,
        AGENT_BRIDGE_WORKSPACE: ready.input.workspaceId,
      },
    }, () => ({
      pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null,
    }));
    transitionEnrollment(path, ready, "consuming", {}, { HOME: home });
    let adds = 0;
    const result = installClient("codex", "", {
      enrollmentFile: path,
      env: { HOME: home },
    }, (_command, args) => {
      if (args.includes("add")) adds += 1;
      return {
        pid: 1,
        output: [],
        stdout: codexRegistration(ready, seeded.backendConfigPath),
        stderr: "",
        status: 0,
        signal: null,
      };
    });
    expect(adds).toBe(0);
    expect(result.enrollmentDeleted).toBe(true);
  });

  it("rotates only the exact backend config and never registers the host", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installer-"));
    directories.push(home);
    const { path, enrollment } = readyEnrollment(home, "rotate", "rotated-token");
    const seeded = installClient("codex", "codex", {
      instance: "codex-enrolled-instance",
      token: "old-token",
      backendBinding: {
        credentialId: enrollment.input.credentialId!,
        principal: enrollment.input.principal,
        instance: enrollment.input.instance,
      },
      env: {
        HOME: home,
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: enrollment.input.gatewayUrl,
        AGENT_BRIDGE_WORKSPACE: "team",
      },
    }, () => ({
      pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null,
    }));
    let adds = 0;
    const result = installClient("codex", "", {
      enrollmentFile: path,
      env: { HOME: home },
    }, (_command, args) => {
      if (args.includes("add")) adds += 1;
      return {
        pid: 1,
        output: [],
        stdout: codexRegistration(enrollment, seeded.backendConfigPath),
        stderr: "",
        status: 0,
        signal: null,
      };
    });
    expect(adds).toBe(0);
    expect(result.backendConfigPath).toBe(seeded.backendConfigPath);
    expect(readFileSync(seeded.backendConfigPath, "utf8")).toContain(
      "AGENT_BRIDGE_TOKEN=rotated-token",
    );
  });

  it("fails closed when MCP inspection is not a recognized absence", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installer-"));
    directories.push(home);
    const { path } = readyEnrollment(home);
    expect(() => installClient("codex", "", {
      enrollmentFile: path,
      env: { HOME: home },
    }, () => ({
      pid: 1,
      output: [],
      stdout: "",
      stderr: "permission denied",
      status: 1,
      signal: null,
    }))).toThrow(/MCP inspection failed/);
    expect(readEnrollment(path, { HOME: home }).state).toBe("ready");
  });

  it("keeps a post-add verification failure in consuming state", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installer-"));
    directories.push(home);
    const { path } = readyEnrollment(home);
    expect(() => installClient("codex", "", {
      enrollmentFile: path,
      env: { HOME: home },
    }, (_command, args) => ({
      pid: 1,
      output: [],
      stdout: args.slice(0, 2).join(" ") === "mcp get"
        ? "Error: No MCP server named 'agent-bridge' found.\n"
        : "",
      stderr: "",
      status: args.slice(0, 2).join(" ") === "mcp get" ? 1 : 0,
      signal: null,
    }))).toThrow(/verification failed/);
    const retained = readEnrollment(path, { HOME: home });
    expect(retained).toMatchObject({ state: "consuming", token: "enrolled-token" });
  });

  it("refuses rotation of a legacy metadata-less backend", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installer-"));
    directories.push(home);
    const { path, enrollment } = readyEnrollment(home, "rotate", "rotated-token");
    installClient("codex", "codex", {
      instance: enrollment.input.instance,
      token: "old-token",
      env: {
        HOME: home,
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: enrollment.input.gatewayUrl,
        AGENT_BRIDGE_WORKSPACE: enrollment.input.workspaceId,
      },
    }, () => ({
      pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null,
    }));
    expect(() => installClient("codex", "", {
      enrollmentFile: path,
      env: { HOME: home },
    }, () => ({
      pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null,
    }))).toThrow(/exactly bound predecessor or successor backend/);
    expect(readEnrollment(path, { HOME: home }).state).toBe("ready");
  });

  it("revalidates consumed enrollment state before deleting the file", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installer-"));
    directories.push(home);
    const { path, enrollment: ready } = readyEnrollment(home);
    installClient("codex", "codex", {
      instance: ready.input.instance,
      token: ready.token!,
      backendBinding: {
        credentialId: ready.result!.credentialId,
        principal: ready.input.principal,
        instance: ready.input.instance,
      },
      env: {
        HOME: home,
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: ready.input.gatewayUrl,
        AGENT_BRIDGE_WORKSPACE: ready.input.workspaceId,
      },
    }, () => ({ pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null }));
    const consuming = transitionEnrollment(path, ready, "consuming", {}, { HOME: home });
    transitionEnrollment(path, consuming, "consumed", { token: null }, { HOME: home });
    expect(() => installClient("codex", "", {
      enrollmentFile: path,
      env: { HOME: home },
    }, () => ({
      pid: 1,
      output: [],
      stdout: "Error: No MCP server named 'agent-bridge' found.\n",
      stderr: "",
      status: 1,
      signal: null,
    }))).toThrow(/no longer matches its MCP registration/);
    expect(readEnrollment(path, { HOME: home })).toMatchObject({ state: "consumed", token: null });
  });

  it("finalizes a consuming rotation whose successor backend was already written", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installer-"));
    directories.push(home);
    const { path, enrollment: ready } = readyEnrollment(home, "rotate", "successor-token");
    const seeded = installClient("codex", "codex", {
      instance: ready.input.instance,
      token: ready.token!,
      backendBinding: {
        credentialId: ready.result!.credentialId,
        principal: ready.input.principal,
        instance: ready.input.instance,
      },
      env: {
        HOME: home,
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: ready.input.gatewayUrl,
        AGENT_BRIDGE_WORKSPACE: ready.input.workspaceId,
      },
    }, () => ({ pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null }));
    transitionEnrollment(path, ready, "consuming", {}, { HOME: home });
    const inode = statSync(seeded.backendConfigPath).ino;
    let adds = 0;
    const result = installClient("codex", "", {
      enrollmentFile: path,
      env: { HOME: home },
    }, (_command, args) => {
      if (args.includes("add")) adds += 1;
      return {
        pid: 1,
        output: [],
        stdout: codexRegistration(ready, seeded.backendConfigPath),
        stderr: "",
        status: 0,
        signal: null,
      };
    });
    expect(adds).toBe(0);
    if (process.platform !== "win32") expect(statSync(seeded.backendConfigPath).ino).toBe(inode);
    expect(result.enrollmentStatus).toBe("consumed");
  });

  it("rejects appended Claude not-found diagnostics and inexact scope proof", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-installer-"));
    directories.push(home);
    const first = readyEnrollment(home, "provision", "claude-token", "claude-code");
    expect(() => installClient("claude-code", "", {
      enrollmentFile: first.path,
      env: { HOME: home },
    }, () => ({
      pid: 1,
      output: [],
      stdout: 'No MCP server named "agent-bridge".\npermission denied\n',
      stderr: "",
      status: 1,
      signal: null,
    }))).toThrow(/MCP inspection failed/);
    expect(readEnrollment(first.path, { HOME: home }).state).toBe("ready");

    const second = readyEnrollment(home, "provision", "claude-token-2", "claude-code");
    let reads = 0;
    expect(() => installClient("claude-code", "", {
      enrollmentFile: second.path,
      env: { HOME: home },
    }, (_command, args) => {
      const get = args.slice(0, 2).join(" ") === "mcp get";
      if (get) reads += 1;
      return {
        pid: 1,
        output: [],
        stdout: !get ? "" : reads === 1
          ? 'No MCP server named "agent-bridge".\n'
          : [
              "agent-bridge:",
              "  Scope: User config (available in all your projects) appended",
              "  Status: ✔ Connected",
              "  Type: stdio",
              "  Command: agent-bridge-mcp",
              "  Args:",
              "  Environment:",
              "    AGENT_BRIDGE_AGENT=claude-code",
              "    AGENT_BRIDGE_INSTANCE=" + second.enrollment.input.instance,
              "    AGENT_BRIDGE_CONFIG=" + join(
                home, ".agent-bridge", "clients",
                "claude-code-" + second.enrollment.input.instance,
              ),
              "",
              "To remove this server, run: claude mcp remove agent-bridge -s user",
            ].join("\n"),
        stderr: "",
        status: get && reads === 1 ? 1 : 0,
        signal: null,
      };
    })).toThrow(/verification failed/);
    expect(readEnrollment(second.path, { HOME: home }).state).toBe("consuming");
  });
});
