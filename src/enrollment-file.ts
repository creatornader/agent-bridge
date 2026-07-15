import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { securePrivatePath, verifyPrivatePathAccess } from "./private-path.js";

export const ENROLLMENT_SCHEMA = "agent-bridge.enrollment";
export const ENROLLMENT_VERSION = 1;
export type EnrollmentState = "pending" | "ready" | "consuming" | "consumed";
export type EnrollmentOperation = "provision" | "rotate";

export interface EnrollmentInput {
  gatewayUrl: string;
  workspaceId: string;
  principal: string;
  runtime: "codex" | "claude-code" | "claude-desktop";
  instance: string;
  credentialId: string | null;
  workspaceName: string | null;
  displayName: string | null;
  runtimeType: string;
  label: string | null;
  scopeSetName: string;
  expiresAt: string | null;
  graceUntil: string | null;
  invalidateImmediately: boolean;
}

export interface EnrollmentResult {
  workspaceId: string;
  principal: string;
  agentId: string | null;
  credentialId: string;
  replayed: boolean;
}

export interface EnrollmentFile {
  schema: typeof ENROLLMENT_SCHEMA;
  version: typeof ENROLLMENT_VERSION;
  provider: "gateway";
  revision: number;
  state: EnrollmentState;
  operation: EnrollmentOperation;
  requestId: string;
  createdAt: string;
  completedAt: string | null;
  input: EnrollmentInput;
  token: string | null;
  result: EnrollmentResult | null;
}

export interface EnrollmentLock {
  readonly enrollmentPath: string;
  readonly lockPath: string;
  readonly descriptor: number;
  readonly device: number;
  readonly inode: number;
  readonly nonce: string;
  released: boolean;
}

export interface EnrollmentDurabilityDependencies {
  syncDirectory(path: string): void;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 128): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(label + " is invalid");
  }
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function canonicalTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  const selected = text(value, label, 64);
  const match = RFC3339.exec(selected);
  if (!match) throw new Error(label + " must be RFC3339 with a timezone");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    fraction = "", zone, sign, offsetHourText = "0", offsetMinuteText = "0"] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(fraction.padEnd(3, "0"));
  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error(label + " is invalid");
  }
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, millisecond);
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1
    || wall.getUTCDate() !== day || wall.getUTCHours() !== hour
    || wall.getUTCMinutes() !== minute || wall.getUTCSeconds() !== second
    || wall.getUTCMilliseconds() !== millisecond) {
    throw new Error(label + " is invalid");
  }
  const direction = zone === "Z" ? 0 : sign === "+" ? 1 : -1;
  const instant = new Date(wall.getTime() - direction * (offsetHour * 60 + offsetMinute) * 60_000);
  if (!Number.isFinite(instant.getTime())) throw new Error(label + " is invalid");
  return instant.toISOString();
}

export function canonicalGatewayUrl(value: unknown, label: string): string {
  const selected = text(value, label, 2048);
  let parsed: URL;
  try { parsed = new URL(selected); } catch { throw new Error(label + " is invalid"); }
  if (parsed.username || parsed.password) throw new Error(label + " cannot contain credentials");
  if (parsed.hash) throw new Error(label + " cannot contain a fragment");
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(label + " must use HTTPS, or HTTP on an explicit loopback host");
  }
  return parsed.toString();
}

function uuid(value: unknown, label: string): string {
  const selected = text(value, label, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selected)) {
    throw new Error(label + " is invalid");
  }
  return selected;
}

function runtime(value: unknown): EnrollmentInput["runtime"] {
  if (value !== "codex" && value !== "claude-code" && value !== "claude-desktop") {
    throw new Error("enrollment runtime is invalid");
  }
  return value;
}

function validateInput(value: unknown, operation: EnrollmentOperation): EnrollmentInput {
  const input = object(value, "enrollment input");
  const gatewayUrl = canonicalGatewayUrl(input.gatewayUrl, "enrollment gatewayUrl");
  const credentialId = input.credentialId === null ? null : uuid(input.credentialId, "enrollment credentialId");
  const workspaceName = nullableText(input.workspaceName, "enrollment workspaceName");
  const graceUntil = canonicalTimestamp(input.graceUntil, "enrollment graceUntil");
  const invalidateImmediately = input.invalidateImmediately;
  if (typeof invalidateImmediately !== "boolean") throw new Error("enrollment invalidateImmediately is invalid");
  if (operation === "provision" && (credentialId !== null || workspaceName === null || graceUntil !== null || invalidateImmediately)) {
    throw new Error("provision enrollment input is invalid");
  }
  if (operation === "rotate" && (credentialId === null || workspaceName !== null
    || (graceUntil === null) === !invalidateImmediately)) {
    throw new Error("rotation must choose graceUntil or invalidateImmediately");
  }
  return {
    gatewayUrl,
    workspaceId: text(input.workspaceId, "enrollment workspaceId"),
    principal: text(input.principal, "enrollment principal"),
    runtime: runtime(input.runtime),
    instance: text(input.instance, "enrollment instance"),
    credentialId,
    workspaceName,
    displayName: nullableText(input.displayName, "enrollment displayName"),
    runtimeType: text(input.runtimeType, "enrollment runtimeType"),
    label: nullableText(input.label, "enrollment label"),
    scopeSetName: text(input.scopeSetName, "enrollment scopeSetName"),
    expiresAt: canonicalTimestamp(input.expiresAt, "enrollment expiresAt"),
    graceUntil,
    invalidateImmediately,
  };
}

function validateResult(value: unknown, input: EnrollmentInput): EnrollmentResult | null {
  if (value === null) return null;
  const result = object(value, "enrollment result");
  if (typeof result.replayed !== "boolean") throw new Error("enrollment result replayed is invalid");
  const validated = {
    workspaceId: text(result.workspaceId, "enrollment result workspaceId"),
    principal: text(result.principal, "enrollment result principal"),
    agentId: result.agentId === null ? null : uuid(result.agentId, "enrollment result agentId"),
    credentialId: uuid(result.credentialId, "enrollment result credentialId"),
    replayed: result.replayed,
  };
  if (validated.workspaceId !== input.workspaceId || validated.principal !== input.principal) {
    throw new Error("enrollment result does not match its workspace and principal");
  }
  return validated;
}

export function enrollmentTokenHash(enrollment: Pick<EnrollmentFile, "token">): string {
  if (!enrollment.token) throw new Error("enrollment no longer contains a credential");
  return createHash("sha256").update(enrollment.token, "utf8").digest("hex");
}

export function validateEnrollmentFile(value: unknown): EnrollmentFile {
  const file = object(value, "enrollment file");
  if (file.schema !== ENROLLMENT_SCHEMA || file.version !== ENROLLMENT_VERSION) {
    throw new Error("unsupported enrollment schema or version");
  }
  if (file.provider !== "gateway") throw new Error("enrollment provider must be gateway");
  if (!["pending", "ready", "consuming", "consumed"].includes(String(file.state))) {
    throw new Error("enrollment state is invalid");
  }
  if (file.operation !== "provision" && file.operation !== "rotate") {
    throw new Error("enrollment operation is invalid");
  }
  const state = file.state as EnrollmentState;
  if (!Number.isSafeInteger(file.revision) || Number(file.revision) < 0) {
    throw new Error("enrollment revision is invalid");
  }
  const input = validateInput(file.input, file.operation);
  const token = file.token === null ? null : text(file.token, "enrollment token", 4096);
  const result = validateResult(file.result, input);
  const completedAt = canonicalTimestamp(file.completedAt, "enrollment completedAt");
  if (state === "pending" && (result !== null || completedAt !== null || token === null)) {
    throw new Error("pending enrollment state is invalid");
  }
  if ((state === "ready" || state === "consuming") && (result === null || completedAt === null || token === null)) {
    throw new Error(state + " enrollment state is invalid");
  }
  if (state === "consumed" && (result === null || completedAt === null || token !== null)) {
    throw new Error("consumed enrollment state is invalid");
  }
  return {
    schema: ENROLLMENT_SCHEMA,
    version: ENROLLMENT_VERSION,
    provider: "gateway",
    revision: Number(file.revision),
    state,
    operation: file.operation,
    requestId: uuid(file.requestId, "enrollment requestId"),
    createdAt: (() => {
      const createdAt = canonicalTimestamp(file.createdAt, "enrollment createdAt");
      if (createdAt === null) throw new Error("enrollment createdAt is invalid");
      return createdAt;
    })(),
    completedAt,
    input,
    token,
    result,
  };
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

const durabilityDefaults: EnrollmentDurabilityDependencies = { syncDirectory };

function prepareDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  securePrivatePath(path, "directory");
}

export function enrollmentRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_BRIDGE_ENROLLMENT_DIR) return resolve(env.AGENT_BRIDGE_ENROLLMENT_DIR);
  const home = realpathSync(env.HOME ?? homedir());
  return join(home, ".agent-bridge", "enrollments");
}

function rejectSymlinkComponents(path: string): void {
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("enrollment paths cannot contain symbolic links");
    }
  }
}

interface DirectoryIdentity { device: number; inode: number }

function verifyPrivateDirectory(path: string): DirectoryIdentity {
  rejectSymlinkComponents(path);
  const details = lstatSync(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("enrollment directory must be a real directory");
  }
  verifyPrivatePathAccess(path, "directory");
  return { device: details.dev, inode: details.ino };
}

function sameDirectory(path: string, expected: DirectoryIdentity): void {
  const actual = verifyPrivateDirectory(path);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error("enrollment directory changed during the operation");
  }
}

function verifyPrivatePath(root: string, directory: string): void {
  verifyPrivateDirectory(root);
  const inside = relative(root, directory);
  if (!inside) return;
  let current = root;
  for (const component of inside.split(sep).filter(Boolean)) {
    current = join(current, component);
    verifyPrivateDirectory(current);
  }
}

function prepareEnrollmentRoot(env: NodeJS.ProcessEnv): string {
  const root = enrollmentRoot(env);
  rejectSymlinkComponents(dirname(root));
  prepareDirectory(root);
  verifyPrivateDirectory(root);
  return root;
}

export function assertEnrollmentPath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = enrollmentRoot(env);
  const selected = resolve(path);
  const inside = relative(root, selected);
  if (!inside || inside.startsWith(".." + sep) || inside === ".." || inside.includes(sep + ".." + sep)) {
    throw new Error("enrollment file must be inside the configured enrollment directory");
  }
  rejectSymlinkComponents(root);
  rejectSymlinkComponents(dirname(selected));
  if (existsSync(root) && existsSync(dirname(selected))) {
    verifyPrivatePath(root, dirname(selected));
  }
  return selected;
}

function serialized(value: EnrollmentFile): string {
  return JSON.stringify(validateEnrollmentFile(value), null, 2) + "\n";
}

export function defaultEnrollmentPath(requestId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(enrollmentRoot(env), requestId + ".json");
}

export function createPendingEnrollment(
  path: string,
  enrollment: EnrollmentFile,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (enrollment.state !== "pending") throw new Error("new enrollment must be pending");
  if (enrollment.revision !== 0) throw new Error("new enrollment revision must be zero");
  path = assertEnrollmentPath(path, env);
  prepareEnrollmentRoot(env);
  path = assertEnrollmentPath(path, env);
  const directory = dirname(path);
  prepareDirectory(directory);
  verifyPrivatePath(enrollmentRoot(env), directory);
  const directoryIdentity = verifyPrivateDirectory(directory);
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, serialized(enrollment), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    securePrivatePath(path, "file");
    sameDirectory(directory, directoryIdentity);
    syncDirectory(directory);
  } catch (error) {
    try { closeSync(descriptor); } catch {}
    rmSync(path, { force: true });
    throw error;
  }
}

function readEnrollmentUnlocked(path: string, env: NodeJS.ProcessEnv): EnrollmentFile {
  path = assertEnrollmentPath(path, env);
  const directory = dirname(path);
  verifyPrivatePath(enrollmentRoot(env), directory);
  const directoryIdentity = verifyPrivateDirectory(directory);
  verifyPrivatePathAccess(path, "file");
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const details = fstatSync(descriptor);
    if (!details.isFile()) throw new Error("enrollment path must be a regular file, not a symbolic link");
    if (process.platform !== "win32") {
      if ((details.mode & 0o077) !== 0) throw new Error("enrollment file permissions must be 0600");
      if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
        throw new Error("enrollment file must be owned by the current user");
      }
    }
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(descriptor, "utf8")); }
    catch { throw new Error("enrollment file is not valid JSON"); }
    sameDirectory(directory, directoryIdentity);
    return validateEnrollmentFile(parsed);
  } finally {
    closeSync(descriptor);
  }
}

export function readEnrollment(path: string, env: NodeJS.ProcessEnv = process.env): EnrollmentFile {
  return readEnrollmentUnlocked(path, env);
}

function assertActiveLock(lock: EnrollmentLock, enrollmentPath: string): void {
  if (lock.released || lock.enrollmentPath !== enrollmentPath) {
    throw new Error("enrollment lock does not cover this file");
  }
  const open = fstatSync(lock.descriptor);
  const current = lstatSync(lock.lockPath);
  if (open.dev !== lock.device || open.ino !== lock.inode
    || current.dev !== lock.device || current.ino !== lock.inode || current.isSymbolicLink()) {
    throw new Error("enrollment lock changed during the operation");
  }
}

export function acquireEnrollmentLock(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): EnrollmentLock {
  prepareEnrollmentRoot(env);
  path = assertEnrollmentPath(path, env);
  const directory = dirname(path);
  prepareDirectory(directory);
  verifyPrivatePath(enrollmentRoot(env), directory);
  const directoryIdentity = verifyPrivateDirectory(directory);
  const lockPath = path + ".lock";
  const descriptor = openSync(lockPath, "wx", 0o600);
  const nonce = randomUUID();
  try {
    writeFileSync(descriptor, JSON.stringify({
      schema: "agent-bridge.enrollment-lock",
      version: 1,
      enrollmentPath: path,
      pid: process.pid,
      host: hostname(),
      createdAt: new Date().toISOString(),
      nonce,
    }) + "\n", "utf8");
    fsyncSync(descriptor);
    securePrivatePath(lockPath, "file");
    sameDirectory(directory, directoryIdentity);
    syncDirectory(directory);
    const details = fstatSync(descriptor);
    return {
      enrollmentPath: path,
      lockPath,
      descriptor,
      device: details.dev,
      inode: details.ino,
      nonce,
      released: false,
    };
  } catch (error) {
    try { closeSync(descriptor); } catch {}
    rmSync(lockPath, { force: true });
    throw error;
  }
}

export function releaseEnrollmentLock(
  lock: EnrollmentLock,
  dependencies: EnrollmentDurabilityDependencies = durabilityDefaults,
): "released" | "durability-unknown" {
  assertActiveLock(lock, lock.enrollmentPath);
  const directory = dirname(lock.lockPath);
  const directoryIdentity = verifyPrivateDirectory(directory);
  closeSync(lock.descriptor);
  const current = lstatSync(lock.lockPath);
  if (current.dev !== lock.device || current.ino !== lock.inode) {
    throw new Error("enrollment lock changed before release");
  }
  rmSync(lock.lockPath);
  lock.released = true;
  try {
    sameDirectory(directory, directoryIdentity);
    dependencies.syncDirectory(directory);
  } catch {
    return "durability-unknown";
  }
  return "released";
}

export function recoverEnrollmentLock(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): void {
  path = assertEnrollmentPath(path, env);
  const lockPath = path + ".lock";
  verifyPrivatePathAccess(lockPath, "file");
  const descriptor = openSync(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const details = fstatSync(descriptor);
    if (!details.isFile()) throw new Error("enrollment lock is not a regular file");
    if (process.platform !== "win32") {
      if ((details.mode & 0o077) !== 0) throw new Error("enrollment lock permissions must be 0600");
      if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
        throw new Error("enrollment lock must be owned by the current user");
      }
    }
    let metadata: Record<string, unknown>;
    try { metadata = object(JSON.parse(readFileSync(descriptor, "utf8")), "enrollment lock"); }
    catch { throw new Error("enrollment lock metadata is invalid"); }
    if (metadata.schema !== "agent-bridge.enrollment-lock" || metadata.version !== 1
      || metadata.enrollmentPath !== path || metadata.host !== hostname()
      || typeof metadata.pid !== "number" || !Number.isSafeInteger(metadata.pid)
      || typeof metadata.createdAt !== "string" || !RFC3339.test(metadata.createdAt)) {
      throw new Error("enrollment lock metadata is invalid");
    }
    const age = now - new Date(metadata.createdAt).getTime();
    if (age < 60_000) throw new Error("enrollment lock is too recent to recover");
    try {
      process.kill(metadata.pid, 0);
      throw new Error("enrollment lock owner is still running");
    } catch (error) {
      if (error instanceof Error && error.message === "enrollment lock owner is still running") throw error;
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
        throw new Error("cannot prove that the enrollment lock owner has stopped");
      }
    }
    const current = lstatSync(lockPath);
    if (current.dev !== details.dev || current.ino !== details.ino) {
      throw new Error("enrollment lock changed during recovery");
    }
  } finally {
    closeSync(descriptor);
  }
  rmSync(lockPath);
  syncDirectory(dirname(lockPath));
}

export function deleteEnrollmentFile(
  path: string,
  lock: EnrollmentLock,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: EnrollmentDurabilityDependencies = durabilityDefaults,
): "deleted-and-durable" | "deleted-durability-unknown" | "missing" {
  path = assertEnrollmentPath(path, env);
  assertActiveLock(lock, path);
  let current: EnrollmentFile;
  try {
    current = readEnrollmentUnlocked(path, env);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  if (current.state !== "consumed" || current.token !== null) {
    throw new Error("only a consumed enrollment can be deleted");
  }
  const directory = dirname(path);
  const directoryIdentity = verifyPrivateDirectory(directory);
  try {
    rmSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  try {
    sameDirectory(directory, directoryIdentity);
    dependencies.syncDirectory(directory);
  } catch {
    return "deleted-durability-unknown";
  }
  return "deleted-and-durable";
}

export function transitionEnrollment(
  path: string,
  current: EnrollmentFile,
  state: EnrollmentState,
  changes: Partial<Pick<EnrollmentFile, "completedAt" | "result" | "token">> = {},
  env: NodeJS.ProcessEnv = process.env,
  heldLock?: EnrollmentLock,
): EnrollmentFile {
  path = assertEnrollmentPath(path, env);
  const lock = heldLock ?? acquireEnrollmentLock(path, env);
  try {
    assertActiveLock(lock, path);
    const onDisk = readEnrollmentUnlocked(path, env);
    if (onDisk.revision !== current.revision || onDisk.state !== current.state
      || onDisk.requestId !== current.requestId || onDisk.operation !== current.operation
      || onDisk.token !== current.token) {
      throw new Error("stale enrollment transition refused");
    }
    const transition = current.state + "->" + state;
    if (!new Set([
      "pending->ready",
      "ready->consuming",
      "consuming->ready",
      "consuming->consumed",
    ]).has(transition)) {
      throw new Error("illegal enrollment state transition: " + transition);
    }
    const next = validateEnrollmentFile({
      ...onDisk,
      ...changes,
      state,
      revision: onDisk.revision + 1,
    });
    const directory = dirname(path);
    const directoryIdentity = verifyPrivateDirectory(directory);
    const temporary = path + "." + process.pid + "." + randomUUID() + ".tmp";
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, serialized(next), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      securePrivatePath(temporary, "file");
      sameDirectory(directory, directoryIdentity);
      renameSync(temporary, path);
      verifyPrivatePathAccess(path, "file");
      sameDirectory(directory, directoryIdentity);
      syncDirectory(directory);
      return next;
    } catch (error) {
      try { closeSync(descriptor); } catch {}
      rmSync(temporary, { force: true });
      throw error;
    }
  } finally {
    if (!heldLock) releaseEnrollmentLock(lock);
  }
}
