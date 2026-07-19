import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  linkSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
  createPrivateDirectoryAccessCache, PrivatePathError, securePrivatePath, type PrivateDirectoryAccessCache,
  verifyPrivatePathAccess,
} from "./private-path.js";
import type { InstallableRuntime } from "./client-installer.js";

export const CLIENT_OPERATION_SCHEMA = "agent-bridge.client-operation";
export const CLIENT_OPERATION_VERSION = 3;
export type ClientOperationState =
  | "prepared" | "snapshotted" | "in-progress" | "applied" | "cleaning" | "committed";
export type ClientOperationKind = "repair" | "update" | "uninstall" | "migrate";
export interface ClientOperationLaunch {
  command: string;
  args: string[];
  scope: "local" | "user" | "project" | null;
  envKeys: ["AGENT_BRIDGE_AGENT", "AGENT_BRIDGE_CONFIG", "AGENT_BRIDGE_INSTANCE"];
}
export type ClientOperationRequest =
  | { kind: "repair"; identity: string }
  | { kind: "update"; identity: string; launch: ClientOperationLaunch }
  | { kind: "uninstall" }
  | { kind: "migrate"; endpoint: string; workspace: string };
type LegacyClientOperationRequest =
  | { kind: "repair" }
  | { kind: "update"; release: string }
  | { kind: "uninstall" }
  | { kind: "migrate"; endpoint: string; workspace: string };
type RecordedClientOperationRequest = ClientOperationRequest | LegacyClientOperationRequest;
export interface ClientOperationCompletion {
  operation: ClientOperationKind;
  stepCount: number;
  completedAt: string;
  cleanupDirectoryDurability: "durable" | "unavailable";
}
export type ClientOperationTargetKind = "registration" | "backend" | "metadata";
export type ClientOperationStepState = "pending" | "intent-recorded" | "observed-applied";

export interface ClientOperationStep {
  index: number;
  target: ClientOperationTargetKind;
  locator: string;
  beforeArtifact: string;
  afterArtifact: string;
  expectedBeforeSha256: string;
  expectedAfterSha256: string;
  state: ClientOperationStepState;
  intentRecordedAt: string | null;
  observedAppliedAt: string | null;
}

export interface ClientOperationArtifact {
  name: string;
  stepIndex: number;
  phase: "before" | "after";
  bytes: number;
  sha256: string;
  cleanupIntentAt: string | null;
  removedAt: string | null;
  directoryDurability: "durable" | "unavailable" | null;
}

export interface ClientOperationManifest {
  schema: typeof CLIENT_OPERATION_SCHEMA;
  version: 2 | typeof CLIENT_OPERATION_VERSION;
  operationId: string;
  request: RecordedClientOperationRequest | null;
  runtime: InstallableRuntime;
  instance: string;
  state: ClientOperationState;
  revision: number;
  host: string;
  createdAt: string;
  updatedAt: string;
  completion: ClientOperationCompletion | null;
  artifacts: ClientOperationArtifact[];
  steps: ClientOperationStep[];
}

export interface ClientOperationSummary {
  schemaVersion: 3;
  operationId: string;
  operation: ClientOperationKind | null;
  runtime: InstallableRuntime | null;
  instance: string | null;
  state: ClientOperationState | "corrupt";
  inspectionState: "resumable" | "classification-required" | "blocked" | "complete";
  revision: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  cleanupDirectoryDurability: "durable" | "unavailable" | null;
  artifacts: ClientOperationArtifact[];
  pendingStep: number | null;
  recoverable: boolean;
  reason: string;
}

export interface ClientOperationLock {
  readonly runtime: InstallableRuntime;
  readonly instance: string;
  readonly lockPath: string;
  readonly descriptor: number;
  readonly device: number;
  readonly inode: number;
  released: boolean;
}

export class ClientOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ClientOperationError"; }
}

const operationLockPrivatePathCaches = new WeakMap<ClientOperationLock, PrivateDirectoryAccessCache>();

function privatePathCacheForLock(lock: ClientOperationLock): PrivateDirectoryAccessCache {
  const cache = operationLockPrivatePathCaches.get(lock);
  if (!cache) fail("LOCK_REPLACED", "client lock is no longer held");
  return cache;
}

export type ClientOperationFilesystemEvent =
  | "before-publish-rename" | "after-publish-rename" | "before-publish-link"
  | "after-publish-link" | "before-directory-sync"
  | "before-cleanup" | "after-snapshot-directory-read" | "before-snapshot-file-open"
  | "after-snapshots-created" | "before-lock-remove"
  | "after-cleanup-intent" | "before-artifact-unlink" | "after-artifact-unlink"
  | "after-artifact-directory-sync" | "before-cleanup-commit";
export interface ClientOperationFilesystem {
  hook(event: ClientOperationFilesystemEvent, path: string): void;
  link(source: string, target: string): void;
  rename(source: string, target: string): void;
  remove(path: string, options?: { force?: boolean; recursive?: boolean }): void;
  syncDirectory(path: string): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LOCK_BYTES = 16 * 1024;
const MAX_OPERATION_STEPS = 128;
const MAX_OPERATION_ARTIFACTS = MAX_OPERATION_STEPS * 2;
const MAX_LISTED_OPERATIONS = 1000;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const STATES: ClientOperationState[] = ["prepared", "snapshotted", "in-progress", "applied", "cleaning", "committed"];
const OPERATIONS: ClientOperationKind[] = ["repair", "update", "uninstall", "migrate"];
const RUNTIMES: InstallableRuntime[] = ["codex", "claude-code", "claude-desktop"];

function fail(code: string, message: string): never { throw new ClientOperationError(code, message); }
function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
const filesystemDefaults: ClientOperationFilesystem = {
  hook: () => {}, link: linkSync, rename: renameSync, remove: rmSync,
  syncDirectory,
};
function safeText(value: unknown, label: string, maximum = 128): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail("INVALID_MANIFEST", `${label} is invalid`);
  return value;
}
function safeIdentity(value: unknown): string {
  return safeText(value, "identity", 128);
}
function safeNativeLaunchCommand(value: unknown): string {
  const command = safeText(value, "launch command", 1024);
  if (/[?=#]/.test(command) || /:\/\//.test(command)
    || (!isAbsolute(command) && /\s/.test(command))) {
    fail("INVALID_MANIFEST", "launch command is invalid");
  }
  return command;
}
function rejectLinks(path: string): void {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) fail("INSECURE_PATH", "operation paths cannot contain links");
    } catch (error) {
      if (error instanceof ClientOperationError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      fail("INSECURE_PATH", "operation path ancestry is unavailable");
    }
  }
}
function privateDirectory(path: string, cache?: PrivateDirectoryAccessCache): { device: number; inode: number } {
  rejectLinks(path);
  let details;
  try { details = lstatSync(path); } catch { fail("INSECURE_PATH", "operation directory is unavailable"); }
  if (!details.isDirectory() || details.isSymbolicLink()) fail("INSECURE_PATH", "operation directory is invalid");
  try {
    if (cache) cache.verify(path);
    else verifyPrivatePathAccess(path, "directory");
  } catch (error) {
    if (error instanceof PrivatePathError && error.code === "PATH_REPLACED") {
      fail("PATH_REPLACED", "operation directory changed during access");
    }
    fail("INSECURE_PATH", "operation directory is not owner-private");
  }
  return { device: details.dev, inode: details.ino };
}
function sameDirectory(path: string, identity: { device: number; inode: number }, cache?: PrivateDirectoryAccessCache): void {
  const current = privateDirectory(path, cache);
  if (current.device !== identity.device || current.inode !== identity.inode) {
    fail("PATH_REPLACED", "operation directory changed during access");
  }
}
function prepareDirectory(path: string, cache?: PrivateDirectoryAccessCache): void {
  rejectLinks(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    if (cache) cache.secure(path);
    else securePrivatePath(path, "directory");
  } catch { fail("INSECURE_PATH", "operation directory is not owner-private"); }
  privateDirectory(path, cache);
}

export function clientOperationRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_BRIDGE_OPERATION_DIR) return resolve(env.AGENT_BRIDGE_OPERATION_DIR);
  return join(realpathSync(env.HOME ?? homedir()), ".agent-bridge", "operations");
}
function prepareRoot(env: NodeJS.ProcessEnv, cache?: PrivateDirectoryAccessCache): string {
  const root = clientOperationRoot(env);
  prepareDirectory(root, cache);
  prepareDirectory(join(root, "locks"), cache);
  return root;
}

interface PinnedOperationRoot {
  root: string;
  rootIdentity: { device: number; inode: number };
  locks: string;
  locksIdentity: { device: number; inode: number };
}

function pinOperationRoot(env: NodeJS.ProcessEnv, create: boolean, cache?: PrivateDirectoryAccessCache): PinnedOperationRoot {
  const root = clientOperationRoot(env);
  if (create) prepareRoot(env, cache);
  const rootIdentity = privateDirectory(root, cache);
  const locks = join(root, "locks");
  const locksIdentity = privateDirectory(locks, cache);
  sameDirectory(root, rootIdentity, cache);
  return { root, rootIdentity, locks, locksIdentity };
}

function assertPinnedRoot(pinned: PinnedOperationRoot, cache?: PrivateDirectoryAccessCache): void {
  sameDirectory(pinned.root, pinned.rootIdentity, cache);
  sameDirectory(pinned.locks, pinned.locksIdentity, cache);
}
function operationDirectory(operationId: string, env: NodeJS.ProcessEnv): string {
  if (!UUID.test(operationId)) fail("INVALID_OPERATION_ID", "operation id is invalid");
  return join(clientOperationRoot(env), operationId.toLowerCase());
}
function verifyInsideRoot(path: string, env: NodeJS.ProcessEnv, cache?: PrivateDirectoryAccessCache): void {
  const root = clientOperationRoot(env);
  const inside = relative(root, resolve(path));
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`)) fail("INSECURE_PATH", "operation path is outside the operation root");
  privateDirectory(root, cache);
}
function manifestPath(operationId: string, env: NodeJS.ProcessEnv): string {
  return join(operationDirectory(operationId, env), "manifest.json");
}
function validateArtifact(value: unknown): ClientOperationArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  const artifact = value as Record<string, unknown>;
  const name = safeText(artifact.name, "artifact name", 80);
  const timestamp = (item: unknown): item is string | null => item === null
    || (typeof item === "string" && Number.isFinite(Date.parse(item)));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  if (!Number.isSafeInteger(artifact.stepIndex) || Number(artifact.stepIndex) < 0
    || !["before", "after"].includes(String(artifact.phase))
    || !Number.isSafeInteger(artifact.bytes) || Number(artifact.bytes) < 0
    || Number(artifact.bytes) > MAX_SNAPSHOT_BYTES
    || typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)
    || !timestamp(artifact.cleanupIntentAt) || !timestamp(artifact.removedAt)
    || ![null, "durable", "unavailable"].includes(artifact.directoryDurability as null | string)
    || (artifact.removedAt !== null && artifact.cleanupIntentAt === null)
    || (artifact.removedAt !== null && artifact.directoryDurability === null)
    || (artifact.removedAt === null && artifact.directoryDurability !== null)) {
    fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  }
  return {
    name, stepIndex: Number(artifact.stepIndex), phase: artifact.phase as "before" | "after",
    bytes: Number(artifact.bytes), sha256: artifact.sha256,
    cleanupIntentAt: artifact.cleanupIntentAt as string | null,
    removedAt: artifact.removedAt as string | null,
    directoryDurability: artifact.directoryDurability as "durable" | "unavailable" | null,
  };
}
function validateStep(value: unknown, index: number): ClientOperationStep {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  const step = value as Record<string, unknown>;
  const targets: ClientOperationTargetKind[] = ["registration", "backend", "metadata"];
  const states: ClientOperationStepState[] = ["pending", "intent-recorded", "observed-applied"];
  const locator = safeText(step.locator, "step locator", 512);
  const beforeArtifact = safeText(step.beforeArtifact, "before artifact", 80);
  const afterArtifact = safeText(step.afterArtifact, "after artifact", 80);
  const digest = (item: unknown): item is string => typeof item === "string" && /^[0-9a-f]{64}$/.test(item);
  const timestamp = (item: unknown): item is string | null => item === null
    || (typeof item === "string" && Number.isFinite(Date.parse(item)));
  if (step.index !== index || !targets.includes(step.target as ClientOperationTargetKind)
    || !states.includes(step.state as ClientOperationStepState)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(beforeArtifact) || beforeArtifact.includes("..")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(afterArtifact) || afterArtifact.includes("..")
    || beforeArtifact === afterArtifact
    || !digest(step.expectedBeforeSha256) || !digest(step.expectedAfterSha256)
    || !timestamp(step.intentRecordedAt) || !timestamp(step.observedAppliedAt)
    || (step.state === "pending" && (step.intentRecordedAt !== null || step.observedAppliedAt !== null))
    || (step.state === "intent-recorded" && (step.intentRecordedAt === null || step.observedAppliedAt !== null))
    || (step.state === "observed-applied" && (step.intentRecordedAt === null || step.observedAppliedAt === null))) {
    fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  }
  return {
    index, target: step.target as ClientOperationTargetKind, locator, beforeArtifact, afterArtifact,
    expectedBeforeSha256: step.expectedBeforeSha256, expectedAfterSha256: step.expectedAfterSha256,
    state: step.state as ClientOperationStepState,
    intentRecordedAt: step.intentRecordedAt as string | null,
    observedAppliedAt: step.observedAppliedAt as string | null,
  };
}
function validateRequest(
  value: unknown, runtime?: InstallableRuntime, version: 2 | typeof CLIENT_OPERATION_VERSION = CLIENT_OPERATION_VERSION,
): RecordedClientOperationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  const request = value as Record<string, unknown>;
  if (!OPERATIONS.includes(request.kind as ClientOperationKind)) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  const keys = Object.keys(request).sort().join(",");
  if (version === 2) {
    if (request.kind === "repair") {
      if (keys !== "kind") fail("CORRUPT_OPERATION", "operation manifest is corrupt");
      return { kind: "repair" };
    }
    if (request.kind === "update") {
      if (keys !== "kind,release") fail("CORRUPT_OPERATION", "operation manifest is corrupt");
      const release = safeText(request.release, "release", 128);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(release)) {
        fail("CORRUPT_OPERATION", "operation manifest is corrupt");
      }
      return { kind: "update", release };
    }
    if (request.kind === "uninstall") {
      if (keys !== "kind") fail("CORRUPT_OPERATION", "operation manifest is corrupt");
      return { kind: "uninstall" };
    }
    if (keys !== "endpoint,kind,workspace") fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    const endpoint = safeText(request.endpoint, "endpoint", 512);
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch { fail("CORRUPT_OPERATION", "operation manifest is corrupt"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    }
    const workspace = safeText(request.workspace, "workspace");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspace)) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    return { kind: "migrate", endpoint: parsed.toString(), workspace };
  }
  if (request.kind === "repair") {
    if (keys !== "identity,kind") fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    return { kind: "repair", identity: safeIdentity(request.identity) };
  }
  if (request.kind === "uninstall" && keys !== "kind") fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  if (request.kind === "update") {
    if (keys !== "identity,kind,launch" || !request.launch || typeof request.launch !== "object"
      || Array.isArray(request.launch)) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    const launch = request.launch as Record<string, unknown>;
    if (Object.keys(launch).sort().join(",") !== "args,command,envKeys,scope") {
      fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    }
    const command = safeText(launch.command, "launch command", 1024);
    if (!Array.isArray(launch.args) || launch.args.length > 16
      || launch.args.some((arg) => {
        try { safeText(arg, "launch argument", 1024); return false; } catch { return true; }
      })
      || !Array.isArray(launch.envKeys)
      || launch.envKeys.join(",") !== "AGENT_BRIDGE_AGENT,AGENT_BRIDGE_CONFIG,AGENT_BRIDGE_INSTANCE"
      || ![null, "local", "user", "project"].includes(launch.scope as null | string)) {
      fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    }
    if ((runtime === "codex" || runtime === "claude-code")
      && ((launch.args as unknown[]).length !== 0
        || (runtime === "claude-code" ? !["local", "user", "project"].includes(launch.scope as string)
          : launch.scope !== null))) {
      fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    }
    if (runtime === "codex" || runtime === "claude-code") safeNativeLaunchCommand(command);
    if (runtime === "claude-desktop" && (launch.scope !== null || !isAbsolute(command))) {
      fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    }
    return {
      kind: "update",
      identity: safeIdentity(request.identity),
      launch: {
        command,
        args: [...launch.args] as string[],
        scope: launch.scope as "local" | "user" | "project" | null,
        envKeys: ["AGENT_BRIDGE_AGENT", "AGENT_BRIDGE_CONFIG", "AGENT_BRIDGE_INSTANCE"],
      },
    };
  }
  if (request.kind === "migrate") {
    if (keys !== "endpoint,kind,workspace") fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    const endpoint = safeText(request.endpoint, "endpoint", 512);
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch { fail("CORRUPT_OPERATION", "operation manifest is corrupt"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    }
    const workspace = safeText(request.workspace, "workspace");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspace)) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    return { kind: "migrate", endpoint: parsed.toString(), workspace };
  }
  return { kind: "uninstall" };
}
function validateCompletion(value: unknown): ClientOperationCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  const completion = value as Record<string, unknown>;
  if (Object.keys(completion).sort().join(",") !== "cleanupDirectoryDurability,completedAt,operation,stepCount"
    || !OPERATIONS.includes(completion.operation as ClientOperationKind)
    || !Number.isSafeInteger(completion.stepCount) || Number(completion.stepCount) < 1
    || Number(completion.stepCount) > MAX_OPERATION_STEPS
    || typeof completion.completedAt !== "string" || !Number.isFinite(Date.parse(completion.completedAt))
    || !["durable", "unavailable"].includes(String(completion.cleanupDirectoryDurability))) {
    fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  }
  return {
    operation: completion.operation as ClientOperationKind,
    stepCount: Number(completion.stepCount), completedAt: completion.completedAt,
    cleanupDirectoryDurability: completion.cleanupDirectoryDurability as "durable" | "unavailable",
  };
}
export function validateClientOperation(value: unknown): ClientOperationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  const file = value as Record<string, unknown>;
  if (file.schema !== CLIENT_OPERATION_SCHEMA || (file.version !== 2 && file.version !== CLIENT_OPERATION_VERSION)
    || !UUID.test(String(file.operationId))
    || !RUNTIMES.includes(file.runtime as InstallableRuntime) || !STATES.includes(file.state as ClientOperationState)
    || !Number.isSafeInteger(file.revision) || Number(file.revision) < 0
    || !Array.isArray(file.artifacts) || file.artifacts.length > MAX_OPERATION_ARTIFACTS
    || !Array.isArray(file.steps)
    || file.steps.length > MAX_OPERATION_STEPS) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  const createdAt = safeText(file.createdAt, "createdAt", 64);
  const updatedAt = safeText(file.updatedAt, "updatedAt", 64);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  const terminal = file.state === "committed";
  const version = file.version as 2 | typeof CLIENT_OPERATION_VERSION;
  const request = terminal && file.request === null ? null : validateRequest(file.request, file.runtime as InstallableRuntime, version);
  const completion = terminal ? validateCompletion(file.completion) : null;
  const artifacts = file.artifacts.map(validateArtifact);
  const steps = file.steps.map(validateStep);
  if ((!terminal && (!request || file.completion !== null || steps.length === 0))
    || (terminal && (request !== null || steps.length !== 0 || artifacts.length !== 0))) {
    fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  }
  const firstIncomplete = steps.findIndex((step) => step.state !== "observed-applied");
  const tail = firstIncomplete < 0 ? [] : steps.slice(firstIncomplete + 1);
  const artifactNames = artifacts.map((artifact) => artifact.name);
  const stepArtifacts = steps.flatMap((step) => [step.beforeArtifact, step.afterArtifact]);
  const artifactsValid = new Set(artifactNames).size === artifactNames.length
    && artifacts.every((artifact) => {
      const step = steps[artifact.stepIndex];
      return Boolean(step && (artifact.phase === "before"
        ? step.beforeArtifact === artifact.name && step.expectedBeforeSha256 === artifact.sha256
        : step.afterArtifact === artifact.name && step.expectedAfterSha256 === artifact.sha256));
    });
  const completeSnapshots = artifactsValid
    && steps.every((step) => artifacts.some((artifact) => artifact.name === step.beforeArtifact));
  const exactAfterArtifacts = steps.every((step) => {
    const count = artifacts.filter((artifact) => artifact.name === step.afterArtifact && artifact.phase === "after").length;
    return count === (step.state === "observed-applied" ? 1 : 0);
  });
  const allPending = steps.every((step) => step.state === "pending");
  const allApplied = steps.every((step) => step.state === "observed-applied");
  const hasProgress = steps.some((step) => step.state !== "pending");
  const allArtifacts = artifacts.length === stepArtifacts.length;
  const anyCleanup = artifacts.some((artifact) => artifact.cleanupIntentAt !== null);
  const stateConsistent = terminal ? true : file.state === "prepared"
    ? allPending && !anyCleanup
    : file.state === "snapshotted"
      ? allPending && completeSnapshots && !anyCleanup
      : file.state === "in-progress"
        ? hasProgress && !allApplied && completeSnapshots && !anyCleanup
        : file.state === "applied"
          ? allApplied && completeSnapshots && allArtifacts && !anyCleanup
          : allApplied && completeSnapshots && allArtifacts && anyCleanup;
  if (tail.some((step) => step.state !== "pending")
    || steps.filter((step) => step.state === "intent-recorded").length > 1
    || new Set(stepArtifacts).size !== stepArtifacts.length
    || !artifactsValid || !exactAfterArtifacts
    || artifacts.reduce((total, artifact) => total + artifact.bytes, 0) > MAX_TOTAL_SNAPSHOT_BYTES
    || !stateConsistent) {
    fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  }
  return {
    schema: CLIENT_OPERATION_SCHEMA, version,
    operationId: String(file.operationId).toLowerCase(), request,
    runtime: file.runtime as InstallableRuntime, instance: safeText(file.instance, "instance"),
    state: file.state as ClientOperationState, revision: Number(file.revision),
    host: safeText(file.host, "host", 255), createdAt, updatedAt, completion,
    artifacts, steps,
  };
}
function serialize(manifest: ClientOperationManifest): string { return `${JSON.stringify(validateClientOperation(manifest), null, 2)}\n`; }
function hasCompleteSnapshots(manifest: ClientOperationManifest): boolean {
  return manifest.steps.every((step) => manifest.artifacts.some((artifact) => artifact.name === step.beforeArtifact
      && artifact.phase === "before" && artifact.sha256 === step.expectedBeforeSha256));
}
function publish(
  path: string, content: string | Buffer, filesystem: ClientOperationFilesystem = filesystemDefaults,
  expectedDirectory?: { device: number; inode: number }, cache?: PrivateDirectoryAccessCache,
): void {
  const directory = dirname(path);
  const identity = privateDirectory(directory, cache);
  if (expectedDirectory && (identity.device !== expectedDirectory.device || identity.inode !== expectedDirectory.inode)) {
    fail("PATH_REPLACED", "operation directory changed during publication");
  }
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    securePrivatePath(temporary, "file");
    filesystem.hook("before-publish-rename", path);
    sameDirectory(directory, identity, cache);
    filesystem.rename(temporary, path);
    filesystem.hook("after-publish-rename", path);
    verifyPrivatePathAccess(path, "file");
    sameDirectory(directory, identity, cache);
    filesystem.hook("before-directory-sync", directory);
    filesystem.syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
    // Never follow a replaced directory while cleaning up. Residue inside the
    // original, now-unreachable directory is safer than deleting an external file.
    try {
      filesystem.hook("before-cleanup", temporary);
      sameDirectory(directory, identity, cache);
      filesystem.remove(temporary, { force: true });
    } catch {}
    cache?.clear();
    if (error instanceof ClientOperationError) throw error;
    fail("DURABILITY_FAILED", "operation state could not be published durably");
  }
}

function publishNoReplace(
  path: string, content: string | Buffer, filesystem: ClientOperationFilesystem,
  cache?: PrivateDirectoryAccessCache,
): void {
  const directory = dirname(path);
  const identity = privateDirectory(directory, cache);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    securePrivatePath(temporary, "file");
    const temporaryIdentity = fstatSync(descriptor);
    filesystem.hook("before-publish-link", path);
    sameDirectory(directory, identity, cache);
    filesystem.link(temporary, path);
    filesystem.hook("after-publish-link", path);
    const published = lstatSync(path);
    if (!published.isFile() || published.isSymbolicLink()
      || published.dev !== temporaryIdentity.dev || published.ino !== temporaryIdentity.ino) {
      fail("PATH_REPLACED", "snapshot path changed during publication");
    }
    verifyPrivatePathAccess(path, "file");
    const verified = lstatSync(path);
    if (!verified.isFile() || verified.isSymbolicLink()
      || verified.dev !== temporaryIdentity.dev || verified.ino !== temporaryIdentity.ino) {
      fail("PATH_REPLACED", "snapshot path changed during publication");
    }
    sameDirectory(directory, identity, cache);
    closeSync(descriptor); descriptor = undefined;
    filesystem.remove(temporary);
    filesystem.hook("before-directory-sync", directory);
    filesystem.syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
    try {
      filesystem.hook("before-cleanup", temporary);
      sameDirectory(directory, identity, cache);
      filesystem.remove(temporary, { force: true });
    } catch {}
    cache?.clear();
    if (error instanceof ClientOperationError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("AMBIGUOUS_OPERATION", "snapshot path already exists outside the durable manifest");
    }
    fail("DURABILITY_FAILED", "operation state could not be published durably");
  }
}

function publishAfterArtifact(
  path: string, content: Buffer, filesystem: ClientOperationFilesystem,
  cache?: PrivateDirectoryAccessCache,
): void {
  try {
    if (!existsSync(path)) { publishNoReplace(path, content, filesystem, cache); return; }
    const directory = dirname(path); const identity = privateDirectory(directory, cache);
    verifyPrivatePathAccess(path, "file");
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const details = fstatSync(descriptor);
      if (!details.isFile() || details.size !== content.byteLength
        || createHash("sha256").update(readFileSync(descriptor)).digest("hex") !== createHash("sha256").update(content).digest("hex")) {
        fail("AMBIGUOUS_OPERATION", "existing after artifact does not match the verified after-state");
      }
      sameDirectory(directory, identity, cache);
    } finally { closeSync(descriptor); }
    filesystem.hook("before-directory-sync", directory);
    sameDirectory(directory, identity, cache);
    filesystem.syncDirectory(directory);
    sameDirectory(directory, identity, cache);
  } catch (error) {
    cache?.clear();
    throw error;
  }
}

function createClientOperationWithCache(input: {
  operationId?: string; request: ClientOperationRequest; runtime: InstallableRuntime; instance: string;
  steps: Array<Pick<ClientOperationStep, "target" | "locator" | "beforeArtifact" | "afterArtifact" | "expectedBeforeSha256" | "expectedAfterSha256">>;
}, env: NodeJS.ProcessEnv = process.env, filesystem: ClientOperationFilesystem = filesystemDefaults,
cache?: PrivateDirectoryAccessCache): ClientOperationManifest {
  const operationId = (input.operationId ?? randomUUID()).toLowerCase();
  if (!UUID.test(operationId) || !RUNTIMES.includes(input.runtime)) {
    fail("INVALID_OPERATION", "operation request is invalid");
  }
  const request = validateRequest(input.request, input.runtime, CLIENT_OPERATION_VERSION) as ClientOperationRequest;
  const instance = safeText(input.instance.trim(), "instance");
  const pinned = pinOperationRoot(env, true, cache);
  const directory = join(pinned.root, operationId);
  assertPinnedRoot(pinned, cache);
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") fail("OPERATION_EXISTS", "operation already exists");
    fail("DURABILITY_FAILED", "operation could not be created");
  }
  assertPinnedRoot(pinned, cache);
  if (cache) cache.secure(directory);
  else securePrivatePath(directory, "directory");
  assertPinnedRoot(pinned, cache);
  prepareDirectory(join(directory, "snapshots"), cache);
  assertPinnedRoot(pinned, cache);
  const now = new Date().toISOString();
  const manifest: ClientOperationManifest = {
    schema: CLIENT_OPERATION_SCHEMA, version: CLIENT_OPERATION_VERSION, operationId,
    request, runtime: input.runtime, instance, state: "prepared", revision: 0,
    host: hostname(), createdAt: now, updatedAt: now, completion: null, artifacts: [],
    steps: input.steps.map((step, index) => ({ ...step, index, state: "pending" as const, intentRecordedAt: null, observedAppliedAt: null })),
  };
  try {
    filesystem.hook("after-snapshots-created", directory);
    assertPinnedRoot(pinned, cache);
    publish(join(directory, "manifest.json"), serialize(manifest), filesystem, undefined, cache);
    assertPinnedRoot(pinned, cache);
    filesystem.syncDirectory(pinned.root);
    assertPinnedRoot(pinned, cache);
  }
  catch (error) {
    try {
      assertPinnedRoot(pinned, cache);
      const publishedManifest = join(directory, "manifest.json");
      if (!existsSync(publishedManifest)) {
        filesystem.hook("before-cleanup", directory);
        assertPinnedRoot(pinned, cache);
        filesystem.remove(directory, { recursive: true, force: true });
        assertPinnedRoot(pinned, cache);
      }
    } catch {}
    throw error;
  }
  return manifest;
}

export function createClientOperation(input: {
  operationId?: string; request: ClientOperationRequest; runtime: InstallableRuntime; instance: string;
  steps: Array<Pick<ClientOperationStep, "target" | "locator" | "beforeArtifact" | "afterArtifact" | "expectedBeforeSha256" | "expectedAfterSha256">>;
}, env: NodeJS.ProcessEnv = process.env, filesystem: ClientOperationFilesystem = filesystemDefaults): ClientOperationManifest {
  return createClientOperationWithCache(input, env, filesystem);
}

export interface BegunClientOperation { manifest: ClientOperationManifest; lock: ClientOperationLock }

/** Acquire the client lock before checking or creating any operation state. */
export function beginClientOperation(input: Parameters<typeof createClientOperation>[0], env: NodeJS.ProcessEnv = process.env, filesystem: ClientOperationFilesystem = filesystemDefaults): BegunClientOperation {
  const lock = acquireClientOperationLock(input.runtime, input.instance, env);
  try {
    const operations = listClientOperations(env, filesystem);
    if (operations.some((summary) => summary.inspectionState === "blocked")) {
      fail("BLOCKED_OPERATION", "a blocked operation must be resolved before another client mutation can begin");
    }
    const unfinished = operations.find((summary) => summary.runtime === input.runtime
      && summary.instance === input.instance && summary.inspectionState !== "complete");
    if (unfinished) fail("UNFINISHED_OPERATION", `unfinished operation ${unfinished.operationId} already owns this client`);
    return { manifest: createClientOperationWithCache(input, env, filesystem, privatePathCacheForLock(lock)), lock };
  } catch (error) {
    try { releaseClientOperationLock(lock); } catch {}
    throw error;
  }
}

/** Resume is same-host only and returns with the per-client lock held. */
export function resumeClientOperation(operationId: string, env: NodeJS.ProcessEnv = process.env, filesystem: ClientOperationFilesystem = filesystemDefaults): BegunClientOperation {
  const manifest = readClientOperation(operationId, env);
  if (manifest.state === "committed") fail("OPERATION_COMPLETE", "committed operation cannot be resumed");
  if (manifest.version !== CLIENT_OPERATION_VERSION) {
    fail("LEGACY_OPERATION", "legacy operation cannot resume without an identity-bound request");
  }
  if (manifest.host !== hostname()) fail("CROSS_HOST_RESUME", "operation can only resume on its creating host");
  const lock = acquireClientOperationLock(manifest.runtime, manifest.instance, env);
  try {
    const operations = listClientOperations(env, filesystem);
    if (operations.some((summary) => summary.inspectionState === "blocked")) {
      fail("BLOCKED_OPERATION", "a blocked operation must be resolved before another client mutation can resume");
    }
    const summary = inspectClientOperation(operationId, env, filesystem);
    if (summary.inspectionState === "blocked") fail("OPERATION_BLOCKED", summary.reason);
    const resumed = readClientOperation(operationId, env);
    if (resumed.runtime !== lock.runtime || resumed.instance !== lock.instance
      || resumed.operationId !== manifest.operationId || resumed.host !== hostname()) {
      fail("LOCK_MISMATCH", "client lock does not cover the resumed operation");
    }
    return { manifest: resumed, lock };
  } catch (error) {
    try { releaseClientOperationLock(lock); } catch {}
    throw error;
  }
}

function readClientOperationWithCache(
  operationId: string,
  env: NodeJS.ProcessEnv,
  cache?: PrivateDirectoryAccessCache,
): ClientOperationManifest {
  const path = manifestPath(operationId, env);
  verifyInsideRoot(path, env, cache);
  const directory = dirname(path);
  const identity = privateDirectory(directory, cache);
  try {
    verifyPrivatePathAccess(path, "file");
  } catch { fail("CORRUPT_OPERATION", "operation manifest is unavailable or insecure"); }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const details = fstatSync(descriptor);
    if (!details.isFile() || details.size > MAX_MANIFEST_BYTES) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    let value: unknown;
    try { value = JSON.parse(readFileSync(descriptor, "utf8")); } catch { fail("CORRUPT_OPERATION", "operation manifest is corrupt"); }
    sameDirectory(directory, identity, cache);
    const manifest = validateClientOperation(value);
    if (manifest.operationId !== operationId.toLowerCase()) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    return manifest;
  } finally { closeSync(descriptor); }
}
export function readClientOperation(operationId: string, env: NodeJS.ProcessEnv = process.env): ClientOperationManifest {
  return readClientOperationWithCache(operationId, env);
}

function lockName(runtime: InstallableRuntime, instance: string): string {
  const digest = createHash("sha256").update(`${runtime}\0${instance}`).digest("hex");
  return `${runtime}-${digest}.lock`;
}
export function acquireClientOperationLock(runtime: InstallableRuntime, instance: string, env: NodeJS.ProcessEnv = process.env): ClientOperationLock {
  if (!RUNTIMES.includes(runtime)) fail("INVALID_OPERATION", "client runtime is invalid");
  instance = safeText(instance.trim(), "instance");
  const cache = createPrivateDirectoryAccessCache();
  const root = prepareRoot(env, cache);
  const directory = join(root, "locks");
  const identity = privateDirectory(directory, cache);
  const lockPath = join(directory, lockName(runtime, instance));
  let descriptor: number;
  try { descriptor = openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") fail("CLIENT_LOCKED", "another operation holds the client lock");
    fail("LOCK_FAILED", "client lock could not be acquired");
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify({ schema: "agent-bridge.client-operation-lock", version: 1, runtime, instance, pid: process.pid, host: hostname(), createdAt: new Date().toISOString(), nonce: randomUUID() })}\n`);
    fsyncSync(descriptor);
    securePrivatePath(lockPath, "file");
    sameDirectory(directory, identity, cache); syncDirectory(directory);
    const details = fstatSync(descriptor);
    const lock = { runtime, instance, lockPath, descriptor, device: details.dev, inode: details.ino, released: false };
    operationLockPrivatePathCaches.set(lock, cache);
    return lock;
  } catch {
    cache.clear();
    try { closeSync(descriptor); } catch {} rmSync(lockPath, { force: true });
    fail("LOCK_FAILED", "client lock could not be acquired");
  }
}
function assertLock(lock: ClientOperationLock): void {
  if (lock.released) fail("LOCK_REPLACED", "client lock is no longer held");
  const opened = fstatSync(lock.descriptor);
  let current;
  try { current = lstatSync(lock.lockPath); } catch { fail("LOCK_REPLACED", "client lock changed while held"); }
  if (current.isSymbolicLink() || current.dev !== lock.device || current.ino !== lock.inode
    || opened.dev !== lock.device || opened.ino !== lock.inode) fail("LOCK_REPLACED", "client lock changed while held");
}
export function releaseClientOperationLock(lock: ClientOperationLock): "released" | "durability-unknown" {
  const cache = privatePathCacheForLock(lock);
  try {
    assertLock(lock);
    const directory = dirname(lock.lockPath); const identity = privateDirectory(directory, cache);
    closeSync(lock.descriptor);
    const current = lstatSync(lock.lockPath);
    if (current.dev !== lock.device || current.ino !== lock.inode) fail("LOCK_REPLACED", "client lock changed before release");
    rmSync(lock.lockPath); lock.released = true;
    try { sameDirectory(directory, identity, cache); syncDirectory(directory); return "released"; } catch { return "durability-unknown"; }
  } finally {
    cache.clear();
    operationLockPrivatePathCaches.delete(lock);
  }
}
export function recoverClientOperationLock(runtime: InstallableRuntime, instance: string, env: NodeJS.ProcessEnv = process.env, now = Date.now(), filesystem: ClientOperationFilesystem = filesystemDefaults): void {
  if (!RUNTIMES.includes(runtime)) fail("INVALID_OPERATION", "client runtime is invalid");
  instance = safeText(instance.trim(), "instance");
  const pinned = pinOperationRoot(env, false);
  const path = join(pinned.locks, lockName(runtime, instance));
  try { verifyPrivatePathAccess(path, "file"); } catch { fail("LOCK_RECOVERY_REFUSED", "client lock cannot be safely recovered"); }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let details;
  try {
    details = fstatSync(descriptor);
    if (!details.isFile() || details.size > MAX_LOCK_BYTES) {
      fail("LOCK_RECOVERY_REFUSED", "client lock cannot be safely recovered");
    }
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(readFileSync(descriptor, "utf8")); } catch { fail("LOCK_RECOVERY_REFUSED", "client lock cannot be safely recovered"); }
    if (metadata.schema !== "agent-bridge.client-operation-lock" || metadata.version !== 1
      || metadata.runtime !== runtime || metadata.instance !== instance || metadata.host !== hostname()
      || !Number.isSafeInteger(metadata.pid) || typeof metadata.createdAt !== "string"
      || !Number.isFinite(Date.parse(metadata.createdAt))) fail("LOCK_RECOVERY_REFUSED", "client lock cannot be safely recovered");
    if (now - Date.parse(metadata.createdAt) < 60_000) fail("LOCK_RECOVERY_REFUSED", "client lock is too recent to recover");
    try { process.kill(Number(metadata.pid), 0); fail("CLIENT_LOCKED", "client lock owner is still running"); }
    catch (error) {
      if (error instanceof ClientOperationError) throw error;
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
        fail("LOCK_RECOVERY_REFUSED", "cannot prove that the client lock owner stopped");
      }
    }
    assertPinnedRoot(pinned);
    const current = lstatSync(path);
    if (current.dev !== details.dev || current.ino !== details.ino || current.isSymbolicLink()) fail("LOCK_REPLACED", "client lock changed during recovery");
  } finally { closeSync(descriptor); }
  assertPinnedRoot(pinned);
  filesystem.hook("before-lock-remove", path);
  assertPinnedRoot(pinned);
  filesystem.remove(path);
  assertPinnedRoot(pinned);
  filesystem.hook("before-directory-sync", pinned.locks);
  filesystem.syncDirectory(pinned.locks);
  assertPinnedRoot(pinned);
}

const TRANSITIONS = new Set(["prepared->snapshotted"]);
export function transitionClientOperation(operationId: string, current: ClientOperationManifest, state: ClientOperationState, lock: ClientOperationLock, env: NodeJS.ProcessEnv = process.env): ClientOperationManifest {
  assertLock(lock);
  const cache = privatePathCacheForLock(lock);
  const disk = readClientOperationWithCache(operationId, env, cache);
  if (disk.runtime !== lock.runtime || disk.instance !== lock.instance) fail("LOCK_MISMATCH", "client lock does not cover this operation");
  if (disk.host !== hostname()) fail("CROSS_HOST_RESUME", "operation can only mutate on its creating host");
  if (disk.revision !== current.revision || disk.state !== current.state || disk.operationId !== current.operationId) fail("STALE_OPERATION", "stale operation transition refused");
  if (!TRANSITIONS.has(`${disk.state}->${state}`)) fail("ILLEGAL_TRANSITION", "operation state transition is not allowed");
  if (state === "snapshotted" && !hasCompleteSnapshots(disk)) {
    fail("MISSING_SNAPSHOT", "operation requires a durable snapshot for every ordered step");
  }
  const next = validateClientOperation({ ...disk, state, revision: disk.revision + 1, updatedAt: new Date().toISOString() });
  publish(manifestPath(operationId, env), serialize(next), filesystemDefaults, undefined, cache);
  return next;
}

function pendingStep(manifest: ClientOperationManifest): ClientOperationStep | undefined {
  return manifest.steps.find((step) => step.state !== "observed-applied");
}

function verifyOperationLock(operationId: string, current: ClientOperationManifest, lock: ClientOperationLock, env: NodeJS.ProcessEnv): ClientOperationManifest {
  assertLock(lock);
  const disk = readClientOperationWithCache(operationId, env, privatePathCacheForLock(lock));
  if (disk.runtime !== lock.runtime || disk.instance !== lock.instance) fail("LOCK_MISMATCH", "client lock does not cover this operation");
  if (disk.host !== hostname()) fail("CROSS_HOST_RESUME", "operation can only mutate on its creating host");
  if (disk.revision !== current.revision || disk.state !== current.state || disk.operationId !== current.operationId) {
    fail("STALE_OPERATION", "stale operation transition refused");
  }
  return disk;
}

/** Persist this intent before the caller performs the corresponding external write. */
export function recordClientOperationStepIntent(
  operationId: string, current: ClientOperationManifest, stepIndex: number,
  lock: ClientOperationLock, env: NodeJS.ProcessEnv = process.env,
): ClientOperationManifest {
  const disk = verifyOperationLock(operationId, current, lock, env);
  if (disk.state !== "snapshotted" && disk.state !== "in-progress") fail("ILLEGAL_TRANSITION", "operation is not ready to apply a step");
  const step = pendingStep(disk);
  if (!step || step.index !== stepIndex || step.state !== "pending"
    || !disk.artifacts.some((artifact) => artifact.name === step.beforeArtifact && artifact.phase === "before")) {
    fail("ILLEGAL_TRANSITION", "operation step intent is out of order or lacks its snapshot");
  }
  const now = new Date().toISOString();
  const steps = disk.steps.map((item) => item.index === stepIndex
    ? { ...item, state: "intent-recorded" as const, intentRecordedAt: now }
    : item);
  const next = validateClientOperation({ ...disk, state: "in-progress", revision: disk.revision + 1, updatedAt: now, steps });
  publish(manifestPath(operationId, env), serialize(next), filesystemDefaults, undefined, privatePathCacheForLock(lock));
  return next;
}

/** Persist observed-applied only after the caller has verified the external digest. */
export function recordClientOperationStepApplied(
  operationId: string, current: ClientOperationManifest, stepIndex: number, afterContents: string | Buffer,
  lock: ClientOperationLock, env: NodeJS.ProcessEnv = process.env, filesystem: ClientOperationFilesystem = filesystemDefaults,
): ClientOperationManifest {
  const disk = verifyOperationLock(operationId, current, lock, env);
  const step = pendingStep(disk);
  const buffer = Buffer.isBuffer(afterContents) ? afterContents : Buffer.from(afterContents);
  const observedSha256 = createHash("sha256").update(buffer).digest("hex");
  if (disk.state !== "in-progress" || !step || step.index !== stepIndex || step.state !== "intent-recorded"
    || observedSha256 !== step.expectedAfterSha256) fail("AMBIGUOUS_OPERATION", "operation step after-state was not verified");
  if (buffer.byteLength > MAX_SNAPSHOT_BYTES) fail("SNAPSHOT_TOO_LARGE", "artifact exceeds the operation size limit");
  const artifactPath = join(operationDirectory(operationId, env), "snapshots", step.afterArtifact);
  const cache = privatePathCacheForLock(lock);
  publishAfterArtifact(artifactPath, buffer, filesystem, cache);
  const now = new Date().toISOString();
  const steps = disk.steps.map((item) => item.index === stepIndex
    ? { ...item, state: "observed-applied" as const, observedAppliedAt: now }
    : item);
  const artifact: ClientOperationArtifact = {
    name: step.afterArtifact, stepIndex, phase: "after", bytes: buffer.byteLength, sha256: observedSha256,
    cleanupIntentAt: null, removedAt: null, directoryDurability: null,
  };
  const state: ClientOperationState = steps.every((item) => item.state === "observed-applied") ? "applied" : "in-progress";
  const next = validateClientOperation({ ...disk, state, revision: disk.revision + 1, updatedAt: now, steps, artifacts: [...disk.artifacts, artifact] });
  try { publish(manifestPath(operationId, env), serialize(next), filesystem, undefined, cache); }
  catch { fail("AMBIGUOUS_OPERATION", "after artifact publication left ambiguous operation state"); }
  return next;
}

export interface ClientOperationRestartClassification {
  stepIndex: number | null;
  disposition: "complete" | "retryable" | "advance" | "blocked";
  reason: string;
}

/** Classify one externally observed digest without changing either operation or client state. */
export function classifyClientOperationRestart(
  manifest: ClientOperationManifest, observedSha256: string,
): ClientOperationRestartClassification {
  const step = pendingStep(manifest);
  if (!step) return { stepIndex: null, disposition: "complete", reason: "all ordered steps are durably observed applied" };
  if (!/^[0-9a-f]{64}$/.test(observedSha256)) return { stepIndex: step.index, disposition: "blocked", reason: "the pending step state is ambiguous" };
  if (observedSha256 === step.expectedAfterSha256 && step.state === "intent-recorded") return { stepIndex: step.index, disposition: "advance", reason: "the pending step matches its expected after-state" };
  if (observedSha256 === step.expectedBeforeSha256) return { stepIndex: step.index, disposition: "retryable", reason: "the pending step matches its expected before-state" };
  return { stepIndex: step.index, disposition: "blocked", reason: "the pending step state is ambiguous" };
}
export function writeClientOperationSnapshot(operationId: string, current: ClientOperationManifest, name: string, contents: string | Buffer, lock: ClientOperationLock, env: NodeJS.ProcessEnv = process.env, filesystem: ClientOperationFilesystem = filesystemDefaults): ClientOperationManifest {
  assertLock(lock);
  const cache = privatePathCacheForLock(lock);
  name = safeText(name, "snapshot name", 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) fail("INVALID_SNAPSHOT", "snapshot name is invalid");
  const disk = readClientOperationWithCache(operationId, env, cache);
  if (disk.runtime !== lock.runtime || disk.instance !== lock.instance) fail("LOCK_MISMATCH", "client lock does not cover this operation");
  if (disk.host !== hostname()) fail("CROSS_HOST_RESUME", "operation can only mutate on its creating host");
  const step = disk.steps.find((item) => item.beforeArtifact === name);
  if (disk.revision !== current.revision || disk.state !== "prepared"
    || disk.artifacts.some((item) => item.name === name) || !step) {
    fail("STALE_OPERATION", "snapshot publication refused");
  }
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (buffer.byteLength > MAX_SNAPSHOT_BYTES
    || disk.artifacts.reduce((total, artifact) => total + artifact.bytes, 0) + buffer.byteLength > MAX_TOTAL_SNAPSHOT_BYTES) {
    fail("SNAPSHOT_TOO_LARGE", "snapshot exceeds the operation size limit");
  }
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (sha256 !== step.expectedBeforeSha256) fail("SNAPSHOT_MISMATCH", "snapshot does not match the expected before-state");
  const snapshotDirectory = join(operationDirectory(operationId, env), "snapshots");
  privateDirectory(snapshotDirectory, cache);
  publishNoReplace(join(snapshotDirectory, name), buffer, filesystem, cache);
  const artifact: ClientOperationArtifact = {
    name, stepIndex: step.index, phase: "before", bytes: buffer.byteLength, sha256,
    cleanupIntentAt: null, removedAt: null, directoryDurability: null,
  };
  const next = validateClientOperation({ ...disk, revision: disk.revision + 1, updatedAt: new Date().toISOString(), artifacts: [...disk.artifacts, artifact] });
  try { publish(manifestPath(operationId, env), serialize(next), filesystem, undefined, cache); }
  catch (error) { fail("AMBIGUOUS_OPERATION", "snapshot publication left ambiguous operation state"); }
  return next;
}

/** Remove one artifact with durable intent. Call repeatedly until committed. */
export function cleanupClientOperationArtifact(
  operationId: string, current: ClientOperationManifest, lock: ClientOperationLock,
  env: NodeJS.ProcessEnv = process.env, filesystem: ClientOperationFilesystem = filesystemDefaults,
): ClientOperationManifest {
  if (!UUID.test(operationId)) fail("INVALID_OPERATION_ID", "operation id is invalid");
  const cache = privatePathCacheForLock(lock);
  try {
    return cleanupClientOperationArtifactWithCache(operationId, current, lock, env, filesystem, cache);
  } catch (error) {
    cache.clear();
    throw error;
  }
}

function cleanupClientOperationArtifactWithCache(
  operationId: string, current: ClientOperationManifest, lock: ClientOperationLock,
  env: NodeJS.ProcessEnv, filesystem: ClientOperationFilesystem, cache: PrivateDirectoryAccessCache,
): ClientOperationManifest {
  const pinned = pinOperationRoot(env, false, cache);
  const operationPath = join(pinned.root, operationId.toLowerCase());
  const operationIdentity = privateDirectory(operationPath, cache);
  const directory = join(operationPath, "snapshots");
  const identity = privateDirectory(directory, cache);
  const operationManifest = join(operationPath, "manifest.json");
  const assertCleanupPaths = () => {
    assertPinnedRoot(pinned, cache);
    sameDirectory(operationPath, operationIdentity, cache);
    sameDirectory(directory, identity, cache);
  };
  assertCleanupPaths();
  let disk = verifyOperationLock(operationId, current, lock, env);
  assertCleanupPaths();
  if (disk.state === "committed") return disk;
  if (disk.state !== "applied" && disk.state !== "cleaning") fail("ILLEGAL_TRANSITION", "operation writes are not fully applied");
  let artifact = disk.artifacts.find((item) => item.removedAt === null);
  if (!artifact) {
    filesystem.hook("before-cleanup-commit", operationManifest);
    assertCleanupPaths();
    const now = new Date().toISOString();
    const completion: ClientOperationCompletion = {
      operation: disk.request!.kind,
      stepCount: disk.steps.length,
      completedAt: now,
      cleanupDirectoryDurability: disk.artifacts.some((item) => item.directoryDurability === "unavailable")
        ? "unavailable" : "durable",
    };
    const terminal = validateClientOperation({
      ...disk, request: null, state: "committed", revision: disk.revision + 1,
      updatedAt: now, completion, artifacts: [], steps: [],
    });
    publish(operationManifest, serialize(terminal), filesystem, operationIdentity, cache);
    assertCleanupPaths();
    return terminal;
  }
  const intentPredatedInvocation = artifact.cleanupIntentAt !== null;
  const path = join(directory, artifact.name);
  if (!intentPredatedInvocation) {
    let preflight: number;
    try { preflight = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        fail("CLEANUP_BLOCKED", "artifact disappeared before cleanup intent could authorize recovery");
      }
      fail("CLEANUP_BLOCKED", "artifact cannot be safely opened for cleanup");
    }
    try {
      const details = fstatSync(preflight);
      if (!details.isFile() || details.size !== artifact.bytes
        || createHash("sha256").update(readFileSync(preflight)).digest("hex") !== artifact.sha256) {
        fail("CLEANUP_BLOCKED", "artifact no longer matches its durable record");
      }
      sameDirectory(directory, identity, cache);
      const currentPath = lstatSync(path);
      if (currentPath.isSymbolicLink() || currentPath.dev !== details.dev || currentPath.ino !== details.ino) {
        fail("PATH_REPLACED", "artifact changed during cleanup");
      }
    } finally { closeSync(preflight); }
    assertCleanupPaths();
    const now = new Date().toISOString();
    const artifacts = disk.artifacts.map((item) => item.name === artifact!.name ? { ...item, cleanupIntentAt: now } : item);
    disk = validateClientOperation({ ...disk, state: "cleaning", revision: disk.revision + 1, updatedAt: now, artifacts });
    publish(operationManifest, serialize(disk), filesystem, operationIdentity, cache);
    assertCleanupPaths();
    filesystem.hook("after-cleanup-intent", artifact.name);
    assertCleanupPaths();
    artifact = disk.artifacts.find((item) => item.name === artifact!.name)!;
  }
  let absent = false;
  let descriptor: number | undefined;
  try { descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && intentPredatedInvocation) absent = true;
    else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      fail("CLEANUP_BLOCKED", "artifact disappeared before cleanup intent could authorize recovery");
    }
    else fail("CLEANUP_BLOCKED", "artifact cannot be safely opened for cleanup");
  }
  if (descriptor !== undefined) {
    try {
      const details = fstatSync(descriptor);
      if (!details.isFile() || details.size !== artifact.bytes
        || createHash("sha256").update(readFileSync(descriptor)).digest("hex") !== artifact.sha256) {
        fail("CLEANUP_BLOCKED", "artifact no longer matches its durable record");
      }
      sameDirectory(directory, identity, cache);
      const currentPath = lstatSync(path);
      if (currentPath.isSymbolicLink() || currentPath.dev !== details.dev || currentPath.ino !== details.ino) {
        fail("PATH_REPLACED", "artifact changed during cleanup");
      }
    } finally { closeSync(descriptor); }
  }
  if (!absent) {
    filesystem.hook("before-artifact-unlink", path);
    assertCleanupPaths();
    filesystem.remove(path);
    filesystem.hook("after-artifact-unlink", path);
  }
  assertCleanupPaths();
  let directoryDurability: "durable" | "unavailable";
  if (process.platform === "win32") directoryDurability = "unavailable";
  else {
    filesystem.hook("before-directory-sync", directory);
    assertCleanupPaths();
    filesystem.syncDirectory(directory);
    assertCleanupPaths();
    directoryDurability = "durable";
  }
  filesystem.hook("after-artifact-directory-sync", path);
  const now = new Date().toISOString();
  const artifacts = disk.artifacts.map((item) => item.name === artifact!.name
    ? { ...item, removedAt: now, directoryDurability } : item);
  const next = validateClientOperation({ ...disk, state: "cleaning", revision: disk.revision + 1, updatedAt: now, artifacts });
  assertCleanupPaths();
  publish(operationManifest, serialize(next), filesystem, operationIdentity, cache);
  assertCleanupPaths();
  return next;
}

export function completeClientOperationCleanup(
  operationId: string, current: ClientOperationManifest, lock: ClientOperationLock,
  env: NodeJS.ProcessEnv = process.env, filesystem: ClientOperationFilesystem = filesystemDefaults,
): ClientOperationManifest {
  let manifest = current;
  while (manifest.state !== "committed") manifest = cleanupClientOperationArtifact(operationId, manifest, lock, env, filesystem);
  return manifest;
}

interface ClientOperationArtifactInspection { intact: boolean; resumableResidue: boolean }
function inspectOperationArtifacts(manifest: ClientOperationManifest, env: NodeJS.ProcessEnv, filesystem: ClientOperationFilesystem): ClientOperationArtifactInspection {
  const directory = join(operationDirectory(manifest.operationId, env), "snapshots");
  try {
    const identity = privateDirectory(directory);
    const names = readdirSync(directory).sort();
    filesystem.hook("after-snapshot-directory-read", directory);
    sameDirectory(directory, identity);
    const retained = manifest.artifacts.filter((item) => item.removedAt === null);
    const retainedNames = new Set(retained.map((item) => item.name));
    const pending = pendingStep(manifest);
    const orphanAfter = pending?.state === "intent-recorded"
      && !manifest.artifacts.some((item) => item.name === pending.afterArtifact)
      ? pending : null;
    let resumableResidue = false;
    for (const name of names) {
      if (retainedNames.has(name)) continue;
      if (!orphanAfter || name !== orphanAfter.afterArtifact) return { intact: false, resumableResidue: false };
      sameDirectory(directory, identity);
      const path = join(directory, name); verifyPrivatePathAccess(path, "file");
      const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const details = fstatSync(descriptor);
        if (!details.isFile() || details.size > MAX_SNAPSHOT_BYTES
          || createHash("sha256").update(readFileSync(descriptor)).digest("hex") !== orphanAfter.expectedAfterSha256) {
          return { intact: false, resumableResidue: false };
        }
        sameDirectory(directory, identity);
        resumableResidue = true;
      } finally { closeSync(descriptor); }
    }
    for (const artifact of retained) {
      if (!names.includes(artifact.name)) {
        if (artifact.cleanupIntentAt !== null) { resumableResidue = true; continue; }
        return { intact: false, resumableResidue: false };
      }
      sameDirectory(directory, identity);
      const path = join(directory, artifact.name); verifyPrivatePathAccess(path, "file");
      filesystem.hook("before-snapshot-file-open", path);
      sameDirectory(directory, identity);
      const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const details = fstatSync(descriptor);
        if (!details.isFile() || details.size !== artifact.bytes || details.size > MAX_SNAPSHOT_BYTES) {
          return { intact: false, resumableResidue: false };
        }
        const matches = createHash("sha256").update(readFileSync(descriptor)).digest("hex") === artifact.sha256;
        sameDirectory(directory, identity);
        if (!matches) return { intact: false, resumableResidue: false };
      } finally { closeSync(descriptor); }
    }
    return { intact: true, resumableResidue };
  } catch { return { intact: false, resumableResidue: false }; }
}
export function inspectClientOperation(operationId: string, env: NodeJS.ProcessEnv = process.env, filesystem: ClientOperationFilesystem = filesystemDefaults): ClientOperationSummary {
  try {
    const manifest = readClientOperation(operationId, env);
    const artifactInspection = inspectOperationArtifacts(manifest, env, filesystem);
    const intact = artifactInspection.intact;
    const pending = pendingStep(manifest);
    const ambiguous = pending?.state === "intent-recorded";
    const sameHost = manifest.host === hostname();
    const legacy = manifest.version !== CLIENT_OPERATION_VERSION && manifest.state !== "committed";
    const inspectionState: ClientOperationSummary["inspectionState"] = !intact
      ? "blocked" : manifest.state === "committed" ? "complete" : !sameHost
        ? "blocked" : legacy ? "blocked" : ambiguous ? "classification-required" : "resumable";
    return {
      schemaVersion: 3, operationId: manifest.operationId,
      operation: manifest.request?.kind ?? manifest.completion?.operation ?? null,
      runtime: manifest.runtime, instance: manifest.instance,
      state: intact ? manifest.state : "corrupt", inspectionState, revision: manifest.revision,
      createdAt: manifest.createdAt, updatedAt: manifest.updatedAt,
      completedAt: manifest.completion?.completedAt ?? null,
      cleanupDirectoryDurability: manifest.completion?.cleanupDirectoryDurability ?? null,
      artifacts: intact ? manifest.artifacts : [], pendingStep: intact ? (pending?.index ?? null) : null,
      recoverable: inspectionState === "resumable" || inspectionState === "classification-required",
      reason: !intact ? "operation artifacts do not match the durable manifest"
        : !sameHost ? "operation can only resume on its creating host"
        : legacy ? "legacy operation lacks an identity-bound request and cannot resume"
        : ambiguous ? `operation stopped at ordered step ${pending.index} and requires external-state classification`
          : manifest.state === "committed" ? "operation is complete and retains a credential-free audit record"
          : artifactInspection.resumableResidue ? "operation contains expected crash residue and can resume safely"
            : "operation state is internally consistent",
    };
  } catch (error) {
    if (!(error instanceof ClientOperationError) || error.code === "INVALID_OPERATION_ID") throw error;
    return { schemaVersion: 3, operationId: operationId.toLowerCase(), operation: null, runtime: null, instance: null, state: "corrupt", inspectionState: "blocked", revision: null, createdAt: null, updatedAt: null, completedAt: null, cleanupDirectoryDurability: null, artifacts: [], pendingStep: null, recoverable: false, reason: "operation state is corrupt or insecure" };
  }
}
export function reconcileClientOperation(operationId: string, env: NodeJS.ProcessEnv = process.env): ClientOperationSummary {
  const summary = inspectClientOperation(operationId, env);
  if (summary.inspectionState === "blocked") fail("CORRUPT_OPERATION", "operation state cannot be safely reconciled");
  if (summary.inspectionState === "classification-required") fail("AMBIGUOUS_OPERATION", "operation requires external-state classification at its pending step");
  return summary;
}
export function listClientOperations(env: NodeJS.ProcessEnv = process.env, filesystem: ClientOperationFilesystem = filesystemDefaults): ClientOperationSummary[] {
  const root = clientOperationRoot(env);
  if (!existsSync(root)) return [];
  privateDirectory(root);
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => UUID.test(entry.name));
  if (entries.length > MAX_LISTED_OPERATIONS) {
    fail("OPERATION_LIMIT", "operation directory exceeds the inspection limit");
  }
  return entries
    .map((entry) => inspectClientOperation(entry.name, env, filesystem))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
