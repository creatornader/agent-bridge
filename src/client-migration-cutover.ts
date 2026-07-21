import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { verifyPrivatePathAccess } from "./private-path.js";
import { spawnSync } from "node:child_process";
import {
  beginClientOperation, classifyClientOperationRestart, completeClientOperationCleanup,
  hasClientOperationLock, readClientOperation, recordClientOperationStepApplied,
  recordClientOperationStepIntent, recoverClientOperationLock, releaseClientOperationLock,
  resumeClientOperation, transitionClientOperation, writeClientOperationSnapshot,
  type ClientMigrationCutoverRequest, type ClientMigrationStageContract, type ClientMigrationStageRequest,
  type ClientOperationLock, type ClientOperationManagedMetadata, type ClientOperationManifest,
  type ClientOperationRegistrationProof,
} from "./client-operation.js";
import {
  addManagedClientRegistration, removeManagedClientRegistration, replaceManagedDesktopRegistration,
  switchManagedClientMetadata,
} from "./client-maintenance.js";
import {
  loadManagedClientMetadata, managedClientMetadataPath, observeManagedRegistration,
  type ClientLifecycleExecutor, type ManagedClientMetadata, type ManagedRegistrationObservation,
} from "./client-lifecycle.js";
import {
  edgeScopeKey, inspectEdgeScopeReadOnly, SQLiteEdgeStore,
  type EdgeDrainLease, type EdgeMigrationGate,
} from "./sqlite-edge-store.js";
import { SyncingBridgeStore } from "./syncing-bridge-store.js";
import { HttpBridgeStore } from "./http-bridge-store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BACKEND_KEYS = [
  "AGENT_BRIDGE_PROVIDER", "AGENT_BRIDGE_WORKSPACE", "AGENT_BRIDGE_URL", "AGENT_BRIDGE_TOKEN",
  "AGENT_BRIDGE_EDGE_DB", "AGENT_BRIDGE_CREDENTIAL_ID", "AGENT_BRIDGE_PRINCIPAL", "AGENT_BRIDGE_CLIENT_INSTANCE",
] as const;
type BackendKey = (typeof BACKEND_KEYS)[number];
type Backend = Record<BackendKey, string>;
type Phase = "migrate-cutover" | "migrate-finalize";

export interface ClientMigrationCutoverPlan {
  schemaVersion: 1;
  action: "migrate-cutover" | "migrate-finalize";
  applied: boolean;
  operationId: string | null;
  stageOperationId: string;
  sourceCutoverOperationId: string | null;
  runtime: "codex" | "claude-code" | "claude-desktop";
  instance: string;
  sourceScopeKey: string;
  exclusiveEdgeRequired: true;
}

export interface CutoverOptions {
  stageOperationId: string;
  apply?: boolean;
  exclusiveEdge?: boolean;
  recoverLock?: boolean;
  env?: NodeJS.ProcessEnv;
  execute?: ClientLifecycleExecutor;
  fetch?: typeof fetch;
  now?: () => Date;
}
export interface CutoverResumeOptions {
  operationId: string;
  recoverLock?: boolean;
  env?: NodeJS.ProcessEnv;
  execute?: ClientLifecycleExecutor;
  fetch?: typeof fetch;
  now?: () => Date;
}

class CutoverError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CutoverError"; }
}
function fail(code: string, message: string): never { throw new CutoverError(code, message); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value), "utf8").digest("hex"); }
function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) fail("CORRUPT_OPERATION", `${label} is invalid`);
  return value.toLowerCase();
}
function text(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("CORRUPT_OPERATION", `${label} is invalid`);
  }
  return value;
}
function readPrivateText(path: string): string {
  verifyPrivatePathAccess(path, "file");
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) fail("BACKEND_DRIFT", "managed backend is not a private regular file");
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail("BACKEND_DRIFT", "managed backend changed while it was opened");
    }
    const contents = readFileSync(descriptor, "utf8");
    const after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      fail("BACKEND_DRIFT", "managed backend changed while it was read");
    }
    return contents;
  } finally { closeSync(descriptor); }
}
function parseBackend(path: string): Backend {
  const source = readPrivateText(path);
  const values: Partial<Record<BackendKey, string>> = {};
  for (const line of source.split(/\r?\n/u)) {
    if (!line) continue;
    const at = line.indexOf("=");
    if (at < 1) fail("BACKEND_DRIFT", "managed backend is invalid");
    const key = line.slice(0, at) as BackendKey;
    const value = line.slice(at + 1);
    if (!(BACKEND_KEYS as readonly string[]).includes(key) || values[key] !== undefined || !value) {
      fail("BACKEND_DRIFT", "managed backend is invalid");
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== BACKEND_KEYS.length) fail("BACKEND_DRIFT", "managed backend is invalid");
  return values as Backend;
}
function normalizedGatewayUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { fail("BACKEND_DRIFT", "gateway URL is invalid"); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) fail("BACKEND_DRIFT", "gateway URL is invalid");
  return parsed.toString().replace(/\/$/, "");
}
function endpointDigest(url: string): string {
  return createHash("sha256").update(normalizedGatewayUrl(url), "utf8").digest("hex");
}
function projection(values: Backend) {
  if (values.AGENT_BRIDGE_PROVIDER !== "gateway") {
    fail("BACKEND_DRIFT", "managed backend must use gateway provider");
  }
  const edge = text(values.AGENT_BRIDGE_EDGE_DB, "edge database path");
  if (!isAbsolute(edge) || resolve(edge) !== edge || edge === ":memory:") fail("BACKEND_DRIFT", "edge database path is invalid");
  return {
    provider: "gateway",
    workspace: text(values.AGENT_BRIDGE_WORKSPACE, "workspace", 128),
    principal: text(values.AGENT_BRIDGE_PRINCIPAL, "principal", 128),
    instance: text(values.AGENT_BRIDGE_CLIENT_INSTANCE, "instance", 128),
    credentialId: uuid(values.AGENT_BRIDGE_CREDENTIAL_ID, "credential ID"),
    endpointSha256: endpointDigest(values.AGENT_BRIDGE_URL), edgeDatabasePath: edge,
  };
}
function gateProof(gate: EdgeMigrationGate): { state: string; operationId: string | null } {
  return { state: gate.state, operationId: gate.operationId ?? null };
}
function registrationContract(metadata: ManagedClientMetadata): ClientOperationRegistrationProof {
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
        AGENT_BRIDGE_CONFIG: metadata.backendConfigPath,
        AGENT_BRIDGE_INSTANCE: metadata.instance,
      },
    },
  };
}
function observedExactRegistration(
  metadata: ManagedClientMetadata, execute: ClientLifecycleExecutor, env: NodeJS.ProcessEnv,
): ClientOperationRegistrationProof {
  const observed = observeManagedRegistration(metadata, execute, env);
  if (observed.state !== "exact" || observed.observed.state !== "present") {
    fail("REGISTRATION_DRIFT", "managed registration is not exact");
  }
  const expected = registrationContract(metadata);
  if (canonical(observed) !== canonical(expected)) fail("REGISTRATION_DRIFT", "managed registration proof drifted");
  return expected;
}
function observedAbsentRegistration(
  metadata: ManagedClientMetadata, execute: ClientLifecycleExecutor, env: NodeJS.ProcessEnv,
): ManagedRegistrationObservation {
  const observed = observeManagedRegistration(metadata, execute, env);
  if (observed.state !== "absent" || observed.observed.state !== "absent") {
    fail("REGISTRATION_DRIFT", "managed registration is not absent");
  }
  return observed;
}

function stageContract(stageOperationId: string, env: NodeJS.ProcessEnv): ClientMigrationStageContract {
  const stage = readClientOperation(stageOperationId, env);
  if (stage.version !== 5 || stage.state !== "committed" || stage.completion?.operation !== "migrate") {
    fail("STAGE_UNAVAILABLE", "cutover requires a committed v5 migration stage");
  }
  const contract = stage.completion.migration;
  if (!contract || !("request" in contract) || contract.request.kind !== "migrate" || contract.stageOperationId !== stage.operationId) {
    fail("STAGE_UNAVAILABLE", "legacy v5 stages without a retained contract cannot authorize cutover");
  }
  const request = contract.request;
  verifyPrivatePathAccess(request.stageRecordPath, "file");
  verifyPrivatePathAccess(request.targetBackendPath, "file");
  const recordBytes = readPrivateText(request.stageRecordPath);
  // v5 records the canonical string digest, rather than the raw-byte digest.
  // Preserve that framing here so a valid retained stage can be re-attested.
 const recordProof = digest({ exists: true, sha256: digest(recordBytes) });
 const targetProjection = projection(parseBackend(request.targetBackendPath));
 const targetProof = digest({ exists: true, backend: targetProjection });
 if (recordProof !== contract.stageRecordSha256 || targetProof !== contract.targetBackendProjectionSha256) {
   fail("STAGE_DRIFT", "retained stage contract no longer matches its private artifacts");
 }
  return contract as ClientMigrationStageContract;
}
function stageCurrent(stageOperationId: string, env: NodeJS.ProcessEnv, execute: ClientLifecycleExecutor) {
  const contract = stageContract(stageOperationId, env);
  const request = contract.request;
  const operation = readClientOperation(stageOperationId, env);
  const metadata = loadManagedClientMetadata(operation.runtime, operation.instance, env);
  if (resolve(metadata.backendConfigPath) !== request.sourceBackendPath || metadata.identity !== request.identity) {
    fail("STAGE_DRIFT", "managed client no longer matches the staged source");
  }
  const sourceRegistration = observedExactRegistration(metadata, execute, env);
  const sourceValues = parseBackend(request.sourceBackendPath);
  const targetValues = parseBackend(request.targetBackendPath);
  const source = projection(sourceValues); const target = projection(targetValues);
  if (source.endpointSha256 !== request.sourceEndpointSha256 || source.edgeDatabasePath !== request.sourceEdgeDatabasePath
    || source.credentialId !== request.predecessorCredentialId || source.principal !== request.identity
    || source.instance !== metadata.instance || target.endpointSha256 !== request.targetEndpointSha256
    || target.credentialId !== request.successorCredentialId || target.workspace !== request.targetWorkspace
    || target.principal !== request.identity || target.instance !== metadata.instance
    || request.sourceScopeKey !== edgeScopeKey({ endpoint: sourceValues.AGENT_BRIDGE_URL, principal: { workspace: source.workspace, agent: source.principal } })) {
    fail("STAGE_DRIFT", "stage backend bindings changed");
  }
  const targetMetadata: ManagedClientMetadata = { ...metadata, backendConfigPath: request.targetBackendPath };
  const targetRegistration = registrationContract(targetMetadata);
  return { contract, request, metadata, targetMetadata, sourceRegistration, targetRegistration, sourceValues, targetValues, source, target };
}
type StagedMigrationCurrent = ReturnType<typeof stageCurrent>;

function retainedCurrent(
  request: ClientMigrationCutoverRequest,
  env: NodeJS.ProcessEnv,
): StagedMigrationCurrent {
  const contract = stageContract(request.stageOperationId, env);
  if (canonical(contract) !== canonical(request.stageContract)) {
    fail("STAGE_DRIFT", "retained stage contract changed after cutover authorization");
  }
  const targetValues = parseBackend(request.targetBackendPath);
  const sourceValues: Backend = {
    AGENT_BRIDGE_PROVIDER: "gateway",
    AGENT_BRIDGE_WORKSPACE: targetValues.AGENT_BRIDGE_WORKSPACE,
    AGENT_BRIDGE_URL: request.sourceGatewayUrl,
    AGENT_BRIDGE_TOKEN: targetValues.AGENT_BRIDGE_TOKEN,
    AGENT_BRIDGE_EDGE_DB: request.sourceEdgeDatabasePath,
    AGENT_BRIDGE_CREDENTIAL_ID: targetValues.AGENT_BRIDGE_CREDENTIAL_ID,
    AGENT_BRIDGE_PRINCIPAL: request.identity,
    AGENT_BRIDGE_CLIENT_INSTANCE: request.sourceMetadata.instance,
  };
  const source = projection(sourceValues);
  const target = projection(targetValues);
  if (source.endpointSha256 !== request.sourceEndpointSha256
    || source.edgeDatabasePath !== request.sourceEdgeDatabasePath
    || source.credentialId !== request.successorCredentialId
    || source.workspace !== request.targetWorkspace
    || target.endpointSha256 !== request.targetEndpointSha256
    || target.credentialId !== request.successorCredentialId
    || target.workspace !== request.targetWorkspace
    || target.edgeDatabasePath !== request.targetEdgeDatabasePath
    || targetValues.AGENT_BRIDGE_PRINCIPAL !== request.identity
    || targetValues.AGENT_BRIDGE_CLIENT_INSTANCE !== request.targetMetadata.instance
    || edgeScopeKey({ endpoint: sourceValues.AGENT_BRIDGE_URL, principal: { workspace: source.workspace, agent: source.principal } }) !== request.sourceScopeKey
    || canonical(request.sourceMetadata) !== canonical({ ...request.sourceMetadata, backendConfigPath: request.sourceBackendPath })
    || canonical(request.targetMetadata) !== canonical({ ...request.targetMetadata, backendConfigPath: request.targetBackendPath })
    || digest(metadataProof(request.sourceMetadata)) !== request.sourceMetadataSha256
    || digest(metadataProof(request.targetMetadata)) !== request.targetMetadataSha256
    || digest(registrationProof(request.sourceRegistration)) !== request.sourceRegistrationSha256
    || digest(registrationProof(request.targetRegistration)) !== request.targetRegistrationSha256) {
    fail("STAGE_DRIFT", "retained endpoint contract no longer matches its backends");
  }
  if (source.workspace !== sourceValues.AGENT_BRIDGE_WORKSPACE || source.principal !== request.identity
    || target.workspace !== targetValues.AGENT_BRIDGE_WORKSPACE || target.principal !== request.identity) {
    fail("STAGE_DRIFT", "retained endpoint principal bindings changed");
  }
  assertDistinctEdges(request.sourceEdgeDatabasePath, request.targetEdgeDatabasePath);
  return {
    contract,
    request: contract.request,
    metadata: request.sourceMetadata,
    targetMetadata: request.targetMetadata,
    sourceRegistration: request.sourceRegistration,
    targetRegistration: request.targetRegistration,
    sourceValues,
    targetValues,
    source,
    target,
  };
}

function targetCurrent(
  request: ClientMigrationCutoverRequest,
  env: NodeJS.ProcessEnv,
  execute: ClientLifecycleExecutor,
): StagedMigrationCurrent {
  const retained = retainedCurrent(request, env);
  const metadata = loadManagedClientMetadata(request.targetMetadata.runtime, request.targetMetadata.instance, env);
  if (canonical(metadata) !== canonical(request.targetMetadata)
    || canonical(observedExactRegistration(metadata, execute, env)) !== canonical(request.targetRegistration)) {
    fail("TARGET_DRIFT", "managed client no longer matches the retained target contract");
  }
  return retained;
}

interface EdgeIdentity { dev: bigint; ino: bigint; nlink: bigint }

function edgeIdentity(path: string): EdgeIdentity | null {
  if (!existsSync(path)) return null;
  verifyPrivatePathAccess(path, "file");
  const details = lstatSync(path, { bigint: true });
  if (!details.isFile() || details.isSymbolicLink()) fail("EDGE_ALIAS", "edge database is not a private regular file");
  return { dev: details.dev, ino: details.ino, nlink: details.nlink };
}
export function edgeIdentitiesAlias(left: EdgeIdentity, right: EdgeIdentity): boolean {
  const leftHasFileId = left.dev !== 0n || left.ino !== 0n;
  const rightHasFileId = right.dev !== 0n || right.ino !== 0n;
  if (leftHasFileId && rightHasFileId) return left.dev === right.dev && left.ino === right.ino;
  if (left.nlink > 1n && right.nlink > 1n) {
    fail("EDGE_ALIAS", "edge file identity is ambiguous on this platform");
  }
  return false;
}
function managedEdgeCohort(
  metadata: ManagedClientMetadata,
  edgePath: string,
  env: NodeJS.ProcessEnv,
  scopeKey?: string,
): string[] {
  const directory = dirname(managedClientMetadataPath(metadata.runtime, metadata.instance, env));
  verifyPrivatePathAccess(directory, "directory");
  const matches: string[] = [];
  const edgePathIdentity = edgeIdentity(edgePath);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".managed.json")) continue;
    try {
      const raw = JSON.parse(readPrivateText(resolve(directory, entry.name))) as { runtime?: string; instance?: string };
      if (!raw.runtime || !raw.instance || !["codex", "claude-code", "claude-desktop"].includes(raw.runtime)) continue;
      const candidate = loadManagedClientMetadata(raw.runtime as ManagedClientMetadata["runtime"], raw.instance, env);
      if (!existsSync(candidate.backendConfigPath)) continue;
      const values = parseBackend(candidate.backendConfigPath);
      const candidateProjection = projection(values);
      const candidateScope = edgeScopeKey({ endpoint: values.AGENT_BRIDGE_URL, principal: { workspace: candidateProjection.workspace, agent: candidateProjection.principal } });
      if (scopeKey !== undefined && candidateScope !== scopeKey) continue;
      const candidateIdentity = edgeIdentity(candidateProjection.edgeDatabasePath);
      const samePath = resolve(candidateProjection.edgeDatabasePath) === resolve(edgePath);
      const sameFile = edgePathIdentity !== null && candidateIdentity !== null
        && edgeIdentitiesAlias(edgePathIdentity, candidateIdentity);
      if (samePath || sameFile) matches.push(candidate.backendConfigPath);
    } catch { fail("SHARED_EDGE_COHORT", "managed edge cohort could not be inspected"); }
  }
  return matches;
}
function assertExclusiveEdge(metadata: ManagedClientMetadata, edgePath: string, scopeKey: string, env: NodeJS.ProcessEnv): void {
  const matches = managedEdgeCohort(metadata, edgePath, env, scopeKey);
  if (new Set(matches).size !== 1 || matches.length !== 1 || matches[0] !== metadata.backendConfigPath) {
    fail("SHARED_EDGE_COHORT", "shared_edge_cohort: another managed registration uses this edge scope");
  }
}
function assertRetainedSourceEdgeExclusive(
  metadata: ManagedClientMetadata, edgePath: string, scopeKey: string, env: NodeJS.ProcessEnv,
): void {
  const matches = managedEdgeCohort(metadata, edgePath, env, scopeKey);
  if (matches.some((path) => path !== metadata.backendConfigPath)) {
    fail("SHARED_EDGE_COHORT", "shared_edge_cohort: another managed registration uses this edge scope");
  }
}
function assertSourceRetirementCohort(metadata: ManagedClientMetadata, sourceEdge: string, env: NodeJS.ProcessEnv): void {
  if (managedEdgeCohort(metadata, sourceEdge, env).length !== 0) {
    fail("SHARED_EDGE_COHORT", "source_edge_cohort: a managed registration still uses the source edge");
  }
}

interface GatewayBinding { authorityId: string; credentialId: string; }
async function gatewayStatus(values: Backend, expected: { workspace: string; principal: string; credentialId: string }, fetchImpl: typeof fetch): Promise<GatewayBinding> {
  const response = await fetchImpl(`${values.AGENT_BRIDGE_URL.replace(/\/$/, "")}/v2/status`, {
    headers: {
      authorization: `Bearer ${values.AGENT_BRIDGE_TOKEN}`,
      "x-agent-bridge-protocol-version": "2.1",
      "x-agent-bridge-instance": values.AGENT_BRIDGE_CLIENT_INSTANCE,
    },
  });
  const selected = response.headers.get("x-agent-bridge-protocol-version");
  const supported = response.headers.get("x-agent-bridge-supported-protocol-versions")?.split(",").map((item) => item.trim()) ?? [];
  if (!response.ok || selected !== "2.1" || !supported.includes("2.1")) fail("GATEWAY_ATTESTATION", "gateway does not negotiate HTTP 2.1");
  const status = await response.json() as Record<string, unknown>;
  const principal = status.principal as Record<string, unknown> | undefined;
  if (!principal || principal.workspace !== expected.workspace || principal.agent !== expected.principal
    || status.credentialId !== expected.credentialId || typeof status.gatewayAuthorityId !== "string" || !UUID.test(status.gatewayAuthorityId)) {
    fail("GATEWAY_ATTESTATION", "gateway status binding does not match the staged credential");
  }
  return { authorityId: status.gatewayAuthorityId.toLowerCase(), credentialId: expected.credentialId };
}
async function gatewayCapabilities(values: Backend, fetchImpl: typeof fetch): Promise<readonly string[]> {
  const response = await fetchImpl(values.AGENT_BRIDGE_URL.replace(/\/$/, "") + "/v2/capabilities", {
    headers: {
      authorization: "Bearer " + values.AGENT_BRIDGE_TOKEN,
      "x-agent-bridge-protocol-version": "2.1",
      "x-agent-bridge-instance": values.AGENT_BRIDGE_CLIENT_INSTANCE,
    },
  });
  const selected = response.headers.get("x-agent-bridge-protocol-version");
  const supported = response.headers.get("x-agent-bridge-supported-protocol-versions")?.split(",").map((item) => item.trim()) ?? [];
  if (!response.ok || selected !== "2.1" || !supported.includes("2.1")) {
    fail("GATEWAY_CAPABILITIES", "gateway does not negotiate HTTP 2.1 capabilities");
  }
  const document = await response.json() as Record<string, unknown>;
  const grantedScopes = document.grantedScopes;
  if (!Array.isArray(grantedScopes) || grantedScopes.some((scope) => typeof scope !== "string" || !scope)) {
    fail("GATEWAY_CAPABILITIES", "gateway capabilities response does not include valid granted scopes");
  }
  return grantedScopes;
}
async function requireSuccessorScopes(values: Backend, fetchImpl: typeof fetch): Promise<void> {
  const grantedScopes = await gatewayCapabilities(values, fetchImpl);
  for (const scope of ["status:read", "messages:write"]) {
    if (!grantedScopes.includes(scope)) {
      fail("SUCCESSOR_SCOPE_MISSING", "successor credential lacks " + scope);
    }
  }
}
async function postChallenge(values: Backend, path: string, body: Record<string, string>, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${values.AGENT_BRIDGE_URL.replace(/\/$/, "")}${path}`, {
    method: "POST", headers: {
      authorization: `Bearer ${values.AGENT_BRIDGE_TOKEN}`, "content-type": "application/json",
      "x-agent-bridge-protocol-version": "2.1", "x-agent-bridge-instance": values.AGENT_BRIDGE_CLIENT_INSTANCE,
    }, body: JSON.stringify(body),
  });
  if (!response.ok || response.headers.get("x-agent-bridge-protocol-version") !== "2.1") {
    fail("ROUTE_CHALLENGE", "gateway does not support endpoint migration route challenges");
  }
  return response.json() as Promise<Record<string, unknown>>;
}
async function proveRoutes(source: Backend, target: Backend, expectedAuthority: string, fetchImpl: typeof fetch): Promise<void> {
  const challenge = randomBytes(32).toString("hex");
  const issuerCredentialId = projection(source).credentialId;
  const verifierCredentialId = projection(target).credentialId;
  const issued = await postChallenge(source, "/v2/endpoint-migration-challenges", {
    challenge, expectedGatewayAuthorityId: expectedAuthority, verifierCredentialId,
  }, fetchImpl);
  const issuedIssuerCredentialId = typeof issued.issuerCredentialId === "string"
    ? issued.issuerCredentialId : null;
  const issuedVerifierCredentialId = typeof issued.verifierCredentialId === "string"
    ? issued.verifierCredentialId : null;
  if (issued.gatewayAuthorityId !== expectedAuthority
    || !issuedIssuerCredentialId
    || issuedIssuerCredentialId !== issuerCredentialId
    || issuedVerifierCredentialId !== verifierCredentialId) {
    fail("ROUTE_CHALLENGE", "issuer gateway challenge does not match the staged route pair");
  }
  const consumed = await postChallenge(target, "/v2/endpoint-migration-challenges/consume", {
    challenge, expectedGatewayAuthorityId: expectedAuthority, issuerCredentialId: issuedIssuerCredentialId,
  }, fetchImpl);
  if (consumed.gatewayAuthorityId !== expectedAuthority
    || consumed.issuerCredentialId !== issuerCredentialId
    || consumed.verifierCredentialId !== verifierCredentialId
    || consumed.consumed !== true) {
    fail("ROUTE_CHALLENGE", "gateway endpoints did not prove one shared live authority");
  }
}
async function attestRoutePair(
  issuer: Backend, issuerExpected: ReturnType<typeof projection>,
  consumer: Backend, consumerExpected: ReturnType<typeof projection>,
  authorityId: string, fetchImpl: typeof fetch,
): Promise<void> {
  const [issuerStatus, consumerStatus] = await Promise.all([
    gatewayStatus(issuer, issuerExpected, fetchImpl), gatewayStatus(consumer, consumerExpected, fetchImpl),
  ]);
  if (issuerStatus.authorityId !== authorityId || consumerStatus.authorityId !== authorityId
    || issuerStatus.authorityId !== consumerStatus.authorityId) {
    fail("GATEWAY_AUTHORITY_MISMATCH", "live endpoint authority no longer matches the retained migration contract");
  }
  await proveRoutes(issuer, consumer, authorityId, fetchImpl);
}
function sourceWithSuccessor(staged: StagedMigrationCurrent): Backend {
  return {
    ...staged.sourceValues,
    AGENT_BRIDGE_TOKEN: staged.targetValues.AGENT_BRIDGE_TOKEN,
    AGENT_BRIDGE_CREDENTIAL_ID: staged.targetValues.AGENT_BRIDGE_CREDENTIAL_ID,
  };
}
async function attestPhaseAuthority(
  staged: StagedMigrationCurrent, request: ClientMigrationCutoverRequest, fetchImpl: typeof fetch,
): Promise<void> {
  const target = await gatewayStatus(staged.targetValues, staged.target, fetchImpl);
  if (target.authorityId !== request.gatewayAuthorityId) {
    fail("GATEWAY_AUTHORITY_MISMATCH", "target gateway authority no longer matches the retained migration contract");
  }
  await proveRoutes(sourceWithSuccessor(staged), staged.targetValues, target.authorityId, fetchImpl);
}
function assertPhaseManagedCohort(
  phase: Phase,
  staged: StagedMigrationCurrent,
  request: ClientMigrationCutoverRequest,
  env: NodeJS.ProcessEnv,
): void {
  if (phase === "migrate-cutover") {
    assertRetainedSourceEdgeExclusive(staged.metadata, staged.source.edgeDatabasePath, request.sourceScopeKey, env);
    return;
  }
  assertSourceRetirementCohort(staged.targetMetadata, staged.source.edgeDatabasePath, env);
}

async function openEdge(values: Backend): Promise<SQLiteEdgeStore> {
  const edge = new SQLiteEdgeStore(values.AGENT_BRIDGE_EDGE_DB, {
    endpoint: values.AGENT_BRIDGE_URL, principal: { workspace: values.AGENT_BRIDGE_WORKSPACE, agent: values.AGENT_BRIDGE_PRINCIPAL },
  });
  await edge.initialize(); return edge;
}
async function requireUntouchedTarget(values: Backend): Promise<void> {
  const edge = await openEdge(values);
  try {
    const stats = await edge.stats();
    if (stats.migrationState !== "active" || stats.pending !== 0 || stats.due !== 0 || stats.scheduled !== 0
      || stats.leased !== 0 || stats.blocked !== 0 || stats.cached !== 0) {
      fail("TARGET_EDGE_NOT_EMPTY", "target edge must be active and exactly empty");
    }
  } finally { await edge.close(); }
}
function inspectEdge(values: Backend, now: Date) {
  return inspectEdgeScopeReadOnly(values.AGENT_BRIDGE_EDGE_DB, {
    endpoint: values.AGENT_BRIDGE_URL,
    principal: { workspace: values.AGENT_BRIDGE_WORKSPACE, agent: values.AGENT_BRIDGE_PRINCIPAL },
  }, now);
}
function assertForwardLocalPreconditions(
  source: Backend, target: Backend, now: Date,
): void {
  const sourceInspection = inspectEdge(source, now);
  const targetInspection = inspectEdge(target, now);
  if (sourceInspection.gate.state !== "active") fail("EDGE_GATE_DRIFT", "source edge must be active before cutover");
  if (targetInspection.gate.state !== "active" || targetInspection.pending !== 0 || targetInspection.due !== 0
    || targetInspection.scheduled !== 0 || targetInspection.leased !== 0 || targetInspection.blocked !== 0
    || targetInspection.cached !== 0) {
    fail("TARGET_EDGE_NOT_EMPTY", "target edge must be active and exactly empty");
  }
}
function assertDistinctEdges(sourcePath: string, targetPath: string, requirePresent = true): void {
  if (resolve(sourcePath) === resolve(targetPath)) {
    fail("EDGE_ALIAS", "source and target edge paths must differ");
  }
  const source = edgeIdentity(sourcePath);
  const target = edgeIdentity(targetPath);
  if (requirePresent && (!source || !target)) fail("EDGE_ALIAS", "source and target edge paths must be initialized before mutation");
  if (source && target && edgeIdentitiesAlias(source, target)) {
    fail("EDGE_ALIAS", "source and target edges must not alias the same file");
  }
}
async function assertFinalizeGatePreconditions(
  staged: StagedMigrationCurrent,
  sourceCutoverOperationId: string,
  now: Date,
): Promise<void> {
  const source = inspectEdge(staged.sourceValues, now);
  if (source.gate.state !== "draining" || source.gate.operationId !== sourceCutoverOperationId) {
    fail("EDGE_GATE_DRIFT", "finalization requires the retained source drain");
  }
}
async function drain(
  edge: SQLiteEdgeStore,
  remoteValues: Backend,
  lease: EdgeDrainLease,
  fetchImpl: typeof fetch,
  now: () => Date,
): Promise<EdgeDrainLease> {
  const gate = await edge.migrationGate();
  if (gate.state !== "draining" || gate.operationId !== lease.operationId) {
    fail("EDGE_GATE_DRIFT", "edge is not draining for the recorded migration operation");
  }
  const remote = new HttpBridgeStore({ baseUrl: remoteValues.AGENT_BRIDGE_URL, token: remoteValues.AGENT_BRIDGE_TOKEN,
    principal: { workspace: remoteValues.AGENT_BRIDGE_WORKSPACE, agent: remoteValues.AGENT_BRIDGE_PRINCIPAL, instance: remoteValues.AGENT_BRIDGE_CLIENT_INSTANCE }, fetch: fetchImpl });
  const sync = new SyncingBridgeStore(edge, remote, {
    workspace: remoteValues.AGENT_BRIDGE_WORKSPACE,
    agent: remoteValues.AGENT_BRIDGE_PRINCIPAL,
    instance: remoteValues.AGENT_BRIDGE_CLIENT_INSTANCE,
  }, { autoSync: false, edgeDrainLease: lease, closeEdge: false, now });
  try {
    await sync.initialize();
    for (;;) {
      lease = await edge.renewDrainLease(lease, now());
      sync.setDrainLease(lease);
      const report = await sync.sync({ maxPush: 1, maxPages: 0 });
      lease = await edge.renewDrainLease(lease, now());
      sync.setDrainLease(lease);
      const stats = await edge.stats(now());
      if (stats.blocked > 0) fail("SOURCE_EDGE_BLOCKED", "edge drain refuses blocked outbox work");
      if (stats.pending === 0 && stats.leased === 0 && stats.scheduled === 0 && stats.due === 0) {
        await edge.assertDrainComplete(lease, now());
        return lease;
      }
      if (report.lastError || stats.scheduled > 0 || stats.leased > 0) {
        fail("EDGE_NOT_DRAINED", "edge contains scheduled, leased, or retrying work");
      }
    }
  } finally {
    await sync.close();
  }
}

function metadataProof(metadata: ClientOperationManagedMetadata): Record<string, unknown> {
  return { role: "metadata", metadata };
}
function registrationProof(registration: ClientOperationRegistrationProof): Record<string, unknown> {
  return { role: "registration", observation: registration };
}
function absentRegistrationProof(registration: ClientOperationRegistrationProof): Record<string, unknown> {
  return { state: "absent", target: registration.target, observed: { state: "absent" } };
}
function requestFor(
  phase: Phase,
  migrationOperationId: string,
  sourceCutoverOperationId: string | null,
  authorityId: string,
  current: StagedMigrationCurrent,
): ClientMigrationCutoverRequest {
  const stage = current.request;
  return {
    ...stage,
    kind: phase,
    migrationOperationId: uuid(migrationOperationId, "migration operation ID"),
    stageOperationId: current.contract.stageOperationId,
    sourceCutoverOperationId,
    sourceGatewayUrl: normalizedGatewayUrl(current.sourceValues.AGENT_BRIDGE_URL),
    targetEdgeDatabasePath: current.target.edgeDatabasePath,
    gatewayAuthorityId: authorityId,
    exclusiveEdgeAssertion: true,
    stageContract: current.contract,
    sourceMetadata: current.metadata,
    targetMetadata: current.targetMetadata,
    sourceRegistration: current.sourceRegistration,
    targetRegistration: current.targetRegistration,
    sourceMetadataSha256: digest(metadataProof(current.metadata)),
    targetMetadataSha256: digest(metadataProof(current.targetMetadata)),
    sourceRegistrationSha256: digest(registrationProof(current.sourceRegistration)),
    targetRegistrationSha256: digest(registrationProof(current.targetRegistration)),
  };
}
interface MigrationStepSpec {
  name: string;
  target: "edge-gate" | "registration" | "metadata";
  locator: string;
  before: unknown;
  after: unknown;
}
function phaseStepSpecs(phase: Phase, runtime: ManagedClientMetadata["runtime"], request: ClientMigrationCutoverRequest): MigrationStepSpec[] {
  const native = runtime !== "claude-desktop";
  const sourceActive = { state: "active", operationId: null };
  const sourceDraining = { state: "draining", operationId: request.sourceCutoverOperationId };
  const sourceExact = registrationProof(request.sourceRegistration);
  const sourceAbsent = absentRegistrationProof(request.sourceRegistration);
  const targetExact = registrationProof(request.targetRegistration);
  const targetAbsent = absentRegistrationProof(request.targetRegistration);
  const sourceMetadata = metadataProof(request.sourceMetadata);
  const targetMetadata = metadataProof(request.targetMetadata);
  if (phase === "migrate-cutover") {
    const steps: MigrationStepSpec[] = [{ name: "source-drain", target: "edge-gate", locator: request.sourceEdgeDatabasePath, before: sourceActive, after: { state: "draining", operationId: request.migrationOperationId } }];
    if (native) steps.push(
      { name: "native-remove-source", target: "registration", locator: "native-remove-source", before: sourceExact, after: sourceAbsent },
      { name: "native-add-target", target: "registration", locator: "native-add-target", before: targetAbsent, after: targetExact },
    );
    else steps.push({ name: "desktop-replace-target", target: "registration", locator: "desktop-replace-target", before: sourceExact, after: targetExact });
    steps.push({ name: "metadata-switch-target", target: "metadata", locator: request.sourceBackendPath, before: sourceMetadata, after: targetMetadata });
    return steps;
  }
  return [{ name: "source-retire", target: "edge-gate", locator: request.sourceEdgeDatabasePath, before: sourceDraining, after: { state: "retired", operationId: request.sourceCutoverOperationId! } }];
}
function phaseSteps(phase: Phase, runtime: ManagedClientMetadata["runtime"], request: ClientMigrationCutoverRequest) {
  return phaseStepSpecs(phase, runtime, request).map((step) => ({
    target: step.target,
    locator: step.locator,
    beforeArtifact: `${step.name}.before`,
    afterArtifact: `${step.name}.after`,
    expectedBeforeSha256: digest(step.before),
    expectedAfterSha256: digest(step.after),
  }));
}
function specForStep(
  request: ClientMigrationCutoverRequest, phase: Phase, runtime: ManagedClientMetadata["runtime"],
  step: ClientOperationManifest["steps"][number],
): MigrationStepSpec {
  const match = phaseStepSpecs(phase, runtime, request).find((candidate) => candidate.target === step.target
    && candidate.locator === step.locator && `${candidate.name}.before` === step.beforeArtifact
    && `${candidate.name}.after` === step.afterArtifact && digest(candidate.before) === step.expectedBeforeSha256
    && digest(candidate.after) === step.expectedAfterSha256);
  if (!match) fail("CORRUPT_OPERATION", "migration journal step does not match its retained phase contract");
  return match;
}

function plan(phase: Phase, applied: boolean, operationId: string | null, request: ClientMigrationCutoverRequest, runtime: ManagedClientMetadata["runtime"], instance: string): ClientMigrationCutoverPlan {
  return { schemaVersion: 1, action: phase, applied, operationId, stageOperationId: request.stageOperationId,
    sourceCutoverOperationId: request.sourceCutoverOperationId, runtime, instance, sourceScopeKey: request.sourceScopeKey, exclusiveEdgeRequired: true };
}

export async function cutoverClientMigration(options: CutoverOptions): Promise<ClientMigrationCutoverPlan> {
  const env = options.env ?? process.env; const execute = options.execute ?? ((command, args, context) => spawnSync(command, args, { encoding: "utf8", cwd: context?.cwd, env: context?.env }));
  if (!options.exclusiveEdge) fail("EXCLUSIVE_EDGE_REQUIRED", "--exclusive-edge is required because unmanaged publishers cannot be enumerated");
  const now = options.now ?? (() => new Date());
  const current = stageCurrent(options.stageOperationId, env, execute);
  assertExclusiveEdge(current.metadata, current.source.edgeDatabasePath, current.request.sourceScopeKey, env);
  assertDistinctEdges(current.source.edgeDatabasePath, current.target.edgeDatabasePath, false);
  assertForwardLocalPreconditions(current.sourceValues, current.targetValues, now());
  if (!options.apply) {
    return plan("migrate-cutover", false, null, requestFor(
      "migrate-cutover", "00000000-0000-7000-8000-000000000000", null,
      "00000000-0000-7000-8000-000000000000", current,
    ), current.metadata.runtime, current.metadata.instance);
  }
  const initializedSource = await openEdge(current.sourceValues);
  await initializedSource.close();
  const fetchImpl = options.fetch ?? fetch;
  assertExclusiveEdge(current.metadata, current.source.edgeDatabasePath, current.request.sourceScopeKey, env);
  await requireUntouchedTarget(current.targetValues);
  assertDistinctEdges(current.source.edgeDatabasePath, current.target.edgeDatabasePath);
  assertForwardLocalPreconditions(current.sourceValues, current.targetValues, now());
  const sourceBinding = await gatewayStatus(current.sourceValues, current.source, fetchImpl);
  const targetBinding = await gatewayStatus(current.targetValues, current.target, fetchImpl);
  if (sourceBinding.authorityId !== targetBinding.authorityId) fail("GATEWAY_AUTHORITY_MISMATCH", "gateway authority IDs differ");
  await requireSuccessorScopes(current.targetValues, fetchImpl);
  await proveRoutes(current.sourceValues, current.targetValues, sourceBinding.authorityId, fetchImpl);
  const request = requestFor("migrate-cutover", randomUUID(), null, sourceBinding.authorityId, current);
  if (options.recoverLock && hasClientOperationLock(current.metadata.runtime, current.metadata.instance, env)) recoverClientOperationLock(current.metadata.runtime, current.metadata.instance, env);
  const begun = beginClientOperation({ operationId: request.migrationOperationId, version: 6, request, runtime: current.metadata.runtime, instance: current.metadata.instance, steps: phaseSteps(request.kind, current.metadata.runtime, request) }, env);
  try {
    // The predecessor credentials authorize only the pre-journal challenge.
    // Every journal mutation uses the retained successor route instead.
    return await applyOperation(begun.manifest, begun.lock, retainedCurrent(request, env), execute, fetchImpl, now, env);
  }
  finally { releaseClientOperationLock(begun.lock); }
}

function currentRegistrationProof(metadata: ManagedClientMetadata, contract: ClientOperationRegistrationProof,
  execute: ClientLifecycleExecutor, env: NodeJS.ProcessEnv): unknown {
  const observed = observeManagedRegistration(metadata, execute, env);
  if (observed.state === "exact" && observed.observed.state === "present") {
    if (canonical(observed) !== canonical(contract)) fail("REGISTRATION_DRIFT", "managed registration proof drifted");
    return registrationProof(contract);
  }
  if (observed.state === "absent" && observed.observed.state === "absent") return absentRegistrationProof(contract);
  fail("REGISTRATION_DRIFT", "managed registration is neither the recorded before nor after state");
}
function currentDesktopReplacementProof(
  beforeMetadata: ManagedClientMetadata, before: ClientOperationRegistrationProof,
  afterMetadata: ManagedClientMetadata, after: ClientOperationRegistrationProof,
  execute: ClientLifecycleExecutor, env: NodeJS.ProcessEnv,
): unknown {
  const beforeObserved = observeManagedRegistration(beforeMetadata, execute, env);
  if (beforeObserved.state === "exact" && beforeObserved.observed.state === "present"
    && canonical(beforeObserved) === canonical(before)) return registrationProof(before);
  const afterObserved = observeManagedRegistration(afterMetadata, execute, env);
  if (afterObserved.state === "exact" && afterObserved.observed.state === "present"
    && canonical(afterObserved) === canonical(after)) return registrationProof(after);
  fail("REGISTRATION_DRIFT", "Desktop registration is neither recorded replacement state");
}

async function observedStepProof(
  request: ClientMigrationCutoverRequest,
  phase: Phase,
  step: ClientOperationManifest["steps"][number],
  sourceGate: SQLiteEdgeStore,
  execute: ClientLifecycleExecutor,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const spec = specForStep(request, phase, request.sourceMetadata.runtime, step);
  if (spec.target === "edge-gate") {
    return gateProof(await sourceGate.migrationGate());
  }
  if (spec.name === "desktop-replace-target") {
    return currentDesktopReplacementProof(request.sourceMetadata, request.sourceRegistration,
      request.targetMetadata, request.targetRegistration, execute, env);
  }
  if (spec.name === "native-remove-source") {
    return currentRegistrationProof(request.sourceMetadata, request.sourceRegistration, execute, env);
  }
  if (spec.name === "native-add-target") return currentRegistrationProof(request.targetMetadata, request.targetRegistration, execute, env);
  return metadataProof(loadManagedClientMetadata(request.sourceMetadata.runtime, request.sourceMetadata.instance, env));
}

async function claimDrain(
  edge: SQLiteEdgeStore, operationId: string, now: Date,
): Promise<EdgeDrainLease> {
  const gate = await edge.migrationGate();
  if (gate.state === "active") return edge.beginDrain(operationId, now);
  if (gate.state === "draining" && gate.operationId === operationId) return edge.resumeDrain(operationId, now);
  fail("EDGE_GATE_DRIFT", "edge gate cannot be claimed by this migration phase");
}

async function applyOperation(
  manifest: ClientOperationManifest,
  lock: ClientOperationLock,
  staged: StagedMigrationCurrent,
  execute: ClientLifecycleExecutor,
  fetchImpl: typeof fetch,
  now: () => Date,
  env: NodeJS.ProcessEnv,
): Promise<ClientMigrationCutoverPlan> {
  const request = manifest.request as ClientMigrationCutoverRequest;
  let current = manifest;
  const phase = request.kind;
  if (current.state === "prepared") {
    for (const step of current.steps) {
      const spec = specForStep(request, phase, current.runtime, step);
      current = writeClientOperationSnapshot(current.operationId, current, step.beforeArtifact,
        canonical(spec.before), lock, env);
    }
    current = transitionClientOperation(current.operationId, current, "snapshotted", lock, env);
  }
  const sourceGate = await openEdge(staged.sourceValues);
  let sourceLease: EdgeDrainLease | undefined;
  let forwardDrained = false;
  try {
    for (let index = 0; index < current.steps.length; index += 1) {
      const step = current.steps[index]!;
      const spec = specForStep(request, phase, current.runtime, step);
      let observed = await observedStepProof(request, phase, step, sourceGate, execute, env);
      if (step.state === "observed-applied") {
        if (digest(observed) !== step.expectedAfterSha256) fail("AMBIGUOUS_OPERATION", "applied migration step no longer matches its durable after-state");
        continue;
      }
      const classification = classifyClientOperationRestart(current, digest(observed));
      if (classification.disposition === "blocked") fail("AMBIGUOUS_OPERATION", classification.reason);
      if (classification.disposition === "advance") {
        current = recordClientOperationStepApplied(current.operationId, current, index, canonical(observed), lock, env);
        continue;
      }
      // Every real edge or host mutation is preceded by a fresh, apply-only
      // authority check. Dry-run paths never enter this function.
      await attestPhaseAuthority(staged, request, fetchImpl);
      // A resumed journal can observe a changed managed cohort after its last
      // durable step. Check the phase-specific cohort immediately before each
      // new mutation, rather than trusting the original cutover assertion.
      assertPhaseManagedCohort(phase, staged, request, env);
      if (step.state === "pending") current = recordClientOperationStepIntent(current.operationId, current, index, lock, env);

      if (step.target === "edge-gate") {
        if (phase === "migrate-cutover") {
          sourceLease = await claimDrain(sourceGate, request.migrationOperationId, now());
        } else {
          if (new Date(request.predecessorGraceUntil).getTime() > now().getTime()) {
            fail("FINALIZE_REFUSED", "source edge is not eligible for finalization");
          }
          sourceLease = await claimDrain(sourceGate, request.sourceCutoverOperationId!, now());
          await sourceGate.assertDrainComplete(sourceLease, now());
          await sourceGate.retireScope(sourceLease, now());
        }
      } else if (phase === "migrate-cutover") {
        if (!sourceLease) sourceLease = await claimDrain(sourceGate, request.migrationOperationId, now());
        if (!forwardDrained) {
          sourceLease = await drain(sourceGate, staged.targetValues, sourceLease, fetchImpl, now);
          forwardDrained = true;
        }
        // Drain work can take arbitrarily long. Re-attest the route before the
        // registration or metadata write that follows it.
        await attestPhaseAuthority(staged, request, fetchImpl);
        assertPhaseManagedCohort(phase, staged, request, env);
        await sourceGate.assertDrainComplete(sourceLease, now());
        sourceLease = await sourceGate.renewDrainLease(sourceLease, now());
        await sourceGate.assertDrainLease(sourceLease, now());
        if (spec.name === "native-remove-source") removeManagedClientRegistration(request.sourceMetadata, execute, env);
        else if (spec.name === "native-add-target") addManagedClientRegistration(request.targetMetadata, execute, env);
        else if (spec.name === "desktop-replace-target") {
          replaceManagedDesktopRegistration(request.sourceMetadata, request.targetMetadata, current.operationId, index, execute, env);
        } else if (spec.name === "metadata-switch-target") {
          switchManagedClientMetadata(request.sourceMetadata, request.targetMetadata, env);
        } else fail("CORRUPT_OPERATION", "unexpected forward migration step");
      } else {
        fail("CORRUPT_OPERATION", "unexpected finalization step");
      }
      observed = await observedStepProof(request, phase, step, sourceGate, execute, env);
      current = recordClientOperationStepApplied(current.operationId, current, index, canonical(observed), lock, env);
    }
  } finally {
    await sourceGate.close();
  }
  current = completeClientOperationCleanup(current.operationId, current, lock, env);
  return plan(phase, true, current.operationId, request, current.runtime, current.instance);
}

export async function resumeClientMigrationCutover(options: CutoverResumeOptions): Promise<ClientMigrationCutoverPlan> {
  const env = options.env ?? process.env; const original = readClientOperation(options.operationId, env);
  if (original.version !== 6 || !original.request || !["migrate-cutover", "migrate-finalize"].includes(original.request.kind)) fail("CORRUPT_OPERATION", "operation is not a v6 endpoint migration");
  if (options.recoverLock && hasClientOperationLock(original.runtime, original.instance, env)) recoverClientOperationLock(original.runtime, original.instance, env);
  const begun = resumeClientOperation(options.operationId, env);
  const execute = options.execute ?? ((command, args, context) => spawnSync(command, args, { encoding: "utf8", cwd: context?.cwd, env: context?.env }));
  try {
    const request = begun.manifest.request as ClientMigrationCutoverRequest;
    // A resumed journal is allowed to be between its recorded before and after
    // registration or metadata states. Per-step classification owns that proof.
    const staged = retainedCurrent(request, env);
    return await applyOperation(begun.manifest, begun.lock, staged, execute, options.fetch ?? fetch, options.now ?? (() => new Date()), env);
  } finally { releaseClientOperationLock(begun.lock); }
}

export async function finalizeClientMigration(options: Omit<CutoverOptions, "stageOperationId"> & { cutoverOperationId: string }): Promise<ClientMigrationCutoverPlan> {
  const env = options.env ?? process.env; const source = readClientOperation(options.cutoverOperationId, env);
  const prior = source.completion?.migration;
  if (source.version !== 6 || source.completion?.operation !== "migrate-cutover" || !prior || !("kind" in prior) || prior.kind !== "migrate-cutover") fail("FINALIZE_REFUSED", "finalize requires a committed forward cutover");
  const execute = options.execute ?? ((command, args, context) => spawnSync(command, args, { encoding: "utf8", cwd: context?.cwd, env: context?.env }));
  const dryCurrent = targetCurrent(prior, env, execute);
  const now = options.now ?? (() => new Date());
  if (!options.exclusiveEdge) fail("EXCLUSIVE_EDGE_REQUIRED", "--exclusive-edge is required because finalization mutates the retained source cohort");
  assertSourceRetirementCohort(dryCurrent.targetMetadata, dryCurrent.source.edgeDatabasePath, env);
  if (new Date(prior.predecessorGraceUntil).getTime() > now().getTime()) fail("FINALIZE_REFUSED", "source edge is not eligible for finalization");
  await assertFinalizeGatePreconditions(dryCurrent, source.operationId, now());
  if (!options.apply) return plan("migrate-finalize", false, null, requestFor(
    "migrate-finalize", "00000000-0000-7000-8000-000000000000", source.operationId,
    prior.gatewayAuthorityId, dryCurrent,
  ), source.runtime, source.instance);
  const staged = dryCurrent;
  const request = requestFor("migrate-finalize", randomUUID(), source.operationId, prior.gatewayAuthorityId, staged);
  if (options.recoverLock && hasClientOperationLock(source.runtime, source.instance, env)) {
    recoverClientOperationLock(source.runtime, source.instance, env);
  }
  const begun = beginClientOperation({ operationId: request.migrationOperationId, version: 6, request, runtime: source.runtime, instance: source.instance, steps: phaseSteps(request.kind, source.runtime, request) }, env);
  try { return await applyOperation(begun.manifest, begun.lock, staged, execute, options.fetch ?? fetch, now, env); }
  finally { releaseClientOperationLock(begun.lock); }
}
