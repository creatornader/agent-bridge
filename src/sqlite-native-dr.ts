import { randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, unlinkSync, type Stats,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { DatabaseSync as Database } from "node:sqlite";
import { NativeDrBundleError, NativeDrBundleReader, writeNativeDrBundle, type NativeDrBundleMetadata } from "./native-dr-bundle.js";
import { preparePrivateFileLocation, preparePrivateSqliteLocation, securePrivatePath, securePrivateSqliteFiles, verifyPrivatePathAccess } from "./private-path.js";
import { SQLiteBridgeStore } from "./sqlite-bridge-store.js";
import {
  assertLocalAuthorityDatabase, EDGE_SQLITE_APPLICATION_ID, identifySqliteDatabase, LOCAL_SQLITE_APPLICATION_ID,
  SQLITE_DATABASE_SCHEMA_VERSION, SQLiteDatabaseContractError, isSupportedLocalSqliteSchemaContract,
  sqliteSchemaContractHash, verifySqliteHealth,
} from "./sqlite-database-contract.js";

const require = createRequire(import.meta.url);
const SQLITE_ENTRY = "sqlite/database.sqlite3";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const WORKER_TERMINATION_TIMEOUT_MS = 5_000;

export class NativeDrCommandError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); }
}

export interface NativeDrFileOperations {
  link(source: string, target: string): void;
  unlink(path: string): void;
  syncDirectory(path: string): void;
  afterPublish?(target: string): void;
}

export interface SQLiteNativeDrOptions {
  timeoutMs?: number;
  fileOperations?: Partial<NativeDrFileOperations>;
  runBackupWorker?: typeof runSqliteBackupWorker;
  now?: () => Date;
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new NativeDrCommandError(code, message, details);
}

export function validateNativeDrId(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new NativeDrCommandError("INVALID_REQUEST_ID", "DR request and backup IDs must be UUIDs");
  }
  return normalized;
}

export function validateNativeDrTimeout(value: number | undefined): number {
  const selected = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(selected) || selected < 100 || selected > MAX_TIMEOUT_MS) {
    throw new NativeDrCommandError("INVALID_TIMEOUT", "DR timeout must be an integer from 100 to 86400000 milliseconds");
  }
  return selected;
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r"); try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function operations(options: SQLiteNativeDrOptions): NativeDrFileOperations {
  return {
    link: options.fileOperations?.link ?? linkSync,
    unlink: options.fileOperations?.unlink ?? unlinkSync,
    syncDirectory: options.fileOperations?.syncDirectory ?? syncDirectory,
    afterPublish: options.fileOperations?.afterPublish,
  };
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function database(path: string, readOnly = true): Database {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(path, { readOnly });
}

function verifyLocalDatabase(path: string): string {
  const target = preparePrivateSqliteLocation(path);
  const before = lstatSync(target); const db = database(target);
  try {
    assertLocalAuthorityDatabase(db); verifySqliteHealth(db); const contract = sqliteSchemaContractHash(db);
    const after = lstatSync(target);
    if (!sameIdentity(before, after)) throw new SQLiteDatabaseContractError("SQLite database path changed while verifying");
    return contract;
  } finally { db.close(); }
}

async function prepareBackupSource(path: string): Promise<string> {
  const source = preparePrivateSqliteLocation(path);
  if (!existsSync(source)) fail("SOURCE_NOT_FOUND", "local DR source does not exist");
  let db: Database | undefined; let kind: ReturnType<typeof identifySqliteDatabase> = "unknown";
  try {
    db = database(source);
    kind = identifySqliteDatabase(db);
    if (kind === "edge-cache" || kind === "legacy-edge") fail("EDGE_DATABASE_REJECTED", "edge databases are not supported by native DR v1");
    if (kind !== "local-authority" && kind !== "legacy-local") fail("INVALID_SOURCE", "DR source is not a local authority database");
    if (kind === "local-authority") { assertLocalAuthorityDatabase(db); verifySqliteHealth(db); }
  } finally { db?.close(); }
  if (kind === "legacy-local") {
    const store = new SQLiteBridgeStore(source);
    try { await store.initialize(); } finally { await store.close(); }
    verifyLocalDatabase(source);
  }
  return source;
}

const BACKUP_WORKER = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync, backup } = require("node:sqlite");
const { lstatSync } = require("node:fs");
(async () => {
  let source;
  try {
    const before = lstatSync(workerData.source);
    if (before.dev !== workerData.identity.dev || before.ino !== workerData.identity.ino) throw new Error("source identity changed");
    source = new DatabaseSync(workerData.source, { readOnly: true });
    const pages = await backup(source, workerData.destination, { rate: 64 });
    source.close(); source = undefined;
    const after = lstatSync(workerData.source);
    if (after.dev !== workerData.identity.dev || after.ino !== workerData.identity.ino) throw new Error("source identity changed");
    parentPort.postMessage({ ok: true, pages });
  } catch (error) {
    try { source?.close(); } catch {}
    parentPort.postMessage({ ok: false, code: error && typeof error.code === "string" ? error.code : "SQLITE_BACKUP_FAILED" });
  }
})();`;

export async function runSqliteBackupWorker(source: string, destination: string, timeoutMs: number): Promise<number> {
  const identity = lstatSync(source);
  const worker = new Worker(BACKUP_WORKER, { eval: true, workerData: { source, destination, identity: { dev: identity.dev, ino: identity.ino } } });
  return await new Promise<number>((resolvePromise, reject) => {
    let settled = false;
    const finish = async (callback: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try {
        await Promise.race([
          worker.terminate(),
          new Promise<never>((_resolve, rejectTermination) => {
            const terminationTimer = setTimeout(() => rejectTermination(new Error("worker termination timed out")), WORKER_TERMINATION_TIMEOUT_MS);
            terminationTimer.unref();
          }),
        ]);
      } catch {
        reject(new NativeDrCommandError(
          "SQLITE_BACKUP_TERMINATION_UNKNOWN",
          "SQLite backup worker termination could not be confirmed",
          { workerTermination: "unknown", recoveryPaths: [destination] },
        ));
        return;
      }
      callback();
    };
    const timer = setTimeout(() => {
      void finish(() => reject(new NativeDrCommandError("SQLITE_BACKUP_TIMEOUT", "SQLite online backup exceeded its hard deadline")));
    }, timeoutMs);
    timer.unref();
    worker.once("message", (message: { ok?: boolean; pages?: number }) => void finish(() => {
      if (!message?.ok || !Number.isSafeInteger(message.pages)) reject(new NativeDrCommandError("SQLITE_BACKUP_FAILED", "SQLite online backup failed"));
      else resolvePromise(message.pages!);
    }));
    worker.once("error", () => void finish(() => reject(new NativeDrCommandError("SQLITE_BACKUP_FAILED", "SQLite online backup worker failed"))));
    worker.once("exit", (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new NativeDrCommandError("SQLITE_BACKUP_FAILED", `SQLite online backup worker exited before completion (${code})`)); }
    });
  });
}

function cleanup(paths: readonly string[]): string[] {
  for (const path of paths) { try { if (existsSync(path)) unlinkSync(path); } catch { /* reported below */ } }
  return paths.filter(existsSync);
}

function verifyBundle(path: string): NativeDrBundleMetadata {
  const reader = new NativeDrBundleReader(path);
  try {
    const result = reader.inspect();
    if (result.manifest.kind !== "sqlite" || result.manifest.entries.length !== 1 || result.manifest.entries[0]!.name !== SQLITE_ENTRY
      || result.manifest.schema.applicationId !== LOCAL_SQLITE_APPLICATION_ID
      || result.manifest.schema.userVersion !== SQLITE_DATABASE_SCHEMA_VERSION
      || typeof result.manifest.schema.schemaContractSha256 !== "string"
      || !isSupportedLocalSqliteSchemaContract(result.manifest.schema.schemaContractSha256)) {
      throw new NativeDrBundleError("DR bundle is not a supported local SQLite backup");
    }
    return result;
  } finally { reader.close(); }
}

export async function backupLocalSqlite(
  sourcePath: string,
  outputPath: string,
  backupIdInput: string = randomUUID(),
  options: SQLiteNativeDrOptions = {},
): Promise<NativeDrBundleMetadata> {
  const backupId = validateNativeDrId(backupIdInput); const timeoutMs = validateNativeDrTimeout(options.timeoutMs);
  const source = await prepareBackupSource(sourcePath); const sourceIdentity = lstatSync(source);
  const target = resolve(outputPath); const directory = dirname(target);
  preparePrivateFileLocation(target);
  const snapshot = join(directory, `.${backupId}.agent-bridge-dr.sqlite.tmp`);
  const bundle = join(directory, `.${backupId}.agent-bridge-dr.bundle.tmp`);
  const existingRecoveryPaths = [bundle, snapshot].filter(existsSync);
  if (existingRecoveryPaths.length) fail("DR_RECOVERY_REQUIRED", "a prior DR backup with this ID requires recovery", {
    backupId, output: target, outputExists: existsSync(target), published: existsSync(target) ? "unknown" : false,
    recoveryPaths: existingRecoveryPaths,
  });
  if (existsSync(target)) fail("OUTPUT_EXISTS", "DR output already exists");
  let bundleDescriptor: number | undefined; let published = false; let durable = false;
  const fileOps = operations(options);
  try {
    await (options.runBackupWorker ?? runSqliteBackupWorker)(source, snapshot, timeoutMs);
    securePrivateSqliteFiles(snapshot); const schemaContractSha256 = verifyLocalDatabase(snapshot);
    const afterBackup = lstatSync(source);
    if (sourceIdentity.dev !== afterBackup.dev || sourceIdentity.ino !== afterBackup.ino) fail("SOURCE_CHANGED", "DR source path changed during online backup");
    bundleDescriptor = openSync(bundle, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); securePrivatePath(bundle, "file");
    writeNativeDrBundle(bundleDescriptor, {
      backupId,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      entries: [{ name: SQLITE_ENTRY, path: snapshot }],
      kind: "sqlite",
      schema: { applicationId: LOCAL_SQLITE_APPLICATION_ID, userVersion: SQLITE_DATABASE_SCHEMA_VERSION, schemaContractSha256 },
    }, bundle);
    closeSync(bundleDescriptor); bundleDescriptor = undefined;
    const beforePublication = verifyBundle(bundle);
    try { fileOps.link(bundle, target); published = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("OUTPUT_EXISTS", "DR output already exists");
      throw error;
    }
    try { fileOps.afterPublish?.(target); fileOps.syncDirectory(directory); durable = true; }
    catch { fail("DR_PUBLICATION_AMBIGUOUS", "DR output is visible but durability is unknown", { backupId, output: target, published: true, durable: "unknown", recoveryPaths: [bundle, snapshot].filter(existsSync) }); }
    let publishedMetadata: NativeDrBundleMetadata;
    try { publishedMetadata = verifyBundle(target); }
    catch { fail("DR_PUBLICATION_INVALID", "published DR output could not be verified", { backupId, output: target, published: true, durable: true, verified: false, recoveryPaths: [bundle, snapshot].filter(existsSync) }); }
    if (publishedMetadata.bundleSha256 !== beforePublication.bundleSha256) {
      fail("DR_PUBLICATION_INVALID", "published DR output does not match its verified staging bundle", { backupId, output: target, published: true, durable: true, verified: false, recoveryPaths: [bundle, snapshot].filter(existsSync) });
    }
    try { fileOps.unlink(bundle); fileOps.unlink(snapshot); fileOps.syncDirectory(directory); }
    catch { fail("DR_RECOVERY_ARTIFACT_RETAINED", "DR output is valid but a recovery artifact remains", { backupId, output: target, published: true, durable: true, verified: true, recoveryPaths: [bundle, snapshot].filter(existsSync) }); }
    return publishedMetadata;
  } catch (error) {
    if (bundleDescriptor !== undefined) { closeSync(bundleDescriptor); bundleDescriptor = undefined; }
    if (!published) {
      const retainPossiblyActiveSnapshot = error instanceof NativeDrCommandError
        && error.code === "SQLITE_BACKUP_TERMINATION_UNKNOWN";
      const recoveryPaths = retainPossiblyActiveSnapshot ? [bundle, snapshot].filter(existsSync) : cleanup([bundle, snapshot]);
      if (error instanceof NativeDrCommandError) {
        throw new NativeDrCommandError(error.code, error.message, recoveryPaths.length ? { ...error.details, backupId, recoveryPaths } : error.details);
      }
      fail("DR_BACKUP_FAILED", "local SQLite backup failed", recoveryPaths.length ? { backupId, recoveryPaths } : { backupId });
    }
    if (error instanceof NativeDrCommandError) throw error;
    if (published) fail("DR_PUBLICATION_AMBIGUOUS", "DR publication outcome is incomplete", { backupId, output: target, published: true, durable: durable || "unknown", recoveryPaths: [bundle, snapshot].filter(existsSync) });
  } finally {
    if (bundleDescriptor !== undefined) closeSync(bundleDescriptor);
  }
  throw new NativeDrCommandError("DR_BACKUP_FAILED", "local SQLite backup failed");
}

export function verifyNativeDrBundle(path: string): NativeDrBundleMetadata {
  try { return verifyBundle(path); }
  catch (error) {
    if (error instanceof NativeDrCommandError) throw error;
    fail("INVALID_DR_BUNDLE", "DR bundle verification failed");
  }
}

export async function restoreLocalSqlite(
  bundlePath: string,
  targetPath: string,
  requestIdInput: string = randomUUID(),
  options: SQLiteNativeDrOptions = {},
): Promise<NativeDrBundleMetadata & { requestId: string }> {
  const requestId = validateNativeDrId(requestIdInput); validateNativeDrTimeout(options.timeoutMs);
  const bundle = resolve(bundlePath); const metadata = verifyBundle(bundle);
  const target = resolve(targetPath); const directory = dirname(target); preparePrivateFileLocation(target);
  const staged = join(directory, `.${requestId}.agent-bridge-dr.restore.sqlite.tmp`);
  if (existsSync(staged)) fail("DR_RECOVERY_REQUIRED", "a prior DR restore with this ID requires recovery", {
    requestId, target, targetExists: existsSync(target), published: existsSync(target) ? "unknown" : false,
    recoveryPaths: [staged],
  });
  if (existsSync(target) || existsSync(`${target}-wal`) || existsSync(`${target}-shm`)) fail("TARGET_EXISTS", "DR restore target must be fresh");
  let descriptor: number | undefined; let published = false; let durable = false;
  const fileOps = operations(options);
  try {
    descriptor = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); securePrivatePath(staged, "file");
    const reader = new NativeDrBundleReader(bundle);
    try {
      const extracted = reader.inspect((entry) => entry.name === SQLITE_ENTRY ? descriptor : undefined);
      if (extracted.bundleSha256 !== metadata.bundleSha256) throw new NativeDrBundleError("DR bundle changed between verification passes");
    } finally { reader.close(); }
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined; securePrivateSqliteFiles(staged);
    const restoredContract = verifyLocalDatabase(staged);
    if (restoredContract !== metadata.manifest.schema.schemaContractSha256) throw new NativeDrBundleError("restored SQLite schema contract does not match the manifest");
    try { fileOps.link(staged, target); published = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("TARGET_EXISTS", "DR restore target must be fresh");
      throw error;
    }
    try { fileOps.afterPublish?.(target); fileOps.syncDirectory(directory); durable = true; }
    catch { fail("DR_RESTORE_AMBIGUOUS", "restored database is visible but durability is unknown", { requestId, target, published: true, durable: "unknown", verified: false, recoveryPaths: [staged] }); }
    try {
      const publishedContract = verifyLocalDatabase(target);
      if (publishedContract !== metadata.manifest.schema.schemaContractSha256) throw new NativeDrBundleError("published SQLite schema contract does not match the manifest");
    }
    catch { fail("DR_RESTORE_INVALID", "restored database is visible but failed verification", { requestId, target, published: true, durable: true, verified: false, recoveryPaths: [staged] }); }
    try { fileOps.unlink(staged); }
    catch {
      fail("DR_RECOVERY_ARTIFACT_RETAINED", "restored database is valid but a recovery artifact remains", {
        requestId, target, published: true, durable: true, verified: true, recoveryPaths: [staged].filter(existsSync),
      });
    }
    try {
      securePrivateSqliteFiles(target);
      if (verifyLocalDatabase(target) !== metadata.manifest.schema.schemaContractSha256) {
        throw new NativeDrBundleError("published SQLite schema contract changed during cleanup");
      }
    }
    catch {
      fail("DR_RESTORE_INVALID", "restored database failed post-cleanup verification", {
        requestId, target, published: true, durable: true, verified: false, recoveryPaths: [],
      });
    }
    try { fileOps.syncDirectory(directory); }
    catch {
      fail("DR_CLEANUP_DURABILITY_UNKNOWN", "restored database is valid but staging cleanup durability is unknown", {
        requestId, target, published: true, durable: true, verified: true, recoveryPaths: [],
      });
    }
    return { ...metadata, requestId };
  } catch (error) {
    if (descriptor !== undefined) { closeSync(descriptor); descriptor = undefined; }
    if (!published) {
      const recoveryPaths = cleanup([staged]);
      if (error instanceof NativeDrCommandError) {
        throw new NativeDrCommandError(error.code, error.message, recoveryPaths.length ? { ...error.details, requestId, recoveryPaths } : error.details);
      }
      fail("DR_RESTORE_FAILED", "local SQLite restore failed", recoveryPaths.length ? { requestId, recoveryPaths } : { requestId });
    }
    if (error instanceof NativeDrCommandError) throw error;
    if (published) fail("DR_RESTORE_AMBIGUOUS", "DR restore outcome is incomplete", { requestId, target, published: true, durable: durable || "unknown", verified: false, recoveryPaths: [staged].filter(existsSync) });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  throw new NativeDrCommandError("DR_RESTORE_FAILED", "local SQLite restore failed");
}

export const SQLITE_EDGE_APPLICATION_ID = EDGE_SQLITE_APPLICATION_ID;
