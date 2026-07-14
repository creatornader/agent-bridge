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
  ["row_isolation_attestations.name", "text"],
  ["row_isolation_attestations.catalog_definition", "text"],
  ["row_isolation_attestations.attested_at", "timestamptz"],
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
  ["deliveries.publisher", "text"],
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
  ["delivery_events.publisher", "text"],
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
  { version: 13, name: "row_isolation" },
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

async function rowIsolationReady(db: PgQueryable, allowPrivilegedCaller: boolean): Promise<boolean> {
  const result = await db.query<{
    rolesReady: boolean;
    callerReady: boolean;
    callerBypasses: boolean;
    ownershipReady: boolean;
    policiesReady: boolean;
    functionsReady: boolean;
    constraintsReady: boolean;
    triggersReady: boolean;
    grantsReady: boolean;
    catalogReady: boolean;
  }>(`WITH names AS (
      SELECT
        ('agent_bridge_runtime_' || substr(md5(current_database()),1,16))::name AS runtime_role,
        ('agent_bridge_data_owner_' || substr(md5(current_database()),1,16))::name AS data_owner,
        ('agent_bridge_context_reader_' || substr(md5(current_database()),1,16))::name AS context_reader,
        ('agent_bridge_event_writer_' || substr(md5(current_database()),1,16))::name AS event_writer
    ), required_roles(role_name) AS (
      SELECT runtime_role FROM names UNION ALL SELECT data_owner FROM names
      UNION ALL SELECT context_reader FROM names UNION ALL SELECT event_writer FROM names
    ), domain_tables(table_name) AS (
      VALUES ('messages'),('receipts'),('deliveries'),('delivery_events'),('agent_instances')
    ), caller_role AS (
      SELECT * FROM pg_roles WHERE rolname=current_user
    ), expected_policies(table_name,policy_name,command_name,role_name,needs_workspace,needs_principal) AS (
      SELECT 'messages','messages_owner_all','*',data_owner::text,false,false FROM names UNION ALL
      SELECT 'messages','messages_runtime_select','r',runtime_role::text,true,true FROM names UNION ALL
      SELECT 'messages','messages_runtime_insert','a',runtime_role::text,true,true FROM names UNION ALL
      SELECT 'receipts','receipts_owner_all','*',data_owner::text,false,false FROM names UNION ALL
      SELECT 'receipts','receipts_runtime_select','r',runtime_role::text,true,true FROM names UNION ALL
      SELECT 'receipts','receipts_runtime_insert','a',runtime_role::text,true,true FROM names UNION ALL
      SELECT 'deliveries','deliveries_owner_all','*',data_owner::text,false,false FROM names UNION ALL
      SELECT 'deliveries','deliveries_runtime_select','r',runtime_role::text,true,true FROM names UNION ALL
      SELECT 'deliveries','deliveries_runtime_insert','a',runtime_role::text,true,true FROM names UNION ALL
      SELECT 'deliveries','deliveries_runtime_update','w',runtime_role::text,true,true FROM names UNION ALL
      SELECT 'delivery_events','delivery_events_owner_all','*',data_owner::text,false,false FROM names UNION ALL
      SELECT 'delivery_events','delivery_events_runtime_select','r',runtime_role::text,true,true FROM names UNION ALL
      SELECT 'delivery_events','delivery_events_writer_insert','a',event_writer::text,false,false FROM names UNION ALL
      SELECT 'agent_instances','agent_instances_owner_all','*',data_owner::text,false,false FROM names UNION ALL
      SELECT 'agent_instances','agent_instances_runtime_select','r',runtime_role::text,true,false FROM names UNION ALL
      SELECT 'agent_instances','agent_instances_runtime_insert','a',runtime_role::text,true,true FROM names UNION ALL
      SELECT 'agent_instances','agent_instances_runtime_update','w',runtime_role::text,true,true FROM names UNION ALL
      SELECT 'agent_instances','agent_instances_runtime_delete','d',runtime_role::text,true,true FROM names
    ), actual_policies AS (
      SELECT relation.relname AS table_name,policy.polname AS policy_name,
        policy.polcmd AS command_name,policy.polpermissive,
        ARRAY(SELECT role.rolname::text FROM unnest(policy.polroles) member(oid)
          JOIN pg_roles role ON role.oid=member.oid ORDER BY role.rolname) AS role_names,
        coalesce(pg_get_expr(policy.polqual,policy.polrelid),'') || ' ' ||
          coalesce(pg_get_expr(policy.polwithcheck,policy.polrelid),'') AS expressions
      FROM pg_policy policy
      JOIN pg_class relation ON relation.oid=policy.polrelid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='agent_bridge'
        AND relation.relname IN (SELECT table_name FROM domain_tables)
    )
    SELECT
      (SELECT count(*)=4 AND bool_and(
          role.rolname=(required.role_name::text)
          AND NOT role.rolcanlogin AND NOT role.rolsuper AND NOT role.rolcreatedb
          AND NOT role.rolcreaterole AND NOT role.rolreplication AND NOT role.rolbypassrls
        )
       FROM required_roles required JOIN pg_roles role ON role.rolname=required.role_name::text) AS "rolesReady",
      ((SELECT rolsuper OR rolbypassrls FROM caller_role) OR (
        (SELECT rolcanlogin AND rolinherit AND NOT rolsuper AND NOT rolcreatedb
           AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
         FROM caller_role)
        AND pg_has_role(current_user,(SELECT runtime_role FROM names),'MEMBER')
        AND NOT EXISTS (
          SELECT 1 FROM pg_roles unexpected
          WHERE unexpected.oid<>(SELECT oid FROM caller_role)
            AND unexpected.rolname<>(SELECT runtime_role::text FROM names)
            AND pg_has_role(current_user,unexpected.oid,'MEMBER')
        )
      )) AS "callerReady",
      EXISTS (
        SELECT 1 FROM pg_roles elevated
        WHERE (elevated.rolsuper OR elevated.rolbypassrls)
          AND pg_has_role(current_user,elevated.oid,'MEMBER')
      ) AS "callerBypasses",
      (SELECT count(*)=5 AND bool_and(
          relation.relrowsecurity AND relation.relforcerowsecurity
          AND owner.rolname=(SELECT data_owner::text FROM names)
        )
       FROM domain_tables required
       JOIN pg_namespace namespace ON namespace.nspname='agent_bridge'
       JOIN pg_class relation ON relation.relnamespace=namespace.oid AND relation.relname=required.table_name
       JOIN pg_roles owner ON owner.oid=relation.relowner)
        AND EXISTS (
          SELECT 1 FROM pg_class attestation
          JOIN pg_namespace namespace ON namespace.oid=attestation.relnamespace
          WHERE namespace.nspname='agent_bridge'
            AND attestation.relname='row_isolation_attestations'
            AND attestation.relowner=namespace.nspowner
        ) AS "ownershipReady",
      ((SELECT count(*) FROM actual_policies)=18 AND NOT EXISTS (
        SELECT 1 FROM expected_policies expected
        LEFT JOIN actual_policies actual
          ON actual.table_name=expected.table_name AND actual.policy_name=expected.policy_name
        WHERE actual.policy_name IS NULL OR actual.command_name<>expected.command_name
          OR NOT actual.polpermissive OR actual.role_names<>ARRAY[expected.role_name]
          OR (expected.needs_workspace AND position('current_request_workspace' in actual.expressions)=0)
          OR (expected.needs_principal AND position('current_request_principal' in actual.expressions)=0)
          OR (NOT expected.needs_workspace AND NOT expected.needs_principal
            AND position('true' in actual.expressions)=0)
      )) AS "policiesReady",
      (SELECT count(*)=4 AND bool_and(
          procedure.proconfig @> ARRAY['search_path=""']::text[]
          AND CASE procedure.proname
            WHEN 'record_delivery_event' THEN owner.rolname=(SELECT event_writer::text FROM names)
              AND procedure.prosecdef AND procedure.provolatile='v'
            WHEN 'row_isolation_catalog_definition' THEN
              owner.oid=(SELECT relation.relowner FROM pg_class relation
                JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
                WHERE namespace.nspname='agent_bridge'
                  AND relation.relname='row_isolation_attestations')
              AND NOT procedure.prosecdef AND procedure.provolatile='s'
            ELSE owner.rolname=(SELECT context_reader::text FROM names)
              AND procedure.prosecdef AND procedure.provolatile='s'
          END
        )
       FROM pg_proc procedure
       JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
       JOIN pg_roles owner ON owner.oid=procedure.proowner
       WHERE namespace.nspname='agent_bridge'
         AND procedure.proname IN (
           'current_request_workspace','current_request_principal',
           'record_delivery_event','row_isolation_catalog_definition'
         ))
        AND NOT EXISTS (
          SELECT 1 FROM pg_proc private_function
          JOIN pg_namespace private_namespace ON private_namespace.oid=private_function.pronamespace
          WHERE private_namespace.nspname='agent_bridge'
            AND has_function_privilege('public',private_function.oid,'EXECUTE')
        )
        AND has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.current_request_workspace()','EXECUTE')
        AND has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.current_request_principal()','EXECUTE')
        AND has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.row_isolation_catalog_definition()','EXECUTE')
        AND NOT has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.record_delivery_event()','EXECUTE')
        AND NOT has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.reject_delivery_identity_mutation()','EXECUTE')
        AND NOT has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.enforce_delivery_actor_role()','EXECUTE')
        AND NOT has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.reject_delivery_event_mutation()','EXECUTE')
        AS "functionsReady",
      ((SELECT count(*)=5 AND bool_and(constraint_record.convalidated)
       FROM (VALUES
          ('agent_bridge.messages'::regclass,'messages_workspace_id_source_unique'),
          ('agent_bridge.deliveries'::regclass,'deliveries_publisher_message_fk'),
          ('agent_bridge.deliveries'::regclass,'deliveries_event_identity_unique'),
          ('agent_bridge.delivery_events'::regclass,'delivery_events_delivery_publisher_fk'),
          ('agent_bridge.row_isolation_attestations'::regclass,'row_isolation_attestation_name')
       ) required(relation_id,constraint_name)
       JOIN pg_constraint constraint_record
         ON constraint_record.conrelid=required.relation_id
        AND constraint_record.conname=required.constraint_name)
        AND (SELECT count(*)=2 AND bool_and(attribute.attnotnull)
          FROM pg_attribute attribute
          WHERE (attribute.attrelid,attribute.attname) IN (
            ('agent_bridge.deliveries'::regclass,'publisher'),
            ('agent_bridge.delivery_events'::regclass,'publisher')
          ) AND attribute.attnum>0 AND NOT attribute.attisdropped)
      ) AS "constraintsReady",
      (SELECT count(*)=4 AND bool_and(trigger.tgenabled='O')
       FROM (VALUES
          ('agent_bridge.deliveries'::regclass,'deliveries_record_event'),
          ('agent_bridge.deliveries'::regclass,'deliveries_identity_immutable'),
          ('agent_bridge.deliveries'::regclass,'deliveries_actor_role'),
          ('agent_bridge.delivery_events'::regclass,'delivery_events_append_only')
       ) required(relation_id,trigger_name)
       JOIN pg_trigger trigger ON trigger.tgrelid=required.relation_id
        AND trigger.tgname=required.trigger_name AND NOT trigger.tgisinternal) AS "triggersReady",
      (has_schema_privilege((SELECT runtime_role FROM names),'agent_bridge','USAGE')
        AND NOT has_schema_privilege((SELECT runtime_role FROM names),'agent_bridge','CREATE')
        AND has_schema_privilege((SELECT data_owner FROM names),'agent_bridge','USAGE')
        AND NOT has_schema_privilege((SELECT data_owner FROM names),'agent_bridge','CREATE')
        AND has_schema_privilege((SELECT context_reader FROM names),'agent_bridge','USAGE')
        AND NOT has_schema_privilege((SELECT context_reader FROM names),'agent_bridge','CREATE')
        AND has_schema_privilege((SELECT event_writer FROM names),'agent_bridge','USAGE')
        AND NOT has_schema_privilege((SELECT event_writer FROM names),'agent_bridge','CREATE')
        AND has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.messages','SELECT')
        AND has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.messages','INSERT')
        AND NOT has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.messages','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.receipts','SELECT')
        AND has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.receipts','INSERT')
        AND NOT has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.receipts','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.deliveries','SELECT')
        AND has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.deliveries','INSERT')
        AND has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.deliveries','UPDATE')
        AND NOT has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.deliveries','DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.delivery_events','SELECT')
        AND NOT has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.delivery_events','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.agent_instances','SELECT')
        AND has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.agent_instances','INSERT')
        AND has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.agent_instances','UPDATE')
        AND has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.agent_instances','DELETE')
        AND NOT has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.agent_instances','TRUNCATE,REFERENCES,TRIGGER')
        AND has_sequence_privilege((SELECT runtime_role FROM names),'agent_bridge.messages_sequence_seq','USAGE')
        AND NOT has_sequence_privilege((SELECT runtime_role FROM names),'agent_bridge.messages_sequence_seq','SELECT,UPDATE')
        AND NOT has_sequence_privilege((SELECT runtime_role FROM names),'agent_bridge.delivery_events_sequence_seq','USAGE,SELECT,UPDATE')
        AND has_table_privilege((SELECT context_reader FROM names),'agent_bridge.request_authorities','SELECT')
        AND NOT has_table_privilege((SELECT context_reader FROM names),'agent_bridge.request_authorities','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND has_table_privilege((SELECT event_writer FROM names),'agent_bridge.delivery_events','INSERT')
        AND NOT has_table_privilege((SELECT event_writer FROM names),'agent_bridge.delivery_events','SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT EXISTS (
          SELECT 1 FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='agent_bridge' AND relation.relkind IN ('r','p','v','m','f')
            AND (
              (relation.relname<>'request_authorities' AND has_table_privilege(
                (SELECT context_reader FROM names),relation.oid,
                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
              ))
              OR (relation.relname<>'delivery_events' AND has_table_privilege(
                (SELECT event_writer FROM names),relation.oid,
                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
              ))
            )
        )
        AND has_sequence_privilege((SELECT event_writer FROM names),'agent_bridge.delivery_events_sequence_seq','USAGE')
        AND NOT has_sequence_privilege((SELECT event_writer FROM names),'agent_bridge.delivery_events_sequence_seq','SELECT,UPDATE')
        AND NOT EXISTS (
          SELECT 1 FROM pg_class sequence
          JOIN pg_namespace namespace ON namespace.oid=sequence.relnamespace
          WHERE namespace.nspname='agent_bridge' AND sequence.relkind='S'
            AND (
              has_sequence_privilege((SELECT context_reader FROM names),sequence.oid,'USAGE,SELECT,UPDATE')
              OR (sequence.relname<>'delivery_events_sequence_seq' AND has_sequence_privilege(
                (SELECT event_writer FROM names),sequence.oid,'USAGE,SELECT,UPDATE'
              ))
            )
        )
        AND NOT has_sequence_privilege('public','agent_bridge.messages_sequence_seq','USAGE,SELECT,UPDATE')
        AND NOT has_sequence_privilege('public','agent_bridge.delivery_events_sequence_seq','USAGE,SELECT,UPDATE')
        AND has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.row_isolation_attestations','SELECT')
        AND NOT has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.row_isolation_attestations','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(ARRAY[
            'agent_bridge.credentials','agent_bridge.agents',
            'agent_bridge.workspaces','agent_bridge.request_authorities'
          ]) protected_table(value)
          CROSS JOIN unnest(ARRAY[
            'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'
          ]) requested_privilege(value)
          WHERE has_table_privilege(
            (SELECT runtime_role FROM names),protected_table.value,requested_privilege.value
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(ARRAY[
            'agent_bridge.credentials','agent_bridge.agents',
            'agent_bridge.workspaces','agent_bridge.request_authorities'
          ]) protected_table(value)
          CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) requested_privilege(value)
          WHERE has_any_column_privilege(
            (SELECT runtime_role FROM names),protected_table.value,requested_privilege.value
          )
        )
        AND NOT has_table_privilege('public','agent_bridge.row_isolation_attestations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT pg_has_role((SELECT runtime_role FROM names),(SELECT data_owner FROM names),'MEMBER')
        AND NOT pg_has_role((SELECT runtime_role FROM names),(SELECT context_reader FROM names),'MEMBER')
        AND NOT pg_has_role((SELECT runtime_role FROM names),(SELECT event_writer FROM names),'MEMBER')
        AND NOT EXISTS (
          SELECT 1 FROM pg_proc private_function
          JOIN pg_namespace namespace ON namespace.oid=private_function.pronamespace
          WHERE namespace.nspname='agent_bridge'
            AND (
              (NOT (private_function.proname IN ('current_request_workspace','current_request_principal')
                    AND private_function.pronargs=0)
                AND has_function_privilege((SELECT context_reader FROM names),private_function.oid,'EXECUTE'))
              OR (NOT (private_function.proname='record_delivery_event' AND private_function.pronargs=0)
                AND has_function_privilege((SELECT event_writer FROM names),private_function.oid,'EXECUTE'))
            )
        )
      ) AS "grantsReady",
      (SELECT count(*)=1 AND bool_and(
          attestation.catalog_definition=agent_bridge.row_isolation_catalog_definition()
        )
       FROM agent_bridge.row_isolation_attestations attestation
       WHERE attestation.name='domain-v1') AS "catalogReady"
  `);
  const row = result.rows[0];
  const callerReady = row?.callerReady && (allowPrivilegedCaller || !row.callerBypasses);
  return Boolean(
    row?.rolesReady && callerReady && row.ownershipReady && row.policiesReady &&
    row.functionsReady && row.constraintsReady && row.triggersReady && row.grantsReady && row.catalogReady
  );
}

export async function runtimeSchemaReady(
  db: PgQueryable,
  options: { allowPrivilegedCaller?: boolean } = {},
): Promise<boolean> {
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
    `WITH names AS (
       SELECT ('agent_bridge_runtime_' || substr(md5(current_database()),1,16))::name AS runtime_role
     ) SELECT
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
       NOT has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.credentials','SELECT') AS "credentialDigestHidden",
       NOT has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.request_authorities','SELECT') AS "authorityRowsHidden",
       (NOT has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.agents','SELECT')
         AND NOT has_table_privilege((SELECT runtime_role FROM names),'agent_bridge.workspaces','SELECT')) AS "principalTablesHidden",
       (
         NOT EXISTS (
           SELECT 1
           FROM unnest(ARRAY[
             'agent_bridge.credentials','agent_bridge.agents',
             'agent_bridge.workspaces','agent_bridge.request_authorities'
           ]) protected_table(value)
           CROSS JOIN unnest(ARRAY[
             'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'
           ]) requested_privilege(value)
           WHERE has_table_privilege(
             (SELECT runtime_role FROM names),protected_table.value,requested_privilege.value
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM unnest(ARRAY[
             'agent_bridge.credentials','agent_bridge.agents',
             'agent_bridge.workspaces','agent_bridge.request_authorities'
           ]) protected_table(value)
           CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) requested_privilege(value)
           WHERE has_any_column_privilege(
             (SELECT runtime_role FROM names),protected_table.value,requested_privilege.value
           )
         )
       ) AS "authorityTablesLocked",
       (
         has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.resolve_credential_hash(text)','EXECUTE')
         AND has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.open_request_authority(uuid,text,uuid)','EXECUTE')
         AND has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.close_request_authority()','EXECUTE')
         AND has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.record_scope_denial(uuid,text,uuid)','EXECUTE')
         AND has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.consume_rate_limit(uuid,text,uuid)','EXECUTE')
         AND NOT has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.active_request_authority()','EXECUTE')
         AND NOT has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.assert_active_request_credential(uuid)','EXECUTE')
         AND NOT has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.record_scope_denial_unbound_011(uuid,text,uuid)','EXECUTE')
         AND NOT has_function_privilege((SELECT runtime_role FROM names),'agent_bridge.consume_rate_limit_unbound_011(uuid,text,uuid)','EXECUTE')
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
       ) AS "authorityCatalog"`,
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
    return security.rows[0]?.ready === true && await rowIsolationReady(
      db,
      options.allowPrivilegedCaller === true,
    );
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
