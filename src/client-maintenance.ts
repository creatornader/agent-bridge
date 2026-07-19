import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  beginClientOperation, classifyClientOperationRestart, completeClientOperationCleanup,
  readClientOperation, recordClientOperationStepApplied, recordClientOperationStepIntent,
  recoverClientOperationLock, releaseClientOperationLock, resumeClientOperation,
  transitionClientOperation, writeClientOperationSnapshot, type ClientOperationLaunch,
  type ClientOperationManifest, type ClientOperationRegistrationProof,
  type ClientOperationRollbackContract,
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
type PlannedKind = "backend" | "backend-delete" | "native-remove" | "native-add"
  | "desktop-replace" | "desktop-remove" | "metadata" | "metadata-delete";

interface BackendProof {
  role: "backend";
  file: { device: number; inode: number };
  parent: { device: number; inode: number };
  state: BackendState;
}

interface BackendAbsentProof {
  role: "backend";
  parent: { device: number; inode: number };
  state: "absent";
  directoryDurability: "durable" | "unavailable";
}

interface MetadataAbsentProof {
  role: "metadata";
  runtime: InstallableRuntime;
  instance: string;
  parent: { device: number; inode: number };
  state: "absent";
  directoryDurability: "durable" | "unavailable";
}

interface PlannedStep {
  kind: PlannedKind;
  target: "backend" | "registration" | "metadata";
  locator: string;
  before: string;
  after: string;
  registrationMetadata?: "source" | "target";
  afterRegistrationMetadata?: "source" | "target";
}

export interface ClientMaintenancePlan {
  schemaVersion: 1;
  action: "repair" | "update" | "uninstall" | "rollback" | "none";
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
  beforeOperationBegin?: () => void;
  beforeApply?: (step: { target: PlannedStep["target"]; action: PlannedKind }) => void;
  afterApply?: (step: { target: PlannedStep["target"]; action: PlannedKind }) => void;
  afterBackendPin?: () => void;
  desktop?: DesktopMaintenanceHooks;
}

export interface ClientMaintenanceOptions {
  action: "repair" | "update" | "uninstall";
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

export interface ClientMaintenanceResumeOptions {
  operationId: string;
  recoverLock?: boolean;
  env?: NodeJS.ProcessEnv;
  execute?: ClientLifecycleExecutor;
  /** Test-only fault injection for mutation-boundary regression coverage. */
  testHooks?: ClientMaintenanceTestHooks;
}

export interface ClientRollbackOptions {
  sourceOperationId: string;
  identity: string;
  apply?: boolean;
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

function assertCurrentOperationManifest(current: ClientOperationManifest, env: NodeJS.ProcessEnv): void {
  const persisted = readClientOperation(current.operationId, env);
  if (!isDeepStrictEqual(persisted, current) || canonical(persisted) !== canonical(current)) {
    throw new Error("operation manifest changed while the client lock is held");
  }
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

function exactRegistrationObservation(metadata: ManagedClientMetadata): ManagedRegistrationObservation {
  return {
    state: "exact",
    target: {
      runtime: metadata.runtime, identity: metadata.identity, instance: metadata.instance,
      backendConfigPath: metadata.backendConfigPath,
      launch: { command: metadata.launch.command, args: [...metadata.launch.args], scope: metadata.launch.scope },
      locator: metadata.locator,
    },
    observed: {
      state: "present", command: metadata.launch.command, args: [...metadata.launch.args],
      env: {
        AGENT_BRIDGE_AGENT: metadata.identity,
        AGENT_BRIDGE_INSTANCE: metadata.instance,
        AGENT_BRIDGE_CONFIG: metadata.backendConfigPath,
      },
    },
  };
}

function rollbackContract(
  prior: ManagedClientMetadata,
  forward: ManagedClientMetadata,
): ClientOperationRollbackContract {
  const priorRegistration = exactRegistrationObservation(prior);
  const forwardRegistration = exactRegistrationObservation(forward);
  return {
    schema: "agent-bridge.client-update-rollback", version: 1, identity: prior.identity,
    priorMetadata: prior,
    priorRegistration: priorRegistration as ClientOperationRegistrationProof,
    forwardMetadataSha256: digest(metadataProof(forward)),
    forwardRegistrationSha256: digest(registrationProof(forwardRegistration)),
  };
}

function managedMetadataFromRollback(
  contract: ClientOperationRollbackContract,
): ManagedClientMetadata {
  return contract.priorMetadata as ManagedClientMetadata;
}

function assertRollbackContract(
  contract: ClientOperationRollbackContract,
  runtime: InstallableRuntime,
  instance: string,
): { prior: ManagedClientMetadata } {
  const prior = managedMetadataFromRollback(contract);
  if (prior.runtime !== runtime || prior.instance !== instance || prior.identity !== contract.identity) {
    throw new Error("rollback source does not match its recorded managed client");
  }
  const expectedPrior = exactRegistrationObservation(prior);
  if (canonical(contract.priorRegistration) !== canonical(expectedPrior)) {
    throw new Error("rollback source inverse registration contract is invalid");
  }
  return { prior };
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

function privateDirectoryProof(path: string, message: string): { device: number; inode: number } {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error(message);
  verifyPrivatePathAccess(path, "directory");
  const after = lstatSync(path);
  if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error(message);
  }
  return { device: before.dev, inode: before.ino };
}

function samePrivateDirectory(
  path: string,
  expected: { device: number; inode: number },
  message: string,
): void {
  const current = lstatSync(path);
  if (current.isSymbolicLink() || !current.isDirectory()
    || current.dev !== expected.device || current.ino !== expected.inode) {
    throw new Error(message);
  }
  verifyPrivatePathAccess(path, "directory");
}

function pathEntryIsAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function syncPrivateDirectory(
  path: string,
  expected: { device: number; inode: number },
  message: string,
): "durable" | "unavailable" {
  samePrivateDirectory(path, expected, message);
  if (process.platform === "win32") return "unavailable";
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory() || opened.dev !== expected.device || opened.ino !== expected.inode) {
      throw new Error(message);
    }
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  samePrivateDirectory(path, expected, message);
  return "durable";
}

function expectedBackendAbsentProof(before: BackendProof): BackendAbsentProof {
  return {
    role: "backend", parent: { ...before.parent }, state: "absent",
    directoryDurability: process.platform === "win32" ? "unavailable" : "durable",
  };
}

function observedBackendAbsentProof(
  path: string,
  expected: { device: number; inode: number },
): BackendAbsentProof {
  const parentPath = dirname(path);
  samePrivateDirectory(parentPath, expected, "managed backend directory changed during deletion");
  if (!pathEntryIsAbsent(path)) throw new Error("managed backend remains after deletion");
  const directoryDurability = syncPrivateDirectory(
    parentPath, expected, "managed backend directory changed during deletion",
  );
  return { role: "backend", parent: { ...expected }, state: "absent", directoryDurability };
}

function expectedMetadataAbsentProof(
  metadata: ManagedClientMetadata,
  env: NodeJS.ProcessEnv,
): MetadataAbsentProof {
  const parent = privateDirectoryProof(
    dirname(managedClientMetadataPath(metadata.runtime, metadata.instance, env)),
    "managed metadata directory is invalid",
  );
  return {
    role: "metadata", runtime: metadata.runtime, instance: metadata.instance,
    parent, state: "absent", directoryDurability: process.platform === "win32" ? "unavailable" : "durable",
  };
}

function observedMetadataAbsentProof(
  runtime: InstallableRuntime,
  instance: string,
  env: NodeJS.ProcessEnv,
  expected: { device: number; inode: number },
): MetadataAbsentProof {
  const path = managedClientMetadataPath(runtime, instance, env);
  const parentPath = dirname(path);
  samePrivateDirectory(parentPath, expected, "managed metadata directory changed during deletion");
  if (!pathEntryIsAbsent(path)) throw new Error("managed metadata remains after deletion");
  const directoryDurability = syncPrivateDirectory(
    parentPath, expected, "managed metadata directory changed during deletion",
  );
  return { role: "metadata", runtime, instance, parent: { ...expected }, state: "absent", directoryDurability };
}

function deletePrivateFile(
  path: string,
  expectedFile: { device: number; inode: number },
  expectedParent: { device: number; inode: number },
  description: string,
): "durable" | "unavailable" {
  const parentPath = dirname(path);
  samePrivateDirectory(parentPath, expectedParent, `${description} directory changed during deletion`);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== expectedFile.device || opened.ino !== expectedFile.inode) {
      throw new Error(`${description} changed during deletion`);
    }
  } finally { closeSync(descriptor); }
  const current = lstatSync(path);
  if (current.isSymbolicLink() || !current.isFile()
    || current.dev !== expectedFile.device || current.ino !== expectedFile.inode) {
    throw new Error(`${description} changed during deletion`);
  }
  unlinkSync(path);
  if (!pathEntryIsAbsent(path)) throw new Error(`${description} remains after deletion`);
  return syncPrivateDirectory(parentPath, expectedParent, `${description} directory changed during deletion`);
}

function deleteManagedClientMetadata(metadata: ManagedClientMetadata, env: NodeJS.ProcessEnv): "durable" | "unavailable" {
  const current = loadManagedClientMetadata(metadata.runtime, metadata.instance, env);
  if (!isDeepStrictEqual(current, metadata)) throw new Error("managed metadata changed before deletion");
  const path = managedClientMetadataPath(metadata.runtime, metadata.instance, env);
  const parent = privateDirectoryProof(dirname(path), "managed metadata directory is invalid");
  const file = lstatSync(path);
  if (file.isSymbolicLink() || !file.isFile()) throw new Error("managed metadata changed before deletion");
  verifyPrivatePathAccess(path, "file");
  return deletePrivateFile(path, { device: file.dev, inode: file.ino }, parent, "managed metadata");
}

function deleteBackend(
  path: string,
  before: BackendProof,
): "durable" | "unavailable" {
  if (before.state !== "private") throw new Error("managed backend must be private before deletion");
  const current = backendPolicy(path);
  if (current.state !== "private" || current.file.device !== before.file.device
    || current.file.inode !== before.file.inode || current.parent.device !== before.parent.device
    || current.parent.inode !== before.parent.inode) {
    throw new Error("managed backend changed before deletion");
  }
  return deletePrivateFile(path, before.file, before.parent, "managed backend");
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

function mutateDesktopRegistration(
  metadata: ManagedClientMetadata,
  operationId: string,
  stepIndex: number,
  action: "replace" | "remove",
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
  const nextServers = { ...(servers as Record<string, unknown> | undefined) };
  if (action === "replace") {
    nextServers["agent-bridge"] = {
      command: metadata.launch.command,
      args: metadata.launch.args,
      env: {
        AGENT_BRIDGE_AGENT: metadata.identity,
        AGENT_BRIDGE_INSTANCE: metadata.instance,
        AGENT_BRIDGE_CONFIG: metadata.backendConfigPath,
      },
    };
  } else {
    delete nextServers["agent-bridge"];
  }
  const next = {
    ...read.config,
    mcpServers: nextServers,
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
    if (action === "remove") {
      if (entry !== undefined) throw new Error("Claude Desktop registration removal was not verified");
    } else if (!entry || entry.command !== metadata.launch.command
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

function expectedBackendAbsentFromParent(parent: { device: number; inode: number }): BackendAbsentProof {
  return {
    role: "backend", parent: { ...parent }, state: "absent",
    directoryDurability: process.platform === "win32" ? "unavailable" : "durable",
  };
}

function uninstallBackendObservation(path: string): BackendProof | BackendAbsentProof {
  try { return backendPolicy(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = privateDirectoryProof(dirname(path), "managed backend directory is invalid");
    if (!pathEntryIsAbsent(path)) throw new Error("managed backend appeared during uninstall planning");
    return expectedBackendAbsentFromParent(parent);
  }
}

function assertUninstallPathIsolation(metadata: ManagedClientMetadata, env: NodeJS.ProcessEnv): void {
  const paths = [
    ["backend", metadata.backendConfigPath],
    ["metadata", managedClientMetadataPath(metadata.runtime, metadata.instance, env)],
  ] as Array<[string, string]>;
  if (metadata.runtime === "claude-desktop") {
    const locator = metadata.locator as Extract<ClientRegistrationLocator, { kind: "claude-desktop-config" }>;
    paths.push(["Desktop config", locator.configPath]);
  }
  const seen = new Map<string, string>();
  const existing = new Map<string, string>();
  for (const [role, path] of paths) {
    const resolved = resolve(path);
    const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const prior = seen.get(normalized);
    if (prior) throw new Error(`managed uninstall paths alias: ${prior} and ${role}`);
    seen.set(normalized, role);
    try {
      const entry = lstatSync(resolved, { bigint: true });
      const identity = `${entry.dev}:${entry.ino}`;
      const existingRole = existing.get(identity);
      if (existingRole) throw new Error(`managed uninstall paths alias: ${existingRole} and ${role}`);
      existing.set(identity, role);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function buildUninstallPlan(
  metadata: ManagedClientMetadata,
  execute: ClientLifecycleExecutor,
  env: NodeJS.ProcessEnv,
): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const registration = observeManagedRegistration(metadata, execute, env, metadata.launch.args);
  const absentRegistration: ManagedRegistrationObservation = {
    state: "absent", target: registration.target, observed: { state: "absent" },
  };
  if (registration.state !== "absent") {
    steps.push({
      kind: metadata.runtime === "claude-desktop" ? "desktop-remove" : "native-remove",
      target: "registration", locator: `${metadata.runtime}:agent-bridge`,
      before: registrationProof(registration), after: registrationProof(absentRegistration),
    });
  }
  const backend = uninstallBackendObservation(metadata.backendConfigPath);
  if (backend.state === "repairable") {
    throw new Error("managed backend must be private before uninstall deletes it");
  }
  if (backend.state === "private") {
    steps.push({
      kind: "backend-delete", target: "backend", locator: "managed-backend-policy",
      before: canonical(backend), after: canonical(expectedBackendAbsentProof(backend)),
    });
  }
  const metadataAbsent = expectedMetadataAbsentProof(metadata, env);
  steps.push({
    kind: "metadata-delete", target: "metadata", locator: "managed-client-metadata",
    before: metadataProof(metadata), after: canonical(metadataAbsent),
  });
  return steps;
}

function buildRollbackPlan(
  forward: ManagedClientMetadata,
  prior: ManagedClientMetadata,
): PlannedStep[] {
  const forwardRegistration = exactRegistrationObservation(forward);
  const priorRegistration = exactRegistrationObservation(prior);
  if (forward.runtime === "claude-desktop") {
    return [
      {
        kind: "desktop-replace", target: "registration", locator: "claude-desktop:agent-bridge",
        before: registrationProof(forwardRegistration), after: registrationProof(priorRegistration),
        registrationMetadata: "source", afterRegistrationMetadata: "target",
      },
      {
        kind: "metadata", target: "metadata", locator: "managed-client-metadata",
        before: metadataProof(forward), after: metadataProof(prior),
      },
    ];
  }
  const absentForward: ManagedRegistrationObservation = {
    state: "absent", target: forwardRegistration.target, observed: { state: "absent" },
  };
  const absentPrior: ManagedRegistrationObservation = {
    state: "absent", target: priorRegistration.target, observed: { state: "absent" },
  };
  return [
    {
      kind: "native-remove", target: "registration", locator: `${forward.runtime}:agent-bridge`,
      before: registrationProof(forwardRegistration), after: registrationProof(absentForward),
      registrationMetadata: "source", afterRegistrationMetadata: "source",
    },
    {
      kind: "native-add", target: "registration", locator: `${forward.runtime}:agent-bridge`,
      before: registrationProof(absentPrior), after: registrationProof(priorRegistration),
      registrationMetadata: "target", afterRegistrationMetadata: "target",
    },
    {
      kind: "metadata", target: "metadata", locator: "managed-client-metadata",
      before: metadataProof(forward), after: metadataProof(prior),
    },
  ];
}

function rollbackExecutionStepsFromManifest(
  manifest: ClientOperationManifest,
  prior: ManagedClientMetadata,
): PlannedStep[] {
  let registrationIndex = 0;
  return manifest.steps.map((step) => {
    if (step.target === "metadata") {
      return { kind: "metadata", target: "metadata", locator: step.locator, before: "", after: "" };
    }
    if (prior.runtime === "claude-desktop") {
      return {
        kind: "desktop-replace", target: "registration", locator: step.locator,
        before: "", after: "", registrationMetadata: "source", afterRegistrationMetadata: "target",
      };
    }
    const kind = registrationIndex++ === 0 ? "native-remove" : "native-add";
    return {
      kind, target: "registration", locator: step.locator, before: "", after: "",
      registrationMetadata: kind === "native-remove" ? "source" : "target",
      afterRegistrationMetadata: kind === "native-remove" ? "source" : "target",
    };
  });
}

function rollbackMetadataReachedAfterState(
  manifest: ClientOperationManifest | null,
  prior: ManagedClientMetadata,
  env: NodeJS.ProcessEnv,
): boolean {
  const metadataStep = manifest?.steps.find((step) => step.target === "metadata");
  if (!metadataStep) return false;
  if (metadataStep.state === "observed-applied") return true;
  if (metadataStep.state !== "intent-recorded") return false;
  const current = loadManagedClientMetadata(manifest!.runtime, manifest!.instance, env);
  return isDeepStrictEqual(current, prior)
    && digest(metadataProof(current)) === metadataStep.expectedAfterSha256;
}

function rollbackRegistrationHasProgress(manifest: ClientOperationManifest | null): boolean {
  return manifest?.steps.some((step) => step.target === "registration" && step.state !== "pending") ?? false;
}

function assertForwardRollbackMetadataState(
  forward: ManagedClientMetadata,
  contract: ClientOperationRollbackContract,
): void {
  if (digest(metadataProof(forward)) !== contract.forwardMetadataSha256) {
    throw new Error("managed client no longer matches the forward update metadata state");
  }
}

function assertForwardRollbackRegistrationState(
  forward: ManagedClientMetadata,
  contract: ClientOperationRollbackContract,
  execute: ClientLifecycleExecutor,
  env: NodeJS.ProcessEnv,
): void {
  const registration = observeManagedRegistration(forward, execute, env);
  if (digest(registrationProof(registration)) !== contract.forwardRegistrationSha256) {
    throw new Error("managed client no longer matches the forward update registration state");
  }
}

function executionStepsFromManifest(
  manifest: ClientOperationManifest,
  target: ManagedClientMetadata,
  action: "repair" | "update" | "uninstall",
): PlannedStep[] {
  const registrationSteps = manifest.steps.filter((step) => step.target === "registration");
  let registrationIndex = 0;
  return manifest.steps.map((step) => {
    let kind: PlannedKind;
    if (action === "uninstall") {
      if (step.target === "backend") kind = "backend-delete";
      else if (step.target === "metadata") kind = "metadata-delete";
      else kind = target.runtime === "claude-desktop" ? "desktop-remove" : "native-remove";
    } else if (step.target === "backend") kind = "backend";
    else if (step.target === "metadata") kind = "metadata";
    else if (target.runtime === "claude-desktop") kind = "desktop-replace";
    else {
      kind = registrationSteps.length === 2 && registrationIndex++ === 0 ? "native-remove" : "native-add";
    }
    return { kind, target: step.target as PlannedStep["target"], locator: step.locator, before: "", after: "" };
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
  phase: "before" | "after" = "before",
): ObservedStep {
  if (step.kind === "backend") {
    const backend = backendPolicy(metadata.backendConfigPath);
    return { proof: canonical(backend), backend };
  }
  if (step.kind === "backend-delete") {
    if (!pathEntryIsAbsent(metadata.backendConfigPath)) {
      const backend = backendPolicy(metadata.backendConfigPath);
      return { proof: canonical(backend), backend };
    }
    const parent = privateDirectoryProof(dirname(metadata.backendConfigPath), "managed backend directory is invalid");
    return { proof: canonical(observedBackendAbsentProof(metadata.backendConfigPath, parent)) };
  }
  if (step.kind === "metadata") {
    return { proof: metadataProof(loadManagedClientMetadata(metadata.runtime, metadata.instance, env)) };
  }
  if (step.kind === "metadata-delete") {
    const metadataPath = managedClientMetadataPath(metadata.runtime, metadata.instance, env);
    if (!pathEntryIsAbsent(metadataPath)) {
      return { proof: metadataProof(loadManagedClientMetadata(metadata.runtime, metadata.instance, env)) };
    }
    const parent = privateDirectoryProof(dirname(metadataPath), "managed metadata directory is invalid");
    return { proof: canonical(observedMetadataAbsentProof(metadata.runtime, metadata.instance, env, parent)) };
  }
  const registrationRole = phase === "after"
    ? step.afterRegistrationMetadata ?? step.registrationMetadata
    : step.registrationMetadata;
  const registrationMetadata = registrationRole === "source" ? metadata : target;
  const alternateArgs = registrationRole === "source" ? target.launch.args : metadata.launch.args;
  return {
    proof: registrationProof(observeManagedRegistration(
      registrationMetadata, execute, env, alternateArgs,
    )),
  };
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
  if (step.kind === "backend-delete") {
    if (!observed.backend) throw new Error("backend proof is unavailable");
    deleteBackend(metadata.backendConfigPath, observed.backend);
    return;
  }
  const beforeRegistration = step.registrationMetadata === "source" ? metadata : target;
  const afterRegistration = step.afterRegistrationMetadata === "source" ? metadata : target;
  if (step.kind === "native-remove") return nativeExecute(beforeRegistration, "remove", execute, env);
  if (step.kind === "native-add") return nativeExecute(afterRegistration, "add", execute, env);
  if (step.kind === "desktop-replace") return mutateDesktopRegistration(afterRegistration, operationId, stepIndex, "replace", desktopHooks);
  if (step.kind === "desktop-remove") return mutateDesktopRegistration(target, operationId, stepIndex, "remove", desktopHooks);
  if (step.kind === "metadata-delete") {
    deleteManagedClientMetadata(metadata, env);
    return;
  }
  const current = loadManagedClientMetadata(metadata.runtime, metadata.instance, env);
  if (!isDeepStrictEqual(current, metadata)) throw new Error("managed metadata changed before update");
  writeManagedClientMetadata(managedClientMetadataPath(target.runtime, target.instance, env), target);
  const after = loadManagedClientMetadata(target.runtime, target.instance, env);
  if (!isDeepStrictEqual(after, target)) throw new Error("managed metadata update was not verified");
}

function resumeAction(
  metadata: ManagedClientMetadata,
  manifest: ClientOperationManifest,
  command: string | undefined,
  env: NodeJS.ProcessEnv,
  action: "repair" | "update" | "uninstall",
): ManagedClientMetadata {
  if (manifest.runtime !== metadata.runtime || manifest.instance !== metadata.instance) {
    throw new Error("--resume does not match this client action, runtime, or instance");
  }
  if (manifest.version !== 3 && manifest.version !== 4) {
    throw new Error("--resume requires an identity-bound operation request");
  }
  if (action === "repair") {
    if (manifest.version !== 3 || !manifest.request || manifest.request.kind !== "repair" || !("identity" in manifest.request)
      || manifest.request.identity !== metadata.identity) {
      throw new Error("--resume does not match this client action, runtime, or instance");
    }
    if (command !== undefined) throw new Error("--command is not valid for clients repair");
    return metadata;
  }
  if (action === "uninstall") {
    if (manifest.version !== 3 || !manifest.request || manifest.request.kind !== "uninstall" || !("identity" in manifest.request)
      || manifest.request.identity !== metadata.identity) {
      throw new Error("--resume does not match this client action, runtime, or instance");
    }
    if (command !== undefined) throw new Error("--command is not valid for clients uninstall");
    return metadata;
  }
  if (!manifest.request || manifest.request.kind !== "update" || !("identity" in manifest.request)
    || !("launch" in manifest.request) || manifest.request.identity !== metadata.identity) {
    throw new Error("--resume does not match this client action, runtime, or instance");
  }
  const recorded = manifest.request.launch;
  if (manifest.version === 4) assertRollbackContract(manifest.request.rollback!, metadata.runtime, metadata.instance);
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
  action: "repair" | "update" | "uninstall" | "rollback" | "none", applied: boolean, metadata: ManagedClientMetadata,
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
 * Repair, update, or forward-only uninstall one metadata-owned registration. The dry-run path does not acquire a lock,
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
  if (requestedAction === "uninstall") assertUninstallPathIsolation(metadata, env);
  const manifest = options.resume ? readClientOperation(options.resume, env) : undefined;
  const target = manifest
    ? resumeAction(metadata, manifest, options.command, env, requestedAction)
    : requestedAction === "update"
      ? updateMetadata(metadata, resolveUpdateLaunch(metadata, options.command, env))
      : metadata;
  const steps = options.resume && options.apply ? []
    : requestedAction === "uninstall"
      ? buildUninstallPlan(metadata, execute, env)
      : buildPlan(metadata, target, execute, env);
  if (!options.apply) {
    if (options.resume || options.recoverLock) throw new Error("--resume and --recover-lock require --apply");
    return planResult(steps.length === 0 ? "none" : requestedAction, false, metadata, steps, env);
  }
  if (options.recoverLock) recoverClientOperationLock(metadata.runtime, metadata.instance, env);
  if (steps.length === 0 && !options.resume) return planResult("none", false, metadata, steps, env);
  const begun = options.resume
    ? resumeClientOperation(options.resume, env)
    : beginClientOperation({
      version: requestedAction === "update" ? 4 : 3,
      request: requestedAction === "repair"
        ? { kind: "repair", identity: metadata.identity }
        : requestedAction === "update"
          ? {
              kind: "update", identity: metadata.identity, launch: operationLaunch(target),
              rollback: rollbackContract(metadata, target),
            }
          : { kind: "uninstall", identity: metadata.identity },
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
    assertCurrentOperationManifest(current, env);
    if (metadataProof(loadManagedClientMetadata(metadata.runtime, metadata.instance, env)) !== authority) {
      throw new Error("managed metadata changed while acquiring the client lock");
    }
    const recordedSteps = options.resume && current.state !== "prepared"
      ? executionStepsFromManifest(current, target, requestedAction)
      : requestedAction === "uninstall"
        ? buildUninstallPlan(metadata, execute, env)
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
      let actual = observedProof(step, metadata, target, execute, env, "before");
      let intentAlreadyRecorded = false;
      if (journalStep.state === "intent-recorded") {
        let classification = classifyClientOperationRestart(current, digest(actual.proof));
        if (classification.disposition === "blocked" && step.afterRegistrationMetadata
          && step.afterRegistrationMetadata !== step.registrationMetadata) {
          const after = observedProof(step, metadata, target, execute, env, "after");
          const afterClassification = classifyClientOperationRestart(current, digest(after.proof));
          if (afterClassification.disposition === "advance") {
            actual = after;
            classification = afterClassification;
          }
        }
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
        actual = observedProof(step, metadata, target, execute, env, "after");
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
      assertCurrentOperationManifest(current, env);
      applyStep(
        step, actual, metadata, target, execute, env, current.operationId, index,
        options.testHooks?.desktop, options.testHooks?.afterBackendPin,
      );
      options.testHooks?.afterApply?.({ target: step.target, action: step.kind });
      actual = observedProof(step, metadata, target, execute, env, "after");
      current = recordClientOperationStepApplied(current.operationId, current, index, actual.proof, begun.lock, env);
    }
    current = completeClientOperationCleanup(current.operationId, current, begun.lock, env);
    return planResult(requestedAction, true, target, recordedSteps, env, current.operationId);
  } finally {
    releaseClientOperationLock(begun.lock);
  }
}

function uninstallStepAction(step: { target: "registration" | "backend" | "metadata" }, runtime: InstallableRuntime): PlannedKind {
  if (step.target === "registration") return runtime === "claude-desktop" ? "desktop-remove" : "native-remove";
  return step.target === "backend" ? "backend-delete" : "metadata-delete";
}

function resumeUninstallAfterMetadataDeletion(
  manifest: ClientOperationManifest,
  identity: string,
  options: ClientMaintenanceResumeOptions,
): ClientMaintenancePlan {
  const env = options.env ?? process.env;
  if (options.recoverLock) recoverClientOperationLock(manifest.runtime, manifest.instance, env);
  const begun = resumeClientOperation(manifest.operationId, env);
  let current = begun.manifest;
  const steps = current.steps.map((step) => ({
    target: step.target as "registration" | "backend" | "metadata",
    action: uninstallStepAction(step as { target: "registration" | "backend" | "metadata" }, current.runtime),
  }));
  try {
    if (current.version !== 3 || !current.request || current.request.kind !== "uninstall"
      || !("identity" in current.request) || current.request.identity !== identity) {
      throw new Error("operation is not an identity-bound uninstall request");
    }
    const pending = current.steps.find((step) => step.state !== "observed-applied");
    if (pending) {
      const earlierComplete = current.steps.slice(0, pending.index).every((step) => step.state === "observed-applied");
      if (!earlierComplete || pending.target !== "metadata" || pending.state !== "intent-recorded") {
        throw new Error("managed metadata is missing before uninstall reached its final deletion step");
      }
      const metadataPath = managedClientMetadataPath(current.runtime, current.instance, env);
      if (!pathEntryIsAbsent(metadataPath)) throw new Error("managed metadata reappeared during uninstall resume");
      const parent = privateDirectoryProof(dirname(metadataPath), "managed metadata directory is invalid");
      const actual = canonical(observedMetadataAbsentProof(current.runtime, current.instance, env, parent));
      const classification = classifyClientOperationRestart(current, digest(actual));
      if (classification.disposition !== "advance") throw new Error(classification.reason);
      current = recordClientOperationStepApplied(
        current.operationId, current, pending.index, actual, begun.lock, env,
      );
    }
    current = completeClientOperationCleanup(current.operationId, current, begun.lock, env);
    return {
      schemaVersion: 1, action: "uninstall", applied: true, operationId: current.operationId,
      runtime: manifest.runtime, instance: manifest.instance, identity,
      metadataPath: managedClientMetadataPath(manifest.runtime, manifest.instance, env), steps,
    };
  } finally {
    releaseClientOperationLock(begun.lock);
  }
}

function loadRollbackSource(
  sourceOperationId: string,
  identity: string,
  env: NodeJS.ProcessEnv,
): { source: ClientOperationManifest; contract: ClientOperationRollbackContract; prior: ManagedClientMetadata } {
  const source = readClientOperation(sourceOperationId, env);
  if (source.state !== "committed" || source.version !== 4 || source.host !== hostname()) {
    throw new Error("rollback source must be a committed same-host v4 update");
  }
  if (source.completion?.operation !== "update" || !source.completion.rollback) {
    throw new Error("rollback source does not retain an update inverse contract");
  }
  const contract = source.completion.rollback;
  const { prior } = assertRollbackContract(contract, source.runtime, source.instance);
  if (!identity || identity.trim() !== identity || identity !== contract.identity) {
    throw new Error("--identity must exactly match the rollback source");
  }
  return { source, contract, prior };
}

function assertRollbackOperationAuthority(
  manifest: ClientOperationManifest,
  sourceOperationId: string,
  identity: string,
  contract: ClientOperationRollbackContract,
): void {
  if (manifest.version !== 4 || manifest.request?.kind !== "rollback"
    || manifest.request.sourceOperationId !== sourceOperationId
    || manifest.request.identity !== identity
    || canonical(manifest.request.rollback) !== canonical(contract)) {
    throw new Error("locked rollback operation no longer matches its committed update authority");
  }
}

function rollbackPlanResult(
  applied: boolean,
  metadata: ManagedClientMetadata,
  steps: PlannedStep[],
  env: NodeJS.ProcessEnv,
  operationId?: string,
): ClientMaintenancePlan {
  return planResult("rollback", applied, metadata, steps, env, operationId);
}

function runManagedClientRollback(
  options: ClientRollbackOptions,
  resumeOperationId?: string,
): ClientMaintenancePlan {
  const env = options.env ?? process.env;
  const execute = options.execute ?? ((command, args, context) => spawnSync(command, args, {
    encoding: "utf8", cwd: context?.cwd, env: context?.env,
  }));
  const reverse = resumeOperationId ? readClientOperation(resumeOperationId, env) : null;
  let sourceOperationId = options.sourceOperationId;
  let identity = options.identity;
  if (reverse) {
    if (reverse.version !== 4 || !reverse.request || reverse.request.kind !== "rollback") {
      throw new Error("operation is not a resumable rollback request");
    }
    sourceOperationId = reverse.request.sourceOperationId;
    identity = reverse.request.identity;
  }
  const { source, contract, prior } = loadRollbackSource(sourceOperationId, identity, env);
  const reverseRequest = reverse?.request?.kind === "rollback" ? reverse.request : null;
  if (reverseRequest && canonical(reverseRequest.rollback) !== canonical(contract)) {
    throw new Error("rollback request no longer matches its committed source");
  }
  const metadataStepApplied = rollbackMetadataReachedAfterState(reverse, prior, env);
  const forward = metadataStepApplied ? prior : loadManagedClientMetadata(source.runtime, source.instance, env);
  const registrationHasProgress = rollbackRegistrationHasProgress(reverse);
  if (!metadataStepApplied) {
    assertForwardRollbackMetadataState(forward, contract);
    if (!registrationHasProgress) assertForwardRollbackRegistrationState(forward, contract, execute, env);
  }
  const steps = reverse && reverse.state !== "prepared"
    ? rollbackExecutionStepsFromManifest(reverse, prior)
    : buildRollbackPlan(forward, prior);
  if (!options.apply) {
    if (options.recoverLock) throw new Error("--recover-lock requires --apply");
    return rollbackPlanResult(false, forward, steps, env);
  }
  if (options.recoverLock) recoverClientOperationLock(source.runtime, source.instance, env);
  options.testHooks?.beforeOperationBegin?.();
  const begun = reverse
    ? resumeClientOperation(reverse.operationId, env)
    : beginClientOperation({
      version: 4,
      request: { kind: "rollback", identity, sourceOperationId: source.operationId, rollback: contract },
      runtime: source.runtime, instance: source.instance,
      steps: steps.map((step, index) => ({
        target: step.target, locator: step.locator,
        beforeArtifact: `step-${index}.before`, afterArtifact: `step-${index}.after`,
        expectedBeforeSha256: digest(step.before), expectedAfterSha256: digest(step.after),
      })),
    }, env);
  let current = begun.manifest;
  try {
    assertRollbackOperationAuthority(current, source.operationId, identity, contract);
    options.testHooks?.afterLock?.();
    assertCurrentOperationManifest(current, env);
    const refreshed = loadRollbackSource(source.operationId, identity, env);
    if (canonical(refreshed.contract) !== canonical(contract)) {
      throw new Error("rollback source changed while acquiring the client lock");
    }
    const metadataApplied = rollbackMetadataReachedAfterState(current, prior, env);
    const currentForward = metadataApplied ? prior : loadManagedClientMetadata(source.runtime, source.instance, env);
    const currentRegistrationHasProgress = rollbackRegistrationHasProgress(current);
    if (!metadataApplied) {
      assertForwardRollbackMetadataState(currentForward, contract);
      if (!currentRegistrationHasProgress) assertForwardRollbackRegistrationState(currentForward, contract, execute, env);
    }
    const recordedSteps = current.state === "prepared"
      ? buildRollbackPlan(currentForward, prior)
      : rollbackExecutionStepsFromManifest(current, prior);
    if (recordedSteps.length !== current.steps.length) {
      throw new Error("rollback request no longer matches the recorded operation plan");
    }
    if (current.state === "prepared") {
      if (recordedSteps.some((step, index) => digest(step.before) !== current.steps[index]?.expectedBeforeSha256
        || digest(step.after) !== current.steps[index]?.expectedAfterSha256)) {
        throw new Error("rollback request no longer matches the forward update state");
      }
      for (let index = 0; index < recordedSteps.length; index += 1) {
        current = writeClientOperationSnapshot(
          current.operationId, current, `step-${index}.before`, recordedSteps[index]!.before, begun.lock, env,
        );
      }
      current = transitionClientOperation(current.operationId, current, "snapshotted", begun.lock, env);
    }
    const forwardMetadataAuthority = contract.forwardMetadataSha256;
    for (let index = 0; index < recordedSteps.length; index += 1) {
      const step = recordedSteps[index]!;
      const journalStep = current.steps[index]!;
      if (step.kind !== "metadata" && journalStep.state !== "observed-applied"
        && digest(metadataProof(loadManagedClientMetadata(source.runtime, source.instance, env))) !== forwardMetadataAuthority) {
        throw new Error("managed metadata changed before rollback mutated a client registration");
      }
      let actual = observedProof(step, currentForward, prior, execute, env, "before");
      let intentAlreadyRecorded = false;
      if (journalStep.state === "intent-recorded") {
        let classification = classifyClientOperationRestart(current, digest(actual.proof));
        if (classification.disposition === "blocked" && step.afterRegistrationMetadata
          && step.afterRegistrationMetadata !== step.registrationMetadata) {
          const after = observedProof(step, currentForward, prior, execute, env, "after");
          const afterClassification = classifyClientOperationRestart(current, digest(after.proof));
          if (afterClassification.disposition === "advance") {
            actual = after;
            classification = afterClassification;
          }
        }
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
        actual = observedProof(step, currentForward, prior, execute, env, "after");
        if (digest(actual.proof) !== journalStep.expectedAfterSha256) {
          throw new Error(`completed rollback step ${index} no longer matches its after-state`);
        }
        continue;
      } else if (digest(actual.proof) !== journalStep.expectedBeforeSha256) {
        throw new Error("rollback step no longer matches its before-state");
      }
      if (!intentAlreadyRecorded) {
        current = recordClientOperationStepIntent(current.operationId, current, index, begun.lock, env);
      }
      options.testHooks?.beforeApply?.({ target: step.target, action: step.kind });
      assertCurrentOperationManifest(current, env);
      applyStep(
        step, actual, currentForward, prior, execute, env, current.operationId, index,
        options.testHooks?.desktop, options.testHooks?.afterBackendPin,
      );
      options.testHooks?.afterApply?.({ target: step.target, action: step.kind });
      actual = observedProof(step, currentForward, prior, execute, env, "after");
      current = recordClientOperationStepApplied(current.operationId, current, index, actual.proof, begun.lock, env);
    }
    current = completeClientOperationCleanup(current.operationId, current, begun.lock, env);
    return rollbackPlanResult(true, prior, recordedSteps, env, current.operationId);
  } finally {
    releaseClientOperationLock(begun.lock);
  }
}

/** Plan or explicitly apply one update-only reverse journal. */
export function rollbackManagedClient(options: ClientRollbackOptions): ClientMaintenancePlan {
  return runManagedClientRollback(options);
}

/** Resume exactly one supported managed-client operation using recorded authority only. */
export function resumeManagedClientOperation(options: ClientMaintenanceResumeOptions): ClientMaintenancePlan {
  const env = options.env ?? process.env;
  const manifest = readClientOperation(options.operationId, env);
  if (manifest.version === 4 && manifest.request?.kind === "rollback") {
    return runManagedClientRollback({
      sourceOperationId: manifest.request.sourceOperationId, identity: manifest.request.identity,
      apply: true, recoverLock: options.recoverLock, env, execute: options.execute, testHooks: options.testHooks,
    }, manifest.operationId);
  }
  if (!manifest.request || !["repair", "update", "uninstall"].includes(manifest.request.kind)
    || !("identity" in manifest.request)
    || (manifest.version !== 3 && manifest.version !== 4)
    || (manifest.version === 4 && manifest.request.kind !== "update")) {
    throw new Error("operation is not a resumable identity-bound managed client request");
  }
  const action = manifest.request.kind as "repair" | "update" | "uninstall";
  const identity = manifest.request.identity;
  const metadataPath = managedClientMetadataPath(manifest.runtime, manifest.instance, env);
  if (action === "uninstall" && pathEntryIsAbsent(metadataPath)) {
    return resumeUninstallAfterMetadataDeletion(manifest, identity, options);
  }
  return maintainManagedClient({
    action, runtime: manifest.runtime, instance: manifest.instance, identity,
    apply: true, resume: manifest.operationId, recoverLock: options.recoverLock,
    env, execute: options.execute, testHooks: options.testHooks,
  });
}

export function repairManagedClient(options: Omit<ClientMaintenanceOptions, "command" | "action">): ClientMaintenancePlan {
  return maintainManagedClient({ ...options, action: "repair" });
}

export function updateManagedClient(options: Omit<ClientMaintenanceOptions, "action">): ClientMaintenancePlan {
  return maintainManagedClient({ ...options, action: "update" });
}

export function uninstallManagedClient(options: Omit<ClientMaintenanceOptions, "command" | "action">): ClientMaintenancePlan {
  return maintainManagedClient({ ...options, action: "uninstall" });
}
