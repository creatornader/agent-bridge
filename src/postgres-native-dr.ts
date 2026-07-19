import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync,
  readSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import pg from "pg";
import { createBoundedToolOutput } from "./bounded-tool-output.js";
import { NATIVE_DR_ADVISORY_LOCK_KEY, rowIsolationReady } from "./migrations.js";
import type { PgQueryable } from "./postgres-bridge-store.js";
import { securePrivatePath, verifyPrivatePathAccess } from "./private-path.js";

export const POSTGRES_NATIVE_DR_ROLE_SCHEMA = "agent-bridge.postgres-native-dr-roles";
export const POSTGRES_NATIVE_DR_ROLE_VERSION = 1;
export const POSTGRES_NATIVE_DR_SERVICE = "agent_bridge_dr";

export const POSTGRES_NATIVE_DR_LEGACY_EXCLUDED_DATA_TABLES = [
  "agent_bridge.agent_instances",
  "agent_bridge.rate_limit_buckets",
  "agent_bridge.request_authorities",
  "agent_bridge.archive_transaction_authorizations",
] as const;

export const POSTGRES_NATIVE_DR_EXCLUDED_DATA_TABLES = [
  ...POSTGRES_NATIVE_DR_LEGACY_EXCLUDED_DATA_TABLES,
  "agent_bridge.endpoint_migration_challenges",
] as const;

function excludedDataTablesForSchemaVersion(schemaVersion: number): readonly string[] {
  return schemaVersion <= 17
    ? POSTGRES_NATIVE_DR_LEGACY_EXCLUDED_DATA_TABLES
    : POSTGRES_NATIVE_DR_EXCLUDED_DATA_TABLES;
}

const SSL_PARAMETERS = new Set([
  "channel_binding",
  "sslcert",
  "sslcrl",
  "sslcrldir",
  "sslkey",
  "sslmode",
  "sslrootcert",
  "sslsni",
]);

const DERIVED_ROLE = /^agent_bridge_(?:runtime|data_owner|context_reader|event_writer|control_owner|control_operator|control_auditor|archive_operator)_[0-9a-f]{16}$/;
const ROLE_NAME = /^[^\u0000-\u001f\u007f]{1,63}$/u;

function validPostgresIdentifier(value: string): boolean {
  return value !== "PUBLIC" && !value.includes(":")
    && ROLE_NAME.test(value) && Buffer.byteLength(value, "utf8") <= 63;
}

export type PostgresDrRoleKind = "derived" | "schema-owner" | "object-role" | "external-principal";

export interface PostgresDrRole {
  name: string;
  kind: PostgresDrRoleKind;
}

export interface PostgresDrMembership {
  role: string;
  member: string;
  adminOption: boolean;
  inheritOption: boolean;
  setOption: boolean;
}

interface PostgresDrDefaultAclGrantBase {
  grantor: string;
  privilege: string;
  grantable: boolean;
}

export type PostgresDrDefaultAclGrant = PostgresDrDefaultAclGrantBase & (
  { granteeKind: "public" }
  | { granteeKind: "role"; grantee: string }
);

export interface PostgresDrDefaultAcl {
  owner: string;
  schema: "agent_bridge" | null;
  objectType: "r" | "S" | "f" | "T" | "n";
  grants: PostgresDrDefaultAclGrant[];
}

export interface PostgresDrRoleInventory {
  schema: typeof POSTGRES_NATIVE_DR_ROLE_SCHEMA;
  version: typeof POSTGRES_NATIVE_DR_ROLE_VERSION;
  databaseName: string;
  roles: PostgresDrRole[];
  memberships: PostgresDrMembership[];
  defaultAcls: PostgresDrDefaultAcl[];
}

export interface PostgresDrLibpqFiles {
  serviceName: typeof POSTGRES_NATIVE_DR_SERVICE;
  serviceFile: string;
  passFile: string;
  environment: Record<"LC_ALL" | "PGAPPNAME" | "PGPASSFILE" | "PGSERVICE" | "PGSERVICEFILE", string>;
}

export interface PostgresNativeDrMigration {
  version: number;
  name: string;
  checksum: string;
}

export interface PostgresNativeDrSchema {
  databaseName: string;
  serverVersionNum: number;
  serverMajor: number;
  schemaVersion: number;
  migrations: PostgresNativeDrMigration[];
  tableCounts: Record<string, string>;
  excludedDataTables: string[];
  claimedDeliveryCount: string;
  pgDumpVersion: string;
  roleInventorySha256: string;
  readinessAttestations: {
    securitySchemaSha256: string;
    rowIsolationSha256: string;
    ownerControlSha256: string;
    portableArchiveSha256: string;
  };
}

export interface PostgresNativeDrBundleInput {
  backupId: string;
  createdAt: string;
  kind: "postgres";
  schema: PostgresNativeDrSchema;
  entries: readonly [
    { name: "postgres/database.dump"; path: string },
    { name: "postgres/roles.json"; path: string },
  ];
}

interface PostgresDrQueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export interface PostgresDrClient {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<PostgresDrQueryResult<T>>;
  end(): Promise<void>;
}

export interface PostgresDrToolResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface PostgresNativeDrDependencies {
  createClient(connectionUrl: string): PostgresDrClient;
  resolveTool(tool: "pg_dump" | "pg_restore", toolDirectory?: string): string;
  runTool(
    command: string,
    args: string[],
    environment: Record<string, string>,
    inputFileDescriptor?: number,
  ): Promise<PostgresDrToolResult>;
  now(): Date;
  randomId(): string;
  checkRowIsolationReady(client: PostgresDrClient): Promise<boolean>;
  removePath(path: string): void;
}

export interface BackupPostgresNativeDrOptions {
  stagingDirectory: string;
  backupId?: string;
  environment?: NodeJS.ProcessEnv;
  toolDirectory?: string;
  dependencies?: Partial<PostgresNativeDrDependencies>;
}

export interface RestorePostgresNativeDrOptions {
  dumpPath: string;
  rolesPath: string;
  schema: PostgresNativeDrSchema;
  artifactAnchors: PostgresNativeDrArtifactAnchors;
  acceptSourceSqlRisk: boolean;
  environment?: NodeJS.ProcessEnv;
  toolDirectory?: string;
  dependencies?: Partial<PostgresNativeDrDependencies>;
}

export interface PostgresNativeDrArtifactAnchor {
  descriptor: number;
  device: string;
  inode: string;
  size: string;
  ctimeNanoseconds: string;
  mtimeNanoseconds: string;
  sha256: string;
}

export interface PostgresNativeDrArtifactAnchors {
  dump: PostgresNativeDrArtifactAnchor;
  roles: PostgresNativeDrArtifactAnchor;
}

export interface VerifyPostgresNativeDrArtifactsOptions {
  dumpPath: string;
  rolesPath: string;
  schema: PostgresNativeDrSchema;
  artifactAnchors: PostgresNativeDrArtifactAnchors;
  toolDirectory?: string;
  dependencies?: Partial<PostgresNativeDrDependencies>;
}

export interface VerifyPostgresNativeDrArtifactsResult {
  schema: PostgresNativeDrSchema;
  roleInventory: PostgresDrRoleInventory;
  artifactAnchors: PostgresNativeDrArtifactAnchors;
  dumpTocVerified: true;
  dumpToc: string;
}

export interface RestorePostgresNativeDrResult {
  databaseName: string;
  normalizedClaimedDeliveries: string;
  tableCounts: Record<string, string>;
  readiness: { security: true; rowIsolation: true; ownerControl: true; portableArchive: true };
}

export class PostgresNativeDrError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: {
      residualRoleShells?: string[];
      targetOffline?: boolean;
      targetMutated?: boolean;
      restoreCompleted?: boolean;
      recoveryPaths?: string[];
      causeCode?: string;
    } = {},
  ) {
    super(message);
    this.name = "PostgresNativeDrError";
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const expectedSet = new Set(expected);
  const unexpected = Object.keys(value).filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !(key in value));
  if (unexpected.length > 0) throw new Error(`${label} has unexpected fields: ${unexpected.join(", ")}`);
  if (missing.length > 0) throw new Error(`${label} is missing fields: ${missing.join(", ")}`);
}

function assertSafeText(value: string, label: string): void {
  if (value.length === 0 || /[\u0000\r\n]/u.test(value)) throw new Error(`${label} is invalid`);
}

function serviceValue(value: string, label: string): string {
  assertSafeText(value, label);
  if (value.trim() !== value) throw new Error(`${label} cannot begin or end with whitespace`);
  return value;
}

function pgpassValue(value: string): string {
  assertSafeText(value, "PostgreSQL credential component");
  return value.split("\\").join("\\\\").split(":").join("\\:");
}

export function createPostgresDrLibpqFiles(connectionUrl: string, directory: string): PostgresDrLibpqFiles {
  let url: URL;
  try {
    url = new URL(connectionUrl);
  } catch {
    throw new Error("PostgreSQL disaster recovery URL is invalid");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("PostgreSQL disaster recovery URL must use postgres or postgresql");
  }
  if (!url.hostname || !url.username || !url.pathname || url.pathname === "/") {
    throw new Error("PostgreSQL disaster recovery URL must include host, user, and database");
  }
  for (const key of url.searchParams.keys()) {
    if (!SSL_PARAMETERS.has(key)) throw new Error(`unsupported PostgreSQL connection parameter: ${key}`);
  }
  const duplicateKeys = [...new Set(url.searchParams.keys())]
    .filter((key) => url.searchParams.getAll(key).length !== 1);
  if (duplicateKeys.length > 0) throw new Error(`duplicate PostgreSQL connection parameter: ${duplicateKeys[0]}`);

  const targetDirectory = resolve(directory);
  securePrivatePath(targetDirectory, "directory");
  verifyPrivatePathAccess(targetDirectory, "directory");
  const serviceFile = resolve(targetDirectory, "pg_service.conf");
  const passFile = resolve(targetDirectory, "pgpass");
  let database: string;
  let user: string;
  let password: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new Error("PostgreSQL disaster recovery URL contains invalid percent encoding");
  }
  const host = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const port = url.port || "5432";
  const serviceLines = [
    `[${POSTGRES_NATIVE_DR_SERVICE}]`,
    `host=${serviceValue(host, "PostgreSQL host")}`,
    `port=${serviceValue(port, "PostgreSQL port")}`,
    `dbname=${serviceValue(database, "PostgreSQL database")}`,
    `user=${serviceValue(user, "PostgreSQL user")}`,
  ];
  for (const [key, value] of [...url.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    serviceLines.push(`${key}=${serviceValue(value, `PostgreSQL ${key}`)}`);
  }
  writeFileSync(serviceFile, `${serviceLines.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  writeFileSync(passFile, `${[
    pgpassValue(host),
    pgpassValue(port),
    pgpassValue(database),
    pgpassValue(user),
    pgpassValue(password),
  ].join(":")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  securePrivatePath(serviceFile, "file");
  securePrivatePath(passFile, "file");
  verifyPrivatePathAccess(serviceFile, "file");
  verifyPrivatePathAccess(passFile, "file");
  return {
    serviceName: POSTGRES_NATIVE_DR_SERVICE,
    serviceFile,
    passFile,
    environment: {
      LC_ALL: "C",
      PGAPPNAME: "agent-bridge-native-dr",
      PGPASSFILE: passFile,
      PGSERVICE: POSTGRES_NATIVE_DR_SERVICE,
      PGSERVICEFILE: serviceFile,
    },
  };
}

export function buildPgDumpArgs(outputPath: string, snapshot: string, serviceName = POSTGRES_NATIVE_DR_SERVICE): string[] {
  return buildPgDumpArgsForTables(outputPath, snapshot, serviceName, POSTGRES_NATIVE_DR_EXCLUDED_DATA_TABLES);
}

function buildPgDumpArgsForTables(
  outputPath: string,
  snapshot: string,
  serviceName: string,
  excludedDataTables: readonly string[],
): string[] {
  assertSafeText(outputPath, "PostgreSQL dump path");
  assertSafeText(snapshot, "PostgreSQL snapshot");
  assertSafeText(serviceName, "PostgreSQL service name");
  return [
    "--format=custom",
    `--file=${outputPath}`,
    "--schema=agent_bridge",
    "--no-tablespaces",
    `--snapshot=${snapshot}`,
    ...excludedDataTables.map((table) => `--exclude-table-data=${table}`),
    `--dbname=service=${serviceName}`,
  ];
}

export function buildPgRestoreArgs(inputPath: string | undefined, serviceName = POSTGRES_NATIVE_DR_SERVICE): string[] {
  if (inputPath !== undefined) assertSafeText(inputPath, "PostgreSQL dump path");
  assertSafeText(serviceName, "PostgreSQL service name");
  return [
    "--exit-on-error",
    "--single-transaction",
    "--no-tablespaces",
    "--schema=agent_bridge",
    `--dbname=service=${serviceName}`,
    ...(inputPath === undefined ? [] : [inputPath]),
  ];
}

export function buildPgRestoreListArgs(inputPath?: string): string[] {
  if (inputPath !== undefined) assertSafeText(inputPath, "PostgreSQL dump path");
  return inputPath === undefined ? ["--list"] : ["--list", inputPath];
}

export function buildPgRestoreSchemaAclArgs(
  inputPath: string | undefined,
  listPath: string,
  serviceName = POSTGRES_NATIVE_DR_SERVICE,
): string[] {
  if (inputPath !== undefined) assertSafeText(inputPath, "PostgreSQL dump path");
  assertSafeText(listPath, "PostgreSQL restore list path");
  assertSafeText(serviceName, "PostgreSQL service name");
  return [
    "--exit-on-error",
    "--single-transaction",
    "--no-tablespaces",
    `--use-list=${listPath}`,
    `--dbname=service=${serviceName}`,
    ...(inputPath === undefined ? [] : [inputPath]),
  ];
}

const POSTGRES_TOC_DESCRIPTORS = [
  "MATERIALIZED VIEW DATA", "SEQUENCE OWNED BY", "SECURITY LABEL", "CHECK CONSTRAINT",
  "PUBLICATION TABLE", "MATERIALIZED VIEW", "SEQUENCE SET", "TABLE ATTACH",
  "ROW SECURITY", "DEFAULT ACL", "TABLE DATA", "FK CONSTRAINT", "OPERATOR CLASS",
  "OPERATOR FAMILY", "FOREIGN TABLE", "BLOB COMMENTS", "BLOB ACL", "PROCEDURE",
  "AGGREGATE", "COLLATION", "CONVERSION", "CONSTRAINT", "FUNCTION", "OPERATOR",
  "SEQUENCE", "TRIGGER", "POLICY", "COMMENT", "DEFAULT", "SCHEMA", "TABLE", "TYPE",
  "DOMAIN", "INDEX", "RULE", "VIEW", "ACL",
] as const;
const POSTGRES_TOC_MAX_BYTES = 16 * 1024 * 1024;

function parsePostgresDumpTocBody(entry: string): string | undefined {
  let cursor = 0;
  const readDigits = (): boolean => {
    const start = cursor;
    while (cursor < entry.length) {
      const code = entry.charCodeAt(cursor);
      if (code < 48 || code > 57) break;
      cursor += 1;
    }
    return cursor > start;
  };
  const readSeparator = (): boolean => {
    const start = cursor;
    while (entry[cursor] === " " || entry[cursor] === "\t") cursor += 1;
    return cursor > start;
  };

  if (!readDigits() || entry[cursor] !== ";") return undefined;
  cursor += 1;
  if (!readSeparator() || !readDigits() || !readSeparator() || !readDigits() || !readSeparator()) {
    return undefined;
  }
  return cursor < entry.length ? entry.slice(cursor) : undefined;
}

export function validatePostgresDumpToc(text: string): void {
  if (Buffer.byteLength(text, "utf8") > POSTGRES_TOC_MAX_BYTES) {
    throw new PostgresNativeDrError("PG_DUMP_TOC_INVALID", "PostgreSQL dump table of contents exceeds 16 MiB");
  }
  const entries = text.split(/\r?\n/u).map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(";"));
  if (entries.length === 0) throw new PostgresNativeDrError("PG_DUMP_TOC_INVALID", "PostgreSQL dump table of contents is empty");
  for (const entry of entries) {
    const body = parsePostgresDumpTocBody(entry);
    if (body === undefined) throw new PostgresNativeDrError("PG_DUMP_TOC_INVALID", "PostgreSQL dump table of contents has an invalid record");
    const descriptor = POSTGRES_TOC_DESCRIPTORS.find((candidate) => body.startsWith(`${candidate} `));
    if (!descriptor) throw new PostgresNativeDrError("PG_DUMP_TOC_OUT_OF_SCOPE", "PostgreSQL dump contains an unsupported object kind");
    const remainder = body.slice(descriptor.length + 1).split(/\s+/u);
    const namespace = remainder[0] === "-"
      ? descriptor === "SCHEMA" ? remainder[1] : remainder[2]
      : remainder[0];
    if (namespace !== "agent_bridge") {
      throw new PostgresNativeDrError("PG_DUMP_TOC_OUT_OF_SCOPE", "PostgreSQL dump contains an object outside the agent_bridge schema");
    }
  }
}

export function schemaAclRestoreList(text: string): string {
  validatePostgresDumpToc(text);
  const entries = text.split(/\r?\n/u).map((line) => line.trim())
    .filter((line) => /^\d+;\s+\d+\s+\d+\s+ACL\s+-\s+SCHEMA\s+agent_bridge(?:\s|$)/u.test(line));
  if (entries.length !== 1) {
    throw new PostgresNativeDrError("PG_DUMP_TOC_INVALID", "PostgreSQL dump must contain exactly one Agent Bridge schema ACL entry");
  }
  return `${entries[0]}\n`;
}

export function parsePostgresToolMajor(output: string): number {
  const match = /\(PostgreSQL\)\s+(\d+)(?:\.\d+)?(?:\s|$)/u.exec(output.trim());
  if (!match) throw new Error("cannot parse PostgreSQL tool version");
  const major = Number(match[1]);
  if (!Number.isSafeInteger(major) || major < 15 || major > 18) {
    throw new Error(`unsupported PostgreSQL tool version: ${match[1]}`);
  }
  return major;
}

function validateRole(value: unknown, index: number): PostgresDrRole {
  assertRecord(value, `roles[${index}]`);
  exactKeys(value, ["name", "kind"], `roles[${index}]`);
  if (typeof value.name !== "string" || !validPostgresIdentifier(value.name)) throw new Error(`roles[${index}].name is invalid`);
  if (!(["derived", "schema-owner", "object-role", "external-principal"] as unknown[]).includes(value.kind)) {
    throw new Error(`roles[${index}].kind is invalid`);
  }
  if (value.kind === "derived" && !DERIVED_ROLE.test(value.name)) {
    throw new Error(`roles[${index}] is not an Agent Bridge derived role`);
  }
  if (value.kind !== "derived" && value.kind !== "schema-owner" && DERIVED_ROLE.test(value.name)) {
    throw new Error(`roles[${index}] must classify its Agent Bridge derived role`);
  }
  return { name: value.name, kind: value.kind as PostgresDrRoleKind };
}

function validateMembership(value: unknown, index: number): PostgresDrMembership {
  assertRecord(value, `memberships[${index}]`);
  exactKeys(value, ["role", "member", "adminOption", "inheritOption", "setOption"], `memberships[${index}]`);
  if (typeof value.role !== "string" || typeof value.member !== "string") {
    throw new Error(`memberships[${index}] role and member must be strings`);
  }
  for (const field of ["adminOption", "inheritOption", "setOption"] as const) {
    if (typeof value[field] !== "boolean") throw new Error(`memberships[${index}].${field} must be boolean`);
  }
  const adminOption = value.adminOption as boolean;
  const inheritOption = value.inheritOption as boolean;
  const setOption = value.setOption as boolean;
  return {
    role: value.role,
    member: value.member,
    adminOption,
    inheritOption,
    setOption,
  };
}

const DEFAULT_PRIVILEGE_TYPES = new Set([
  "CREATE", "DELETE", "EXECUTE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT",
  "TRIGGER", "TRUNCATE", "UPDATE", "USAGE",
]);
const DEFAULT_PRIVILEGES_BY_OBJECT: Record<PostgresDrDefaultAcl["objectType"], ReadonlySet<string>> = {
  r: new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]),
  S: new Set(["USAGE", "SELECT", "UPDATE"]),
  f: new Set(["EXECUTE"]),
  T: new Set(["USAGE"]),
  n: new Set(["USAGE", "CREATE"]),
};

function validateDefaultAclGrant(value: unknown, aclIndex: number, grantIndex: number): PostgresDrDefaultAclGrant {
  const label = `defaultAcls[${aclIndex}].grants[${grantIndex}]`;
  assertRecord(value, label);
  if (value.granteeKind === "public") {
    exactKeys(value, ["grantor", "granteeKind", "privilege", "grantable"], label);
  } else if (value.granteeKind === "role") {
    exactKeys(value, ["grantor", "granteeKind", "grantee", "privilege", "grantable"], label);
    if (typeof value.grantee !== "string" || !validPostgresIdentifier(value.grantee)) {
      throw new Error(`${label}.grantee is invalid`);
    }
  } else {
    throw new Error(`${label}.granteeKind is invalid`);
  }
  if (typeof value.grantor !== "string" || !validPostgresIdentifier(value.grantor)) throw new Error(`${label}.grantor is invalid`);
  if (typeof value.privilege !== "string" || !DEFAULT_PRIVILEGE_TYPES.has(value.privilege)) {
    throw new Error(`${label}.privilege is invalid`);
  }
  if (typeof value.grantable !== "boolean") throw new Error(`${label}.grantable must be boolean`);
  return value as unknown as PostgresDrDefaultAclGrant;
}

function validateDefaultAcl(value: unknown, index: number): PostgresDrDefaultAcl {
  assertRecord(value, `defaultAcls[${index}]`);
  exactKeys(value, ["owner", "schema", "objectType", "grants"], `defaultAcls[${index}]`);
  if (typeof value.owner !== "string" || !validPostgresIdentifier(value.owner)) {
    throw new Error(`defaultAcls[${index}].owner is invalid`);
  }
  if (value.schema !== null && value.schema !== "agent_bridge") {
    throw new Error(`defaultAcls[${index}] references a schema outside Agent Bridge`);
  }
  if (!(value.objectType === "r" || value.objectType === "S" || value.objectType === "f"
    || value.objectType === "T" || value.objectType === "n")) {
    throw new Error(`defaultAcls[${index}].objectType is invalid`);
  }
  if (value.objectType === "n" && value.schema !== null) {
    throw new Error(`defaultAcls[${index}] cannot scope schema privileges to a schema`);
  }
  if (!Array.isArray(value.grants)) throw new Error(`defaultAcls[${index}].grants must be an array`);
  const grants = value.grants.map((grant, grantIndex) => validateDefaultAclGrant(grant, index, grantIndex));
  if (grants.some((grant) => !DEFAULT_PRIVILEGES_BY_OBJECT[value.objectType as PostgresDrDefaultAcl["objectType"]].has(grant.privilege))) {
    throw new Error(`defaultAcls[${index}] contains a privilege invalid for its object type`);
  }
  return {
    owner: value.owner,
    schema: value.schema,
    objectType: value.objectType,
    grants,
  } as PostgresDrDefaultAcl;
}

export function validatePostgresRoleInventory(value: unknown): PostgresDrRoleInventory {
  assertRecord(value, "PostgreSQL role inventory");
  exactKeys(value, ["schema", "version", "databaseName", "roles", "memberships", "defaultAcls"], "PostgreSQL role inventory");
  if (value.schema !== POSTGRES_NATIVE_DR_ROLE_SCHEMA || value.version !== POSTGRES_NATIVE_DR_ROLE_VERSION) {
    throw new Error("PostgreSQL role inventory schema or version is unsupported");
  }
  if (typeof value.databaseName !== "string" || !validPostgresIdentifier(value.databaseName)) {
    throw new Error("PostgreSQL role inventory databaseName is invalid");
  }
  if (!Array.isArray(value.roles) || !Array.isArray(value.memberships) || !Array.isArray(value.defaultAcls)) {
    throw new Error("PostgreSQL role inventory roles, memberships, and defaultAcls must be arrays");
  }
  const roles = value.roles.map(validateRole);
  const expectedDerivedSuffix = createHash("md5").update(value.databaseName as string).digest("hex").slice(0, 16);
  if (roles.some((role) => DERIVED_ROLE.test(role.name) && !role.name.endsWith(`_${expectedDerivedSuffix}`))) {
    throw new Error("PostgreSQL role inventory contains a derived role for another database");
  }
  if (roles.filter((role) => role.kind === "schema-owner").length !== 1) {
    throw new Error("PostgreSQL role inventory must contain exactly one schema owner");
  }
  const roleNames = new Set<string>();
  for (const role of roles) {
    if (roleNames.has(role.name)) throw new Error(`duplicate PostgreSQL role: ${role.name}`);
    roleNames.add(role.name);
  }
  const memberships = value.memberships.map(validateMembership);
  const membershipKeys = new Set<string>();
  for (const membership of memberships) {
    if (!roleNames.has(membership.role) || !roleNames.has(membership.member)) {
      throw new Error("PostgreSQL role membership references a role outside the inventory");
    }
    if (membership.role === membership.member) throw new Error("PostgreSQL role membership cannot be self-referential");
    const key = `${membership.role}\u0000${membership.member}`;
    if (membershipKeys.has(key)) throw new Error("duplicate PostgreSQL role membership");
    membershipKeys.add(key);
  }
  const defaultAcls = value.defaultAcls.map(validateDefaultAcl);
  const defaultAclKeys = new Set<string>();
  for (const acl of defaultAcls) {
    if (!roleNames.has(acl.owner)) throw new Error("PostgreSQL default ACL owner is outside the inventory");
    const aclKey = [acl.owner, acl.schema ?? "", acl.objectType].join("\u0000");
    if (defaultAclKeys.has(aclKey)) throw new Error("duplicate PostgreSQL default ACL");
    defaultAclKeys.add(aclKey);
    const grantKeys = new Set<string>();
    for (const grant of acl.grants) {
      if (grant.grantor !== acl.owner) {
        throw new Error("PostgreSQL default ACL with a grantor distinct from its owner is unsupported");
      }
      if (grant.granteeKind === "role" && !roleNames.has(grant.grantee)) {
        throw new Error("PostgreSQL default ACL references a grantee outside the inventory");
      }
      const grantKey = [grant.grantor, grant.granteeKind,
        grant.granteeKind === "role" ? grant.grantee : "", grant.privilege, String(grant.grantable)].join("\u0000");
      if (grantKeys.has(grantKey)) throw new Error("duplicate PostgreSQL default ACL grant");
      grantKeys.add(grantKey);
    }
  }
  return {
    schema: POSTGRES_NATIVE_DR_ROLE_SCHEMA,
    version: POSTGRES_NATIVE_DR_ROLE_VERSION,
    databaseName: value.databaseName,
    roles: roles.sort((left, right) => left.name.localeCompare(right.name)),
    memberships: memberships.sort((left, right) => left.role.localeCompare(right.role) || left.member.localeCompare(right.member)),
    defaultAcls: defaultAcls.map((acl) => ({
      ...acl,
      grants: acl.grants.sort((left, right) => left.grantor.localeCompare(right.grantor)
        || left.granteeKind.localeCompare(right.granteeKind)
        || (left.granteeKind === "role" ? left.grantee : "").localeCompare(
          right.granteeKind === "role" ? right.grantee : "",
        )
        || left.privilege.localeCompare(right.privilege)
        || Number(left.grantable) - Number(right.grantable)),
    })).sort((left, right) =>
      left.owner.localeCompare(right.owner)
      || (left.schema ?? "").localeCompare(right.schema ?? "")
      || left.objectType.localeCompare(right.objectType)),
  };
}

export function canonicalPostgresRoleInventory(inventory: PostgresDrRoleInventory): string {
  return `${JSON.stringify(validatePostgresRoleInventory(inventory))}\n`;
}

function quoteIdentifier(value: string): string {
  if (!validPostgresIdentifier(value)) throw new Error("PostgreSQL role name is invalid");
  return `"${value.split('"').join('""')}"`;
}

export function buildPostgresRoleShellStatements(inventory: PostgresDrRoleInventory): string[] {
  return validatePostgresRoleInventory(inventory).roles.map((role) =>
    `CREATE ROLE ${quoteIdentifier(role.name)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;`);
}

export function buildPostgresMembershipStatements(inventory: PostgresDrRoleInventory, serverMajor: number): string[] {
  if (!Number.isSafeInteger(serverMajor) || serverMajor < 15 || serverMajor > 18) {
    throw new Error("PostgreSQL membership target major must be between 15 and 18");
  }
  return validatePostgresRoleInventory(inventory).memberships.map((membership) => {
    if (serverMajor === 15) {
      if (!membership.inheritOption || !membership.setOption) {
        throw new Error("PostgreSQL 15 cannot preserve membership INHERIT FALSE or SET FALSE semantics");
      }
      return `GRANT ${quoteIdentifier(membership.role)} TO ${quoteIdentifier(membership.member)}${membership.adminOption ? " WITH ADMIN OPTION" : ""};`;
    }
    const options = [
      `ADMIN ${membership.adminOption ? "OPTION" : "FALSE"}`,
      `INHERIT ${membership.inheritOption ? "TRUE" : "FALSE"}`,
      `SET ${membership.setOption ? "TRUE" : "FALSE"}`,
    ].join(", ");
    return `GRANT ${quoteIdentifier(membership.role)} TO ${quoteIdentifier(membership.member)} WITH ${options};`;
  });
}

const DEFAULT_PRIVILEGE_OBJECTS: Record<PostgresDrDefaultAcl["objectType"], string> = {
  r: "TABLES",
  S: "SEQUENCES",
  f: "FUNCTIONS",
  T: "TYPES",
  n: "SCHEMAS",
};

export function buildPostgresDefaultPrivilegeStatements(inventory: PostgresDrRoleInventory): string[] {
  return validatePostgresRoleInventory(inventory).defaultAcls.map((acl) => {
    const prefix = `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(acl.owner)}`
      + `${acl.schema ? ` IN SCHEMA ${quoteIdentifier(acl.schema)}` : ""}`;
    const objects = DEFAULT_PRIVILEGE_OBJECTS[acl.objectType];
    const statements = [
      `SET LOCAL ROLE ${quoteIdentifier(acl.owner)}`,
      `${prefix} REVOKE ALL PRIVILEGES ON ${objects} FROM PUBLIC`,
      `${prefix} REVOKE ALL PRIVILEGES ON ${objects} FROM ${quoteIdentifier(acl.owner)}`,
    ];
    for (const grant of acl.grants) {
      const grantee = grant.granteeKind === "public" ? "PUBLIC" : quoteIdentifier(grant.grantee);
      statements.push(`${prefix} GRANT ${grant.privilege} ON ${objects} TO ${grantee}`
        + `${grant.grantable ? " WITH GRANT OPTION" : ""}`);
    }
    statements.push("RESET ROLE");
    return `${statements.join("; ")};`;
  });
}

function resolvePostgresTool(tool: "pg_dump" | "pg_restore", toolDirectory?: string): string {
  const executable = process.platform === "win32" ? `${tool}.exe` : tool;
  const candidates = toolDirectory
    ? [resolve(toolDirectory, executable)]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => resolve(directory, executable));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next parent-runtime path. Child processes receive no PATH.
    }
  }
  throw new PostgresNativeDrError("POSTGRES_TOOL_NOT_FOUND", `${tool} was not found in the selected PostgreSQL tool directory`);
}

async function runPostgresTool(
  command: string,
  args: string[],
  environment: Record<string, string>,
  inputFileDescriptor?: number,
): Promise<PostgresDrToolResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: [inputFileDescriptor ?? "ignore", "pipe", "pipe"],
    });
    const stdout = createBoundedToolOutput(POSTGRES_TOC_MAX_BYTES);
    const stderr = createBoundedToolOutput(POSTGRES_TOC_MAX_BYTES);
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKill.unref();
    }, 30 * 60_000);
    deadline.unref();
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(deadline);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (forceKill) clearTimeout(forceKill);
      const capturedStdout = stdout.read();
      const capturedStderr = stderr.read();
      resolveResult({
        stdout: capturedStdout.bytes.toString("utf8"),
        stderr: capturedStderr.bytes.toString("utf8"),
        exitCode: code ?? -1,
        timedOut,
        stdoutTruncated: capturedStdout.truncated,
        stderrTruncated: capturedStderr.truncated,
      });
    });
  });
}

const defaultDependencies: PostgresNativeDrDependencies = {
  createClient: (connectionUrl) => {
    const client = new pg.Client({
      connectionString: connectionUrl,
      application_name: "agent-bridge-native-dr",
      connectionTimeoutMillis: 10_000,
      query_timeout: 60_000,
    });
    client.on("error", () => { /* Queries surface active errors; this handles administrative termination while idle. */ });
    return client as unknown as PostgresDrClient;
  },
  resolveTool: resolvePostgresTool,
  runTool: runPostgresTool,
  now: () => new Date(),
  randomId: () => randomUUID(),
  checkRowIsolationReady: (client) => rowIsolationReady(
    client as unknown as PgQueryable,
    true,
  ),
  removePath: (path) => rmSync(path, { recursive: true, force: true }),
};

function dependencies(overrides?: Partial<PostgresNativeDrDependencies>): PostgresNativeDrDependencies {
  return { ...defaultDependencies, ...overrides };
}

function requiredEnvironmentUrl(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new PostgresNativeDrError("MISSING_DATABASE_AUTHORITY", `${name} is required`);
  return value;
}

function validateBackupId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new PostgresNativeDrError("INVALID_BACKUP_ID", "PostgreSQL native DR backup ID must be a UUID");
  }
  return normalized;
}

function sanitizedUnexpectedError(error: unknown, authorityUrl: string): string {
  const message = error instanceof Error ? error.message : "unknown error";
  let password = "";
  try { password = decodeURIComponent(new URL(authorityUrl).password); } catch { /* URL validation reports elsewhere. */ }
  return [authorityUrl, password].filter(Boolean).reduce(
    (text, secret) => text.split(secret).join("[redacted]"),
    message,
  ).slice(0, 512);
}

function serverMajor(serverVersionNum: number): number {
  if (!Number.isSafeInteger(serverVersionNum)) throw new PostgresNativeDrError("INVALID_SERVER_VERSION", "PostgreSQL server version is invalid");
  const major = Math.floor(serverVersionNum / 10_000);
  if (major < 15 || major > 18) throw new PostgresNativeDrError("UNSUPPORTED_SERVER_VERSION", "PostgreSQL server major must be between 15 and 18");
  return major;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateArtifactAnchor(value: PostgresNativeDrArtifactAnchor, label: string): PostgresNativeDrArtifactAnchor {
  assertRecord(value, label);
  exactKeys(value, [
    "descriptor", "device", "inode", "size", "ctimeNanoseconds", "mtimeNanoseconds", "sha256",
  ], label);
  if (!Number.isSafeInteger(value.descriptor) || value.descriptor < 0
    || typeof value.device !== "string" || !/^[0-9]+$/u.test(value.device)
    || typeof value.inode !== "string" || !/^[0-9]+$/u.test(value.inode)
    || typeof value.size !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.size)
    || typeof value.ctimeNanoseconds !== "string" || !/^[0-9]+$/u.test(value.ctimeNanoseconds)
    || typeof value.mtimeNanoseconds !== "string" || !/^[0-9]+$/u.test(value.mtimeNanoseconds)
    || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)) {
    throw new PostgresNativeDrError("ARTIFACT_ANCHOR_INVALID", `${label} is invalid`);
  }
  return value;
}

type ArtifactStat = ReturnType<typeof fstatSync> & {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

function artifactStat(descriptor: number): ArtifactStat {
  try {
    const stat = fstatSync(descriptor, { bigint: true }) as ArtifactStat;
    if (!stat.isFile()) throw new Error("not a regular file");
    return stat;
  } catch {
    throw new PostgresNativeDrError("ARTIFACT_ANCHOR_INVALID", "PostgreSQL native DR artifact anchor is not an open regular file");
  }
}

function sameArtifact(left: ArtifactStat, right: ArtifactStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function statMatchesAnchor(stat: ArtifactStat, anchor: PostgresNativeDrArtifactAnchor): boolean {
  return stat.dev.toString() === anchor.device && stat.ino.toString() === anchor.inode
    && stat.size.toString() === anchor.size && stat.ctimeNs.toString() === anchor.ctimeNanoseconds
    && stat.mtimeNs.toString() === anchor.mtimeNanoseconds;
}

function openAnchoredArtifact(inputPath: string, anchorInput: PostgresNativeDrArtifactAnchor): {
  descriptor: number;
  anchorStat: ArtifactStat;
} {
  const anchor = validateArtifactAnchor(anchorInput, "PostgreSQL artifact anchor");
  const anchorFileStat = artifactStat(anchor.descriptor);
  if (!statMatchesAnchor(anchorFileStat, anchor)) {
    throw new PostgresNativeDrError("ARTIFACT_IDENTITY_MISMATCH", "PostgreSQL native DR retained anchor changed after bundle verification");
  }
  const path = resolve(inputPath);
  verifyPrivatePathAccess(path, "file");
  const pathStat = lstatSync(path, { bigint: true });
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new PostgresNativeDrError("ARTIFACT_TYPE_INVALID", "PostgreSQL native DR artifact must be a regular file");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  const opened = fstatSync(descriptor, { bigint: true }) as ArtifactStat;
  if (!opened.isFile() || opened.dev !== pathStat.dev || opened.ino !== pathStat.ino
    || !sameArtifact(opened, anchorFileStat)) {
    closeSync(descriptor);
    throw new PostgresNativeDrError("ARTIFACT_IDENTITY_MISMATCH", "PostgreSQL native DR artifact path does not match its retained anchor");
  }
  return { descriptor, anchorStat: anchorFileStat };
}

function assertAnchoredDescriptorUnchanged(descriptor: number, anchorStat: ArtifactStat): void {
  if (!sameArtifact(artifactStat(descriptor), anchorStat)) {
    throw new PostgresNativeDrError("ARTIFACT_IDENTITY_MISMATCH", "PostgreSQL native DR artifact changed while it was in use");
  }
}

function readAnchoredArtifact(
  path: string,
  anchor: PostgresNativeDrArtifactAnchor,
  maximumBytes: number,
): Buffer {
  const opened = openAnchoredArtifact(path, anchor);
  try {
    if (opened.anchorStat.size > BigInt(maximumBytes)) {
      throw new PostgresNativeDrError("ROLE_INVENTORY_TOO_LARGE", "PostgreSQL role inventory exceeds 1 MiB");
    }
    const content = Buffer.alloc(Number(opened.anchorStat.size));
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(opened.descriptor, content, offset, content.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== content.length) throw new PostgresNativeDrError("ARTIFACT_IDENTITY_MISMATCH", "PostgreSQL native DR artifact changed while it was read");
    assertAnchoredDescriptorUnchanged(opened.descriptor, opened.anchorStat);
    return content;
  } finally {
    closeSync(opened.descriptor);
  }
}

async function runToolWithAnchoredInput(
  path: string,
  anchor: PostgresNativeDrArtifactAnchor,
  run: (descriptor: number) => Promise<PostgresDrToolResult>,
): Promise<PostgresDrToolResult> {
  const opened = openAnchoredArtifact(path, anchor);
  try {
    const result = await run(opened.descriptor);
    assertAnchoredDescriptorUnchanged(opened.descriptor, opened.anchorStat);
    return result;
  } finally {
    closeSync(opened.descriptor);
  }
}

function validateArtifactAnchors(value: PostgresNativeDrArtifactAnchors): PostgresNativeDrArtifactAnchors {
  assertRecord(value, "PostgreSQL artifact anchors");
  exactKeys(value, ["dump", "roles"], "PostgreSQL artifact anchors");
  return {
    dump: validateArtifactAnchor(value.dump, "PostgreSQL dump anchor"),
    roles: validateArtifactAnchor(value.roles, "PostgreSQL roles anchor"),
  };
}

function quoteSqlIdentifier(value: string): string {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("PostgreSQL identifier is invalid");
  return `"${value.split('"').join('""')}"`;
}

function assertToolSucceeded(result: PostgresDrToolResult, code: string, tool: string): void {
  if (result.timedOut) throw new PostgresNativeDrError(`${code}_TIMEOUT`, `${tool} exceeded the 30 minute execution deadline and was terminated`);
  if (result.exitCode !== 0) {
    const diagnostic = result.stderr.trim()
      .replace(/postgres(?:ql)?:\/\/\S+/giu, "[redacted PostgreSQL URL]")
      .replace(/password\s*=\s*\S+/giu, "password=[redacted]")
      .slice(0, 8_192);
    throw new PostgresNativeDrError(
      code,
      `${tool} failed with exit code ${result.exitCode}${diagnostic ? `: ${diagnostic}` : ""}`,
    );
  }
}

function assertPostgresTocOutputComplete(result: PostgresDrToolResult): void {
  if (result.stdoutTruncated) {
    throw new PostgresNativeDrError(
      "PG_DUMP_TOC_TRUNCATED",
      "PostgreSQL dump table of contents exceeds the 16 MiB verification limit",
    );
  }
}

async function checkedTools(
  sourceMajor: number,
  libpqEnvironment: Record<string, string>,
  toolDirectory: string | undefined,
  deps: PostgresNativeDrDependencies,
): Promise<{ pgDump: string; pgRestore: string; pgDumpVersion: string }> {
  const pgDump = deps.resolveTool("pg_dump", toolDirectory);
  const pgRestore = deps.resolveTool("pg_restore", toolDirectory);
  const dumpVersion = await deps.runTool(pgDump, ["--version"], libpqEnvironment);
  const restoreVersion = await deps.runTool(pgRestore, ["--version"], libpqEnvironment);
  assertToolSucceeded(dumpVersion, "PG_DUMP_VERSION_FAILED", "pg_dump --version");
  assertToolSucceeded(restoreVersion, "PG_RESTORE_VERSION_FAILED", "pg_restore --version");
  if (parsePostgresToolMajor(dumpVersion.stdout) !== sourceMajor
    || parsePostgresToolMajor(restoreVersion.stdout) !== sourceMajor) {
    throw new PostgresNativeDrError("POSTGRES_TOOL_MAJOR_MISMATCH", "pg_dump and pg_restore must exactly match the database server major");
  }
  return { pgDump, pgRestore, pgDumpVersion: dumpVersion.stdout.trim() };
}

export async function collectPostgresRoleInventory(
  client: PostgresDrClient,
  databaseName: string,
): Promise<PostgresDrRoleInventory> {
  const roleRows = await client.query<{ name: string; kind: PostgresDrRoleKind }>(`
    WITH derived_names(name) AS (
      SELECT prefix||substr(pg_catalog.md5(pg_catalog.current_database()),1,16)
      FROM unnest(ARRAY[
        'agent_bridge_runtime_','agent_bridge_data_owner_','agent_bridge_context_reader_',
        'agent_bridge_event_writer_','agent_bridge_control_owner_','agent_bridge_control_operator_',
        'agent_bridge_control_auditor_','agent_bridge_archive_operator_'
      ]) prefix
    ), object_roles AS (
      SELECT namespace.nspowner AS oid, 'schema-owner'::text AS kind
      FROM pg_catalog.pg_namespace namespace WHERE namespace.nspname='agent_bridge'
      UNION SELECT class.relowner, 'object-role' FROM pg_catalog.pg_class class
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=class.relnamespace
        WHERE namespace.nspname='agent_bridge'
      UNION SELECT procedure.proowner, 'object-role' FROM pg_catalog.pg_proc procedure
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=procedure.pronamespace
        WHERE namespace.nspname='agent_bridge'
      UNION SELECT type.typowner, 'object-role' FROM pg_catalog.pg_type type
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=type.typnamespace
        WHERE namespace.nspname='agent_bridge'
      UNION SELECT acl.grantor, 'object-role' FROM pg_catalog.pg_namespace namespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) acl WHERE namespace.nspname='agent_bridge'
      UNION SELECT acl.grantee, 'object-role' FROM pg_catalog.pg_namespace namespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) acl WHERE namespace.nspname='agent_bridge' AND acl.grantee<>0
      UNION SELECT acl.grantor, 'object-role' FROM pg_catalog.pg_class class
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=class.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(class.relacl) acl WHERE namespace.nspname='agent_bridge'
      UNION SELECT acl.grantee, 'object-role' FROM pg_catalog.pg_class class
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=class.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(class.relacl) acl WHERE namespace.nspname='agent_bridge' AND acl.grantee<>0
      UNION SELECT acl.grantor, 'object-role' FROM pg_catalog.pg_proc procedure
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=procedure.pronamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) acl WHERE namespace.nspname='agent_bridge'
      UNION SELECT acl.grantee, 'object-role' FROM pg_catalog.pg_proc procedure
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=procedure.pronamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) acl WHERE namespace.nspname='agent_bridge' AND acl.grantee<>0
      UNION SELECT acl.grantor, 'object-role' FROM pg_catalog.pg_type type
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=type.typnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(type.typacl) acl WHERE namespace.nspname='agent_bridge'
      UNION SELECT acl.grantee, 'object-role' FROM pg_catalog.pg_type type
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=type.typnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(type.typacl) acl WHERE namespace.nspname='agent_bridge' AND acl.grantee<>0
      UNION SELECT defaults.defaclrole, 'object-role' FROM pg_catalog.pg_default_acl defaults
        LEFT JOIN pg_catalog.pg_namespace namespace ON namespace.oid=defaults.defaclnamespace
        WHERE namespace.nspname='agent_bridge' OR defaults.defaclrole=(
          SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='agent_bridge')
          OR (defaults.defaclnamespace=0 AND defaults.defaclrole=(SELECT oid FROM pg_catalog.pg_roles
            WHERE rolname='agent_bridge_control_owner_'||substr(pg_catalog.md5(pg_catalog.current_database()),1,16)))
      UNION SELECT acl.grantor, 'object-role' FROM pg_catalog.pg_default_acl defaults
        LEFT JOIN pg_catalog.pg_namespace namespace ON namespace.oid=defaults.defaclnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) acl WHERE namespace.nspname='agent_bridge'
          OR defaults.defaclrole=(SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='agent_bridge')
          OR (defaults.defaclnamespace=0 AND defaults.defaclrole=(SELECT oid FROM pg_catalog.pg_roles
            WHERE rolname='agent_bridge_control_owner_'||substr(pg_catalog.md5(pg_catalog.current_database()),1,16)))
      UNION SELECT acl.grantee, 'object-role' FROM pg_catalog.pg_default_acl defaults
        LEFT JOIN pg_catalog.pg_namespace namespace ON namespace.oid=defaults.defaclnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) acl WHERE acl.grantee<>0 AND (
          namespace.nspname='agent_bridge' OR defaults.defaclrole=(
            SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='agent_bridge')
          OR (defaults.defaclnamespace=0 AND defaults.defaclrole=(SELECT oid FROM pg_catalog.pg_roles
            WHERE rolname='agent_bridge_control_owner_'||substr(pg_catalog.md5(pg_catalog.current_database()),1,16))))
    ), base_roles AS (
      SELECT role.oid, CASE WHEN role.rolname IN (SELECT name FROM derived_names)
        THEN 'derived' ELSE object_roles.kind END AS kind
      FROM pg_catalog.pg_roles role JOIN object_roles ON object_roles.oid=role.oid
      UNION
      SELECT role.oid, 'derived' FROM pg_catalog.pg_roles role
      WHERE role.rolname IN (SELECT name FROM derived_names)
    ), related_roles AS (
      SELECT oid, kind FROM base_roles
      UNION SELECT membership.roleid, 'external-principal' FROM pg_catalog.pg_auth_members membership
        WHERE membership.member IN (SELECT oid FROM base_roles)
      UNION SELECT membership.member, 'external-principal' FROM pg_catalog.pg_auth_members membership
        WHERE membership.roleid IN (SELECT oid FROM base_roles)
    )
    SELECT role.rolname AS name,
      CASE WHEN bool_or(related.kind='schema-owner') THEN 'schema-owner'
        WHEN role.rolname IN (SELECT name FROM derived_names) THEN 'derived'
        WHEN bool_or(related.kind='object-role') THEN 'object-role'
        ELSE 'external-principal' END AS kind
    FROM related_roles related JOIN pg_catalog.pg_roles role ON role.oid=related.oid
    GROUP BY role.rolname ORDER BY role.rolname`);
  const names = roleRows.rows.map((row) => row.name);
  const membershipRows = names.length === 0 ? { rows: [], rowCount: 0 } : await client.query<PostgresDrMembership>(`
    SELECT granted.rolname AS role, member.rolname AS member,
      membership.admin_option AS "adminOption",
      coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true) AS "inheritOption",
      coalesce((to_jsonb(membership)->>'set_option')::boolean,true) AS "setOption"
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
    JOIN pg_catalog.pg_roles member ON member.oid=membership.member
    WHERE granted.rolname=ANY($1::text[]) AND member.rolname=ANY($1::text[])
    ORDER BY granted.rolname,member.rolname`, [names]);
  if (names.length > 0) {
    const boundary = await client.query<{ found: number }>(`
      SELECT 1 AS found FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      WHERE (granted.rolname=ANY($1::text[])) <> (member.rolname=ANY($1::text[]))
      LIMIT 1`, [names]);
    if (boundary.rows.length > 0) {
      throw new PostgresNativeDrError(
        "TRANSITIVE_ROLE_MEMBERSHIP_UNSUPPORTED",
        "PostgreSQL role inventory has a transitive external membership outside the bounded restore graph",
      );
    }
  }
  const defaultPrivilegeRows = await client.query<{
    owner: string;
    schema: string | null;
    objectType: PostgresDrDefaultAcl["objectType"];
    grantor: string | null;
    granteePublic: boolean | null;
    grantee: string | null;
    privilege: string | null;
    grantable: boolean | null;
  }>(`
    SELECT owner.rolname AS owner,
      namespace.nspname AS schema,
      defaults.defaclobjtype::text AS "objectType",
      grantor.rolname AS grantor,
      CASE WHEN acl.grantee IS NULL THEN NULL ELSE acl.grantee=0 END AS "granteePublic",
      grantee.rolname AS grantee,
      acl.privilege_type AS privilege,
      acl.is_grantable AS grantable
    FROM pg_catalog.pg_default_acl defaults
    JOIN pg_catalog.pg_roles owner ON owner.oid=defaults.defaclrole
    LEFT JOIN pg_catalog.pg_namespace namespace ON namespace.oid=defaults.defaclnamespace
    LEFT JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) acl ON true
    LEFT JOIN pg_catalog.pg_roles grantor ON grantor.oid=acl.grantor
    LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
    WHERE namespace.nspname='agent_bridge' OR defaults.defaclrole=(
      SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='agent_bridge')
      OR (defaults.defaclnamespace=0 AND defaults.defaclrole=(SELECT oid FROM pg_catalog.pg_roles
        WHERE rolname='agent_bridge_control_owner_'||substr(pg_catalog.md5(pg_catalog.current_database()),1,16)))
    ORDER BY owner.rolname,namespace.nspname NULLS FIRST,defaults.defaclobjtype,
      grantor.rolname,grantee,acl.privilege_type,acl.is_grantable`);
  const defaultAcls: PostgresDrDefaultAcl[] = [];
  for (const row of defaultPrivilegeRows.rows) {
    let acl = defaultAcls.find((candidate) => candidate.owner === row.owner
      && candidate.schema === row.schema && candidate.objectType === row.objectType);
    if (!acl) {
      acl = { owner: row.owner, schema: row.schema as "agent_bridge" | null, objectType: row.objectType, grants: [] };
      defaultAcls.push(acl);
    }
    if (row.grantor !== null || row.granteePublic !== null || row.grantee !== null
      || row.privilege !== null || row.grantable !== null) {
      if (row.grantor === null || row.granteePublic === null || row.privilege === null || row.grantable === null
        || (!row.granteePublic && row.grantee === null)) {
        throw new PostgresNativeDrError("DEFAULT_ACL_INVALID", "PostgreSQL default ACL has an incomplete privilege record");
      }
      acl.grants.push({
        grantor: row.grantor,
        ...(row.granteePublic ? { granteeKind: "public" as const } : { granteeKind: "role" as const, grantee: row.grantee! }),
        privilege: row.privilege,
        grantable: row.grantable,
      });
    }
  }
  return validatePostgresRoleInventory({
    schema: POSTGRES_NATIVE_DR_ROLE_SCHEMA,
    version: POSTGRES_NATIVE_DR_ROLE_VERSION,
    databaseName,
    roles: roleRows.rows,
    memberships: membershipRows.rows,
    defaultAcls,
  });
}

async function collectSnapshotMetadata(
  client: PostgresDrClient,
  checkRowReady: (client: PostgresDrClient) => Promise<boolean>,
): Promise<{
  databaseName: string;
  serverVersionNum: number;
  migrations: PostgresNativeDrMigration[];
  tableCounts: Record<string, string>;
  claimedDeliveryCount: string;
  readinessAttestations: PostgresNativeDrSchema["readinessAttestations"];
}> {
  const metadata = await client.query<{ databaseName: string; serverVersionNum: string }>(
    `SELECT current_database() AS "databaseName", current_setting('server_version_num') AS "serverVersionNum"`,
  );
  const databaseName = metadata.rows[0]?.databaseName;
  const serverVersionNum = Number(metadata.rows[0]?.serverVersionNum);
  if (!databaseName) throw new PostgresNativeDrError("SOURCE_METADATA_INVALID", "source database metadata is unavailable");
  serverMajor(serverVersionNum);
  const migrationRows = await client.query<{ version: number | string; name: string; checksum: string }>(
    `SELECT version,name,checksum FROM agent_bridge.schema_migrations ORDER BY version`,
  );
  const migrations = migrationRows.rows.map((row) => ({
    version: Number(row.version), name: row.name, checksum: row.checksum,
  }));
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1 || !/^[a-z0-9_]+$/u.test(migration.name)
      || !/^[0-9a-f]{64}$/u.test(migration.checksum)) {
      throw new PostgresNativeDrError("SOURCE_MIGRATION_INVALID", "source migration inventory is invalid");
    }
  }
  if (migrations.length === 0) throw new PostgresNativeDrError("SOURCE_SCHEMA_EMPTY", "source has no Agent Bridge migrations");
  const schemaVersion = Math.max(...migrations.map((migration) => migration.version));
  const tableRows = await client.query<{ tableName: string }>(`
    SELECT table_name AS "tableName" FROM information_schema.tables
    WHERE table_schema='agent_bridge' AND table_type='BASE TABLE' ORDER BY table_name`);
  const tableCounts: Record<string, string> = {};
  for (const row of tableRows.rows) {
    const qualified = `agent_bridge.${row.tableName}`;
    const count = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_bridge.${quoteSqlIdentifier(row.tableName)}`,
    );
    const value = count.rows[0]?.count;
    if (!value || !/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new PostgresNativeDrError("SOURCE_COUNT_INVALID", `source count is invalid for ${qualified}`);
    tableCounts[qualified] = value;
  }
  const claimed = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_bridge.deliveries WHERE state='claimed'`,
  );
  const claimedDeliveryCount = claimed.rows[0]?.count;
  if (!claimedDeliveryCount || !/^(?:0|[1-9][0-9]*)$/u.test(claimedDeliveryCount)) {
    throw new PostgresNativeDrError("SOURCE_COUNT_INVALID", "source claimed delivery count is invalid");
  }
  const readiness = await client.query<{
    security: boolean;
    ownerControl: boolean;
    portableArchive: boolean;
    securityDefinition: string;
    ownerControlDefinition: string;
    portableArchiveDefinition: string;
    rowIsolationDefinition: string;
  }>(`
    SELECT agent_bridge.security_schema_ready() AS security,
      agent_bridge.owner_control_plane_ready() AS "ownerControl",
      agent_bridge.portable_archive_ready() AS "portableArchive",
      agent_bridge.credential_security_prerequisite_definition() AS "securityDefinition",
      agent_bridge.row_isolation_catalog_definition() AS "rowIsolationDefinition",
      agent_bridge.owner_control_attestation_definition() AS "ownerControlDefinition",
      agent_bridge.portable_archive_attestation_definition() AS "portableArchiveDefinition"`);
  const ready = readiness.rows[0];
  const rowReady = await checkRowReady(client);
  const authorityReady = await gatewayAuthorityReady(client, schemaVersion);
  if (!ready?.security || !rowReady || !ready.ownerControl || !ready.portableArchive
    || !authorityReady
    || typeof ready.securityDefinition !== "string"
    || typeof ready.rowIsolationDefinition !== "string"
    || typeof ready.ownerControlDefinition !== "string"
    || typeof ready.portableArchiveDefinition !== "string") {
    throw new PostgresNativeDrError("SOURCE_NOT_READY", "source PostgreSQL schema failed readiness attestation");
  }
  return {
    databaseName,
    serverVersionNum,
    migrations,
    tableCounts,
    claimedDeliveryCount,
    readinessAttestations: {
      securitySchemaSha256: sha256(ready.securityDefinition),
      rowIsolationSha256: sha256(ready.rowIsolationDefinition),
      ownerControlSha256: sha256(ready.ownerControlDefinition),
      portableArchiveSha256: sha256(ready.portableArchiveDefinition),
    },
  };
}

async function gatewayAuthorityReady(
  client: PostgresDrClient,
  schemaVersion: number,
): Promise<boolean> {
  if (schemaVersion <= 16) return true;
  const result = await client.query<{ ready: boolean }>(`
    WITH names AS (
      SELECT ('agent_bridge_runtime_' || substr(md5(current_database()),1,16))::name AS runtime_role,
        (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='agent_bridge') AS schema_owner
    ) SELECT
      agent_bridge.gateway_authority_ready()
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname='agent_bridge' AND relation.relname='gateway_authority'
          AND relation.relkind='r' AND relation.relowner=(SELECT schema_owner FROM names)
          AND NOT relation.relrowsecurity AND NOT relation.relforcerowsecurity
      )
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint table_constraint
        WHERE table_constraint.conrelid='agent_bridge.gateway_authority'::regclass
          AND table_constraint.conname='gateway_authority_singleton'
          AND table_constraint.contype='p'
          AND table_constraint.conkey::smallint[]=ARRAY[(SELECT attribute.attnum FROM pg_catalog.pg_attribute attribute
            WHERE attribute.attrelid='agent_bridge.gateway_authority'::regclass
              AND attribute.attname='singleton' AND attribute.attnum>0 AND NOT attribute.attisdropped)]
      )
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint table_constraint
        WHERE table_constraint.conrelid='agent_bridge.gateway_authority'::regclass
          AND table_constraint.conname='gateway_authority_singleton_true'
          AND table_constraint.contype='c'
          AND regexp_replace(
            pg_get_expr(table_constraint.conbin,table_constraint.conrelid),'[[:space:]()]','','g'
          )='singleton'
      )
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint table_constraint
        WHERE table_constraint.conrelid='agent_bridge.gateway_authority'::regclass
          AND table_constraint.conname='gateway_authority_id_unique'
          AND table_constraint.contype='u'
          AND table_constraint.conkey::smallint[]=ARRAY[(SELECT attribute.attnum FROM pg_catalog.pg_attribute attribute
            WHERE attribute.attrelid='agent_bridge.gateway_authority'::regclass
              AND attribute.attname='authority_id' AND attribute.attnum>0 AND NOT attribute.attisdropped)]
      )
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger trigger
        JOIN pg_catalog.pg_proc trigger_function ON trigger_function.oid=trigger.tgfoid
        JOIN pg_catalog.pg_namespace trigger_namespace ON trigger_namespace.oid=trigger_function.pronamespace
        WHERE trigger.tgrelid='agent_bridge.gateway_authority'::regclass
          AND trigger.tgname='gateway_authority_immutable'
          AND NOT trigger.tgisinternal AND trigger.tgenabled='O'
          AND (trigger.tgtype::integer & 1)=0
          AND (trigger.tgtype::integer & 2)=2
          AND (trigger.tgtype::integer & 56)=56
          AND trigger_function.proname='reject_gateway_authority_mutation'
          AND trigger_namespace.nspname='agent_bridge'
          AND trigger_function.proowner=(SELECT schema_owner FROM names)
          AND NOT trigger_function.prosecdef
          AND coalesce(trigger_function.proconfig @> ARRAY['search_path=""'],false)
      )
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc procedure
        WHERE procedure.oid='agent_bridge.gateway_authority_ready()'::regprocedure
          AND procedure.prosecdef AND procedure.provolatile='s'
          AND procedure.proowner=(SELECT schema_owner FROM names)
          AND coalesce(procedure.proconfig @> ARRAY['search_path=""'],false)
      )
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc procedure
        WHERE procedure.oid='agent_bridge.open_request_authority_bound(uuid,text,uuid)'::regprocedure
          AND procedure.prosecdef AND procedure.provolatile='v'
          AND procedure.proowner=(SELECT schema_owner FROM names)
          AND coalesce(procedure.proconfig @> ARRAY['search_path=""'],false)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(ARRAY[
          'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'
        ]) privilege(value)
        WHERE has_table_privilege((SELECT runtime_role FROM names),
          'agent_bridge.gateway_authority',privilege.value)
          OR has_table_privilege('public','agent_bridge.gateway_authority',privilege.value)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) privilege(value)
        WHERE has_any_column_privilege((SELECT runtime_role FROM names),
          'agent_bridge.gateway_authority',privilege.value)
          OR has_any_column_privilege('public','agent_bridge.gateway_authority',privilege.value)
      )
      AND has_function_privilege((SELECT runtime_role FROM names),
        'agent_bridge.gateway_authority_ready()','EXECUTE')
      AND has_function_privilege((SELECT runtime_role FROM names),
        'agent_bridge.open_request_authority_bound(uuid,text,uuid)','EXECUTE')
      AND NOT has_function_privilege('public','agent_bridge.gateway_authority_ready()','EXECUTE')
      AND NOT has_function_privilege('public',
        'agent_bridge.open_request_authority_bound(uuid,text,uuid)','EXECUTE') AS ready`);
  return result.rows[0]?.ready === true;
}

function createPrivateEmptyFile(path: string): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  closeSync(descriptor);
  securePrivatePath(path, "file");
  verifyPrivatePathAccess(path, "file");
}

export async function backupPostgresNativeDr(options: BackupPostgresNativeDrOptions): Promise<PostgresNativeDrBundleInput> {
  const env = options.environment ?? process.env;
  const sourceUrl = requiredEnvironmentUrl(env, "AGENT_BRIDGE_DR_SOURCE_DATABASE_URL");
  const stage = resolve(options.stagingDirectory);
  verifyPrivatePathAccess(stage, "directory");
  const deps = dependencies(options.dependencies);
  const libpqDirectory = mkdtempSync(join(stage, ".postgres-dr-libpq-"));
  securePrivatePath(libpqDirectory, "directory");
  verifyPrivatePathAccess(libpqDirectory, "directory");
  const dumpPath = join(stage, "postgres-database.dump");
  const rolesPath = join(stage, "postgres-roles.json");
  let source: PostgresDrClient | undefined;
  let postInventoryClient: PostgresDrClient | undefined;
  let lockHeld = false;
  let transactionOpen = false;
  let primaryFailure: PostgresNativeDrError | undefined;
  let backupCompleted = false;
  try {
    const libpq = createPostgresDrLibpqFiles(sourceUrl, libpqDirectory);
    createPrivateEmptyFile(dumpPath);
    source = deps.createClient(sourceUrl);
    await source.connect();
    await source.query("SELECT pg_catalog.pg_advisory_lock($1)", [NATIVE_DR_ADVISORY_LOCK_KEY]);
    lockHeld = true;
    await source.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    const snapshotResult = await source.query<{ snapshot: string }>("SELECT pg_catalog.pg_export_snapshot() AS snapshot");
    const snapshot = snapshotResult.rows[0]?.snapshot;
    if (!snapshot) throw new PostgresNativeDrError("SNAPSHOT_EXPORT_FAILED", "PostgreSQL did not export a disaster recovery snapshot");
    const metadata = await collectSnapshotMetadata(source, deps.checkRowIsolationReady);
    const major = serverMajor(metadata.serverVersionNum);
    const schemaVersion = Math.max(...metadata.migrations.map((migration) => migration.version));
    const excludedDataTables = excludedDataTablesForSchemaVersion(schemaVersion);
    const beforeInventory = await collectPostgresRoleInventory(source, metadata.databaseName);
    const canonicalRoles = canonicalPostgresRoleInventory(beforeInventory);
    const tools = await checkedTools(major, libpq.environment, options.toolDirectory, deps);
    const dump = await deps.runTool(
      tools.pgDump,
      buildPgDumpArgsForTables(dumpPath, snapshot, libpq.serviceName, excludedDataTables),
      libpq.environment,
    );
    assertToolSucceeded(dump, "PG_DUMP_FAILED", "pg_dump");
    verifyPrivatePathAccess(dumpPath, "file");
    if (statSync(dumpPath).size === 0) throw new PostgresNativeDrError("PG_DUMP_EMPTY", "pg_dump produced an empty file");
    const listed = await deps.runTool(tools.pgRestore, buildPgRestoreListArgs(dumpPath), libpq.environment);
    assertToolSucceeded(listed, "PG_RESTORE_LIST_FAILED", "pg_restore --list");
    assertPostgresTocOutputComplete(listed);
    validatePostgresDumpToc(listed.stdout);
    schemaAclRestoreList(listed.stdout);
    postInventoryClient = deps.createClient(sourceUrl);
    await postInventoryClient.connect();
    const afterInventory = await collectPostgresRoleInventory(postInventoryClient, metadata.databaseName);
    if (canonicalPostgresRoleInventory(afterInventory) !== canonicalRoles) {
      throw new PostgresNativeDrError("ROLE_INVENTORY_DRIFT", "PostgreSQL role inventory changed while the native DR fence was held");
    }
    writeFileSync(rolesPath, canonicalRoles, { encoding: "utf8", mode: 0o600, flag: "wx" });
    securePrivatePath(rolesPath, "file");
    verifyPrivatePathAccess(rolesPath, "file");
    await source.query("COMMIT");
    transactionOpen = false;
    await source.query("SELECT pg_catalog.pg_advisory_unlock($1)", [NATIVE_DR_ADVISORY_LOCK_KEY]);
    lockHeld = false;
    const result: PostgresNativeDrBundleInput = {
      backupId: validateBackupId(options.backupId ?? deps.randomId()),
      createdAt: deps.now().toISOString(),
      kind: "postgres",
      schema: {
        databaseName: metadata.databaseName,
        serverVersionNum: metadata.serverVersionNum,
        serverMajor: major,
        schemaVersion,
        migrations: metadata.migrations,
        tableCounts: metadata.tableCounts,
        excludedDataTables: [...excludedDataTables],
        claimedDeliveryCount: metadata.claimedDeliveryCount,
        pgDumpVersion: tools.pgDumpVersion,
        roleInventorySha256: sha256(canonicalRoles),
        readinessAttestations: metadata.readinessAttestations,
      },
      entries: [
        { name: "postgres/database.dump", path: dumpPath },
        { name: "postgres/roles.json", path: rolesPath },
      ],
    };
    backupCompleted = true;
    return result;
  } catch (error) {
    if (transactionOpen && source) await source.query("ROLLBACK").catch(() => undefined);
    const recoveryPaths: string[] = [];
    for (const path of [dumpPath, rolesPath]) {
      try { deps.removePath(path); }
      catch { if (existsSync(path)) recoveryPaths.push(path); }
    }
    if (recoveryPaths.length > 0) {
      const original = error instanceof PostgresNativeDrError ? error.code : "POSTGRES_NATIVE_BACKUP_FAILED";
      primaryFailure = new PostgresNativeDrError(
        "BACKUP_CLEANUP_FAILED",
        `PostgreSQL native backup failed after ${original} and confidential staging files could not be removed`,
        { recoveryPaths, causeCode: original },
      );
      throw primaryFailure;
    }
    if (error instanceof PostgresNativeDrError) primaryFailure = error;
    throw error;
  } finally {
    if (lockHeld && source) await source.query("SELECT pg_catalog.pg_advisory_unlock($1)", [NATIVE_DR_ADVISORY_LOCK_KEY]).catch(() => undefined);
    await postInventoryClient?.end().catch(() => undefined);
    await source?.end().catch(() => undefined);
    try { deps.removePath(libpqDirectory); }
    catch {
      if (existsSync(libpqDirectory)) {
        const recoveryPaths = [libpqDirectory, dumpPath, rolesPath].filter(existsSync);
        throw new PostgresNativeDrError(
          "CREDENTIAL_CLEANUP_FAILED",
          `PostgreSQL native backup ${backupCompleted ? "completed" : "failed"}, but its credential directory could not be removed`,
          { recoveryPaths, causeCode: primaryFailure?.code },
        );
      }
    }
  }
}

function validatePostgresNativeDrSchema(value: PostgresNativeDrSchema): PostgresNativeDrSchema {
  assertRecord(value, "PostgreSQL native DR schema");
  exactKeys(value, [
    "databaseName", "serverVersionNum", "serverMajor", "schemaVersion", "migrations",
    "tableCounts", "excludedDataTables", "claimedDeliveryCount", "pgDumpVersion", "roleInventorySha256",
    "readinessAttestations",
  ], "PostgreSQL native DR schema");
  if (typeof value.databaseName !== "string" || !ROLE_NAME.test(value.databaseName)) throw new PostgresNativeDrError("INVALID_MANIFEST", "PostgreSQL database name is invalid");
  if (!Number.isSafeInteger(value.serverVersionNum) || serverMajor(value.serverVersionNum) !== value.serverMajor) throw new PostgresNativeDrError("INVALID_MANIFEST", "PostgreSQL server version is inconsistent");
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) throw new PostgresNativeDrError("INVALID_MANIFEST", "PostgreSQL schema version is invalid");
  if (!Array.isArray(value.migrations) || value.migrations.length === 0) throw new PostgresNativeDrError("INVALID_MANIFEST", "PostgreSQL migrations are missing");
  let previous = 0;
  for (const migration of value.migrations) {
    assertRecord(migration, "PostgreSQL migration");
    exactKeys(migration, ["version", "name", "checksum"], "PostgreSQL migration");
    if (!Number.isSafeInteger(migration.version) || migration.version <= previous
      || !/^[a-z0-9_]+$/u.test(migration.name) || !/^[0-9a-f]{64}$/u.test(migration.checksum)) {
      throw new PostgresNativeDrError("INVALID_MANIFEST", "PostgreSQL migration inventory is invalid");
    }
    previous = migration.version;
  }
  if (previous !== value.schemaVersion) throw new PostgresNativeDrError("INVALID_MANIFEST", "PostgreSQL schema version does not match migrations");
  assertRecord(value.tableCounts, "PostgreSQL table counts");
  for (const [table, count] of Object.entries(value.tableCounts)) {
    if (!/^agent_bridge\.[a-z][a-z0-9_]*$/u.test(table) || typeof count !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(count)) {
      throw new PostgresNativeDrError("INVALID_MANIFEST", "PostgreSQL table count inventory is invalid");
    }
  }
  const excludedDataTables = excludedDataTablesForSchemaVersion(value.schemaVersion);
  for (const table of ["agent_bridge.deliveries", "agent_bridge.delivery_events", ...excludedDataTables]) {
    if (!(table in value.tableCounts)) throw new PostgresNativeDrError("INVALID_MANIFEST", `PostgreSQL table count is missing for ${table}`);
  }
  if (JSON.stringify(value.excludedDataTables) !== JSON.stringify(excludedDataTables)) {
    throw new PostgresNativeDrError("INVALID_MANIFEST", "PostgreSQL excluded table inventory is invalid");
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value.claimedDeliveryCount)) throw new PostgresNativeDrError("INVALID_MANIFEST", "PostgreSQL claimed delivery count is invalid");
  if (!/^[0-9a-f]{64}$/u.test(value.roleInventorySha256)) throw new PostgresNativeDrError("INVALID_MANIFEST", "PostgreSQL role inventory digest is invalid");
  assertRecord(value.readinessAttestations, "PostgreSQL readiness attestations");
  exactKeys(value.readinessAttestations, [
    "securitySchemaSha256", "rowIsolationSha256", "ownerControlSha256", "portableArchiveSha256",
  ], "PostgreSQL readiness attestations");
  for (const digest of Object.values(value.readinessAttestations)) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
      throw new PostgresNativeDrError("INVALID_MANIFEST", "PostgreSQL readiness attestation digest is invalid");
    }
  }
  if (parsePostgresToolMajor(value.pgDumpVersion) !== value.serverMajor) throw new PostgresNativeDrError("INVALID_MANIFEST", "PostgreSQL dump version does not match the source server");
  return value;
}

export async function verifyPostgresNativeDrArtifacts(
  options: VerifyPostgresNativeDrArtifactsOptions,
): Promise<VerifyPostgresNativeDrArtifactsResult> {
  const schema = validatePostgresNativeDrSchema(options.schema);
  const anchors = validateArtifactAnchors(options.artifactAnchors);
  const dumpPath = resolve(options.dumpPath);
  const rolesPath = resolve(options.rolesPath);
  if (anchors.roles.sha256 !== schema.roleInventorySha256) {
    throw new PostgresNativeDrError("ROLE_INVENTORY_DIGEST_MISMATCH", "PostgreSQL role inventory digest does not match the manifest");
  }
  const rolesText = readAnchoredArtifact(rolesPath, anchors.roles, 1024 * 1024).toString("utf8");
  let parsedRoles: unknown;
  try { parsedRoles = JSON.parse(rolesText); }
  catch { throw new PostgresNativeDrError("ROLE_INVENTORY_INVALID", "PostgreSQL role inventory is not valid JSON"); }
  const roleInventory = validatePostgresRoleInventory(parsedRoles);
  if (canonicalPostgresRoleInventory(roleInventory) !== rolesText) {
    throw new PostgresNativeDrError("ROLE_INVENTORY_NOT_CANONICAL", "PostgreSQL role inventory is not in canonical form");
  }
  if (roleInventory.databaseName !== schema.databaseName) {
    throw new PostgresNativeDrError("DATABASE_NAME_MISMATCH", "PostgreSQL role inventory database does not match the manifest");
  }
  const deps = dependencies(options.dependencies);
  const environment = { LC_ALL: "C" };
  const pgRestore = deps.resolveTool("pg_restore", options.toolDirectory);
  const version = await deps.runTool(pgRestore, ["--version"], environment);
  assertToolSucceeded(version, "PG_RESTORE_VERSION_FAILED", "pg_restore --version");
  if (parsePostgresToolMajor(version.stdout) !== schema.serverMajor) {
    throw new PostgresNativeDrError("POSTGRES_TOOL_MAJOR_MISMATCH", "pg_restore must exactly match the backup server major");
  }
  const listed = await runToolWithAnchoredInput(dumpPath, anchors.dump, (descriptor) =>
    deps.runTool(pgRestore, buildPgRestoreListArgs(), environment, descriptor));
  assertToolSucceeded(listed, "PG_RESTORE_LIST_FAILED", "pg_restore --list");
  assertPostgresTocOutputComplete(listed);
  validatePostgresDumpToc(listed.stdout);
  schemaAclRestoreList(listed.stdout);
  return {
    schema,
    roleInventory,
    artifactAnchors: anchors,
    dumpTocVerified: true,
    dumpToc: listed.stdout,
  };
}

async function targetMetadata(client: PostgresDrClient): Promise<{
  databaseName: string;
  serverVersionNum: number;
  schemaExists: boolean;
  databaseFresh: boolean;
}> {
  const result = await client.query<{
    databaseName: string;
    serverVersionNum: string;
    schemaExists: boolean;
    databaseFresh: boolean;
  }>(`
    SELECT current_database() AS "databaseName",
      current_setting('server_version_num') AS "serverVersionNum",
      pg_catalog.to_regnamespace('agent_bridge') IS NOT NULL AS "schemaExists",
      NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_namespace namespace
        WHERE namespace.nspname NOT IN ('pg_catalog','information_schema','pg_toast','public')
          AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
          AND namespace.nspname NOT LIKE 'pg_temp_%'
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class class
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=class.relnamespace
        WHERE namespace.nspname='public'
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc procedure
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=procedure.pronamespace
        WHERE namespace.nspname='public'
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_type type
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=type.typnamespace
        WHERE namespace.nspname='public' AND type.typtype<>'p'
      ) AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl) AS "databaseFresh"`);
  const row = result.rows[0];
  if (!row) throw new PostgresNativeDrError("TARGET_METADATA_INVALID", "target database metadata is unavailable");
  return {
    databaseName: row.databaseName,
    serverVersionNum: Number(row.serverVersionNum),
    schemaExists: row.schemaExists,
    databaseFresh: row.databaseFresh,
  };
}

async function targetTableCounts(client: PostgresDrClient): Promise<Record<string, string>> {
  const tableRows = await client.query<{ tableName: string }>(`
    SELECT table_name AS "tableName" FROM information_schema.tables
    WHERE table_schema='agent_bridge' AND table_type='BASE TABLE' ORDER BY table_name`);
  const counts: Record<string, string> = {};
  for (const row of tableRows.rows) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_bridge.${quoteSqlIdentifier(row.tableName)}`,
    );
    counts[`agent_bridge.${row.tableName}`] = result.rows[0]?.count ?? "";
  }
  return counts;
}

function expectedRestoredTableCounts(schema: PostgresNativeDrSchema): Record<string, string> {
  const expected = { ...schema.tableCounts };
  for (const table of excludedDataTablesForSchemaVersion(schema.schemaVersion)) expected[table] = "0";
  const deliveryEvents = expected["agent_bridge.delivery_events"];
  if (deliveryEvents === undefined) throw new PostgresNativeDrError("INVALID_MANIFEST", "PostgreSQL delivery event count is missing");
  expected["agent_bridge.delivery_events"] = (BigInt(deliveryEvents) + BigInt(schema.claimedDeliveryCount)).toString();
  return expected;
}

function compareStringMaps(actual: Record<string, string>, expected: Record<string, string>, label: string): void {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) throw new PostgresNativeDrError("RESTORE_COUNT_MISMATCH", `${label} table set does not match the backup`);
  for (const key of expectedKeys) {
    if (actual[key] !== expected[key]) throw new PostgresNativeDrError("RESTORE_COUNT_MISMATCH", `${label} count does not match for ${key}`);
  }
}

function administrativeDatabaseUrl(targetUrl: string, targetDatabase: string): string {
  const url = new URL(targetUrl);
  url.pathname = `/${targetDatabase === "postgres" ? "template1" : "postgres"}`;
  return url.toString();
}

export async function assertPostgresRestoreAuthority(client: PostgresDrClient): Promise<void> {
  const result = await client.query<{ isSuperuser: boolean }>(`
    SELECT role.rolsuper AS "isSuperuser"
    FROM pg_catalog.pg_roles role
    WHERE role.rolname=current_user`);
  const authority = result.rows[0];
  if (!authority?.isSuperuser) {
    throw new PostgresNativeDrError(
      "TARGET_AUTHORITY_INSUFFICIENT",
      "PostgreSQL native restore v1 requires a superuser DBA authority",
    );
  }
}

async function markTargetOffline(client: PostgresDrClient, databaseName: string): Promise<boolean> {
  try {
    await client.query(`ALTER DATABASE ${quoteSqlIdentifier(databaseName)} WITH ALLOW_CONNECTIONS false`);
    await client.query(`SELECT pg_catalog.pg_terminate_backend(pid)
      FROM pg_catalog.pg_stat_activity WHERE datname=$1`, [databaseName]);
    return true;
  } catch {
    return false;
  }
}

async function restorePostgresNativeDrInternal(options: RestorePostgresNativeDrOptions): Promise<RestorePostgresNativeDrResult> {
  if (options.acceptSourceSqlRisk !== true) {
    throw new PostgresNativeDrError("SOURCE_SQL_RISK_NOT_ACCEPTED", "PostgreSQL native restore requires explicit acceptance of source SQL risk");
  }
  const schema = validatePostgresNativeDrSchema(options.schema);
  const env = options.environment ?? process.env;
  const targetUrl = requiredEnvironmentUrl(env, "AGENT_BRIDGE_DR_TARGET_DATABASE_URL");
  const dumpPath = resolve(options.dumpPath);
  const rolesPath = resolve(options.rolesPath);
  const deps = dependencies(options.dependencies);
  const verifiedArtifacts = await verifyPostgresNativeDrArtifacts({
    dumpPath,
    rolesPath,
    schema,
    artifactAnchors: options.artifactAnchors,
    toolDirectory: options.toolDirectory,
    dependencies: deps,
  });
  const inventory = verifiedArtifacts.roleInventory;
  const libpqParent = resolve(rolesPath, "..");
  verifyPrivatePathAccess(libpqParent, "directory");
  const libpqDirectory = mkdtempSync(join(libpqParent, ".postgres-dr-libpq-"));
  securePrivatePath(libpqDirectory, "directory");
  verifyPrivatePathAccess(libpqDirectory, "directory");
  let target: PostgresDrClient | undefined;
  let admin: PostgresDrClient | undefined;
  let transactionOpen = false;
  const createdRoles: string[] = [];
  let targetName = schema.databaseName;
  let restoreStarted = false;
  let restoreLockHeld = false;
  let restoreCompleted = false;
  let primaryFailure: PostgresNativeDrError | undefined;
  let phase = "target preflight";
  try {
    const libpq = createPostgresDrLibpqFiles(targetUrl, libpqDirectory);
    target = deps.createClient(targetUrl);
    await target.connect();
    const restoreLock = await target.query<{ acquired: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_lock($1) AS acquired",
      [NATIVE_DR_ADVISORY_LOCK_KEY],
    );
    if (!restoreLock.rows[0]?.acquired) throw new PostgresNativeDrError("RESTORE_IN_PROGRESS", "another native restore already holds the target fence");
    restoreLockHeld = true;
    const metadata = await targetMetadata(target);
    targetName = metadata.databaseName;
    const major = serverMajor(metadata.serverVersionNum);
    if (metadata.databaseName !== schema.databaseName) throw new PostgresNativeDrError("DATABASE_NAME_MISMATCH", "target database name must exactly match the backup");
    if (major !== schema.serverMajor) throw new PostgresNativeDrError("SERVER_MAJOR_MISMATCH", "target PostgreSQL major must exactly match the backup");
    if (metadata.schemaExists || !metadata.databaseFresh) {
      throw new PostgresNativeDrError("TARGET_NOT_FRESH", "target must be a dedicated fresh database without user objects or default ACLs");
    }
    const conflicts = await target.query<{ name: string }>(
      `SELECT rolname AS name FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`,
      [inventory.roles.map((role) => role.name)],
    );
    if (conflicts.rows.length > 0) throw new PostgresNativeDrError("TARGET_ROLE_CONFLICT", "target contains a role required by the backup");
    await assertPostgresRestoreAuthority(target);
    admin = deps.createClient(administrativeDatabaseUrl(targetUrl, metadata.databaseName));
    await admin.connect();
    const pgRestore = deps.resolveTool("pg_restore", options.toolDirectory);
    const schemaAclListPath = join(libpqDirectory, "schema-acl.list");
    writeFileSync(schemaAclListPath, schemaAclRestoreList(verifiedArtifacts.dumpToc), { encoding: "utf8", mode: 0o600, flag: "wx" });
    securePrivatePath(schemaAclListPath, "file");
    verifyPrivatePathAccess(schemaAclListPath, "file");
    for (const [index, statement] of buildPostgresRoleShellStatements(inventory).entries()) {
      phase = "role shell creation";
      restoreStarted = true;
      await target.query(statement);
      createdRoles.push(inventory.roles[index]!.name);
    }
    const schemaOwner = inventory.roles.find((role) => role.kind === "schema-owner")!;
    phase = "schema creation";
    await target.query(`CREATE SCHEMA agent_bridge AUTHORIZATION ${quoteIdentifier(schemaOwner.name)}`);
    phase = "schema ACL restore";
    const schemaAclRestore = await runToolWithAnchoredInput(
      dumpPath,
      verifiedArtifacts.artifactAnchors.dump,
      (descriptor) => deps.runTool(
        pgRestore,
        buildPgRestoreSchemaAclArgs(undefined, schemaAclListPath, libpq.serviceName),
        libpq.environment,
        descriptor,
      ),
    );
    assertToolSucceeded(schemaAclRestore, "PG_SCHEMA_ACL_RESTORE_FAILED", "pg_restore schema ACL");
    phase = "pg_restore";
    const restored = await runToolWithAnchoredInput(
      dumpPath,
      verifiedArtifacts.artifactAnchors.dump,
      (descriptor) => deps.runTool(
        pgRestore,
        buildPgRestoreArgs(undefined, libpq.serviceName),
        libpq.environment,
        descriptor,
      ),
    );
    assertToolSucceeded(restored, "PG_RESTORE_FAILED", "pg_restore");
    await target.query("BEGIN");
    transactionOpen = true;
    phase = "membership restore";
    for (const statement of buildPostgresMembershipStatements(inventory, major)) await target.query(statement);
    phase = "default privilege restore";
    for (const statement of buildPostgresDefaultPrivilegeStatements(inventory)) await target.query(statement);
    phase = "claim normalization";
    const normalized = await target.query<{ count: string }>(`
      WITH changed AS (
        UPDATE agent_bridge.deliveries SET state='retrying', lease_token=NULL, lease_owner=NULL,
          lease_expires_at=NULL, available_at=pg_catalog.now(),
          last_error='lease invalidated by native restore', last_actor='agent-bridge', last_action='lease_expired'
        WHERE state='claimed' RETURNING 1
      ) SELECT count(*)::text AS count FROM changed`);
    const normalizedCount = normalized.rows[0]?.count;
    if (normalizedCount !== schema.claimedDeliveryCount) throw new PostgresNativeDrError("CLAIM_NORMALIZATION_MISMATCH", "restored claimed delivery count does not match the backup");
    phase = "migration validation";
    const migrationRows = await target.query<{ version: number | string; name: string; checksum: string }>(
      `SELECT version,name,checksum FROM agent_bridge.schema_migrations ORDER BY version`,
    );
    const migrations = migrationRows.rows.map((row) => ({ version: Number(row.version), name: row.name, checksum: row.checksum }));
    if (migrations.length !== schema.migrations.length || migrations.some((migration, index) => {
      const expected = schema.migrations[index];
      return expected === undefined || migration.version !== expected.version
        || migration.name !== expected.name || migration.checksum !== expected.checksum;
    })) {
      throw new PostgresNativeDrError("RESTORE_MIGRATION_MISMATCH", "restored migrations do not match the backup");
    }
    phase = "table count validation";
    const counts = await targetTableCounts(target);
    compareStringMaps(counts, expectedRestoredTableCounts(schema), "restored PostgreSQL");
    phase = "readiness validation";
    const readiness = await target.query<{
      security: boolean;
      ownerControl: boolean;
      portableArchive: boolean;
      securityDefinition: string;
      rowIsolationDefinition: string;
      ownerControlDefinition: string;
      portableArchiveDefinition: string;
    }>(`
      SELECT agent_bridge.security_schema_ready() AS security,
        agent_bridge.owner_control_plane_ready() AS "ownerControl",
        agent_bridge.portable_archive_ready() AS "portableArchive",
        agent_bridge.credential_security_prerequisite_definition() AS "securityDefinition",
        agent_bridge.row_isolation_catalog_definition() AS "rowIsolationDefinition",
        agent_bridge.owner_control_attestation_definition() AS "ownerControlDefinition",
        agent_bridge.portable_archive_attestation_definition() AS "portableArchiveDefinition"`);
    const ready = readiness.rows[0];
    const restoredRowReady = await deps.checkRowIsolationReady(target);
    const restoredGatewayAuthorityReady = await gatewayAuthorityReady(target, schema.schemaVersion);
    const failedReadiness = [
      !ready?.security ? "security" : undefined,
      !restoredRowReady ? "row-isolation" : undefined,
      !ready?.ownerControl ? "owner-control" : undefined,
      !ready?.portableArchive ? "portable-archive" : undefined,
      !restoredGatewayAuthorityReady ? "gateway-authority" : undefined,
    ].filter(Boolean);
    if (failedReadiness.length > 0) {
      throw new PostgresNativeDrError("RESTORE_NOT_READY", `restored PostgreSQL schema failed readiness attestation: ${failedReadiness.join(", ")}`);
    }
    const restoredAttestations = {
      securitySchemaSha256: sha256(ready!.securityDefinition),
      rowIsolationSha256: sha256(ready!.rowIsolationDefinition),
      ownerControlSha256: sha256(ready!.ownerControlDefinition),
      portableArchiveSha256: sha256(ready!.portableArchiveDefinition),
    };
    const attestationKeys = [
      "securitySchemaSha256", "rowIsolationSha256", "ownerControlSha256", "portableArchiveSha256",
    ] as const;
    if (attestationKeys.some((key) => restoredAttestations[key] !== schema.readinessAttestations[key])) {
      throw new PostgresNativeDrError("RESTORE_ATTESTATION_MISMATCH", "restored PostgreSQL readiness attestations do not match the backup");
    }
    const externalRoles = inventory.roles.filter((role) => role.kind === "external-principal").map((role) => role.name);
    if (externalRoles.length > 0) {
      const loginRoles = await target.query<{ name: string }>(
        `SELECT rolname AS name FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[]) AND rolcanlogin ORDER BY rolname`,
        [externalRoles],
      );
      if (loginRoles.rows.length > 0) throw new PostgresNativeDrError("EXTERNAL_ROLE_CAN_LOGIN", "restored external principals must remain NOLOGIN");
    }
    await target.query("COMMIT");
    transactionOpen = false;
    const result: RestorePostgresNativeDrResult = {
      databaseName: metadata.databaseName,
      normalizedClaimedDeliveries: normalizedCount,
      tableCounts: counts,
      readiness: { security: true, rowIsolation: true, ownerControl: true, portableArchive: true },
    };
    restoreCompleted = true;
    return result;
  } catch (error) {
    if (transactionOpen && target) await target.query("ROLLBACK").catch(() => undefined);
    const targetOffline = restoreStarted && admin ? await markTargetOffline(admin, targetName) : false;
    const original = error instanceof PostgresNativeDrError ? error : undefined;
    if (restoreStarted && !targetOffline) {
      primaryFailure = new PostgresNativeDrError(
        "TARGET_OFFLINE_FAILED",
        `PostgreSQL native restore failed and the target could not be forced offline${original ? ` after ${original.code}` : ""}`,
        {
          residualRoleShells: createdRoles,
          targetOffline: false,
          targetMutated: restoreStarted,
          restoreCompleted: false,
        },
      );
      throw primaryFailure;
    }
    primaryFailure = new PostgresNativeDrError(
      original?.code ?? "POSTGRES_NATIVE_RESTORE_FAILED",
      original?.message ?? `PostgreSQL native restore failed during ${phase}: ${sanitizedUnexpectedError(error, targetUrl)}`,
      {
        residualRoleShells: createdRoles,
        targetOffline,
        targetMutated: restoreStarted,
        restoreCompleted: false,
      },
    );
    throw primaryFailure;
  } finally {
    if (restoreLockHeld && target) {
      await target.query("SELECT pg_catalog.pg_advisory_unlock($1)", [NATIVE_DR_ADVISORY_LOCK_KEY]).catch(() => undefined);
    }
    await target?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    try { deps.removePath(libpqDirectory); }
    catch {
      if (existsSync(libpqDirectory)) {
        throw new PostgresNativeDrError(
          "CREDENTIAL_CLEANUP_FAILED",
          `PostgreSQL native restore ${restoreCompleted ? "completed" : "failed"}, but its credential directory could not be removed`,
          {
            residualRoleShells: primaryFailure?.details.residualRoleShells,
            targetOffline: primaryFailure?.details.targetOffline,
            targetMutated: restoreStarted,
            restoreCompleted,
            recoveryPaths: [libpqDirectory],
            causeCode: primaryFailure?.code,
          },
        );
      }
    }
  }
}

export async function restorePostgresNativeDr(options: RestorePostgresNativeDrOptions): Promise<RestorePostgresNativeDrResult> {
  try {
    return await restorePostgresNativeDrInternal(options);
  } catch (error) {
    if (error instanceof PostgresNativeDrError) {
      if (typeof error.details.targetMutated === "boolean" && typeof error.details.restoreCompleted === "boolean") {
        throw error;
      }
      throw new PostgresNativeDrError(error.code, error.message, {
        ...error.details,
        targetMutated: false,
        restoreCompleted: false,
      });
    }
    throw new PostgresNativeDrError(
      "POSTGRES_NATIVE_RESTORE_FAILED",
      "PostgreSQL native restore failed before target mutation",
      { targetMutated: false, restoreCompleted: false },
    );
  }
}
