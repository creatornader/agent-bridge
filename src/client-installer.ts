import {
  accessSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readClientConfigFile, resolveClientConfig } from "./client-config.js";
import { securePrivatePath, verifyPrivatePathAccess } from "./private-path.js";
import {
  acquireEnrollmentLock,
  deleteEnrollmentFile,
  readEnrollment,
  recoverEnrollmentLock,
  releaseEnrollmentLock,
  transitionEnrollment,
  type EnrollmentLock,
  type EnrollmentFile,
} from "./enrollment-file.js";

export type InstallableRuntime = "codex" | "claude-code" | "claude-desktop";

export interface ClientInstallResult {
  runtime: InstallableRuntime;
  identity: string;
  instance: string;
  method: "native-cli" | "json-config";
  configPath?: string;
  backendConfigPath: string;
  restartRequired: boolean;
  installed?: true;
  enrollmentDeleted?: boolean;
  enrollmentFile?: string;
  enrollmentStatus?: "consumed" | "consumed-file-retained" | "consumed-file-missing"
    | "consumed-deletion-durability-unknown";
  lockReleaseStatus?: "released" | "retained" | "durability-unknown";
}

type Executor = (
  command: string,
  args: string[],
) => SpawnSyncReturns<string>;

export interface ClientBackendBinding {
  credentialId: string;
  principal: string;
  instance: string;
}

export interface DesktopLaunchContract {
  command: string;
  args: string[];
}

function assertExecutable(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`Claude Desktop MCP executable does not exist: ${path}`);
  }
  if (!statSync(path).isFile()) {
    throw new Error(`Claude Desktop MCP executable is not a file: ${path}`);
  }
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch {
    throw new Error(`Claude Desktop MCP executable is not executable: ${path}`);
  }
  return path;
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return assertExecutable(resolve(command));
  }
  const searchPath = env.PATH ?? process.env.PATH ?? "";
  const extensions = process.platform === "win32" && !extname(command)
    ? (env.PATHEXT ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
    : [""];
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      if (!existsSync(candidate)) continue;
      return assertExecutable(resolve(candidate));
    }
  }
  throw new Error(`Claude Desktop MCP executable was not found on PATH: ${command}`);
}

function defaultServerEntry(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, "index.js"),
    join(moduleDirectory, "..", "dist", "index.js"),
  ];
  const entry = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!entry) {
    throw new Error(`Claude Desktop MCP server entry does not exist: ${candidates[0]}`);
  }
  return resolve(entry);
}

export function resolveDesktopLaunchContract(
  requestedCommand: string | undefined,
  env: NodeJS.ProcessEnv,
): DesktopLaunchContract {
  const command = requestedCommand?.trim();
  if (command) return { command: resolveExecutable(command, env), args: [] };
  return {
    command: assertExecutable(resolve(process.execPath)),
    args: [defaultServerEntry()],
  };
}

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
  const directory = dirname(path);
  const privateRoot = dirname(directory);
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  securePrivatePath(privateRoot, "directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  securePrivatePath(directory, "directory");
  if (existsSync(path)) verifyPrivatePathAccess(path, "file");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  securePrivatePath(temporary, "file");
  renameSync(temporary, path);
  verifyPrivatePathAccess(path, "file");
  if (process.platform !== "win32") {
    const descriptor = openSync(directory, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
}

function writeClientBackendConfig(
  runtime: InstallableRuntime,
  identity: string,
  instance: string,
  options: {
    token?: string;
    env: NodeJS.ProcessEnv;
    binding?: ClientBackendBinding;
    destinationPath?: string;
    gatewayUrl?: string;
    workspace?: string;
    edgeDatabasePath?: string;
  },
): string {
  const env = options.env;
  const home = env.HOME ?? homedir();
  const sharedPath = env.AGENT_BRIDGE_CONFIG ?? join(home, ".agent-bridge", "config");
  const shared = readClientConfigFile(sharedPath);
  const stagedGateway = options.gatewayUrl !== undefined || options.workspace !== undefined
    || options.edgeDatabasePath !== undefined;
  if (stagedGateway && (!options.gatewayUrl || !options.workspace || !options.edgeDatabasePath)) {
    throw new Error("staged gateway backend requires URL, workspace, and edge database path");
  }
  const configuredProvider = stagedGateway
    ? "gateway"
    : env.AGENT_BRIDGE_PROVIDER?.trim() || shared.AGENT_BRIDGE_PROVIDER?.trim();
  const inferredGateway = !configuredProvider && Boolean(
    env.AGENT_BRIDGE_TOKEN?.trim() || shared.AGENT_BRIDGE_TOKEN?.trim(),
  );
  const provider = configuredProvider ?? (inferredGateway ? "gateway" : undefined);
  const clientToken = options.token?.trim() || env.AGENT_BRIDGE_CLIENT_TOKEN?.trim();
  if (provider === "gateway" && !clientToken) {
    throw new Error(
      "gateway client installation requires --token or AGENT_BRIDGE_CLIENT_TOKEN",
    );
  }
  const resolved = resolveClientConfig(stagedGateway
    ? {
      ...env,
      AGENT_BRIDGE_CONFIG: undefined,
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: options.gatewayUrl,
      AGENT_BRIDGE_WORKSPACE: options.workspace,
      AGENT_BRIDGE_EDGE_DB: options.edgeDatabasePath,
      AGENT_BRIDGE_AGENT: undefined,
      AGENT_BRIDGE_INSTANCE: undefined,
      AGENT_BRIDGE_TOKEN: clientToken,
    }
    : {
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
    AGENT_BRIDGE_DB: resolved.provider === "local" ? resolved.databasePath : undefined,
    AGENT_BRIDGE_EDGE_DB: resolved.provider === "gateway" ? resolved.edgeDatabasePath : undefined,
    AGENT_BRIDGE_CREDENTIAL_ID: options.binding?.credentialId,
    AGENT_BRIDGE_PRINCIPAL: options.binding?.principal,
    AGENT_BRIDGE_CLIENT_INSTANCE: options.binding?.instance,
  };
  for (const value of Object.values(values)) {
    if (value?.includes("\n") || value?.includes("\r")) {
      throw new Error("client backend config values cannot contain newlines");
    }
  }
  const path = options.destinationPath ?? clientBackendConfigPath(runtime, instance, env);
  replacePrivateFile(
    path,
    `${Object.entries(values)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
  return path;
}

export interface StagedGatewayBackendPaths {
  directory: string;
  backendConfigPath: string;
  edgeDatabasePath: string;
}

function migrationOperationId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("client migration operation ID is invalid");
  }
  return value.toLowerCase();
}

export function stagedGatewayBackendPaths(
  operationId: string,
  env: NodeJS.ProcessEnv = process.env,
): StagedGatewayBackendPaths {
  const home = env.HOME ?? homedir();
  const directory = join(home, ".agent-bridge", "client-migrations", migrationOperationId(operationId));
  return {
    directory,
    backendConfigPath: join(directory, "target.config"),
    edgeDatabasePath: join(directory, "target.edge.sqlite3"),
  };
}

/** Write only the fixed private target backend for a persisted migration operation. */
export function writeStagedGatewayBackendConfig(
  runtime: InstallableRuntime,
  identity: string,
  instance: string,
  operationId: string,
  options: {
    token: string;
    gatewayUrl: string;
    workspace: string;
    credentialId: string;
    principal: string;
    env?: NodeJS.ProcessEnv;
  },
): StagedGatewayBackendPaths {
  const env = options.env ?? process.env;
  const paths = stagedGatewayBackendPaths(operationId, env);
  writeClientBackendConfig(runtime, identity, instance, {
    token: options.token,
    env,
    binding: {
      credentialId: options.credentialId,
      principal: options.principal,
      instance,
    },
    destinationPath: paths.backendConfigPath,
    gatewayUrl: options.gatewayUrl,
    workspace: options.workspace,
    edgeDatabasePath: paths.edgeDatabasePath,
  });
  return paths;
}

function writeBackendConfig(
  runtime: InstallableRuntime,
  identity: string,
  instance: string,
  options: { token?: string; env: NodeJS.ProcessEnv; binding?: ClientBackendBinding },
): string {
  return writeClientBackendConfig(runtime, identity, instance, options);
}

function writeJsonConfig(
  path: string,
  identity: string,
  instance: string,
  backendConfigPath: string,
  launch: DesktopLaunchContract,
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
        command: launch.command,
        args: launch.args,
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

function assertEnrollmentConfiguration(
  enrollment: EnrollmentFile,
  assertions: {
    runtime?: InstallableRuntime;
    identity?: string;
    instance?: string;
    token?: string;
    env: NodeJS.ProcessEnv;
  },
): void {
  const input = enrollment.input;
  const env = assertions.env;
  const home = env.HOME ?? homedir();
  const shared = readClientConfigFile(
    env.AGENT_BRIDGE_CONFIG ?? join(home, ".agent-bridge", "config"),
  );
  const conflicts: Array<[string, string | undefined, string]> = [
    ["runtime", assertions.runtime, input.runtime],
    ["identity", assertions.identity?.trim() || undefined, input.principal],
    ["instance", assertions.instance?.trim() || undefined, input.instance],
    ["AGENT_BRIDGE_AGENT", env.AGENT_BRIDGE_AGENT?.trim(), input.principal],
    ["AGENT_BRIDGE_INSTANCE", env.AGENT_BRIDGE_INSTANCE?.trim(), input.instance],
    ["AGENT_BRIDGE_URL", env.AGENT_BRIDGE_URL?.trim(), input.gatewayUrl],
    ["AGENT_BRIDGE_WORKSPACE", env.AGENT_BRIDGE_WORKSPACE?.trim(), input.workspaceId],
    ["shared AGENT_BRIDGE_URL", shared.AGENT_BRIDGE_URL?.trim(), input.gatewayUrl],
    ["shared AGENT_BRIDGE_WORKSPACE", shared.AGENT_BRIDGE_WORKSPACE?.trim(), input.workspaceId],
  ];
  for (const [name, actual, expected] of conflicts) {
    if (actual && actual !== expected) throw new Error(name + " conflicts with the enrollment file");
  }
  for (const [name, provider] of [
    ["AGENT_BRIDGE_PROVIDER", env.AGENT_BRIDGE_PROVIDER?.trim()],
    ["shared AGENT_BRIDGE_PROVIDER", shared.AGENT_BRIDGE_PROVIDER?.trim()],
  ] as const) {
    if (provider && provider !== "gateway") throw new Error(name + " conflicts with the enrollment file");
  }
  if (assertions.token) throw new Error("--token cannot be used with --enrollment-file");
  if (env.AGENT_BRIDGE_CLIENT_TOKEN || env.AGENT_BRIDGE_TOKEN) {
    throw new Error("token environment variables cannot be used with --enrollment-file");
  }
}

function removeConsumedEnrollment(
  path: string,
  result: ClientInstallResult,
  lock: EnrollmentLock,
  env: NodeJS.ProcessEnv,
): ClientInstallResult {
  try {
    const deletion = deleteEnrollmentFile(path, lock, env);
    if (deletion === "missing") {
      return {
        ...result,
        installed: true,
        enrollmentDeleted: false,
        enrollmentFile: path,
        enrollmentStatus: "consumed-file-missing",
      };
    }
    if (deletion === "deleted-durability-unknown") {
      return {
        ...result,
        installed: true,
        enrollmentDeleted: true,
        enrollmentStatus: "consumed-deletion-durability-unknown",
      };
    }
    return {
      ...result,
      installed: true,
      enrollmentDeleted: true,
      enrollmentStatus: "consumed",
    };
  } catch {
    return {
      ...result,
      installed: true,
      enrollmentDeleted: false,
      enrollmentFile: path,
      enrollmentStatus: "consumed-file-retained",
    };
  }
}

function backendMatches(
  path: string,
  enrollment: EnrollmentFile,
  credentialId: string,
  requireToken: boolean,
): boolean {
  if (!existsSync(path)) return false;
  const config = readClientConfigFile(path);
  return config.AGENT_BRIDGE_PROVIDER === "gateway"
    && config.AGENT_BRIDGE_URL === enrollment.input.gatewayUrl
    && config.AGENT_BRIDGE_WORKSPACE === enrollment.input.workspaceId
    && config.AGENT_BRIDGE_CREDENTIAL_ID === credentialId
    && config.AGENT_BRIDGE_PRINCIPAL === enrollment.input.principal
    && config.AGENT_BRIDGE_CLIENT_INSTANCE === enrollment.input.instance
    && (!requireToken || config.AGENT_BRIDGE_TOKEN === enrollment.token);
}

function desktopRegistrationState(
  enrollment: EnrollmentFile,
  backendConfigPath: string,
  launch: DesktopLaunchContract,
  env: NodeJS.ProcessEnv,
): "absent" | "matching" | "legacy" | "conflict" {
  const path = desktopConfigPath(env);
  if (!existsSync(path)) return "absent";
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    const server = config?.mcpServers?.["agent-bridge"];
    if (!server) return "absent";
    const environment = server?.env;
    const exactEnvironment = environment && typeof environment === "object"
      && !Array.isArray(environment)
      && Object.keys(environment).sort().join(",")
        === "AGENT_BRIDGE_AGENT,AGENT_BRIDGE_CONFIG,AGENT_BRIDGE_INSTANCE"
      && environment.AGENT_BRIDGE_AGENT === enrollment.input.principal
      && environment.AGENT_BRIDGE_INSTANCE === enrollment.input.instance
      && environment.AGENT_BRIDGE_CONFIG === backendConfigPath;
    if (server?.command === "agent-bridge-mcp"
      && (server?.args === undefined || (Array.isArray(server.args) && server.args.length === 0))
      && exactEnvironment) return "legacy";
    return server?.command === launch.command
      && Array.isArray(server?.args)
      && server.args.length === launch.args.length
      && server.args.every((arg: unknown, index: number) => arg === launch.args[index])
      && exactEnvironment
      ? "matching"
      : "conflict";
  } catch {
    return "conflict";
  }
}

function repairLegacyDesktopRegistration(
  state: "absent" | "matching" | "legacy" | "conflict",
  enrollment: EnrollmentFile,
  backendConfigPath: string,
  launch: DesktopLaunchContract,
  env: NodeJS.ProcessEnv,
): "absent" | "matching" | "conflict" {
  if (state !== "legacy") return state;
  writeJsonConfig(
    desktopConfigPath(env),
    enrollment.input.principal,
    enrollment.input.instance,
    backendConfigPath,
    launch,
  );
  const repaired = desktopRegistrationState(enrollment, backendConfigPath, launch, env);
  return repaired === "legacy" ? "conflict" : repaired;
}

function nativeRegistrationState(
  enrollment: EnrollmentFile,
  backendConfigPath: string,
  command: string,
  scope: "local" | "user" | "project",
  execute: Executor,
): "absent" | "matching" | "conflict" {
  const executable = enrollment.input.runtime === "codex" ? "codex" : "claude";
  const args = enrollment.input.runtime === "codex"
    ? ["mcp", "get", "agent-bridge", "--json"]
    : ["mcp", "get", "agent-bridge"];
  const result = execute(executable, args);
  if (result.error) throw new Error(enrollment.input.runtime + " MCP inspection failed");
  if (result.status !== 0) {
    const output = (result.stdout + "\n" + result.stderr).trim();
    const notFound = enrollment.input.runtime === "codex"
      ? output === "Error: No MCP server named 'agent-bridge' found."
      : output === 'No MCP server named "agent-bridge".'
        || /^No MCP server named "agent-bridge"\. Configured servers: [^\r\n]+$/.test(output);
    if (notFound) return "absent";
    throw new Error(enrollment.input.runtime + " MCP inspection failed");
  }
  if (enrollment.input.runtime === "codex") {
    try {
      const server = JSON.parse(result.stdout);
      const transport = server?.transport;
      const environment = transport?.env;
      const exactEnvironment = environment && typeof environment === "object"
        && !Array.isArray(environment)
        && Object.keys(environment).sort().join(",")
          === "AGENT_BRIDGE_AGENT,AGENT_BRIDGE_CONFIG,AGENT_BRIDGE_INSTANCE";
      return server?.name === "agent-bridge" && server?.enabled === true
        && transport?.type === "stdio" && transport?.command === command
        && Array.isArray(transport?.args) && transport.args.length === 0
        && exactEnvironment
        && transport?.env?.AGENT_BRIDGE_AGENT === enrollment.input.principal
        && transport?.env?.AGENT_BRIDGE_INSTANCE === enrollment.input.instance
        && transport?.env?.AGENT_BRIDGE_CONFIG === backendConfigPath
        ? "matching"
        : "conflict";
    } catch {
      return "conflict";
    }
  }
  const lines = result.stdout.replace(/\r\n/g, "\n").split("\n");
  const scopeLine = {
    local: "  Scope: Local config (private to you in this project)",
    user: "  Scope: User config (available in all your projects)",
    project: "  Scope: Project config (shared via .mcp.json)",
  }[scope];
  const expectedPrefix = [
    "agent-bridge:",
    scopeLine,
  ];
  if (lines[0] !== expectedPrefix[0] || lines[1] !== expectedPrefix[1]
    || lines[3] !== "  Type: stdio" || lines[4] !== "  Command: " + command
    || lines[5] !== "  Args:" || lines[6] !== "  Environment:") return "conflict";
  const environmentLines: string[] = [];
  let index = 7;
  while (index < lines.length && lines[index]?.startsWith("    ")) {
    environmentLines.push(lines[index]!);
    index += 1;
  }
  const expectedEnvironment = [
    "    AGENT_BRIDGE_AGENT=" + enrollment.input.principal,
    "    AGENT_BRIDGE_INSTANCE=" + enrollment.input.instance,
    "    AGENT_BRIDGE_CONFIG=" + backendConfigPath,
  ].sort();
  if (environmentLines.sort().join("\n") !== expectedEnvironment.join("\n")) return "conflict";
  while (lines[index] === "") index += 1;
  if (lines[index] !== "To remove this server, run: claude mcp remove agent-bridge -s " + scope) {
    return "conflict";
  }
  if (lines.slice(index + 1).some((line) => line !== "")) return "conflict";
  return "matching";
}

function enrolledInstallLocked(
  runtimeAssertion: InstallableRuntime | undefined,
  identityAssertion: string,
  options: {
    command?: string;
    scope?: "local" | "user" | "project";
    instance?: string;
    token?: string;
    enrollmentFile: string;
    env?: NodeJS.ProcessEnv;
  },
  execute: Executor,
  lock: EnrollmentLock,
): ClientInstallResult {
  const env = options.env ?? process.env;
  let enrollment = readEnrollment(options.enrollmentFile, env);
  assertEnrollmentConfiguration(enrollment, {
    runtime: runtimeAssertion,
    identity: identityAssertion,
    instance: options.instance,
    token: options.token,
    env,
  });
  const runtime = enrollment.input.runtime;
  const identity = enrollment.input.principal;
  const expectedPath = clientBackendConfigPath(runtime, enrollment.input.instance, env);
  const command = options.command?.trim() || "agent-bridge-mcp";
  const desktopLaunch = runtime === "claude-desktop"
    ? resolveDesktopLaunchContract(options.command, env)
    : undefined;
  const scope = options.scope ?? "user";
  const baseResult: ClientInstallResult = {
    runtime,
    identity,
    instance: enrollment.input.instance,
    method: runtime === "claude-desktop" ? "json-config" : "native-cli",
    configPath: runtime === "claude-desktop" ? desktopConfigPath(env) : undefined,
    backendConfigPath: expectedPath,
    restartRequired: true,
  };
  if (enrollment.state === "consumed") {
    if (!enrollment.result
      || !backendMatches(expectedPath, enrollment, enrollment.result.credentialId, false)) {
      throw new Error("consumed enrollment no longer matches its client backend");
    }
    const inspected = runtime === "claude-desktop"
      ? desktopRegistrationState(enrollment, expectedPath, desktopLaunch!, env)
      : nativeRegistrationState(enrollment, expectedPath, command, scope, execute);
    const registration = runtime === "claude-desktop"
      ? repairLegacyDesktopRegistration(
          inspected, enrollment, expectedPath, desktopLaunch!, env,
        )
      : inspected;
    if (registration !== "matching") {
      throw new Error("consumed enrollment no longer matches its MCP registration");
    }
    return removeConsumedEnrollment(options.enrollmentFile, baseResult, lock, env);
  }
  if (enrollment.state === "pending") {
    throw new Error("enrollment is pending; resume the owner command first");
  }
  const recovering = enrollment.state === "consuming";
  if (!recovering && enrollment.operation === "provision" && existsSync(expectedPath)) {
    throw new Error("provision enrollment would replace an existing client backend file");
  }
  if (!recovering && enrollment.operation === "provision") {
    const registration = runtime === "claude-desktop"
      ? desktopRegistrationState(enrollment, expectedPath, desktopLaunch!, env)
      : nativeRegistrationState(enrollment, expectedPath, command, scope, execute);
    if (registration !== "absent") {
      throw new Error("provision enrollment would replace an existing MCP registration");
    }
  }
  if (enrollment.state === "ready") {
    enrollment = transitionEnrollment(options.enrollmentFile, enrollment, "consuming", {}, env, lock);
  }
  if (enrollment.state !== "consuming" || !enrollment.token) {
    throw new Error("enrollment is not ready for installation");
  }
  const derivedEnv: NodeJS.ProcessEnv = {
    ...env,
    AGENT_BRIDGE_PROVIDER: "gateway",
    AGENT_BRIDGE_URL: enrollment.input.gatewayUrl,
    AGENT_BRIDGE_WORKSPACE: enrollment.input.workspaceId,
    AGENT_BRIDGE_AGENT: undefined,
    AGENT_BRIDGE_INSTANCE: undefined,
    AGENT_BRIDGE_CLIENT_TOKEN: undefined,
  };
  let result: ClientInstallResult;
  let sideEffectsCompleted = false;
  try {
    if (enrollment.operation === "rotate") {
      if (!enrollment.input.credentialId || !enrollment.result) {
        throw new Error("rotation enrollment lacks credential lineage");
      }
      const predecessorMatches = backendMatches(
        expectedPath, enrollment, enrollment.input.credentialId, false,
      );
      const successorMatches = recovering && backendMatches(
        expectedPath, enrollment, enrollment.result.credentialId, true,
      );
      if (!predecessorMatches && !successorMatches) {
        throw new Error("rotation requires an exactly bound predecessor or successor backend");
      }
      const inspected = runtime === "claude-desktop"
        ? desktopRegistrationState(enrollment, expectedPath, desktopLaunch!, env)
        : nativeRegistrationState(enrollment, expectedPath, command, scope, execute);
      const registration = runtime === "claude-desktop"
        ? repairLegacyDesktopRegistration(
            inspected, enrollment, expectedPath, desktopLaunch!, env,
          )
        : inspected;
      if (registration !== "matching") {
        throw new Error("rotation requires the exact existing MCP registration");
      }
      if (predecessorMatches) {
        const previous = readFileSync(expectedPath);
        try {
          writeBackendConfig(runtime, identity, enrollment.input.instance, {
            token: enrollment.token,
            env: derivedEnv,
            binding: {
              credentialId: enrollment.result.credentialId,
              principal: identity,
              instance: enrollment.input.instance,
            },
          });
        } catch (error) {
          replacePrivateFile(expectedPath, previous);
          throw error;
        }
      }
      result = baseResult;
      sideEffectsCompleted = true;
    } else {
      if (recovering && existsSync(expectedPath) && !backendMatches(
        expectedPath, enrollment, enrollment.result!.credentialId, true,
      )) {
        throw new Error("consuming enrollment conflicts with its client backend file");
      }
      const inspected = recovering
        ? runtime === "claude-desktop"
          ? desktopRegistrationState(enrollment, expectedPath, desktopLaunch!, env)
          : nativeRegistrationState(enrollment, expectedPath, command, scope, execute)
        : "absent";
      const registration = recovering && runtime === "claude-desktop"
        ? repairLegacyDesktopRegistration(
            inspected, enrollment, expectedPath, desktopLaunch!, env,
          )
        : inspected;
      if (recovering && registration === "conflict") {
        throw new Error("consuming enrollment conflicts with the registered MCP server");
      }
      if (recovering && backendMatches(
        expectedPath, enrollment, enrollment.result!.credentialId, true,
      ) && registration === "matching") {
        result = baseResult;
      } else {
        result = installClient(runtime, identity, {
          command: runtime === "claude-desktop" ? options.command : command,
          scope: options.scope,
          instance: enrollment.input.instance,
          token: enrollment.token,
          backendBinding: {
            credentialId: enrollment.result!.credentialId,
            principal: identity,
            instance: enrollment.input.instance,
          },
          env: derivedEnv,
        }, execute);
        sideEffectsCompleted = true;
        const verified = runtime === "claude-desktop"
          ? desktopRegistrationState(enrollment, expectedPath, desktopLaunch!, env)
          : nativeRegistrationState(enrollment, expectedPath, command, scope, execute);
        if (verified !== "matching") throw new Error("MCP registration verification failed");
      }
    }
  } catch (error) {
    if (!recovering && !sideEffectsCompleted) {
      transitionEnrollment(options.enrollmentFile, enrollment, "ready", {}, env, lock);
    }
    throw error;
  }
  enrollment = transitionEnrollment(
    options.enrollmentFile,
    enrollment,
    "consumed",
    { token: null },
    env,
    lock,
  );
  return removeConsumedEnrollment(options.enrollmentFile, result, lock, env);
}

function enrolledInstall(
  runtime: InstallableRuntime | undefined,
  identity: string,
  options: {
    command?: string;
    scope?: "local" | "user" | "project";
    instance?: string;
    token?: string;
    enrollmentFile: string;
    recoverLock?: boolean;
    env?: NodeJS.ProcessEnv;
  },
  execute: Executor,
): ClientInstallResult {
  const env = options.env ?? process.env;
  if (options.recoverLock) recoverEnrollmentLock(options.enrollmentFile, env);
  const lock = acquireEnrollmentLock(options.enrollmentFile, env);
  let result: ClientInstallResult;
  try {
    result = enrolledInstallLocked(runtime, identity, options, execute, lock);
  } catch (error) {
    if (!lock.released) {
      try { releaseEnrollmentLock(lock); } catch {}
    }
    throw error;
  }
  let lockReleaseStatus: NonNullable<ClientInstallResult["lockReleaseStatus"]>;
  try {
    const release = releaseEnrollmentLock(lock);
    lockReleaseStatus = release === "released" ? "released" : "durability-unknown";
  } catch {
    lockReleaseStatus = existsSync(lock.lockPath) ? "retained" : "durability-unknown";
  }
  return { ...result, lockReleaseStatus };
}

export function installClient(
  runtime: InstallableRuntime | undefined,
  identity: string,
  options: {
    command?: string;
    scope?: "local" | "user" | "project";
    instance?: string;
    token?: string;
    enrollmentFile?: string;
    recoverLock?: boolean;
    backendBinding?: ClientBackendBinding;
    env?: NodeJS.ProcessEnv;
  } = {},
  execute: Executor = (command, args) => spawnSync(command, args, { encoding: "utf8" }),
): ClientInstallResult {
  if (options.enrollmentFile) {
    return enrolledInstall(runtime, identity, {
      ...options,
      enrollmentFile: options.enrollmentFile,
    }, execute);
  }
  if (!runtime) throw new Error("install runtime is required");
  const normalizedIdentity = identity.trim();
  if (!normalizedIdentity || normalizedIdentity.length > 128) throw new Error("--identity is required");
  const instance = options.instance?.trim() || `${runtime}-${randomUUID()}`;
  if (instance.length > 128) throw new Error("--instance exceeds 128 characters");
  if (options.scope && !["local", "user", "project"].includes(options.scope)) {
    throw new Error("scope must be local, user, or project");
  }
  const command = options.command?.trim() || "agent-bridge-mcp";
  const env = options.env ?? process.env;
  const desktopLaunch = runtime === "claude-desktop"
    ? resolveDesktopLaunchContract(options.command, env)
    : undefined;
  const expectedPath = clientBackendConfigPath(runtime, instance, env);
  const previous = existsSync(expectedPath) ? readFileSync(expectedPath) : undefined;
  try {
    const backendConfigPath = writeBackendConfig(runtime, normalizedIdentity, instance, {
      token: options.token,
      env,
      binding: options.backendBinding,
    });
    if (runtime === "claude-desktop") {
      const path = desktopConfigPath(env);
      writeJsonConfig(path, normalizedIdentity, instance, backendConfigPath, desktopLaunch!);
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
