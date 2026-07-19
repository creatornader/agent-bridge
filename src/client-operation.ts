import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  linkSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { securePrivatePath, verifyPrivatePathAccess } from "./private-path.js";
import type { InstallableRuntime } from "./client-installer.js";

export const CLIENT_OPERATION_SCHEMA = "agent-bridge.client-operation";
export const CLIENT_OPERATION_VERSION = 1;
export type ClientOperationState =
  | "prepared" | "snapshotted" | "in-progress" | "committed";
export type ClientOperationKind = "repair" | "update" | "uninstall" | "migrate";
export type ClientOperationTargetKind = "registration" | "backend" | "metadata";
export type ClientOperationStepState = "pending" | "intent-recorded" | "observed-applied";

export interface ClientOperationStep {
  index: number;
  target: ClientOperationTargetKind;
  locator: string;
  snapshotArtifact: string;
  expectedBeforeSha256: string;
  expectedAfterSha256: string;
  state: ClientOperationStepState;
  intentRecordedAt: string | null;
  observedAppliedAt: string | null;
}

export interface ClientOperationArtifact {
  name: string;
  bytes: number;
  sha256: string;
}

export interface ClientOperationManifest {
  schema: typeof CLIENT_OPERATION_SCHEMA;
  version: typeof CLIENT_OPERATION_VERSION;
  operationId: string;
  operation: ClientOperationKind;
  runtime: InstallableRuntime;
  instance: string;
  state: ClientOperationState;
  revision: number;
  host: string;
  createdAt: string;
  updatedAt: string;
  artifacts: ClientOperationArtifact[];
  steps: ClientOperationStep[];
}

export interface ClientOperationSummary {
  schemaVersion: 1;
  operationId: string;
  operation: ClientOperationKind | null;
  runtime: InstallableRuntime | null;
  instance: string | null;
  state: ClientOperationState | "corrupt";
  revision: number | null;
  createdAt: string | null;
  updatedAt: string | null;
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

export type ClientOperationFilesystemEvent =
  | "before-publish-rename" | "after-publish-rename" | "before-publish-link"
  | "after-publish-link" | "before-directory-sync"
  | "before-cleanup" | "after-snapshot-directory-read" | "before-snapshot-file-open"
  | "after-snapshots-created" | "before-lock-remove";
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
const MAX_OPERATION_ARTIFACTS = 128;
const MAX_LISTED_OPERATIONS = 1000;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const STATES: ClientOperationState[] = ["prepared", "snapshotted", "in-progress", "committed"];
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
function privateDirectory(path: string): { device: number; inode: number } {
  rejectLinks(path);
  let details;
  try { details = lstatSync(path); } catch { fail("INSECURE_PATH", "operation directory is unavailable"); }
  if (!details.isDirectory() || details.isSymbolicLink()) fail("INSECURE_PATH", "operation directory is invalid");
  try { verifyPrivatePathAccess(path, "directory"); } catch { fail("INSECURE_PATH", "operation directory is not owner-private"); }
  return { device: details.dev, inode: details.ino };
}
function sameDirectory(path: string, identity: { device: number; inode: number }): void {
  const current = privateDirectory(path);
  if (current.device !== identity.device || current.inode !== identity.inode) {
    fail("PATH_REPLACED", "operation directory changed during access");
  }
}
function prepareDirectory(path: string): void {
  rejectLinks(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { securePrivatePath(path, "directory"); } catch { fail("INSECURE_PATH", "operation directory is not owner-private"); }
  privateDirectory(path);
}

export function clientOperationRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_BRIDGE_OPERATION_DIR) return resolve(env.AGENT_BRIDGE_OPERATION_DIR);
  return join(realpathSync(env.HOME ?? homedir()), ".agent-bridge", "operations");
}
function prepareRoot(env: NodeJS.ProcessEnv): string {
  const root = clientOperationRoot(env);
  prepareDirectory(root);
  prepareDirectory(join(root, "locks"));
  return root;
}

interface PinnedOperationRoot {
  root: string;
  rootIdentity: { device: number; inode: number };
  locks: string;
  locksIdentity: { device: number; inode: number };
}

function pinOperationRoot(env: NodeJS.ProcessEnv, create: boolean): PinnedOperationRoot {
  const root = clientOperationRoot(env);
  if (create) prepareRoot(env);
  const rootIdentity = privateDirectory(root);
  const locks = join(root, "locks");
  const locksIdentity = privateDirectory(locks);
  sameDirectory(root, rootIdentity);
  return { root, rootIdentity, locks, locksIdentity };
}

function assertPinnedRoot(pinned: PinnedOperationRoot): void {
  sameDirectory(pinned.root, pinned.rootIdentity);
  sameDirectory(pinned.locks, pinned.locksIdentity);
}
function operationDirectory(operationId: string, env: NodeJS.ProcessEnv): string {
  if (!UUID.test(operationId)) fail("INVALID_OPERATION_ID", "operation id is invalid");
  return join(clientOperationRoot(env), operationId.toLowerCase());
}
function verifyInsideRoot(path: string, env: NodeJS.ProcessEnv): void {
  const root = clientOperationRoot(env);
  const inside = relative(root, resolve(path));
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`)) fail("INSECURE_PATH", "operation path is outside the operation root");
  privateDirectory(root);
}
function manifestPath(operationId: string, env: NodeJS.ProcessEnv): string {
  return join(operationDirectory(operationId, env), "manifest.json");
}
function validateArtifact(value: unknown): ClientOperationArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  const artifact = value as Record<string, unknown>;
  const name = safeText(artifact.name, "artifact name", 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  if (!Number.isSafeInteger(artifact.bytes) || Number(artifact.bytes) < 0
    || Number(artifact.bytes) > MAX_SNAPSHOT_BYTES
    || typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
    fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  }
  return { name, bytes: Number(artifact.bytes), sha256: artifact.sha256 };
}
function validateStep(value: unknown, index: number): ClientOperationStep {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  const step = value as Record<string, unknown>;
  const targets: ClientOperationTargetKind[] = ["registration", "backend", "metadata"];
  const states: ClientOperationStepState[] = ["pending", "intent-recorded", "observed-applied"];
  const locator = safeText(step.locator, "step locator", 512);
  const snapshotArtifact = safeText(step.snapshotArtifact, "snapshot artifact", 80);
  const digest = (item: unknown): item is string => typeof item === "string" && /^[0-9a-f]{64}$/.test(item);
  const timestamp = (item: unknown): item is string | null => item === null
    || (typeof item === "string" && Number.isFinite(Date.parse(item)));
  if (step.index !== index || !targets.includes(step.target as ClientOperationTargetKind)
    || !states.includes(step.state as ClientOperationStepState)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(snapshotArtifact) || snapshotArtifact.includes("..")
    || !digest(step.expectedBeforeSha256) || !digest(step.expectedAfterSha256)
    || !timestamp(step.intentRecordedAt) || !timestamp(step.observedAppliedAt)
    || (step.state === "pending" && (step.intentRecordedAt !== null || step.observedAppliedAt !== null))
    || (step.state === "intent-recorded" && (step.intentRecordedAt === null || step.observedAppliedAt !== null))
    || (step.state === "observed-applied" && (step.intentRecordedAt === null || step.observedAppliedAt === null))) {
    fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  }
  return {
    index, target: step.target as ClientOperationTargetKind, locator, snapshotArtifact,
    expectedBeforeSha256: step.expectedBeforeSha256, expectedAfterSha256: step.expectedAfterSha256,
    state: step.state as ClientOperationStepState,
    intentRecordedAt: step.intentRecordedAt as string | null,
    observedAppliedAt: step.observedAppliedAt as string | null,
  };
}
export function validateClientOperation(value: unknown): ClientOperationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  const file = value as Record<string, unknown>;
  if (file.schema !== CLIENT_OPERATION_SCHEMA || file.version !== CLIENT_OPERATION_VERSION
    || !UUID.test(String(file.operationId)) || !OPERATIONS.includes(file.operation as ClientOperationKind)
    || !RUNTIMES.includes(file.runtime as InstallableRuntime) || !STATES.includes(file.state as ClientOperationState)
    || !Number.isSafeInteger(file.revision) || Number(file.revision) < 0
    || !Array.isArray(file.artifacts) || file.artifacts.length > MAX_OPERATION_ARTIFACTS
    || !Array.isArray(file.steps) || file.steps.length === 0
    || file.steps.length > MAX_OPERATION_STEPS) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  const createdAt = safeText(file.createdAt, "createdAt", 64);
  const updatedAt = safeText(file.updatedAt, "updatedAt", 64);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  const artifacts = file.artifacts.map(validateArtifact);
  const steps = file.steps.map(validateStep);
  const firstIncomplete = steps.findIndex((step) => step.state !== "observed-applied");
  const tail = firstIncomplete < 0 ? [] : steps.slice(firstIncomplete + 1);
  const artifactNames = artifacts.map((artifact) => artifact.name);
  const stepArtifacts = steps.map((step) => step.snapshotArtifact);
  const artifactsValid = new Set(artifactNames).size === artifactNames.length
    && artifacts.every((artifact) => steps.some((step) => step.snapshotArtifact === artifact.name
      && step.expectedBeforeSha256 === artifact.sha256));
  const completeSnapshots = artifactsValid
    && artifactNames.length === stepArtifacts.length
    && new Set(stepArtifacts).size === stepArtifacts.length;
  const allPending = steps.every((step) => step.state === "pending");
  const allApplied = steps.every((step) => step.state === "observed-applied");
  const hasProgress = steps.some((step) => step.state !== "pending");
  const stateConsistent = file.state === "prepared"
    ? allPending
    : file.state === "snapshotted"
      ? allPending && completeSnapshots
      : file.state === "in-progress"
        ? hasProgress && !allApplied && completeSnapshots
        : allApplied && completeSnapshots;
  if (tail.some((step) => step.state !== "pending")
    || steps.filter((step) => step.state === "intent-recorded").length > 1
    || new Set(stepArtifacts).size !== stepArtifacts.length
    || !artifactsValid
    || artifacts.reduce((total, artifact) => total + artifact.bytes, 0) > MAX_TOTAL_SNAPSHOT_BYTES
    || !stateConsistent) {
    fail("CORRUPT_OPERATION", "operation manifest is corrupt");
  }
  return {
    schema: CLIENT_OPERATION_SCHEMA, version: CLIENT_OPERATION_VERSION,
    operationId: String(file.operationId).toLowerCase(), operation: file.operation as ClientOperationKind,
    runtime: file.runtime as InstallableRuntime, instance: safeText(file.instance, "instance"),
    state: file.state as ClientOperationState, revision: Number(file.revision),
    host: safeText(file.host, "host", 255), createdAt, updatedAt,
    artifacts, steps,
  };
}
function serialize(manifest: ClientOperationManifest): string { return `${JSON.stringify(validateClientOperation(manifest), null, 2)}\n`; }
function hasCompleteSnapshots(manifest: ClientOperationManifest): boolean {
  return manifest.artifacts.length === manifest.steps.length
    && manifest.steps.every((step) => manifest.artifacts.some((artifact) => artifact.name === step.snapshotArtifact
      && artifact.sha256 === step.expectedBeforeSha256));
}
function publish(path: string, content: string | Buffer, filesystem: ClientOperationFilesystem = filesystemDefaults): void {
  const directory = dirname(path);
  const identity = privateDirectory(directory);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    securePrivatePath(temporary, "file");
    filesystem.hook("before-publish-rename", path);
    sameDirectory(directory, identity);
    filesystem.rename(temporary, path);
    filesystem.hook("after-publish-rename", path);
    verifyPrivatePathAccess(path, "file");
    sameDirectory(directory, identity);
    filesystem.hook("before-directory-sync", directory);
    filesystem.syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
    // Never follow a replaced directory while cleaning up. Residue inside the
    // original, now-unreachable directory is safer than deleting an external file.
    try { filesystem.hook("before-cleanup", temporary); sameDirectory(directory, identity); filesystem.remove(temporary, { force: true }); } catch {}
    if (error instanceof ClientOperationError) throw error;
    fail("DURABILITY_FAILED", "operation state could not be published durably");
  }
}

function publishNoReplace(path: string, content: string | Buffer, filesystem: ClientOperationFilesystem): void {
  const directory = dirname(path);
  const identity = privateDirectory(directory);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    securePrivatePath(temporary, "file");
    const temporaryIdentity = fstatSync(descriptor);
    filesystem.hook("before-publish-link", path);
    sameDirectory(directory, identity);
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
    sameDirectory(directory, identity);
    closeSync(descriptor); descriptor = undefined;
    filesystem.remove(temporary);
    filesystem.hook("before-directory-sync", directory);
    filesystem.syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
    try {
      filesystem.hook("before-cleanup", temporary);
      sameDirectory(directory, identity);
      filesystem.remove(temporary, { force: true });
    } catch {}
    if (error instanceof ClientOperationError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("AMBIGUOUS_OPERATION", "snapshot path already exists outside the durable manifest");
    }
    fail("DURABILITY_FAILED", "operation state could not be published durably");
  }
}

export function createClientOperation(input: {
  operationId?: string; operation: ClientOperationKind; runtime: InstallableRuntime; instance: string;
  steps: Array<Pick<ClientOperationStep, "target" | "locator" | "snapshotArtifact" | "expectedBeforeSha256" | "expectedAfterSha256">>;
}, env: NodeJS.ProcessEnv = process.env, filesystem: ClientOperationFilesystem = filesystemDefaults): ClientOperationManifest {
  const operationId = (input.operationId ?? randomUUID()).toLowerCase();
  if (!UUID.test(operationId) || !OPERATIONS.includes(input.operation) || !RUNTIMES.includes(input.runtime)) {
    fail("INVALID_OPERATION", "operation request is invalid");
  }
  const instance = safeText(input.instance.trim(), "instance");
  prepareRoot(env);
  const directory = operationDirectory(operationId, env);
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") fail("OPERATION_EXISTS", "operation already exists");
    fail("DURABILITY_FAILED", "operation could not be created");
  }
  securePrivatePath(directory, "directory");
  prepareDirectory(join(directory, "snapshots"));
  const now = new Date().toISOString();
  const manifest: ClientOperationManifest = {
    schema: CLIENT_OPERATION_SCHEMA, version: CLIENT_OPERATION_VERSION, operationId,
    operation: input.operation, runtime: input.runtime, instance, state: "prepared", revision: 0,
    host: hostname(), createdAt: now, updatedAt: now, artifacts: [],
    steps: input.steps.map((step, index) => ({ ...step, index, state: "pending" as const, intentRecordedAt: null, observedAppliedAt: null })),
  };
  try {
    filesystem.hook("after-snapshots-created", directory);
    publish(join(directory, "manifest.json"), serialize(manifest), filesystem);
    filesystem.syncDirectory(clientOperationRoot(env));
  }
  catch (error) {
    try {
      const rootIdentity = privateDirectory(clientOperationRoot(env));
      filesystem.hook("before-cleanup", directory);
      sameDirectory(clientOperationRoot(env), rootIdentity);
      filesystem.remove(directory, { recursive: true, force: true });
    } catch {}
    throw error;
  }
  return manifest;
}

export function readClientOperation(operationId: string, env: NodeJS.ProcessEnv = process.env): ClientOperationManifest {
  const path = manifestPath(operationId, env);
  verifyInsideRoot(path, env);
  const directory = dirname(path);
  const identity = privateDirectory(directory);
  try { verifyPrivatePathAccess(path, "file"); } catch { fail("CORRUPT_OPERATION", "operation manifest is unavailable or insecure"); }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const details = fstatSync(descriptor);
    if (!details.isFile() || details.size > MAX_MANIFEST_BYTES) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    let value: unknown;
    try { value = JSON.parse(readFileSync(descriptor, "utf8")); } catch { fail("CORRUPT_OPERATION", "operation manifest is corrupt"); }
    sameDirectory(directory, identity);
    const manifest = validateClientOperation(value);
    if (manifest.operationId !== operationId.toLowerCase()) fail("CORRUPT_OPERATION", "operation manifest is corrupt");
    return manifest;
  } finally { closeSync(descriptor); }
}

function lockName(runtime: InstallableRuntime, instance: string): string {
  const digest = createHash("sha256").update(`${runtime}\0${instance}`).digest("hex");
  return `${runtime}-${digest}.lock`;
}
export function acquireClientOperationLock(runtime: InstallableRuntime, instance: string, env: NodeJS.ProcessEnv = process.env): ClientOperationLock {
  if (!RUNTIMES.includes(runtime)) fail("INVALID_OPERATION", "client runtime is invalid");
  instance = safeText(instance.trim(), "instance");
  const root = prepareRoot(env);
  const directory = join(root, "locks");
  const identity = privateDirectory(directory);
  const lockPath = join(directory, lockName(runtime, instance));
  let descriptor: number;
  try { descriptor = openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") fail("CLIENT_LOCKED", "another operation holds the client lock");
    fail("LOCK_FAILED", "client lock could not be acquired");
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify({ schema: "agent-bridge.client-operation-lock", version: 1, runtime, instance, pid: process.pid, host: hostname(), createdAt: new Date().toISOString(), nonce: randomUUID() })}\n`);
    fsyncSync(descriptor); securePrivatePath(lockPath, "file"); sameDirectory(directory, identity); syncDirectory(directory);
    const details = fstatSync(descriptor);
    return { runtime, instance, lockPath, descriptor, device: details.dev, inode: details.ino, released: false };
  } catch {
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
  assertLock(lock);
  const directory = dirname(lock.lockPath); const identity = privateDirectory(directory);
  closeSync(lock.descriptor);
  const current = lstatSync(lock.lockPath);
  if (current.dev !== lock.device || current.ino !== lock.inode) fail("LOCK_REPLACED", "client lock changed before release");
  rmSync(lock.lockPath); lock.released = true;
  try { sameDirectory(directory, identity); syncDirectory(directory); return "released"; } catch { return "durability-unknown"; }
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
  const disk = readClientOperation(operationId, env);
  if (disk.runtime !== lock.runtime || disk.instance !== lock.instance) fail("LOCK_MISMATCH", "client lock does not cover this operation");
  if (disk.revision !== current.revision || disk.state !== current.state || disk.operationId !== current.operationId) fail("STALE_OPERATION", "stale operation transition refused");
  if (!TRANSITIONS.has(`${disk.state}->${state}`)) fail("ILLEGAL_TRANSITION", "operation state transition is not allowed");
  if (state === "snapshotted" && !hasCompleteSnapshots(disk)) {
    fail("MISSING_SNAPSHOT", "operation requires a durable snapshot for every ordered step");
  }
  const next = validateClientOperation({ ...disk, state, revision: disk.revision + 1, updatedAt: new Date().toISOString() });
  publish(manifestPath(operationId, env), serialize(next));
  return next;
}

function pendingStep(manifest: ClientOperationManifest): ClientOperationStep | undefined {
  return manifest.steps.find((step) => step.state !== "observed-applied");
}

function verifyOperationLock(operationId: string, current: ClientOperationManifest, lock: ClientOperationLock, env: NodeJS.ProcessEnv): ClientOperationManifest {
  assertLock(lock);
  const disk = readClientOperation(operationId, env);
  if (disk.runtime !== lock.runtime || disk.instance !== lock.instance) fail("LOCK_MISMATCH", "client lock does not cover this operation");
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
    || !disk.artifacts.some((artifact) => artifact.name === step.snapshotArtifact)) {
    fail("ILLEGAL_TRANSITION", "operation step intent is out of order or lacks its snapshot");
  }
  const now = new Date().toISOString();
  const steps = disk.steps.map((item) => item.index === stepIndex
    ? { ...item, state: "intent-recorded" as const, intentRecordedAt: now }
    : item);
  const next = validateClientOperation({ ...disk, state: "in-progress", revision: disk.revision + 1, updatedAt: now, steps });
  publish(manifestPath(operationId, env), serialize(next));
  return next;
}

/** Persist observed-applied only after the caller has verified the external digest. */
export function recordClientOperationStepApplied(
  operationId: string, current: ClientOperationManifest, stepIndex: number, observedSha256: string,
  lock: ClientOperationLock, env: NodeJS.ProcessEnv = process.env,
): ClientOperationManifest {
  const disk = verifyOperationLock(operationId, current, lock, env);
  const step = pendingStep(disk);
  if (disk.state !== "in-progress" || !step || step.index !== stepIndex || step.state !== "intent-recorded"
    || observedSha256 !== step.expectedAfterSha256) fail("AMBIGUOUS_OPERATION", "operation step after-state was not verified");
  const now = new Date().toISOString();
  const steps = disk.steps.map((item) => item.index === stepIndex
    ? { ...item, state: "observed-applied" as const, observedAppliedAt: now }
    : item);
  const state: ClientOperationState = steps.every((item) => item.state === "observed-applied") ? "committed" : "in-progress";
  const next = validateClientOperation({ ...disk, state, revision: disk.revision + 1, updatedAt: now, steps });
  publish(manifestPath(operationId, env), serialize(next));
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
  name = safeText(name, "snapshot name", 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) fail("INVALID_SNAPSHOT", "snapshot name is invalid");
  const disk = readClientOperation(operationId, env);
  if (disk.runtime !== lock.runtime || disk.instance !== lock.instance) fail("LOCK_MISMATCH", "client lock does not cover this operation");
  const step = disk.steps.find((item) => item.snapshotArtifact === name);
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
  privateDirectory(snapshotDirectory);
  publishNoReplace(join(snapshotDirectory, name), buffer, filesystem);
  const artifact = { name, bytes: buffer.byteLength, sha256 };
  const next = validateClientOperation({ ...disk, revision: disk.revision + 1, updatedAt: new Date().toISOString(), artifacts: [...disk.artifacts, artifact] });
  try { publish(manifestPath(operationId, env), serialize(next), filesystem); }
  catch (error) { fail("AMBIGUOUS_OPERATION", "snapshot publication left ambiguous operation state"); }
  return next;
}

function artifactsMatch(manifest: ClientOperationManifest, env: NodeJS.ProcessEnv, filesystem: ClientOperationFilesystem): boolean {
  const directory = join(operationDirectory(manifest.operationId, env), "snapshots");
  try {
    const identity = privateDirectory(directory);
    const names = readdirSync(directory).sort();
    filesystem.hook("after-snapshot-directory-read", directory);
    sameDirectory(directory, identity);
    if (names.join("\0") !== manifest.artifacts.map((item) => item.name).sort().join("\0")) return false;
    return manifest.artifacts.every((artifact) => {
      sameDirectory(directory, identity);
      const path = join(directory, artifact.name); verifyPrivatePathAccess(path, "file");
      filesystem.hook("before-snapshot-file-open", path);
      sameDirectory(directory, identity);
      const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const details = fstatSync(descriptor);
        if (!details.isFile() || details.size !== artifact.bytes || details.size > MAX_SNAPSHOT_BYTES) return false;
        const matches = createHash("sha256").update(readFileSync(descriptor)).digest("hex") === artifact.sha256;
        sameDirectory(directory, identity);
        return matches;
      } finally { closeSync(descriptor); }
    });
  } catch { return false; }
}
export function inspectClientOperation(operationId: string, env: NodeJS.ProcessEnv = process.env, filesystem: ClientOperationFilesystem = filesystemDefaults): ClientOperationSummary {
  try {
    const manifest = readClientOperation(operationId, env);
    const intact = artifactsMatch(manifest, env, filesystem);
    const pending = pendingStep(manifest);
    const ambiguous = pending?.state === "intent-recorded";
    return {
      schemaVersion: 1, operationId: manifest.operationId, operation: manifest.operation,
      runtime: manifest.runtime, instance: manifest.instance,
      state: intact ? manifest.state : "corrupt", revision: manifest.revision,
      createdAt: manifest.createdAt, updatedAt: manifest.updatedAt,
      artifacts: intact ? manifest.artifacts : [], pendingStep: intact ? (pending?.index ?? null) : null, recoverable: intact && ambiguous,
      reason: !intact ? "operation artifacts do not match the durable manifest"
        : ambiguous ? `operation stopped at ordered step ${pending.index} and requires external-state classification`
          : "operation state is internally consistent",
    };
  } catch (error) {
    if (!(error instanceof ClientOperationError) || error.code === "INVALID_OPERATION_ID") throw error;
    return { schemaVersion: 1, operationId: operationId.toLowerCase(), operation: null, runtime: null, instance: null, state: "corrupt", revision: null, createdAt: null, updatedAt: null, artifacts: [], pendingStep: null, recoverable: false, reason: "operation state is corrupt or insecure" };
  }
}
export function reconcileClientOperation(operationId: string, env: NodeJS.ProcessEnv = process.env): ClientOperationSummary {
  const summary = inspectClientOperation(operationId, env);
  if (summary.state === "corrupt") fail("CORRUPT_OPERATION", "operation state cannot be safely reconciled");
  if (summary.recoverable) fail("AMBIGUOUS_OPERATION", "operation requires external-state classification at its pending step");
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
