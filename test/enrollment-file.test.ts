import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect } from "vitest";
import { buildSync } from "esbuild";
import {
  acquireEnrollmentLock,
  createPendingEnrollment,
  deleteEnrollmentFile,
  defaultEnrollmentPath,
  enrollmentRoot,
  readEnrollment,
  recoverEnrollmentLock,
  releaseEnrollmentLock,
  transitionEnrollment,
  validateEnrollmentFile,
  type EnrollmentFile,
} from "../src/enrollment-file.js";
import { privatePathIt } from "./private-path-policy.js";

const it = privatePathIt;

const roots: string[] = [];

function fixture(home: string): EnrollmentFile {
  return {
    schema: "agent-bridge.enrollment",
    version: 1,
    provider: "gateway",
    revision: 0,
    state: "pending",
    operation: "provision",
    requestId: randomUUID(),
    createdAt: new Date().toISOString(),
    completedAt: null,
    input: {
      gatewayUrl: "https://bridge.example.test",
      workspaceId: "team",
      principal: "codex",
      runtime: "codex",
      instance: "codex-machine",
      credentialId: null,
      workspaceName: "Team",
      displayName: "Codex",
      runtimeType: "codex",
      label: "codex",
      scopeSetName: "release-a-full",
      expiresAt: null,
      graceUntil: null,
      invalidateImmediately: false,
    },
    token: "private-token",
    result: null,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("enrollment files", () => {
  it("creates private files exclusively and fsync-transitions the legal state graph", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-enrollment-"));
    roots.push(home);
    const env = { HOME: home };
    const pending = fixture(home);
    const path = defaultEnrollmentPath(pending.requestId, env);
    createPendingEnrollment(path, pending, env);
    expect(() => createPendingEnrollment(path, pending, env)).toThrow();
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, ".agent-bridge", "enrollments")).mode & 0o777).toBe(0o700);
    }
    const result = {
      workspaceId: "team",
      principal: "codex",
      agentId: randomUUID(),
      credentialId: randomUUID(),
      replayed: false,
    };
    const ready = transitionEnrollment(
      path,
      readEnrollment(path, env),
      "ready",
      { completedAt: new Date().toISOString(), result },
      env,
    );
    const consuming = transitionEnrollment(path, ready, "consuming", {}, env);
    expect(() => transitionEnrollment(path, ready, "consuming", {}, env)).toThrow(
      /stale enrollment transition refused/,
    );
    expect(() => transitionEnrollment(path, consuming, "pending", {}, env)).toThrow(
      /illegal enrollment state transition/,
    );
    const consumed = transitionEnrollment(path, consuming, "consumed", { token: null }, env);
    expect(consumed.token).toBeNull();
    expect(consumed.revision).toBe(3);
    expect(() => transitionEnrollment(path, consuming, "ready", {}, env)).toThrow(
      /stale enrollment transition refused/,
    );
    expect(readEnrollment(path, env)).toMatchObject({ state: "consumed", token: null, revision: 3 });
    expect(() => transitionEnrollment(path, consumed, "ready", {}, env)).toThrow(
      /illegal enrollment state transition/,
    );
  }, 90_000);

  it("rejects escapes, symlink parents, loose permissions, and null creation times", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-enrollment-"));
    roots.push(home);
    const env = { HOME: home };
    const pending = fixture(home);
    expect(() => createPendingEnrollment(join(home, "outside.json"), pending, env)).toThrow(
      /configured enrollment directory/,
    );
    const root = enrollmentRoot(env);
    const target = join(home, "target");
    writeFileSync(target, "target");
    mkdirSync(join(home, ".agent-bridge"), { recursive: true });
    expect(() => symlinkSync(home, root)).not.toThrow();
    expect(() => createPendingEnrollment(join(root, "bad.json"), pending, env)).toThrow(
      /symbolic links/,
    );
    rmSync(root, { force: true });
    const path = defaultEnrollmentPath(pending.requestId, env);
    createPendingEnrollment(path, pending, env);
    if (process.platform !== "win32") {
      chmodSync(path, 0o644);
      expect(() => readEnrollment(path, env)).toThrow(/permissions are not owner-only/);
      chmodSync(path, 0o600);
    }
    const invalid = JSON.parse(JSON.stringify(pending));
    invalid.createdAt = null;
    writeFileSync(path, JSON.stringify(invalid), { mode: 0o600 });
    expect(() => readEnrollment(path, env)).toThrow(/createdAt/);
  });

  it("accepts only canonical HTTP gateway and RFC3339 timestamp forms", () => {
    const pending = fixture("unused");
    const credentialedGateway = new URL("https://bridge.example.test");
    credentialedGateway.username = "user";
    credentialedGateway.password = "secret";
    for (const gatewayUrl of [
      "ftp://localhost/bridge",
      "http://bridge.example.test",
      credentialedGateway.toString(),
      "https://bridge.example.test/#fragment",
    ]) {
      expect(() => validateEnrollmentFile({
        ...pending,
        input: { ...pending.input, gatewayUrl },
      })).toThrow(/gatewayUrl/);
    }
    expect(validateEnrollmentFile({
      ...pending,
      input: { ...pending.input, gatewayUrl: "http://[::1]:8787" },
    }).input.gatewayUrl).toBe("http://[::1]:8787/");
    expect(() => validateEnrollmentFile({
      ...pending,
      input: { ...pending.input, expiresAt: "2026-07-14T12:00:00" },
    })).toThrow(/timezone/);
    for (const expiresAt of [
      "2026-02-30T12:00:00Z",
      "2026-07-14T24:00:00Z",
      "2026-07-14T12:60:00Z",
      "2026-07-14T12:00:00.1234Z",
    ]) {
      expect(() => validateEnrollmentFile({
        ...pending,
        input: { ...pending.input, expiresAt },
      })).toThrow(/expiresAt/);
    }
    expect(validateEnrollmentFile({
      ...pending,
      input: { ...pending.input, expiresAt: "2026-07-14T07:00:00-05:00" },
    }).input.expiresAt).toBe("2026-07-14T12:00:00.000Z");
  });

  it("holds one exclusive enrollment lock across processes", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-enrollment-"));
    roots.push(home);
    const env = { ...process.env, HOME: home };
    const pending = fixture(home);
    const path = defaultEnrollmentPath(pending.requestId, env);
    createPendingEnrollment(path, pending, env);
    const bundlePath = join(home, "enrollment-file.mjs");
    buildSync({
      entryPoints: [fileURLToPath(new URL("../src/enrollment-file.ts", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bundlePath,
    });
    const moduleUrl = pathToFileURL(bundlePath).href;
    const holderScript = `import {acquireEnrollmentLock,releaseEnrollmentLock} from ${JSON.stringify(moduleUrl)};const lock=acquireEnrollmentLock(${JSON.stringify(path)},process.env);process.stdout.write('locked\\n');process.stdin.once('data',()=>{releaseEnrollmentLock(lock);process.exit(0)});process.stdin.resume();`;
    const holder = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", holderScript], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      holder.once("error", reject);
      holder.stderr.on("data", (chunk) => { stderr += String(chunk); });
      holder.stdout.once("data", (chunk) => String(chunk).includes("locked") && resolve());
      holder.once("close", (status) => reject(new Error(
        "lock holder exited before acquisition: " + status + " " + stderr,
      )));
    });
    const contenderScript = `import {acquireEnrollmentLock} from ${JSON.stringify(moduleUrl)};try{acquireEnrollmentLock(${JSON.stringify(path)},process.env);process.exit(2)}catch(error){if(error?.code==='EEXIST'){process.stdout.write('busy\\n');process.exit(0)}throw error}`;
    const holderClosed = new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.once("close", (status) => status === 0 ? resolve() : reject(new Error("lock holder failed")));
    });
    let contenderFailure: unknown;
    try {
      const contender = spawnSync(process.execPath, [
        "--experimental-strip-types", "--input-type=module", "--eval", contenderScript,
      ], { env, encoding: "utf8", timeout: 30_000 });
      expect(contender.status, contender.stderr).toBe(0);
      expect(contender.stdout).toBe("busy\n");
    } catch (error) {
      contenderFailure = error;
    } finally {
      try { holder.stdin.end("release\n"); } catch { holder.kill(); }
    }
    await holderClosed;
    if (contenderFailure) throw contenderFailure;
  }, 60_000);

  it("refuses live lock recovery and parent replacement", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-enrollment-"));
    roots.push(home);
    const env = { HOME: home };
    const pending = fixture(home);
    const path = defaultEnrollmentPath(pending.requestId, env);
    createPendingEnrollment(path, pending, env);
    const lock = acquireEnrollmentLock(path, env);
    expect(() => recoverEnrollmentLock(path, env, Date.now() + 61_000)).toThrow(/still running/);
    if (process.platform === "win32") {
      releaseEnrollmentLock(lock);
      return;
    }
    const directory = dirname(path);
    const moved = directory + "-moved";
    renameSync(directory, moved);
    mkdirSync(directory, { mode: 0o700 });
    expect(() => transitionEnrollment(path, pending, "ready", {}, env, lock)).toThrow();
    closeSync(lock.descriptor);
    lock.released = true;
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it("distinguishes post-unlink and lock-release durability failures", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-enrollment-"));
    roots.push(home);
    const env = { HOME: home };
    const pending = fixture(home);
    const path = defaultEnrollmentPath(pending.requestId, env);
    createPendingEnrollment(path, pending, env);
    const lock = acquireEnrollmentLock(path, env);
    const result = {
      workspaceId: "team",
      principal: "codex",
      agentId: randomUUID(),
      credentialId: randomUUID(),
      replayed: false,
    };
    const ready = transitionEnrollment(path, pending, "ready", {
      completedAt: new Date().toISOString(), result,
    }, env, lock);
    const consuming = transitionEnrollment(path, ready, "consuming", {}, env, lock);
    transitionEnrollment(path, consuming, "consumed", { token: null }, env, lock);
    expect(deleteEnrollmentFile(path, lock, env, {
      syncDirectory: () => { throw new Error("fsync fault after unlink"); },
    })).toBe("deleted-durability-unknown");
    expect(existsSync(path)).toBe(false);
    expect(releaseEnrollmentLock(lock)).toBe("released");

    const second = fixture(home);
    const secondPath = defaultEnrollmentPath(second.requestId, env);
    createPendingEnrollment(secondPath, second, env);
    const secondLock = acquireEnrollmentLock(secondPath, env);
    expect(releaseEnrollmentLock(secondLock, {
      syncDirectory: () => { throw new Error("lock directory fsync fault"); },
    })).toBe("durability-unknown");
    expect(existsSync(secondLock.lockPath)).toBe(false);
  });
});
