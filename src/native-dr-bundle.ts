import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, type Stats, writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { verifyPrivatePathAccess } from "./private-path.js";

const MAGIC = Buffer.from("AGENT-BRIDGE-DR!", "ascii");
const HEADER_BYTES = MAGIC.length + 2 + 4;
const FRAME_BYTES = 2 + 8 + 32;
const CHUNK_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
export const NATIVE_DR_MAX_BUNDLE_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 16;

export const NATIVE_DR_FORMAT = "agent-bridge-native-dr";
export const NATIVE_DR_VERSION = 1;

export interface NativeDrManifest {
  backupId: string;
  createdAt: string;
  entries: Array<{ length: number; name: string; sha256: string }>;
  format: typeof NATIVE_DR_FORMAT;
  kind: "sqlite" | "postgres";
  schema: Record<string, unknown>;
  version: typeof NATIVE_DR_VERSION;
}

export interface NativeDrBundleMetadata {
  manifest: NativeDrManifest;
  bundleSha256: string;
  bundleBytes: number;
}

export class NativeDrBundleError extends Error {}

export interface NativeDrInputEntry { name: string; path: string }
export interface NativeDrBundleInput {
  backupId: string;
  createdAt: string;
  entries: readonly NativeDrInputEntry[];
  kind: "sqlite" | "postgres";
  schema: Record<string, unknown>;
}
export interface NativeDrBundleWriteHooks { afterHash?(): void }

function assertString(value: string, label: string): void {
  if (value.includes("\0")) throw new NativeDrBundleError(`${label} contains U+0000`);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new NativeDrBundleError(`${label} contains an unpaired surrogate`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new NativeDrBundleError(`${label} contains an unpaired surrogate`);
  }
}

function canonical(value: unknown): string {
  if (typeof value === "string") { assertString(value, "DR manifest string"); return JSON.stringify(value); }
  if (typeof value === "number" && !Number.isFinite(value)) throw new NativeDrBundleError("DR manifest contains a non-finite number");
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new NativeDrBundleError("DR manifest contains an unsupported value");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => { assertString(key, "DR manifest field"); return `${JSON.stringify(key)}:${canonical(record[key])}`; }).join(",")}}`;
}

const POSTGRES_SCHEMA_FIELDS = [
  "databaseName", "serverVersionNum", "serverMajor", "schemaVersion", "migrations", "tableCounts",
  "excludedDataTables", "pgDumpVersion", "roleInventorySha256", "claimedDeliveryCount", "readinessAttestations",
] as const;
const POSTGRES_EXCLUDED_DATA = [
  "agent_bridge.agent_instances", "agent_bridge.rate_limit_buckets", "agent_bridge.request_authorities",
  "agent_bridge.archive_transaction_authorizations",
] as const;

function validateSchema(kind: NativeDrManifest["kind"], value: unknown): Record<string, unknown> {
  if (kind === "sqlite") {
    const schema = exactObject(value, ["applicationId", "schemaContractSha256", "userVersion"], "DR SQLite schema");
    if (!Number.isSafeInteger(schema.applicationId) || !Number.isSafeInteger(schema.userVersion)
      || typeof schema.schemaContractSha256 !== "string" || !/^[a-f0-9]{64}$/.test(schema.schemaContractSha256)) throw new NativeDrBundleError("DR SQLite schema metadata is invalid");
    return schema;
  }
  const schema = exactObject(value, POSTGRES_SCHEMA_FIELDS, "DR PostgreSQL schema");
  if (typeof schema.databaseName !== "string" || !schema.databaseName || schema.databaseName.length > 128
    || !Number.isSafeInteger(schema.serverVersionNum) || Number(schema.serverVersionNum) < 100000
    || !Number.isSafeInteger(schema.serverMajor) || Number(schema.serverMajor) < 10
    || !Number.isSafeInteger(schema.schemaVersion) || Number(schema.schemaVersion) < 1
    || typeof schema.pgDumpVersion !== "string" || !schema.pgDumpVersion || schema.pgDumpVersion.length > 128
    || typeof schema.roleInventorySha256 !== "string" || !/^[a-f0-9]{64}$/.test(schema.roleInventorySha256)
    || typeof schema.claimedDeliveryCount !== "string" || !/^(0|[1-9][0-9]*)$/.test(schema.claimedDeliveryCount)) {
    throw new NativeDrBundleError("DR PostgreSQL schema metadata is invalid");
  }
  assertString(schema.databaseName, "DR database name"); assertString(schema.pgDumpVersion, "DR pg_dump version");
  if (!Array.isArray(schema.migrations) || schema.migrations.length > 10_000) throw new NativeDrBundleError("DR PostgreSQL migration inventory is invalid");
  let priorVersion = 0;
  for (const raw of schema.migrations) {
    const migration = exactObject(raw, ["checksum", "name", "version"], "DR migration");
    if (!Number.isSafeInteger(migration.version) || Number(migration.version) <= priorVersion
      || typeof migration.name !== "string" || !/^[a-z0-9][a-z0-9_]{0,127}$/.test(migration.name)
      || typeof migration.checksum !== "string" || !/^[a-f0-9]{64}$/.test(migration.checksum)) {
      throw new NativeDrBundleError("DR PostgreSQL migration inventory is invalid");
    }
    priorVersion = Number(migration.version);
  }
  if (!schema.tableCounts || typeof schema.tableCounts !== "object" || Array.isArray(schema.tableCounts)) throw new NativeDrBundleError("DR PostgreSQL table counts are invalid");
  for (const [table, count] of Object.entries(schema.tableCounts as Record<string, unknown>)) {
    if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(table) || typeof count !== "string" || !/^(0|[1-9][0-9]*)$/.test(count)) {
      throw new NativeDrBundleError("DR PostgreSQL table counts are invalid");
    }
  }
  if (!Array.isArray(schema.excludedDataTables) || schema.excludedDataTables.length !== POSTGRES_EXCLUDED_DATA.length
    || schema.excludedDataTables.some((name, index) => name !== POSTGRES_EXCLUDED_DATA[index])) {
    throw new NativeDrBundleError("DR PostgreSQL excluded-data inventory is invalid");
  }
  const readiness = exactObject(schema.readinessAttestations, [
    "ownerControlSha256", "portableArchiveSha256", "rowIsolationSha256", "securitySchemaSha256",
  ], "DR PostgreSQL readiness attestations");
  if (Object.values(readiness).some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
    throw new NativeDrBundleError("DR PostgreSQL readiness attestations are invalid");
  }
  return schema;
}

function expectedEntries(kind: NativeDrManifest["kind"]): readonly string[] {
  return kind === "sqlite"
    ? ["sqlite/database.sqlite3"]
    : ["postgres/database.dump", "postgres/roles.json"];
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
}

function exactObject(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NativeDrBundleError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort(); const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new NativeDrBundleError(`${label} has unexpected fields`);
  }
  return record;
}

function parseManifest(bytes: Buffer): NativeDrManifest {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new NativeDrBundleError("DR manifest is not valid UTF-8"); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new NativeDrBundleError("DR manifest is not valid JSON"); }
  if (canonical(parsed) !== text) throw new NativeDrBundleError("DR manifest is not canonical JSON");
  const manifest = exactObject(parsed, ["backupId", "createdAt", "entries", "format", "kind", "schema", "version"], "DR manifest");
  if (manifest.format !== NATIVE_DR_FORMAT || manifest.version !== NATIVE_DR_VERSION
    || (manifest.kind !== "sqlite" && manifest.kind !== "postgres")) {
    throw new NativeDrBundleError("DR bundle format is unsupported");
  }
  if (typeof manifest.backupId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(manifest.backupId)) {
    throw new NativeDrBundleError("DR backup ID is invalid");
  }
  let canonicalTimestamp = "";
  try { canonicalTimestamp = typeof manifest.createdAt === "string" ? new Date(manifest.createdAt).toISOString() : ""; } catch { /* rejected below */ }
  if (typeof manifest.createdAt !== "string" || canonicalTimestamp !== manifest.createdAt) {
    throw new NativeDrBundleError("DR creation timestamp is invalid");
  }
  if (!Array.isArray(manifest.entries) || !manifest.entries.length || manifest.entries.length > MAX_ENTRIES) throw new NativeDrBundleError("DR entry set is invalid");
  let previous = "";
  for (const rawEntry of manifest.entries) {
    const entry = exactObject(rawEntry, ["length", "name", "sha256"], "DR entry");
    if (typeof entry.name !== "string" || !/^[a-z0-9][a-z0-9/_.-]{0,255}$/.test(entry.name)
      || entry.name.split("/").includes("..") || entry.name <= previous
      || !Number.isSafeInteger(entry.length) || Number(entry.length) < 1 || Number(entry.length) > NATIVE_DR_MAX_BUNDLE_BYTES
      || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new NativeDrBundleError("DR entry metadata is invalid");
    }
    previous = entry.name;
  }
  const allowedEntries = expectedEntries(manifest.kind as NativeDrManifest["kind"]);
  if (manifest.entries.length !== allowedEntries.length
    || manifest.entries.some((entry, index) => entry.name !== allowedEntries[index])) throw new NativeDrBundleError("DR entries do not match the provider kind");
  validateSchema(manifest.kind as NativeDrManifest["kind"], manifest.schema);
  return parsed as NativeDrManifest;
}

function hashFile(descriptor: number, identity: Stats): string {
  const hash = createHash("sha256"); const chunk = Buffer.allocUnsafe(CHUNK_BYTES); let position = 0;
  while (position < identity.size) {
    const read = readSync(descriptor, chunk, 0, Math.min(chunk.length, identity.size - position), position);
    if (read <= 0) throw new NativeDrBundleError("DR source ended before its recorded size");
    hash.update(chunk.subarray(0, read)); position += read;
  }
  if (!sameFile(identity, fstatSync(descriptor))) throw new NativeDrBundleError("DR source changed while hashing");
  return hash.digest("hex");
}

interface OpenInput { descriptor: number; identity: Stats; name: string; path: string; sha256: string }

function openInput(entry: NativeDrInputEntry): Omit<OpenInput, "sha256"> {
  const path = resolve(entry.path);
  verifyPrivatePathAccess(dirname(path), "directory"); verifyPrivatePathAccess(path, "file");
  const before = lstatSync(path);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const identity = fstatSync(descriptor); const named = lstatSync(path);
    if (!identity.isFile() || before.isSymbolicLink() || !sameFile(before, identity) || !sameFile(named, identity)
      || identity.size < 1 || identity.size > NATIVE_DR_MAX_BUNDLE_BYTES) throw new NativeDrBundleError("DR source is not a stable regular file");
    return { descriptor, identity, name: entry.name, path };
  } catch (error) { closeSync(descriptor); throw error; }
}

export function validateNativeDrAggregateSize(entryBytes: readonly number[], framingBytes = 0): number {
  let total = framingBytes;
  for (const bytes of entryBytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || total > NATIVE_DR_MAX_BUNDLE_BYTES - bytes) {
      throw new NativeDrBundleError("DR bundle exceeds its aggregate size limit");
    }
    total += bytes;
  }
  return total;
}

export function writeNativeDrBundle(
  outputDescriptor: number,
  input: NativeDrBundleInput,
  outputPath: string,
  hooks: NativeDrBundleWriteHooks = {},
): NativeDrManifest {
  if (!input.entries.length || input.entries.length > MAX_ENTRIES) throw new NativeDrBundleError("DR entry set is invalid");
  const names = input.entries.map((entry) => entry.name);
  if (names.some((name, index) => index > 0 && name <= names[index - 1]!)) throw new NativeDrBundleError("DR entries must be uniquely ordered by name");
  const allowedEntries = expectedEntries(input.kind);
  if (names.length !== allowedEntries.length || names.some((name, index) => name !== allowedEntries[index])) {
    throw new NativeDrBundleError("DR entries do not match the provider kind");
  }
  validateSchema(input.kind, input.schema);
  const sources: OpenInput[] = [];
  try {
    for (const entry of input.entries) {
      const opened = openInput(entry); sources.push({ ...opened, sha256: hashFile(opened.descriptor, opened.identity) });
    }
    hooks.afterHash?.();
    const manifest: NativeDrManifest = {
      backupId: input.backupId,
      createdAt: input.createdAt,
      entries: sources.map((source) => ({ length: source.identity.size, name: source.name, sha256: source.sha256 })),
      format: NATIVE_DR_FORMAT,
      kind: input.kind,
      schema: input.schema,
      version: NATIVE_DR_VERSION,
    };
    const manifestBytes = Buffer.from(canonical(manifest), "utf8");
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new NativeDrBundleError("DR manifest exceeds 64 KiB");
    parseManifest(manifestBytes);
    const output = resolve(outputPath); verifyPrivatePathAccess(dirname(output), "directory"); verifyPrivatePathAccess(output, "file");
    const openedOutput = fstatSync(outputDescriptor); const namedOutput = lstatSync(output);
    if (!openedOutput.isFile() || namedOutput.isSymbolicLink() || !sameFile(openedOutput, namedOutput) || openedOutput.size !== 0) {
      throw new NativeDrBundleError("DR output descriptor does not match its private staging path");
    }
    validateNativeDrAggregateSize(
      sources.map((source) => source.identity.size),
      HEADER_BYTES + manifestBytes.length + sources.reduce((total, source) => total + FRAME_BYTES + Buffer.byteLength(source.name), 0),
    );
    const header = Buffer.alloc(HEADER_BYTES); MAGIC.copy(header); header.writeUInt16BE(NATIVE_DR_VERSION, MAGIC.length); header.writeUInt32BE(manifestBytes.length, MAGIC.length + 2);
    writeAll(outputDescriptor, header); writeAll(outputDescriptor, manifestBytes);
    for (const source of sources) {
      const name = Buffer.from(source.name, "utf8");
      const frame = Buffer.alloc(FRAME_BYTES); frame.writeUInt16BE(name.length, 0); frame.writeBigUInt64BE(BigInt(source.identity.size), 2); Buffer.from(source.sha256, "hex").copy(frame, 10);
      writeAll(outputDescriptor, frame); writeAll(outputDescriptor, name);
      const streamedHash = createHash("sha256"); const chunk = Buffer.allocUnsafe(CHUNK_BYTES); let position = 0;
      while (position < source.identity.size) {
        const read = readSync(source.descriptor, chunk, 0, Math.min(chunk.length, source.identity.size - position), position);
        if (read <= 0) throw new NativeDrBundleError("DR source ended while streaming");
        const bytes = chunk.subarray(0, read); streamedHash.update(bytes); writeAll(outputDescriptor, bytes); position += read;
      }
      if (streamedHash.digest("hex") !== source.sha256) throw new NativeDrBundleError("DR source changed between hashing and bundling");
      if (!sameFile(source.identity, fstatSync(source.descriptor)) || !sameFile(source.identity, lstatSync(source.path))) {
        throw new NativeDrBundleError("DR source changed while bundling");
      }
    }
    fsyncSync(outputDescriptor);
    return manifest;
  } finally { for (const source of sources) closeSync(source.descriptor); }
}

export class NativeDrBundleReader {
  readonly path: string;
  private readonly descriptor: number;
  private readonly identity: Stats;
  private closed = false;

  constructor(path: string) {
    this.path = resolve(path);
    verifyPrivatePathAccess(dirname(this.path), "directory");
    verifyPrivatePathAccess(this.path, "file");
    const before = lstatSync(this.path); const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    this.descriptor = openSync(this.path, constants.O_RDONLY | noFollow);
    try {
      this.identity = fstatSync(this.descriptor); const after = lstatSync(this.path);
      if (!this.identity.isFile() || before.isSymbolicLink() || !sameFile(before, this.identity) || !sameFile(after, this.identity)
        || this.identity.size < HEADER_BYTES + FRAME_BYTES + 1 || this.identity.size > NATIVE_DR_MAX_BUNDLE_BYTES) {
        throw new NativeDrBundleError("DR bundle is not a stable regular file");
      }
    } catch (error) { closeSync(this.descriptor); throw error; }
  }

  private readExact(position: number, length: number, hash: ReturnType<typeof createHash>): Buffer {
    const output = Buffer.allocUnsafe(length); let offset = 0;
    while (offset < length) {
      const read = readSync(this.descriptor, output, offset, length - offset, position + offset);
      if (read <= 0) throw new NativeDrBundleError("DR bundle ended unexpectedly");
      offset += read;
    }
    hash.update(output); return output;
  }

  inspect(output?: (entry: NativeDrManifest["entries"][number]) => number | undefined): NativeDrBundleMetadata {
    if (this.closed) throw new NativeDrBundleError("DR bundle is closed");
    const bundleHash = createHash("sha256"); let position = 0;
    const header = this.readExact(position, HEADER_BYTES, bundleHash); position += header.length;
    if (!header.subarray(0, MAGIC.length).equals(MAGIC) || header.readUInt16BE(MAGIC.length) !== NATIVE_DR_VERSION) {
      throw new NativeDrBundleError("DR bundle header is unsupported");
    }
    const manifestLength = header.readUInt32BE(MAGIC.length + 2);
    if (manifestLength < 1 || manifestLength > MAX_MANIFEST_BYTES) throw new NativeDrBundleError("DR manifest size is invalid");
    const manifest = parseManifest(this.readExact(position, manifestLength, bundleHash)); position += manifestLength;
    for (const expected of manifest.entries) {
      const frame = this.readExact(position, FRAME_BYTES, bundleHash); position += frame.length;
      const nameLength = frame.readUInt16BE(0); const length = Number(frame.readBigUInt64BE(2)); const digest = frame.subarray(10).toString("hex");
      if (!Number.isSafeInteger(length) || length !== expected.length || digest !== expected.sha256) {
        throw new NativeDrBundleError("DR entry frame does not match the manifest");
      }
      const name = this.readExact(position, nameLength, bundleHash); position += nameLength;
      let decoded: string;
      try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(name); }
      catch { throw new NativeDrBundleError("DR entry name is not valid UTF-8"); }
      if (decoded !== expected.name) throw new NativeDrBundleError("DR entry name does not match the manifest");
      const outputDescriptor = output?.(expected);
      const entryHash = createHash("sha256"); const chunk = Buffer.allocUnsafe(CHUNK_BYTES); let remaining = length;
      while (remaining > 0) {
        const requested = Math.min(chunk.length, remaining); const read = readSync(this.descriptor, chunk, 0, requested, position);
        if (read <= 0) throw new NativeDrBundleError("DR entry ended unexpectedly");
        const bytes = chunk.subarray(0, read); bundleHash.update(bytes); entryHash.update(bytes);
        if (outputDescriptor !== undefined) writeAll(outputDescriptor, bytes);
        position += read; remaining -= read;
      }
      if (entryHash.digest("hex") !== digest) throw new NativeDrBundleError("DR entry digest verification failed");
    }
    if (position !== this.identity.size) throw new NativeDrBundleError("DR bundle has trailing bytes");
    if (!sameFile(this.identity, fstatSync(this.descriptor)) || !sameFile(this.identity, lstatSync(this.path))) {
      throw new NativeDrBundleError("DR bundle changed while reading");
    }
    return { manifest, bundleSha256: bundleHash.digest("hex"), bundleBytes: this.identity.size };
  }

  close(): void { if (!this.closed) { this.closed = true; closeSync(this.descriptor); } }
}
