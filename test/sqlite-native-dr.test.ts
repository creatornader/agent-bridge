import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it as vitestIt } from "vitest";
import { BridgeService } from "../src/bridge-service.js";
import { writeNativeDrBundle } from "../src/native-dr-bundle.js";
import { SQLiteBridgeStore } from "../src/sqlite-bridge-store.js";
import { SQLiteEdgeStore } from "../src/sqlite-edge-store.js";
import { EDGE_SQLITE_APPLICATION_ID, LOCAL_SQLITE_APPLICATION_ID, SQLITE_DATABASE_SCHEMA_VERSION, sqliteSchemaContractHash } from "../src/sqlite-database-contract.js";
import { backupLocalSqlite, NativeDrCommandError, restoreLocalSqlite, verifyNativeDrBundle } from "../src/sqlite-native-dr.js";
import { privateTestDirectory, secureTestFile } from "./private-test-path.js";
import { privatePathIt } from "./private-path-policy.js";

const it = privatePathIt;

const require = createRequire(import.meta.url);
const roots: string[] = [];
const nativeTestTimeout = process.platform === "win32" ? 90_000 : 30_000;
function root(): string { const path = privateTestDirectory("agent-bridge-sqlite-dr-"); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function local(path: string): Promise<SQLiteBridgeStore> {
  const store = new SQLiteBridgeStore(path); await store.initialize(); return store;
}

describe("local SQLite native DR", () => {
  it("backs up a live WAL database and restores every native row", async () => {
    const directory = root(); const source = join(directory, "source.sqlite3"); const bundle = join(directory, "backup.abdr"); const target = join(directory, "target.sqlite3");
    const store = await local(source); const service = new BridgeService(store);
    const sent = await service.publish({ workspace: "acme", agent: "publisher" }, { type: "work", content: "native row", targets: ["worker"] });
    await service.acknowledge({ workspace: "acme", agent: "worker" }, [sent.message.id]);
    const backedUp = await backupLocalSqlite(source, bundle, "018f4a70-0000-7000-8000-000000000211");
    expect(backedUp.manifest.kind).toBe("sqlite"); expect(backedUp.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    if (process.platform !== "win32") expect(lstatSync(bundle).mode & 0o077).toBe(0);
    const restored = await restoreLocalSqlite(bundle, target, "018f4a70-0000-7000-8000-000000000212");
    expect(restored.requestId).toBe("018f4a70-0000-7000-8000-000000000212");
    const copy = await local(target);
    expect((await copy.listMessages({ workspace: "acme", agent: "worker" })).messages.map((message) => message.content)).toEqual(["native row"]);
    await copy.close(); await store.close();
  }, nativeTestTimeout);

  it("marks local and edge databases distinctly and rejects edge backup", async () => {
    const directory = root(); const localPath = join(directory, "local.sqlite3"); const edgePath = join(directory, "edge.sqlite3");
    const authority = await local(localPath); await authority.close();
    const edge = new SQLiteEdgeStore(edgePath, { endpoint: "https://bridge.example", principal: { workspace: "acme", agent: "codex" } });
    await edge.initialize(); await edge.close();
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const localRaw = new DatabaseSync(localPath, { readOnly: true }); const edgeRaw = new DatabaseSync(edgePath, { readOnly: true });
    expect((localRaw.prepare("PRAGMA application_id").get() as any).application_id).toBe(LOCAL_SQLITE_APPLICATION_ID);
    expect((edgeRaw.prepare("PRAGMA application_id").get() as any).application_id).toBe(EDGE_SQLITE_APPLICATION_ID);
    localRaw.close(); edgeRaw.close();
    await expect(backupLocalSqlite(edgePath, join(directory, "edge.abdr"))).rejects.toMatchObject({ code: "EDGE_DATABASE_REJECTED" });
  });

  it("refuses to bless schema drift and conflicting kind markers", async () => {
    const directory = root(); const drifted = join(directory, "drifted.sqlite3"); const conflict = join(directory, "conflict.sqlite3"); const arbitrary = join(directory, "arbitrary.sqlite3");
    for (const path of [drifted, conflict]) { const store = await local(path); await store.close(); }
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const drift = new DatabaseSync(drifted); drift.exec("CREATE TABLE unexpected_data(value TEXT)"); drift.close();
    const driftedStore = new SQLiteBridgeStore(drifted); await expect(driftedStore.initialize()).rejects.toThrow(/unexpected (pre-migration )?schema object/); await driftedStore.close();
    const conflicting = new DatabaseSync(conflict); conflicting.exec(`PRAGMA application_id=${EDGE_SQLITE_APPLICATION_ID}`); conflicting.close();
    const conflictingStore = new SQLiteBridgeStore(conflict); await expect(conflictingStore.initialize()).rejects.toThrow(/kind marker|metadata kind markers conflict/); await conflictingStore.close();
    const unmarked = new DatabaseSync(arbitrary); unmarked.exec("CREATE TABLE unrelated(value TEXT)"); unmarked.close(); secureTestFile(arbitrary);
    const arbitraryStore = new SQLiteBridgeStore(arbitrary); await expect(arbitraryStore.initialize()).rejects.toThrow(/unexpected pre-migration schema object/); await arbitraryStore.close();
    const unchanged = new DatabaseSync(arbitrary, { readOnly: true });
    expect((unchanged.prepare("PRAGMA application_id").get() as any).application_id).toBe(0);
    expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name='agent_bridge_metadata'").get()).toBeUndefined(); unchanged.close();
  });

  it("rejects tampered triggers, indexes, constraints, and edge definitions", async () => {
    const directory = root(); const triggerPath = join(directory, "trigger.sqlite3"); const indexPath = join(directory, "index.sqlite3"); const tablePath = join(directory, "table.sqlite3");
    for (const path of [triggerPath, indexPath, tablePath]) { const store = await local(path); await store.close(); }
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const trigger = new DatabaseSync(triggerPath); trigger.exec("DROP TRIGGER bridge_messages_no_update; CREATE TRIGGER bridge_messages_no_update BEFORE UPDATE ON bridge_messages BEGIN SELECT 1; END"); trigger.close();
    const triggerStore = new SQLiteBridgeStore(triggerPath); await expect(triggerStore.initialize()).rejects.toThrow(/schema contract hash/); await triggerStore.close();
    const index = new DatabaseSync(indexPath); index.exec("DROP INDEX bridge_messages_cursor; CREATE INDEX bridge_messages_cursor ON bridge_messages(workspace,source)"); index.close();
    const indexStore = new SQLiteBridgeStore(indexPath); await expect(indexStore.initialize()).rejects.toThrow(/schema contract hash/); await indexStore.close();
    const table = new DatabaseSync(tablePath); table.exec(`DROP INDEX bridge_presence_active; DROP TABLE bridge_presence;
      CREATE TABLE bridge_presence (workspace TEXT NOT NULL,agent TEXT NOT NULL,instance TEXT NOT NULL,runtime_type TEXT,capabilities TEXT NOT NULL DEFAULT '[]',lease_expires_at TEXT NOT NULL,last_seen_at TEXT NOT NULL);
      CREATE INDEX bridge_presence_active ON bridge_presence(workspace,lease_expires_at)`); table.close();
    const tableStore = new SQLiteBridgeStore(tablePath); await expect(tableStore.initialize()).rejects.toThrow(/schema contract hash/); await tableStore.close();
    const edgePath = join(directory, "edge-tampered.sqlite3"); const edge = new SQLiteEdgeStore(edgePath, { endpoint: "https://bridge.example", principal: { workspace: "acme", agent: "codex" } }); await edge.initialize(); await edge.close();
    const edgeRaw = new DatabaseSync(edgePath); edgeRaw.exec("DROP INDEX edge_inbox_cursor; CREATE INDEX edge_inbox_cursor ON edge_inbox(scope_key,source)"); edgeRaw.close();
    const edgeRestart = new SQLiteEdgeStore(edgePath, { endpoint: "https://bridge.example", principal: { workspace: "acme", agent: "codex" } }); await expect(edgeRestart.initialize()).rejects.toThrow(/schema contract hash/); await edgeRestart.close();
  });

  it("rejects corrupted bundles and foreign-key-invalid restore stages", async () => {
    const directory = root(); const source = join(directory, "source.sqlite3"); const bundle = join(directory, "bad-fk.abdr");
    const store = await local(source); await store.close();
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(source); const schemaContractSha256 = sqliteSchemaContractHash(raw); raw.exec("PRAGMA foreign_keys=OFF");
    raw.prepare("INSERT INTO bridge_receipts(workspace,message_id,principal,read_at) VALUES ('acme','missing','worker','2026-07-15T00:00:00.000Z')").run(); raw.close();
    const descriptor = openSync(bundle, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    secureTestFile(bundle);
    try {
      writeNativeDrBundle(descriptor, {
        backupId: "018f4a70-0000-7000-8000-000000000213", createdAt: "2026-07-15T00:00:00.000Z", kind: "sqlite",
        entries: [{ name: "sqlite/database.sqlite3", path: source }],
        schema: { applicationId: LOCAL_SQLITE_APPLICATION_ID, userVersion: SQLITE_DATABASE_SCHEMA_VERSION, schemaContractSha256 },
      }, bundle);
    } finally { closeSync(descriptor); }
    const target = join(directory, "target.sqlite3");
    await expect(restoreLocalSqlite(bundle, target)).rejects.toMatchObject({ code: "DR_RESTORE_FAILED" });
    expect(existsSync(target)).toBe(false);
    const corrupted = join(directory, "corrupted.abdr"); const bytes = readFileSync(bundle); bytes[bytes.length - 1] ^= 1; writeFileSync(corrupted, bytes, { mode: 0o600 });
    secureTestFile(corrupted);
    expect(() => verifyNativeDrBundle(corrupted)).toThrow(expect.objectContaining({ code: "INVALID_DR_BUNDLE" }));
  });

  it("publishes no-replace under a backup race", async () => {
    const directory = root(); const source = join(directory, "source.sqlite3"); const output = join(directory, "backup.abdr");
    const store = await local(source); await new BridgeService(store).publish({ workspace: "acme", agent: "codex" }, { type: "note", content: "race" }); await store.close();
    await expect(backupLocalSqlite(source, output, "018f4a70-0000-7000-8000-000000000214", {
      fileOperations: { link: (_staged, selected) => { writeFileSync(selected, "racer", { mode: 0o600 }); secureTestFile(selected); const error = new Error("exists") as NodeJS.ErrnoException; error.code = "EEXIST"; throw error; } },
    })).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    expect(readFileSync(output, "utf8")).toBe("racer");
    expect(existsSync(join(directory, ".018f4a70-0000-7000-8000-000000000214.agent-bridge-dr.bundle.tmp"))).toBe(false);
  }, nativeTestTimeout);

  it("keeps restore fresh-target-only under a publication race", async () => {
    const directory = root(); const source = join(directory, "source.sqlite3"); const bundle = join(directory, "backup.abdr"); const target = join(directory, "target.sqlite3");
    const store = await local(source); await store.close();
    await backupLocalSqlite(source, bundle, "018f4a70-0000-7000-8000-000000000218");
    await expect(restoreLocalSqlite(bundle, target, "018f4a70-0000-7000-8000-000000000219", {
      fileOperations: { link: (staged, selected) => { writeFileSync(selected, "racer", { mode: 0o600 }); secureTestFile(selected); const error = new Error("exists") as NodeJS.ErrnoException; error.code = "EEXIST"; throw error; } },
    })).rejects.toMatchObject({ code: "TARGET_EXISTS" });
    expect(readFileSync(target, "utf8")).toBe("racer");
    const retryStage = join(directory, ".018f4a70-0000-7000-8000-000000000219.agent-bridge-dr.restore.sqlite.tmp");
    expect(existsSync(retryStage)).toBe(false);
    writeFileSync(retryStage, "prior stage", { mode: 0o600 }); secureTestFile(retryStage);
    await expect(restoreLocalSqlite(bundle, target, "018f4a70-0000-7000-8000-000000000219"))
      .rejects.toMatchObject({
        code: "DR_RECOVERY_REQUIRED",
        details: { target, targetExists: true, published: "unknown", recoveryPaths: [retryStage] },
      });
    const sidecarOnly = join(directory, "sidecar-only.sqlite3");
    writeFileSync(`${sidecarOnly}-wal`, "occupied", { mode: 0o600 }); secureTestFile(`${sidecarOnly}-wal`);
    await expect(restoreLocalSqlite(bundle, sidecarOnly, randomUUID())).rejects.toMatchObject({ code: "TARGET_EXISTS" });
  });

  it("reports distinct restore cleanup failures truthfully", async () => {
    const directory = root();
    const source = join(directory, "source.sqlite3");
    const bundle = join(directory, "backup.abdr");
    const store = await local(source); await store.close();
    await backupLocalSqlite(source, bundle, "018f4a70-0000-7000-8000-000000000241");

    const retainedTarget = join(directory, "retained.sqlite3");
    const retainedId = "018f4a70-0000-7000-8000-000000000242";
    const retainedStage = join(directory, `.${retainedId}.agent-bridge-dr.restore.sqlite.tmp`);
    await expect(restoreLocalSqlite(bundle, retainedTarget, retainedId, {
      fileOperations: { unlink: () => { throw new Error("injected unlink failure"); } },
    })).rejects.toMatchObject({
      code: "DR_RECOVERY_ARTIFACT_RETAINED",
      details: { verified: true, recoveryPaths: [retainedStage] },
    });

    const invalidTarget = join(directory, "invalid.sqlite3");
    await expect(restoreLocalSqlite(bundle, invalidTarget, "018f4a70-0000-7000-8000-000000000243", {
      fileOperations: {
        unlink: (path) => { unlinkSync(path); writeFileSync(invalidTarget, "corrupt", { flag: "w" }); },
      },
    })).rejects.toMatchObject({
      code: "DR_RESTORE_INVALID",
      details: { verified: false, recoveryPaths: [] },
    });

    const uncertainTarget = join(directory, "uncertain.sqlite3");
    let syncCalls = 0;
    await expect(restoreLocalSqlite(bundle, uncertainTarget, "018f4a70-0000-7000-8000-000000000244", {
      fileOperations: { syncDirectory: () => { syncCalls += 1; if (syncCalls === 2) throw new Error("injected cleanup sync failure"); } },
    })).rejects.toMatchObject({
      code: "DR_CLEANUP_DURABILITY_UNKNOWN",
      details: { verified: true, recoveryPaths: [] },
    });
  }, 90_000);

  it("reports deadline cleanup and post-publication ambiguity truthfully", async () => {
    const directory = root(); const source = join(directory, "source.sqlite3"); const store = await local(source); await store.close();
    const timedOutId = "018f4a70-0000-7000-8000-000000000216";
    await expect(backupLocalSqlite(source, join(directory, "timeout.abdr"), timedOutId, {
      runBackupWorker: async () => { throw new NativeDrCommandError("SQLITE_BACKUP_TIMEOUT", "deadline"); },
    })).rejects.toMatchObject({ code: "SQLITE_BACKUP_TIMEOUT" });
    expect(existsSync(join(directory, `.${timedOutId}.agent-bridge-dr.sqlite.tmp`))).toBe(false);
    const unknownTerminationId = "018f4a70-0000-7000-8000-000000000221";
    const unknownTerminationStage = join(directory, `.${unknownTerminationId}.agent-bridge-dr.sqlite.tmp`);
    await expect(backupLocalSqlite(source, join(directory, "unknown-termination.abdr"), unknownTerminationId, {
      runBackupWorker: async (_source, destination) => {
        writeFileSync(destination, "possibly active", { mode: 0o600 }); secureTestFile(destination);
        throw new NativeDrCommandError(
          "SQLITE_BACKUP_TERMINATION_UNKNOWN",
          "worker termination could not be confirmed",
          { workerTermination: "unknown", recoveryPaths: [destination] },
        );
      },
    })).rejects.toMatchObject({
      code: "SQLITE_BACKUP_TERMINATION_UNKNOWN",
      details: { workerTermination: "unknown", recoveryPaths: [unknownTerminationStage] },
    });
    expect(existsSync(unknownTerminationStage)).toBe(true);
    const ambiguousOutput = join(directory, "ambiguous.abdr");
    const ambiguousId = "018f4a70-0000-7000-8000-000000000217";
    const ambiguousBundle = join(directory, `.${ambiguousId}.agent-bridge-dr.bundle.tmp`);
    const ambiguousSnapshot = join(directory, `.${ambiguousId}.agent-bridge-dr.sqlite.tmp`);
    await expect(backupLocalSqlite(source, ambiguousOutput, ambiguousId, {
      fileOperations: { syncDirectory: () => { throw new Error("injected"); } },
    })).rejects.toMatchObject({
      code: "DR_PUBLICATION_AMBIGUOUS",
      details: { published: true, durable: "unknown", recoveryPaths: [ambiguousBundle, ambiguousSnapshot] },
    });
    expect(existsSync(ambiguousOutput)).toBe(true);
    await expect(backupLocalSqlite(source, ambiguousOutput, ambiguousId)).rejects.toMatchObject({
      code: "DR_RECOVERY_REQUIRED",
      details: {
        output: ambiguousOutput, outputExists: true, published: "unknown",
        recoveryPaths: [ambiguousBundle, ambiguousSnapshot],
      },
    });
  }, nativeTestTimeout);

  vitestIt.skipIf(process.platform === "win32")("terminates a real timed-out backup worker before cleaning its destination", async () => {
    const directory = root(); const source = join(directory, "large.sqlite3"); const output = join(directory, "timeout.abdr");
    const store = await local(source); await store.close();
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite"); const raw = new DatabaseSync(source);
    const insert = raw.prepare(`INSERT INTO bridge_messages
      (id,workspace,source,type,content,content_type,targets,priority,delivery_policy,created_at,metadata)
      VALUES (?,'acme','legacy','note','bulk','text/plain','[]','info','{"mode":"mailbox"}','2026-07-15T00:00:00.000Z',?)`);
    raw.exec("BEGIN");
    try { for (let index = 0; index < 1_500; index += 1) insert.run(`bulk-${index}`, `{"blob":"${"x".repeat(64 * 1024 - 20)}"}`); raw.exec("COMMIT"); }
    catch (error) { raw.exec("ROLLBACK"); throw error; }
    raw.close();
    const id = "018f4a70-0000-7000-8000-000000000220"; const stage = join(directory, `.${id}.agent-bridge-dr.sqlite.tmp`);
    await expect(backupLocalSqlite(source, output, id, { timeoutMs: 100 })).rejects.toMatchObject({ code: "SQLITE_BACKUP_TIMEOUT" });
    expect(existsSync(stage)).toBe(false); await new Promise((resolve) => setTimeout(resolve, 300)); expect(existsSync(stage)).toBe(false);
  }, 90_000);
});
