import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { HttpBridgeStore } from "./http-bridge-store.js";
import { edgeScopeKey, SQLiteEdgeStore } from "./sqlite-edge-store.js";
import {
  stagedGatewayBackendPaths,
  writeStagedGatewayBackendConfig,
  type InstallableRuntime,
} from "./client-installer.js";
import {
  beginClientOperation,
  classifyClientOperationRestart,
  completeClientOperationCleanup,
  hasClientOperationLock,
  readClientOperation,
  recordClientOperationStepApplied,
  recordClientOperationStepIntent,
  recoverClientOperationLock,
  releaseClientOperationLock,
  resumeClientOperation,
  transitionClientOperation,
  writeClientOperationSnapshot,
  type ClientMigrationStageRequest,
  type ClientOperationLock,
  type ClientOperationManifest,
} from "./client-operation.js";
import {
  loadManagedClientMetadata,
  observeManagedRegistration,
  type ClientLifecycleExecutor,
  type ManagedClientMetadata,
} from "./client-lifecycle.js";
import {
  acquireEnrollmentLock,
  deleteEnrollmentFile,
  readEnrollment,
  recoverEnrollmentLock,
  releaseEnrollmentLock,
  transitionEnrollment,
  type EnrollmentFile,
  type EnrollmentLock,
} from "./enrollment-file.js";
import { securePrivatePath, verifyPrivatePathAccess } from "./private-path.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BACKEND_KEYS = [
  "AGENT_BRIDGE_PROVIDER",
  "AGENT_BRIDGE_WORKSPACE",
  "AGENT_BRIDGE_URL",
  "AGENT_BRIDGE_TOKEN",
  "AGENT_BRIDGE_EDGE_DB",
  "AGENT_BRIDGE_CREDENTIAL_ID",
  "AGENT_BRIDGE_PRINCIPAL",
  "AGENT_BRIDGE_CLIENT_INSTANCE",
] as const;
const MIN_PREDECESSOR_GRACE_MS = 5 * 60_000;

type BackendKey = (typeof BACKEND_KEYS)[number];
type BackendValues = Record<BackendKey, string>;

interface BackendProjection {
  provider: "gateway";
  workspace: string;
  endpointSha256: string;
  edgeDatabasePath: string;
  credentialId: string;
  principal: string;
  instance: string;
}

interface StageRecord {
  schema: "agent-bridge.client-migration-stage";
  version: 1;
  state: "staged";
  operationId: string;
  createdAt: string;
  runtime: InstallableRuntime;
  identity: string;
  instance: string;
  enrollmentRequestId: string;
  source: {
    backendConfigPath: string;
    edgeDatabasePath: string;
    scopeKey: string;
    endpointSha256: string;
    credentialId: string;
    graceUntil: string;
  };
  target: {
    backendConfigPath: string;
    edgeDatabasePath: string;
    endpointSha256: string;
    credentialId: string;
    workspace: string;
    principal: string;
  };
}

export interface ClientMigrationStagePlan {
  schemaVersion: 1;
  action: "migrate-stage";
  applied: boolean;
  operationId: string | null;
  runtime: InstallableRuntime;
  identity: string;
  instance: string;
  enrollmentFile: string;
  sourceBackendPath: string;
  sourceEdgeDatabasePath: string;
  sourceScopeKey: string;
  targetBackendPath: string | null;
  stageRecordPath: string | null;
  sourceEndpointSha256: string;
  targetEndpointSha256: string;
  successorCredentialId: string;
  enrollmentStatus: "ready" | "consumed-file-retained" | "consumed-file-missing" | "consumed-deletion-durability-unknown";
}

export interface ClientMigrationStageOptions {
  runtime: InstallableRuntime;
  identity: string;
  instance: string;
  enrollmentFile: string;
  apply?: boolean;
  recoverLock?: boolean;
  env?: NodeJS.ProcessEnv;
  execute?: ClientLifecycleExecutor;
  verifyTarget?: (input: {
    url: string;
    token: string;
    workspace: string;
    principal: string;
    instance: string;
  }) => Promise<void>;
  verifySource?: (input: {
    url: string;
    token: string;
    workspace: string;
    principal: string;
    instance: string;
  }) => Promise<void>;
  now?: () => Date;
}

export interface ResumeClientMigrationStageOptions {
  operationId: string;
  recoverLock?: boolean;
  env?: NodeJS.ProcessEnv;
  execute?: ClientLifecycleExecutor;
  verifyTarget?: ClientMigrationStageOptions["verifyTarget"];
  verifySource?: ClientMigrationStageOptions["verifySource"];
  now?: () => Date;
}

class ClientMigrationStageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ClientMigrationStageError";
  }
}

function fail(code: string, message: string): never {
  throw new ClientMigrationStageError(code, message);
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_STAGE", `${label} is invalid`);
  }
  return value;
}

function identity(value: unknown): string {
  const selected = text(value, "identity", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selected)) fail("INVALID_STAGE", "identity is invalid");
  return selected;
}

function uuid(value: unknown, label: string): string {
  const selected = text(value, label, 36).toLowerCase();
  if (!UUID.test(selected)) fail("INVALID_STAGE", `${label} is invalid`);
  return selected;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function endpointSha256(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { fail("INVALID_STAGE", "gateway endpoint is invalid"); }
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    fail("INVALID_STAGE", "gateway endpoint is invalid");
  }
  return createHash("sha256").update(parsed.toString().replace(/\/$/, ""), "utf8").digest("hex");
}

function stageAbsentProof(): Record<string, boolean> { return { exists: false }; }

function enrollmentProof(enrollment: EnrollmentFile): Record<string, unknown> {
  return {
    state: enrollment.state,
    operation: enrollment.operation,
    requestId: enrollment.requestId,
    credentialId: enrollment.result?.credentialId ?? null,
    inputCredentialId: enrollment.input.credentialId,
    workspaceId: enrollment.input.workspaceId,
    principal: enrollment.input.principal,
    runtime: enrollment.input.runtime,
    instance: enrollment.input.instance,
  };
}

function readPrivateText(path: string): string {
  verifyPrivatePathAccess(path, "file");
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) fail("UNSAFE_STAGE_PATH", "private stage file is not a regular file");
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const details = fstatSync(descriptor);
    if (!details.isFile() || details.dev !== before.dev || details.ino !== before.ino) {
      fail("UNSAFE_STAGE_PATH", "private stage file changed while reading");
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function parseBackendValues(path: string): BackendValues {
  const output: Partial<Record<BackendKey, string>> = {};
  for (const raw of readPrivateText(path).split(/\r?\n/u)) {
    if (!raw) continue;
    const separator = raw.indexOf("=");
    if (separator <= 0) fail("INVALID_BACKEND", "client backend config is invalid");
    const key = raw.slice(0, separator) as BackendKey;
    const value = raw.slice(separator + 1);
    if (!(BACKEND_KEYS as readonly string[]).includes(key) || key in output || !value || /[\r\n]/u.test(value)) {
      fail("INVALID_BACKEND", "client backend config is invalid");
    }
    output[key] = value;
  }
  if (Object.keys(output).sort().join(",") !== [...BACKEND_KEYS].sort().join(",")) {
    fail("INVALID_BACKEND", "client backend config has an unexpected binding");
  }
  return output as BackendValues;
}

function backendProjection(values: BackendValues): BackendProjection {
  if (values.AGENT_BRIDGE_PROVIDER !== "gateway") fail("INVALID_BACKEND", "client backend is not gateway-backed");
  const workspace = text(values.AGENT_BRIDGE_WORKSPACE, "workspace", 128);
  const edgeDatabasePath = text(values.AGENT_BRIDGE_EDGE_DB, "edge database path", 4096);
  if (edgeDatabasePath === ":memory:" || !isAbsolute(edgeDatabasePath) || resolve(edgeDatabasePath) !== edgeDatabasePath) {
    fail("INVALID_BACKEND", "gateway edge database path must be an absolute normalized file path");
  }
  const credentialId = uuid(values.AGENT_BRIDGE_CREDENTIAL_ID, "credential ID");
  const principal = identity(values.AGENT_BRIDGE_PRINCIPAL);
  const instance = text(values.AGENT_BRIDGE_CLIENT_INSTANCE, "instance", 128);
  return {
    provider: "gateway",
    workspace,
    endpointSha256: endpointSha256(values.AGENT_BRIDGE_URL),
    edgeDatabasePath,
    credentialId,
    principal,
    instance,
  };
}

function backendProof(path: string, expected?: BackendProjection): Record<string, unknown> {
  if (!existsSync(path)) return stageAbsentProof();
  const actual = backendProjection(parseBackendValues(path));
  if (expected && canonical(actual) !== canonical(expected)) {
    fail("STAGED_BACKEND_DRIFT", "staged backend no longer matches its verified target");
  }
  return { exists: true, backend: actual };
}

function stageRecordPaths(operationId: string, env: NodeJS.ProcessEnv): {
  backendConfigPath: string;
  edgeDatabasePath: string;
  stageRecordPath: string;
} {
  const paths = stagedGatewayBackendPaths(operationId, env);
  return {
    backendConfigPath: paths.backendConfigPath,
    edgeDatabasePath: paths.edgeDatabasePath,
    stageRecordPath: join(paths.directory, "stage.json"),
  };
}

function assertStagePath(path: string, operationId: string, env: NodeJS.ProcessEnv): void {
  const paths = stageRecordPaths(operationId, env);
  if (![paths.backendConfigPath, paths.stageRecordPath].includes(resolve(path))) {
    fail("UNSAFE_STAGE_PATH", "stage path is outside its operation directory");
  }
  const directory = dirname(paths.backendConfigPath);
  if (relative(directory, resolve(path)).startsWith("..")) fail("UNSAFE_STAGE_PATH", "stage path is outside its operation directory");
}

function assertStageTargetsAbsent(operationId: string, env: NodeJS.ProcessEnv): void {
  const paths = stageRecordPaths(operationId, env);
  for (const path of [paths.backendConfigPath, paths.stageRecordPath]) {
    if (!existsSync(path)) continue;
    assertStagePath(path, operationId, env);
    verifyPrivatePathAccess(path, "file");
    fail("AMBIGUOUS_OPERATION", "migration stage target already exists");
  }
}

function writeStageRecord(path: string, record: StageRecord, operationId: string, env: NodeJS.ProcessEnv): string {
  assertStagePath(path, operationId, env);
  const content = `${canonical(record)}\n`;
  const directory = dirname(path);
  const root = dirname(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  securePrivatePath(root, "directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  securePrivatePath(directory, "directory");
  if (existsSync(path)) verifyPrivatePathAccess(path, "file");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  securePrivatePath(temporary, "file");
  try {
    renameSync(temporary, path);
    verifyPrivatePathAccess(path, "file");
    if (process.platform !== "win32") {
      const directoryDescriptor = openSync(directory, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    }
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  return content;
}

function readStageRecord(path: string, operationId: string, env: NodeJS.ProcessEnv): string | undefined {
  assertStagePath(path, operationId, env);
  return existsSync(path) ? readPrivateText(path) : undefined;
}

function expectedStageRecord(
  operationId: string,
  runtime: InstallableRuntime,
  identityValue: string,
  instance: string,
  request: ClientMigrationStageRequest,
  target: BackendProjection,
  createdAt: string,
): StageRecord {
  return {
    schema: "agent-bridge.client-migration-stage",
    version: 1,
    state: "staged",
    operationId,
    createdAt,
    runtime,
    identity: identityValue,
    instance,
    enrollmentRequestId: request.enrollmentRequestId,
    source: {
      backendConfigPath: request.sourceBackendPath,
      edgeDatabasePath: request.sourceEdgeDatabasePath,
      scopeKey: request.sourceScopeKey,
      endpointSha256: request.sourceEndpointSha256,
      credentialId: request.predecessorCredentialId,
      graceUntil: request.predecessorGraceUntil,
    },
    target: {
      backendConfigPath: request.targetBackendPath,
      edgeDatabasePath: target.edgeDatabasePath,
      endpointSha256: request.targetEndpointSha256,
      credentialId: request.successorCredentialId,
      workspace: target.workspace,
      principal: target.principal,
    },
  };
}

function stageRecordContents(record: StageRecord): string {
  return `${canonical(record)}\n`;
}

function stageRecordProof(contents: string): Record<string, unknown> {
  return { exists: true, sha256: digest(contents) };
}

function missingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function enrollmentLockPath(path: string): string {
  return `${resolve(path)}.lock`;
}

/** A surviving enrollment lock is evidence of an interrupted owner. Never bypass it. */
function requireNoEnrollmentLock(path: string): void {
  const lockPath = enrollmentLockPath(path);
  if (!existsSync(lockPath)) return;
  verifyPrivatePathAccess(lockPath, "file");
  fail("ENROLLMENT_LOCKED", "rotation enrollment has an unfinished lock; use --recover-lock after proving it is stale");
}

function recoverEnrollmentLockIfPresent(path: string, env: NodeJS.ProcessEnv): void {
  if (existsSync(enrollmentLockPath(path))) recoverEnrollmentLock(path, env);
}

function checkMetadata(
  runtime: InstallableRuntime,
  identityValue: string,
  instance: string,
  execute: ClientLifecycleExecutor | undefined,
  env: NodeJS.ProcessEnv,
): ManagedClientMetadata {
  const metadata = loadManagedClientMetadata(runtime, instance, env);
  if (metadata.identity !== identityValue || metadata.instance !== instance || metadata.runtime !== runtime) {
    fail("MANAGED_CLIENT_DRIFT", "managed client identity does not match the requested migration");
  }
  const observed = observeManagedRegistration(metadata, execute, env);
  if (observed.state !== "exact") fail("MANAGED_CLIENT_DRIFT", "managed client registration is not exact");
  return metadata;
}

function checkEnrollment(
  enrollment: EnrollmentFile,
  runtime: InstallableRuntime,
  identityValue: string,
  instance: string,
  source: BackendProjection,
  minimumGraceMs = MIN_PREDECESSOR_GRACE_MS,
  now = new Date(),
): void {
  const graceUntil = enrollment.input.graceUntil;
  if (enrollment.operation !== "rotate" || enrollment.input.runtime !== runtime
    || enrollment.input.principal !== identityValue || enrollment.input.instance !== instance
    || enrollment.input.credentialId !== source.credentialId || enrollment.input.workspaceId !== source.workspace
    || enrollment.result === null || enrollment.result.credentialId === source.credentialId
    || enrollment.result.principal !== identityValue || enrollment.result.workspaceId !== enrollment.input.workspaceId
    || enrollment.input.invalidateImmediately || graceUntil === null
    || new Date(graceUntil).getTime() - now.getTime() <= minimumGraceMs) {
    fail("ENROLLMENT_MISMATCH", "rotation enrollment does not match the managed client");
  }
}

function makeRequest(
  operationId: string,
  metadata: ManagedClientMetadata,
  source: BackendProjection,
  enrollment: EnrollmentFile,
  enrollmentPath: string,
  env: NodeJS.ProcessEnv,
): ClientMigrationStageRequest {
  const paths = stageRecordPaths(operationId, env);
  const successorCredentialId = enrollment.result?.credentialId;
  if (!successorCredentialId) fail("ENROLLMENT_MISMATCH", "rotation enrollment has no successor credential");
  const targetEndpointSha256 = endpointSha256(enrollment.input.gatewayUrl);
  if (source.endpointSha256 === targetEndpointSha256) {
    fail("ENROLLMENT_MISMATCH", "rotation enrollment must use a different gateway endpoint");
  }
  return {
    kind: "migrate",
    identity: metadata.identity,
    enrollmentPath: resolve(enrollmentPath),
    enrollmentRequestId: enrollment.requestId,
    sourceBackendPath: metadata.backendConfigPath,
    sourceEdgeDatabasePath: source.edgeDatabasePath,
    sourceScopeKey: edgeScopeKey({
      endpoint: parseBackendValues(metadata.backendConfigPath).AGENT_BRIDGE_URL,
      principal: { workspace: source.workspace, agent: source.principal },
    }),
    targetBackendPath: paths.backendConfigPath,
    stageRecordPath: paths.stageRecordPath,
    predecessorGraceUntil: enrollment.input.graceUntil!,
    targetWorkspace: enrollment.input.workspaceId,
    sourceEndpointSha256: source.endpointSha256,
    targetEndpointSha256,
    predecessorCredentialId: source.credentialId,
    successorCredentialId,
  };
}

async function verifyGatewayBackend(
  values: BackendValues,
  projection: BackendProjection,
  verifier: ClientMigrationStageOptions["verifyTarget"] | ClientMigrationStageOptions["verifySource"],
): Promise<void> {
  if (verifier) {
    await verifier({
      url: values.AGENT_BRIDGE_URL,
      token: values.AGENT_BRIDGE_TOKEN,
      workspace: projection.workspace,
      principal: projection.principal,
      instance: projection.instance,
    });
    return;
  }
  const remote = new HttpBridgeStore({
    baseUrl: values.AGENT_BRIDGE_URL,
    token: values.AGENT_BRIDGE_TOKEN,
    principal: { workspace: projection.workspace, agent: projection.principal, instance: projection.instance },
  });
  try { await remote.initialize(); } finally { await remote.close?.(); }
}

async function verifySourceStage(
  values: BackendValues,
  source: BackendProjection,
  sourceScopeKey: string,
  verifier: ClientMigrationStageOptions["verifySource"],
): Promise<void> {
  const derivedScopeKey = edgeScopeKey({
    endpoint: values.AGENT_BRIDGE_URL,
    principal: { workspace: source.workspace, agent: source.principal },
  });
  if (derivedScopeKey !== sourceScopeKey) fail("MANAGED_CLIENT_DRIFT", "managed source edge scope changed during migration staging");
  await verifyGatewayBackend(values, source, verifier);
  const edge = new SQLiteEdgeStore(source.edgeDatabasePath, {
    endpoint: values.AGENT_BRIDGE_URL,
    principal: { workspace: source.workspace, agent: source.principal },
  });
  try {
    await edge.initialize();
    const gate = await edge.migrationGate();
    if (gate.state !== "active" || gate.scopeKey !== sourceScopeKey) {
      fail("SOURCE_EDGE_NOT_ACTIVE", "recorded source edge scope is not active for migration staging");
    }
  } finally {
    await edge.close();
  }
}

function targetValuesFromEnrollment(enrollment: EnrollmentFile, target: BackendProjection): BackendValues {
  if (!enrollment.token) fail("ENROLLMENT_MISMATCH", "rotation enrollment no longer contains a credential");
  return {
    AGENT_BRIDGE_PROVIDER: "gateway",
    AGENT_BRIDGE_WORKSPACE: target.workspace,
    AGENT_BRIDGE_URL: enrollment.input.gatewayUrl,
    AGENT_BRIDGE_TOKEN: enrollment.token,
    AGENT_BRIDGE_EDGE_DB: target.edgeDatabasePath,
    AGENT_BRIDGE_CREDENTIAL_ID: target.credentialId,
    AGENT_BRIDGE_PRINCIPAL: target.principal,
    AGENT_BRIDGE_CLIENT_INSTANCE: target.instance,
  };
}

async function verifyStagedTargetBeforeConsumption(
  request: ClientMigrationStageRequest,
  target: BackendProjection,
  recordContents: string,
  enrollment: EnrollmentFile,
  verifier: ClientMigrationStageOptions["verifyTarget"],
  operationId: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const values = parseBackendValues(request.targetBackendPath);
  backendProof(request.targetBackendPath, target);
  if (!enrollment.token || values.AGENT_BRIDGE_TOKEN !== enrollment.token) {
    fail("STAGED_BACKEND_DRIFT", "staged backend credential no longer matches the rotation enrollment");
  }
  await verifyGatewayBackend(values, target, verifier);
  if (readStageRecord(request.stageRecordPath, operationId, env) !== recordContents) {
    fail("STAGE_RECORD_DRIFT", "stage record no longer matches the verified target");
  }
}

function requireStageRequest(manifest: ClientOperationManifest): ClientMigrationStageRequest {
  if (manifest.version !== 5 || manifest.request?.kind !== "migrate"
    || !("identity" in manifest.request)) {
    fail("CORRUPT_OPERATION", "operation is not a staged client migration");
  }
  return manifest.request as ClientMigrationStageRequest;
}

function snapshotStageOperation(
  manifest: ClientOperationManifest,
  lock: ClientOperationLock,
  enrollment: EnrollmentFile,
  env: NodeJS.ProcessEnv,
): ClientOperationManifest {
  let current = manifest;
  const request = requireStageRequest(current);
  const backendBefore = backendProof(request.targetBackendPath);
  const recordBefore = readStageRecord(request.stageRecordPath, current.operationId, env) === undefined
    ? stageAbsentProof()
    : { exists: true };
  if (canonical(backendBefore) !== canonical(stageAbsentProof())
    || canonical(recordBefore) !== canonical(stageAbsentProof())) {
    fail("AMBIGUOUS_OPERATION", "migration stage targets must be absent before snapshots are recorded");
  }
  const before = [
    backendBefore,
    recordBefore,
    enrollmentProof(enrollment),
  ];
  for (const [index, proof] of before.entries()) {
    current = writeClientOperationSnapshot(current.operationId, current, current.steps[index]!.beforeArtifact,
      canonical(proof), lock, env);
  }
  return transitionClientOperation(current.operationId, current, "snapshotted", lock, env);
}

function assertPersistedManifest(current: ClientOperationManifest, env: NodeJS.ProcessEnv): void {
  if (canonical(readClientOperation(current.operationId, env)) !== canonical(current)) {
    fail("MANIFEST_DRIFT", "migration operation manifest changed before a staged write");
  }
}

function checkRequestAgainstCurrent(
  manifest: ClientOperationManifest,
  execute: ClientLifecycleExecutor | undefined,
  env: NodeJS.ProcessEnv,
  now: Date,
): { metadata: ManagedClientMetadata; source: BackendProjection; enrollment?: EnrollmentFile; target: BackendProjection } {
  const request = requireStageRequest(manifest);
  if (new Date(request.predecessorGraceUntil).getTime() <= now.getTime()) {
    fail("ENROLLMENT_MISMATCH", "rotation enrollment grace window has expired");
  }
  const metadata = checkMetadata(manifest.runtime, request.identity, manifest.instance, execute, env);
  if (resolve(metadata.backendConfigPath) !== request.sourceBackendPath) {
    fail("MANAGED_CLIENT_DRIFT", "managed backend path changed during migration staging");
  }
  const sourceValues = parseBackendValues(request.sourceBackendPath);
  const source = backendProjection(sourceValues);
  if (source.endpointSha256 !== request.sourceEndpointSha256 || source.credentialId !== request.predecessorCredentialId
    || source.edgeDatabasePath !== request.sourceEdgeDatabasePath
    || edgeScopeKey({ endpoint: sourceValues.AGENT_BRIDGE_URL, principal: { workspace: source.workspace, agent: source.principal } })
      !== request.sourceScopeKey
    || source.principal !== request.identity || source.instance !== manifest.instance) {
    fail("MANAGED_CLIENT_DRIFT", "managed backend binding changed during migration staging");
  }
  let enrollment: EnrollmentFile | undefined;
  try { enrollment = readEnrollment(request.enrollmentPath, env); }
  catch (error) {
    const deletionMayBeInProgress = manifest.steps[0]?.state === "observed-applied"
      && manifest.steps[1]?.state === "observed-applied"
      && manifest.steps[2]?.state === "intent-recorded";
    if (!missingPath(error) || !deletionMayBeInProgress) throw error;
  }
  if (enrollment) {
    checkEnrollment(enrollment, manifest.runtime, request.identity, manifest.instance, source, 0, now);
    if (enrollment.requestId !== request.enrollmentRequestId || enrollment.result?.credentialId !== request.successorCredentialId
      || enrollment.input.graceUntil !== request.predecessorGraceUntil) {
      fail("ENROLLMENT_MISMATCH", "rotation enrollment changed during migration staging");
    }
  }
  const target = {
    provider: "gateway" as const,
    workspace: request.targetWorkspace,
    endpointSha256: request.targetEndpointSha256,
    edgeDatabasePath: stageRecordPaths(manifest.operationId, env).edgeDatabasePath,
    credentialId: request.successorCredentialId,
    principal: request.identity,
    instance: manifest.instance,
  };
  if ((enrollment && (target.endpointSha256 !== endpointSha256(enrollment.input.gatewayUrl)
    || target.workspace !== enrollment.input.workspaceId))
    || target.endpointSha256 === request.sourceEndpointSha256
    || resolve(request.targetBackendPath) !== stageRecordPaths(manifest.operationId, env).backendConfigPath
    || resolve(request.stageRecordPath) !== stageRecordPaths(manifest.operationId, env).stageRecordPath) {
    fail("CORRUPT_OPERATION", "migration target paths or endpoint do not match the operation");
  }
  return { metadata, source, enrollment, target };
}

async function applyStageOperation(
  manifest: ClientOperationManifest,
  lock: ClientOperationLock,
  execute: ClientLifecycleExecutor | undefined,
  verifier: ClientMigrationStageOptions["verifyTarget"],
  sourceVerifier: ClientMigrationStageOptions["verifySource"],
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<{ manifest: ClientOperationManifest; enrollmentStatus: ClientMigrationStagePlan["enrollmentStatus"] }> {
  let current = manifest;
  const request = requireStageRequest(current);
  const checked = checkRequestAgainstCurrent(current, execute, env, now);
  let enrollment = checked.enrollment;
  if (!enrollment) requireNoEnrollmentLock(request.enrollmentPath);
  const enrollmentLock = enrollment ? acquireEnrollmentLock(request.enrollmentPath, env) : undefined;
  let enrollmentStatus: ClientMigrationStagePlan["enrollmentStatus"] = "ready";
  try {
    if (enrollment && enrollmentLock) {
      enrollment = readEnrollment(request.enrollmentPath, env);
      checkEnrollment(enrollment, current.runtime, request.identity, current.instance, checked.source, 0, now);
    }
    if (current.state === "prepared") {
      if (!enrollment) fail("ENROLLMENT_MISMATCH", "missing enrollment cannot start migration staging");
      current = snapshotStageOperation(current, lock, enrollment, env);
    }

    const record = expectedStageRecord(
      current.operationId, current.runtime, request.identity, current.instance, request, checked.target, current.createdAt,
    );
    const recordContents = stageRecordContents(record);

    const backendStep = current.steps[0]!;
    if (backendStep.state === "observed-applied"
      && digest(backendProof(request.targetBackendPath, checked.target)) !== backendStep.expectedAfterSha256) {
      fail("STAGED_BACKEND_DRIFT", "staged backend no longer matches its journal proof");
    }
    if (backendStep.state !== "observed-applied") {
      const before = backendProof(request.targetBackendPath, checked.target);
      const classification = classifyClientOperationRestart(current, digest(before));
      if (classification.disposition === "blocked") fail("AMBIGUOUS_OPERATION", classification.reason);
      if (backendStep.state === "pending") {
        assertPersistedManifest(current, env);
        current = recordClientOperationStepIntent(current.operationId, current, 0, lock, env);
        assertPersistedManifest(current, env);
      }
      if (classification.disposition === "retryable") {
        const activeEnrollment = enrollment;
        if (!activeEnrollment || (activeEnrollment.state !== "ready" && activeEnrollment.state !== "consuming")) {
          fail("ENROLLMENT_MISMATCH", "rotation enrollment cannot create a staged backend");
        }
        const token = activeEnrollment.token;
        if (!token) fail("ENROLLMENT_MISMATCH", "rotation enrollment no longer contains a credential");
        assertPersistedManifest(current, env);
        writeStagedGatewayBackendConfig(current.runtime, request.identity, current.instance, current.operationId, {
          token,
          gatewayUrl: activeEnrollment.input.gatewayUrl,
          workspace: activeEnrollment.input.workspaceId,
          credentialId: request.successorCredentialId,
          principal: request.identity,
          env,
        });
      }
      const after = backendProof(request.targetBackendPath, checked.target);
      assertPersistedManifest(current, env);
      current = recordClientOperationStepApplied(current.operationId, current, 0, canonical(after), lock, env);
    }

    const recordStep = current.steps[1]!;
    if (recordStep.state === "observed-applied") {
      const contents = readStageRecord(request.stageRecordPath, current.operationId, env);
      if (contents !== recordContents || digest(stageRecordProof(contents)) !== recordStep.expectedAfterSha256) {
        fail("STAGE_RECORD_DRIFT", "stage record no longer matches its journal proof");
      }
    }
    if (recordStep.state !== "observed-applied") {
      const values = parseBackendValues(request.targetBackendPath);
      await verifyGatewayBackend(values, checked.target, verifier);
      const prior = readStageRecord(request.stageRecordPath, current.operationId, env);
      const proof = prior === undefined ? stageAbsentProof() : stageRecordProof(prior);
      const classification = classifyClientOperationRestart(current, digest(proof));
      if (classification.disposition === "blocked") fail("AMBIGUOUS_OPERATION", classification.reason);
      if (recordStep.state === "pending") {
        assertPersistedManifest(current, env);
        current = recordClientOperationStepIntent(current.operationId, current, 1, lock, env);
        assertPersistedManifest(current, env);
      }
      if (classification.disposition === "retryable") {
        assertPersistedManifest(current, env);
        writeStageRecord(request.stageRecordPath, record, current.operationId, env);
      }
      const afterRecord = readStageRecord(request.stageRecordPath, current.operationId, env);
      if (afterRecord !== recordContents) fail("STAGE_RECORD_DRIFT", "stage record no longer matches the verified target");
      assertPersistedManifest(current, env);
      current = recordClientOperationStepApplied(current.operationId, current, 1,
        canonical(stageRecordProof(afterRecord)), lock, env);
    }

    const enrollmentStep = current.steps[2]!;
    if (enrollmentStep.state === "observed-applied") {
      if (existsSync(request.enrollmentPath)) {
        fail("ENROLLMENT_MISMATCH", "consumed enrollment remains after its deletion step");
      }
      if (digest(stageAbsentProof()) !== enrollmentStep.expectedAfterSha256) {
        fail("CORRUPT_OPERATION", "enrollment deletion proof is invalid");
      }
    }
    if (enrollmentStep.state !== "observed-applied") {
      if (!enrollment) {
        const fresh = checkRequestAgainstCurrent(current, execute, env, now);
        await verifySourceStage(
          parseBackendValues(request.sourceBackendPath), fresh.source, request.sourceScopeKey, sourceVerifier,
        );
        const values = parseBackendValues(request.targetBackendPath);
        backendProof(request.targetBackendPath, checked.target);
        await verifyGatewayBackend(values, checked.target, verifier);
        if (readStageRecord(request.stageRecordPath, current.operationId, env) !== recordContents) {
          fail("STAGE_RECORD_DRIFT", "stage record no longer matches the verified target");
        }
        const classification = classifyClientOperationRestart(current, digest(stageAbsentProof()));
        if (classification.disposition !== "advance") fail("AMBIGUOUS_OPERATION", classification.reason);
        assertPersistedManifest(current, env);
        current = recordClientOperationStepApplied(current.operationId, current, 2,
          canonical(stageAbsentProof()), lock, env);
        enrollmentStatus = "consumed-file-missing";
      } else {
        const before = enrollmentProof(enrollment);
        const classification = classifyClientOperationRestart(current, digest(before));
        if (!enrollmentLock) fail("ENROLLMENT_MISMATCH", "rotation enrollment lock is unavailable");
        if (enrollment.state === "ready" || enrollment.state === "consuming") {
          if (enrollmentStep.state === "pending" && classification.disposition !== "retryable") {
            fail("AMBIGUOUS_OPERATION", classification.reason);
          }
          // This must finish before durable intent says enrollment destruction can begin.
          const fresh = checkRequestAgainstCurrent(current, execute, env, now);
          await verifySourceStage(
            parseBackendValues(request.sourceBackendPath), fresh.source, request.sourceScopeKey, sourceVerifier,
          );
          await verifyStagedTargetBeforeConsumption(
            request,
            checked.target,
            recordContents,
            enrollment,
            verifier,
            current.operationId,
            env,
          );
          if (enrollmentStep.state === "pending") {
            assertPersistedManifest(current, env);
            current = recordClientOperationStepIntent(current.operationId, current, 2, lock, env);
            assertPersistedManifest(current, env);
          }
        } else if (enrollment.state !== "consumed" || enrollmentStep.state !== "intent-recorded") {
          fail("AMBIGUOUS_OPERATION", "enrollment state does not match the migration journal");
        }
        if (enrollment.state === "ready") {
          assertPersistedManifest(current, env);
          enrollment = transitionEnrollment(request.enrollmentPath, enrollment, "consuming", {}, env, enrollmentLock);
        }
        if (enrollment.state === "consuming") {
          assertPersistedManifest(current, env);
          enrollment = transitionEnrollment(request.enrollmentPath, enrollment, "consumed", { token: null }, env, enrollmentLock);
        }
        if (enrollment.state !== "consumed") fail("ENROLLMENT_MISMATCH", "rotation enrollment did not reach consumed state");
        assertPersistedManifest(current, env);
        const deletion = deleteEnrollmentFile(request.enrollmentPath, enrollmentLock, env);
        enrollmentStatus = deletion === "deleted-and-durable" || deletion === "missing" ? "consumed-file-missing"
          : "consumed-deletion-durability-unknown";
        assertPersistedManifest(current, env);
        current = recordClientOperationStepApplied(current.operationId, current, 2,
          canonical(stageAbsentProof()), lock, env);
      }
    }

    current = completeClientOperationCleanup(current.operationId, current, lock, env);
    return { manifest: current, enrollmentStatus };
  } finally {
    if (enrollmentLock) releaseEnrollmentLock(enrollmentLock);
  }
}

function planFrom(
  metadata: ManagedClientMetadata,
  source: BackendProjection,
  enrollment: EnrollmentFile | undefined,
  enrollmentFile: string,
  runtime: InstallableRuntime,
  identityValue: string,
  instance: string,
  applied: boolean,
  operationId: string | null,
  enrollmentStatus: ClientMigrationStagePlan["enrollmentStatus"] = "ready",
  env: NodeJS.ProcessEnv,
  request?: ClientMigrationStageRequest,
): ClientMigrationStagePlan {
  const paths = operationId ? stageRecordPaths(operationId, env) : null;
  return {
    schemaVersion: 1,
    action: "migrate-stage",
    applied,
    operationId,
    runtime,
    identity: identityValue,
    instance,
    enrollmentFile: resolve(enrollmentFile),
    sourceBackendPath: metadata.backendConfigPath,
    sourceEdgeDatabasePath: source.edgeDatabasePath,
    sourceScopeKey: edgeScopeKey({
      endpoint: parseBackendValues(metadata.backendConfigPath).AGENT_BRIDGE_URL,
      principal: { workspace: source.workspace, agent: source.principal },
    }),
    targetBackendPath: paths?.backendConfigPath ?? null,
    stageRecordPath: paths?.stageRecordPath ?? null,
    sourceEndpointSha256: source.endpointSha256,
    targetEndpointSha256: enrollment ? endpointSha256(enrollment.input.gatewayUrl) : request?.targetEndpointSha256 ?? "",
    successorCredentialId: enrollment?.result?.credentialId ?? request?.successorCredentialId ?? "",
    enrollmentStatus,
  };
}

function completedPlanFromRequest(
  manifest: ClientOperationManifest,
  request: ClientMigrationStageRequest,
): ClientMigrationStagePlan {
  return {
    schemaVersion: 1,
    action: "migrate-stage",
    applied: true,
    operationId: manifest.operationId,
    runtime: manifest.runtime,
    identity: request.identity,
    instance: manifest.instance,
    enrollmentFile: request.enrollmentPath,
    sourceBackendPath: request.sourceBackendPath,
    sourceEdgeDatabasePath: request.sourceEdgeDatabasePath,
    sourceScopeKey: request.sourceScopeKey,
    targetBackendPath: request.targetBackendPath,
    stageRecordPath: request.stageRecordPath,
    sourceEndpointSha256: request.sourceEndpointSha256,
    targetEndpointSha256: request.targetEndpointSha256,
    successorCredentialId: request.successorCredentialId,
    enrollmentStatus: "consumed-file-missing",
  };
}

export async function stageClientMigrationTarget(options: ClientMigrationStageOptions): Promise<ClientMigrationStagePlan> {
  const env = options.env ?? process.env;
  const runtime = options.runtime;
  const identityValue = identity(options.identity);
  const instance = text(options.instance, "instance", 128);
  const enrollmentFile = resolve(options.enrollmentFile);
  if (options.recoverLock && !options.apply) {
    fail("INVALID_STAGE", "--recover-lock requires --apply");
  }
  if (options.recoverLock) {
    if (hasClientOperationLock(runtime, instance, env)) recoverClientOperationLock(runtime, instance, env);
    recoverEnrollmentLockIfPresent(enrollmentFile, env);
  }
  requireNoEnrollmentLock(enrollmentFile);
  const metadata = checkMetadata(runtime, identityValue, instance, options.execute, env);
  const source = backendProjection(parseBackendValues(metadata.backendConfigPath));
  const enrollment = readEnrollment(enrollmentFile, env);
  const now = options.now?.() ?? new Date();
  checkEnrollment(enrollment, runtime, identityValue, instance, source, MIN_PREDECESSOR_GRACE_MS, now);
  if (enrollment.state !== "ready") fail("ENROLLMENT_MISMATCH", "rotation enrollment is not ready for staging");
  if (!options.apply) {
    return planFrom(metadata, source, enrollment, enrollmentFile, runtime, identityValue, instance, false, null, "ready", env);
  }
  const operationId = randomUUID();
  assertStageTargetsAbsent(operationId, env);
  const stageCreatedAt = new Date().toISOString();
  const request = makeRequest(
    operationId,
    metadata,
    source,
    enrollment,
    enrollmentFile,
    env,
  );
  const target = {
    provider: "gateway" as const,
    workspace: request.targetWorkspace,
    endpointSha256: request.targetEndpointSha256,
    edgeDatabasePath: stageRecordPaths(operationId, env).edgeDatabasePath,
    credentialId: request.successorCredentialId,
    principal: identityValue,
    instance,
  };
  await verifySourceStage(
    parseBackendValues(metadata.backendConfigPath), source, request.sourceScopeKey, options.verifySource,
  );
  await verifyGatewayBackend(targetValuesFromEnrollment(enrollment, target), target, options.verifyTarget);
  const record = expectedStageRecord(operationId, runtime, identityValue, instance, request, target, stageCreatedAt);
  const begun = beginClientOperation({
    operationId,
    createdAt: stageCreatedAt,
    version: 5,
    request,
    runtime,
    instance,
    steps: [
      { target: "stage-backend", locator: request.targetBackendPath, beforeArtifact: "backend-before", afterArtifact: "backend-after", expectedBeforeSha256: digest(stageAbsentProof()), expectedAfterSha256: digest({ exists: true, backend: target }) },
      { target: "stage-record", locator: request.stageRecordPath, beforeArtifact: "record-before", afterArtifact: "record-after", expectedBeforeSha256: digest(stageAbsentProof()), expectedAfterSha256: digest({ exists: true, sha256: digest(stageRecordContents(record)) }) },
      { target: "enrollment", locator: request.enrollmentPath, beforeArtifact: "enrollment-before", afterArtifact: "enrollment-after", expectedBeforeSha256: digest(enrollmentProof(enrollment)), expectedAfterSha256: digest(stageAbsentProof()) },
    ],
  }, env);
  if (begun.manifest.createdAt !== stageCreatedAt) {
    releaseClientOperationLock(begun.lock);
    fail("CORRUPT_OPERATION", "migration stage record timestamp does not match the operation journal");
  }
  try {
    const result = await applyStageOperation(
      begun.manifest, begun.lock, options.execute, options.verifyTarget, options.verifySource, env, now,
    );
    return planFrom(metadata, source, enrollment, enrollmentFile, runtime, identityValue, instance, true,
      result.manifest.operationId, result.enrollmentStatus, env, request);
  } finally {
    releaseClientOperationLock(begun.lock);
  }
}

export async function resumeClientMigrationStage(
  options: ResumeClientMigrationStageOptions,
): Promise<ClientMigrationStagePlan> {
  const env = options.env ?? process.env;
  const operation = readClientOperation(options.operationId, env);
  const request = requireStageRequest(operation);
  if (options.recoverLock) {
    if (hasClientOperationLock(operation.runtime, operation.instance, env)) {
      recoverClientOperationLock(operation.runtime, operation.instance, env);
    }
    recoverEnrollmentLockIfPresent(request.enrollmentPath, env);
  }
  requireNoEnrollmentLock(request.enrollmentPath);
  const begun = resumeClientOperation(options.operationId, env);
  try {
    if (begun.manifest.steps.every((step) => step.state === "observed-applied")) {
      const completed = completeClientOperationCleanup(
        begun.manifest.operationId, begun.manifest, begun.lock, env,
      );
      return completedPlanFromRequest(completed, request);
    }
    const now = options.now?.() ?? new Date();
    const checked = checkRequestAgainstCurrent(begun.manifest, options.execute, env, now);
    const result = await applyStageOperation(
      begun.manifest, begun.lock, options.execute, options.verifyTarget, options.verifySource, env, now,
    );
    return planFrom(checked.metadata, checked.source, checked.enrollment, request.enrollmentPath,
      begun.manifest.runtime, request.identity, begun.manifest.instance, true,
      result.manifest.operationId, result.enrollmentStatus, env, request);
  } finally {
    releaseClientOperationLock(begun.lock);
  }
}
