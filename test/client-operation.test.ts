import {
  chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect } from "vitest";
import {
  acquireClientOperationLock, ClientOperationError, createClientOperation,
  beginClientOperation, cleanupClientOperationArtifact, completeClientOperationCleanup,
  classifyClientOperationRestart, type ClientOperationFilesystem,
  inspectClientOperation, listClientOperations, readClientOperation,
  recordClientOperationStepApplied, recordClientOperationStepIntent,
  recoverClientOperationLock, releaseClientOperationLock, resumeClientOperation, transitionClientOperation,
  validateClientOperation, writeClientOperationSnapshot, type ClientOperationRequest,
} from "../src/client-operation.js";
import { securePrivatePath } from "../src/private-path.js";
import { privatePathIt } from "./private-path-policy.js";

const it = privatePathIt;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "agent-bridge-operation-")); roots.push(home);
  securePrivatePath(home, "directory");
  return { home, env: { HOME: home } };
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const updateRequest: ClientOperationRequest = {
  kind: "update" as const,
  identity: "test-worker",
  launch: {
    command: "agent-bridge-mcp", args: [], scope: null,
    envKeys: ["AGENT_BRIDGE_AGENT", "AGENT_BRIDGE_CONFIG", "AGENT_BRIDGE_INSTANCE"],
  },
};
function operation(env: NodeJS.ProcessEnv) {
  return createClientOperation({
    operationId: "11111111-1111-4111-8111-111111111111",
    request: updateRequest, runtime: "codex", instance: "stable-client", steps: [
      { target: "registration", locator: "codex:profile:default", beforeArtifact: "registration.before", afterArtifact: "registration.after", expectedBeforeSha256: sha256("before-registration"), expectedAfterSha256: sha256("after-registration") },
      { target: "backend", locator: "backend:managed", beforeArtifact: "backend.before", afterArtifact: "backend.after", expectedBeforeSha256: sha256("before-backend"), expectedAfterSha256: sha256("after-backend") },
      { target: "metadata", locator: "management:stable-client", beforeArtifact: "metadata.before", afterArtifact: "metadata.after", expectedBeforeSha256: sha256("before-metadata"), expectedAfterSha256: sha256("after-metadata") },
    ],
  }, env);
}
function injected(hook: ClientOperationFilesystem["hook"], overrides: Partial<ClientOperationFilesystem> = {}): ClientOperationFilesystem {
  return {
    hook,
    link: (source, target) => { linkSync(source, target); },
    rename: renameSync,
    remove: (path, options) => rmSync(path, options),
    syncDirectory: () => {},
    ...overrides,
  };
}

describe("managed client operation substrate", () => {
  it("durably advances an immutable ordered plan across exact crash boundaries", () => {
    const { home, env } = fixture();
    let manifest = operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    manifest = writeClientOperationSnapshot(manifest.operationId, manifest, "registration.before", "before-registration", lock, env);
    manifest = writeClientOperationSnapshot(manifest.operationId, manifest, "backend.before", "before-backend", lock, env);
    manifest = writeClientOperationSnapshot(manifest.operationId, manifest, "metadata.before", "before-metadata", lock, env);
    expect(manifest).toMatchObject({ state: "prepared", revision: 3 });
    manifest = transitionClientOperation(manifest.operationId, manifest, "snapshotted", lock, env);
    expect(classifyClientOperationRestart(manifest, manifest.steps[0].expectedAfterSha256))
      .toMatchObject({ stepIndex: 0, disposition: "blocked" });
    manifest = recordClientOperationStepIntent(manifest.operationId, manifest, 0, lock, env);
    expect(inspectClientOperation(manifest.operationId, env)).toMatchObject({ state: "in-progress", recoverable: true, pendingStep: 0 });
    expect(classifyClientOperationRestart(manifest, manifest.steps[0].expectedBeforeSha256)).toMatchObject({ stepIndex: 0, disposition: "retryable" });
    expect(classifyClientOperationRestart(manifest, manifest.steps[0].expectedAfterSha256)).toMatchObject({ stepIndex: 0, disposition: "advance" });
    expect(classifyClientOperationRestart(manifest, "f".repeat(64))).toMatchObject({ stepIndex: 0, disposition: "blocked" });
    manifest = recordClientOperationStepApplied(manifest.operationId, manifest, 0, "after-registration", lock, env);
    expect(manifest).toMatchObject({ state: "in-progress", revision: 6, steps: [{ state: "observed-applied" }, { state: "pending" }, { state: "pending" }] });
    expect(releaseClientOperationLock(lock)).toBe("released");

    const directory = join(home, ".agent-bridge", "operations", manifest.operationId);
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o077).toBe(0);
      expect(statSync(join(directory, "manifest.json")).mode & 0o077).toBe(0);
      expect(statSync(join(directory, "snapshots", "registration.before")).mode & 0o077).toBe(0);
    }
  });

  it("serializes operations per runtime and stable instance", () => {
    const { env } = fixture(); operation(env);
    const first = acquireClientOperationLock("codex", "stable-client", env);
    expect(() => acquireClientOperationLock("codex", "stable-client", env)).toThrowError(ClientOperationError);
    const otherRuntime = acquireClientOperationLock("claude-code", "stable-client", env);
    const otherInstance = acquireClientOperationLock("codex", "other-client", env);
    releaseClientOperationLock(otherRuntime); releaseClientOperationLock(otherInstance); releaseClientOperationLock(first);
  });

  it("recovers only stale same-host locks with proof that the process stopped", () => {
    const { home, env } = fixture(); operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    expect(() => recoverClientOperationLock("codex", "stable-client", env, Date.now() + 120_000)).toThrow("still running");
    // Close the descriptor to model a crashed owner, then replace only the PID metadata.
    // The test uses a guaranteed-unusable large PID; ESRCH is the required proof.
    const metadata = JSON.parse(readFileSync(lock.lockPath, "utf8"));
    metadata.pid = 2_147_483_647; metadata.host = hostname(); metadata.createdAt = new Date(0).toISOString();
    writeFileSync(lock.lockPath, JSON.stringify(metadata), { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(lock.lockPath, 0o600);
    recoverClientOperationLock("codex", "stable-client", env, Date.now());
    expect(existsSync(lock.lockPath)).toBe(false);
    // Avoid release: recovery deliberately removed the lock held by this test descriptor.
    expect(home).toBeTruthy();
  });

  it("pins operation-root and locks identities throughout stale-lock recovery", () => {
    if (process.platform === "win32") return;
    const { home, env } = fixture(); operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    const metadata = JSON.parse(readFileSync(lock.lockPath, "utf8"));
    metadata.pid = 2_147_483_647; metadata.host = hostname(); metadata.createdAt = new Date(0).toISOString();
    writeFileSync(lock.lockPath, JSON.stringify(metadata), { mode: 0o600 }); chmodSync(lock.lockPath, 0o600);
    const locks = join(home, ".agent-bridge", "operations", "locks");
    const original = join(home, "original-locks");
    const external = join(home, "external-locks");
    mkdirSync(external, { mode: 0o700 }); securePrivatePath(external, "directory");
    const externalLock = join(external, basename(lock.lockPath));
    writeFileSync(externalLock, "do-not-remove", { mode: 0o600 });
    const filesystem = injected((event) => {
      if (event === "before-lock-remove") { renameSync(locks, original); renameSync(external, locks); }
    });
    expect(() => recoverClientOperationLock("codex", "stable-client", env, Date.now(), filesystem)).toThrow("operation directory changed");
    expect(readFileSync(join(locks, basename(lock.lockPath)), "utf8")).toBe("do-not-remove");
  });

  it("fails closed for linked, replaced, corrupt, and ambiguous state", () => {
    if (process.platform === "win32") return;
    const { home, env } = fixture(); const manifest = operation(env);
    const directory = join(home, ".agent-bridge", "operations", manifest.operationId);
    const external = join(home, "external"); mkdirSync(external, { mode: 0o700 }); securePrivatePath(external, "directory");
    renameSync(join(directory, "snapshots"), join(external, "snapshots"));
    symlinkSync(join(external, "snapshots"), join(directory, "snapshots"), "dir");
    expect(() => readClientOperation(manifest.operationId, env)).not.toThrow();
    expect(inspectClientOperation(manifest.operationId, env)).toMatchObject({ state: "corrupt", recoverable: false });

    rmSync(join(directory, "snapshots")); renameSync(join(external, "snapshots"), join(directory, "snapshots"));
    writeFileSync(join(directory, "manifest.json"), "not-json", { mode: 0o600 });
    expect(inspectClientOperation(manifest.operationId, env)).toMatchObject({ state: "corrupt", reason: "operation state is corrupt or insecure" });
  });

  it("detects lock replacement before transition or release", () => {
    const { env } = fixture(); const manifest = operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    const moved = `${lock.lockPath}.moved`; renameSync(lock.lockPath, moved);
    writeFileSync(lock.lockPath, "replacement", { mode: 0o600 });
    expect(() => transitionClientOperation(manifest.operationId, manifest, "snapshotted", lock, env)).toThrow("client lock changed");
    expect(() => releaseClientOperationLock(lock)).toThrow("client lock changed");
  });

  it("returns only safe summaries and never snapshot contents", () => {
    const { env } = fixture();
    const secret = "AGENT_BRIDGE_TOKEN=top-secret";
    let manifest = createClientOperation({
      operationId: "33333333-3333-4333-8333-333333333333",
      request: updateRequest, runtime: "codex", instance: "stable-client", steps: [
        { target: "backend", locator: "backend:managed", beforeArtifact: "backend.before", afterArtifact: "backend.after", expectedBeforeSha256: sha256(secret), expectedAfterSha256: sha256("after-backend") },
      ],
    }, env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    manifest = writeClientOperationSnapshot(manifest.operationId, manifest, "backend.before", secret, lock, env);
    const summary = inspectClientOperation(manifest.operationId, env);
    const listed = listClientOperations(env);
    expect(JSON.stringify({ summary, listed })).not.toContain("top-secret");
    expect(JSON.stringify({ summary, listed })).not.toContain("AGENT_BRIDGE_TOKEN");
    expect(summary.artifacts[0]).toMatchObject({ name: "backend.before", bytes: 29 });
    releaseClientOperationLock(lock);
  });

  it("rejects a dangling operation-root link", () => {
    if (process.platform === "win32") return;
    const { home, env } = fixture();
    mkdirSync(join(home, ".agent-bridge"), { mode: 0o700 });
    symlinkSync(join(home, "missing-target"), join(home, ".agent-bridge", "operations"), "dir");
    expect(() => operation(env)).toThrow("operation paths cannot contain links");
  });

  it("pins the snapshots directory across enumeration and leaves swapped ancestry untouched", () => {
    if (process.platform === "win32") return;
    const { home, env } = fixture(); let manifest = operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    manifest = writeClientOperationSnapshot(manifest.operationId, manifest, "registration.before", "before-registration", lock, env);
    const operationPath = join(home, ".agent-bridge", "operations", manifest.operationId);
    const original = join(home, "original-snapshots");
    const external = join(home, "external-snapshots");
    mkdirSync(external, { mode: 0o700 }); securePrivatePath(external, "directory");
    writeFileSync(join(external, "do-not-touch"), "preserve", { mode: 0o600 });
    let swapped = false;
    const filesystem = injected((event) => {
      if (event === "after-snapshot-directory-read" && !swapped) {
        swapped = true;
        renameSync(join(operationPath, "snapshots"), original);
        renameSync(external, join(operationPath, "snapshots"));
      }
    });
    expect(inspectClientOperation(manifest.operationId, env, filesystem)).toMatchObject({ state: "corrupt" });
    expect(readFileSync(join(operationPath, "snapshots", "do-not-touch"), "utf8")).toBe("preserve");
  });

  it("reports ambiguous durable state when directory sync fails after rename", () => {
    const { home, env } = fixture(); const manifest = operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    const filesystem = injected(() => {}, {
      syncDirectory: (path) => { if (path.endsWith("snapshots")) throw new Error("injected sync failure"); },
    });
    expect(() => writeClientOperationSnapshot(manifest.operationId, manifest, "registration.before", "before-registration", lock, env, filesystem)).toThrow("could not be published durably");
    expect(existsSync(join(home, ".agent-bridge", "operations", manifest.operationId, "snapshots", "registration.before"))).toBe(true);
    expect(inspectClientOperation(manifest.operationId, env)).toMatchObject({ state: "corrupt" });
  });

  it("leaves external files unchanged when a publish directory is swapped", () => {
    if (process.platform === "win32") return;
    const { home, env } = fixture(); const manifest = operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    const snapshots = join(home, ".agent-bridge", "operations", manifest.operationId, "snapshots");
    const original = join(home, "publish-original");
    const external = join(home, "publish-external");
    mkdirSync(external, { mode: 0o700 }); securePrivatePath(external, "directory");
    writeFileSync(join(external, "do-not-touch"), "preserve", { mode: 0o600 });
    let swapped = false;
    const filesystem = injected((event, path) => {
      if (event === "before-publish-link" && path.endsWith("registration.before") && !swapped) {
        swapped = true; renameSync(snapshots, original); renameSync(external, snapshots);
      }
    });
    expect(() => writeClientOperationSnapshot(manifest.operationId, manifest, "registration.before", "before-registration", lock, env, filesystem)).toThrow("operation directory changed");
    expect(readFileSync(join(snapshots, "do-not-touch"), "utf8")).toBe("preserve");
    expect(existsSync(join(snapshots, "registration.before"))).toBe(false);
  });

  it("blocks after snapshot creation when manifest publication fails", () => {
    const { home, env } = fixture(); const manifest = operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    const filesystem = injected((event, path) => {
      if (event === "before-publish-rename" && path.endsWith("manifest.json")) throw new Error("injected manifest failure");
    });
    expect(() => writeClientOperationSnapshot(manifest.operationId, manifest, "registration.before", "before-registration", lock, env, filesystem)).toThrow("snapshot publication left ambiguous");
    expect(existsSync(join(home, ".agent-bridge", "operations", manifest.operationId, "snapshots", "registration.before"))).toBe(true);
    expect(inspectClientOperation(manifest.operationId, env)).toMatchObject({ state: "corrupt", recoverable: false });
  });

  it("never overwrites an unrecorded snapshot left by a failed manifest publication", () => {
    const { home, env } = fixture(); const manifest = operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    const filesystem = injected((event, path) => {
      if (event === "before-publish-rename" && path.endsWith("manifest.json")) {
        throw new Error("injected manifest failure");
      }
    });
    expect(() => writeClientOperationSnapshot(
      manifest.operationId, manifest, "registration.before", "before-registration", lock, env, filesystem,
    )).toThrow("snapshot publication left ambiguous");
    const snapshot = join(home, ".agent-bridge", "operations", manifest.operationId, "snapshots", "registration.before");
    expect(readFileSync(snapshot, "utf8")).toBe("before-registration");
    expect(() => writeClientOperationSnapshot(
      manifest.operationId, manifest, "registration.before", "after-registration", lock, env,
    )).toThrow("snapshot does not match");
    expect(() => writeClientOperationSnapshot(
      manifest.operationId, manifest, "registration.before", "before-registration", lock, env,
    )).toThrow("already exists outside the durable manifest");
    expect(readFileSync(snapshot, "utf8")).toBe("before-registration");
  });

  it("requires every ordered step snapshot before external writes can begin", () => {
    const { env } = fixture(); let manifest = operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    manifest = writeClientOperationSnapshot(
      manifest.operationId, manifest, "registration.before", "before-registration", lock, env,
    );
    expect(() => transitionClientOperation(manifest.operationId, manifest, "snapshotted", lock, env))
      .toThrow("durable snapshot for every ordered step");
  });

  it("rejects contradictory manifest and step states", () => {
    const { env } = fixture(); const manifest = operation(env);
    expect(() => validateClientOperation({ ...manifest, state: "committed" })).toThrow("manifest is corrupt");
    expect(() => validateClientOperation({ ...manifest, state: "rolled-back" })).toThrow("manifest is corrupt");
    expect(() => validateClientOperation({
      ...manifest,
      steps: manifest.steps.map((step, index) => index === 0 ? {
        ...step,
        state: "observed-applied",
        intentRecordedAt: new Date(0).toISOString(),
        observedAppliedAt: new Date(1).toISOString(),
      } : step),
    })).toThrow("manifest is corrupt");
    expect(() => validateClientOperation({
      ...manifest,
      artifacts: [{ ...manifest.artifacts[0], name: "registration.before", stepIndex: 0, phase: "before", bytes: 16 * 1024 * 1024 + 1, sha256: manifest.steps[0].expectedBeforeSha256, cleanupIntentAt: null, removedAt: null, directoryDurability: null }],
    })).toThrow("manifest is corrupt");
    expect(() => validateClientOperation({
      ...manifest,
      artifacts: [{ name: "registration.before", stepIndex: 0, phase: "before", bytes: 1, sha256: "f".repeat(64), cleanupIntentAt: null, removedAt: null, directoryDurability: null }],
    })).toThrow("manifest is corrupt");
    expect(() => validateClientOperation({
      ...manifest,
      steps: Array.from({ length: 129 }, (_, index) => ({
        ...manifest.steps[0], index, beforeArtifact: `before-${index}.json`, afterArtifact: `after-${index}.json`,
      })),
    })).toThrow("manifest is corrupt");
  });

  it("rejects removed cleanup artifacts without a durability result", () => {
    const { env } = fixture();
    const created = createClientOperation({
      request: { kind: "repair", identity: "test-worker" }, runtime: "codex", instance: "one",
      steps: [{ target: "metadata", locator: "management:one", beforeArtifact: "one.before", afterArtifact: "one.after", expectedBeforeSha256: sha256("before"), expectedAfterSha256: sha256("after") }],
    }, env);
    const now = new Date().toISOString();
    const steps = created.steps.map((step) => ({
      ...step, state: "observed-applied" as const, intentRecordedAt: now, observedAppliedAt: now,
    }));
    const artifacts = [
      { name: "one.before", stepIndex: 0, phase: "before" as const, bytes: 6, sha256: sha256("before"), cleanupIntentAt: now, removedAt: now, directoryDurability: "durable" as const },
      { name: "one.after", stepIndex: 0, phase: "after" as const, bytes: 5, sha256: sha256("after"), cleanupIntentAt: now, removedAt: now, directoryDurability: "durable" as const },
    ];
    expect(() => validateClientOperation({ ...created, state: "cleaning", steps, artifacts })).not.toThrow();
    expect(() => validateClientOperation({
      ...created, state: "cleaning", steps,
      artifacts: artifacts.map((artifact, index) => index === 0 ? { ...artifact, directoryDurability: null } : artifact),
    })).toThrow("manifest is corrupt");
  });

  it("accepts the maximum plan and artifact counts", () => {
    const { env } = fixture(); const created = operation(env); const now = new Date().toISOString();
    const steps = Array.from({ length: 128 }, (_, index) => ({
      index, target: "metadata" as const, locator: `management:item-${index}`,
      beforeArtifact: `item-${index}.before`, afterArtifact: `item-${index}.after`,
      expectedBeforeSha256: sha256(`before-${index}`), expectedAfterSha256: sha256(`after-${index}`),
      state: "observed-applied" as const, intentRecordedAt: now, observedAppliedAt: now,
    }));
    const artifacts = steps.flatMap((step) => [
      { name: step.beforeArtifact, stepIndex: step.index, phase: "before" as const, bytes: 1, sha256: step.expectedBeforeSha256, cleanupIntentAt: null, removedAt: null, directoryDurability: null },
      { name: step.afterArtifact, stepIndex: step.index, phase: "after" as const, bytes: 1, sha256: step.expectedAfterSha256, cleanupIntentAt: null, removedAt: null, directoryDurability: null },
    ]);
    const validated = validateClientOperation({ ...created, state: "applied", steps, artifacts });
    expect(validated.steps).toHaveLength(128);
    expect(validated.artifacts).toHaveLength(256);
  });

  it("preserves recoverable residue when manifest publication and cleanup both fail", () => {
    const { home, env } = fixture();
    const filesystem = injected((event) => {
      if (event === "after-snapshots-created") throw new Error("injected manifest publication failure");
    }, { remove: () => { throw new Error("injected cleanup failure"); } });
    expect(() => createClientOperation({
      operationId: "22222222-2222-4222-8222-222222222222", request: { kind: "repair", identity: "test-worker" }, runtime: "codex", instance: "stable-client",
      steps: [{ target: "metadata", locator: "management:stable-client", beforeArtifact: "metadata.before", afterArtifact: "metadata.after", expectedBeforeSha256: "1".repeat(64), expectedAfterSha256: "2".repeat(64) }],
    }, env, filesystem)).toThrow("injected manifest publication failure");
    expect(existsSync(join(home, ".agent-bridge", "operations", "22222222-2222-4222-8222-222222222222", "snapshots"))).toBe(true);
  });

  it("preserves a published manifest when operation-root durability is uncertain", () => {
    const { home, env } = fixture();
    const filesystem = injected(() => {}, {
      syncDirectory: (path) => { if (path.endsWith(join(".agent-bridge", "operations"))) throw new Error("injected root sync failure"); },
    });
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(() => createClientOperation({
      operationId, request: { kind: "repair", identity: "test-worker" }, runtime: "codex", instance: "stable-client",
      steps: [{ target: "metadata", locator: "management:stable-client", beforeArtifact: "metadata.before", afterArtifact: "metadata.after", expectedBeforeSha256: sha256("before"), expectedAfterSha256: sha256("after") }],
    }, env, filesystem)).toThrow("injected root sync failure");
    expect(readClientOperation(operationId, env)).toMatchObject({ operationId, state: "prepared" });
  });

  it("identifies registration, backend, and metadata as the exact pending crash step", () => {
    const { env } = fixture(); let manifest = operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    for (const [artifact, contents] of [["registration.before", "before-registration"], ["backend.before", "before-backend"], ["metadata.before", "before-metadata"]]) {
      manifest = writeClientOperationSnapshot(manifest.operationId, manifest, artifact, contents, lock, env);
    }
    manifest = transitionClientOperation(manifest.operationId, manifest, "snapshotted", lock, env);
    for (let index = 0; index < 3; index += 1) {
      manifest = recordClientOperationStepIntent(manifest.operationId, manifest, index, lock, env);
      expect(classifyClientOperationRestart(manifest, manifest.steps[index].expectedBeforeSha256)).toMatchObject({ stepIndex: index, disposition: "retryable" });
      manifest = recordClientOperationStepApplied(manifest.operationId, manifest, index, ["after-registration", "after-backend", "after-metadata"][index], lock, env);
    }
    expect(manifest.state).toBe("applied");
    expect(classifyClientOperationRestart(manifest, "0".repeat(64))).toMatchObject({ stepIndex: null, disposition: "complete" });
  });

  it("begins under the client lock and refuses another unfinished operation", () => {
    const { env } = fixture();
    const input = {
      operationId: "44444444-4444-4444-8444-444444444444", request: { kind: "repair", identity: "test-worker" } as const,
      runtime: "codex" as const, instance: "stable-client",
      steps: [{ target: "metadata" as const, locator: "management:stable-client", beforeArtifact: "metadata.before", afterArtifact: "metadata.after", expectedBeforeSha256: sha256("before"), expectedAfterSha256: sha256("after") }],
    };
    const begun = beginClientOperation(input, env);
    expect(() => beginClientOperation({ ...input, operationId: "55555555-5555-4555-8555-555555555555" }, env)).toThrow("client lock");
    releaseClientOperationLock(begun.lock);
    expect(() => beginClientOperation({ ...input, operationId: "55555555-5555-4555-8555-555555555555" }, env)).toThrow("unfinished operation");
  });

  it("enforces same-host resume and reports explicit inspection states", () => {
    const { home, env } = fixture(); const manifest = operation(env);
    expect(inspectClientOperation(manifest.operationId, env)).toMatchObject({ inspectionState: "resumable" });
    const path = join(home, ".agent-bridge", "operations", manifest.operationId, "manifest.json");
    const changed = JSON.parse(readFileSync(path, "utf8")); changed.host = "another-host.invalid";
    writeFileSync(path, `${JSON.stringify(changed, null, 2)}\n`, { mode: 0o600 });
    expect(inspectClientOperation(manifest.operationId, env)).toMatchObject({ inspectionState: "blocked" });
    expect(() => resumeClientOperation(manifest.operationId, env)).toThrow("creating host");
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    expect(() => writeClientOperationSnapshot(
      manifest.operationId, manifest, "registration.before", "before-registration", lock, env,
    )).toThrow("creating host");
    releaseClientOperationLock(lock);
  });

  it("replays an exact no-replace after artifact after a manifest crash", () => {
    const { env } = fixture(); let manifest = operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    for (const [artifact, contents] of [["registration.before", "before-registration"], ["backend.before", "before-backend"], ["metadata.before", "before-metadata"]]) {
      manifest = writeClientOperationSnapshot(manifest.operationId, manifest, artifact, contents, lock, env);
    }
    manifest = transitionClientOperation(manifest.operationId, manifest, "snapshotted", lock, env);
    manifest = recordClientOperationStepIntent(manifest.operationId, manifest, 0, lock, env);
    let crashed = false;
    const filesystem = injected((event, path) => {
      if (!crashed && event === "before-publish-rename" && path.endsWith("manifest.json")) { crashed = true; throw new Error("crash"); }
    });
    expect(() => recordClientOperationStepApplied(manifest.operationId, manifest, 0, "after-registration", lock, env, filesystem)).toThrow("ambiguous");
    releaseClientOperationLock(lock);
    expect(inspectClientOperation(manifest.operationId, env)).toMatchObject({ inspectionState: "classification-required" });
    const resumed = resumeClientOperation(manifest.operationId, env);
    manifest = recordClientOperationStepApplied(manifest.operationId, resumed.manifest, 0, "after-registration", resumed.lock, env);
    expect(manifest.steps[0].state).toBe("observed-applied");
    releaseClientOperationLock(resumed.lock);
  });

  it("resumes per-artifact cleanup after unlink and retains a safe completion record", () => {
    const { env } = fixture(); let manifest = operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    for (const [artifact, before] of [["registration.before", "before-registration"], ["backend.before", "before-backend"], ["metadata.before", "before-metadata"]]) {
      manifest = writeClientOperationSnapshot(manifest.operationId, manifest, artifact, before, lock, env);
    }
    manifest = transitionClientOperation(manifest.operationId, manifest, "snapshotted", lock, env);
    for (const [index, after] of ["after-registration", "after-backend", "after-metadata"].entries()) {
      manifest = recordClientOperationStepIntent(manifest.operationId, manifest, index, lock, env);
      manifest = recordClientOperationStepApplied(manifest.operationId, manifest, index, after, lock, env);
    }
    let crashed = false;
    const filesystem = injected((event) => {
      if (!crashed && event === "after-artifact-unlink") { crashed = true; throw new Error("crash after unlink"); }
    });
    expect(() => cleanupClientOperationArtifact(manifest.operationId, manifest, lock, env, filesystem)).toThrow("crash after unlink");
    releaseClientOperationLock(lock);
    expect(inspectClientOperation(manifest.operationId, env)).toMatchObject({ inspectionState: "resumable" });
    const resumed = resumeClientOperation(manifest.operationId, env);
    manifest = completeClientOperationCleanup(manifest.operationId, resumed.manifest, resumed.lock, env);
    expect(manifest).toMatchObject({
      state: "committed", request: null, artifacts: [], steps: [],
      completion: { operation: "update", stepCount: 3, cleanupDirectoryDurability: process.platform === "win32" ? "unavailable" : "durable" },
    });
    expect(inspectClientOperation(manifest.operationId, env)).toMatchObject({
      inspectionState: "complete", operation: "update", artifacts: [],
      cleanupDirectoryDurability: process.platform === "win32" ? "unavailable" : "durable",
    });
    releaseClientOperationLock(resumed.lock);
  });

  it("blocks a snapshot that disappeared before its cleanup intent", () => {
    const { home, env } = fixture(); let manifest = operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    for (const [artifact, before] of [["registration.before", "before-registration"], ["backend.before", "before-backend"], ["metadata.before", "before-metadata"]]) {
      manifest = writeClientOperationSnapshot(manifest.operationId, manifest, artifact, before, lock, env);
    }
    manifest = transitionClientOperation(manifest.operationId, manifest, "snapshotted", lock, env);
    for (const [index, after] of ["after-registration", "after-backend", "after-metadata"].entries()) {
      manifest = recordClientOperationStepIntent(manifest.operationId, manifest, index, lock, env);
      manifest = recordClientOperationStepApplied(manifest.operationId, manifest, index, after, lock, env);
    }
    rmSync(join(home, ".agent-bridge", "operations", manifest.operationId, "snapshots", "registration.before"));
    expect(() => cleanupClientOperationArtifact(manifest.operationId, manifest, lock, env))
      .toThrow("disappeared before cleanup intent");
    expect(readClientOperation(manifest.operationId, env).artifacts[0].cleanupIntentAt).toBeNull();
    releaseClientOperationLock(lock);
  });

  it("rejects an after artifact for a step that was not observed applied", () => {
    const { env } = fixture(); const manifest = operation(env);
    expect(() => validateClientOperation({
      ...manifest,
      artifacts: [{
        name: "registration.after", stepIndex: 0, phase: "after", bytes: 18,
        sha256: sha256("after-registration"), cleanupIntentAt: null, removedAt: null, directoryDurability: null,
      }],
    })).toThrow("manifest is corrupt");
  });

  it("re-syncs an adopted after artifact before recording it", () => {
    const { env } = fixture(); let manifest = operation(env);
    const lock = acquireClientOperationLock("codex", "stable-client", env);
    for (const [artifact, before] of [["registration.before", "before-registration"], ["backend.before", "before-backend"], ["metadata.before", "before-metadata"]]) {
      manifest = writeClientOperationSnapshot(manifest.operationId, manifest, artifact, before, lock, env);
    }
    manifest = transitionClientOperation(manifest.operationId, manifest, "snapshotted", lock, env);
    manifest = recordClientOperationStepIntent(manifest.operationId, manifest, 0, lock, env);
    let snapshotSyncs = 0;
    const filesystem = injected(() => {}, {
      syncDirectory: (path) => {
        if (path.endsWith("snapshots") && ++snapshotSyncs === 1) throw new Error("injected sync failure");
      },
    });
    expect(() => recordClientOperationStepApplied(
      manifest.operationId, manifest, 0, "after-registration", lock, env, filesystem,
    )).toThrow("durably");
    releaseClientOperationLock(lock);
    const resumed = resumeClientOperation(manifest.operationId, env);
    manifest = recordClientOperationStepApplied(
      manifest.operationId, resumed.manifest, 0, "after-registration", resumed.lock, env, filesystem,
    );
    expect(snapshotSyncs).toBe(2);
    expect(manifest.steps[0].state).toBe("observed-applied");
    releaseClientOperationLock(resumed.lock);
  });

  it("rejects request fields that can carry credentials", () => {
    const { env } = fixture();
    const step = [{
      target: "metadata" as const, locator: "management:one", beforeArtifact: "one.before", afterArtifact: "one.after",
      expectedBeforeSha256: sha256("before"), expectedAfterSha256: sha256("after"),
    }];
    expect(() => createClientOperation({
      request: { kind: "migrate", endpoint: "https://bridge.example/mcp?access_token=secret", workspace: "one" },
      runtime: "codex", instance: "one", steps: step,
    }, env)).toThrow("manifest is corrupt");
    expect(() => createClientOperation({
      request: { kind: "migrate", endpoint: "https://bridge.example/mcp", workspace: "https://token.invalid" },
      runtime: "codex", instance: "one", steps: step,
    }, env)).toThrow("manifest is corrupt");
    expect(() => createClientOperation({
      request: { kind: "update", release: "token=secret" } as unknown as ClientOperationRequest,
      runtime: "codex", instance: "one", steps: step,
    }, env)).toThrow("manifest is corrupt");
    expect(() => createClientOperation({
      request: { kind: "uninstall" } as unknown as ClientOperationRequest,
      runtime: "codex", instance: "one", steps: step,
    }, env)).toThrow("manifest is corrupt");
  });

  it("keeps released v2 manifests inspectable without allowing identity-free resume", () => {
    const { home, env } = fixture();
    const prepared = operation(env);
    const preparedPath = join(home, ".agent-bridge", "operations", prepared.operationId, "manifest.json");
    const legacyPrepared = {
      ...prepared,
      version: 2,
      request: { kind: "repair" },
    };
    writeFileSync(preparedPath, `${JSON.stringify(legacyPrepared, null, 2)}\n`, { mode: 0o600 });
    expect(validateClientOperation(legacyPrepared)).toMatchObject({ version: 2, request: { kind: "repair" } });
    expect(inspectClientOperation(prepared.operationId, env)).toMatchObject({
      state: "prepared", inspectionState: "blocked", recoverable: false,
      reason: "legacy operation lacks an identity-bound request and cannot resume",
    });
    expect(() => resumeClientOperation(prepared.operationId, env)).toThrow("identity-bound request");

    const completed = createClientOperation({
      operationId: "99999999-9999-4999-8999-999999999998",
      request: { kind: "repair", identity: "test-worker" }, runtime: "claude-code", instance: "legacy-complete",
      steps: [{ target: "metadata", locator: "management:legacy-complete", beforeArtifact: "before", afterArtifact: "after", expectedBeforeSha256: sha256("before"), expectedAfterSha256: sha256("after") }],
    }, env);
    const completedPath = join(home, ".agent-bridge", "operations", completed.operationId, "manifest.json");
    const legacyCompleted = {
      ...completed,
      version: 2,
      request: null,
      state: "committed",
      steps: [],
      artifacts: [],
      completion: {
        operation: "repair",
        stepCount: 1,
        completedAt: new Date().toISOString(),
        cleanupDirectoryDurability: process.platform === "win32" ? "unavailable" : "durable",
      },
    };
    writeFileSync(completedPath, `${JSON.stringify(legacyCompleted, null, 2)}\n`, { mode: 0o600 });
    expect(validateClientOperation(legacyCompleted)).toMatchObject({ version: 2, state: "committed" });
    expect(inspectClientOperation(completed.operationId, env)).toMatchObject({
      inspectionState: "complete", operation: "repair", recoverable: false,
    });
  });

  it("rejects rollback as a terminal v3 completion operation", () => {
    const { env } = fixture();
    const prepared = operation(env);
    const invalid = {
      ...prepared,
      request: null,
      state: "committed",
      revision: prepared.revision + 1,
      steps: [],
      artifacts: [],
      completion: {
        operation: "rollback",
        stepCount: 1,
        completedAt: new Date().toISOString(),
        cleanupDirectoryDurability: process.platform === "win32" ? "unavailable" : "durable",
      },
    };
    expect(invalid.version).toBe(3);
    expect(() => validateClientOperation(invalid)).toThrow("operation manifest is corrupt");
  });

  it("treats committed history as complete across hosts", () => {
    const { home, env } = fixture(); let manifest = createClientOperation({
      operationId: "77777777-7777-4777-8777-777777777777", request: { kind: "repair", identity: "test-worker" }, runtime: "codex", instance: "one",
      steps: [{ target: "metadata", locator: "management:one", beforeArtifact: "one.before", afterArtifact: "one.after", expectedBeforeSha256: sha256("before"), expectedAfterSha256: sha256("after") }],
    }, env);
    const lock = acquireClientOperationLock("codex", "one", env);
    manifest = writeClientOperationSnapshot(manifest.operationId, manifest, "one.before", "before", lock, env);
    manifest = transitionClientOperation(manifest.operationId, manifest, "snapshotted", lock, env);
    manifest = recordClientOperationStepIntent(manifest.operationId, manifest, 0, lock, env);
    manifest = recordClientOperationStepApplied(manifest.operationId, manifest, 0, "after", lock, env);
    manifest = completeClientOperationCleanup(manifest.operationId, manifest, lock, env);
    releaseClientOperationLock(lock);
    const path = join(home, ".agent-bridge", "operations", manifest.operationId, "manifest.json");
    const changed = JSON.parse(readFileSync(path, "utf8")); changed.host = "another-host.invalid";
    writeFileSync(path, `${JSON.stringify(changed, null, 2)}\n`, { mode: 0o600 });
    expect(inspectClientOperation(manifest.operationId, env)).toMatchObject({ inspectionState: "complete", operation: "repair" });
    const next = beginClientOperation({
      operationId: "88888888-8888-4888-8888-888888888888", request: { kind: "repair", identity: "test-worker" }, runtime: "codex", instance: "one",
      steps: [{ target: "metadata", locator: "management:one", beforeArtifact: "two.before", afterArtifact: "two.after", expectedBeforeSha256: sha256("before"), expectedAfterSha256: sha256("after") }],
    }, env);
    releaseClientOperationLock(next.lock);
  });

  it("fences new mutations when any operation is corrupt", () => {
    const { home, env } = fixture(); const manifest = operation(env);
    writeFileSync(join(home, ".agent-bridge", "operations", manifest.operationId, "manifest.json"), "not-json", { mode: 0o600 });
    expect(() => beginClientOperation({
      request: { kind: "repair", identity: "test-worker" }, runtime: "claude-code", instance: "other",
      steps: [{ target: "metadata", locator: "management:other", beforeArtifact: "other.before", afterArtifact: "other.after", expectedBeforeSha256: sha256("before"), expectedAfterSha256: sha256("after") }],
    }, env)).toThrow("blocked operation");
  });

  it("fences resume when another operation is corrupt", () => {
    const { home, env } = fixture(); const resumable = operation(env);
    const blocked = createClientOperation({
      operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", request: { kind: "repair", identity: "test-worker" }, runtime: "claude-code", instance: "other",
      steps: [{ target: "metadata", locator: "management:other", beforeArtifact: "other.before", afterArtifact: "other.after", expectedBeforeSha256: sha256("before"), expectedAfterSha256: sha256("after") }],
    }, env);
    writeFileSync(join(home, ".agent-bridge", "operations", blocked.operationId, "manifest.json"), "not-json", { mode: 0o600 });
    expect(() => resumeClientOperation(resumable.operationId, env)).toThrow("blocked operation");
  });

  it("validates update launch shape against its runtime before publishing a manifest", () => {
    const { env } = fixture();
    const step = [{ target: "metadata" as const, locator: "management:one", beforeArtifact: "one.before", afterArtifact: "one.after", expectedBeforeSha256: sha256("before"), expectedAfterSha256: sha256("after") }];
    expect(() => createClientOperation({
      request: { kind: "update", identity: "test-worker", launch: {
        command: "agent-bridge-mcp", args: [], scope: "user",
        envKeys: ["AGENT_BRIDGE_AGENT", "AGENT_BRIDGE_CONFIG", "AGENT_BRIDGE_INSTANCE"],
      } }, runtime: "codex", instance: "one", steps: step,
    }, env)).toThrow("manifest");
    expect(() => createClientOperation({
      request: { kind: "update", identity: "test-worker", launch: {
        command: "agent-bridge-mcp", args: [], scope: null,
        envKeys: ["AGENT_BRIDGE_AGENT", "AGENT_BRIDGE_CONFIG", "AGENT_BRIDGE_INSTANCE"],
      } }, runtime: "claude-code", instance: "one", steps: step,
    }, env)).toThrow("manifest");
    expect(() => createClientOperation({
      request: { kind: "update", identity: "test-worker", launch: {
        command: "agent-bridge-mcp --token=secret", args: [], scope: null,
        envKeys: ["AGENT_BRIDGE_AGENT", "AGENT_BRIDGE_CONFIG", "AGENT_BRIDGE_INSTANCE"],
      } }, runtime: "codex", instance: "one", steps: step,
    }, env)).toThrow("launch command");
  });

  it("does not clean a replacement operation root after create failure", () => {
    if (process.platform === "win32") return;
    const { home, env } = fixture();
    const root = join(home, ".agent-bridge", "operations");
    const original = join(home, "original-operations");
    const operationId = "99999999-9999-4999-8999-999999999999";
    const filesystem = injected((event) => {
      if (event !== "after-snapshots-created") return;
      renameSync(root, original);
      mkdirSync(join(root, "locks"), { recursive: true, mode: 0o700 });
      securePrivatePath(root, "directory"); securePrivatePath(join(root, "locks"), "directory");
      mkdirSync(join(root, operationId), { mode: 0o700 }); securePrivatePath(join(root, operationId), "directory");
      writeFileSync(join(root, operationId, "do-not-touch"), "preserve", { mode: 0o600 });
    });
    expect(() => createClientOperation({
      operationId, request: { kind: "repair", identity: "test-worker" }, runtime: "codex", instance: "one",
      steps: [{ target: "metadata", locator: "management:one", beforeArtifact: "one.before", afterArtifact: "one.after", expectedBeforeSha256: sha256("before"), expectedAfterSha256: sha256("after") }],
    }, env, filesystem)).toThrow("operation directory changed");
    expect(readFileSync(join(root, operationId, "do-not-touch"), "utf8")).toBe("preserve");
  });

  it("does not unlink through a replacement operation root during cleanup", () => {
    if (process.platform === "win32") return;
    const { home, env } = fixture(); let manifest = createClientOperation({
      operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", request: { kind: "repair", identity: "test-worker" }, runtime: "codex", instance: "one",
      steps: [{ target: "metadata", locator: "management:one", beforeArtifact: "one.before", afterArtifact: "one.after", expectedBeforeSha256: sha256("before"), expectedAfterSha256: sha256("after") }],
    }, env);
    const lock = acquireClientOperationLock("codex", "one", env);
    manifest = writeClientOperationSnapshot(manifest.operationId, manifest, "one.before", "before", lock, env);
    manifest = transitionClientOperation(manifest.operationId, manifest, "snapshotted", lock, env);
    manifest = recordClientOperationStepIntent(manifest.operationId, manifest, 0, lock, env);
    manifest = recordClientOperationStepApplied(manifest.operationId, manifest, 0, "after", lock, env);
    const root = join(home, ".agent-bridge", "operations");
    const original = join(home, "cleanup-original-operations");
    let swapped = false;
    const filesystem = injected((event) => {
      if (event !== "before-artifact-unlink" || swapped) return;
      swapped = true; renameSync(root, original);
      mkdirSync(join(root, "locks"), { recursive: true, mode: 0o700 });
      mkdirSync(join(root, manifest.operationId, "snapshots"), { recursive: true, mode: 0o700 });
      for (const directory of [root, join(root, "locks"), join(root, manifest.operationId), join(root, manifest.operationId, "snapshots")]) {
        securePrivatePath(directory, "directory");
      }
      writeFileSync(join(root, manifest.operationId, "snapshots", "do-not-touch"), "preserve", { mode: 0o600 });
    });
    expect(() => cleanupClientOperationArtifact(manifest.operationId, manifest, lock, env, filesystem))
      .toThrow("operation directory changed");
    expect(readFileSync(join(root, manifest.operationId, "snapshots", "do-not-touch"), "utf8")).toBe("preserve");
  });

  it("records POSIX cleanup durability or explicit Windows unavailability", () => {
    const { env } = fixture();
    let manifest = createClientOperation({
      operationId: "66666666-6666-4666-8666-666666666666", request: { kind: "uninstall", identity: "test-worker" }, runtime: "codex", instance: "one",
      steps: [{ target: "metadata", locator: "management:one", beforeArtifact: "one.before", afterArtifact: "one.after", expectedBeforeSha256: sha256("before"), expectedAfterSha256: sha256("after") }],
    }, env);
    const lock = acquireClientOperationLock("codex", "one", env);
    manifest = writeClientOperationSnapshot(manifest.operationId, manifest, "one.before", "before", lock, env);
    manifest = transitionClientOperation(manifest.operationId, manifest, "snapshotted", lock, env);
    manifest = recordClientOperationStepIntent(manifest.operationId, manifest, 0, lock, env);
    manifest = recordClientOperationStepApplied(manifest.operationId, manifest, 0, "after", lock, env);
    manifest = cleanupClientOperationArtifact(manifest.operationId, manifest, lock, env);
    expect(manifest.artifacts[0].directoryDurability).toBe(process.platform === "win32" ? "unavailable" : "durable");
  });
});
