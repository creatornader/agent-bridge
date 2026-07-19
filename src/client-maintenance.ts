import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  beginClientOperation, classifyClientOperationRestart, completeClientOperationCleanup,
  readClientOperation, recordClientOperationStepApplied, recordClientOperationStepIntent,
  recoverClientOperationLock, releaseClientOperationLock, resumeClientOperation,
  transitionClientOperation, writeClientOperationSnapshot, type ClientOperationLaunch,
  type ClientOperationManifest,
} from "./client-operation.js";
import {
  assertNoLinkedPathAncestors, loadManagedClientMetadata, managedClientMetadataPath,
  newNativeExecutableContract,
  observeManagedRegistration,
  writeManagedClientMetadata, type ClientLifecycleExecutor, type ClientRegistrationLocator,
  type ManagedClientMetadata, type ManagedRegistrationObservation,
} from "./client-lifecycle.js";
import { resolveDesktopLaunchContract, type InstallableRuntime } from "./client-installer.js";
import { securePrivatePath, verifyPrivatePathAccess } from "./private-path.js";

const MAX_DESKTOP_CONFIG_BYTES = 4 * 1024 * 1024;

type BackendState = "private" | "repairable";
type PlannedKind = "backend" | "native-remove" | "native-add" | "desktop-replace" | "metadata";

interface BackendProof {
  role: "backend";
  file: { device: number; inode: number };
  parent: { device: number; inode: number };
  state: BackendState;
}

interface PlannedStep {
  kind: PlannedKind;
  target: "backend" | "registration" | "metadata";
  locator: string;
  before: string;
  after: string;
}

export interface ClientMaintenancePlan {
  schemaVersion: 1;
  action: "repair" | "update" | "none";
  applied: boolean;
  operationId?: string;
  runtime: InstallableRuntime;
  instance: string;
  identity: string;
  metadataPath: string;
  steps: Array<{ target: "backend" | "registration" | "metadata"; action: string }>;
}

interface ClientMaintenanceTestHooks {
  afterLock?: () => void;
  beforeApply?: (step: { target: PlannedStep["target"]; action: PlannedKind }) => void;
  afterApply?: (step: { target: PlannedStep["target"]; action: PlannedKind }) => void;
  afterBackendPin?: () => void;
  desktop?: DesktopMaintenanceHooks;
}

export interface ClientMaintenanceOptions {
  action: "repair" | "update";
  runtime: InstallableRuntime;
  instance: string;
  identity: string;
  command?: string;
  apply?: boolean;
  resume?: string;
  recoverLock?: boolean;
  env?: NodeJS.ProcessEnv;
  execute?: ClientLifecycleExecutor;
  /** Test-only fault injection for mutation-boundary regression coverage. */
  testHooks?: ClientMaintenanceTestHooks;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixedEnvKeys(): ClientOperationLaunch["envKeys"] {
  return ["AGENT_BRIDGE_AGENT", "AGENT_BRIDGE_CONFIG", "AGENT_BRIDGE_INSTANCE"];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value as Record<string, unknown>).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function assertRuntime(runtime: string): asserts runtime is InstallableRuntime {
  if (!["codex", "claude-code", "claude-desktop"].includes(runtime)) {
    throw new Error(`unsupported client runtime: ${runtime}`);
  }
}

function assertIdentity(metadata: ManagedClientMetadata, assertion: string): void {
  if (!assertion || assertion.trim() !== assertion || assertion !== metadata.identity) {
    throw new Error("--identity must exactly match managed metadata");
  }
}

function registrationProof(observation: ManagedRegistrationObservation): string {
  return canonical({ role: "registration", observation });
}

function metadataProof(metadata: ManagedClientMetadata): string {
  return canonical({ role: "metadata", metadata });
}

function operationLaunch(metadata: ManagedClientMetadata): ClientOperationLaunch {
  return {
    command: metadata.launch.command,
    args: [...metadata.launch.args],
    scope: metadata.launch.scope,
    envKeys: fixedEnvKeys(),
  };
}

function updateMetadata(metadata: ManagedClientMetadata, launch: ClientOperationLaunch): ManagedClientMetadata {
  return {
    ...metadata,
    launch: { command: launch.command, args: [...launch.args], scope: launch.scope },
  };
}

function resolveUpdateLaunch(
  metadata: ManagedClientMetadata,
  command: string | undefined,
  env: NodeJS.ProcessEnv,
): ClientOperationLaunch {
  if (metadata.runtime === "claude-desktop") {
    const launch = resolveDesktopLaunchContract(command, env);
    return { command: launch.command, args: [...launch.args], scope: null, envKeys: fixedEnvKeys() };
  }
  const requested = command === undefined ? "agent-bridge-mcp" : command;
  newNativeExecutableContract(requested, "--command");
  return {
    command: requested,
    args: [],
    scope: metadata.runtime === "claude-code" ? metadata.launch.scope : null,
    envKeys: fixedEnvKeys(),
  };
}

function backendPolicy(path: string): BackendProof {
  const parentPath = dirname(path);
  const parent = lstatSync(parentPath);
  const file = lstatSync(path);
  if (parent.isSymbolicLink() || !parent.isDirectory() || file.isSymbolicLink() || !file.isFile()) {
    throw new Error("managed backend path cannot be a link or non-regular file");
  }
  if (typeof process.getuid === "function" && (parent.uid !== process.getuid() || file.uid !== process.getuid())) {
    throw new Error("managed backend path is not owned by the current user");
  }
  if (process.platform === "win32") {
    try {
      verifyPrivatePathAccess(parentPath, "directory");
      verifyPrivatePathAccess(path, "file");
      return {
        role: "backend", file: { device: file.dev, inode: file.ino },
        parent: { device: parent.dev, inode: parent.ino }, state: "private",
      };
    } catch {
      throw new Error("managed backend policy cannot be tightened safely on this platform");
    }
  }
  const exactPrivate = (parent.mode & 0o777) === 0o700 && (file.mode & 0o777) === 0o600;
  if (exactPrivate) {
    verifyPrivatePathAccess(parentPath, "directory");
    verifyPrivatePathAccess(path, "file");
    return {
      role: "backend", file: { device: file.dev, inode: file.ino },
      parent: { device: parent.dev, inode: parent.ino }, state: "private",
    };
  }
  if ((parent.mode & 0o700) !== 0o700 || (file.mode & 0o600) !== 0o600
    || (parent.mode & 0o7000) !== 0 || (file.mode & 0o7000) !== 0) {
    throw new Error("managed backend policy would require nonmonotonic permission changes");
  }
  return {
    role: "backend", file: { device: file.dev, inode: file.ino },
    parent: { device: parent.dev, inode: parent.ino }, state: "repairable",
  };
}

function tightenBackendPolicy(path: string, before: BackendProof, afterPin?: () => void): void {
  const current = backendPolicy(path);
  if (current.state !== "repairable" || current.file.device !== before.file.device
    || current.file.inode !== before.file.inode || current.parent.device !== before.parent.device
    || current.parent.inode !== before.parent.inode) {
    throw new Error("managed backend changed before privacy repair");
  }
  if (process.platform === "win32") throw new Error("managed backend policy cannot be tightened safely on this platform");
  const parentDescriptor = openSync(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const parent = fstatSync(parentDescriptor);
    if (!parent.isDirectory() || parent.dev !== before.parent.device || parent.ino !== before.parent.inode
      || (typeof process.getuid === "function" && parent.uid !== process.getuid())) {
      throw new Error("managed backend parent changed during privacy repair");
    }
    const fileDescriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const file = fstatSync(fileDescriptor);
      if (!file.isFile() || file.dev !== before.file.device || file.ino !== before.file.inode
        || (typeof process.getuid === "function" && file.uid !== process.getuid())) {
        throw new Error("managed backend changed during privacy repair");
      }
      afterPin?.();
      fchmodSync(parentDescriptor, 0o700);
      fchmodSync(fileDescriptor, 0o600);
      const securedParent = fstatSync(parentDescriptor);
      const securedFile = fstatSync(fileDescriptor);
      if (securedParent.dev !== before.parent.device || securedParent.ino !== before.parent.inode
        || securedFile.dev !== before.file.device || securedFile.ino !== before.file.inode
        || (securedParent.mode & 0o777) !== 0o700 || (securedFile.mode & 0o777) !== 0o600) {
        throw new Error("managed backend changed during privacy repair");
      }
    } finally { closeSync(fileDescriptor); }
  } finally { closeSync(parentDescriptor); }
  if (backendPolicy(path).state !== "private") throw new Error("managed backend privacy repair failed");
}

function nativeContext(metadata: ManagedClientMetadata, env: NodeJS.ProcessEnv): { cwd?: string; env: NodeJS.ProcessEnv } {
  if (metadata.runtime === "codex") {
    const locator = metadata.locator as Extract<ClientRegistrationLocator, { kind: "codex-profile" }>;
    return { env: { ...env, CODEX_HOME: dirname(locator.configPath) } };
  }
  const locator = metadata.locator as Extract<ClientRegistrationLocator, { kind: "claude-code-scope" }>;
  return { cwd: locator.contextPath ?? undefined, env: { ...env } };
}

function nativeExecute(
  metadata: ManagedClientMetadata,
  action: "remove" | "add",
  execute: ClientLifecycleExecutor,
  env: NodeJS.ProcessEnv,
): void {
  const context = nativeContext(metadata, env);
  const executable = metadata.runtime === "codex" ? "codex" : "claude";
  const args = action === "remove"
    ? metadata.runtime === "codex"
      ? ["mcp", "remove", "agent-bridge"]
      : ["mcp", "remove", "agent-bridge", "-s", metadata.launch.scope!]
    : metadata.runtime === "codex"
      ? [
          "mcp", "add", "agent-bridge",
          "--env", `AGENT_BRIDGE_AGENT=${metadata.identity}`,
          "--env", `AGENT_BRIDGE_INSTANCE=${metadata.instance}`,
          "--env", `AGENT_BRIDGE_CONFIG=${metadata.backendConfigPath}`,
          "--", metadata.launch.command,
        ]
      : [
          "mcp", "add", "--scope", metadata.launch.scope!, "agent-bridge",
          "-e", `AGENT_BRIDGE_AGENT=${metadata.identity}`,
          "-e", `AGENT_BRIDGE_INSTANCE=${metadata.instance}`,
          "-e", `AGENT_BRIDGE_CONFIG=${metadata.backendConfigPath}`,
          "--", metadata.launch.command,
        ];
  const result = execute(executable, args, context);
  if (result.error || result.status !== 0) {
    throw new Error(`${metadata.runtime} MCP ${action} failed`);
  }
}

interface DesktopConfigRead {
  config: Record<string, unknown>;
  identity: { device: number; inode: number } | null;
}

function readDesktopConfigNoFollow(path: string): DesktopConfigRead {
  assertNoLinkedPathAncestors(path);
  if (!existsSync(path)) return { config: {}, identity: null };
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_DESKTOP_CONFIG_BYTES) {
    throw new Error("Claude Desktop config is not a safe regular JSON file");
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_DESKTOP_CONFIG_BYTES
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Claude Desktop config changed during access");
    }
    const parsed = JSON.parse(readFileSync(descriptor, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Claude Desktop config is not valid JSON");
    }
    const after = lstatSync(path);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error("Claude Desktop config changed during access");
    }
    return { config: parsed as Record<string, unknown>, identity: { device: opened.dev, inode: opened.ino } };
  } finally { closeSync(descriptor); }
}

interface DesktopMaintenanceHooks {
  afterTemporarySync?: () => void;
  beforeRename?: () => void;
  afterRename?: () => void;
}

function sameIdentity(path: string, identity: { device: number; inode: number }, message: string): void {
  const current = lstatSync(path);
  if (current.isSymbolicLink() || !current.isFile()
    || current.dev !== identity.device || current.ino !== identity.inode) {
    throw new Error(message);
  }
}

function temporaryIdentity(path: string, privateRequired = true): { device: number; inode: number } {
  const details = lstatSync(path);
  if (details.isSymbolicLink() || !details.isFile()
    || (typeof process.getuid === "function" && details.uid !== process.getuid())) {
    throw new Error("Claude Desktop temporary config is not safe");
  }
  if (privateRequired && process.platform !== "win32" && (details.mode & 0o777) !== 0o600) {
    throw new Error("Claude Desktop temporary config is not private");
  }
  if (privateRequired) verifyPrivatePathAccess(path, "file");
  return { device: details.dev, inode: details.ino };
}

function syncDesktopDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function removeKnownTemporary(path: string, identity: { device: number; inode: number } | null): void {
  if (!existsSync(path)) return;
  const current = temporaryIdentity(path);
  if (identity && (current.device !== identity.device || current.inode !== identity.inode)) {
    throw new Error("Claude Desktop temporary config changed during cleanup");
  }
  rmSync(path);
  syncDesktopDirectory(dirname(path));
}

function replaceDesktopRegistration(
  metadata: ManagedClientMetadata,
  operationId: string,
  stepIndex: number,
  hooks?: DesktopMaintenanceHooks,
): void {
  const locator = metadata.locator as Extract<ClientRegistrationLocator, { kind: "claude-desktop-config" }>;
  const path = locator.configPath;
  const directory = dirname(path);
  assertNoLinkedPathAncestors(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoLinkedPathAncestors(path);
  const directoryInfo = lstatSync(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error("Claude Desktop config directory is not safe");
  }
  const directoryIdentity = { device: directoryInfo.dev, inode: directoryInfo.ino };
  const read = readDesktopConfigNoFollow(path);
  const servers = read.config.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Error("Claude Desktop mcpServers is not an object");
  }
  const next = {
    ...read.config,
    mcpServers: {
      ...(servers as Record<string, unknown> | undefined),
      "agent-bridge": {
        command: metadata.launch.command,
        args: metadata.launch.args,
        env: {
          AGENT_BRIDGE_AGENT: metadata.identity,
          AGENT_BRIDGE_INSTANCE: metadata.instance,
          AGENT_BRIDGE_CONFIG: metadata.backendConfigPath,
        },
      },
    },
  };
  const temporary = join(directory, `.ab-${operationId.slice(0, 8)}-${stepIndex}-${digest(path).slice(0, 12)}.tmp`);
  removeKnownTemporary(temporary, null);
  let temporaryFile: { device: number; inode: number } | null = null;
  let operationError: unknown;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      temporaryFile = temporaryIdentity(temporary, false);
      securePrivatePath(temporary, "file");
      temporaryFile = temporaryIdentity(temporary);
      writeFileSync(descriptor, `${JSON.stringify(next, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    temporaryFile = temporaryIdentity(temporary);
    hooks?.afterTemporarySync?.();
    const currentDirectory = lstatSync(directory);
    if (currentDirectory.isSymbolicLink() || !currentDirectory.isDirectory()
      || currentDirectory.dev !== directoryIdentity.device || currentDirectory.ino !== directoryIdentity.inode) {
      throw new Error("Claude Desktop config directory changed before publication");
    }
    if (read.identity) {
      sameIdentity(path, read.identity, "Claude Desktop config changed before publication");
    } else if (existsSync(path)) {
      throw new Error("Claude Desktop config appeared before publication");
    }
    hooks?.beforeRename?.();
    if (read.identity) sameIdentity(path, read.identity, "Claude Desktop config changed before publication");
    else if (existsSync(path)) throw new Error("Claude Desktop config appeared before publication");
    temporaryIdentity(temporary);
    renameSync(temporary, path);
    temporaryFile = null;
    hooks?.afterRename?.();
    securePrivatePath(path, "file");
    verifyPrivatePathAccess(path, "file");
    const publishedDirectory = lstatSync(directory);
    if (publishedDirectory.isSymbolicLink() || publishedDirectory.dev !== directoryIdentity.device
      || publishedDirectory.ino !== directoryIdentity.inode) {
      throw new Error("Claude Desktop config directory changed during publication");
    }
    if (process.platform !== "win32") {
      const directoryDescriptor = openSync(directory, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    }
    const verified = readDesktopConfigNoFollow(path);
    const servers = verified.config.mcpServers as Record<string, unknown> | undefined;
    const entry = servers?.["agent-bridge"] as Record<string, unknown> | undefined;
    if (!entry || entry.command !== metadata.launch.command
      || !isDeepStrictEqual(entry.args, metadata.launch.args)
      || !isDeepStrictEqual(entry.env, {
        AGENT_BRIDGE_AGENT: metadata.identity,
        AGENT_BRIDGE_INSTANCE: metadata.instance,
        AGENT_BRIDGE_CONFIG: metadata.backendConfigPath,
      })) {
      throw new Error("Claude Desktop registration postcondition was not met");
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (temporaryFile) {
      try { removeKnownTemporary(temporary, temporaryFile); }
      catch (error) { if (!operationError) throw error; }
    }
  }
}

function buildPlan(
  metadata: ManagedClientMetadata,
  target: ManagedClientMetadata,
  execute: ClientLifecycleExecutor,
  env: NodeJS.ProcessEnv,
): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const policy = backendPolicy(metadata.backendConfigPath);
  if (policy.state === "repairable") {
    steps.push({
      kind: "backend", target: "backend", locator: "managed-backend-policy",
      before: canonical(policy), after: canonical({ ...policy, state: "private" }),
    });
  }
  const registration = observeManagedRegistration(target, execute, env, metadata.launch.args);
  const absentRegistration: ManagedRegistrationObservation = {
    state: "absent", target: registration.target, observed: { state: "absent" },
  };
  const exactRegistration: ManagedRegistrationObservation = {
    state: "exact", target: registration.target,
    observed: {
      state: "present", command: target.launch.command, args: [...target.launch.args],
      env: {
        AGENT_BRIDGE_AGENT: target.identity,
        AGENT_BRIDGE_INSTANCE: target.instance,
        AGENT_BRIDGE_CONFIG: target.backendConfigPath,
      },
    },
  };
  if (target.runtime === "claude-desktop") {
    if (registration.state !== "exact") {
      steps.push({
        kind: "desktop-replace", target: "registration", locator: "claude-desktop:agent-bridge",
        before: registrationProof(registration), after: registrationProof(exactRegistration),
      });
    }
  } else if (registration.state === "inexact") {
    steps.push({
      kind: "native-remove", target: "registration", locator: `${target.runtime}:agent-bridge`,
      before: registrationProof(registration), after: registrationProof(absentRegistration),
    });
    steps.push({
      kind: "native-add", target: "registration", locator: `${target.runtime}:agent-bridge`,
      before: registrationProof(absentRegistration), after: registrationProof(exactRegistration),
    });
  } else if (registration.state === "absent") {
    steps.push({
      kind: "native-add", target: "registration", locator: `${target.runtime}:agent-bridge`,
      before: registrationProof(absentRegistration), after: registrationProof(exactRegistration),
    });
  }
  if (!isDeepStrictEqual(metadata.launch, target.launch)) {
    steps.push({
      kind: "metadata", target: "metadata", locator: "managed-client-metadata",
      before: metadataProof(metadata), after: metadataProof(target),
    });
  }
  return steps;
}

function executionStepsFromManifest(
  manifest: ClientOperationManifest,
  target: ManagedClientMetadata,
): PlannedStep[] {
  const registrationSteps = manifest.steps.filter((step) => step.target === "registration");
  let registrationIndex = 0;
  return manifest.steps.map((step) => {
    let kind: PlannedKind;
    if (step.target === "backend") kind = "backend";
    else if (step.target === "metadata") kind = "metadata";
    else if (target.runtime === "claude-desktop") kind = "desktop-replace";
    else {
      kind = registrationSteps.length === 2 && registrationIndex++ === 0 ? "native-remove" : "native-add";
    }
    return { kind, target: step.target, locator: step.locator, before: "", after: "" };
  });
}

interface ObservedStep {
  proof: string;
  backend?: BackendProof;
}

function observedProof(
  step: PlannedStep,
  metadata: ManagedClientMetadata,
  target: ManagedClientMetadata,
  execute: ClientLifecycleExecutor,
  env: NodeJS.ProcessEnv,
): ObservedStep {
  if (step.kind === "backend") {
    const backend = backendPolicy(metadata.backendConfigPath);
    return { proof: canonical(backend), backend };
  }
  if (step.kind === "metadata") {
    return { proof: metadataProof(loadManagedClientMetadata(metadata.runtime, metadata.instance, env)) };
  }
  return { proof: registrationProof(observeManagedRegistration(target, execute, env, metadata.launch.args)) };
}

function applyStep(
  step: PlannedStep,
  observed: ObservedStep,
  metadata: ManagedClientMetadata,
  target: ManagedClientMetadata,
  execute: ClientLifecycleExecutor,
  env: NodeJS.ProcessEnv,
  operationId: string,
  stepIndex: number,
  desktopHooks?: DesktopMaintenanceHooks,
  afterBackendPin?: () => void,
): void {
  if (step.kind === "backend") {
    if (!observed.backend) throw new Error("backend proof is unavailable");
    tightenBackendPolicy(metadata.backendConfigPath, observed.backend, afterBackendPin);
    return;
  }
  if (step.kind === "native-remove") return nativeExecute(target, "remove", execute, env);
  if (step.kind === "native-add") return nativeExecute(target, "add", execute, env);
  if (step.kind === "desktop-replace") return replaceDesktopRegistration(target, operationId, stepIndex, desktopHooks);
  const current = loadManagedClientMetadata(metadata.runtime, metadata.instance, env);
  if (!isDeepStrictEqual(current, metadata)) throw new Error("managed metadata changed before update");
  writeManagedClientMetadata(managedClientMetadataPath(target.runtime, target.instance, env), target);
  const after = loadManagedClientMetadata(target.runtime, target.instance, env);
  if (!isDeepStrictEqual(after, target)) throw new Error("managed metadata update was not verified");
}

function resumeLaunch(
  metadata: ManagedClientMetadata,
  manifest: ClientOperationManifest,
  command: string | undefined,
  env: NodeJS.ProcessEnv,
  action: "repair" | "update",
): ManagedClientMetadata {
  if (manifest.runtime !== metadata.runtime || manifest.instance !== metadata.instance) {
    throw new Error("--resume does not match this client action, runtime, or instance");
  }
  if (manifest.version !== 3) {
    throw new Error("--resume requires an identity-bound operation request");
  }
  if (action === "repair") {
    if (!manifest.request || manifest.request.kind !== "repair" || !("identity" in manifest.request)
      || manifest.request.identity !== metadata.identity) {
      throw new Error("--resume does not match this client action, runtime, or instance");
    }
    if (command !== undefined) throw new Error("--command is not valid for clients repair");
    return metadata;
  }
  if (!manifest.request || manifest.request.kind !== "update" || !("identity" in manifest.request)
    || !("launch" in manifest.request) || manifest.request.identity !== metadata.identity) {
    throw new Error("--resume does not match this client action, runtime, or instance");
  }
  const recorded = manifest.request.launch;
  if (metadata.runtime === "claude-desktop") {
    const resolved = recorded.args.length === 0
      ? resolveDesktopLaunchContract(recorded.command, env)
      : resolveDesktopLaunchContract(undefined, env);
    if (resolved.command !== recorded.command || !isDeepStrictEqual(resolved.args, recorded.args)) {
      throw new Error("recorded Desktop update launch is invalid");
    }
  }
  if (command !== undefined) {
    const supplied = resolveUpdateLaunch(metadata, command, env);
    if (!isDeepStrictEqual(supplied, recorded)) {
      throw new Error("--command does not match the recorded update request");
    }
  }
  return updateMetadata(metadata, recorded);
}

function planResult(
  action: "repair" | "update" | "none", applied: boolean, metadata: ManagedClientMetadata,
  steps: PlannedStep[], env: NodeJS.ProcessEnv, operationId?: string,
): ClientMaintenancePlan {
  return {
    schemaVersion: 1, action, applied, operationId, runtime: metadata.runtime,
    instance: metadata.instance, identity: metadata.identity,
    metadataPath: managedClientMetadataPath(metadata.runtime, metadata.instance, env),
    steps: steps.map((step) => ({ target: step.target, action: step.kind })),
  };
}

/**
 * Repair or update one metadata-owned registration. The dry-run path does not acquire a lock,
 * create operation state, or touch the registration, backend, or metadata file.
 */
export function maintainManagedClient(options: ClientMaintenanceOptions): ClientMaintenancePlan {
  assertRuntime(options.runtime);
  const env = options.env ?? process.env;
  const execute = options.execute ?? ((command, args, context) => spawnSync(command, args, {
    encoding: "utf8", cwd: context?.cwd, env: context?.env,
  }));
  const metadata = loadManagedClientMetadata(options.runtime, options.instance, env);
  assertIdentity(metadata, options.identity);
  const authority = metadataProof(metadata);
  const requestedAction = options.action;
  const manifest = options.resume ? readClientOperation(options.resume, env) : undefined;
  const target = manifest
    ? resumeLaunch(metadata, manifest, options.command, env, requestedAction)
    : requestedAction === "update"
      ? updateMetadata(metadata, resolveUpdateLaunch(metadata, options.command, env))
      : metadata;
  const steps = options.resume && options.apply ? [] : buildPlan(metadata, target, execute, env);
  if (!options.apply) {
    if (options.resume || options.recoverLock) throw new Error("--resume and --recover-lock require --apply");
    return planResult(steps.length === 0 ? "none" : requestedAction, false, metadata, steps, env);
  }
  if (options.recoverLock) recoverClientOperationLock(metadata.runtime, metadata.instance, env);
  if (steps.length === 0 && !options.resume) return planResult("none", false, metadata, steps, env);
  const begun = options.resume
    ? resumeClientOperation(options.resume, env)
    : beginClientOperation({
      request: requestedAction === "repair"
        ? { kind: "repair", identity: metadata.identity }
        : { kind: "update", identity: metadata.identity, launch: operationLaunch(target) },
      runtime: metadata.runtime, instance: metadata.instance,
      steps: steps.map((step, index) => ({
        target: step.target, locator: step.locator,
        beforeArtifact: `step-${index}.before`, afterArtifact: `step-${index}.after`,
        expectedBeforeSha256: digest(step.before), expectedAfterSha256: digest(step.after),
      })),
    }, env);
  let current = begun.manifest;
  try {
    options.testHooks?.afterLock?.();
    if (metadataProof(loadManagedClientMetadata(metadata.runtime, metadata.instance, env)) !== authority) {
      throw new Error("managed metadata changed while acquiring the client lock");
    }
    const recordedSteps = options.resume && current.state !== "prepared"
      ? executionStepsFromManifest(current, target)
      : buildPlan(metadata, target, execute, env);
    if (recordedSteps.length !== current.steps.length) {
      throw new Error("operation request no longer matches the managed client state");
    }
    if (current.state === "prepared") {
      if (recordedSteps.some((step, index) => digest(step.before) !== current.steps[index]?.expectedBeforeSha256
        || digest(step.after) !== current.steps[index]?.expectedAfterSha256)) {
        throw new Error("operation request no longer matches the managed client state");
      }
      for (let index = 0; index < recordedSteps.length; index += 1) {
        current = writeClientOperationSnapshot(
          current.operationId, current, `step-${index}.before`, recordedSteps[index]!.before, begun.lock, env,
        );
      }
      current = transitionClientOperation(current.operationId, current, "snapshotted", begun.lock, env);
    }
    for (let index = 0; index < recordedSteps.length; index += 1) {
      const step = recordedSteps[index]!;
      const journalStep = current.steps[index]!;
      if (step.kind !== "metadata"
        && metadataProof(loadManagedClientMetadata(metadata.runtime, metadata.instance, env)) !== authority) {
        throw new Error("managed metadata changed before a client mutation");
      }
      let actual = observedProof(step, metadata, target, execute, env);
      let intentAlreadyRecorded = false;
      if (journalStep.state === "intent-recorded") {
        const classification = classifyClientOperationRestart(current, digest(actual.proof));
        if (classification.disposition === "advance") {
          current = recordClientOperationStepApplied(current.operationId, current, index, actual.proof, begun.lock, env);
          continue;
        }
        if (classification.disposition !== "retryable") throw new Error(classification.reason);
        intentAlreadyRecorded = true;
      } else if (journalStep.state === "observed-applied") {
        const supersededByLaterStep = current.steps.slice(index + 1)
          .some((later) => later.target === journalStep.target && later.state !== "pending");
        if (supersededByLaterStep) continue;
        if (digest(actual.proof) !== journalStep.expectedAfterSha256) {
          throw new Error(`completed operation step ${index} no longer matches its after-state`);
        }
        continue;
      } else if (digest(actual.proof) !== journalStep.expectedBeforeSha256) {
        throw new Error("operation step no longer matches its before-state");
      }
      if (!intentAlreadyRecorded) {
        current = recordClientOperationStepIntent(current.operationId, current, index, begun.lock, env);
      }
      options.testHooks?.beforeApply?.({ target: step.target, action: step.kind });
      applyStep(
        step, actual, metadata, target, execute, env, current.operationId, index,
        options.testHooks?.desktop, options.testHooks?.afterBackendPin,
      );
      options.testHooks?.afterApply?.({ target: step.target, action: step.kind });
      actual = observedProof(step, metadata, target, execute, env);
      current = recordClientOperationStepApplied(current.operationId, current, index, actual.proof, begun.lock, env);
    }
    current = completeClientOperationCleanup(current.operationId, current, begun.lock, env);
    return planResult(requestedAction, true, target, recordedSteps, env, current.operationId);
  } finally {
    releaseClientOperationLock(begun.lock);
  }
}

export function repairManagedClient(options: Omit<ClientMaintenanceOptions, "command" | "action">): ClientMaintenancePlan {
  return maintainManagedClient({ ...options, action: "repair" });
}

export function updateManagedClient(options: Omit<ClientMaintenanceOptions, "action">): ClientMaintenancePlan {
  return maintainManagedClient({ ...options, action: "update" });
}
