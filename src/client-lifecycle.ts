import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { verifyPrivatePathAccess, securePrivatePath } from "./private-path.js";
import {
  resolveDesktopLaunchContract,
  type InstallableRuntime,
} from "./client-installer.js";

export type ClientLifecycleState = "absent" | "unmanaged" | "managed" | "drifted";

type Executor = (command: string, args: string[]) => SpawnSyncReturns<string>;

export interface ClientLifecycleOptions {
  instance: string;
  backendConfigPath: string;
  command?: string;
  scope?: "local" | "user" | "project";
  configPath?: string;
  apply?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ClientInspection {
  schemaVersion: 1;
  runtime: InstallableRuntime;
  identity: string;
  instance: string;
  backendConfigPath: string;
  registrationLocator: ClientRegistrationLocator;
  metadataPath: string;
  state: ClientLifecycleState;
  managed: boolean;
  exact: boolean;
  reason: string;
}

export interface ClientAdoptionPlan {
  schemaVersion: 1;
  action: "adopt" | "none";
  applied: boolean;
  before: ClientLifecycleState;
  after: ClientLifecycleState;
  metadataPath: string;
  inspection: ClientInspection;
}

interface ManagedClientMetadata {
  schema: "agent-bridge.client-management";
  version: 1;
  runtime: InstallableRuntime;
  identity: string;
  instance: string;
  backendConfigPath: string;
  launch: { command: string; args: string[]; scope: "local" | "user" | "project" | null };
  locator: ClientRegistrationLocator;
}

export type ClientRegistrationLocator =
  | { kind: "codex-profile"; configPath: string }
  | { kind: "claude-code-scope"; scope: "local" | "user" | "project"; contextPath: string | null }
  | { kind: "claude-desktop-config"; configPath: string };

function safeComponent(value: string): string {
  const readable = value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 48) || "client";
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${readable}-${suffix}`;
}

function metadataPath(runtime: InstallableRuntime, instance: string, env: NodeJS.ProcessEnv): string {
  return join(env.HOME ?? homedir(), ".agent-bridge", "clients", `${runtime}-${safeComponent(instance)}.managed.json`);
}

function desktopConfigPath(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    if (!env.APPDATA) throw new Error("APPDATA is required for Claude Desktop inspection");
    return join(env.APPDATA, "Claude", "claude_desktop_config.json");
  }
  const home = env.HOME ?? homedir();
  return process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : join(home, ".config", "Claude", "claude_desktop_config.json");
}

function inspectedDesktopConfigPath(options: ClientLifecycleOptions, env: NodeJS.ProcessEnv): string {
  return resolve(options.configPath?.trim() || desktopConfigPath(env));
}

function clientRegistrationLocator(
  runtime: InstallableRuntime,
  scope: "local" | "user" | "project" | null,
  options: ClientLifecycleOptions,
  env: NodeJS.ProcessEnv,
): ClientRegistrationLocator {
  if (runtime === "claude-desktop") {
    return { kind: "claude-desktop-config", configPath: inspectedDesktopConfigPath(options, env) };
  }
  if (runtime === "claude-code") {
    const claudeScope = scope!;
    return {
      kind: "claude-code-scope",
      scope: claudeScope,
      contextPath: claudeScope === "user" ? null : resolve(process.cwd()),
    };
  }
  const codexHome = env.CODEX_HOME?.trim() || join(env.HOME ?? homedir(), ".codex");
  return { kind: "codex-profile", configPath: resolve(codexHome, "config.toml") };
}

function expectedMetadata(
  runtime: InstallableRuntime,
  identity: string,
  options: ClientLifecycleOptions,
  env: NodeJS.ProcessEnv,
): ManagedClientMetadata {
  const scope = runtime === "claude-code" ? options.scope ?? "user" : null;
  const launch = runtime === "claude-desktop"
    ? resolveDesktopLaunchContract(options.command, env)
    : { command: options.command?.trim() || "agent-bridge-mcp", args: [] };
  return {
    schema: "agent-bridge.client-management",
    version: 1,
    runtime,
    identity,
    instance: options.instance.trim(),
    backendConfigPath: resolve(options.backendConfigPath.trim()),
    launch: { ...launch, scope },
    locator: clientRegistrationLocator(runtime, scope, options, env),
  };
}

function exactObject(actual: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(actual, expected);
}

function inspectCodex(
  expected: ManagedClientMetadata,
  execute: Executor,
): "absent" | "exact" | "inexact" {
  const result = execute("codex", ["mcp", "get", "agent-bridge", "--json"]);
  if (result.error) throw new Error("codex MCP inspection failed");
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (output === "Error: No MCP server named 'agent-bridge' found.") return "absent";
    throw new Error("codex MCP inspection failed");
  }
  try {
    const server = JSON.parse(result.stdout);
    const transport = server?.transport;
    const environment = transport?.env;
    const exactEnvironment = environment && typeof environment === "object"
      && !Array.isArray(environment)
      && Object.keys(environment).sort().join(",")
        === "AGENT_BRIDGE_AGENT,AGENT_BRIDGE_CONFIG,AGENT_BRIDGE_INSTANCE";
    return server?.name === "agent-bridge" && server?.enabled === true
      && transport?.type === "stdio" && transport?.command === expected.launch.command
      && Array.isArray(transport?.args) && transport.args.length === 0
      && exactEnvironment
      && environment.AGENT_BRIDGE_AGENT === expected.identity
      && environment.AGENT_BRIDGE_INSTANCE === expected.instance
      && environment.AGENT_BRIDGE_CONFIG === expected.backendConfigPath
      ? "exact" : "inexact";
  } catch {
    return "inexact";
  }
}

function inspectClaudeCode(
  expected: ManagedClientMetadata,
  execute: Executor,
): "absent" | "exact" | "inexact" {
  const result = execute("claude", ["mcp", "get", "agent-bridge"]);
  if (result.error) throw new Error("claude-code MCP inspection failed");
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (output === 'No MCP server named "agent-bridge".'
      || /^No MCP server named "agent-bridge"\. Configured servers: [^\r\n]+$/.test(output)) return "absent";
    throw new Error("claude-code MCP inspection failed");
  }
  const scope = {
    local: "  Scope: Local config (private to you in this project)",
    user: "  Scope: User config (available in all your projects)",
    project: "  Scope: Project config (shared via .mcp.json)",
  }[expected.launch.scope!];
  const lines = result.stdout.replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (lines[0] !== "agent-bridge:" || lines[1] !== scope) return "inexact";
  const typeIndex = lines.indexOf("  Type: stdio", 2);
  if (typeIndex < 0 || lines[typeIndex + 1] !== `  Command: ${expected.launch.command}`
    || lines[typeIndex + 2] !== "  Args:" || lines[typeIndex + 3] !== "  Environment:") return "inexact";
  const environmentLines: string[] = [];
  let index = typeIndex + 4;
  while (index < lines.length && lines[index]?.startsWith("    ")) {
    environmentLines.push(lines[index]!);
    index += 1;
  }
  const wantedEnvironment = [
    `    AGENT_BRIDGE_AGENT=${expected.identity}`,
    `    AGENT_BRIDGE_INSTANCE=${expected.instance}`,
    `    AGENT_BRIDGE_CONFIG=${expected.backendConfigPath}`,
  ].sort();
  if (environmentLines.sort().join("\n") !== wantedEnvironment.join("\n")) return "inexact";
  while (lines[index] === "") index += 1;
  if (lines[index] !== `To remove this server, run: claude mcp remove agent-bridge -s ${expected.launch.scope}`) {
    return "inexact";
  }
  return lines.slice(index + 1).some((line) => line !== "") ? "inexact" : "exact";
}

function inspectDesktop(
  expected: ManagedClientMetadata,
  path: string,
): "absent" | "exact" | "inexact" {
  if (!existsSync(path)) return "absent";
  try {
    const server = JSON.parse(readFileSync(path, "utf8"))?.mcpServers?.["agent-bridge"];
    if (!server) return "absent";
    const environment = server?.env;
    const exactEnvironment = environment && typeof environment === "object"
      && !Array.isArray(environment)
      && Object.keys(environment).sort().join(",")
        === "AGENT_BRIDGE_AGENT,AGENT_BRIDGE_CONFIG,AGENT_BRIDGE_INSTANCE";
    return server?.command === expected.launch.command
      && isDeepStrictEqual(server?.args, expected.launch.args)
      && exactEnvironment
      && environment.AGENT_BRIDGE_AGENT === expected.identity
      && environment.AGENT_BRIDGE_INSTANCE === expected.instance
      && environment.AGENT_BRIDGE_CONFIG === expected.backendConfigPath
      ? "exact" : "inexact";
  } catch {
    return "inexact";
  }
}

function readMetadata(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    verifyPrivatePathAccess(dirname(dirname(path)), "directory");
    verifyPrivatePathAccess(dirname(path), "directory");
    verifyPrivatePathAccess(path, "file");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeMetadata(path: string, metadata: ManagedClientMetadata): void {
  const directory = dirname(path);
  const privateRoot = dirname(directory);
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  securePrivatePath(privateRoot, "directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  securePrivatePath(directory, "directory");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(metadata, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  securePrivatePath(temporary, "file");
  renameSync(temporary, path);
  verifyPrivatePathAccess(path, "file");
  if (process.platform !== "win32") {
    const directoryDescriptor = openSync(directory, "r");
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  }
}

function validate(runtime: InstallableRuntime, identity: string, options: ClientLifecycleOptions): void {
  if (!identity.trim() || identity.trim().length > 128) throw new Error("--identity is required");
  if (!options.instance.trim() || options.instance.trim().length > 128) throw new Error("--instance is required");
  if (!options.backendConfigPath.trim()) throw new Error("--backend-config is required");
  if (runtime === "claude-code" && options.scope && !["local", "user", "project"].includes(options.scope)) {
    throw new Error("scope must be local, user, or project");
  }
}

function backendState(path: string): "absent" | "private-file" | "invalid" {
  if (!existsSync(path)) return "absent";
  try {
    verifyPrivatePathAccess(dirname(path), "directory");
    verifyPrivatePathAccess(path, "file");
    return statSync(path).isFile() ? "private-file" : "invalid";
  } catch {
    return "invalid";
  }
}

export function inspectClient(
  runtime: InstallableRuntime,
  identity: string,
  options: ClientLifecycleOptions,
  execute: Executor = (command, args) => spawnSync(command, args, { encoding: "utf8" }),
): ClientInspection {
  validate(runtime, identity, options);
  const env = options.env ?? process.env;
  const normalizedIdentity = identity.trim();
  const expected = expectedMetadata(runtime, normalizedIdentity, options, env);
  const path = metadataPath(runtime, expected.instance, env);
  const registration = runtime === "codex"
    ? inspectCodex(expected, execute)
    : runtime === "claude-code"
      ? inspectClaudeCode(expected, execute)
      : inspectDesktop(expected, inspectedDesktopConfigPath(options, env));
  const metadata = readMetadata(path);
  const backend = backendState(expected.backendConfigPath);
  let state: ClientLifecycleState;
  let reason: string;
  if (registration === "absent" && metadata === undefined && backend === "absent") {
    state = "absent"; reason = "registration is absent";
  } else if (registration === "exact" && backend === "private-file" && metadata === undefined) {
    state = "unmanaged"; reason = "exact registration has no managed metadata";
  } else if (registration === "exact" && backend === "private-file" && exactObject(metadata, expected)) {
    state = "managed"; reason = "registration and managed metadata are exact";
  } else {
    state = "drifted"; reason = backend !== "private-file"
      ? "backend path or its immediate parent is absent or not owner-private"
      : "registration or managed metadata differs from the requested contract";
  }
  return {
    schemaVersion: 1,
    runtime,
    identity: normalizedIdentity,
    instance: expected.instance,
    backendConfigPath: expected.backendConfigPath,
    registrationLocator: expected.locator,
    metadataPath: path,
    state,
    managed: state === "managed",
    exact: registration === "exact" && backend === "private-file",
    reason,
  };
}

export function adoptClient(
  runtime: InstallableRuntime,
  identity: string,
  options: ClientLifecycleOptions,
  execute: Executor = (command, args) => spawnSync(command, args, { encoding: "utf8" }),
): ClientAdoptionPlan {
  const inspection = inspectClient(runtime, identity, options, execute);
  if (inspection.state === "managed") {
    return { schemaVersion: 1, action: "none", applied: false, before: "managed", after: "managed", metadataPath: inspection.metadataPath, inspection };
  }
  if (inspection.state !== "unmanaged") {
    throw new Error("only an exact unmanaged registration can be adopted");
  }
  if (options.apply) {
    writeMetadata(
      inspection.metadataPath,
      expectedMetadata(runtime, inspection.identity, options, options.env ?? process.env),
    );
    const postcondition = inspectClient(runtime, identity, options, execute);
    if (postcondition.state !== "managed") {
      throw new Error("client registration changed while adoption was applied");
    }
    return {
      schemaVersion: 1, action: "adopt", applied: true, before: "unmanaged",
      after: "managed", metadataPath: inspection.metadataPath, inspection: postcondition,
    };
  }
  return {
    schemaVersion: 1,
    action: "adopt",
    applied: false,
    before: "unmanaged",
    after: "managed",
    metadataPath: inspection.metadataPath,
    inspection,
  };
}
