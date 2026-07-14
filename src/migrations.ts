import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PgQueryable } from "./postgres-bridge-store.js";

const MIGRATION_NAME = /^(\d+)_([a-z0-9_]+)\.sql$/;
const REQUIRED_COLUMNS = new Map([
  ["workspaces.id", "text"],
  ["agents.id", "uuid"],
  ["agents.workspace_id", "text"],
  ["agents.principal", "text"],
  ["credentials.id", "uuid"],
  ["credentials.workspace_id", "text"],
  ["credentials.agent_id", "uuid"],
  ["credentials.token_hash", "bpchar"],
  ["messages.sequence", "int8"],
  ["messages.id", "uuid"],
  ["messages.workspace", "text"],
  ["messages.source", "text"],
  ["messages.targets", "jsonb"],
  ["receipts.workspace", "text"],
  ["receipts.message_id", "uuid"],
  ["receipts.principal", "text"],
  ["deliveries.id", "uuid"],
  ["deliveries.message_id", "uuid"],
  ["deliveries.workspace", "text"],
  ["deliveries.recipient", "text"],
  ["deliveries.state", "text"],
  ["deliveries.lease_token", "uuid"],
  ["delivery_events.delivery_id", "uuid"],
  ["delivery_events.to_state", "text"],
  ["agent_instances.workspace", "text"],
  ["agent_instances.instance", "text"],
  ["agent_instances.capabilities", "jsonb"],
]);

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

export interface MigrationPlanEntry extends AppliedMigration {
  source: string;
}

export const REQUIRED_MIGRATIONS = [
  { version: 1, name: "schema_state" },
  { version: 2, name: "workspaces_agents_credentials" },
  { version: 3, name: "messages_receipts_deliveries" },
  { version: 4, name: "message_query_indexes" },
  { version: 5, name: "delivery_events_presence" },
  { version: 6, name: "legacy_shared_context_import" },
  { version: 7, name: "runtime_role" },
] as const;

function checksum(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

async function recordedMigrations(db: PgQueryable): Promise<AppliedMigration[]> {
  const exists = await db.query<{ table_name: string | null }>(
    "SELECT to_regclass('agent_bridge.schema_migrations')::text AS table_name",
  );
  if (!exists.rows[0]?.table_name) return [];
  const result = await db.query<{ version: number; name: string; checksum: string }>(
    "SELECT version, name, checksum FROM agent_bridge.schema_migrations ORDER BY version",
  );
  return result.rows.map((row) => ({
    version: Number(row.version),
    name: row.name,
    checksum: row.checksum,
  }));
}

export async function loadMigrationPlan(directory: string): Promise<MigrationPlanEntry[]> {
  const files = (await readdir(directory))
    .filter((file) => MIGRATION_NAME.test(file))
    .sort((left, right) => left.localeCompare(right));
  const expected = await Promise.all(files.map(async (file) => {
    const match = file.match(MIGRATION_NAME)!;
    const source = await readFile(join(directory, file), "utf8");
    return { version: Number(match[1]), name: match[2], source, checksum: checksum(source) };
  }));

  if (
    expected.length !== REQUIRED_MIGRATIONS.length ||
    !expected.every(
      (migration, index) =>
        migration.version === REQUIRED_MIGRATIONS[index]?.version &&
        migration.name === REQUIRED_MIGRATIONS[index]?.name,
    )
  ) {
    throw new Error("migration directory does not match the required migration sequence");
  }
  return expected;
}

export async function migrationsReady(
  db: PgQueryable,
  expected: ReadonlyArray<Pick<MigrationPlanEntry, "version" | "name" | "checksum">>,
): Promise<boolean> {
  const applied = await recordedMigrations(db);
  return expected.every(
    (required, index) =>
      applied[index]?.version === required.version &&
      applied[index]?.name === required.name &&
      applied[index]?.checksum === required.checksum,
  ) && applied.length === expected.length;
}

export async function runtimeSchemaReady(db: PgQueryable): Promise<boolean> {
  const columns = await db.query<{ table_name: string; column_name: string; udt_name: string }>(
    `SELECT table_name, column_name, udt_name
     FROM information_schema.columns
     WHERE table_schema='agent_bridge'`,
  );
  const actual = new Map(
    columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.udt_name]),
  );
  if ([...REQUIRED_COLUMNS].some(([name, type]) => actual.get(name) !== type)) return false;

  const objects = await db.query<{ immutable: boolean; deliveryAudit: boolean; idempotency: boolean; claim: boolean; source: boolean; thread: boolean; created: boolean; presence: boolean }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM pg_trigger
         WHERE tgrelid='agent_bridge.messages'::regclass
           AND tgname='messages_immutable' AND NOT tgisinternal
       ) AS immutable,
       EXISTS (
         SELECT 1 FROM pg_trigger
         WHERE tgrelid='agent_bridge.deliveries'::regclass
           AND tgname='deliveries_record_event' AND NOT tgisinternal
       ) AS "deliveryAudit",
       to_regclass('agent_bridge.messages_idempotency') IS NOT NULL AS idempotency,
       to_regclass('agent_bridge.deliveries_claim') IS NOT NULL AS claim,
       to_regclass('agent_bridge.messages_source') IS NOT NULL AS source,
       to_regclass('agent_bridge.messages_thread') IS NOT NULL AS thread,
       to_regclass('agent_bridge.messages_created') IS NOT NULL AS created,
       to_regclass('agent_bridge.agent_instances_active') IS NOT NULL AS presence`,
  );
  const row = objects.rows[0];
  return Boolean(row?.immutable && row.deliveryAudit && row.idempotency && row.claim && row.source && row.thread && row.created && row.presence);
}

export async function runMigrations(
  db: PgQueryable,
  directory: string,
): Promise<AppliedMigration[]> {
  const expected = await loadMigrationPlan(directory);

  for (const migration of expected) {
    const applied = await recordedMigrations(db);
    const recorded = applied.find((entry) => entry.version === migration.version);
    if (recorded) {
      if (recorded.name !== migration.name || recorded.checksum !== migration.checksum) {
        throw new Error(`migration ${migration.version}_${migration.name} conflicts with schema state`);
      }
      continue;
    }
    await db.query(
      migration.source.split("__AGENT_BRIDGE_MIGRATION_CHECKSUM__").join(migration.checksum),
    );
    const verified = (await recordedMigrations(db)).find(
      (entry) => entry.version === migration.version,
    );
    if (verified?.name !== migration.name || verified.checksum !== migration.checksum) {
      throw new Error(`migration ${migration.version}_${migration.name} was not recorded correctly`);
    }
  }

  return recordedMigrations(db);
}
