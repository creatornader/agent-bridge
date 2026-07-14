import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readClientConfigFile, resolveClientConfig } from "./client-config.js";

export type InstallableRuntime = "codex" | "claude-code" | "claude-desktop";

export interface ClientInstallResult {
  runtime: InstallableRuntime;
  identity: string;
  instance: string;
  method: "native-cli" | "json-config";
  configPath?: string;
  backendConfigPath: string;
  restartRequired: boolean;
}

type Executor = (
  command: string,
  args: string[],
) => SpawnSyncReturns<string>;

function desktopConfigPath(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    const appData = env.APPDATA;
    if (!appData) throw new Error("APPDATA is required for Claude Desktop installation");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  const home = env.HOME ?? homedir();
  return process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : join(home, ".config", "Claude", "claude_desktop_config.json");
}

function safeComponent(value: string): string {
  const readable = value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 48) || "client";
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${readable}-${suffix}`;
}

function clientBackendConfigPath(
  runtime: InstallableRuntime,
  instance: string,
  env: NodeJS.ProcessEnv,
): string {
  const home = env.HOME ?? homedir();
  return join(
    home,
    ".agent-bridge",
    "clients",
    `${runtime}-${safeComponent(instance)}.config`,
  );
}

function replacePrivateFile(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function writeBackendConfig(
  runtime: InstallableRuntime,
  identity: string,
  instance: string,
  options: { token?: string; env: NodeJS.ProcessEnv },
): string {
  const env = options.env;
  const home = env.HOME ?? homedir();
  const sharedPath = env.AGENT_BRIDGE_CONFIG ?? join(home, ".agent-bridge", "config");
  const shared = readClientConfigFile(sharedPath);
  const configuredProvider = env.AGENT_BRIDGE_PROVIDER?.trim() || shared.AGENT_BRIDGE_PROVIDER?.trim();
  const inferredGateway = !configuredProvider && Boolean(
    env.AGENT_BRIDGE_TOKEN?.trim() || shared.AGENT_BRIDGE_TOKEN?.trim(),
  );
  const provider = configuredProvider === "legacy" || configuredProvider === "supabase"
    ? "legacy-supabase"
    : configuredProvider ?? (inferredGateway ? "gateway" : undefined);
  const clientToken = options.token?.trim() || env.AGENT_BRIDGE_CLIENT_TOKEN?.trim();
  if (provider === "gateway" && !clientToken) {
    throw new Error(
      "gateway client installation requires --token or AGENT_BRIDGE_CLIENT_TOKEN",
    );
  }
  const resolved = resolveClientConfig({
    ...env,
    AGENT_BRIDGE_AGENT: undefined,
    AGENT_BRIDGE_INSTANCE: undefined,
    AGENT_BRIDGE_TOKEN: clientToken ?? env.AGENT_BRIDGE_TOKEN,
  }, identity);
  const values: Record<string, string | undefined> = {
    AGENT_BRIDGE_PROVIDER: resolved.provider,
    AGENT_BRIDGE_WORKSPACE: resolved.principal.workspace,
    AGENT_BRIDGE_URL: resolved.url,
    AGENT_BRIDGE_TOKEN: resolved.provider === "gateway" ? resolved.credential : undefined,
    AGENT_BRIDGE_KEY: resolved.provider === "legacy-supabase" ? resolved.credential : undefined,
    AGENT_BRIDGE_DB: resolved.provider === "local" ? resolved.databasePath : undefined,
    AGENT_BRIDGE_EDGE_DB: resolved.provider === "gateway" ? resolved.edgeDatabasePath : undefined,
  };
  for (const value of Object.values(values)) {
    if (value?.includes("\n") || value?.includes("\r")) {
      throw new Error("client backend config values cannot contain newlines");
    }
  }
  const path = clientBackendConfigPath(runtime, instance, env);
  replacePrivateFile(
    path,
    `${Object.entries(values)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
  return path;
}

function writeJsonConfig(
  path: string,
  identity: string,
  instance: string,
  backendConfigPath: string,
  command: string,
): void {
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
      config = parsed;
    } catch {
      throw new Error(`Claude Desktop config is not valid JSON: ${path}`);
    }
  }
  const currentServers = config.mcpServers;
  const mcpServers = currentServers && !Array.isArray(currentServers) && typeof currentServers === "object"
    ? currentServers as Record<string, unknown>
    : {};
  const next = {
    ...config,
    mcpServers: {
      ...mcpServers,
      "agent-bridge": {
        command,
        env: {
          AGENT_BRIDGE_AGENT: identity,
          AGENT_BRIDGE_INSTANCE: instance,
          AGENT_BRIDGE_CONFIG: backendConfigPath,
        },
      },
    },
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function installClient(
  runtime: InstallableRuntime,
  identity: string,
  options: {
    command?: string;
    scope?: "local" | "user" | "project";
    instance?: string;
    token?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
  execute: Executor = (command, args) => spawnSync(command, args, { encoding: "utf8" }),
): ClientInstallResult {
  const normalizedIdentity = identity.trim();
  if (!normalizedIdentity || normalizedIdentity.length > 128) throw new Error("--identity is required");
  const instance = options.instance?.trim() || `${runtime}-${randomUUID()}`;
  if (instance.length > 128) throw new Error("--instance exceeds 128 characters");
  if (options.scope && !["local", "user", "project"].includes(options.scope)) {
    throw new Error("scope must be local, user, or project");
  }
  const command = options.command?.trim() || "agent-bridge-mcp";
  const env = options.env ?? process.env;
  const expectedPath = clientBackendConfigPath(runtime, instance, env);
  const previous = existsSync(expectedPath) ? readFileSync(expectedPath) : undefined;
  try {
    const backendConfigPath = writeBackendConfig(runtime, normalizedIdentity, instance, {
      token: options.token,
      env,
    });
    if (runtime === "claude-desktop") {
      const path = desktopConfigPath(env);
      writeJsonConfig(path, normalizedIdentity, instance, backendConfigPath, command);
      return { runtime, identity: normalizedIdentity, instance, method: "json-config", configPath: path, backendConfigPath, restartRequired: true };
    }
    const executable = runtime === "codex" ? "codex" : "claude";
    const args = runtime === "codex"
      ? [
          "mcp", "add", "agent-bridge",
          "--env", `AGENT_BRIDGE_AGENT=${normalizedIdentity}`,
          "--env", `AGENT_BRIDGE_INSTANCE=${instance}`,
          "--env", `AGENT_BRIDGE_CONFIG=${backendConfigPath}`,
          "--", command,
        ]
      : [
          "mcp", "add", "--scope", options.scope ?? "user", "agent-bridge",
          "-e", `AGENT_BRIDGE_AGENT=${normalizedIdentity}`,
          "-e", `AGENT_BRIDGE_INSTANCE=${instance}`,
          "-e", `AGENT_BRIDGE_CONFIG=${backendConfigPath}`,
          "--", command,
        ];
    const result = execute(executable, args);
    if (result.error || result.status !== 0) {
      const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
      throw new Error(`${runtime} MCP installation failed: ${detail}`);
    }
    return { runtime, identity: normalizedIdentity, instance, method: "native-cli", backendConfigPath, restartRequired: true };
  } catch (error) {
    try {
      if (previous) replacePrivateFile(expectedPath, previous);
      else rmSync(expectedPath, { force: true });
    } catch (rollbackError) {
      const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`${error instanceof Error ? error.message : String(error)}; client config rollback failed: ${detail}`);
    }
    throw error;
  }
}
