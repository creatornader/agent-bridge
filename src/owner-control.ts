import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import {
  canonicalGatewayUrl,
  canonicalTimestamp,
  acquireEnrollmentLock,
  createPendingEnrollment,
  defaultEnrollmentPath,
  enrollmentTokenHash,
  readEnrollment,
  recoverEnrollmentLock,
  releaseEnrollmentLock,
  transitionEnrollment,
  type EnrollmentLock,
  type EnrollmentFile,
  type EnrollmentInput,
  type EnrollmentResult,
} from "./enrollment-file.js";

export type OwnerOptionValue = string | boolean | undefined;
export type OwnerOptions = Record<string, OwnerOptionValue>;
type Queryable = Pick<pg.Pool, "query">;

class OwnerDatabaseFailure extends Error {
  constructor(readonly driverCode: string) {
    super("owner database operation failed");
  }
}

async function ownerQuery<T extends pg.QueryResultRow>(
  db: Queryable,
  sql: string,
  values: unknown[],
): Promise<pg.QueryResult<T>> {
  try {
    return await db.query<T>(sql, values);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    throw new OwnerDatabaseFailure(code);
  }
}

export interface OwnerDependencies {
  connect(databaseUrl: string): { db: Queryable; close(): Promise<void> };
  now(): Date;
  requestId(): string;
  token(): string;
  instance(runtime: EnrollmentInput["runtime"]): string;
}

const defaultDependencies: OwnerDependencies = {
  connect(databaseUrl) {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 10_000,
      query_timeout: 30_000,
    });
    return { db: pool, close: () => pool.end() };
  },
  now: () => new Date(),
  requestId: () => randomUUID(),
  token: () => randomBytes(32).toString("base64url"),
  instance: (runtime) => runtime + "-" + randomUUID(),
};

function stringOption(options: OwnerOptions, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function required(options: OwnerOptions, name: string): string {
  const value = stringOption(options, name);
  if (!value) throw new Error("--" + name + " is required");
  return value;
}

function selectWithEnvironment(
  options: OwnerOptions,
  name: string,
  env: NodeJS.ProcessEnv,
  environmentName: string,
  requiredValue: boolean,
): string | undefined {
  const explicit = stringOption(options, name);
  const environment = env[environmentName]?.trim() || undefined;
  if (explicit && environment && explicit !== environment) {
    throw new Error("--" + name + " conflicts with " + environmentName);
  }
  const selected = explicit ?? environment;
  if (requiredValue && !selected) {
    throw new Error("--" + name + " or " + environmentName + " is required");
  }
  return selected;
}

function timestamp(options: OwnerOptions, name: string): string | null {
  const value = stringOption(options, name) ?? null;
  return canonicalTimestamp(value, "--" + name);
}

function installRuntime(options: OwnerOptions): EnrollmentInput["runtime"] {
  const value = required(options, "runtime");
  if (value !== "codex" && value !== "claude-code" && value !== "claude-desktop") {
    throw new Error("--runtime must be codex, claude-code, or claude-desktop");
  }
  return value;
}

function scopeSet(options: OwnerOptions): string {
  const value = required(options, "scope-set");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error("--scope-set is invalid");
  return value;
}

function uuidValue(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(label + " must be a UUID");
  }
  return value;
}

function uuidOption(options: OwnerOptions, name: string): string {
  return uuidValue(required(options, name), "--" + name);
}

const OWNER_OPTIONS: Record<string, ReadonlySet<string>> = {
  provision: new Set([
    "workspace", "workspace-name", "identity", "runtime", "instance", "gateway-url",
    "scope-set", "display-name", "runtime-type", "label", "expires-at", "request-id",
    "enrollment-file", "recover-lock",
  ]),
  rotate: new Set([
    "workspace", "identity", "runtime", "instance", "gateway-url", "scope-set",
    "runtime-type", "label", "expires-at", "grace-until", "invalidate-immediately",
    "credential-id", "request-id", "enrollment-file", "recover-lock",
  ]),
  inventory: new Set(["workspace", "cursor", "limit"]),
  revoke: new Set(["credential-id", "reason", "request-id"]),
};

function validateOwnerOptions(subcommand: string, options: OwnerOptions): void {
  if (stringOption(options, "resume")) {
    const override = Object.keys(options).find((key) => key !== "resume" && key !== "recover-lock");
    if (override) throw new Error("--" + override + " cannot be used with --resume");
    if (subcommand !== "provision" && subcommand !== "rotate") {
      throw new Error("--resume is valid only for provision or rotate");
    }
    return;
  }
  const allowed = OWNER_OPTIONS[subcommand];
  const invalid = Object.keys(options).find((key) => !allowed?.has(key));
  if (invalid) throw new Error("--" + invalid + " is not valid for owner " + subcommand);
}

function requestId(options: OwnerOptions, dependencies: OwnerDependencies): string {
  return stringOption(options, "request-id") ? uuidOption(options, "request-id") : dependencies.requestId();
}

function initialEnrollment(
  operation: "provision" | "rotate",
  options: OwnerOptions,
  env: NodeJS.ProcessEnv,
  dependencies: OwnerDependencies,
): { path: string; enrollment: EnrollmentFile } {
  const request = requestId(options, dependencies);
  const runtime = installRuntime(options);
  const gatewayUrl = canonicalGatewayUrl(
    selectWithEnvironment(options, "gateway-url", env, "AGENT_BRIDGE_URL", true),
    "--gateway-url",
  );
  const workspaceId = required(options, "workspace");
  const principal = required(options, "identity");
  const explicitInstance = stringOption(options, "instance");
  const instance = operation === "rotate"
    ? explicitInstance ?? (() => { throw new Error("--instance is required for rotation"); })()
    : explicitInstance ?? dependencies.instance(runtime);
  const graceUntil = timestamp(options, "grace-until");
  const invalidateImmediately = options["invalidate-immediately"] === true
    || options["invalidate-immediately"] === "true";
  if (operation === "rotate" && (graceUntil === null) === !invalidateImmediately) {
    throw new Error("rotation requires exactly one of --grace-until or --invalidate-immediately");
  }
  if (operation === "provision" && (graceUntil !== null || invalidateImmediately)) {
    throw new Error("provision does not accept rotation invalidation options");
  }
  const input: EnrollmentInput = {
    gatewayUrl,
    workspaceId,
    principal,
    runtime,
    instance,
    credentialId: operation === "rotate" ? uuidOption(options, "credential-id") : null,
    workspaceName: operation === "provision" ? required(options, "workspace-name") : null,
    displayName: stringOption(options, "display-name") ?? null,
    runtimeType: stringOption(options, "runtime-type") ?? runtime,
    label: stringOption(options, "label") ?? null,
    scopeSetName: scopeSet(options),
    expiresAt: timestamp(options, "expires-at"),
    graceUntil,
    invalidateImmediately,
  };
  if (operation === "rotate" && input.displayName !== null) {
    throw new Error("rotate does not accept --display-name");
  }
  const enrollment: EnrollmentFile = {
    schema: "agent-bridge.enrollment",
    version: 1,
    provider: "gateway",
    revision: 0,
    state: "pending",
    operation,
    requestId: request,
    createdAt: dependencies.now().toISOString(),
    completedAt: null,
    input,
    token: dependencies.token(),
    result: null,
  };
  const path = stringOption(options, "enrollment-file") ?? defaultEnrollmentPath(request, env);
  createPendingEnrollment(path, enrollment, env);
  return { path, enrollment };
}

function enrollment(
  operation: "provision" | "rotate",
  options: OwnerOptions,
  env: NodeJS.ProcessEnv,
  dependencies: OwnerDependencies,
): { path: string; enrollment: EnrollmentFile } {
  const resume = stringOption(options, "resume");
  if (!resume) return initialEnrollment(operation, options, env, dependencies);
  const loaded = readEnrollment(resume, env);
  if (loaded.operation !== operation) {
    throw new Error("enrollment operation is " + loaded.operation + ", not " + operation);
  }
  return { path: resume, enrollment: loaded };
}

function publicEnrollment(path: string, enrollment: EnrollmentFile): Record<string, unknown> {
  if (!enrollment.result) throw new Error("enrollment has no completed result");
  return {
    schemaVersion: 1,
    status: "ok",
    operation: enrollment.operation,
    requestId: enrollment.requestId,
    enrollmentFile: path,
    enrollmentState: enrollment.state,
    ...enrollment.result,
  };
}

async function runProvision(
  db: Queryable,
  path: string,
  enrollment: EnrollmentFile,
  completedAt: string,
  env: NodeJS.ProcessEnv,
  lock: EnrollmentLock,
): Promise<Record<string, unknown>> {
  if (enrollment.state !== "pending") return publicEnrollment(path, enrollment);
  const input = enrollment.input;
  const response = await ownerQuery<{
    workspace_id: string; agent_id: string; credential_id: string; replayed: boolean;
  }>(
    db,
    "SELECT * FROM agent_bridge.control_provision(" +
      "$1::uuid,$2::text,$3::text,$4::text,$5::text,$6::text,$7::char(64)," +
      "$8::text,$9::text,$10::timestamptz)",
    [enrollment.requestId, input.workspaceId, input.workspaceName, input.principal,
      input.displayName, input.runtimeType, enrollmentTokenHash(enrollment),
      input.label, input.scopeSetName, input.expiresAt],
  );
  const row = response.rows[0];
  if (!row) throw new Error("owner provision returned no result");
  const result: EnrollmentResult = {
    workspaceId: row.workspace_id,
    principal: input.principal,
    agentId: row.agent_id,
    credentialId: row.credential_id,
    replayed: row.replayed,
  };
  const ready = transitionEnrollment(path, enrollment, "ready", { completedAt, result }, env, lock);
  return publicEnrollment(path, ready);
}

async function runRotate(
  db: Queryable,
  path: string,
  enrollment: EnrollmentFile,
  completedAt: string,
  env: NodeJS.ProcessEnv,
  lock: EnrollmentLock,
): Promise<Record<string, unknown>> {
  if (enrollment.state !== "pending") return publicEnrollment(path, enrollment);
  const input = enrollment.input;
  const response = await ownerQuery<{
    credential_id: string; workspace_id: string; principal: string; replayed: boolean;
  }>(
    db,
    "SELECT * FROM agent_bridge.control_rotate_credential(" +
      "$1::uuid,$2::uuid,$3::text,$4::text,$5::char(64),$6::text,$7::text," +
      "$8::timestamptz,$9::timestamptz)",
    [enrollment.requestId, input.credentialId, input.workspaceId, input.principal,
      enrollmentTokenHash(enrollment), input.label, input.scopeSetName,
      input.expiresAt, input.graceUntil],
  );
  const row = response.rows[0];
  if (!row) throw new Error("owner rotation returned no result");
  const result: EnrollmentResult = {
    workspaceId: row.workspace_id,
    principal: row.principal,
    agentId: null,
    credentialId: row.credential_id,
    replayed: row.replayed,
  };
  const ready = transitionEnrollment(path, enrollment, "ready", { completedAt, result }, env, lock);
  return publicEnrollment(path, ready);
}

interface InventoryCursor {
  v: 1;
  workspace: string | null;
  createdAt: string;
  credentialId: string;
}

function decodeCursor(raw: string | undefined, workspace: string | null): InventoryCursor | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
  catch { throw new Error("--cursor is not a valid owner inventory cursor"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--cursor is not a valid owner inventory cursor");
  }
  const cursor = parsed as Record<string, unknown>;
  if (cursor.v !== 1 || cursor.workspace !== workspace
    || typeof cursor.createdAt !== "string"
    || typeof cursor.credentialId !== "string") {
    throw new Error("--cursor does not match this inventory request");
  }
  let createdAt: string | null;
  try { createdAt = canonicalTimestamp(cursor.createdAt, "inventory cursor createdAt"); }
  catch { throw new Error("--cursor is not a valid owner inventory cursor"); }
  if (createdAt === null) throw new Error("--cursor is not a valid owner inventory cursor");
  let credentialId: string;
  try { credentialId = uuidValue(cursor.credentialId, "inventory cursor credentialId"); }
  catch { throw new Error("--cursor is not a valid owner inventory cursor"); }
  return { v: 1, workspace, createdAt, credentialId };
}

function encodeCursor(cursor: InventoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function instant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

async function runInventory(db: Queryable, options: OwnerOptions): Promise<Record<string, unknown>> {
  const rawLimit = stringOption(options, "limit");
  const limit = rawLimit === undefined ? 100 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("--limit must be an integer between 1 and 1000");
  }
  const workspace = stringOption(options, "workspace") ?? null;
  const cursor = decodeCursor(stringOption(options, "cursor"), workspace);
  const response = await ownerQuery<Record<string, unknown>>(
    db,
    "SELECT * FROM agent_bridge.control_credential_inventory(" +
      "$1::text,$2::timestamptz,$3::uuid,$4::integer)",
    [workspace, cursor?.createdAt ?? null, cursor?.credentialId ?? null, limit],
  );
  const credentials = response.rows.map((row) => ({
    credentialId: row.credential_id,
    workspaceId: row.workspace_id,
    principal: row.principal,
    label: row.label,
    scopes: row.scopes,
    scopeSetName: row.scope_set_name,
    expiresAt: instant(row.expires_at),
    revokedAt: instant(row.revoked_at),
    revokedBy: row.revoked_by,
    revocationReason: row.revocation_reason,
    replacesCredentialId: row.replaces_credential_id,
    expiryGraceUntil: instant(row.expiry_grace_until),
    createdAt: instant(row.created_at),
    lastUsedAt: instant(row.last_used_at),
    agentDisabledAt: instant(row.agent_disabled_at),
    workspaceDisabledAt: instant(row.workspace_disabled_at),
  }));
  const last = credentials.length ? credentials[credentials.length - 1] : undefined;
  const nextCursor = credentials.length === limit && last?.createdAt
    ? encodeCursor({
        v: 1,
        workspace,
        createdAt: last.createdAt,
        credentialId: String(last.credentialId),
      })
    : null;
  return {
    schemaVersion: 1,
    status: "ok",
    operation: "inventory",
    items: credentials,
    page: { limit, nextCursor },
  };
}

async function runRevoke(
  db: Queryable,
  options: OwnerOptions,
  dependencies: OwnerDependencies,
): Promise<Record<string, unknown>> {
  const selectedRequestId = requestId(options, dependencies);
  const credentialId = uuidOption(options, "credential-id");
  const reason = stringOption(options, "reason") ?? "operator_request";
  if (!["operator_request", "rotation", "compromise", "retired"].includes(reason)) {
    throw new Error("--reason must be operator_request, rotation, compromise, or retired");
  }
  const response = await ownerQuery<{ revoked: boolean; replayed: boolean }>(
    db,
    "SELECT * FROM agent_bridge.control_revoke_credential($1::uuid,$2::uuid,$3::text)",
    [selectedRequestId, credentialId, reason],
  );
  const row = response.rows[0];
  if (!row) throw new Error("owner revoke returned no result");
  return {
    schemaVersion: 1,
    status: "ok",
    operation: "revoke",
    requestId: selectedRequestId,
    credentialId,
    revoked: row.revoked,
    replayed: row.replayed,
  };
}

export async function runOwnerCommand(
  subcommand: string | undefined,
  options: OwnerOptions,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: OwnerDependencies = defaultDependencies,
): Promise<Record<string, unknown>> {
  if (!subcommand || subcommand === "help") {
    if (Object.keys(options).length) throw new Error("owner help does not accept options");
    return {
      command: "agent-bridge owner",
      subcommands: ["provision", "inventory", "rotate", "revoke"],
      authority: "AGENT_BRIDGE_OPERATOR_DATABASE_URL",
    };
  }
  if (!["provision", "inventory", "rotate", "revoke"].includes(subcommand)) {
    throw new Error("unsupported owner command: " + subcommand);
  }
  validateOwnerOptions(subcommand, options);
  if (options["recover-lock"] === true && !stringOption(options, "resume")) {
    throw new Error("--recover-lock requires --resume");
  }
  const databaseUrl = env.AGENT_BRIDGE_OPERATOR_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("AGENT_BRIDGE_OPERATOR_DATABASE_URL is required");
  let connection: ReturnType<OwnerDependencies["connect"]>;
  try {
    connection = dependencies.connect(databaseUrl);
  } catch {
    throw new Error("owner database connection failed");
  }
  try {
    if (subcommand === "inventory") return await runInventory(connection.db, options);
    if (subcommand === "revoke") return await runRevoke(connection.db, options, dependencies);
    const mutation = subcommand as "provision" | "rotate";
    const selected = enrollment(mutation, options, env, dependencies);
    if (options["recover-lock"] === true) recoverEnrollmentLock(selected.path, env);
    const lock = acquireEnrollmentLock(selected.path, env);
    try {
      const current = readEnrollment(selected.path, env);
      if (current.operation !== mutation) {
        throw new Error("enrollment operation is " + current.operation + ", not " + mutation);
      }
      if (subcommand === "provision") {
        return await runProvision(
          connection.db, selected.path, current, dependencies.now().toISOString(), env, lock,
        );
      }
      return await runRotate(
        connection.db, selected.path, current, dependencies.now().toISOString(), env, lock,
      );
    } finally {
      releaseEnrollmentLock(lock);
    }
  } catch (error) {
    if (!(error instanceof OwnerDatabaseFailure)) throw error;
    const code = error.driverCode;
    if (code === "42501") throw new Error("owner database authorization denied");
    if (code === "23505") throw new Error("owner request conflicts with existing state");
    if (code === "22P02" || code === "22007" || code === "22023") {
      throw new Error("owner database rejected invalid input");
    }
    throw new Error("owner database operation failed");
  } finally {
    try {
      await connection.close();
    } catch {
      throw new Error("owner database close failed");
    }
  }
}
