import { fileURLToPath } from "node:url";
import { TLSSocket } from "node:tls";
import pg from "pg";
import { loadMigrationPlan, migrationRecordMatches, type AppliedMigration } from "./migrations.js";

const SUPPORTED_MAJORS = new Set([15, 16, 17, 18]);
const LEGACY_COLUMNS = new Map([
  ["id", "int8"],
  ["source", "text"],
  ["category", "text"],
  ["content", "text"],
  ["priority", "text"],
  ["project", "text"],
  ["metadata", "jsonb"],
  ["created_at", "timestamptz"],
  ["acked_by", "_text"],
]);

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface ProductionPreflightDatabase {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

interface AuthorityRow extends Record<string, unknown> {
  serverVersionNum: string;
  inRecovery: boolean;
  canLogin: boolean;
  inherits: boolean;
  isSuperuser: boolean;
  canCreateRole: boolean;
  bypassesRls: boolean;
  canCreateDatabaseObject: boolean;
  bridgeSchema: string | null;
  migrationTable: string | null;
  legacyTable: string | null;
  ssl: boolean;
  databaseBytes: string;
}

interface LegacyColumnRow extends Record<string, unknown> {
  columnName: string;
  typeName: string;
}

export interface PostgresProductionPreflightReport {
  schema: "agent-bridge-postgres-production-preflight-v1";
  ok: boolean;
  checks: Check[];
  observations: {
    serverMajor: number;
    databaseBytes: string;
    migrationState: "uninitialized" | "upgradeable" | "current" | "invalid";
    appliedMigrationCount: number;
    requiredMigrationCount: number;
    legacyTable: boolean;
    legacyRows?: string;
    ssl: boolean;
  };
}

function check(name: string, ok: boolean, detail: string): Check {
  return { name, ok, detail };
}

function migrationPrefix(
  applied: AppliedMigration[],
  expected: ReadonlyArray<AppliedMigration>,
): boolean {
  return applied.length <= expected.length && applied.every((entry, index) =>
    expected[index] !== undefined && migrationRecordMatches(entry, expected[index])
  );
}

async function legacyChecks(
  db: ProductionPreflightDatabase,
  checks: Check[],
): Promise<string | undefined> {
  const owner = await db.query<{ ownedByCaller: boolean }>(`
    SELECT relation.relowner=current_user::regrole::oid AS "ownedByCaller"
    FROM pg_catalog.pg_class relation
    WHERE relation.oid='public.shared_context'::regclass`);
  checks.push(check(
    "legacy.owner",
    owner.rows[0]?.ownedByCaller === true,
    "the migration authority owns public.shared_context",
  ));

  const columns = await db.query<LegacyColumnRow>(`
    SELECT column_name AS "columnName",udt_name AS "typeName"
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='shared_context'`);
  const actual = new Map(columns.rows.map((row) => [row.columnName, row.typeName]));
  const compatible = [...LEGACY_COLUMNS].every(([name, type]) => actual.get(name) === type);
  checks.push(check(
    "legacy.columns",
    compatible,
    "public.shared_context has the columns required by migration 006",
  ));

  if (!compatible) return undefined;
  const legacy = await db.query<{ rowCount: string; duplicateMessageIds: string }>(`
    WITH mapped AS (
      SELECT CASE
        WHEN metadata #>> '{message_envelope,message_id}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN lower(metadata #>> '{message_envelope,message_id}')
        ELSE 'legacy:' || id::text
      END AS message_id
      FROM public.shared_context
    )
    SELECT
      (SELECT count(*)::text FROM mapped) AS "rowCount",
      (SELECT count(*)::text FROM (
        SELECT message_id FROM mapped GROUP BY message_id HAVING count(*)>1
      ) duplicates) AS "duplicateMessageIds"`);
  const result = legacy.rows[0];
  const duplicates = result?.duplicateMessageIds ?? "unknown";
  checks.push(check(
    "legacy.message_ids",
    duplicates === "0",
    "legacy rows map to unique immutable message IDs",
  ));
  return result?.rowCount;
}

export async function runPostgresProductionPreflight(
  db: ProductionPreflightDatabase,
  migrationsDirectory: string,
  options: { requireSsl?: boolean; clientTransportSsl?: boolean } = {},
): Promise<PostgresProductionPreflightReport> {
  const expected = await loadMigrationPlan(migrationsDirectory);
  await db.query("BEGIN TRANSACTION READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout='15s'");
    await db.query("SET LOCAL lock_timeout='2s'");
    const authority = await db.query<AuthorityRow>(`
      SELECT
        current_setting('server_version_num') AS "serverVersionNum",
        pg_is_in_recovery() AS "inRecovery",
        role.rolcanlogin AS "canLogin",
        role.rolinherit AS inherits,
        role.rolsuper AS "isSuperuser",
        role.rolcreaterole AS "canCreateRole",
        role.rolbypassrls AS "bypassesRls",
        has_database_privilege(current_user,current_database(),'CREATE') AS "canCreateDatabaseObject",
        to_regnamespace('agent_bridge')::text AS "bridgeSchema",
        to_regclass('agent_bridge.schema_migrations')::text AS "migrationTable",
        to_regclass('public.shared_context')::text AS "legacyTable",
        coalesce((SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid()),false) AS ssl,
        pg_database_size(current_database())::text AS "databaseBytes"
      FROM pg_catalog.pg_roles role
      WHERE role.rolname=current_user`);
    const row = authority.rows[0];
    if (!row) throw new Error("current PostgreSQL role could not be inspected");

    const serverMajor = Math.floor(Number(row.serverVersionNum) / 10_000);
    const ssl = row.ssl || options.clientTransportSsl === true;
    const checks: Check[] = [
      check("postgres.version", SUPPORTED_MAJORS.has(serverMajor), "PostgreSQL major is supported"),
      check("postgres.primary", !row.inRecovery, "connection targets a writable primary"),
      check("authority.login", row.canLogin && row.inherits, "migration role can log in and inherits grants"),
      check("authority.database_create", row.canCreateDatabaseObject, "migration role can create database objects"),
      check("authority.roles", row.isSuperuser || row.canCreateRole, "migration role can administer restricted roles"),
      check(
        "authority.native_dr",
        row.isSuperuser || row.bypassesRls,
        "native DR source role can bypass row-level security",
      ),
      ...(options.requireSsl
        ? [check(
          "connection.ssl",
          ssl,
          row.ssl
            ? "PostgreSQL backend reports TLS"
            : options.clientTransportSsl
              ? "client transport uses TLS"
              : "connection does not use TLS",
        )]
        : []),
    ];

    let applied: AppliedMigration[] = [];
    if (row.migrationTable) {
      const result = await db.query<{ version: number; name: string; checksum: string }>(
        "SELECT version,name,checksum FROM agent_bridge.schema_migrations ORDER BY version",
      );
      applied = result.rows.map((entry) => ({
        version: Number(entry.version),
        name: entry.name,
        checksum: entry.checksum,
      }));
    }
    const prefix = migrationPrefix(applied, expected);
    const unmanagedSchema = Boolean(row.bridgeSchema) && (
      !row.migrationTable || applied.length === 0
    );
    const migrationState = unmanagedSchema || !prefix || (!row.bridgeSchema && Boolean(row.migrationTable))
      ? "invalid"
      : applied.length === expected.length
        ? "current"
        : applied.length === 0
          ? "uninitialized"
          : "upgradeable";
    checks.push(check(
      "schema.migrations",
      migrationState !== "invalid",
      migrationState === "invalid"
        ? "agent_bridge namespace or migration ledger conflicts with the release plan"
        : `migration state is ${migrationState}`,
    ));

    if (!row.bridgeSchema) {
      const collisions = await db.query<{ count: string }>(`
        WITH names(role_name) AS (VALUES
          ('agent_bridge_runtime_' || substr(md5(current_database()),1,16)),
          ('agent_bridge_data_owner_' || substr(md5(current_database()),1,16)),
          ('agent_bridge_context_reader_' || substr(md5(current_database()),1,16)),
          ('agent_bridge_event_writer_' || substr(md5(current_database()),1,16)),
          ('agent_bridge_control_owner_' || substr(md5(current_database()),1,16)),
          ('agent_bridge_control_operator_' || substr(md5(current_database()),1,16)),
          ('agent_bridge_control_auditor_' || substr(md5(current_database()),1,16)),
          ('agent_bridge_archive_operator_' || substr(md5(current_database()),1,16)),
          ('agent_bridge_backup_reader_' || substr(md5(current_database()),1,16))
        )
        SELECT count(*)::text AS count FROM names JOIN pg_catalog.pg_roles role
          ON role.rolname=names.role_name`);
      checks.push(check(
        "schema.role_collisions",
        collisions.rows[0]?.count === "0",
        "no derived Agent Bridge roles predate the schema",
      ));
    }

    let legacyRows: string | undefined;
    if (row.legacyTable && applied.length < 6) {
      legacyRows = await legacyChecks(db, checks);
    }

    await db.query("COMMIT");
    return {
      schema: "agent-bridge-postgres-production-preflight-v1",
      ok: checks.every((entry) => entry.ok),
      checks,
      observations: {
        serverMajor,
        databaseBytes: row.databaseBytes,
        migrationState,
        appliedMigrationCount: applied.length,
        requiredMigrationCount: expected.length,
        legacyTable: Boolean(row.legacyTable),
        ...(legacyRows === undefined ? {} : { legacyRows }),
        ssl,
      },
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function parseArguments(args: string[]): { json: boolean; help: boolean; requireSsl: boolean } {
  const options = { json: false, help: false, requireSsl: false };
  for (const argument of args) {
    if (argument === "--json") options.json = true;
    else if (argument === "--require-ssl") options.requireSsl = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function safeError(error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(secret).join("[redacted]").replace(/postgres(?:ql)?:\/\/\S+/giu, "[redacted]");
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: npm run preflight:postgres:production -- [--json] [--require-ssl]\n");
    return;
  }
  const databaseUrl = process.env.AGENT_BRIDGE_DATABASE_URL;
  if (!databaseUrl) throw new Error("AGENT_BRIDGE_DATABASE_URL is required");
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    application_name: "agent-bridge-production-preflight",
  });
  try {
    await client.connect();
    const clientTransportSsl = client.connection.stream instanceof TLSSocket &&
      client.connection.stream.encrypted;
    const migrationsDirectory = fileURLToPath(new URL("../sql/migrations", import.meta.url));
    const report = await runPostgresProductionPreflight({
      query: (sql) => client.query(sql),
    }, migrationsDirectory, {
      requireSsl: options.requireSsl,
      clientTransportSsl,
    });
    if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else {
      for (const entry of report.checks) {
        process.stdout.write(`${entry.ok ? "OK" : "ERROR"} ${entry.name}: ${entry.detail}\n`);
      }
      process.stdout.write(`${report.ok ? "PostgreSQL production preflight passed" : "PostgreSQL production preflight failed"}\n`);
    }
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    throw new Error(safeError(error, databaseUrl));
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
