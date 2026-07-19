import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireClientOperationLock,
  createClientOperation,
  recoverClientOperationLock,
} from "../src/client-operation.js";
import {
  acquireEnrollmentLock,
  createPendingEnrollment,
  defaultEnrollmentPath,
  recoverEnrollmentLock,
  type EnrollmentFile,
} from "../src/enrollment-file.js";
import { securePrivatePath, verifyPrivatePathAccess } from "../src/private-path.js";

const roots: string[] = [];
const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cli = join(packageRoot, "bin", "agent-bridge");
const nativeTestTimeout = 90_000;

function root(prefix: string): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  roots.push(home);
  securePrivatePath(home, "directory");
  return { home, env: { HOME: home } };
}

function runCli(home: string, database: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      NODE_NO_WARNINGS: "1",
      AGENT_BRIDGE_PROVIDER: "local",
      AGENT_BRIDGE_DB: database,
      ...extra,
    },
  });
}

function enrollment(requestId: string): EnrollmentFile {
  return {
    schema: "agent-bridge.enrollment",
    version: 1,
    provider: "gateway",
    revision: 0,
    state: "pending",
    operation: "provision",
    requestId,
    createdAt: new Date(0).toISOString(),
    completedAt: null,
    input: {
      gatewayUrl: "https://bridge.example.test",
      workspaceId: "team",
      principal: "codex",
      runtime: "codex",
      instance: "codex-native-smoke",
      credentialId: null,
      workspaceName: "Team",
      displayName: null,
      runtimeType: "codex",
      label: null,
      scopeSetName: "release-a-full",
      expiresAt: null,
      graceUntil: null,
      invalidateImmediately: false,
    },
    token: "native-smoke-token",
    result: null,
  };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Windows native private path smoke", () => {
  it.skipIf(process.platform !== "win32")("uses public CLI private-file boundaries for local authority, archive, DR, and operation reading", () => {
    const { home, env } = root("agent-bridge-native-cli-");
    const database = join(home, "bridge.sqlite3");
    const config = join(home, ".agent-bridge", "config");
    const cursor = join(home, "watch.cursor");
    const archive = join(home, "workspace.ndjson");
    const bundle = join(home, "backup.abdr");

    const initialized = runCli(home, database, ["init", "--provider", "local", "--db", database]);
    expect(initialized.status, initialized.stderr).toBe(0);
    expect(initialized.stderr).toBe("");
    expect(JSON.parse(initialized.stdout)).toEqual({
      status: "ok",
      config,
      provider: "local",
      workspace: "default",
      identity: "process-scoped",
      database,
    });
    verifyPrivatePathAccess(config, "file");

    const sent = runCli(home, database, ["send", "--source", "codex", "native CLI smoke"]);
    expect(sent.status, sent.stderr).toBe(0);
    expect(sent.stderr).toBe("");
    expect(JSON.parse(sent.stdout)).toMatchObject({
      created: true,
      message: { source: "codex", content: "native CLI smoke" },
    });
    verifyPrivatePathAccess(database, "file");

    const watched = runCli(home, database, ["watch", "--as", "worker", "--polls", "1"], {
      AGENT_BRIDGE_CURSOR: cursor,
    });
    expect(watched.status, watched.stderr).toBe(0);
    expect(watched.stderr).toBe("");
    expect(JSON.parse(watched.stdout)).toMatchObject({ source: "codex", content: "native CLI smoke" });
    expect(readFileSync(cursor, "utf8").trim()).not.toBe("");
    verifyPrivatePathAccess(cursor, "file");

    const exported = runCli(home, database, [
      "archive", "export", "--provider", "local", "--workspace", "default", "--db", database,
      "--output", archive, "--request-id", "00000000-0000-4000-8000-0000000000aa",
    ]);
    expect(exported.status, exported.stderr).toBe(0);
    expect(exported.stderr).toBe("");
    expect(JSON.parse(exported.stdout)).toMatchObject({
      schemaVersion: 1,
      status: "ok",
      operation: "export",
      provider: "local",
      requestId: "00000000-0000-4000-8000-0000000000aa",
      workspace: "default",
      messages: 1,
      receipts: 0,
    });
    verifyPrivatePathAccess(archive, "file");

    const archiveVerified = runCli(home, database, ["archive", "verify", "--file", archive]);
    expect(archiveVerified.status, archiveVerified.stderr).toBe(0);
    expect(archiveVerified.stderr).toBe("");
    expect(JSON.parse(archiveVerified.stdout)).toMatchObject({
      schemaVersion: 1,
      status: "ok",
      operation: "verify",
      exportRequestId: "00000000-0000-4000-8000-0000000000aa",
      workspace: "default",
      messages: 1,
      receipts: 0,
    });

    const backedUp = runCli(home, database, [
      "dr", "backup", "--provider", "local", "--source", database, "--output", bundle,
      "--backup-id", "018f4a70-0000-7000-8000-000000000221", "--timeout-ms", "30000",
    ]);
    expect(backedUp.status, backedUp.stderr).toBe(0);
    expect(backedUp.stderr).toBe("");
    expect(JSON.parse(backedUp.stdout)).toMatchObject({
      status: "ok",
      operation: "backup",
      provider: "local",
      backupId: "018f4a70-0000-7000-8000-000000000221",
    });
    verifyPrivatePathAccess(bundle, "file");

    const drVerified = runCli(home, database, ["dr", "verify", "--provider", "local", "--bundle", bundle]);
    expect(drVerified.status, drVerified.stderr).toBe(0);
    expect(drVerified.stderr).toBe("");
    expect(JSON.parse(drVerified.stdout)).toMatchObject({
      status: "ok",
      operation: "verify",
      backupId: "018f4a70-0000-7000-8000-000000000221",
    });

    const operationId = "11111111-1111-4111-8111-111111111111";
    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
    createClientOperation({
      operationId,
      request: { kind: "repair" },
      runtime: "codex",
      instance: "native-smoke",
      steps: [{
        target: "registration",
        locator: "codex:profile:default",
        beforeArtifact: "registration.before",
        afterArtifact: "registration.after",
        expectedBeforeSha256: sha256("before"),
        expectedAfterSha256: sha256("after"),
      }],
    }, env);
    const operations = runCli(home, database, ["clients", "operations"]);
    expect(operations.status, operations.stderr).toBe(0);
    expect(operations.stderr).toBe("");
    expect(JSON.parse(operations.stdout)).toMatchObject({
      schemaVersion: 2,
      operations: [{
        operationId,
        operation: "repair",
        runtime: "codex",
        instance: "native-smoke",
        state: "prepared",
      }],
    });
  }, nativeTestTimeout);

  it.skipIf(process.platform !== "win32")("recovers an enrollment subsystem lock through the native policy", () => {
    const { home, env } = root("agent-bridge-native-enrollment-");
    const pending = enrollment(randomUUID());
    const path = defaultEnrollmentPath(pending.requestId, env);
    createPendingEnrollment(path, pending, env);
    const lock = acquireEnrollmentLock(path, env);
    const metadata = JSON.parse(readFileSync(lock.lockPath, "utf8"));
    metadata.pid = 2_147_483_647;
    metadata.createdAt = new Date(0).toISOString();
    writeFileSync(lock.lockPath, JSON.stringify(metadata));
    closeSync(lock.descriptor);
    lock.released = true;
    recoverEnrollmentLock(path, env);
    expect(existsSync(lock.lockPath)).toBe(false);
  }, nativeTestTimeout);

  it.skipIf(process.platform !== "win32")("recovers a client-operation subsystem lock through the native policy", () => {
    const { env } = root("agent-bridge-native-operation-");
    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
    createClientOperation({
      operationId: "11111111-1111-4111-8111-111111111111",
      request: { kind: "repair" },
      runtime: "codex",
      instance: "native-smoke",
      steps: [{
        target: "registration",
        locator: "codex:profile:default",
        beforeArtifact: "registration.before",
        afterArtifact: "registration.after",
        expectedBeforeSha256: sha256("before"),
        expectedAfterSha256: sha256("after"),
      }],
    }, env);
    const lock = acquireClientOperationLock("codex", "native-smoke", env);
    const metadata = JSON.parse(readFileSync(lock.lockPath, "utf8"));
    metadata.pid = 2_147_483_647;
    metadata.createdAt = new Date(0).toISOString();
    writeFileSync(lock.lockPath, JSON.stringify(metadata));
    closeSync(lock.descriptor);
    lock.released = true;
    recoverClientOperationLock("codex", "native-smoke", env, Date.now());
    expect(existsSync(lock.lockPath)).toBe(false);
  }, nativeTestTimeout);
});
