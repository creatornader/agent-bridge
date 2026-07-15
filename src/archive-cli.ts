import { randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync,
  openSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import pg from "pg";
import { readClientConfigFile } from "./client-config.js";
import { PortableArchiveFile } from "./portable-archive-file.js";
import { PortableArchiveError, validatePortableArchiveRequestId } from "./portable-archive-format.js";
import type { PortableArchiveExportSession, PortableArchiveMetadata, PortableArchiveStore } from "./portable-archive-store.js";
import { streamPortableArchive } from "./portable-archive.js";
import { PostgresPortableArchiveStore } from "./postgres-portable-archive-store.js";
import { PrivatePathError, securePrivatePath, verifyPrivatePathAccess } from "./private-path.js";
import { SQLitePortableArchiveStore } from "./sqlite-portable-archive-store.js";

type ArchiveProvider = "local" | "postgres";
type ArchiveOperation = "export" | "verify" | "import";
type ArchiveOptions = Record<string, string | true>;
const BOOLEAN_OPTIONS = new Set(["apply", "dry-run", "force"]);
const OPERATION_OPTIONS: Record<ArchiveOperation, ReadonlySet<string>> = {
  export: new Set(["provider", "workspace", "output", "db", "config", "force", "request-id"]),
  verify: new Set(["file"]),
  import: new Set(["provider", "file", "db", "config", "workspace", "request-id", "apply", "dry-run"]),
};

export class ArchiveCommandError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); }
}
function fail(code: string, message: string, details?: Record<string, unknown>): never { throw new ArchiveCommandError(code, message, details); }

function parseArchiveArgs(argv: string[]): { operation: ArchiveOperation; options: ArchiveOptions } {
  const operation = argv[0];
  if (operation !== "export" && operation !== "verify" && operation !== "import") fail("INVALID_COMMAND", "usage: agent-bridge archive <export|verify|import>");
  const options: ArchiveOptions = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--") || argument === "--") fail("INVALID_ARGUMENT", `unexpected positional argument: ${argument}`);
    const name = argument.slice(2);
    if (!name || name.includes("=")) fail("INVALID_OPTION", `invalid option: ${argument}`);
    if (!OPERATION_OPTIONS[operation].has(name)) fail("INVALID_OPTION", `--${name} is not valid for archive ${operation}`);
    if (options[name] !== undefined) fail("DUPLICATE_OPTION", `--${name} may only be provided once`);
    if (BOOLEAN_OPTIONS.has(name)) { options[name] = true; continue; }
    const selected = argv[index + 1];
    if (!selected || selected.startsWith("--")) fail("MISSING_OPTION_VALUE", `--${name} requires a value`);
    options[name] = selected; index += 1;
  }
  if (operation === "import" && options.apply === true && options["dry-run"] === true) fail("INVALID_OPTION", "--apply and --dry-run are mutually exclusive");
  return { operation, options };
}

const stringOption = (options: ArchiveOptions, name: string): string | undefined => typeof options[name] === "string" ? options[name] as string : undefined;
function archiveRequestId(options: ArchiveOptions): string {
  const value = stringOption(options, "request-id") ?? randomUUID();
  try { return validatePortableArchiveRequestId(value); }
  catch { return fail("INVALID_REQUEST_ID", "--request-id must be a UUID"); }
}
function required(options: ArchiveOptions, name: string): string { const selected = stringOption(options, name)?.trim(); if (!selected) fail("MISSING_OPTION", `--${name} is required`); return selected; }
function provider(options: ArchiveOptions): ArchiveProvider {
  const selected = required(options, "provider");
  if (selected !== "local" && selected !== "postgres") fail("INVALID_PROVIDER", "--provider must be local or postgres");
  if (selected === "postgres" && (options.db !== undefined || options.config !== undefined)) fail("INVALID_OPTION", "PostgreSQL archives accept authority only from AGENT_BRIDGE_ARCHIVE_DATABASE_URL");
  return selected;
}
const home = (env: NodeJS.ProcessEnv): string => env.HOME?.trim() || homedir();
function localDatabase(options: ArchiveOptions, env: NodeJS.ProcessEnv): string {
  const configPath = stringOption(options, "config") ?? env.AGENT_BRIDGE_CONFIG?.trim() ?? join(home(env), ".agent-bridge", "config");
  const config = readClientConfigFile(configPath);
  const selected = stringOption(options, "db") ?? env.AGENT_BRIDGE_DB?.trim() ?? config.AGENT_BRIDGE_DB?.trim() ?? join(home(env), ".agent-bridge", "bridge.sqlite3");
  return isAbsolute(selected) ? selected : resolve(selected);
}
function createStore(selected: ArchiveProvider, options: ArchiveOptions, env: NodeJS.ProcessEnv): { store: PortableArchiveStore; close(): Promise<void> } {
  if (selected === "local") { const store = new SQLitePortableArchiveStore(localDatabase(options, env)); return { store, close: async () => { store.close(); } }; }
  const databaseUrl = env.AGENT_BRIDGE_ARCHIVE_DATABASE_URL?.trim();
  if (!databaseUrl) fail("MISSING_AUTHORITY", "AGENT_BRIDGE_ARCHIVE_DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
  return { store: new PostgresPortableArchiveStore(pool), close: () => pool.end() };
}
function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r"); try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

type ArchiveStreamer = typeof streamPortableArchive;
export interface ArchivePublicationFileOperations {
  link(source: string, target: string): void;
  rename(source: string, target: string): void;
  unlink(path: string): void;
  syncDirectory(path: string): void;
}

export async function publishArchive(
  path: string,
  force: boolean,
  session: PortableArchiveExportSession,
  workspace: string,
  options: { requestId: string; stream?: ArchiveStreamer; fileOperations?: Partial<ArchivePublicationFileOperations> },
) {
  const exportRequestId = validatePortableArchiveRequestId(options.requestId);
  const target = resolve(path);
  const directory = dirname(target);
  const temporary = join(directory, `.${exportRequestId}.agent-bridge-archive.tmp`);
  const backup = join(directory, `.${exportRequestId}.agent-bridge-archive.backup`);
  const operations: ArchivePublicationFileOperations = {
    link: options.fileOperations?.link ?? linkSync,
    rename: options.fileOperations?.rename ?? renameSync,
    unlink: options.fileOperations?.unlink ?? unlinkSync,
    syncDirectory: options.fileOperations?.syncDirectory ?? syncDirectory,
  };
  let descriptor: number | undefined; let created = false; let linked = false;
  let replacementVisible = false; let durablyPublished = false; let backupCreated = false;
  let preserveBackup = false; let targetExisted = false;
  const ambiguous = (message: string) => new ArchiveCommandError(
    "ARCHIVE_PUBLICATION_AMBIGUOUS",
    message,
    {
      requestId: exportRequestId, file: target, published: "unknown", auditStatus: "started",
      ...(backupCreated ? { backupFile: backup } : {}),
    },
  );
  try {
    verifyPrivatePathAccess(directory, "directory");
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) fail("INVALID_OUTPUT", "archive output must be a regular file");
      if (!force) fail("OUTPUT_EXISTS", "archive output already exists; pass --force to replace it");
      targetExisted = true;
    }
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); created = true;
    securePrivatePath(temporary, "file");
    const metadata = await (options.stream ?? streamPortableArchive)(session, workspace, exportRequestId, (bytes) => {
      let offset = 0; while (offset < bytes.length) offset += writeSync(descriptor!, bytes, offset, bytes.length - offset);
    });
    fsyncSync(descriptor);
    const opened = fstatSync(descriptor); const named = lstatSync(temporary);
    if (opened.dev !== named.dev || opened.ino !== named.ino || !named.isFile() || named.isSymbolicLink()) fail("INVALID_OUTPUT", "archive temporary path identity changed before publication");
    if (force && targetExisted) {
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      const targetDescriptor = openSync(target, constants.O_RDONLY | noFollow);
      try {
        const openedTarget = fstatSync(targetDescriptor); const namedTarget = lstatSync(target);
        if (!openedTarget.isFile() || namedTarget.isSymbolicLink()
          || openedTarget.dev !== namedTarget.dev || openedTarget.ino !== namedTarget.ino) {
          fail("INVALID_OUTPUT", "archive output identity changed before replacement");
        }
        verifyPrivatePathAccess(target, "file");
        operations.link(target, backup); backupCreated = true;
        const backupStat = lstatSync(backup);
        if (!backupStat.isFile() || backupStat.isSymbolicLink()
          || openedTarget.dev !== backupStat.dev || openedTarget.ino !== backupStat.ino) {
          fail("INVALID_OUTPUT", "archive backup identity changed before replacement");
        }
        verifyPrivatePathAccess(backup, "file"); operations.syncDirectory(directory);
      } finally { closeSync(targetDescriptor); }
    }
    if (force) { operations.rename(temporary, target); created = false; replacementVisible = true; }
    else {
      try { operations.link(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("OUTPUT_EXISTS", "archive output already exists; pass --force to replace it"); throw error; }
      linked = true; operations.unlink(temporary); created = false;
    }
    verifyPrivatePathAccess(target, "file"); operations.syncDirectory(directory); durablyPublished = true;
    if (backupCreated) {
      try {
        operations.unlink(backup);
      } catch {
        preserveBackup = true;
        fail("ARCHIVE_BACKUP_RETAINED", "archive was published but backup cleanup could not be proved; retry the same request ID", {
          requestId: exportRequestId, file: target, backupFile: backup,
          backupState: "retained", published: true, auditStatus: "started",
        });
      }
      backupCreated = false;
      try { operations.syncDirectory(directory); }
      catch {
        fail("ARCHIVE_BACKUP_CLEANUP_AMBIGUOUS", "archive was published but backup deletion durability is unknown; retry the same request ID", {
          requestId: exportRequestId, file: target, backupFile: backup,
          backupState: "unknown", published: true, auditStatus: "started",
        });
      }
    }
    try { await session.complete({ ...metadata, publishedAt: new Date().toISOString() }); }
    catch {
      let auditStatus: "abandoned" | "unknown" = "unknown";
      try { await session.abandon("audit_failed"); auditStatus = "abandoned"; } catch {}
      const details = { requestId: exportRequestId, file: target, published: true, auditStatus };
      if (auditStatus === "abandoned") fail("ARCHIVE_AUDIT_ABANDONED", "archive was published but its completion audit was abandoned", details);
      fail("ARCHIVE_AUDIT_AMBIGUOUS", "archive was published but its completion audit outcome is unknown", details);
    }
    return metadata;
  } catch (error) {
    if (!durablyPublished) {
      if (force && replacementVisible) {
        if (backupCreated) {
          try {
            operations.rename(backup, target); backupCreated = false; replacementVisible = false;
            verifyPrivatePathAccess(target, "file"); operations.syncDirectory(directory);
          } catch { preserveBackup = true; throw ambiguous("archive replacement failed and restoration could not be proved; use owner reconciliation"); }
        } else {
          try { operations.unlink(target); replacementVisible = false; operations.syncDirectory(directory); }
          catch { throw ambiguous("archive replacement failed and removal could not be proved; use owner reconciliation"); }
        }
      } else if (backupCreated) {
        try { operations.unlink(backup); backupCreated = false; operations.syncDirectory(directory); }
        catch { preserveBackup = true; throw ambiguous("archive backup cleanup could not be proved; use owner reconciliation"); }
      }
      if (linked && descriptor !== undefined) {
        try {
          const opened = fstatSync(descriptor); const named = lstatSync(target);
          if (opened.dev === named.dev && opened.ino === named.ino) {
            operations.unlink(target); linked = false; operations.syncDirectory(directory);
          }
        } catch { throw ambiguous("archive publication failed and output removal could not be proved; use owner reconciliation"); }
      }
      try { await session.abandon("publication_failed"); }
      catch {
        throw new ArchiveCommandError(
          "ARCHIVE_AUDIT_AMBIGUOUS",
          "archive publication did not complete but its audit outcome is unknown",
          { requestId: exportRequestId, file: target, published: false, auditStatus: "unknown" },
        );
      }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) { try { operations.unlink(temporary); } catch {} }
    if (backupCreated && !preserveBackup && !replacementVisible) { try { operations.unlink(backup); operations.syncDirectory(directory); } catch {} }
  }
}

const success = (operation: ArchiveOperation, value: Record<string, unknown>): Record<string, unknown> => ({ schemaVersion: 1, status: "ok", operation, ...value });

function recoveryArtifactPaths(target: string, requestId: string): string[] {
  const directory = dirname(target);
  return [
    join(directory, `.${requestId}.agent-bridge-archive.tmp`),
    join(directory, `.${requestId}.agent-bridge-archive.backup`),
  ];
}

function existingRecoveryArtifacts(target: string, requestId: string): string[] {
  return recoveryArtifactPaths(target, requestId).filter((path) => existsSync(path));
}

function openVerifiedPrivateFile(path: string): number {
  verifyPrivatePathAccess(path, "file");
  const before = lstatSync(path);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor); const after = lstatSync(path);
    if (!opened.isFile() || before.isSymbolicLink() || after.isSymbolicLink()
      || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.dev !== after.dev || opened.ino !== after.ino) {
      fail("INVALID_OUTPUT", "archive recovery path identity changed");
    }
    return descriptor;
  } catch (error) { closeSync(descriptor); throw error; }
}

function removeRecoveryArtifacts(target: string, requestId: string): void {
  for (const path of existingRecoveryArtifacts(target, requestId)) {
    const descriptor = openVerifiedPrivateFile(path);
    try {
      const opened = fstatSync(descriptor); const named = lstatSync(path);
      if (opened.dev !== named.dev || opened.ino !== named.ino) fail("INVALID_OUTPUT", "archive recovery path identity changed");
      unlinkSync(path);
    } finally { closeSync(descriptor); }
    syncDirectory(dirname(path));
  }
}

export function verifyCompletedExport(
  path: string,
  requestId: string,
  expected: PortableArchiveMetadata & { publishedAt: string },
): PortableArchiveMetadata {
  const target = resolve(path);
  const recoveryPaths = existingRecoveryArtifacts(target, requestId);
  if (!existsSync(target)) fail("ARCHIVE_REPLAY_FILE_MISSING", "completed export file is missing; use a new request ID", { requestId, file: target, recoveryPaths });
  let archive: PortableArchiveFile | undefined;
  try {
    try { archive = new PortableArchiveFile(target); }
    catch { fail("ARCHIVE_REPLAY_FILE_MISMATCH", "completed export file is not a valid private archive", { requestId, file: target, recoveryPaths }); }
    let actual: PortableArchiveMetadata;
    try { actual = archive.verify(); }
    catch { fail("ARCHIVE_REPLAY_FILE_MISMATCH", "completed export file is not a valid matching archive", { requestId, file: target, recoveryPaths }); }
    if (actual.exportRequestId !== requestId || expected.exportRequestId !== requestId
      || actual.workspace !== expected.workspace || actual.digest !== expected.digest
      || actual.messageCount !== expected.messageCount || actual.receiptCount !== expected.receiptCount) {
      fail("ARCHIVE_REPLAY_FILE_MISMATCH", "completed export file does not match the recorded audit; use a new request ID", { requestId, file: target, recoveryPaths });
    }
    try { archive.proveDurable(); }
    catch { fail("ARCHIVE_REPLAY_DURABILITY_AMBIGUOUS", "completed export file durability could not be reproved", { requestId, file: target, published: true, auditStatus: "completed", recoveryPaths }); }
    try { removeRecoveryArtifacts(target, requestId); }
    catch { fail("ARCHIVE_RECOVERY_ARTIFACT_RETAINED", "completed export recovery artifacts could not be removed", { requestId, file: target, published: true, auditStatus: "completed", recoveryPaths: existingRecoveryArtifacts(target, requestId) }); }
    try { archive.proveDurable(); }
    catch { fail("ARCHIVE_REPLAY_DURABILITY_AMBIGUOUS", "completed export file durability could not be reproved after cleanup", { requestId, file: target, published: true, auditStatus: "completed", recoveryPaths: existingRecoveryArtifacts(target, requestId) }); }
    return actual;
  } finally { archive?.close(); }
}

export async function reconcileActiveExport(
  path: string,
  requestId: string,
  workspace: string,
  session: PortableArchiveExportSession,
): Promise<PortableArchiveMetadata & { publishedAt: string }> {
  const target = resolve(path);
  const details = { requestId, file: target, recoveryPaths: existingRecoveryArtifacts(target, requestId), published: "unknown", auditStatus: "started" };
  if (!existsSync(target)) fail("ARCHIVE_RECONCILIATION_FILE_MISSING", "active export file is missing; use a new request ID or owner reconciliation", details);
  let archive: PortableArchiveFile | undefined;
  try {
    try { archive = new PortableArchiveFile(target); }
    catch { fail("ARCHIVE_RECONCILIATION_FILE_MISMATCH", "active export file is not a valid private archive", details); }
    let metadata: PortableArchiveMetadata;
    try { metadata = archive.verify(); }
    catch { fail("ARCHIVE_RECONCILIATION_FILE_MISMATCH", "active export file is not a valid matching archive", details); }
    if (metadata.exportRequestId !== requestId || metadata.workspace !== workspace) {
      fail("ARCHIVE_RECONCILIATION_FILE_MISMATCH", "active export file does not match the requested workspace; use a new request ID or owner reconciliation", details);
    }
    try { archive.proveDurable(); }
    catch { fail("ARCHIVE_RECONCILIATION_DURABILITY_AMBIGUOUS", "active export file durability could not be proved; retry the same request ID", details); }
    try { removeRecoveryArtifacts(target, requestId); }
    catch {
      fail("ARCHIVE_RECOVERY_ARTIFACT_RETAINED", "active export recovery artifacts could not be removed; retry the same request ID", {
        ...details, recoveryPaths: existingRecoveryArtifacts(target, requestId), published: true,
      });
    }
    try { archive.proveDurable(); }
    catch { fail("ARCHIVE_RECONCILIATION_DURABILITY_AMBIGUOUS", "active export durability after cleanup could not be proved; retry the same request ID", { ...details, published: true }); }
    const publishedAt = new Date().toISOString();
    try { await session.reconcile({ ...metadata, publishedAt }); }
    catch {
      fail("ARCHIVE_RECONCILIATION_AMBIGUOUS", "active export reconciliation outcome is unknown; retry the same request ID", { ...details, published: true, auditStatus: "unknown" });
    }
    return { ...metadata, publishedAt };
  } finally { archive?.close(); }
}

export async function runArchiveCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const { operation, options } = parseArchiveArgs(argv);
  try {
    if (operation === "verify") {
      const path = required(options, "file"); let archive: PortableArchiveFile | undefined;
      try { archive = new PortableArchiveFile(path); const metadata = archive.verify(); return success(operation, { file: resolve(path), exportRequestId: metadata.exportRequestId, workspace: metadata.workspace, digest: metadata.digest, messages: metadata.messageCount, receipts: metadata.receiptCount }); }
      finally { archive?.close(); }
    }
    const selected = provider(options);
    if (operation === "export") {
      const workspace = required(options, "workspace"); const path = required(options, "output");
      const requestId = archiveRequestId(options);
      const connection = createStore(selected, options, env); let session: PortableArchiveExportSession | undefined;
      try {
        const start = await connection.store.beginExport(requestId, workspace);
        if (start.status === "completed") {
          const metadata = verifyCompletedExport(path, requestId, start.metadata);
          return success(operation, { provider: selected, requestId, replayed: true, reconciled: false, file: resolve(path), workspace, digest: metadata.digest, messages: metadata.messageCount, receipts: metadata.receiptCount, publishedAt: start.metadata.publishedAt });
        }
        session = start.session;
        if (start.replayed) {
          const metadata = await reconcileActiveExport(path, requestId, workspace, session);
          return success(operation, { provider: selected, requestId, replayed: true, reconciled: true, file: resolve(path), workspace, digest: metadata.digest, messages: metadata.messageCount, receipts: metadata.receiptCount, publishedAt: metadata.publishedAt });
        }
        const metadata = await publishArchive(path, options.force === true, session, workspace, { requestId });
        return success(operation, { provider: selected, requestId, replayed: false, reconciled: false, file: resolve(path), workspace, digest: metadata.digest, messages: metadata.messageCount, receipts: metadata.receiptCount });
      } finally { await session?.close(); await connection.close(); }
    }
    const path = required(options, "file"); const archive = new PortableArchiveFile(path);
    try {
      const metadata = archive.verify(); const assertedWorkspace = stringOption(options, "workspace")?.trim();
      if (assertedWorkspace && assertedWorkspace !== metadata.workspace) fail("WORKSPACE_MISMATCH", "--workspace does not match the archive workspace");
      const requestId = archiveRequestId(options);
      const connection = createStore(selected, options, env);
      try {
        const result = await connection.store.importWorkspace(requestId, metadata, archive, { apply: options.apply === true });
        return success(operation, { provider: selected, file: resolve(path), exportRequestId: metadata.exportRequestId, ...result });
      } finally { await connection.close(); }
    } finally { archive.close(); }
  } catch (error) {
    if (error instanceof ArchiveCommandError) throw error;
    if (error instanceof PrivatePathError) fail("INSECURE_PATH", "archive file or directory does not satisfy the private path policy");
    if (error instanceof PortableArchiveError) fail("INVALID_ARCHIVE", error.message);
    fail("ARCHIVE_OPERATION_FAILED", "archive operation failed");
  }
}
