import { closeSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { adoptClient } from "../src/client-lifecycle.js";
import {
  resumeClientMigrationStage,
  stageClientMigrationTarget,
} from "../src/client-migration-stage.js";
import {
  cleanupClientOperationArtifact,
  listClientOperations,
  recordClientOperationStepIntent,
  recordClientOperationStepApplied,
  releaseClientOperationLock,
  resumeClientOperation,
} from "../src/client-operation.js";
import {
  stagedGatewayBackendPaths,
  writeStagedGatewayBackendConfig,
} from "../src/client-installer.js";
import {
  createPendingEnrollment,
  acquireEnrollmentLock,
  defaultEnrollmentPath,
  deleteEnrollmentFile,
  readEnrollment,
  transitionEnrollment,
  type EnrollmentFile,
} from "../src/enrollment-file.js";
import { securePrivatePath } from "../src/private-path.js";
import { privateTestDirectory } from "./private-test-path.js";
import { privatePathIt } from "./private-path-policy.js";

const it = privatePathIt;
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

interface Registration {
  command: string;
  identity: string;
  instance: string;
  backendConfigPath: string;
}

function codexRegistration(registration: Registration): string {
  return JSON.stringify({
    name: "agent-bridge",
    enabled: true,
    transport: {
      type: "stdio",
      command: registration.command,
      args: [],
      env: {
        AGENT_BRIDGE_AGENT: registration.identity,
        AGENT_BRIDGE_INSTANCE: registration.instance,
        AGENT_BRIDGE_CONFIG: registration.backendConfigPath,
      },
    },
  });
}

function treeBytes(root: string): Array<{ path: string; bytes: string }> {
  const walk = (directory: string): Array<{ path: string; bytes: string }> => readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      if (!entry.isFile()) return [{ path, bytes: "non-file" }];
      return [{ path, bytes: readFileSync(path).toString("base64") }];
    });
  return walk(root).sort((left, right) => left.path.localeCompare(right.path));
}

function fixture() {
  const home = privateTestDirectory("agent-bridge-stage-"); homes.push(home);
  const env = { HOME: home, CODEX_HOME: join(home, ".codex") };
  const instance = "codex-stage";
  const identity = "codex-work";
  const predecessorCredentialId = "019f7fd1-0000-7000-8000-000000000001";
  const successorCredentialId = "019f7fd1-0000-7000-8000-000000000002";
  const sourceToken = "source-token-do-not-stage";
  const successorToken = "successor-token-do-not-leak";
  const clients = join(home, ".agent-bridge", "clients");
  mkdirSync(clients, { recursive: true, mode: 0o700 });
  securePrivatePath(join(home, ".agent-bridge"), "directory");
  securePrivatePath(clients, "directory");
  const backendConfigPath = join(clients, "codex-stage.config");
  writeFileSync(backendConfigPath, [
    "AGENT_BRIDGE_PROVIDER=gateway",
    "AGENT_BRIDGE_WORKSPACE=team",
    "AGENT_BRIDGE_URL=https://old.bridge.example.test",
    `AGENT_BRIDGE_TOKEN=${sourceToken}`,
    `AGENT_BRIDGE_EDGE_DB=${join(home, ".agent-bridge", "edge.sqlite3")}`,
    `AGENT_BRIDGE_CREDENTIAL_ID=${predecessorCredentialId}`,
    `AGENT_BRIDGE_PRINCIPAL=${identity}`,
    `AGENT_BRIDGE_CLIENT_INSTANCE=${instance}`,
    "",
  ].join("\n"), { mode: 0o600 });
  securePrivatePath(backendConfigPath, "file");
  const registration: Registration = { command: "agent-bridge-mcp", identity, instance, backendConfigPath };
  const execute = (_command: string, args: string[]) => ({
    pid: 1,
    output: [],
    stdout: args[0] === "mcp" && args[1] === "get" ? codexRegistration(registration) : "",
    stderr: "",
    status: 0,
    signal: null,
  });
  const adopted = adoptClient("codex", identity, {
    instance,
    backendConfigPath,
    apply: true,
    env,
  }, execute);
  const pending: EnrollmentFile = {
    schema: "agent-bridge.enrollment",
    version: 1,
    provider: "gateway",
    revision: 0,
    state: "pending",
    operation: "rotate",
    requestId: "019f7fd1-0000-7000-8000-000000000003",
    createdAt: new Date().toISOString(),
    completedAt: null,
    input: {
      gatewayUrl: "https://new.bridge.example.test",
      workspaceId: "team",
      principal: identity,
      runtime: "codex",
      instance,
      credentialId: predecessorCredentialId,
      workspaceName: null,
      displayName: null,
      runtimeType: "codex",
      label: null,
      scopeSetName: "runtime",
      expiresAt: null,
      graceUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
      invalidateImmediately: false,
    },
    token: successorToken,
    result: null,
  };
  const enrollmentFile = defaultEnrollmentPath(pending.requestId, env);
  createPendingEnrollment(enrollmentFile, pending, env);
  const enrollment = transitionEnrollment(enrollmentFile, pending, "ready", {
    completedAt: new Date().toISOString(),
    result: {
      workspaceId: "team",
      principal: identity,
      agentId: null,
      credentialId: successorCredentialId,
      replayed: false,
    },
  }, env);
  return {
    home, env, instance, identity, backendConfigPath, registration, execute, adopted,
    enrollmentFile, enrollment, sourceToken, successorToken, predecessorCredentialId, successorCredentialId,
  };
}

function rewriteEnrollment(
  path: string,
  env: NodeJS.ProcessEnv,
  change: (value: EnrollmentFile) => EnrollmentFile,
): void {
  writeFileSync(path, `${JSON.stringify(change(readEnrollment(path, env)))}\n`, { mode: 0o600 });
  securePrivatePath(path, "file");
}

describe("client migration target staging", () => {
  it("returns a byte-for-byte no-write plan", async () => {
    const state = fixture();
    const before = treeBytes(state.home);
    const plan = await stageClientMigrationTarget({
      runtime: "codex",
      identity: state.identity,
      instance: state.instance,
      enrollmentFile: state.enrollmentFile,
      env: state.env,
      execute: state.execute,
    });
    expect(plan).toMatchObject({ applied: false, sourceEdgeDatabasePath: join(state.home, ".agent-bridge", "edge.sqlite3") });
    expect(treeBytes(state.home)).toEqual(before);
    expect(existsSync(join(state.home, ".agent-bridge", "edge.sqlite3"))).toBe(false);
  });

  it("rejects incompatible rotation authority before it stages anything", async () => {
    const cases: Array<(value: EnrollmentFile, state: ReturnType<typeof fixture>) => EnrollmentFile> = [
      (value) => ({ ...value, input: { ...value.input, invalidateImmediately: true, graceUntil: null } }),
      (value) => ({ ...value, input: { ...value.input, gatewayUrl: "https://old.bridge.example.test" } }),
      (value) => ({ ...value, input: { ...value.input, workspaceId: "other" }, result: { ...value.result!, workspaceId: "other" } }),
      (value, state) => ({ ...value, result: { ...value.result!, credentialId: state.predecessorCredentialId } }),
    ];
    for (const change of cases) {
      const state = fixture();
      rewriteEnrollment(state.enrollmentFile, state.env, (value) => change(value, state));
      await expect(stageClientMigrationTarget({
        runtime: "codex", identity: state.identity, instance: state.instance,
        enrollmentFile: state.enrollmentFile, apply: true, env: state.env, execute: state.execute,
        verifySource: async () => {}, verifyTarget: async () => {},
      })).rejects.toThrow("rotation enrollment");
      expect(listClientOperations(state.env)).toEqual([]);
    }
  });

  it("requires both source and target gateway probes before it creates a journal", async () => {
    const sourceFailure = fixture();
    await expect(stageClientMigrationTarget({
      runtime: "codex", identity: sourceFailure.identity, instance: sourceFailure.instance,
      enrollmentFile: sourceFailure.enrollmentFile, apply: true, env: sourceFailure.env, execute: sourceFailure.execute,
      verifySource: async () => { throw new Error("principal_mismatch"); }, verifyTarget: async () => {},
    })).rejects.toThrow("principal_mismatch");
    expect(listClientOperations(sourceFailure.env)).toEqual([]);

    const targetFailure = fixture();
    await expect(stageClientMigrationTarget({
      runtime: "codex", identity: targetFailure.identity, instance: targetFailure.instance,
      enrollmentFile: targetFailure.enrollmentFile, apply: true, env: targetFailure.env, execute: targetFailure.execute,
      verifySource: async () => {}, verifyTarget: async () => { throw new Error("protocol_mismatch"); },
    })).rejects.toThrow("protocol_mismatch");
    expect(listClientOperations(targetFailure.env)).toEqual([]);
  });

  it("keeps the active client untouched while staging and consuming a verified rotate enrollment", async () => {
    const state = fixture();
    const activeBefore = readFileSync(state.backendConfigPath, "utf8");
    const metadataBefore = readFileSync(state.adopted.metadataPath, "utf8");
    const verified: Array<{ url: string; token: string }> = [];
    const plan = await stageClientMigrationTarget({
      runtime: "codex",
      identity: state.identity,
      instance: state.instance,
      enrollmentFile: state.enrollmentFile,
      apply: true,
      env: state.env,
      execute: state.execute,
      verifyTarget: async ({ url, token }) => { verified.push({ url, token }); },
      verifySource: async () => {},
    });
    expect(plan).toMatchObject({ action: "migrate-stage", applied: true, enrollmentStatus: "consumed-file-missing" });
    expect(verified).toEqual([
      { url: "https://new.bridge.example.test/", token: state.successorToken },
      { url: "https://new.bridge.example.test/", token: state.successorToken },
      { url: "https://new.bridge.example.test/", token: state.successorToken },
    ]);
    expect(readFileSync(state.backendConfigPath, "utf8")).toBe(activeBefore);
    expect(readFileSync(state.adopted.metadataPath, "utf8")).toBe(metadataBefore);
    expect(state.registration.backendConfigPath).toBe(state.backendConfigPath);
    expect(existsSync(state.enrollmentFile)).toBe(false);
    const staged = readFileSync(plan.targetBackendPath!, "utf8");
    const record = readFileSync(plan.stageRecordPath!, "utf8");
    expect(staged).toContain(`AGENT_BRIDGE_TOKEN=${state.successorToken}`);
    expect(record).not.toContain(state.successorToken);
    expect(record).not.toContain(state.sourceToken);
    const operation = listClientOperations(state.env)[0]!;
    expect(operation).toMatchObject({ schemaVersion: 5, operation: "migrate", inspectionState: "complete" });
    const manifest = readFileSync(join(state.home, ".agent-bridge", "operations", operation.operationId, "manifest.json"), "utf8");
    expect(manifest).not.toContain(state.successorToken);
    expect(manifest).not.toContain(state.sourceToken);
  });

  it("blocks consumption after target token drift and resumes only after the target is restored", async () => {
    const state = fixture();
    let probeCount = 0;
    await expect(stageClientMigrationTarget({
      runtime: "codex",
      identity: state.identity,
      instance: state.instance,
      enrollmentFile: state.enrollmentFile,
      apply: true,
      env: state.env,
      execute: state.execute,
      verifyTarget: async () => {
        probeCount += 1;
        if (probeCount !== 2) return;
        const [operation] = listClientOperations(state.env);
        const paths = stagedGatewayBackendPaths(operation!.operationId, state.env);
        const contents = readFileSync(paths.backendConfigPath, "utf8").replace(state.successorToken, "tampered-token");
        writeFileSync(paths.backendConfigPath, contents, { mode: 0o600 });
        securePrivatePath(paths.backendConfigPath, "file");
      },
      verifySource: async () => {},
    })).rejects.toThrow("staged backend credential no longer matches");
    const [operation] = listClientOperations(state.env);
    expect(operation).toMatchObject({ operation: "migrate", inspectionState: "resumable" });
    expect(readEnrollment(state.enrollmentFile, state.env)).toMatchObject({ state: "ready", token: state.successorToken });
    writeStagedGatewayBackendConfig("codex", state.identity, state.instance, operation!.operationId, {
      token: state.successorToken,
      gatewayUrl: "https://new.bridge.example.test",
      workspace: "team",
      credentialId: state.successorCredentialId,
      principal: state.identity,
      env: state.env,
    });
    await expect(resumeClientMigrationStage({
      operationId: operation!.operationId,
      env: state.env,
      execute: state.execute,
      verifyTarget: async () => {},
      verifySource: async () => {},
    })).resolves.toMatchObject({ applied: true, enrollmentStatus: "consumed-file-missing" });
  });

  it("refuses a manifest replacement before the stage-record write", async () => {
    const state = fixture();
    let targetProbe = 0;
    await expect(stageClientMigrationTarget({
      runtime: "codex", identity: state.identity, instance: state.instance,
      enrollmentFile: state.enrollmentFile, apply: true, env: state.env, execute: state.execute,
      verifySource: async () => {},
      verifyTarget: async () => {
        targetProbe += 1;
        if (targetProbe !== 2) return;
        const [operation] = listClientOperations(state.env);
        const manifestPath = join(state.home, ".agent-bridge", "operations", operation!.operationId, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { request: { predecessorGraceUntil: string } };
        manifest.request.predecessorGraceUntil = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
        securePrivatePath(manifestPath, "file");
      },
    })).rejects.toThrow("manifest changed before a staged write");
    const [operation] = listClientOperations(state.env);
    const paths = stagedGatewayBackendPaths(operation!.operationId, state.env);
    expect(existsSync(paths.backendConfigPath)).toBe(true);
    expect(existsSync(join(paths.directory, "stage.json"))).toBe(false);
    expect(readEnrollment(state.enrollmentFile, state.env)).toMatchObject({ state: "ready", token: state.successorToken });
  });

  it("resumes cleanup after enrollment deletion and grace expiry", async () => {
    const state = fixture();
    let targetProbe = 0;
    await expect(stageClientMigrationTarget({
      runtime: "codex", identity: state.identity, instance: state.instance,
      enrollmentFile: state.enrollmentFile, apply: true, env: state.env, execute: state.execute,
      verifySource: async () => {},
      verifyTarget: async () => {
        targetProbe += 1;
        if (targetProbe === 3) throw new Error("simulated crash before enrollment consumption");
      },
    })).rejects.toThrow("simulated crash before enrollment consumption");
    const [operation] = listClientOperations(state.env);
    expect(operation).toMatchObject({ operation: "migrate", inspectionState: "resumable" });

    const resumed = resumeClientOperation(operation!.operationId, state.env);
    let manifest = recordClientOperationStepIntent(
      operation!.operationId, resumed.manifest, 2, resumed.lock, state.env,
    );
    const enrollmentLock = acquireEnrollmentLock(state.enrollmentFile, state.env);
    let enrollment = readEnrollment(state.enrollmentFile, state.env);
    enrollment = transitionEnrollment(
      state.enrollmentFile, enrollment, "consuming", {}, state.env, enrollmentLock,
    );
    enrollment = transitionEnrollment(
      state.enrollmentFile, enrollment, "consumed", { token: null }, state.env, enrollmentLock,
    );
    deleteEnrollmentFile(state.enrollmentFile, enrollmentLock, state.env);
    manifest = recordClientOperationStepApplied(
      operation!.operationId, manifest, 2, JSON.stringify({ exists: false }), resumed.lock, state.env,
    );
    manifest = cleanupClientOperationArtifact(
      operation!.operationId, manifest, resumed.lock, state.env,
    );
    closeSync(enrollmentLock.descriptor);
    writeFileSync(enrollmentLock.lockPath, `${JSON.stringify({
      schema: "agent-bridge.enrollment-lock",
      version: 1,
      enrollmentPath: state.enrollmentFile,
      pid: 2_147_483_647,
      host: hostname(),
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      nonce: randomUUID(),
    })}\n`, { mode: 0o600 });
    securePrivatePath(enrollmentLock.lockPath, "file");
    releaseClientOperationLock(resumed.lock);

    expect(existsSync(state.enrollmentFile)).toBe(false);
    await expect(resumeClientMigrationStage({
      operationId: operation!.operationId,
      env: state.env,
      recoverLock: true,
      now: () => new Date(Date.now() + 2 * 60 * 60_000),
      verifySource: async () => { throw new Error("cleanup must not probe source"); },
      verifyTarget: async () => { throw new Error("cleanup must not probe target"); },
    })).resolves.toMatchObject({ applied: true, enrollmentStatus: "consumed-file-missing" });
    expect(listClientOperations(state.env)[0]).toMatchObject({ inspectionState: "complete" });
  });

  it("rejects relative, in-memory, and non-normalized source edge paths", async () => {
    const cases = [
      () => "relative-edge.sqlite3",
      () => ":memory:",
      (home: string) => `${home}/.agent-bridge/../.agent-bridge/edge.sqlite3`,
    ];
    for (const edgePathFor of cases) {
      const state = fixture();
      const edgePath = edgePathFor(state.home);
      const backend = readFileSync(state.backendConfigPath, "utf8")
        .replace(/^AGENT_BRIDGE_EDGE_DB=.*$/mu, `AGENT_BRIDGE_EDGE_DB=${edgePath}`);
      writeFileSync(state.backendConfigPath, backend, { mode: 0o600 });
      securePrivatePath(state.backendConfigPath, "file");
      await expect(stageClientMigrationTarget({
        runtime: "codex", identity: state.identity, instance: state.instance,
        enrollmentFile: state.enrollmentFile, apply: true, env: state.env, execute: state.execute,
        verifySource: async () => {}, verifyTarget: async () => {},
      })).rejects.toThrow("absolute normalized file path");
      expect(listClientOperations(state.env)).toEqual([]);
    }
  });

  it("rejects plan recovery and unsafe staged writer destinations", async () => {
    const state = fixture();
    await expect(stageClientMigrationTarget({
      runtime: "codex",
      identity: state.identity,
      instance: state.instance,
      enrollmentFile: state.enrollmentFile,
      recoverLock: true,
      env: state.env,
      execute: state.execute,
      verifySource: async () => {},
    })).rejects.toThrow("--recover-lock requires --apply");
    expect(() => stagedGatewayBackendPaths("not-a-uuid", state.env)).toThrow("operation ID is invalid");
    if (process.platform === "win32") return;
    const operationId = randomUUID();
    const paths = stagedGatewayBackendPaths(operationId, state.env);
    const root = join(state.home, ".agent-bridge", "client-migrations");
    mkdirSync(root, { recursive: true, mode: 0o700 }); securePrivatePath(root, "directory");
    const outside = privateTestDirectory("agent-bridge-stage-outside-"); homes.push(outside);
    symlinkSync(outside, paths.directory, "dir");
    expect(() => writeStagedGatewayBackendConfig("codex", state.identity, state.instance, operationId, {
      token: state.successorToken,
      gatewayUrl: "https://new.bridge.example.test",
      workspace: "team",
      credentialId: state.successorCredentialId,
      principal: state.identity,
      env: state.env,
    })).toThrow();
    expect(existsSync(join(outside, "target.config"))).toBe(false);
  });
});
