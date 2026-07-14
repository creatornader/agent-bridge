import type { PgQueryable } from "./postgres-bridge-store.js";

export interface LegacyProjectReconciliationReport {
  mode: "dry-run" | "apply";
  workspace: "agent-bridge";
  messages: number;
  receipts: number;
  deliveries: 0;
  changed: number;
}

export interface LegacyProjectReconciliationOptions {
  apply?: boolean;
  migrationChecksum: string;
}

interface ReconciliationCounts extends Record<string, unknown> {
  messages: number;
  receipts: number;
  changed: number;
}

const lock = `LOCK TABLE public.shared_context IN SHARE MODE;
  LOCK TABLE agent_bridge.messages IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE agent_bridge.receipts IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE agent_bridge.deliveries IN SHARE MODE`;

function preflight(migrationChecksum: string): string {
  return `DO $reconcile$ BEGIN
  IF to_regclass('public.shared_context') IS NULL THEN
    RAISE EXCEPTION 'public.shared_context does not exist';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agent_bridge.schema_migrations
    WHERE version=8
      AND name='message_projects'
      AND checksum='${migrationChecksum}'
  ) THEN
    RAISE EXCEPTION 'migration 008_message_projects does not match the expected migration plan';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='agent_bridge'
      AND table_name='messages'
      AND column_name='project'
      AND data_type='text'
  ) THEN
    RAISE EXCEPTION 'agent_bridge.messages.project is missing or has the wrong type';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='agent_bridge.messages'::regclass
      AND conname='messages_project_label'
      AND contype='c'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'messages_project_label constraint is missing or invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index index_state
    JOIN pg_class index_class ON index_class.oid=index_state.indexrelid
    WHERE index_state.indrelid='agent_bridge.messages'::regclass
      AND index_class.relname='messages_project'
      AND index_state.indisvalid
      AND index_state.indisready
  ) THEN
    RAISE EXCEPTION 'messages_project index is missing or invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agent_bridge.workspaces WHERE id='agent-bridge'
  ) THEN
    RAISE EXCEPTION 'canonical workspace agent-bridge must be provisioned before reconciliation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shared_context
    WHERE project IS NOT NULL
      AND (project<>btrim(project) OR char_length(project) NOT BETWEEN 1 AND 128)
  ) THEN
    RAISE EXCEPTION 'legacy shared_context contains invalid project labels';
  END IF;
  IF EXISTS (
    SELECT agent_bridge.legacy_message_uuid(id, metadata)
    FROM public.shared_context GROUP BY 1 HAVING count(*)>1
  ) THEN
    RAISE EXCEPTION 'legacy shared_context contains duplicate message IDs';
  END IF;
  IF (
    SELECT count(*) FROM public.shared_context context
    JOIN agent_bridge.messages message
      ON message.id=agent_bridge.legacy_message_uuid(context.id, context.metadata)
  ) <> (SELECT count(*) FROM public.shared_context) THEN
    RAISE EXCEPTION 'legacy shared_context and v2 message counts do not match';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shared_context context
    JOIN agent_bridge.messages message
      ON message.id=agent_bridge.legacy_message_uuid(context.id, context.metadata)
    WHERE NOT (
      (message.workspace=coalesce(context.project,'legacy') AND message.project IS NULL)
      OR (message.workspace='agent-bridge' AND message.project IS NOT DISTINCT FROM context.project)
    )
  ) THEN
    RAISE EXCEPTION 'legacy message has a conflicting workspace or project';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shared_context context
    JOIN agent_bridge.messages message
      ON message.id=agent_bridge.legacy_message_uuid(context.id, context.metadata)
    WHERE message.source IS DISTINCT FROM context.source
       OR message.type IS DISTINCT FROM coalesce(
         context.metadata #>> '{message_envelope,kind}', context.category
       )
       OR message.content IS DISTINCT FROM context.content
       OR message.content_type IS DISTINCT FROM coalesce(
         context.metadata #>> '{message_envelope,payload_mime}', 'text/plain'
       )
       OR message.data IS DISTINCT FROM context.metadata #> '{message_envelope,payload}'
       OR message.targets IS DISTINCT FROM CASE
         WHEN jsonb_typeof(context.metadata #> '{message_envelope,target_agents}')='array'
           THEN context.metadata #> '{message_envelope,target_agents}'
         ELSE '[]'::jsonb
       END
       OR message.thread_id IS DISTINCT FROM context.metadata #>> '{message_envelope,thread_id}'
       OR message.reply_to_id IS DISTINCT FROM context.metadata #>> '{message_envelope,reply_to_id}'
       OR message.correlation_id IS DISTINCT FROM context.metadata #>> '{message_envelope,correlation_id}'
       OR message.causation_id IS DISTINCT FROM context.metadata #>> '{message_envelope,causation_id}'
       OR message.priority IS DISTINCT FROM CASE
         WHEN context.priority IN ('info','high','urgent') THEN context.priority ELSE 'info'
       END
       OR message.expires_at IS DISTINCT FROM agent_bridge.safe_timestamptz(
         context.metadata #>> '{message_envelope,expires_at}'
       )
       OR message.idempotency_key IS DISTINCT FROM context.metadata #>> '{message_envelope,idempotency_key}'
       OR message.atrib_receipt_id IS DISTINCT FROM coalesce(
         context.atrib_receipt_id,
         context.metadata #>> '{message_envelope,atrib_receipt_id}'
       )
       OR message.informed_by IS DISTINCT FROM context.metadata #> '{message_envelope,informed_by}'
       OR message.metadata IS DISTINCT FROM context.metadata
       OR message.created_at IS DISTINCT FROM context.created_at
  ) THEN
    RAISE EXCEPTION 'legacy message content differs from migration 006 import';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shared_context context
    JOIN agent_bridge.messages message
      ON message.id=agent_bridge.legacy_message_uuid(context.id, context.metadata)
    JOIN agent_bridge.deliveries delivery
      ON delivery.workspace=message.workspace AND delivery.message_id=message.id
  ) THEN
    RAISE EXCEPTION 'legacy messages with deliveries cannot be reconciled';
  END IF;
  IF EXISTS (
    WITH candidates AS (
      SELECT message.id, message.source, message.idempotency_key
      FROM public.shared_context context
      JOIN agent_bridge.messages message
        ON message.id=agent_bridge.legacy_message_uuid(context.id, context.metadata)
      WHERE message.idempotency_key IS NOT NULL
    ), canonical AS (
      SELECT candidate.id, candidate.source, candidate.idempotency_key FROM candidates candidate
      UNION ALL
      SELECT existing.id, existing.source, existing.idempotency_key
      FROM agent_bridge.messages existing
      WHERE existing.workspace='agent-bridge'
        AND existing.idempotency_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM candidates candidate WHERE candidate.id=existing.id)
    )
    SELECT source, idempotency_key FROM canonical
    GROUP BY source, idempotency_key HAVING count(*)>1
  ) THEN
    RAISE EXCEPTION 'legacy idempotency key collides in canonical workspace';
  END IF;
END $reconcile$`;
}

const counts = `SELECT
  count(*)::int AS messages,
  count(*) FILTER (
    WHERE message.workspace<>'agent-bridge'
      OR message.project IS DISTINCT FROM context.project
  )::int AS changed,
  coalesce(sum((
    SELECT count(*) FROM agent_bridge.receipts receipt
    WHERE receipt.workspace=message.workspace AND receipt.message_id=message.id
  )),0)::int AS receipts
FROM public.shared_context context
JOIN agent_bridge.messages message
  ON message.id=agent_bridge.legacy_message_uuid(context.id, context.metadata)`;

function report(
  mode: "dry-run" | "apply",
  row: ReconciliationCounts | undefined,
): LegacyProjectReconciliationReport {
  return {
    mode,
    workspace: "agent-bridge",
    messages: Number(row?.messages ?? 0),
    receipts: Number(row?.receipts ?? 0),
    deliveries: 0,
    changed: Number(row?.changed ?? 0),
  };
}

export async function reconcileLegacyProjects(
  db: PgQueryable,
  options: LegacyProjectReconciliationOptions,
): Promise<LegacyProjectReconciliationReport> {
  if (!/^[0-9a-f]{64}$/.test(options.migrationChecksum)) {
    throw new Error("migrationChecksum must be 64 lowercase hexadecimal characters");
  }
  const apply = options.apply === true;
  const verify = preflight(options.migrationChecksum);
  await db.query("BEGIN");
  try {
    await db.query("SELECT pg_advisory_xact_lock(1646705660)");
    await db.query(verify);
    if (apply) {
      await db.query(lock);
      await db.query(verify);
    }
    const before = await db.query<ReconciliationCounts>(counts);
    const summary = report(apply ? "apply" : "dry-run", before.rows[0]);
    if (!apply) {
      await db.query("ROLLBACK");
      return summary;
    }

    const totals = await db.query<{ messages: number; receipts: number }>(
      `SELECT
         (SELECT count(*)::int FROM agent_bridge.messages) AS messages,
         (SELECT count(*)::int FROM agent_bridge.receipts) AS receipts`,
    );
    await db.query(`CREATE TEMP TABLE reconcile_receipts ON COMMIT DROP AS
      SELECT receipt.* FROM agent_bridge.receipts receipt
      JOIN public.shared_context context
        ON receipt.message_id=agent_bridge.legacy_message_uuid(context.id,context.metadata)
       AND receipt.workspace=coalesce(context.project,'legacy')`);
    await db.query(`DELETE FROM agent_bridge.receipts receipt
      USING reconcile_receipts saved
      WHERE receipt.workspace=saved.workspace
        AND receipt.message_id=saved.message_id
        AND receipt.principal=saved.principal`);
    await db.query("ALTER TABLE agent_bridge.messages DISABLE TRIGGER messages_immutable");
    await db.query(`UPDATE agent_bridge.messages message
      SET workspace='agent-bridge', project=context.project
      FROM public.shared_context context
      WHERE message.id=agent_bridge.legacy_message_uuid(context.id,context.metadata)
        AND (message.workspace<>'agent-bridge' OR message.project IS DISTINCT FROM context.project)`);
    await db.query("ALTER TABLE agent_bridge.messages ENABLE TRIGGER messages_immutable");
    await db.query(`INSERT INTO agent_bridge.receipts (workspace,message_id,principal,read_at)
      SELECT 'agent-bridge',message_id,principal,read_at FROM reconcile_receipts`);

    const verified = await db.query<{
      messages: number;
      receipts: number;
      mismatches: number;
      deliveries: number;
    }>(`SELECT
      (SELECT count(*)::int FROM agent_bridge.messages) AS messages,
      (SELECT count(*)::int FROM agent_bridge.receipts) AS receipts,
      (SELECT count(*)::int FROM public.shared_context context
       JOIN agent_bridge.messages message
         ON message.id=agent_bridge.legacy_message_uuid(context.id,context.metadata)
       WHERE message.workspace<>'agent-bridge'
          OR message.project IS DISTINCT FROM context.project) AS mismatches,
      (SELECT count(*)::int FROM public.shared_context context
       JOIN agent_bridge.deliveries delivery
         ON delivery.message_id=agent_bridge.legacy_message_uuid(context.id,context.metadata)) AS deliveries`);
    const expected = totals.rows[0];
    const actual = verified.rows[0];
    if (
      !expected || !actual ||
      Number(actual.messages) !== Number(expected.messages) ||
      Number(actual.receipts) !== Number(expected.receipts) ||
      Number(actual.mismatches) !== 0 ||
      Number(actual.deliveries) !== 0
    ) {
      throw new Error("legacy project reconciliation verification failed");
    }
    await db.query("COMMIT");
    return summary;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
