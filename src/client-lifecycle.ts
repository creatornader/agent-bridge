import {
  accessSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { verifyPrivatePathAccess, securePrivatePath } from "./private-path.js";
import {
  resolveDesktopLaunchContract,
  type InstallableRuntime,
} from "./client-installer.js";

export type ClientLifecycleState = "absent" | "unmanaged" | "managed" | "drifted";

export interface ClientCommandContext { cwd?: string; env?: NodeJS.ProcessEnv }
export type ClientLifecycleExecutor = (
  command: string, args: string[], context?: ClientCommandContext,
) => SpawnSyncReturns<string>;
type Executor = ClientLifecycleExecutor;

const defaultExecutor: Executor = (command, args, context) => spawnSync(command, args, {
  encoding: "utf8", cwd: context?.cwd, env: context?.env,
});

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

export interface ManagedClientMetadata {
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

export function managedClientMetadataPath(
  runtime: InstallableRuntime, instance: string, env: NodeJS.ProcessEnv = process.env,
): string {
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

export function expectedManagedClientMetadata(
  runtime: InstallableRuntime,
  identity: string,
  options: ClientLifecycleOptions,
  env: NodeJS.ProcessEnv,
): ManagedClientMetadata {
  const scope = runtime === "claude-code" ? options.scope ?? "user" : null;
  const launch = runtime === "claude-desktop"
    ? resolveDesktopLaunchContract(options.command, env)
    : { command: safeNativeExecutableContract(options.command === undefined ? "agent-bridge-mcp" : options.command, "--command"), args: [] };
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

const REGISTRATION_ENV_KEYS = [
  "AGENT_BRIDGE_AGENT", "AGENT_BRIDGE_CONFIG", "AGENT_BRIDGE_INSTANCE",
] as const;

type RegistrationState = "absent" | "exact" | "inexact";
type RegistrationEnvironment = Partial<Record<(typeof REGISTRATION_ENV_KEYS)[number], string>>;

export interface ManagedRegistrationObservation {
  state: RegistrationState;
  target: {
    runtime: InstallableRuntime;
    identity: string;
    instance: string;
    backendConfigPath: string;
    launch: ManagedClientMetadata["launch"];
    locator: ClientRegistrationLocator;
  };
  observed: { state: "absent" } | {
    state: "present";
    command: string;
    args: string[];
    env: RegistrationEnvironment;
  };
}

function registrationTarget(metadata: ManagedClientMetadata): ManagedRegistrationObservation["target"] {
  return {
    runtime: metadata.runtime,
    identity: metadata.identity,
    instance: metadata.instance,
    backendConfigPath: metadata.backendConfigPath,
    launch: { command: metadata.launch.command, args: [...metadata.launch.args], scope: metadata.launch.scope },
    locator: metadata.locator,
  };
}

export function safeNativeExecutableContract(value: unknown, field: string): string {
  const command = strictText(value, field, 4096);
  if (/[?=#]/.test(command) || /:\/\//.test(command)
    || (!isAbsolute(command) && /\s/.test(command))) {
    throw new Error(`${field} is invalid`);
  }
  return command;
}

export function newNativeExecutableContract(value: unknown, field: string): string {
  const command = safeNativeExecutableContract(value, field);
  if (!isAbsolute(command)) return command;
  if (resolve(command) !== command || !existsSync(command) || !statSync(command).isFile()) {
    throw new Error(`${field} is not an existing executable`);
  }
  try { accessSync(command, process.platform === "win32" ? constants.F_OK : constants.X_OK); }
  catch { throw new Error(`${field} is not an existing executable`); }
  return command;
}

function safeEnvironment(value: unknown): RegistrationEnvironment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("managed registration environment is invalid");
  }
  const environment: RegistrationEnvironment = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!REGISTRATION_ENV_KEYS.includes(key as (typeof REGISTRATION_ENV_KEYS)[number])) {
      throw new Error("managed registration contains an unsupported environment key");
    }
    if (key === "AGENT_BRIDGE_CONFIG") environment.AGENT_BRIDGE_CONFIG = strictAbsolutePath(item, "registration config");
    else environment[key as "AGENT_BRIDGE_AGENT" | "AGENT_BRIDGE_INSTANCE"] = strictText(item, `registration ${key}`, 128);
  }
  return environment;
}

function exactRegistration(
  expected: ManagedClientMetadata,
  command: string,
  args: string[],
  environment: RegistrationEnvironment,
): boolean {
  return command === expected.launch.command
    && isDeepStrictEqual(args, expected.launch.args)
    && isDeepStrictEqual(environment, {
      AGENT_BRIDGE_AGENT: expected.identity,
      AGENT_BRIDGE_INSTANCE: expected.instance,
      AGENT_BRIDGE_CONFIG: expected.backendConfigPath,
    });
}

function safeArgs(value: unknown, expected: string[], alternate: string[] = []): string[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("managed registration arguments are invalid");
  const args = value.map((item) => strictText(item, "registration argument", 1024));
  if (!isDeepStrictEqual(args, expected) && !isDeepStrictEqual(args, alternate)) {
    throw new Error("managed registration arguments cannot be represented safely");
  }
  return args;
}

function commandContext(
  metadata: ManagedClientMetadata,
  env: NodeJS.ProcessEnv,
): ClientCommandContext {
  if (metadata.runtime === "codex") {
    const locator = metadata.locator as Extract<ClientRegistrationLocator, { kind: "codex-profile" }>;
    return { env: { ...env, CODEX_HOME: dirname(locator.configPath) } };
  }
  const locator = metadata.locator as Extract<ClientRegistrationLocator, { kind: "claude-code-scope" }>;
  return { cwd: locator.contextPath ?? undefined, env: { ...env } };
}

function observeCodex(
  expected: ManagedClientMetadata,
  execute: Executor,
  env: NodeJS.ProcessEnv,
  alternateArgs: string[],
): ManagedRegistrationObservation {
  const result = execute("codex", ["mcp", "get", "agent-bridge", "--json"], {
    ...commandContext(expected, env),
  });
  if (result.error) throw new Error("codex MCP inspection failed");
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (output === "Error: No MCP server named 'agent-bridge' found.") {
      return { state: "absent", target: registrationTarget(expected), observed: { state: "absent" } };
    }
    throw new Error("codex MCP inspection failed");
  }
  try {
    const server = JSON.parse(result.stdout) as Record<string, unknown>;
    const transport = server?.transport as Record<string, unknown> | undefined;
    const serverFields = new Set([
      "name", "enabled", "disabled_reason", "transport", "enabled_tools", "disabled_tools",
      "startup_timeout_sec", "tool_timeout_sec", "status",
    ]);
    const transportFields = new Set(["type", "command", "args", "env", "env_vars", "cwd"]);
    const hasNonNullSetting = (field: string): boolean => field in server && server[field] !== null;
    if (!server || typeof server !== "object" || Array.isArray(server)
      || server.name !== "agent-bridge" || server.enabled !== true
      || !transport || typeof transport !== "object" || Array.isArray(transport)
      || transport.type !== "stdio") {
      throw new Error("Codex MCP registration is not a supported stdio contract");
    }
    if (Object.keys(server).some((field) => !serverFields.has(field))
      || Object.keys(transport).some((field) => !transportFields.has(field))
      || hasNonNullSetting("enabled_tools") || hasNonNullSetting("disabled_tools")) {
      throw new Error("Codex MCP registration contains an unsupported execution setting");
    }
    if (("cwd" in transport && transport.cwd !== null)
      || ("env_vars" in transport && (!Array.isArray(transport.env_vars) || transport.env_vars.length !== 0))) {
      throw new Error("Codex MCP registration contains an unsupported execution setting");
    }
    const command = safeNativeExecutableContract(transport.command, "Codex MCP command");
    const args = safeArgs(transport.args, expected.launch.args, alternateArgs);
    const environment = safeEnvironment(transport.env);
    return {
      state: exactRegistration(expected, command, args, environment) ? "exact" : "inexact",
      target: registrationTarget(expected), observed: { state: "present", command, args, env: environment },
    };
  } catch {
    throw new Error("Codex MCP registration cannot be represented safely");
  }
}

function observeClaudeCode(
  expected: ManagedClientMetadata,
  execute: Executor,
  env: NodeJS.ProcessEnv,
  alternateArgs: string[],
): ManagedRegistrationObservation {
  const locator = expected.locator as Extract<ClientRegistrationLocator, { kind: "claude-code-scope" }>;
  const result = execute("claude", ["mcp", "get", "agent-bridge"], {
    ...commandContext(expected, env),
  });
  if (result.error) throw new Error("claude-code MCP inspection failed");
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (output === 'No MCP server named "agent-bridge".'
      || /^No MCP server named "agent-bridge"\. Configured servers: [^\r\n]+$/.test(output)) {
      return { state: "absent", target: registrationTarget(expected), observed: { state: "absent" } };
    }
    throw new Error("claude-code MCP inspection failed");
  }
  const scope = {
    local: "  Scope: Local config (private to you in this project)",
    user: "  Scope: User config (available in all your projects)",
    project: "  Scope: Project config (shared via .mcp.json)",
  }[expected.launch.scope!];
  const lines = result.stdout.replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (lines[0] !== "agent-bridge:" || lines[1] !== scope) {
    throw new Error("Claude Code MCP registration scope is not the recorded scope");
  }
  const typeIndex = lines.indexOf("  Type: stdio", 2);
  if (typeIndex < 0 || lines[typeIndex + 1] !== `  Command: ${expected.launch.command}`
    || lines[typeIndex + 2] !== "  Args:" || lines[typeIndex + 3] !== "  Environment:") {
    if (typeIndex < 0 || lines[typeIndex + 2] !== "  Args:" || lines[typeIndex + 3] !== "  Environment:") {
      throw new Error("Claude Code MCP registration cannot be represented safely");
    }
  }
  const commandLine = lines[typeIndex + 1];
  if (!commandLine?.startsWith("  Command: ")) throw new Error("Claude Code MCP registration cannot be represented safely");
  const command = safeNativeExecutableContract(commandLine.slice("  Command: ".length), "Claude Code MCP command");
  const environmentLines: string[] = [];
  let index = typeIndex + 4;
  while (index < lines.length && lines[index]?.startsWith("    ")) {
    environmentLines.push(lines[index]!);
    index += 1;
  }
  const values: Record<string, string> = {};
  for (const line of environmentLines) {
    const match = /^    ([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match || Object.prototype.hasOwnProperty.call(values, match[1]!)) {
      throw new Error("Claude Code MCP environment is invalid");
    }
    values[match[1]!] = match[2]!;
  }
  const environment = safeEnvironment(values);
  while (lines[index] === "") index += 1;
  if (lines[index] !== `To remove this server, run: claude mcp remove agent-bridge -s ${expected.launch.scope}`) {
    throw new Error("Claude Code MCP registration cannot be represented safely");
  }
  if (lines.slice(index + 1).some((line) => line !== "")) {
    throw new Error("Claude Code MCP registration cannot be represented safely");
  }
  const args = safeArgs([], expected.launch.args, alternateArgs);
  return {
    state: exactRegistration(expected, command, args, environment) ? "exact" : "inexact",
    target: registrationTarget(expected), observed: { state: "present", command, args, env: environment },
  };
}

export function assertNoLinkedPathAncestors(path: string): void {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("Claude Desktop config path contains a link");
    } catch (error) {
      if (error instanceof Error && error.message === "Claude Desktop config path contains a link") throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw new Error("Claude Desktop config path is unavailable");
    }
  }
}

function observeDesktop(
  expected: ManagedClientMetadata,
  path: string,
  alternateArgs: string[],
): ManagedRegistrationObservation {
  assertNoLinkedPathAncestors(path);
  if (!existsSync(path)) return { state: "absent", target: registrationTarget(expected), observed: { state: "absent" } };
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > 4 * 1024 * 1024) {
      throw new Error("Claude Desktop config is not a safe regular JSON file");
    }
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let parsed: unknown;
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.size > 4 * 1024 * 1024
        || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error("Claude Desktop config changed during access");
      }
      parsed = JSON.parse(readFileSync(descriptor, "utf8"));
      const after = lstatSync(path);
      if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
        throw new Error("Claude Desktop config changed during access");
      }
    } finally { closeSync(descriptor); }
    const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
    if (servers === undefined) return { state: "absent", target: registrationTarget(expected), observed: { state: "absent" } };
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      throw new Error("Claude Desktop mcpServers is invalid");
    }
    const server = (servers as Record<string, unknown>)["agent-bridge"];
    if (server === undefined) return { state: "absent", target: registrationTarget(expected), observed: { state: "absent" } };
    if (!server || typeof server !== "object" || Array.isArray(server)
      || Object.keys(server as Record<string, unknown>).sort().join(",") !== "args,command,env") {
      throw new Error("Claude Desktop MCP registration cannot be represented safely");
    }
    const entry = server as Record<string, unknown>;
    const command = strictAbsolutePath(entry.command, "Claude Desktop MCP command");
    const args = safeArgs(entry.args, expected.launch.args, alternateArgs);
    const environment = safeEnvironment(entry.env);
    return {
      state: exactRegistration(expected, command, args, environment) ? "exact" : "inexact",
      target: registrationTarget(expected), observed: { state: "present", command, args, env: environment },
    };
  } catch {
    throw new Error("Claude Desktop MCP registration cannot be represented safely");
  }
}

/** Observe only the bounded, credential-free portion of a metadata-owned registration. */
export function observeManagedRegistration(
  metadata: ManagedClientMetadata,
  execute: Executor = (command, args, context) => spawnSync(command, args, {
    encoding: "utf8", cwd: context?.cwd, env: context?.env,
  }),
  env: NodeJS.ProcessEnv = process.env,
  alternateArgs: string[] = [],
): ManagedRegistrationObservation {
  return metadata.runtime === "codex"
    ? observeCodex(metadata, execute, env, alternateArgs)
    : metadata.runtime === "claude-code"
      ? observeClaudeCode(metadata, execute, env, alternateArgs)
      : observeDesktop(
          metadata,
          (metadata.locator as Extract<ClientRegistrationLocator, { kind: "claude-desktop-config" }>).configPath,
          alternateArgs,
        );
}

/** Inspect the registration using only the locator and launch contract stored in managed metadata. */
export function inspectManagedRegistration(
  metadata: ManagedClientMetadata,
  execute: Executor = (command, args, context) => spawnSync(command, args, {
    encoding: "utf8", cwd: context?.cwd, env: context?.env,
  }),
  env: NodeJS.ProcessEnv = process.env,
): RegistrationState {
  try { return observeManagedRegistration(metadata, execute, env).state; }
  catch { return "inexact"; }
}

const MAX_MANAGED_METADATA_BYTES = 64 * 1024;

function strictText(value: unknown, field: string, maximum = 1024): string {
  if (typeof value !== "string" || !value || value.length > maximum || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`managed metadata ${field} is invalid`);
  }
  return value;
}

function strictAbsolutePath(value: unknown, field: string): string {
  const path = strictText(value, field, 4096);
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`managed metadata ${field} is invalid`);
  return path;
}

function strictLocator(
  runtime: InstallableRuntime,
  value: unknown,
): ClientRegistrationLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("managed metadata locator is invalid");
  }
  const locator = value as Record<string, unknown>;
  if (runtime === "codex") {
    if (Object.keys(locator).sort().join(",") !== "configPath,kind"
      || locator.kind !== "codex-profile") throw new Error("managed metadata locator is invalid");
    const configPath = strictAbsolutePath(locator.configPath, "locator configPath");
    if (!configPath.endsWith("/config.toml") && !configPath.endsWith("\\config.toml")) {
      throw new Error("managed metadata locator is invalid");
    }
    return { kind: "codex-profile", configPath };
  }
  if (runtime === "claude-code") {
    if (Object.keys(locator).sort().join(",") !== "contextPath,kind,scope"
      || locator.kind !== "claude-code-scope"
      || !["local", "user", "project"].includes(locator.scope as string)) {
      throw new Error("managed metadata locator is invalid");
    }
    const scope = locator.scope as "local" | "user" | "project";
    if ((scope === "user" && locator.contextPath !== null)
      || (scope !== "user" && typeof locator.contextPath !== "string")) {
      throw new Error("managed metadata locator is invalid");
    }
    return {
      kind: "claude-code-scope", scope,
      contextPath: scope === "user" ? null : strictAbsolutePath(locator.contextPath, "locator contextPath"),
    };
  }
  if (Object.keys(locator).sort().join(",") !== "configPath,kind"
    || locator.kind !== "claude-desktop-config") throw new Error("managed metadata locator is invalid");
  return { kind: "claude-desktop-config", configPath: strictAbsolutePath(locator.configPath, "locator configPath") };
}

function strictManagedMetadata(
  value: unknown, runtime: InstallableRuntime, instance: string,
): ManagedClientMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("managed metadata is invalid");
  const metadata = value as Record<string, unknown>;
  if (Object.keys(metadata).sort().join(",")
    !== "backendConfigPath,identity,instance,launch,locator,runtime,schema,version"
    || metadata.schema !== "agent-bridge.client-management" || metadata.version !== 1
    || metadata.runtime !== runtime) throw new Error("managed metadata is invalid");
  const identity = strictText(metadata.identity, "identity", 128);
  const recordedInstance = strictText(metadata.instance, "instance", 128);
  if (recordedInstance !== instance) throw new Error("managed metadata instance does not match its locator");
  const backendConfigPath = strictAbsolutePath(metadata.backendConfigPath, "backendConfigPath");
  if (!metadata.launch || typeof metadata.launch !== "object" || Array.isArray(metadata.launch)) {
    throw new Error("managed metadata launch is invalid");
  }
  const launch = metadata.launch as Record<string, unknown>;
  if (Object.keys(launch).sort().join(",") !== "args,command,scope"
    || !Array.isArray(launch.args) || launch.args.length > 16
    || launch.args.some((arg) => {
      try { strictText(arg, "launch argument", 1024); return false; } catch { return true; }
    })
    || ![null, "local", "user", "project"].includes(launch.scope as string | null)) {
    throw new Error("managed metadata launch is invalid");
  }
  const locator = strictLocator(runtime, metadata.locator);
  const scope = launch.scope as "local" | "user" | "project" | null;
  if ((runtime !== "claude-code" && scope !== null)
    || (runtime === "claude-code" && scope !== (locator as Extract<ClientRegistrationLocator, { kind: "claude-code-scope" }>).scope)
    || ((runtime === "codex" || runtime === "claude-code") && launch.args.length !== 0)
    || (runtime === "claude-desktop" && !isAbsolute(strictText(launch.command, "launch command", 4096)))
    || ((runtime === "codex" || runtime === "claude-code")
      && (() => { try { safeNativeExecutableContract(launch.command, "launch command"); return false; } catch { return true; } })())) {
    throw new Error("managed metadata launch is invalid");
  }
  return {
    schema: "agent-bridge.client-management", version: 1, runtime, identity, instance: recordedInstance,
    backendConfigPath,
    launch: { command: strictText(launch.command, "launch command", 4096), args: [...launch.args] as string[], scope },
    locator,
  };
}

/** Load the owner-private record that is the only mutation authority for a managed client. */
export function loadManagedClientMetadata(
  runtime: InstallableRuntime, instance: string, env: NodeJS.ProcessEnv = process.env,
): ManagedClientMetadata {
  const normalizedInstance = strictText(instance, "instance", 128);
  const path = managedClientMetadataPath(runtime, normalizedInstance, env);
  verifyPrivatePathAccess(dirname(dirname(path)), "directory");
  verifyPrivatePathAccess(dirname(path), "directory");
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_MANAGED_METADATA_BYTES) {
    throw new Error("managed metadata is invalid");
  }
  verifyPrivatePathAccess(path, "file");
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_MANAGED_METADATA_BYTES
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("managed metadata changed during access");
    }
    const parsed = JSON.parse(readFileSync(descriptor, "utf8"));
    const after = lstatSync(path);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error("managed metadata changed during access");
    }
    return strictManagedMetadata(parsed, runtime, normalizedInstance);
  } finally { closeSync(descriptor); }
}

function readMetadata(path: string, runtime: InstallableRuntime, instance: string): unknown {
  if (!existsSync(path)) return undefined;
  try { return loadManagedClientMetadata(runtime, instance, { HOME: dirname(dirname(dirname(path))) }); }
  catch { return null; }
}

export function writeManagedClientMetadata(path: string, metadata: ManagedClientMetadata): void {
  const directory = dirname(path);
  const privateRoot = dirname(directory);
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  securePrivatePath(privateRoot, "directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  securePrivatePath(directory, "directory");
  const directoryBefore = lstatSync(directory);
  if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
    throw new Error("managed metadata directory is invalid");
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    const opened = fstatSync(descriptor);
    securePrivatePath(temporary, "file");
    const secured = lstatSync(temporary);
    if (!opened.isFile() || secured.isSymbolicLink() || !secured.isFile()
      || secured.dev !== opened.dev || secured.ino !== opened.ino) {
      throw new Error("managed metadata temporary file changed during access");
    }
    writeFileSync(descriptor, `${JSON.stringify(metadata, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const beforeRename = lstatSync(directory);
  const temporaryBeforeRename = lstatSync(temporary);
  if (beforeRename.isSymbolicLink() || beforeRename.dev !== directoryBefore.dev
    || beforeRename.ino !== directoryBefore.ino || temporaryBeforeRename.isSymbolicLink()
    || !temporaryBeforeRename.isFile()) {
    throw new Error("managed metadata directory changed before publication");
  }
  verifyPrivatePathAccess(temporary, "file");
  renameSync(temporary, path);
  const afterRename = lstatSync(directory);
  if (afterRename.isSymbolicLink() || afterRename.dev !== directoryBefore.dev
    || afterRename.ino !== directoryBefore.ino) {
    throw new Error("managed metadata directory changed during publication");
  }
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
  execute: Executor = defaultExecutor,
): ClientInspection {
  validate(runtime, identity, options);
  const env = options.env ?? process.env;
  const normalizedIdentity = identity.trim();
  const expected = expectedManagedClientMetadata(runtime, normalizedIdentity, options, env);
  const path = managedClientMetadataPath(runtime, expected.instance, env);
  const registration = inspectManagedRegistration(expected, execute, env);
  const metadata = readMetadata(path, runtime, expected.instance);
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
  execute: Executor = defaultExecutor,
): ClientAdoptionPlan {
  const inspection = inspectClient(runtime, identity, options, execute);
  if (inspection.state === "managed") {
    return { schemaVersion: 1, action: "none", applied: false, before: "managed", after: "managed", metadataPath: inspection.metadataPath, inspection };
  }
  if (inspection.state !== "unmanaged") {
    throw new Error("only an exact unmanaged registration can be adopted");
  }
  if (options.apply) {
    writeManagedClientMetadata(
      inspection.metadataPath,
      expectedManagedClientMetadata(runtime, inspection.identity, options, options.env ?? process.env),
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
