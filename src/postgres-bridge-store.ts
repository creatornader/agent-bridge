import { randomUUID } from "node:crypto";
import {
  DeliveryStateConflictError,
  decodeCursor,
  decodeScopedCursor,
  encodeCursor,
  encodeScopedCursor,
  cursorScope,
  scopedCursorScope,
  validateDeliveryCursorPosition,
  validateEventCursorPosition,
  type AgentPresence,
  type BridgeDelivery,
  type BridgeDeliveryEvent,
  type BridgeMessage,
  type BridgePrincipal,
  type DeliveryPolicy,
} from "./bridge-domain.js";
import type {
  BridgeStore,
  BridgeDiagnostics,
  ClaimOptions,
  InsertMessageResult,
  MessagePage,
  MessageQuery,
  DeliveryQuery,
} from "./bridge-store.js";
import { assertIdempotentReplay } from "./idempotency.js";

export interface PgQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  connect?(): Promise<PgTransactionClient>;
  release?(): void;
  /** True when the queryable is already owned by an explicit request transaction. */
  inTransaction?: boolean;
}
export interface PgTransactionClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  release(error?: Error | boolean): void;
}

type Row = Record<string, any>;

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parse(value: unknown): any {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function asTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function asMessage(row: Row): BridgeMessage {
  const deliveryPolicy: DeliveryPolicy = row.delivery_mode === "mailbox"
    ? { mode: "mailbox" }
    : {
        mode: "leased",
        maxAttempts: Number(row.delivery_max_attempts),
        retryBaseDelayMs: Number(row.delivery_retry_base_delay_ms),
        retryMaxDelayMs: Number(row.delivery_retry_max_delay_ms),
        retryJitterRatio: Number(row.delivery_retry_jitter_ratio),
        ...(row.delivery_not_before ? { notBefore: asTimestamp(row.delivery_not_before) } : {}),
      };
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    project: row.project ?? undefined,
    source: String(row.source),
    sequence: String(row.sequence),
    type: String(row.type),
    content: String(row.content),
    contentType: String(row.content_type),
    data: parse(row.data),
    targets: parse(row.targets) ?? [],
    threadId: row.thread_id ?? undefined,
    replyToId: row.reply_to_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    causationId: row.causation_id ?? undefined,
    priority: row.priority,
    expiresAt: asTimestamp(row.expires_at),
    idempotencyKey: row.idempotency_key ?? undefined,
    atribReceiptId: row.atrib_receipt_id ?? undefined,
    informedBy: parse(row.informed_by),
    metadata: parse(row.metadata),
    deliveryPolicy,
    createdAt: asTimestamp(row.created_at) ?? "",
  };
}

function asDelivery(row: Row): BridgeDelivery {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    workspace: String(row.workspace),
    recipient: String(row.recipient),
    state: row.state,
    attempt: Number(row.attempt),
    cycleAttempt: Number(row.cycle_attempt ?? row.attempt),
    requeueCount: Number(row.requeue_count ?? 0),
    createdAt: asTimestamp(row.created_at) ?? "",
    priorityRank: Number(row.priority_rank),
    availableAt: asTimestamp(row.available_at) ?? "",
    leaseToken: row.lease_token ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: asTimestamp(row.lease_expires_at),
    lastError: row.last_error ?? undefined,
    lastActor: row.last_actor ?? undefined,
    lastAction: row.last_action,
  };
}

function asPresence(row: Row): AgentPresence {
  return {
    workspace: String(row.workspace), agent: String(row.agent), instance: String(row.instance),
    runtimeType: row.runtime_type ?? undefined, capabilities: parse(row.capabilities) ?? [],
    leaseExpiresAt: asTimestamp(row.lease_expires_at) ?? "", lastSeenAt: asTimestamp(row.last_seen_at) ?? "",
  };
}

function asDeliveryEvent(row: Row): BridgeDeliveryEvent {
  return {
    sequence: String(row.sequence), deliveryId: String(row.delivery_id),
    messageId: String(row.message_id), workspace: String(row.workspace),
    recipient: String(row.recipient),
    fromState: row.from_state == null ? undefined : row.from_state as BridgeDeliveryEvent["fromState"],
    toState: row.to_state as BridgeDeliveryEvent["toState"], attempt: Number(row.attempt),
    cycleAttempt: Number(row.cycle_attempt), requeueCount: Number(row.requeue_count),
    leaseOwner: row.lease_owner ?? undefined, error: row.error ?? undefined,
    actor: String(row.actor), action: row.action,
    createdAt: asTimestamp(row.created_at) ?? "",
  };
}

async function transaction<T>(db: PgQueryable, work: (client: PgQueryable) => Promise<T>): Promise<T> {
  if (db.inTransaction) return work(db);
  const borrowed = !db.release && Boolean(db.connect);
  const client = borrowed ? await db.connect!() : db;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (borrowed && "release" in client && typeof client.release === "function") client.release();
  }
}

export class PostgresBridgeStore implements BridgeStore {
  constructor(private readonly db: PgQueryable) {}

  async initialize(): Promise<void> {
    // Deployments apply ordered migrations before starting the service.
  }

  async insertMessage(
    input: Omit<BridgeMessage, "sequence" | "createdAt">,
  ): Promise<InsertMessageResult> {
    const values = [
      input.id,
      input.workspace,
      input.project ?? null,
      input.source,
      input.type,
      input.content,
      input.contentType,
      json(input.data),
      json(input.targets),
      input.threadId ?? null,
      input.replyToId ?? null,
      input.correlationId ?? null,
      input.causationId ?? null,
      input.priority,
      input.expiresAt ?? null,
      input.idempotencyKey ?? null,
      input.atribReceiptId ?? null,
      json(input.informedBy),
      json(input.metadata),
      input.deliveryPolicy.mode,
      input.deliveryPolicy.mode === "leased" ? input.deliveryPolicy.maxAttempts : null,
      input.deliveryPolicy.mode === "leased" ? input.deliveryPolicy.retryBaseDelayMs : null,
      input.deliveryPolicy.mode === "leased" ? input.deliveryPolicy.retryMaxDelayMs : null,
      input.deliveryPolicy.mode === "leased" ? input.deliveryPolicy.retryJitterRatio : null,
      input.deliveryPolicy.mode === "leased" ? input.deliveryPolicy.notBefore ?? null : null,
    ];

    const result = await this.db.query<Row>(
      `WITH inserted AS (
         INSERT INTO agent_bridge.messages (
           id, workspace, project, source, type, content, content_type, data, targets,
           thread_id, reply_to_id, correlation_id, causation_id, priority,
           expires_at, idempotency_key, atrib_receipt_id, informed_by, metadata,
           delivery_mode, delivery_max_attempts, delivery_retry_base_delay_ms,
           delivery_retry_max_delay_ms, delivery_retry_jitter_ratio, delivery_not_before
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
           $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb,
           $20, $21, $22, $23, $24, $25
         )
         ON CONFLICT (workspace, source, idempotency_key)
           WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING *, true AS created
       ), selected AS (
         SELECT * FROM inserted
         UNION ALL
         SELECT existing.*, false AS created
         FROM agent_bridge.messages existing
         WHERE $16::text IS NOT NULL
           AND existing.workspace = $2
           AND existing.source = $4
           AND existing.idempotency_key = $16
           AND NOT EXISTS (SELECT 1 FROM inserted)
         LIMIT 1
       ), delivery_rows AS (
         INSERT INTO agent_bridge.deliveries (
           id, message_id, workspace, publisher, recipient, state, available_at,
           created_at, priority_rank, last_actor, last_action
         )
         SELECT gen_random_uuid(), inserted.id, inserted.workspace, inserted.source, target, 'pending',
                greatest(now(), coalesce(inserted.delivery_not_before, now())),
                inserted.created_at,
                case inserted.priority when 'urgent' then 0 when 'high' then 1 else 2 end,
                inserted.source, 'created'
         FROM inserted
         CROSS JOIN LATERAL jsonb_array_elements_text(inserted.targets) AS target
         WHERE inserted.delivery_mode = 'leased'
         ON CONFLICT (message_id, recipient) DO NOTHING
       )
       SELECT * FROM selected`,
      values,
    );

    let row = result.rows[0];
    if (!row && input.idempotencyKey) {
      const existing = await this.db.query<Row>(
        `SELECT *, false AS created
         FROM agent_bridge.messages
         WHERE workspace=$1 AND source=$2 AND idempotency_key=$3`,
        [input.workspace, input.source, input.idempotencyKey],
      );
      row = existing.rows[0];
    }
    if (!row) throw new Error("message insert did not return a row");
    const message = asMessage(row);
    if (row.created !== true) assertIdempotentReplay(message, input);
    return { message, created: row.created === true };
  }

  async listMessages(
    principal: BridgePrincipal,
    query: MessageQuery = {},
  ): Promise<MessagePage> {
    const scope = cursorScope(principal, query);
    const cursor = decodeCursor(query.cursor, scope) ?? "0";
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
    const boundary = query.latest ? undefined : await this.db.query<{ sequence: string | null }>(
      "SELECT max(sequence)::text AS sequence FROM agent_bridge.messages WHERE workspace=$1",
      [principal.workspace],
    );
    const highWater = boundary?.rows[0]?.sequence;
    const values: unknown[] = query.latest
      ? [principal.workspace, principal.agent]
      : [principal.workspace, cursor, principal.agent];
    const mailbox = query.mailbox ?? "inbox";
    const agentParam = query.latest ? 2 : 3;
    const visibility = mailbox === "sent" ? `source=$${agentParam}`
      : mailbox === "all" ? `(source=$${agentParam} OR targets='[]'::jsonb OR targets ? $${agentParam})`
      : `(targets='[]'::jsonb OR targets ? $${agentParam})`;
    let sql = `SELECT * FROM agent_bridge.messages WHERE workspace=$1 ${query.latest ? "" : "AND sequence>$2::bigint "}AND ${visibility}`;

    if (highWater) {
      values.push(highWater);
      sql += ` AND sequence <= $${values.length}::bigint`;
    }

    if (!query.includeExpired) {
      sql += " AND (expires_at IS NULL OR expires_at > now())";
    }
    if (query.types?.length) {
      values.push(query.types);
      sql += ` AND type = ANY($${values.length})`;
    }
    if (query.source) {
      values.push(query.source);
      sql += ` AND source = $${values.length}`;
    }
    if (query.project) {
      values.push(query.project);
      sql += ` AND project = $${values.length}`;
    }
    if (query.since) {
      values.push(query.since);
      sql += ` AND created_at >= $${values.length}::timestamptz`;
    }
    if (query.receiptState && query.receiptState !== "any") {
      sql += ` AND ${query.receiptState === "unread" ? "NOT " : ""}EXISTS (
        SELECT 1 FROM agent_bridge.receipts receipt
        WHERE receipt.workspace=agent_bridge.messages.workspace
          AND receipt.message_id=agent_bridge.messages.id
          AND receipt.principal=$${agentParam}
      )`;
    }
    if (query.threadId) {
      values.push(query.threadId);
      sql += ` AND thread_id = $${values.length}`;
    }

    values.push(limit);
    const result = await this.db.query<Row>(
      `${sql} ORDER BY sequence ${query.latest ? "DESC" : "ASC"} LIMIT $${values.length}`,
      values,
    );
    const messages = result.rows.map(asMessage);
    const last = messages[messages.length - 1];
    if (query.latest) return { messages, cursor: messages[0] ? encodeCursor(messages[0].sequence, scope) : query.cursor };
    if (messages.length === limit) return { messages, cursor: encodeCursor(last!.sequence, scope) };
    return { messages, cursor: highWater ? encodeCursor(highWater, scope) : query.cursor };
  }

  async recordReceipt(
    principal: BridgePrincipal,
    ids: string[],
    readAt = new Date(),
  ): Promise<number> {
    const result = await this.db.query(
      `INSERT INTO agent_bridge.receipts (workspace, message_id, principal, read_at)
       SELECT message.workspace, message.id, $3, $4
       FROM agent_bridge.messages message
       WHERE message.workspace = $1 AND message.id = ANY($2::uuid[])
         AND (message.targets='[]'::jsonb OR message.targets ? $3)
       ON CONFLICT DO NOTHING`,
      [principal.workspace, ids, principal.agent, readAt],
    );
    return result.rowCount ?? 0;
  }

  async claimDelivery(
    principal: BridgePrincipal,
    options: ClaimOptions,
  ): Promise<BridgeDelivery | null> {
    return transaction(this.db, async (db) => {
      await db.query(
        `UPDATE agent_bridge.deliveries delivery
         SET state='dead', last_error='message expired', lease_token=NULL,
             lease_owner=NULL, lease_expires_at=NULL,
             last_actor='agent-bridge', last_action='message_expired'
         FROM agent_bridge.messages message
         WHERE delivery.workspace=$1 AND delivery.recipient=$2
           AND delivery.state IN ('pending','retrying','claimed')
           AND message.workspace=delivery.workspace AND message.id=delivery.message_id
           AND message.expires_at IS NOT NULL AND message.expires_at<=now()`,
        [principal.workspace, principal.agent],
      );
      await db.query(
        `UPDATE agent_bridge.deliveries delivery
         SET state='dead', last_error='maximum attempts reached', lease_token=NULL,
             lease_owner=NULL, lease_expires_at=NULL,
             last_actor='agent-bridge', last_action='attempts_exhausted'
         FROM agent_bridge.messages message
         WHERE delivery.workspace=$1 AND delivery.recipient=$2
           AND message.workspace=delivery.workspace AND message.id=delivery.message_id
           AND delivery.cycle_attempt>=message.delivery_max_attempts
           AND (delivery.state IN ('pending','retrying')
             OR (delivery.state='claimed' AND delivery.lease_expires_at<=now()))`,
        [principal.workspace, principal.agent],
      );
      await db.query(
        `UPDATE agent_bridge.deliveries delivery
         SET state='retrying', available_at=now(), lease_token=NULL,
             lease_owner=NULL, lease_expires_at=NULL,
             last_error='lease expired', last_actor='agent-bridge', last_action='lease_expired'
         FROM agent_bridge.messages message
         WHERE delivery.workspace=$1 AND delivery.recipient=$2
           AND message.workspace=delivery.workspace AND message.id=delivery.message_id
           AND delivery.state='claimed' AND delivery.lease_expires_at<=now()
           AND delivery.cycle_attempt<message.delivery_max_attempts`,
        [principal.workspace, principal.agent],
      );
      const candidate = await db.query<Row>(
        `SELECT delivery.id
         FROM agent_bridge.deliveries delivery
         JOIN agent_bridge.messages message
           ON message.workspace=delivery.workspace AND message.id=delivery.message_id
         WHERE delivery.workspace=$1 AND delivery.recipient=$2
           AND delivery.state IN ('pending','retrying')
           AND delivery.available_at<=now()
           AND delivery.cycle_attempt<message.delivery_max_attempts
           AND (message.expires_at IS NULL OR message.expires_at>now())
         ORDER BY delivery.priority_rank, delivery.available_at, delivery.created_at, delivery.id
         FOR UPDATE OF delivery SKIP LOCKED
         LIMIT 1`,
        [principal.workspace, principal.agent],
      );
      if (!candidate.rows[0]) return null;
      const token = randomUUID();
      const owner = principal.instance ?? principal.agent;
      const claimed = await db.query<Row>(
        `UPDATE agent_bridge.deliveries
         SET state='claimed', attempt=attempt+1, cycle_attempt=cycle_attempt+1,
             lease_token=$1, lease_owner=$2,
             lease_expires_at=now()+($3*interval '1 millisecond'),
             last_error=NULL, last_actor=$4, last_action='claim'
         WHERE id=$5
         RETURNING *`,
        [token, owner, options.leaseMs, principal.agent, candidate.rows[0].id],
      );
      return asDelivery(claimed.rows[0]!);
    });
  }

  async renewDelivery(
    principal: BridgePrincipal,
    id: string,
    token: string,
    leaseMs: number,
  ): Promise<BridgeDelivery | null> {
    const result = await this.db.query<Row>(
      `UPDATE agent_bridge.deliveries
       SET lease_expires_at=now() + ($1 * interval '1 millisecond')
       WHERE workspace=$2 AND recipient=$3 AND lease_owner=$4 AND id=$5 AND lease_token=$6
         AND state='claimed' AND lease_expires_at>now()
       RETURNING *`,
      [leaseMs, principal.workspace, principal.agent, principal.instance ?? principal.agent, id, token],
    );
    return result.rows[0] ? asDelivery(result.rows[0]) : null;
  }

  async settleDelivery(
    principal: BridgePrincipal,
    id: string,
    token: string,
    state: "acked" | "retrying" | "dead",
    error?: string,
    _retryPolicy?: import("./bridge-domain.js").RetryPolicy,
  ): Promise<BridgeDelivery | null> {
    const result = await this.db.query<Row>(
      `UPDATE agent_bridge.deliveries delivery
       SET state=CASE
             WHEN $1='retrying' AND cycle_attempt>=message.delivery_max_attempts THEN 'dead'
             ELSE $1
           END,
           available_at=CASE
             WHEN $1='retrying' AND cycle_attempt<message.delivery_max_attempts THEN
               now() + (
                 LEAST(message.delivery_retry_max_delay_ms::double precision,
                       message.delivery_retry_base_delay_ms::double precision * power(2, GREATEST(cycle_attempt - 1, 0)))
                 * (1 + ((random() * 2) - 1) * message.delivery_retry_jitter_ratio)
                 * interval '1 millisecond'
               )
             ELSE available_at
           END,
           last_error=$2, lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL,
           last_actor=$4,
           last_action=CASE
             WHEN $1='acked' THEN 'ack'
             WHEN $1='dead' THEN 'nack_dead'
             WHEN cycle_attempt>=message.delivery_max_attempts THEN 'attempts_exhausted'
             ELSE 'nack_retry'
           END
       FROM agent_bridge.messages message
       WHERE delivery.workspace=$3 AND delivery.recipient=$4 AND delivery.lease_owner=$5
         AND message.workspace=delivery.workspace AND message.id=delivery.message_id
         AND delivery.id=$6 AND delivery.lease_token=$7 AND delivery.state='claimed' AND delivery.lease_expires_at>now()
       RETURNING delivery.*`,
      [
        state,
        error?.slice(0, 1024) ?? null,
        principal.workspace,
        principal.agent,
        principal.instance ?? principal.agent,
        id,
        token,
      ],
    );
    return result.rows[0] ? asDelivery(result.rows[0]) : null;
  }

  async listDeliveries(principal: BridgePrincipal, query: DeliveryQuery = {}) {
    const filters = {
      role: query.role ?? "all",
      states: [...(query.states ?? [])].sort(),
      messageId: query.messageId ?? null,
      recipient: query.recipient ?? null,
    };
    const scope = scopedCursorScope("deliveries", principal, filters);
    const boundary = validateDeliveryCursorPosition(decodeScopedCursor(query.cursor, scope));
    const createdAt = boundary?.createdAt;
    const id = boundary?.id;
    const limit = query.limit ?? 50;
    const values: unknown[] = [principal.workspace, principal.agent];
    const clauses = ["delivery.workspace=$1"];
    const role = query.role ?? "all";
    clauses.push(role === "recipient" ? "delivery.recipient=$2" : role === "publisher" ? "message.source=$2" : "(delivery.recipient=$2 OR message.source=$2)");
    if (createdAt && id) {
      values.push(createdAt, id);
      clauses.push(`(delivery.created_at,delivery.id)>($${values.length - 1}::timestamptz,$${values.length}::uuid)`);
    }
    if (query.messageId) { values.push(query.messageId); clauses.push(`delivery.message_id=$${values.length}`); }
    if (query.recipient) { values.push(query.recipient); clauses.push(`delivery.recipient=$${values.length}`); }
    if (query.states?.length) { values.push(query.states); clauses.push(`delivery.state=ANY($${values.length}::text[])`); }
    values.push(limit);
    const result = await this.db.query<Row>(
      `SELECT delivery.* FROM agent_bridge.deliveries delivery
       JOIN agent_bridge.messages message ON message.workspace=delivery.workspace AND message.id=delivery.message_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY delivery.created_at,delivery.id LIMIT $${values.length}`,
      values,
    );
    const deliveries = result.rows.map(asDelivery);
    const last = deliveries[deliveries.length - 1];
    return { deliveries, cursor: deliveries.length === limit && last ? encodeScopedCursor(scope, { createdAt: last.createdAt, id: last.id }) : undefined };
  }

  async listDeliveryEvents(principal: BridgePrincipal, id: string, query: { cursor?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const scope = scopedCursorScope("delivery-events", principal, { deliveryId: id });
    const position = validateEventCursorPosition(decodeScopedCursor(query.cursor, scope));
    const result = await this.db.query<Row>(
      `SELECT event.* FROM agent_bridge.delivery_events event
       JOIN agent_bridge.messages message ON message.workspace=event.workspace AND message.id=event.message_id
       WHERE event.workspace=$1 AND event.delivery_id=$2 AND event.sequence>$3::bigint
         AND (event.recipient=$4 OR message.source=$4)
       ORDER BY event.sequence LIMIT $5`,
      [principal.workspace, id, position ?? "0", principal.agent, limit],
    );
    const events = result.rows.map(asDeliveryEvent);
    const last = events[events.length - 1];
    return { events, cursor: events.length === limit && last ? encodeScopedCursor(scope, last.sequence) : undefined };
  }

  async cancelDelivery(principal: BridgePrincipal, id: string) {
    return transaction(this.db, async (db) => {
      const visible = await db.query<Row>(
        `SELECT delivery.* FROM agent_bridge.deliveries delivery
         JOIN agent_bridge.messages message ON message.workspace=delivery.workspace AND message.id=delivery.message_id
         WHERE delivery.id=$1 AND delivery.workspace=$2 AND message.source=$3 FOR UPDATE OF delivery`,
        [id, principal.workspace, principal.agent],
      );
      const current = visible.rows[0];
      if (!current) return null;
      if (current.state === "cancelled") return asDelivery(current);
      if (!["pending", "retrying", "claimed"].includes(current.state)) {
        throw new DeliveryStateConflictError(`cannot cancel a ${current.state} delivery`);
      }
      const result = await db.query<Row>(
        `UPDATE agent_bridge.deliveries SET state='cancelled', lease_token=NULL,
         lease_owner=NULL, lease_expires_at=NULL, last_error=NULL,
         last_actor=$1, last_action='cancel' WHERE id=$2 RETURNING *`,
        [principal.agent, id],
      );
      return asDelivery(result.rows[0]!);
    });
  }

  async requeueDelivery(principal: BridgePrincipal, id: string) {
    return transaction(this.db, async (db) => {
      const visible = await db.query<Row>(
        `SELECT delivery.*,message.expires_at,message.delivery_not_before
         FROM agent_bridge.deliveries delivery
         JOIN agent_bridge.messages message ON message.workspace=delivery.workspace AND message.id=delivery.message_id
         WHERE delivery.id=$1 AND delivery.workspace=$2 AND message.source=$3 FOR UPDATE OF delivery`,
        [id, principal.workspace, principal.agent],
      );
      const current = visible.rows[0];
      if (!current) return null;
      if (!["dead", "cancelled"].includes(current.state)) {
        throw new DeliveryStateConflictError(`cannot requeue a ${current.state} delivery`);
      }
      if (current.expires_at && new Date(current.expires_at).getTime() <= Date.now()) {
        throw new DeliveryStateConflictError("cannot requeue an expired message");
      }
      const result = await db.query<Row>(
        `UPDATE agent_bridge.deliveries SET state='pending',
         available_at=greatest(now(),coalesce($1::timestamptz,now())),
         cycle_attempt=0,requeue_count=requeue_count+1,
         lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,
         last_actor=$2,last_action='requeue' WHERE id=$3 RETURNING *`,
        [current.delivery_not_before, principal.agent, id],
      );
      return asDelivery(result.rows[0]!);
    });
  }

  async diagnostics(principal: BridgePrincipal): Promise<BridgeDiagnostics> {
    const result = await this.db.query<Row>(
      `SELECT
         count(*) FILTER (WHERE state='pending')::integer AS pending,
         count(*) FILTER (WHERE state='claimed')::integer AS claimed,
         count(*) FILTER (WHERE state='retrying')::integer AS retrying,
         count(*) FILTER (WHERE state='dead')::integer AS dead,
         count(*) FILTER (WHERE state='cancelled')::integer AS cancelled,
         min(available_at) FILTER (WHERE state IN ('pending','retrying')) AS oldest_available,
         count(*) FILTER (WHERE state IN ('pending','retrying') AND available_at<=now())::integer AS due,
         count(*) FILTER (WHERE state IN ('pending','retrying') AND available_at>now())::integer AS scheduled,
         count(*) FILTER (WHERE state='claimed' AND lease_expires_at<=now())::integer AS expired_leases,
         min(available_at) FILTER (WHERE state IN ('pending','retrying') AND available_at<=now()) AS oldest_due,
         coalesce(greatest(0,extract(epoch FROM (now()-min(available_at) FILTER (WHERE state IN ('pending','retrying') AND available_at<=now())))*1000),0)::bigint AS queue_lag_ms
       FROM agent_bridge.deliveries WHERE workspace=$1 AND recipient=$2`,
      [principal.workspace, principal.agent],
    );
    const queue = result.rows[0] ?? {};
    return {
      schemaVersion: "postgres-v2",
      deliverySupported: true,
      pending: Number(queue.pending ?? 0),
      claimed: Number(queue.claimed ?? 0),
      retrying: Number(queue.retrying ?? 0),
      dead: Number(queue.dead ?? 0),
      cancelled: Number(queue.cancelled ?? 0),
      oldestAvailableAt: asTimestamp(queue.oldest_available),
      due: Number(queue.due ?? 0),
      scheduled: Number(queue.scheduled ?? 0),
      expiredLeases: Number(queue.expired_leases ?? 0),
      oldestDueAt: asTimestamp(queue.oldest_due),
      queueLagMs: Number(queue.queue_lag_ms ?? 0),
    };
  }

  async heartbeat(principal: BridgePrincipal, leaseMs: number, runtimeType?: string, capabilities: string[] = []): Promise<AgentPresence> {
    await this.db.query(
      "DELETE FROM agent_bridge.agent_instances WHERE workspace=$1 AND lease_expires_at<=now()",
      [principal.workspace],
    );
    const result = await this.db.query<Row>(
      `WITH locked AS (
         SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
       )
       INSERT INTO agent_bridge.agent_instances (workspace,agent,instance,runtime_type,capabilities,lease_expires_at,last_seen_at)
       SELECT $1,$2,$3,$4,$5::jsonb,now() + ($6 * interval '1 millisecond'),now()
       FROM locked
       WHERE EXISTS (
         SELECT 1 FROM agent_bridge.agent_instances
         WHERE workspace=$1 AND agent=$2 AND instance=$3
       ) OR ((
         SELECT count(*) < 128 FROM agent_bridge.agent_instances
         WHERE workspace=$1 AND agent=$2
       ) AND (
         SELECT count(*) < 4096 FROM agent_bridge.agent_instances
         WHERE workspace=$1
       )
       )
       ON CONFLICT (workspace,agent,instance) DO UPDATE SET runtime_type=excluded.runtime_type,capabilities=excluded.capabilities,lease_expires_at=excluded.lease_expires_at,last_seen_at=excluded.last_seen_at
       RETURNING *`,
      [principal.workspace, principal.agent, principal.instance, runtimeType ?? null, JSON.stringify(capabilities), leaseMs],
    );
    if (!result.rows[0]) {
      throw Object.assign(new Error("active instance limit reached"), {
        status: 429,
        code: "presence_limit",
      });
    }
    return asPresence(result.rows[0]!);
  }

  async listPresence(principal: BridgePrincipal): Promise<AgentPresence[]> {
    await this.db.query(
      "DELETE FROM agent_bridge.agent_instances WHERE workspace=$1 AND lease_expires_at<=now()",
      [principal.workspace],
    );
    const result = await this.db.query<Row>(
      "SELECT * FROM agent_bridge.agent_instances WHERE workspace=$1 ORDER BY agent,instance",
      [principal.workspace],
    );
    return result.rows.map(asPresence);
  }

}
