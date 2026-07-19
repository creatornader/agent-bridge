import { createHash, randomUUID } from "node:crypto";
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SQLiteEdgeStore } from "../src/sqlite-edge-store.js";
import { securePrivatePath, verifyPrivatePathAccess } from "../src/private-path.js";
import { runDrCommand } from "../src/dr-cli.js";
import {
  POSTGRES_NATIVE_DR_EXCLUDED_DATA_TABLES, PostgresNativeDrError, type PostgresNativeDrBundleInput,
} from "../src/postgres-native-dr.js";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cli = join(root, "bin", "agent-bridge");
const homes: string[] = [];
const nativeTestTimeout = process.platform === "win32" ? 90_000 : 30_000;
const cliProcessTimeout = process.platform === "win32" ? 60_000 : 20_000;
vi.setConfig({ testTimeout: nativeTestTimeout });
function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
  return runAt(home, args, extra);
}
function runAt(home: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  securePrivatePath(home, "directory");
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: cliProcessTimeout, env: { ...process.env, HOME: home, AGENT_BRIDGE_PROVIDER: "local", AGENT_BRIDGE_DB: join(home, "bridge.sqlite3"), ...extra } });
}
function runAtAsync(home: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  securePrivatePath(home, "directory");
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, HOME: home, AGENT_BRIDGE_PROVIDER: "local", AGENT_BRIDGE_DB: join(home, "bridge.sqlite3"), ...extra },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: cliProcessTimeout,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("agent-bridge CLI", () => {
  it("prints the package version with --version", () => {
    const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    const result = run(["--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${packageVersion}\n`);
    expect(result.stderr).toBe("");
  });

  it("prints the package version with -V", () => {
    const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    const result = run(["-V"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${packageVersion}\n`);
    expect(result.stderr).toBe("");
  });

  it("prints help before command parsing or side effects", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-help-")); homes.push(home);
    const database = join(home, "bridge.sqlite3");
    const invocations = [
      ["--help"], ["-h"], ["get", "--help"], ["send", "-h"],
      ["owner", "--help"], ["clients", "--help"],
      ["archive", "--help"], ["dr", "-h"],
    ];

    for (const invocation of invocations) {
      const result = runAt(home, invocation, { AGENT_BRIDGE_DB: database });
      expect(result.status, `${invocation.join(" ")}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("agent-bridge: provider-neutral agent messaging");
      expect(result.stderr).toBe("");
      expect(existsSync(database)).toBe(false);
    }
  });

  it("inspects managed-client operations without creating operation state", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-operations-")); homes.push(home);
    const result = runAt(home, ["clients", "operations"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 3, operations: [] });
    expect(result.stderr).toBe("");
    expect(existsSync(join(home, ".agent-bridge", "operations"))).toBe(false);

    const invalid = runAt(home, ["clients", "operations", "not-an-operation-id"]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).not.toContain(home);
    expect(invalid.stderr).not.toContain("AGENT_BRIDGE_TOKEN");

    const undocumentedAlias = runAt(home, ["clients", "operation"]);
    expect(undocumentedAlias.status).toBe(1);
    expect(undocumentedAlias.stderr).toContain("clients <install|inspect|adopt|repair|update|uninstall>");
  });

  it("rejects caller authority flags for managed repair, update, uninstall, and generic resume", () => {
    const repair = run([
      "clients", "repair", "codex", "--identity", "codex", "--instance", "stable",
      "--backend-config", "/tmp/forbidden",
    ]);
    expect(repair.status).toBe(1);
    expect(repair.stderr).toContain("--backend-config is not valid for clients repair");

    const update = run([
      "clients", "update", "claude-code", "--identity", "claude", "--instance", "stable",
      "--scope", "project",
    ]);
    expect(update.status).toBe(1);
    expect(update.stderr).toContain("--scope is not valid for clients update");

    const uninstall = run([
      "clients", "uninstall", "codex", "--identity", "codex", "--instance", "stable",
      "--backend-config", "/tmp/forbidden",
    ]);
    expect(uninstall.status).toBe(1);
    expect(uninstall.stderr).toContain("--backend-config is not valid for clients uninstall");

    const resume = run([
      "clients", "resume", "11111111-1111-4111-8111-111111111111", "--identity", "forbidden",
    ]);
    expect(resume.status).toBe(1);
    expect(resume.stderr).toContain("--identity is not valid for clients resume");
  });

  it("exports, verifies, dry-runs, and applies a local portable archive", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const source = join(home, "source.sqlite3");
    const target = join(home, "target.sqlite3");
    const archive = join(home, "workspace.ndjson");
    expect(runAt(home, ["send", "--source", "sender", "portable"], {
      AGENT_BRIDGE_AGENT: undefined, AGENT_BRIDGE_DB: source,
    }).status).toBe(0);
    expect(runAt(home, ["status", "--as", "bootstrap"], {
      AGENT_BRIDGE_AGENT: undefined, AGENT_BRIDGE_DB: target,
    }).status).toBe(0);

    const exported = runAt(home, [
      "archive", "export", "--provider", "local", "--workspace", "default",
      "--db", source, "--output", archive,
      "--request-id", "00000000-0000-4000-8000-0000000000AA",
    ], {
      AGENT_BRIDGE_URL: "https://remote-must-not-be-used.invalid",
      AGENT_BRIDGE_KEY: "legacy-key-must-not-be-used",
      AGENT_BRIDGE_TOKEN: "gateway-token-must-not-be-used",
      AGENT_BRIDGE_ARCHIVE_DATABASE_URL: "postgres://remote-must-not-be-used.invalid/database",
    });
    expect(exported.status).toBe(0);
    expect(JSON.parse(exported.stdout)).toMatchObject({
      schemaVersion: 1, status: "ok", operation: "export", provider: "local",
      requestId: "00000000-0000-4000-8000-0000000000aa", replayed: false,
      reconciled: false, workspace: "default", messages: 1, receipts: 0,
    });
    if (process.platform !== "win32") expect(statSync(archive).mode & 0o077).toBe(0);

    const verified = runAt(home, ["archive", "verify", "--file", archive]);
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      schemaVersion: 1, status: "ok", operation: "verify",
      exportRequestId: "00000000-0000-4000-8000-0000000000aa",
      workspace: "default", messages: 1, receipts: 0,
    });

    const dryRun = runAt(home, [
      "archive", "import", "--provider", "local", "--db", target,
      "--file", archive, "--workspace", "default",
      "--request-id", "00000000-0000-4000-8000-000000000001",
    ]);
    expect(dryRun.status).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      status: "ok", operation: "import", apply: false,
      exportRequestId: "00000000-0000-4000-8000-0000000000aa",
      messages: { created: 1, replayed: 0 },
    });
    const afterDryRun = runAt(home, ["history", "--as", "reader"], {
      AGENT_BRIDGE_AGENT: undefined, AGENT_BRIDGE_DB: target,
    });
    expect(JSON.parse(afterDryRun.stdout).messages).toHaveLength(0);

    const applied = runAt(home, [
      "archive", "import", "--provider", "local", "--db", target,
      "--file", archive, "--apply",
      "--request-id", "00000000-0000-4000-8000-000000000002",
    ]);
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      status: "ok", operation: "import", apply: true,
      exportRequestId: "00000000-0000-4000-8000-0000000000aa",
      messages: { created: 1, replayed: 0 },
    });
    const afterApply = runAt(home, ["history", "--as", "reader"], {
      AGENT_BRIDGE_AGENT: undefined, AGENT_BRIDGE_DB: target,
    });
    expect(JSON.parse(afterApply.stdout).messages).toHaveLength(1);
  }, nativeTestTimeout);

  it("enforces exact archive options and PostgreSQL authority", () => {
    const duplicate = run(["archive", "verify", "--file", "one", "--file", "two"]);
    expect(duplicate.status).toBe(1);
    expect(JSON.parse(duplicate.stderr)).toMatchObject({
      schemaVersion: 1,
      status: "error",
      operation: "verify",
      error: { code: "DUPLICATE_OPTION", message: "--file may only be provided once" },
    });
    const positional = run(["archive", "verify", "unexpected", "--file", "one"]);
    expect(positional.status).toBe(1);
    expect(JSON.parse(positional.stderr).error.code).toBe("INVALID_ARGUMENT");
    const wrongAuthority = run([
      "archive", "export", "--provider", "postgres", "--workspace", "default",
      "--output", "archive.ndjson", "--db", "postgres://forbidden",
    ], { AGENT_BRIDGE_ARCHIVE_DATABASE_URL: "postgres://archive-authority" });
    expect(wrongAuthority.status).toBe(1);
    expect(JSON.parse(wrongAuthority.stderr).error.code).toBe("INVALID_OPTION");
  });

  it("backs up, verifies, and restores a local native DR bundle", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home); securePrivatePath(home, "directory");
    const source = join(home, "source.sqlite3"); const bundle = join(home, "backup.abdr"); const target = join(home, "target.sqlite3");
    expect(runAt(home, ["send", "--source", "sender", "native"], { AGENT_BRIDGE_AGENT: undefined, AGENT_BRIDGE_DB: source }).status).toBe(0);
    const backedUp = runAt(home, [
      "dr", "backup", "--provider", "local", "--source", source, "--output", bundle,
      "--backup-id", "018f4a70-0000-7000-8000-000000000221", "--timeout-ms", "30000",
    ]);
    expect(backedUp.status, backedUp.stderr).toBe(0);
    expect(JSON.parse(backedUp.stdout)).toMatchObject({ status: "ok", operation: "backup", provider: "local", backupId: "018f4a70-0000-7000-8000-000000000221" });
    const verified = runAt(home, ["dr", "verify", "--provider", "local", "--bundle", bundle]);
    expect(verified.status, verified.stderr).toBe(0); expect(JSON.parse(verified.stdout)).toMatchObject({ status: "ok", operation: "verify", backupId: "018f4a70-0000-7000-8000-000000000221" });
    const restored = runAt(home, [
      "dr", "restore", "--provider", "local", "--bundle", bundle, "--target", target,
      "--request-id", "018f4a70-0000-7000-8000-000000000222",
    ]);
    expect(restored.status, restored.stderr).toBe(0); expect(JSON.parse(restored.stdout)).toMatchObject({ status: "ok", operation: "restore", requestId: "018f4a70-0000-7000-8000-000000000222" });
    const history = runAt(home, ["history", "--as", "reader"], { AGENT_BRIDGE_AGENT: undefined, AGENT_BRIDGE_DB: target });
    expect(history.status, history.stderr).toBe(0);
    expect(JSON.parse(history.stdout).messages.map((message: { content: string }) => message.content)).toEqual(["native"]);
  }, nativeTestTimeout);

  it("returns exact JSON errors for native DR command misuse", () => {
    const duplicate = run(["dr", "verify", "--provider", "local", "--bundle", "one", "--bundle", "two"]);
    expect(JSON.parse(duplicate.stderr)).toMatchObject({ status: "error", operation: "verify", error: { code: "DUPLICATE_OPTION" } });
    const postgres = run(["dr", "backup", "--provider", "postgres", "--source", "postgresql://forbidden", "--output", "two"]);
    expect(JSON.parse(postgres.stderr)).toMatchObject({ error: { code: "INVALID_OPTION" } });
    const localTool = run(["dr", "verify", "--provider", "local", "--bundle", "one", "--tool-directory", "/tmp"]);
    expect(JSON.parse(localTool.stderr)).toMatchObject({ error: { code: "INVALID_OPTION" } });
  });

  it("backs up, verifies, and restores PostgreSQL through env-only authority", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home); securePrivatePath(home, "directory");
    const bundle = join(home, "postgres.abdr");
    const backupId = "018f4a70-0000-7000-8000-000000000231";
    const requestId = "018f4a70-0000-7000-8000-000000000232";
    const schema = {
      databaseName: "agent_bridge",
      serverVersionNum: 170005,
      serverMajor: 17,
      schemaVersion: 16,
      migrations: [{ version: 16, name: "native_dr_fence", checksum: "a".repeat(64) }],
      tableCounts: {
        "agent_bridge.deliveries": "1", "agent_bridge.delivery_events": "1",
        ...Object.fromEntries(POSTGRES_NATIVE_DR_EXCLUDED_DATA_TABLES.map((table) => [table, "0"])),
      },
      excludedDataTables: [...POSTGRES_NATIVE_DR_EXCLUDED_DATA_TABLES],
      claimedDeliveryCount: "1",
      pgDumpVersion: "pg_dump (PostgreSQL) 17.5",
      roleInventorySha256: "b".repeat(64),
      readinessAttestations: {
        securitySchemaSha256: "c".repeat(64), rowIsolationSha256: "d".repeat(64),
        ownerControlSha256: "e".repeat(64), portableArchiveSha256: "f".repeat(64),
      },
    };
    const fakeBackup = async (options: Parameters<typeof import("../src/postgres-native-dr.js").backupPostgresNativeDr>[0]) => {
      expect(options.environment?.AGENT_BRIDGE_DR_SOURCE_DATABASE_URL).toBe("postgresql://source-authority");
      expect(options.toolDirectory).toBe("/opt/postgres/17/bin");
      expect(options.backupId).toMatch(/^018f4a70-0000-7000-8000-00000000023[159]$/);
      const dumpPath = join(options.stagingDirectory, "postgres-database.dump");
      const rolesPath = join(options.stagingDirectory, "postgres-roles.json");
      writeFileSync(dumpPath, "custom dump", { mode: 0o600 }); securePrivatePath(dumpPath, "file");
      writeFileSync(rolesPath, "{}\n", { mode: 0o600 }); securePrivatePath(rolesPath, "file");
      return {
        backupId: options.backupId!, createdAt: "2026-07-15T00:00:00.000Z", kind: "postgres", schema,
        entries: [{ name: "postgres/database.dump", path: dumpPath }, { name: "postgres/roles.json", path: rolesPath }],
      } satisfies PostgresNativeDrBundleInput;
    };
    const fakeVerify = async (options: Parameters<typeof import("../src/postgres-native-dr.js").verifyPostgresNativeDrArtifacts>[0]) => {
      expect(fstatSync(options.artifactAnchors.dump.descriptor).isFile()).toBe(true);
      expect(fstatSync(options.artifactAnchors.roles.descriptor).isFile()).toBe(true);
      expect(options.toolDirectory).toBe("/opt/postgres/17/bin");
      return {
        schema: options.schema, roleInventory: {} as never, artifactAnchors: options.artifactAnchors,
        dumpTocVerified: true as const, dumpToc: "",
      };
    };
    const backedUp = await runDrCommand([
      "backup", "--provider", "postgres", "--output", bundle, "--backup-id", backupId,
      "--tool-directory", "/opt/postgres/17/bin",
    ], {
      environment: { AGENT_BRIDGE_DR_SOURCE_DATABASE_URL: "postgresql://source-authority" },
      backupPostgres: fakeBackup,
      verifyPostgres: fakeVerify,
      platform: "linux",
      fileOperations: { syncDirectory: () => true },
    });
    expect(backedUp).toMatchObject({
      status: "ok", operation: "backup", provider: "postgres", backupId, directoryDurability: "confirmed",
    });
    const windowsBackupId = "018f4a70-0000-7000-8000-000000000235";
    const windowsBundle = join(home, "postgres-win.abdr");
    const windowsBackup = await runDrCommand([
      "backup", "--provider", "postgres", "--output", windowsBundle, "--backup-id", windowsBackupId,
      "--tool-directory", "/opt/postgres/17/bin",
    ], {
      environment: { AGENT_BRIDGE_DR_SOURCE_DATABASE_URL: "postgresql://source-authority" },
      backupPostgres: fakeBackup, verifyPostgres: fakeVerify, platform: "win32",
    });
    expect(windowsBackup).toMatchObject({
      status: "ok", backupId: windowsBackupId, directoryDurability: "unavailable", platform: "win32",
    });
    let backupSyncCalls = 0;
    const cleanupBackupId = "018f4a70-0000-7000-8000-000000000239";
    const cleanupBundle = join(home, "postgres-cleanup.abdr");
    await expect(runDrCommand([
      "backup", "--provider", "postgres", "--output", cleanupBundle, "--backup-id", cleanupBackupId,
      "--tool-directory", "/opt/postgres/17/bin",
    ], {
      environment: { AGENT_BRIDGE_DR_SOURCE_DATABASE_URL: "postgresql://source-authority" },
      backupPostgres: fakeBackup,
      verifyPostgres: fakeVerify,
      platform: "linux",
      fileOperations: { syncDirectory: () => { backupSyncCalls += 1; return backupSyncCalls < 4; } },
    })).rejects.toMatchObject({
      code: "DR_CLEANUP_DURABILITY_UNKNOWN",
      details: { backupId: cleanupBackupId, cleanupDurability: "unproved" },
    });
    expect(existsSync(cleanupBundle)).toBe(true);
    expect(existsSync(join(home, `.${cleanupBackupId}.agent-bridge-dr.postgres.stage`))).toBe(false);
    let verifySyncCalls = 0;
    const verified = await runDrCommand([
      "verify", "--provider", "postgres", "--bundle", bundle, "--tool-directory", "/opt/postgres/17/bin",
    ], {
      verifyPostgres: fakeVerify,
      platform: "linux",
      fileOperations: { syncDirectory: () => { verifySyncCalls += 1; return true; } },
    });
    expect(verifySyncCalls).toBe(1);
    expect(verified).toMatchObject({
      status: "ok", operation: "verify", provider: "postgres", backupId,
      cleanupDirectoryDurability: "confirmed",
    });
    const windowsVerified = await runDrCommand([
      "verify", "--provider", "postgres", "--bundle", bundle, "--tool-directory", "/opt/postgres/17/bin",
    ], { verifyPostgres: fakeVerify, platform: "win32" });
    expect(windowsVerified).toMatchObject({
      status: "ok", backupId, cleanupDirectoryDurability: "unavailable", platform: "win32",
    });
    await expect(runDrCommand(["verify", "--provider", "local", "--bundle", bundle]))
      .rejects.toMatchObject({ code: "PROVIDER_MISMATCH" });
    let restoreCalled = false;
    const fakeRestore = async (options: Parameters<typeof import("../src/postgres-native-dr.js").restorePostgresNativeDr>[0]) => {
      restoreCalled = true;
      expect(options.environment?.AGENT_BRIDGE_DR_TARGET_DATABASE_URL).toBe("postgresql://target-authority");
      expect(options.acceptSourceSqlRisk).toBe(true);
      expect(options.toolDirectory).toBe("/opt/postgres/17/bin");
      expect(readFileSync(options.dumpPath, "utf8")).toBe("custom dump");
      expect(readFileSync(options.rolesPath, "utf8")).toBe("{}\n");
      expect(options.schema).toEqual(schema);
      expect(fstatSync(options.artifactAnchors.dump.descriptor).isFile()).toBe(true);
      expect(fstatSync(options.artifactAnchors.roles.descriptor).isFile()).toBe(true);
      return {
        databaseName: "agent_bridge", normalizedClaimedDeliveries: "1", tableCounts: schema.tableCounts,
        readiness: { security: true as const, rowIsolation: true as const, ownerControl: true as const, portableArchive: true as const },
      };
    };
    const restored = await runDrCommand([
      "restore", "--provider", "postgres", "--bundle", bundle, "--request-id", requestId,
      "--accept-source-sql-risk", "--tool-directory", "/opt/postgres/17/bin",
    ], {
      environment: { AGENT_BRIDGE_DR_TARGET_DATABASE_URL: "postgresql://target-authority" },
      platform: "win32",
      restorePostgres: fakeRestore,
    });
    expect(restoreCalled).toBe(true);
    expect(restored).toMatchObject({
      status: "ok", operation: "restore", provider: "postgres", requestId, backupId,
      databaseName: "agent_bridge", normalizedClaimedDeliveries: "1",
      cleanupDirectoryDurability: "unavailable", platform: "win32",
    });
    expect(existsSync(join(home, `.${requestId}.agent-bridge-dr.postgres-restore.stage`))).toBe(false);

    let restoreSyncCalls = 0;
    const cleanupRequestId = "018f4a70-0000-7000-8000-000000000236";
    await expect(runDrCommand([
      "restore", "--provider", "postgres", "--bundle", bundle, "--request-id", cleanupRequestId,
      "--accept-source-sql-risk", "--tool-directory", "/opt/postgres/17/bin",
    ], {
      environment: { AGENT_BRIDGE_DR_TARGET_DATABASE_URL: "postgresql://target-authority" },
      restorePostgres: fakeRestore,
      platform: "linux",
      fileOperations: { syncDirectory: () => { restoreSyncCalls += 1; return restoreSyncCalls < 3; } },
    })).rejects.toMatchObject({
      code: "DR_CLEANUP_DURABILITY_UNKNOWN",
      details: { requestId: cleanupRequestId, targetRestored: true, cleanupDurability: "unproved" },
    });
    expect(existsSync(join(home, `.${cleanupRequestId}.agent-bridge-dr.postgres-restore.stage`))).toBe(false);

    const failureCases = [
      { requestId: "018f4a70-0000-7000-8000-000000000237", targetMutated: false, restoreCompleted: false, retained: false },
      { requestId: "018f4a70-0000-7000-8000-000000000238", targetMutated: true, restoreCompleted: false, retained: true },
      { requestId: "018f4a70-0000-7000-8000-00000000023a", targetMutated: true, restoreCompleted: true, retained: true },
    ] as const;
    for (const failure of failureCases) {
      const failureStage = join(home, `.${failure.requestId}.agent-bridge-dr.postgres-restore.stage`);
      await expect(runDrCommand([
        "restore", "--provider", "postgres", "--bundle", bundle, "--request-id", failure.requestId,
        "--accept-source-sql-risk",
      ], {
        restorePostgres: async () => {
          throw new PostgresNativeDrError("INJECTED_RESTORE_FAILURE", "injected restore failure", {
            targetMutated: failure.targetMutated, restoreCompleted: failure.restoreCompleted,
          });
        },
      })).rejects.toMatchObject({
        code: "INJECTED_RESTORE_FAILURE",
        details: {
          requestId: failure.requestId,
          targetMutated: failure.targetMutated,
          restoreCompleted: failure.restoreCompleted,
          ...(failure.retained ? { recoveryPaths: [failureStage] } : {}),
        },
      });
      expect(existsSync(failureStage)).toBe(failure.retained);
      if (failure.retained) rmSync(failureStage, { recursive: true, force: true });
    }
  });

  it("enforces PostgreSQL DR authority, risk, and crash-recovery contracts", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home); securePrivatePath(home, "directory");
    const output = join(home, "ambiguous.abdr");
    const backupId = "018f4a70-0000-7000-8000-000000000233";
    const bundleStage = join(home, `.${backupId}.agent-bridge-dr.bundle.tmp`);
    const providerStage = join(home, `.${backupId}.agent-bridge-dr.postgres.stage`);
    const schema = {
      databaseName: "agent_bridge", serverVersionNum: 170005, serverMajor: 17, schemaVersion: 16,
      migrations: [{ version: 16, name: "native_dr_fence", checksum: "a".repeat(64) }],
      tableCounts: {
        "agent_bridge.deliveries": "0", "agent_bridge.delivery_events": "0",
        ...Object.fromEntries(POSTGRES_NATIVE_DR_EXCLUDED_DATA_TABLES.map((table) => [table, "0"])),
      },
      excludedDataTables: [...POSTGRES_NATIVE_DR_EXCLUDED_DATA_TABLES], claimedDeliveryCount: "0",
      pgDumpVersion: "pg_dump (PostgreSQL) 17.5", roleInventorySha256: "b".repeat(64),
      readinessAttestations: {
        securitySchemaSha256: "c".repeat(64), rowIsolationSha256: "d".repeat(64),
        ownerControlSha256: "e".repeat(64), portableArchiveSha256: "f".repeat(64),
      },
    };
    const fakeBackup = async (options: Parameters<typeof import("../src/postgres-native-dr.js").backupPostgresNativeDr>[0]) => {
      const dumpPath = join(options.stagingDirectory, "postgres-database.dump");
      const rolesPath = join(options.stagingDirectory, "postgres-roles.json");
      writeFileSync(dumpPath, "dump", { mode: 0o600 }); securePrivatePath(dumpPath, "file");
      writeFileSync(rolesPath, "{}\n", { mode: 0o600 }); securePrivatePath(rolesPath, "file");
      return {
        backupId: options.backupId!, createdAt: "2026-07-15T00:00:00.000Z", kind: "postgres", schema,
        entries: [{ name: "postgres/database.dump", path: dumpPath }, { name: "postgres/roles.json", path: rolesPath }],
      } satisfies PostgresNativeDrBundleInput;
    };
    const fakeVerify = async (options: Parameters<typeof import("../src/postgres-native-dr.js").verifyPostgresNativeDrArtifacts>[0]) => ({
      schema: options.schema, roleInventory: {} as never, artifactAnchors: options.artifactAnchors,
      dumpTocVerified: true as const, dumpToc: "",
    });
    await expect(runDrCommand([
      "backup", "--provider", "postgres", "--source", "postgresql://forbidden", "--output", output,
      "--backup-id", backupId,
    ], { backupPostgres: fakeBackup })).rejects.toMatchObject({ code: "INVALID_OPTION" });
    await expect(runDrCommand(["backup", "--provider", "postgres", "--output", output], { backupPostgres: fakeBackup }))
      .rejects.toMatchObject({ code: "MISSING_OPTION", message: "--backup-id is required" });
    await expect(runDrCommand([
      "restore", "--provider", "postgres", "--bundle", output, "--request-id", randomUUID(),
    ])).rejects.toMatchObject({ code: "SOURCE_SQL_RISK_NOT_ACCEPTED" });
    await expect(runDrCommand([
      "restore", "--provider", "postgres", "--bundle", output, "--target", "postgresql://forbidden",
      "--request-id", randomUUID(), "--accept-source-sql-risk",
    ])).rejects.toMatchObject({ code: "INVALID_OPTION" });
    await expect(runDrCommand([
      "backup", "--provider", "postgres", "--output", output, "--backup-id", backupId,
    ], {
      backupPostgres: fakeBackup,
      verifyPostgres: fakeVerify,
      fileOperations: { afterPublish: () => { throw new Error("injected durability failure"); } },
    })).rejects.toMatchObject({
      code: "DR_PUBLICATION_AMBIGUOUS",
      details: { backupId, output, published: true, recoveryPaths: [bundleStage, providerStage] },
    });
    expect(existsSync(output)).toBe(true);
    await expect(runDrCommand([
      "backup", "--provider", "postgres", "--output", output, "--backup-id", backupId,
    ], { backupPostgres: fakeBackup })).rejects.toMatchObject({
      code: "DR_RECOVERY_REQUIRED",
      details: { outputExists: true, published: "unknown", recoveryPaths: [bundleStage, providerStage] },
    });
    const requestId = "018f4a70-0000-7000-8000-000000000234";
    const restoreStage = join(home, `.${requestId}.agent-bridge-dr.postgres-restore.stage`);
    mkdirSync(restoreStage, { mode: 0o700 }); securePrivatePath(restoreStage, "directory");
    await expect(runDrCommand([
      "restore", "--provider", "postgres", "--bundle", output, "--request-id", requestId,
      "--accept-source-sql-risk",
    ])).rejects.toMatchObject({ code: "DR_RECOVERY_REQUIRED", details: { requestId, recoveryPaths: [restoreStage] } });
  });

  it("uses exact owner and installer command contracts", () => {
    const owner = run(["owner", "inventory", "extra"]);
    expect(owner.status).toBe(1);
    expect(JSON.parse(owner.stderr)).toEqual({
      schemaVersion: 1,
      status: "error",
      operation: "inventory",
      error: {
        code: "OWNER_COMMAND_ERROR",
        message: "usage: agent-bridge owner <provision|inventory|rotate|revoke>",
      },
    });
    const client = run([
      "clients", "install", "codex", "--identity", "codex", "--workspace", "ignored",
    ]);
    expect(client.status).toBe(1);
    expect(client.stderr).toContain("--workspace is not valid for clients install");
    const extra = run(["clients", "install", "codex", "extra", "--identity", "codex"]);
    expect(extra.status).toBe(1);
    expect(extra.stderr).toContain("usage: agent-bridge clients install");
  });
  it("inspects and plan-first adopts an exact Claude Desktop registration", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-bridge-cli-lifecycle-"))); homes.push(home);
    securePrivatePath(home, "directory");
    const backendConfigPath = join(home, ".agent-bridge", "clients", "desktop-existing.config");
    const configPath = join(home, "claude-desktop.json");
    const executable = process.execPath;
    mkdirSync(dirname(backendConfigPath), { recursive: true, mode: 0o700 });
    securePrivatePath(join(home, ".agent-bridge"), "directory");
    securePrivatePath(dirname(backendConfigPath), "directory");
    writeFileSync(backendConfigPath, "AGENT_BRIDGE_TOKEN=must-not-leak\n", { mode: 0o600 });
    securePrivatePath(backendConfigPath, "file");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { "agent-bridge": {
      command: executable,
      args: [],
      env: {
        AGENT_BRIDGE_AGENT: "desktop-work",
        AGENT_BRIDGE_INSTANCE: "desktop-existing",
        AGENT_BRIDGE_CONFIG: backendConfigPath,
      },
    } } }));
    const args = [
      "clients", "inspect", "claude-desktop", "--identity", "desktop-work",
      "--instance", "desktop-existing", "--backend-config", backendConfigPath,
      "--command", executable, "--config-path", configPath,
    ];

    const inspected = runAt(home, args);
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({ state: "unmanaged", exact: true });
    expect(inspected.stdout).not.toContain("must-not-leak");

    const planned = runAt(home, args.with(1, "adopt"));
    expect(planned.status).toBe(0);
    const plan = JSON.parse(planned.stdout);
    expect(plan).toMatchObject({ action: "adopt", applied: false, before: "unmanaged", after: "managed" });
    expect(existsSync(plan.metadataPath)).toBe(false);

    const applied = runAt(home, [...args.with(1, "adopt"), "--apply"]);
    expect(applied.status).toBe(0);
    const result = JSON.parse(applied.stdout);
    expect(result).toMatchObject({ action: "adopt", applied: true, before: "unmanaged", after: "managed" });
    expect(readFileSync(result.metadataPath, "utf8")).not.toContain("must-not-leak");

    const codexScope = runAt(home, [
      "clients", "inspect", "codex", "--identity", "codex-work",
      "--instance", "codex-existing", "--backend-config", backendConfigPath,
      "--scope", "user",
    ]);
    expect(codexScope.status).toBe(1);
    expect(codexScope.stderr).toContain("--scope is only valid for the claude-code runtime");

    const claudeConfig = runAt(home, [
      "clients", "inspect", "claude-code", "--identity", "claude-work",
      "--instance", "claude-existing", "--backend-config", backendConfigPath,
      "--config-path", configPath,
    ]);
    expect(claudeConfig.status).toBe(1);
    expect(claudeConfig.stderr).toContain("--config-path is only valid for the claude-desktop runtime");
  });
  it("does not load SQLite for a legacy provider command", () => {
    const result = run(["help"], {
      AGENT_BRIDGE_PROVIDER: "legacy-supabase",
      AGENT_BRIDGE_URL: "https://supabase.test",
      AGENT_BRIDGE_KEY: "publishable-key",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("ExperimentalWarning: SQLite");
  });
  it("rejects options outside the canonical command contract", () => {
    const result = run(["capabilities", "--as", "worker", "--content", "surprise"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--content is not valid for capabilities");
  });
  it("keeps post as an alias and defaults source from runtime identity", () => {
    const result = run(["post", "--category", "operational", "Bridge is ready"], { AGENT_BRIDGE_AGENT: "codex" });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout).message).toMatchObject({ source: "codex", type: "operational", content: "Bridge is ready" });
  });
  it("publishes and settles leased work with publisher-owned CLI policy", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const sent = runAt(home, [
      "send", "--source", "publisher", "--target", "worker",
      "--delivery-mode", "leased", "--delivery-max-attempts", "1",
      "--retry-base-ms", "1000", "--retry-max-ms", "60000",
      "--retry-jitter", "0", "work",
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(sent.status).toBe(0);
    expect(JSON.parse(sent.stdout).message.deliveryPolicy).toMatchObject({
      mode: "leased", maxAttempts: 1, retryBaseDelayMs: 1000,
      retryMaxDelayMs: 60000, retryJitterRatio: 0,
    });
    const claimed = runAt(home, ["claim", "--as", "worker", "--instance", "one", "--lease-ms", "30000"], { AGENT_BRIDGE_AGENT: undefined });
    const claim = JSON.parse(claimed.stdout);
    const nacked = runAt(home, [
      "nack", "--as", "worker", "--instance", "one",
      "--delivery-id", claim.delivery.id, "--lease-token", claim.leaseToken,
      "--disposition", "retry", "--error", "failed",
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(JSON.parse(nacked.stdout).state).toBe("dead");
    const dead = runAt(home, ["dead-letters", "--as", "worker", "--role", "recipient"], { AGENT_BRIDGE_AGENT: undefined });
    expect(JSON.parse(dead.stdout).deliveries).toHaveLength(1);
    const invalid = runAt(home, [
      "send", "--source", "publisher", "--delivery-mode", "mailbox",
      "--retry-base-ms", "1000", "invalid",
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("mailbox delivery mode does not accept retry or scheduling flags");
  }, nativeTestTimeout);
  it("accepts an explicit source when the environment has no identity", () => {
    const result = run(["send", "--source", "codex", "Bridge is ready"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).message.source).toBe("codex");
  });
  it("rejects a conflicting explicit source", () => {
    const result = run(["send", "--source", "claude-code", "Bridge is ready"], { AGENT_BRIDGE_AGENT: "codex" });
    expect(result.status).toBe(1); expect(result.stderr).toContain("source must match AGENT_BRIDGE_AGENT (codex)");
  });
  it("exposes sent mail and caller-relative receipt state", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const targeted = runAt(home, [
      "send", "--source", "sender", "--target", "worker", "targeted",
    ], { AGENT_BRIDGE_AGENT: undefined });
    const targetedId = JSON.parse(targeted.stdout).message.id as string;
    expect(runAt(home, ["send", "--source", "sender", "broadcast"], {
      AGENT_BRIDGE_AGENT: undefined,
    }).status).toBe(0);

    const inbox = runAt(home, ["inbox", "--as", "sender"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(JSON.parse(inbox.stdout).messages.map((message: { content: string }) => message.content))
      .toEqual(["broadcast"]);
    const sent = runAt(home, ["sent", "--as", "sender"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(JSON.parse(sent.stdout).messages.map((message: { content: string }) => message.content))
      .toEqual(["targeted", "broadcast"]);
    const all = runAt(home, ["history", "--as", "sender", "--mailbox", "all"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(JSON.parse(all.stdout).messages).toHaveLength(2);

    const acknowledgement = runAt(home, [
      "ack", "--agent", "worker", "--ids", targetedId,
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(acknowledgement.status).toBe(0);
    expect(JSON.parse(acknowledgement.stdout)).toEqual({ acknowledged: 1, agent: "worker" });
    const read = runAt(home, [
      "inbox", "--as", "worker", "--receipt-state", "read",
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(JSON.parse(read.stdout).messages.map((message: { id: string }) => message.id))
      .toEqual([targetedId]);
  }, nativeTestTimeout);
  it("rejects another principal's receipt assertion before opening storage", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const database = join(home, "must-not-exist.sqlite3");
    const result = runAt(home, [
      "history", "--as", "sender", "--unacked-by", "worker", "--db", database,
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--unacked-by must equal the configured principal");
    expect(existsSync(database)).toBe(false);
  });
  it("runs the deterministic two-client local demo", () => {
    const result = run(["demo"], { AGENT_BRIDGE_AGENT: "operator" });
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ status: "ok", principals: ["demo-sender", "demo-worker"], acknowledged: true });
  });
  it("does not treat an unacknowledged filter as caller identity", () => {
    const result = run(["get", "--unacked-by", "worker"], { AGENT_BRIDGE_AGENT: undefined });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGENT_BRIDGE_AGENT is required");
  });
  it("preserves legacy envelope flags", () => {
    const result = run([
      "post", "--source", "codex", "--kind", "request",
      "--payload-ref", "file:///tmp/result.json",
      "--payload-ciphertext", "ciphertext", "run task",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).message).toMatchObject({
      type: "request",
      metadata: { message_envelope: {
        payload_ref: "file:///tmp/result.json",
        payload_ciphertext: "ciphertext",
      } },
    });
  });
  it("rejects non-object metadata before envelope fields are lost", () => {
    const result = run(["post", "--source", "codex", "--metadata", "[]", "--payload-ref", "file:///tmp/result", "run"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--metadata must be a JSON object");
  });
  it("rejects unknown flags before a targeted post can become a broadcast", () => {
    const result = run(["post", "--source", "codex", "--no-such-option", "worker", "secret"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown option: --no-such-option");
  });
  it("routes aliases through their canonical option contracts", () => {
    const rejectedPost = run(["post", "--source", "codex", "--limit", "1", "message"]);
    expect(rejectedPost.status).toBe(1);
    expect(rejectedPost.stderr).toContain("--limit is not valid for post");

    const invalidDeadLetters = run(["dead-letters", "--as", "worker", "--content", "surprise"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(invalidDeadLetters.status).toBe(1);
    expect(invalidDeadLetters.stderr).toContain("--content is not valid for dead-letters");
  });
  it("applies invocation backend flags before opening a runtime", () => {
    const result = run([
      "post", "--source", "codex", "--provider", "local", "--db", ":memory:", "local override",
    ], {
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: "http://127.0.0.1:1",
      AGENT_BRIDGE_TOKEN: "test-token",
      AGENT_BRIDGE_WORKSPACE: "acme",
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).message.content).toBe("local override");
  });
  it("accepts the deprecated sync limit alias", () => {
    const result = run(["sync", "--limit", "1"], {
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: "http://127.0.0.1:1",
      AGENT_BRIDGE_TOKEN: "test-token",
      AGENT_BRIDGE_AGENT: "worker",
      AGENT_BRIDGE_WORKSPACE: "acme",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ online: false, pushed: 0 });
  });
  it("rejects a missing target value instead of routing to a true literal", () => {
    const result = run(["post", "--source", "codex", "--target-agent", "--category", "request", "secret"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--target-agent requires a value");
  });
  it("rejects invalid client installation scopes", () => {
    const result = run(["clients", "install", "claude-code", "--identity", "claude-work", "--scope", "machine"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scope must be local, user, or project");
  });
  it("parses explicit boolean values without truthy string coercion", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const config = join(home, ".agent-bridge", "config");
    expect(runAt(home, ["init", "--provider", "local", "--config", config]).status).toBe(0);
    const retained = runAt(home, [
      "init", "--provider", "local", "--config", config, "--force", "false",
    ]);
    expect(retained.status).toBe(1);
    expect(retained.stderr).toContain("Config already exists");
    const invalid = runAt(home, ["watch", "--polls", "0", "--json", "sometimes"], {
      AGENT_BRIDGE_AGENT: "codex",
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("--json must be true or false");
  });
  it("reconstructs the complete compatibility envelope on read", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const sent = runAt(home, [
      "post", "--source", "codex", "--target-agent", "worker",
      "--thread-id", "thread-1", "--payload-ref", "file:///tmp/result.json", "run task",
    ]);
    expect(sent.status).toBe(0);
    const result = runAt(home, ["get", "--as", "worker"], { AGENT_BRIDGE_AGENT: undefined });
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout)[0].metadata.message_envelope;
    expect(envelope).toMatchObject({
      source_agent: "codex",
      kind: "operational",
      target_agents: ["worker"],
      thread_id: "thread-1",
      payload_ref: "file:///tmp/result.json",
    });
    expect(envelope.message_id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("returns legacy get rows newest first", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    expect(runAt(home, ["post", "--source", "codex", "first"]).status).toBe(0);
    expect(runAt(home, ["post", "--source", "codex", "second"]).status).toBe(0);
    const result = runAt(home, ["get", "--as", "codex", "--limit", "2"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).map((row: { content: string }) => row.content)).toEqual(["second", "first"]);
  });
  it("creates a private config and initializes local storage", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const config = join(home, ".agent-bridge", "config");
    const database = join(home, ".agent-bridge", "bridge.sqlite3");
    const result = spawnSync(process.execPath, [cli,
      "init", "--provider", "local",
    ], { encoding: "utf8", timeout: cliProcessTimeout, env: { ...process.env, HOME: home, AGENT_BRIDGE_CONFIG: config } });
    expect(result.status).toBe(0);
    verifyPrivatePathAccess(join(home, ".agent-bridge"), "directory");
    verifyPrivatePathAccess(config, "file");
    verifyPrivatePathAccess(database, "file");
    if (process.platform !== "win32") expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(readFileSync(config, "utf8")).not.toContain("AGENT_BRIDGE_AGENT");
    if (process.platform !== "win32") {
      expect(statSync(join(home, ".agent-bridge")).mode & 0o777).toBe(0o700);
      expect(statSync(database).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(database)).toBe(true);
  });
  it("keeps the previous config when forced initialization cannot connect", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const config = join(home, ".agent-bridge", "config");
    const previous = "AGENT_BRIDGE_PROVIDER=local\nAGENT_BRIDGE_WORKSPACE=working\n";
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, previous);
    const result = spawnSync(process.execPath, [cli,
      "init", "--force", "--provider", "gateway",
      "--url", "http://127.0.0.1:1", "--token", "bad-token",
    ], { encoding: "utf8", timeout: cliProcessTimeout, env: { ...process.env, HOME: home, AGENT_BRIDGE_CONFIG: config } });
    expect(result.status).toBe(1);
    expect(readFileSync(config, "utf8")).toBe(previous);
  });
  it("reports real local queue diagnostics", () => {
    const result = run(["doctor"], { AGENT_BRIDGE_AGENT: "codex" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      connected: true,
      queue: { deliverySupported: true, pending: 0, claimed: 0, retrying: 0, dead: 0 },
      checks: expect.arrayContaining([expect.objectContaining({ name: "blocked-outbox", status: "ok" })]),
    });
  });
  it("keeps status passive and makes an unreachable gateway doctor degraded", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const environment = {
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: "http://127.0.0.1:1",
      AGENT_BRIDGE_TOKEN: "test-token",
      AGENT_BRIDGE_WORKSPACE: "acme",
      AGENT_BRIDGE_AGENT: "worker",
    };
    const status = runAt(home, ["status"], environment);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      status: "unknown",
      connected: false,
      remoteReachable: null,
      checks: expect.arrayContaining([expect.objectContaining({ name: "remote", status: "unknown" })]),
    });
    const doctor = runAt(home, ["doctor"], environment);
    expect(doctor.status).toBe(2);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      status: "degraded",
      remoteReachable: false,
      checks: expect.arrayContaining([expect.objectContaining({ name: "remote", status: "degraded" })]),
    });
  });
  it("does not contact a gateway while reading passive status", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test gateway did not bind TCP");
    try {
      const result = await runAtAsync(home, ["status"], {
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
        AGENT_BRIDGE_TOKEN: "test-token",
        AGENT_BRIDGE_WORKSPACE: "acme",
        AGENT_BRIDGE_AGENT: "worker",
      });
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({ status: "unknown", connected: false });
      expect(payload.queue).not.toHaveProperty("syncLoopState");
      expect(payload.queue).not.toHaveProperty("syncLoopError");
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("does not contact a legacy provider while reading passive status", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end(JSON.stringify([]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test legacy provider did not bind TCP");
    try {
      const result = await runAtAsync(home, ["status"], {
        AGENT_BRIDGE_PROVIDER: "legacy-supabase",
        AGENT_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
        AGENT_BRIDGE_KEY: "test-key",
        AGENT_BRIDGE_WORKSPACE: "acme",
        AGENT_BRIDGE_AGENT: "worker",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "unknown", connected: false });
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("degrades doctor when the status probe returns a retryable failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    let statusRequests = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("x-agent-bridge-protocol-version", "2.1");
      response.setHeader("x-agent-bridge-supported-protocol-versions", "2.0,2.1");
      if (request.url === "/readyz") {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.url === "/v2/status") {
        statusRequests += 1;
        response.statusCode = 503;
        response.end(JSON.stringify({ error: { code: "gateway_unavailable" } }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "not_found" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test gateway did not bind TCP");
    try {
      const result = await runAtAsync(home, ["doctor"], {
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
        AGENT_BRIDGE_TOKEN: "test-token",
        AGENT_BRIDGE_WORKSPACE: "acme",
        AGENT_BRIDGE_AGENT: "worker",
      });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "degraded",
        connected: false,
        remoteReachable: false,
      });
      expect(statusRequests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it.each(["doctor", "status"] as const)("returns sanitized failed %s JSON when local initialization fails", (command) => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const database = join(home, "not-a-database");
    mkdirSync(database);
    const result = runAt(home, [command], {
      AGENT_BRIDGE_AGENT: "worker",
      AGENT_BRIDGE_DB: database,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("Error:");
    const payload = JSON.parse(result.stdout);
    expect(payload.checks[0].message).not.toContain(database);
    expect(payload).toMatchObject({
      status: "failed",
      localHealthy: false,
      agent: "worker",
      checks: [{ name: "local-store", status: "failed" }],
    });
  });
  it("provides a cheap pending-work process gate", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const empty = runAt(home, ["pending"], { AGENT_BRIDGE_AGENT: "worker" });
    expect(empty.status).toBe(1);
    expect(JSON.parse(empty.stdout)).toMatchObject({
      available: false,
      unread: false,
      deliveryAvailable: false,
      authoritative: true,
    });
    expect(runAt(home, [
      "send", "--source", "codex", "--target", "worker", "run the task",
    ]).status).toBe(0);
    const ready = runAt(home, ["pending"], { AGENT_BRIDGE_AGENT: "worker" });
    expect(ready.status).toBe(0);
    expect(JSON.parse(ready.stdout)).toMatchObject({
      available: true,
      unread: true,
      deliveryAvailable: true,
      pending: 1,
    });
  });
  it("propagates project labels through send, history, and inbox", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    expect(runAt(home, [
      "send", "--source", "codex", "--project", "alpha", "alpha message",
    ]).status).toBe(0);
    expect(runAt(home, [
      "send", "--source", "codex", "--project", "beta", "beta message",
    ]).status).toBe(0);

    const history = runAt(home, ["history", "--as", "worker", "--project", "alpha"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(history.status).toBe(0);
    expect(JSON.parse(history.stdout).messages).toEqual([
      expect.objectContaining({ project: "alpha", content: "alpha message" }),
    ]);

    const inbox = runAt(home, ["inbox", "--as", "worker", "--project", "beta"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(inbox.status).toBe(0);
    expect(JSON.parse(inbox.stdout).messages).toEqual([
      expect.objectContaining({ project: "beta", content: "beta message" }),
    ]);
  });
  it("accepts a star as a project label", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const sent = runAt(home, ["send", "--source", "codex", "--project", "*", "star project"]);
    expect(sent.status, sent.stderr).toBe(0);
    expect(JSON.parse(sent.stdout).message.project).toBe("*");
    const history = runAt(home, ["history", "--as", "worker", "--project", "*"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(history.status).toBe(0);
    expect(JSON.parse(history.stdout).messages).toEqual([
      expect.objectContaining({ project: "*", content: "star project" }),
    ]);
  });
  it("filters pending checks by project", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    expect(runAt(home, [
      "send", "--source", "codex", "--project", "alpha", "alpha update",
    ]).status).toBe(0);

    const unrelated = runAt(home, ["pending", "--project", "beta"], {
      AGENT_BRIDGE_AGENT: "worker",
    });
    expect(unrelated.status).toBe(1);
    expect(JSON.parse(unrelated.stdout)).toMatchObject({
      available: false,
      unread: false,
    });

    const matching = runAt(home, ["pending", "--project", "alpha"], {
      AGENT_BRIDGE_AGENT: "worker",
    });
    expect(matching.status).toBe(0);
    expect(JSON.parse(matching.stdout)).toMatchObject({
      available: true,
      unread: true,
    });
  });
  it("keeps watch cursors independent between projects", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const cursor = join(home, "cursor");
    expect(runAt(home, [
      "send", "--source", "codex", "--project", "beta", "beta one",
    ]).status).toBe(0);
    expect(runAt(home, [
      "send", "--source", "codex", "--project", "alpha", "alpha one",
    ]).status).toBe(0);
    const first = runAt(home, [
      "watch", "--as", "worker", "--project", "alpha", "--polls", "1",
    ], { AGENT_BRIDGE_AGENT: undefined, AGENT_BRIDGE_CURSOR: cursor });
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ project: "alpha", content: "alpha one" });
    const alphaCursor = `${cursor}.project-${createHash("sha256").update("alpha").digest("hex").slice(0, 16)}`;
    verifyPrivatePathAccess(alphaCursor, "file");

    const beta = runAt(home, [
      "watch", "--as", "worker", "--project", "beta", "--polls", "1",
    ], { AGENT_BRIDGE_AGENT: undefined, AGENT_BRIDGE_CURSOR: cursor });
    expect(beta.status).toBe(0);
    expect(JSON.parse(beta.stdout)).toMatchObject({ project: "beta", content: "beta one" });

    expect(runAt(home, [
      "send", "--source", "codex", "--project", "alpha", "alpha two",
    ]).status).toBe(0);
    const second = runAt(home, [
      "watch", "--as", "worker", "--project", "alpha", "--polls", "1",
    ], { AGENT_BRIDGE_AGENT: undefined, AGENT_BRIDGE_CURSOR: cursor });
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ project: "alpha", content: "alpha two" });
    expect(second.stdout).not.toContain("beta one");
  });
  it("uses a local workspace override for only that invocation", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const environment = {
      AGENT_BRIDGE_AGENT: undefined,
      AGENT_BRIDGE_WORKSPACE: "default-workspace",
    };
    expect(runAt(home, [
      "send", "--source", "codex", "--workspace", "project-workspace", "isolated",
    ], environment).status).toBe(0);

    const defaultHistory = runAt(home, ["history", "--as", "worker"], environment);
    expect(defaultHistory.status).toBe(0);
    expect(JSON.parse(defaultHistory.stdout).messages).toEqual([]);

    const projectHistory = runAt(home, [
      "history", "--as", "worker", "--workspace", "project-workspace",
    ], environment);
    expect(projectHistory.status).toBe(0);
    expect(JSON.parse(projectHistory.stdout).messages).toEqual([
      expect.objectContaining({ workspace: "project-workspace", content: "isolated" }),
    ]);
  });
  it("rejects a legacy workspace override because v1 has no tenant boundary", () => {
    const result = run(["doctor", "--as", "worker", "--workspace", "project-workspace"], {
      AGENT_BRIDGE_PROVIDER: "legacy-supabase",
      AGENT_BRIDGE_URL: "http://127.0.0.1:1",
      AGENT_BRIDGE_KEY: "publishable-key",
      AGENT_BRIDGE_AGENT: undefined,
      AGENT_BRIDGE_WORKSPACE: "*",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--workspace is not supported by the global legacy Supabase schema",
    );
    expect(result.stderr).not.toContain("network_error");
  });
  it("rejects a mismatched gateway workspace before network access", () => {
    const result = run(["doctor", "--as", "worker", "--workspace", "other"], {
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: "http://127.0.0.1:1",
      AGENT_BRIDGE_TOKEN: "test-token",
      AGENT_BRIDGE_AGENT: undefined,
      AGENT_BRIDGE_WORKSPACE: "acme",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--workspace must match the workspace bound to the gateway credential");
    expect(result.stderr).not.toContain("fetch failed");
  });
  it("accepts a gateway workspace assertion that matches the credential", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("x-agent-bridge-protocol-version", "2.1");
      response.setHeader("x-agent-bridge-supported-protocol-versions", "2.0,2.1");
      if (request.url === "/readyz") {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.url === "/v2/status") {
        response.end(JSON.stringify({
          schemaVersion: "postgres-v2",
          deliverySupported: true,
          pending: 0,
          claimed: 0,
          retrying: 0,
          dead: 0,
          principal: { workspace: "acme", agent: "worker" },
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "not_found" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test gateway did not bind TCP");
    try {
      const result = await runAtAsync(home, ["doctor", "--as", "worker", "--workspace", "acme"], {
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
        AGENT_BRIDGE_TOKEN: "test-token",
        AGENT_BRIDGE_AGENT: undefined,
        AGENT_BRIDGE_WORKSPACE: "acme",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        provider: "gateway",
        workspace: "acme",
        connected: true,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("reports unknown when gateway pending has no authoritative data", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const result = runAt(home, ["pending"], {
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: "http://127.0.0.1:1",
      AGENT_BRIDGE_TOKEN: "test-token",
      AGENT_BRIDGE_AGENT: "worker",
      AGENT_BRIDGE_WORKSPACE: "acme",
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      available: false,
      unread: false,
      authoritative: false,
      state: "unknown",
    });
  });
  it("reports gateway delivery work when there is no unread message", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("x-agent-bridge-protocol-version", "2.1");
      response.setHeader("x-agent-bridge-supported-protocol-versions", "2.0,2.1");
      if (request.url === "/readyz") {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.url === "/v2/status") {
        response.end(JSON.stringify({
          schemaVersion: "postgres-v2",
          deliverySupported: true,
          pending: 1,
          claimed: 0,
          retrying: 0,
          dead: 0,
          oldestAvailableAt: new Date(Date.now() - 1_000).toISOString(),
          principal: { workspace: "acme", agent: "worker" },
        }));
        return;
      }
      if (request.url?.startsWith("/v2/history")) {
        response.end(JSON.stringify({ messages: [] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "not_found" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test gateway did not bind TCP");
    try {
      const result = await runAtAsync(home, ["pending"], {
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
        AGENT_BRIDGE_TOKEN: "test-token",
        AGENT_BRIDGE_AGENT: "worker",
        AGENT_BRIDGE_WORKSPACE: "acme",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        available: true,
        unread: false,
        deliveryAvailable: true,
        pending: 1,
        authoritative: true,
        state: "available",
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("reports cached gateway candidates as available but not authoritative", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home); securePrivatePath(home, "directory");
    const endpoint = "http://127.0.0.1:1";
    const principal = { workspace: "acme", agent: "worker" };
    const path = join(home, ".agent-bridge", "edge.sqlite3");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); securePrivatePath(dirname(path), "directory");
    const edge = new SQLiteEdgeStore(path, { endpoint, principal });
    await edge.initialize();
    await edge.cacheLatest([{
      id: "018f4a70-0000-7000-8000-000000000199",
      sequence: "1",
      workspace: "acme",
      source: "codex",
      type: "request",
      content: "cached work",
      contentType: "text/plain",
      targets: ["worker"],
      priority: "high",
      createdAt: new Date().toISOString(),
    }]);
    await edge.close();

    const result = runAt(home, ["pending"], {
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: endpoint,
      AGENT_BRIDGE_TOKEN: "test-token",
      AGENT_BRIDGE_AGENT: "worker",
      AGENT_BRIDGE_WORKSPACE: "acme",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      available: true,
      unread: true,
      authoritative: false,
      state: "available",
    });
  });
  it("keeps pending non-authoritative when gateway authority changes mid-command", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("x-agent-bridge-protocol-version", "2.1");
      response.setHeader("x-agent-bridge-supported-protocol-versions", "2.0,2.1");
      if (request.url === "/readyz") {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.url === "/v2/status") {
        response.end(JSON.stringify({
          schemaVersion: "postgres-v2",
          deliverySupported: true,
          pending: 0,
          claimed: 0,
          retrying: 0,
          dead: 0,
          principal: { workspace: "acme", agent: "worker" },
        }));
        return;
      }
      response.statusCode = 503;
      response.end(JSON.stringify({ error: { code: "gateway_unavailable" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test gateway did not bind TCP");
    try {
      const result = await runAtAsync(home, ["pending"], {
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
        AGENT_BRIDGE_TOKEN: "test-token",
        AGENT_BRIDGE_AGENT: "worker",
        AGENT_BRIDGE_WORKSPACE: "acme",
      });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        available: false,
        authoritative: false,
        state: "unknown",
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
