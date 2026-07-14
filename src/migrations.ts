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
  ["credentials.scopes", "_text"],
  ["credentials.scope_set_name", "text"],
  ["credentials.replaces_credential_id", "uuid"],
  ["credentials.revoked_by", "text"],
  ["credentials.revocation_reason", "text"],
  ["credentials.expiry_grace_until", "timestamptz"],
  ["credential_scope_sets.name", "text"],
  ["credential_scope_sets.scopes", "_text"],
  ["credential_scope_sets.created_at", "timestamptz"],
  ["security_events.sequence", "int8"],
  ["security_events.event_id", "uuid"],
  ["security_events.event_type", "text"],
  ["security_events.outcome", "text"],
  ["security_events.reason_code", "text"],
  ["security_events.workspace_id", "text"],
  ["security_events.principal", "text"],
  ["security_events.actor_principal", "text"],
  ["security_events.credential_id", "uuid"],
  ["security_events.related_credential_id", "uuid"],
  ["security_events.operation_id", "text"],
  ["security_events.request_id", "uuid"],
  ["security_events.policy_id", "text"],
  ["security_events.retry_after_seconds", "int4"],
  ["security_events.created_at", "timestamptz"],
  ["rate_limit_policies.policy_id", "text"],
  ["rate_limit_policies.operation_id", "text"],
  ["rate_limit_policies.capacity", "int4"],
  ["rate_limit_policies.refill_per_second", "numeric"],
  ["rate_limit_policies.enabled", "bool"],
  ["rate_limit_buckets.credential_id", "uuid"],
  ["rate_limit_buckets.policy_id", "text"],
  ["rate_limit_buckets.tokens", "numeric"],
  ["rate_limit_buckets.updated_at", "timestamptz"],
  ["request_authorities.backend_pid", "int4"],
  ["request_authorities.transaction_id", "xid8"],
  ["request_authorities.request_id", "uuid"],
  ["request_authorities.credential_id", "uuid"],
  ["request_authorities.workspace_id", "text"],
  ["request_authorities.principal", "text"],
  ["request_authorities.scopes", "_text"],
  ["request_authorities.opened_session_user", "name"],
  ["messages.sequence", "int8"],
  ["messages.id", "uuid"],
  ["messages.workspace", "text"],
  ["messages.project", "text"],
  ["messages.source", "text"],
  ["messages.targets", "jsonb"],
  ["messages.delivery_mode", "text"],
  ["messages.delivery_max_attempts", "int4"],
  ["messages.delivery_retry_base_delay_ms", "int4"],
  ["messages.delivery_retry_max_delay_ms", "int4"],
  ["messages.delivery_retry_jitter_ratio", "float8"],
  ["messages.delivery_not_before", "timestamptz"],
  ["receipts.workspace", "text"],
  ["receipts.message_id", "uuid"],
  ["receipts.principal", "text"],
  ["deliveries.id", "uuid"],
  ["deliveries.message_id", "uuid"],
  ["deliveries.workspace", "text"],
  ["deliveries.recipient", "text"],
  ["deliveries.state", "text"],
  ["deliveries.lease_token", "uuid"],
  ["deliveries.created_at", "timestamptz"],
  ["deliveries.priority_rank", "int2"],
  ["deliveries.cycle_attempt", "int4"],
  ["deliveries.requeue_count", "int4"],
  ["deliveries.last_actor", "text"],
  ["deliveries.last_action", "text"],
  ["delivery_events.delivery_id", "uuid"],
  ["delivery_events.to_state", "text"],
  ["delivery_events.cycle_attempt", "int4"],
  ["delivery_events.requeue_count", "int4"],
  ["delivery_events.actor", "text"],
  ["delivery_events.action", "text"],
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
  { version: 8, name: "message_projects" },
  { version: 9, name: "mailbox_query_indexes" },
  { version: 10, name: "publisher_delivery_policy" },
  { version: 11, name: "credential_security" },
  { version: 12, name: "request_authority" },
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
    `SELECT relation.relname AS table_name, attribute.attname AS column_name,
       type.typname AS udt_name
     FROM pg_catalog.pg_attribute attribute
     JOIN pg_catalog.pg_class relation ON relation.oid=attribute.attrelid
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
     JOIN pg_catalog.pg_type type ON type.oid=attribute.atttypid
     WHERE namespace.nspname='agent_bridge'
       AND attribute.attnum>0 AND NOT attribute.attisdropped`,
  );
  const actual = new Map(
    columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.udt_name]),
  );
  if ([...REQUIRED_COLUMNS].some(([name, type]) => actual.get(name) !== type)) return false;

  const objects = await db.query<{ immutable: boolean; deliveryAudit: boolean; idempotency: boolean; claim: boolean; publisher: boolean; terminal: boolean; source: boolean; thread: boolean; created: boolean; presence: boolean; project: boolean; targets: boolean; scopeSets: boolean; securityEvents: boolean; ratePolicies: boolean; rateBuckets: boolean; replacement: boolean; rateCleanup: boolean; credentialSecurity: boolean; eventAppendOnly: boolean; scopeAudit: boolean; rateConsume: boolean; securityReady: boolean; requestAuthorities: boolean; authorityOpen: boolean; authorityClose: boolean; credentialDigestHidden: boolean; authorityRowsHidden: boolean; principalTablesHidden: boolean; authorityTablesLocked: boolean; authorityCatalog: boolean }>(
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
       to_regclass('agent_bridge.deliveries_publisher_lookup') IS NOT NULL AS publisher,
       to_regclass('agent_bridge.deliveries_terminal_lookup') IS NOT NULL AS terminal,
       to_regclass('agent_bridge.messages_source') IS NOT NULL AS source,
       to_regclass('agent_bridge.messages_thread') IS NOT NULL AS thread,
       to_regclass('agent_bridge.messages_created') IS NOT NULL AS created,
       to_regclass('agent_bridge.messages_project') IS NOT NULL AS project,
       to_regclass('agent_bridge.messages_targets_gin') IS NOT NULL AS targets,
       to_regclass('agent_bridge.agent_instances_active') IS NOT NULL AS presence,
       to_regclass('agent_bridge.credential_scope_sets') IS NOT NULL AS "scopeSets",
       to_regclass('agent_bridge.security_events') IS NOT NULL AS "securityEvents",
       to_regclass('agent_bridge.rate_limit_policies') IS NOT NULL AS "ratePolicies",
       to_regclass('agent_bridge.rate_limit_buckets') IS NOT NULL AS "rateBuckets",
       to_regclass('agent_bridge.credentials_replacement_lineage') IS NOT NULL AS replacement,
       to_regclass('agent_bridge.rate_limit_buckets_cleanup') IS NOT NULL AS "rateCleanup",
       EXISTS (
         SELECT 1 FROM pg_trigger
         WHERE tgrelid=to_regclass('agent_bridge.credentials')
           AND tgname='credentials_validate_security' AND NOT tgisinternal
       ) AS "credentialSecurity",
       EXISTS (
         SELECT 1 FROM pg_trigger
         WHERE tgrelid=to_regclass('agent_bridge.security_events')
           AND tgname='security_events_append_only' AND NOT tgisinternal
       ) AS "eventAppendOnly",
       to_regprocedure('agent_bridge.record_scope_denial(uuid,text,uuid)') IS NOT NULL AS "scopeAudit",
       to_regprocedure('agent_bridge.consume_rate_limit(uuid,text,uuid)') IS NOT NULL AS "rateConsume",
       to_regprocedure('agent_bridge.security_schema_ready()') IS NOT NULL AS "securityReady",
       to_regclass('agent_bridge.request_authorities') IS NOT NULL AS "requestAuthorities",
       to_regprocedure('agent_bridge.open_request_authority(uuid,text,uuid)') IS NOT NULL
         AND to_regprocedure('agent_bridge.resolve_credential_hash(text)') IS NOT NULL AS "authorityOpen",
       to_regprocedure('agent_bridge.close_request_authority()') IS NOT NULL AS "authorityClose",
       ((SELECT usesuper FROM pg_user WHERE usename=current_user)
         OR NOT has_table_privilege(current_user,'agent_bridge.credentials','SELECT')) AS "credentialDigestHidden",
       ((SELECT usesuper FROM pg_user WHERE usename=current_user)
         OR NOT has_table_privilege(current_user,'agent_bridge.request_authorities','SELECT')) AS "authorityRowsHidden",
       ((SELECT usesuper FROM pg_user WHERE usename=current_user)
         OR (NOT has_table_privilege(current_user,'agent_bridge.agents','SELECT')
           AND NOT has_table_privilege(current_user,'agent_bridge.workspaces','SELECT'))) AS "principalTablesHidden",
       ((SELECT usesuper FROM pg_user WHERE usename=current_user) OR (
         NOT EXISTS (
           SELECT 1
           FROM unnest(ARRAY[
             'agent_bridge.credentials','agent_bridge.agents',
             'agent_bridge.workspaces','agent_bridge.request_authorities'
           ]) protected_table(value)
           CROSS JOIN unnest(ARRAY[
             'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'
           ]) requested_privilege(value)
           WHERE has_table_privilege(current_user,protected_table.value,requested_privilege.value)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM unnest(ARRAY[
             'agent_bridge.credentials','agent_bridge.agents',
             'agent_bridge.workspaces','agent_bridge.request_authorities'
           ]) protected_table(value)
           CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) requested_privilege(value)
           WHERE has_any_column_privilege(current_user,protected_table.value,requested_privilege.value)
         )
       )) AS "authorityTablesLocked",
       ((SELECT usesuper FROM pg_user WHERE usename=current_user) OR (
         has_function_privilege(current_user,'agent_bridge.resolve_credential_hash(text)','EXECUTE')
         AND has_function_privilege(current_user,'agent_bridge.open_request_authority(uuid,text,uuid)','EXECUTE')
         AND has_function_privilege(current_user,'agent_bridge.close_request_authority()','EXECUTE')
         AND has_function_privilege(current_user,'agent_bridge.record_scope_denial(uuid,text,uuid)','EXECUTE')
         AND has_function_privilege(current_user,'agent_bridge.consume_rate_limit(uuid,text,uuid)','EXECUTE')
         AND NOT has_function_privilege(current_user,'agent_bridge.active_request_authority()','EXECUTE')
         AND NOT has_function_privilege(current_user,'agent_bridge.assert_active_request_credential(uuid)','EXECUTE')
         AND NOT has_function_privilege(current_user,'agent_bridge.record_scope_denial_unbound_011(uuid,text,uuid)','EXECUTE')
         AND NOT has_function_privilege(current_user,'agent_bridge.consume_rate_limit_unbound_011(uuid,text,uuid)','EXECUTE')
         AND NOT has_function_privilege('public','agent_bridge.resolve_credential_hash(text)','EXECUTE')
         AND NOT has_function_privilege('public','agent_bridge.open_request_authority(uuid,text,uuid)','EXECUTE')
         AND NOT has_function_privilege('public','agent_bridge.close_request_authority()','EXECUTE')
         AND NOT has_function_privilege('public','agent_bridge.record_scope_denial(uuid,text,uuid)','EXECUTE')
         AND NOT has_function_privilege('public','agent_bridge.consume_rate_limit(uuid,text,uuid)','EXECUTE')
         AND NOT has_function_privilege('public','agent_bridge.record_scope_denial_unbound_011(uuid,text,uuid)','EXECUTE')
         AND NOT has_function_privilege('public','agent_bridge.consume_rate_limit_unbound_011(uuid,text,uuid)','EXECUTE')
         AND NOT EXISTS (
           SELECT 1 FROM pg_proc procedure
           JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
           WHERE namespace.nspname='agent_bridge'
             AND procedure.proname IN (
               'resolve_credential_hash','open_request_authority','active_request_authority',
               'assert_active_request_credential','close_request_authority','record_scope_denial',
               'consume_rate_limit','record_scope_denial_unbound_011','consume_rate_limit_unbound_011'
             )
             AND (
               NOT procedure.prosecdef
               OR procedure.proowner <> (SELECT nspowner FROM pg_namespace WHERE nspname='agent_bridge')
               OR NOT coalesce(procedure.proconfig @> ARRAY['search_path=""'],false)
             )
         )
       )) AS "authorityCatalog"`,
  );
  const row = objects.rows[0];
  if (!Boolean(
    row?.immutable && row.deliveryAudit && row.idempotency && row.claim && row.publisher &&
    row.terminal && row.source && row.thread && row.created && row.presence && row.project &&
    row.targets && row.scopeSets && row.securityEvents && row.ratePolicies && row.rateBuckets &&
    row.replacement && row.rateCleanup && row.credentialSecurity && row.eventAppendOnly &&
    row.scopeAudit && row.rateConsume && row.securityReady && row.requestAuthorities &&
    row.authorityOpen && row.authorityClose && row.credentialDigestHidden && row.authorityRowsHidden &&
    row.principalTablesHidden && row.authorityTablesLocked && row.authorityCatalog
  )) return false;
  try {
    const security = await db.query<{ ready: boolean }>(
      "SELECT agent_bridge.security_schema_ready() AS ready",
    );
    return security.rows[0]?.ready === true;
  } catch {
    return false;
  }
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
