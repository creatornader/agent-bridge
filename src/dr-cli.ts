import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, rmSync, unlinkSync,
  type Stats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  NativeDrBundleError, NativeDrBundleReader, writeNativeDrBundle, type NativeDrBundleInput, type NativeDrBundleMetadata,
} from "./native-dr-bundle.js";
import {
  backupPostgresNativeDr, PostgresNativeDrError, restorePostgresNativeDr, verifyPostgresNativeDrArtifacts,
  type PostgresNativeDrArtifactAnchor, type PostgresNativeDrArtifactAnchors,
  type PostgresNativeDrBundleInput, type PostgresNativeDrSchema, type RestorePostgresNativeDrResult,
} from "./postgres-native-dr.js";
import {
  preparePrivateFileLocation, PrivatePathError, securePrivatePath, verifyPrivatePathAccess,
} from "./private-path.js";
import {
  backupLocalSqlite, NativeDrCommandError, restoreLocalSqlite, validateNativeDrId, validateNativeDrTimeout,
  verifyNativeDrBundle,
} from "./sqlite-native-dr.js";

type DrOperation = "backup" | "verify" | "restore";
type DrProvider = "local" | "postgres";
type DrOptions = Record<string, string | true>;

const POSTGRES_DUMP_ENTRY = "postgres/database.dump";
const POSTGRES_ROLES_ENTRY = "postgres/roles.json";
const OPTIONS: Record<DrOperation, ReadonlySet<string>> = {
  backup: new Set(["provider", "source", "output", "backup-id", "timeout-ms", "tool-directory"]),
  verify: new Set(["provider", "bundle", "tool-directory"]),
  restore: new Set(["provider", "bundle", "target", "request-id", "timeout-ms", "tool-directory", "accept-source-sql-risk"]),
};
const FLAGS: Record<DrOperation, ReadonlySet<string>> = {
  backup: new Set(), verify: new Set(), restore: new Set(["accept-source-sql-risk"]),
};

interface DrFileOperations {
  link(source: string, target: string): void;
  syncDirectory(path: string): boolean;
  syncFile(path: string): void;
  afterPublish?(target: string): void;
}

export interface DrCommandDependencies {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  backupPostgres?: typeof backupPostgresNativeDr;
  verifyPostgres?: typeof verifyPostgresNativeDrArtifacts;
  restorePostgres?: typeof restorePostgresNativeDr;
  fileOperations?: Partial<DrFileOperations>;
}

const fail = (code: string, message: string, details?: Record<string, unknown>): never => {
  throw new NativeDrCommandError(code, message, details);
};

function parse(argv: string[]): { operation: DrOperation; options: DrOptions } {
  const operation = argv[0];
  if (operation !== "backup" && operation !== "verify" && operation !== "restore") {
    fail("INVALID_COMMAND", "usage: agent-bridge dr <backup|verify|restore>");
  }
  const selectedOperation = operation as DrOperation;
  const options: DrOptions = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--") || argument === "--") {
      fail("INVALID_ARGUMENT", "DR commands do not accept positional arguments");
    }
    const name = argument.slice(2);
    if (!name || name.includes("=") || !OPTIONS[selectedOperation].has(name)) {
      fail("INVALID_OPTION", `--${name} is not valid for dr ${selectedOperation}`);
    }
    if (options[name] !== undefined) fail("DUPLICATE_OPTION", `--${name} may only be provided once`);
    if (FLAGS[selectedOperation].has(name)) { options[name] = true; continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("MISSING_OPTION_VALUE", `--${name} requires a value`);
    options[name] = value; index += 1;
  }
  return { operation: selectedOperation, options };
}

function optional(options: DrOptions, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function required(options: DrOptions, name: string): string {
  const value = optional(options, name);
  if (!value) fail("MISSING_OPTION", `--${name} is required`);
  return value!;
}

function timeout(options: DrOptions): number | undefined {
  const value = optional(options, "timeout-ms");
  return value === undefined ? undefined : validateNativeDrTimeout(Number(value));
}

function provider(options: DrOptions): DrProvider {
  const selected = required(options, "provider");
  if (selected !== "local" && selected !== "postgres") fail("INVALID_PROVIDER", "--provider must be local or postgres");
  return selected as DrProvider;
}

function rejectProviderOption(options: DrOptions, name: string, selected: DrProvider, operation: DrOperation): void {
  if (options[name] !== undefined) fail("INVALID_OPTION", `--${name} is not valid for ${selected} DR ${operation}`);
}

function syncFile(path: string): void {
  const before = lstatSync(path); const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDWR | noFollow);
  try {
    const opened = fstatSync(descriptor); const named = lstatSync(path);
    if (!opened.isFile() || before.isSymbolicLink() || named.isSymbolicLink()
      || !sameNode(before, opened) || !sameNode(opened, named)) {
      fail("INSECURE_PATH", "DR publication path identity changed before file synchronization");
    }
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

function syncDirectory(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return false;
  const descriptor = openSync(path, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  return true;
}

function fileOperations(dependencies: DrCommandDependencies): DrFileOperations {
  return {
    link: dependencies.fileOperations?.link ?? linkSync,
    syncDirectory: dependencies.fileOperations?.syncDirectory
      ?? ((path) => syncDirectory(path, dependencies.platform ?? process.platform)),
    syncFile: dependencies.fileOperations?.syncFile ?? syncFile,
    afterPublish: dependencies.fileOperations?.afterPublish,
  };
}

function sameNode(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }

function createPrivateDirectory(path: string): Stats {
  mkdirSync(path, { mode: 0o700 });
  const before = lstatSync(path);
  securePrivatePath(path, "directory"); verifyPrivatePathAccess(path, "directory");
  const after = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink() || !sameNode(before, after)) {
    fail("INSECURE_PATH", "DR staging directory identity changed while securing it");
  }
  return after;
}

function openPrivateFile(path: string): { descriptor: number; identity: Stats } {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    const before = fstatSync(descriptor);
    securePrivatePath(path, "file"); verifyPrivatePathAccess(path, "file");
    const after = lstatSync(path);
    if (!before.isFile() || after.isSymbolicLink() || !sameNode(before, after)) {
      fail("INSECURE_PATH", "DR staging file identity changed while securing it");
    }
    return { descriptor, identity: after };
  } catch (error) { closeSync(descriptor); throw error; }
}

function artifactAnchor(descriptor: number, sha256: string): PostgresNativeDrArtifactAnchor {
  const stat = fstatSync(descriptor, { bigint: true });
  if (!stat.isFile()) fail("ARTIFACT_ANCHOR_INVALID", "PostgreSQL DR artifact anchor is not a regular file");
  return {
    descriptor,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    ctimeNanoseconds: stat.ctimeNs.toString(),
    mtimeNanoseconds: stat.mtimeNs.toString(),
    sha256,
  };
}

interface ExtractedPostgresBundle {
  metadata: NativeDrBundleMetadata;
  dumpPath: string;
  rolesPath: string;
  artifactAnchors: PostgresNativeDrArtifactAnchors;
  descriptors: Map<string, { descriptor: number; identity: Stats; path: string }>;
}

function extractPostgresBundle(bundle: string, stage: string): ExtractedPostgresBundle {
  const descriptors = new Map<string, { descriptor: number; identity: Stats; path: string }>();
  try {
    for (const [name, filename] of [
      [POSTGRES_DUMP_ENTRY, "postgres-database.dump"],
      [POSTGRES_ROLES_ENTRY, "postgres-roles.json"],
    ] as const) {
      const path = join(stage, filename);
      descriptors.set(name, { ...openPrivateFile(path), path });
    }
    const reader = new NativeDrBundleReader(bundle);
    let metadata: NativeDrBundleMetadata;
    try { metadata = reader.inspect((entry) => descriptors.get(entry.name)?.descriptor); }
    finally { reader.close(); }
    if (metadata.manifest.kind !== "postgres") {
      fail("PROVIDER_MISMATCH", `DR bundle provider is ${metadata.manifest.kind}, not postgres`);
    }
    for (const value of descriptors.values()) {
      const opened = fstatSync(value.descriptor); const named = lstatSync(value.path);
      if (!opened.isFile() || named.isSymbolicLink() || !sameNode(opened, named)) {
        fail("INSECURE_PATH", "DR extraction path identity changed while reading the bundle");
      }
      fsyncSync(value.descriptor);
      securePrivatePath(value.path, "file"); verifyPrivatePathAccess(value.path, "file");
    }
    const dump = descriptors.get(POSTGRES_DUMP_ENTRY)!;
    const roles = descriptors.get(POSTGRES_ROLES_ENTRY)!;
    const dumpEntry = metadata.manifest.entries.find((entry) => entry.name === POSTGRES_DUMP_ENTRY)!;
    const rolesEntry = metadata.manifest.entries.find((entry) => entry.name === POSTGRES_ROLES_ENTRY)!;
    return {
      metadata,
      dumpPath: dump.path,
      rolesPath: roles.path,
      artifactAnchors: {
        dump: artifactAnchor(dump.descriptor, dumpEntry.sha256),
        roles: artifactAnchor(roles.descriptor, rolesEntry.sha256),
      },
      descriptors,
    };
  } catch (error) {
    for (const value of descriptors.values()) {
      try { closeSync(value.descriptor); } catch { /* cleanup reports the primary failure */ }
    }
    throw error;
  }
}

function closeExtractedPostgresBundle(extracted: ExtractedPostgresBundle): void {
  for (const value of extracted.descriptors.values()) {
    try { closeSync(value.descriptor); } catch { /* cleanup handles any retained stage */ }
  }
  extracted.descriptors.clear();
}

function removeOwnedFile(path: string, identity: Stats | undefined): boolean {
  if (!existsSync(path)) return true;
  try {
    const current = lstatSync(path);
    if (!identity || !current.isFile() || current.isSymbolicLink() || !sameNode(current, identity)) return false;
    unlinkSync(path); return !existsSync(path);
  } catch { return false; }
}

function removeOwnedDirectory(path: string, identity: Stats | undefined): boolean {
  if (!existsSync(path)) return true;
  try {
    const current = lstatSync(path);
    if (!identity || !current.isDirectory() || current.isSymbolicLink() || !sameNode(current, identity)) return false;
    // Owner-private paths exclude other OS principals. Node has no portable
    // handle-relative recursive delete, so a hostile same-account process is
    // outside this cleanup-only race boundary. Execution inputs remain FD-bound.
    rmSync(path, { recursive: true }); return !existsSync(path);
  } catch { return false; }
}

function recoveryPaths(paths: readonly string[]): string[] { return paths.filter(existsSync); }

function verifyProviderBundle(path: string, expected: DrProvider): NativeDrBundleMetadata {
  const expectedKind = expected === "local" ? "sqlite" : "postgres";
  const reader = new NativeDrBundleReader(path);
  try {
    const metadata = reader.inspect();
    if (metadata.manifest.kind !== expectedKind) {
      fail("PROVIDER_MISMATCH", `DR bundle provider is ${metadata.manifest.kind}, not ${expected}`);
    }
    return expected === "local" ? verifyNativeDrBundle(path) : metadata;
  } finally { reader.close(); }
}

function commandErrorWithRecovery(
  error: unknown,
  identity: { backupId?: string; requestId?: string },
  paths: readonly string[],
): NativeDrCommandError {
  const details = error instanceof NativeDrCommandError || error instanceof PostgresNativeDrError
    ? { ...error.details } as Record<string, unknown>
    : {};
  const nested = Array.isArray(details.recoveryPaths)
    ? details.recoveryPaths.filter((path): path is string => typeof path === "string")
    : [];
  delete details.recoveryPaths;
  const retained = recoveryPaths([...new Set([...nested, ...paths])]);
  if (error instanceof NativeDrCommandError) {
    return new NativeDrCommandError(error.code, error.message, {
      ...details, ...identity, ...(retained.length ? { recoveryPaths: retained } : {}),
    });
  }
  if (error instanceof PostgresNativeDrError) {
    return new NativeDrCommandError(error.code, error.message, {
      ...details, ...identity, ...(retained.length ? { recoveryPaths: retained } : {}),
    });
  }
  if (error instanceof PrivatePathError) {
    return new NativeDrCommandError("INSECURE_PATH", "DR path does not satisfy the private path policy", {
      ...identity, ...(retained.length ? { recoveryPaths: retained } : {}),
    });
  }
  if (error instanceof NativeDrBundleError) {
    return new NativeDrCommandError("INVALID_DR_BUNDLE", "DR bundle verification failed", {
      ...identity, ...(retained.length ? { recoveryPaths: retained } : {}),
    });
  }
  return new NativeDrCommandError("DR_COMMAND_FAILED", "DR command failed", {
    ...identity, ...(retained.length ? { recoveryPaths: retained } : {}),
  });
}

async function backupPostgresBundle(
  outputPath: string,
  backupId: string,
  toolDirectory: string | undefined,
  dependencies: DrCommandDependencies,
): Promise<{ metadata: NativeDrBundleMetadata; directoryDurability: "confirmed" | "unavailable" }> {
  const target = resolve(outputPath); preparePrivateFileLocation(target);
  const directory = dirname(target);
  const stage = join(directory, `.${backupId}.agent-bridge-dr.postgres.stage`);
  const bundleStage = join(directory, `.${backupId}.agent-bridge-dr.bundle.tmp`);
  const priorRecovery = recoveryPaths([bundleStage, stage]);
  if (priorRecovery.length) fail("DR_RECOVERY_REQUIRED", "a prior PostgreSQL DR backup with this ID requires recovery", {
    backupId, output: target, outputExists: existsSync(target), published: existsSync(target) ? "unknown" : false,
    recoveryPaths: priorRecovery,
  });
  if (existsSync(target)) fail("OUTPUT_EXISTS", "DR output already exists");
  let stageIdentity: Stats | undefined; let bundleIdentity: Stats | undefined; let descriptor: number | undefined;
  let published = false; let durable = false;
  let directoryDurability: "confirmed" | "unavailable" = "confirmed";
  const operations = fileOperations(dependencies);
  const platform = dependencies.platform ?? process.platform;
  try {
    stageIdentity = createPrivateDirectory(stage);
    operations.syncDirectory(directory);
    const input = await (dependencies.backupPostgres ?? backupPostgresNativeDr)({
      stagingDirectory: stage,
      backupId,
      environment: dependencies.environment ?? process.env,
      ...(toolDirectory ? { toolDirectory } : {}),
    });
    if (input.backupId !== backupId || input.kind !== "postgres" || input.entries.length !== 2
      || input.entries[0]?.name !== POSTGRES_DUMP_ENTRY || resolve(input.entries[0].path) !== join(stage, "postgres-database.dump")
      || input.entries[1]?.name !== POSTGRES_ROLES_ENTRY || resolve(input.entries[1].path) !== join(stage, "postgres-roles.json")) {
      fail("POSTGRES_STAGE_INVALID", "PostgreSQL DR adapter returned an unexpected staging contract");
    }
    operations.syncDirectory(stage);
    const opened = openPrivateFile(bundleStage); descriptor = opened.descriptor; bundleIdentity = opened.identity;
    writeNativeDrBundle(descriptor, input as unknown as NativeDrBundleInput, bundleStage);
    closeSync(descriptor); descriptor = undefined;
    const verificationStage = join(stage, "bundle-verification");
    createPrivateDirectory(verificationStage);
    const extracted = extractPostgresBundle(bundleStage, verificationStage);
    try {
      await (dependencies.verifyPostgres ?? verifyPostgresNativeDrArtifacts)({
        dumpPath: extracted.dumpPath,
        rolesPath: extracted.rolesPath,
        schema: extracted.metadata.manifest.schema as unknown as PostgresNativeDrSchema,
        artifactAnchors: extracted.artifactAnchors,
        ...(toolDirectory ? { toolDirectory } : {}),
      });
    } finally { closeExtractedPostgresBundle(extracted); }
    const beforePublication = extracted.metadata;
    try { operations.link(bundleStage, target); published = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("OUTPUT_EXISTS", "DR output already exists");
      throw error;
    }
    const publishedIdentity = lstatSync(target);
    if (!bundleIdentity || !publishedIdentity.isFile() || publishedIdentity.isSymbolicLink()
      || !sameNode(bundleIdentity, publishedIdentity)) {
      fail("DR_PUBLICATION_INVALID", "published DR output does not reference the verified staging file", {
        backupId, output: target, published: true, durable: false, verified: false,
        recoveryPaths: recoveryPaths([bundleStage, stage]),
      });
    }
    try {
      operations.syncFile(target); operations.afterPublish?.(target);
      if (!operations.syncDirectory(directory)) {
        if (platform === "win32") directoryDurability = "unavailable";
        else {
        fail("DR_PUBLICATION_AMBIGUOUS", "DR output is visible but directory durability is unproved", {
          backupId, output: target, published: true, durable: "unknown", platform,
          recoveryPaths: recoveryPaths([bundleStage, stage]),
        });
        }
      }
      durable = true;
    } catch {
      fail("DR_PUBLICATION_AMBIGUOUS", "DR output is visible but durability is unknown", {
        backupId, output: target, published: true, durable: "unknown", recoveryPaths: recoveryPaths([bundleStage, stage]),
      });
    }
    let publishedMetadata: NativeDrBundleMetadata | undefined;
    try { publishedMetadata = verifyProviderBundle(target, "postgres"); }
    catch {
      fail("DR_PUBLICATION_INVALID", "published DR output could not be verified", {
        backupId, output: target, published: true, durable: true, verified: false,
        recoveryPaths: recoveryPaths([bundleStage, stage]),
      });
    }
    if (!publishedMetadata) throw new NativeDrCommandError("DR_PUBLICATION_INVALID", "published DR output could not be verified");
    if (publishedMetadata.bundleSha256 !== beforePublication.bundleSha256) {
      fail("DR_PUBLICATION_INVALID", "published DR output does not match its verified staging bundle", {
        backupId, output: target, published: true, durable: true, verified: false,
        recoveryPaths: recoveryPaths([bundleStage, stage]),
      });
    }
    const bundleRemoved = removeOwnedFile(bundleStage, bundleIdentity);
    const stageRemoved = removeOwnedDirectory(stage, stageIdentity);
    if (!bundleRemoved || !stageRemoved) {
      fail("DR_RECOVERY_ARTIFACT_RETAINED", "DR output is valid but a recovery artifact remains", {
        backupId, output: target, published: true, durable: true, verified: true,
        recoveryPaths: recoveryPaths([bundleStage, stage]),
      });
    }
    try {
      if (!operations.syncDirectory(directory) && platform !== "win32") {
        fail("DR_CLEANUP_DURABILITY_UNKNOWN", "DR output is valid but staging cleanup durability is unproved", {
          backupId, output: target, published: true, durable: true, verified: true,
          cleanupDurability: "unproved", platform,
        });
      }
    }
    catch (error) {
      if (error instanceof NativeDrCommandError) throw error;
      fail("DR_CLEANUP_DURABILITY_UNKNOWN", "DR output is valid but staging cleanup durability is unknown", {
        backupId, output: target, published: true, durable: true, verified: true,
      });
    }
    return { metadata: publishedMetadata, directoryDurability };
  } catch (error) {
    if (descriptor !== undefined) { closeSync(descriptor); descriptor = undefined; }
    if (!published) {
      removeOwnedFile(bundleStage, bundleIdentity); removeOwnedDirectory(stage, stageIdentity);
      try {
        if (!operations.syncDirectory(directory)) {
          if (platform === "win32") {
            const primary = commandErrorWithRecovery(error, { backupId }, [bundleStage, stage]);
            throw new NativeDrCommandError(primary.code, primary.message, {
              ...primary.details, cleanupDirectoryDurability: "unavailable", platform,
            });
          }
          throw new NativeDrCommandError("DR_CLEANUP_DURABILITY_UNKNOWN", "DR backup failure cleanup durability is unproved", {
            backupId, cleanupDurability: "unproved", platform,
            recoveryPaths: recoveryPaths([bundleStage, stage]),
          });
        }
      } catch (cleanupError) {
        if (cleanupError instanceof NativeDrCommandError) throw cleanupError;
        throw new NativeDrCommandError("DR_CLEANUP_DURABILITY_UNKNOWN", "DR backup failure cleanup durability is unknown", {
          backupId, cleanupDurability: "unknown", platform,
          recoveryPaths: recoveryPaths([bundleStage, stage]),
        });
      }
      throw commandErrorWithRecovery(error, { backupId }, [bundleStage, stage]);
    }
    if (error instanceof NativeDrCommandError) throw error;
    throw new NativeDrCommandError("DR_PUBLICATION_AMBIGUOUS", "DR publication outcome is incomplete", {
      backupId, output: target, published: true, durable: durable || "unknown",
      recoveryPaths: recoveryPaths([bundleStage, stage]),
    });
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

async function restorePostgresBundle(
  bundlePath: string,
  requestId: string,
  toolDirectory: string | undefined,
  dependencies: DrCommandDependencies,
): Promise<{
  metadata: NativeDrBundleMetadata;
  result: RestorePostgresNativeDrResult;
  cleanupDirectoryDurability: "confirmed" | "unavailable";
}> {
  const bundle = resolve(bundlePath); const directory = dirname(bundle);
  const stage = join(directory, `.${requestId}.agent-bridge-dr.postgres-restore.stage`);
  if (existsSync(stage)) fail("DR_RECOVERY_REQUIRED", "a prior PostgreSQL DR restore with this ID requires recovery", {
    requestId, bundle, recoveryPaths: [stage],
  });
  let stageIdentity: Stats | undefined;
  let targetRestored = false;
  const platform = dependencies.platform ?? process.platform;
  const operations = fileOperations(dependencies);
  let extracted: ExtractedPostgresBundle | undefined;
  try {
    stageIdentity = createPrivateDirectory(stage);
    operations.syncDirectory(directory);
    extracted = extractPostgresBundle(bundle, stage);
    operations.syncDirectory(stage);
    const result = await (dependencies.restorePostgres ?? restorePostgresNativeDr)({
      dumpPath: extracted.dumpPath,
      rolesPath: extracted.rolesPath,
      schema: extracted.metadata.manifest.schema as unknown as PostgresNativeDrSchema,
      artifactAnchors: extracted.artifactAnchors,
      acceptSourceSqlRisk: true,
      environment: dependencies.environment ?? process.env,
      ...(toolDirectory ? { toolDirectory } : {}),
    });
    targetRestored = true;
    const metadata = extracted.metadata;
    closeExtractedPostgresBundle(extracted); extracted = undefined;
    if (!removeOwnedDirectory(stage, stageIdentity)) {
      fail("DR_RECOVERY_ARTIFACT_RETAINED", "PostgreSQL restore completed but a recovery artifact remains", {
        requestId, recoveryPaths: recoveryPaths([stage]),
      });
    }
    try {
      if (!operations.syncDirectory(directory) && platform !== "win32") {
        fail("DR_CLEANUP_DURABILITY_UNKNOWN", "PostgreSQL restore completed but cleanup durability is unproved", {
          requestId, targetRestored: true, cleanupDurability: "unproved", platform,
        });
      }
    }
    catch (error) {
      if (error instanceof NativeDrCommandError) throw error;
      fail("DR_CLEANUP_DURABILITY_UNKNOWN", "PostgreSQL restore completed but cleanup durability is unknown", {
        requestId, targetRestored: true, cleanupDurability: "unknown", platform,
      });
    }
    return { metadata, result, cleanupDirectoryDurability: platform === "win32" ? "unavailable" : "confirmed" };
  } catch (error) {
    if (extracted) { closeExtractedPostgresBundle(extracted); extracted = undefined; }
    const targetMutated = error instanceof PostgresNativeDrError
      && (error.details.targetMutated === true || error.details.restoreCompleted === true);
    if (targetRestored || targetMutated) throw commandErrorWithRecovery(error, { requestId }, [stage]);
    removeOwnedDirectory(stage, stageIdentity);
    try {
      if (!operations.syncDirectory(directory)) {
        if (platform === "win32") {
          const primary = commandErrorWithRecovery(error, { requestId }, [stage]);
          throw new NativeDrCommandError(primary.code, primary.message, {
            ...primary.details, cleanupDirectoryDurability: "unavailable", platform,
          });
        }
        throw new NativeDrCommandError("DR_CLEANUP_DURABILITY_UNKNOWN", "PostgreSQL restore failure cleanup durability is unproved", {
          requestId, cleanupDurability: "unproved", platform,
          recoveryPaths: recoveryPaths([stage]),
        });
      }
    } catch (cleanupError) {
      if (cleanupError instanceof NativeDrCommandError) throw cleanupError;
      throw new NativeDrCommandError("DR_CLEANUP_DURABILITY_UNKNOWN", "PostgreSQL restore failure cleanup durability is unknown", {
        requestId, cleanupDurability: "unknown", platform,
        recoveryPaths: recoveryPaths([stage]),
      });
    }
    throw commandErrorWithRecovery(error, { requestId }, [stage]);
  }
}

async function verifyPostgresBundle(
  bundlePath: string,
  toolDirectory: string | undefined,
  dependencies: DrCommandDependencies,
): Promise<{ metadata: NativeDrBundleMetadata; cleanupDirectoryDurability: "confirmed" | "unavailable" }> {
  const bundle = resolve(bundlePath); const directory = dirname(bundle);
  const bundlePathId = createHash("sha256").update(bundle).digest("hex").slice(0, 32);
  const stage = join(directory, `.${bundlePathId}.agent-bridge-dr.postgres-verify.stage`);
  if (existsSync(stage)) fail("DR_RECOVERY_REQUIRED", "a prior PostgreSQL DR verification requires recovery", {
    bundle, recoveryPaths: [stage],
  });
  const platform = dependencies.platform ?? process.platform;
  const operations = fileOperations(dependencies);
  let stageIdentity: Stats | undefined; let extracted: ExtractedPostgresBundle | undefined;
  let verificationCompleted = false;
  try {
    stageIdentity = createPrivateDirectory(stage);
    extracted = extractPostgresBundle(bundle, stage);
    await (dependencies.verifyPostgres ?? verifyPostgresNativeDrArtifacts)({
      dumpPath: extracted.dumpPath,
      rolesPath: extracted.rolesPath,
      schema: extracted.metadata.manifest.schema as unknown as PostgresNativeDrSchema,
      artifactAnchors: extracted.artifactAnchors,
      ...(toolDirectory ? { toolDirectory } : {}),
    });
    verificationCompleted = true;
    const metadata = extracted.metadata;
    closeExtractedPostgresBundle(extracted); extracted = undefined;
    if (!removeOwnedDirectory(stage, stageIdentity)) {
      fail("DR_RECOVERY_ARTIFACT_RETAINED", "PostgreSQL verification completed but a recovery artifact remains", {
        backupId: metadata.manifest.backupId, recoveryPaths: recoveryPaths([stage]),
      });
    }
    const durable = operations.syncDirectory(directory);
    if (!durable && platform !== "win32") {
      fail("DR_CLEANUP_DURABILITY_UNKNOWN", "PostgreSQL verification cleanup durability is unproved", {
        backupId: metadata.manifest.backupId, cleanupDurability: "unproved", platform,
      });
    }
    return { metadata, cleanupDirectoryDurability: durable ? "confirmed" : "unavailable" };
  } catch (error) {
    if (extracted) closeExtractedPostgresBundle(extracted);
    if (verificationCompleted) throw commandErrorWithRecovery(error, {}, [stage]);
    removeOwnedDirectory(stage, stageIdentity);
    try { operations.syncDirectory(directory); } catch { /* primary error remains authoritative */ }
    throw commandErrorWithRecovery(error, {}, [stage]);
  }
}

const success = (operation: DrOperation, fields: Record<string, unknown>): Record<string, unknown> => ({
  schemaVersion: 1, status: "ok", operation, ...fields,
});

export async function runDrCommand(argv: string[], dependencies: DrCommandDependencies = {}): Promise<Record<string, unknown>> {
  const { operation, options } = parse(argv);
  try {
    const selected = provider(options);
    if (selected === "local") {
      rejectProviderOption(options, "tool-directory", selected, operation);
      rejectProviderOption(options, "accept-source-sql-risk", selected, operation);
      if (operation === "backup") {
        const source = required(options, "source"); const output = required(options, "output");
        const backupId = optional(options, "backup-id") ? validateNativeDrId(required(options, "backup-id")) : randomUUID();
        const metadata = await backupLocalSqlite(source, output, backupId, { timeoutMs: timeout(options) });
        return success(operation, {
          provider: selected, backupId: metadata.manifest.backupId, createdAt: metadata.manifest.createdAt,
          output: resolve(output), bundleBytes: metadata.bundleBytes, bundleSha256: metadata.bundleSha256,
        });
      }
      const bundle = required(options, "bundle");
      if (operation === "verify") {
        const metadata = verifyProviderBundle(bundle, selected);
        return success(operation, {
          provider: selected, backupId: metadata.manifest.backupId, createdAt: metadata.manifest.createdAt,
          bundle: resolve(bundle), bundleBytes: metadata.bundleBytes, bundleSha256: metadata.bundleSha256,
        });
      }
      const target = required(options, "target");
      const requestId = optional(options, "request-id") ? validateNativeDrId(required(options, "request-id")) : randomUUID();
      const metadata = await restoreLocalSqlite(bundle, target, requestId, { timeoutMs: timeout(options) });
      return success(operation, {
        provider: selected, requestId: metadata.requestId, backupId: metadata.manifest.backupId,
        target: resolve(target), bundleSha256: metadata.bundleSha256,
      });
    }

    rejectProviderOption(options, "source", selected, operation);
    rejectProviderOption(options, "target", selected, operation);
    rejectProviderOption(options, "timeout-ms", selected, operation);
    const toolDirectory = optional(options, "tool-directory");
    if (operation === "backup") {
      const output = required(options, "output");
      const backupId = validateNativeDrId(required(options, "backup-id"));
      const { metadata, directoryDurability } = await backupPostgresBundle(output, backupId, toolDirectory, dependencies);
      return success(operation, {
        provider: selected, backupId: metadata.manifest.backupId, createdAt: metadata.manifest.createdAt,
        output: resolve(output), bundleBytes: metadata.bundleBytes, bundleSha256: metadata.bundleSha256,
        directoryDurability, ...(directoryDurability === "unavailable" ? { platform: "win32" } : {}),
      });
    }
    const bundle = required(options, "bundle");
    if (operation === "verify") {
      const { metadata, cleanupDirectoryDurability } = await verifyPostgresBundle(bundle, toolDirectory, dependencies);
      return success(operation, {
        provider: selected, backupId: metadata.manifest.backupId, createdAt: metadata.manifest.createdAt,
        bundle: resolve(bundle), bundleBytes: metadata.bundleBytes, bundleSha256: metadata.bundleSha256,
        cleanupDirectoryDurability,
        ...(cleanupDirectoryDurability === "unavailable" ? { platform: "win32" } : {}),
      });
    }
    if (options["accept-source-sql-risk"] !== true) {
      fail("SOURCE_SQL_RISK_NOT_ACCEPTED", "PostgreSQL native restore requires --accept-source-sql-risk");
    }
    const requestId = validateNativeDrId(required(options, "request-id"));
    const { metadata, result, cleanupDirectoryDurability } = await restorePostgresBundle(bundle, requestId, toolDirectory, dependencies);
    return success(operation, {
      provider: selected, requestId, backupId: metadata.manifest.backupId, bundleSha256: metadata.bundleSha256,
      databaseName: result.databaseName, normalizedClaimedDeliveries: result.normalizedClaimedDeliveries,
      tableCounts: result.tableCounts, readiness: result.readiness, cleanupDirectoryDurability,
      ...(cleanupDirectoryDurability === "unavailable" ? { platform: "win32" } : {}),
    });
  } catch (error) {
    if (error instanceof NativeDrCommandError) throw error;
    if (error instanceof PostgresNativeDrError) throw new NativeDrCommandError(error.code, error.message, error.details);
    if (error instanceof PrivatePathError) fail("INSECURE_PATH", "DR path does not satisfy the private path policy");
    if (error instanceof NativeDrBundleError) fail("INVALID_DR_BUNDLE", "DR bundle verification failed");
    fail("DR_COMMAND_FAILED", "DR command failed");
  }
  throw new NativeDrCommandError("DR_COMMAND_FAILED", "DR command failed");
}
