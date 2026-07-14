import { randomUUID } from "node:crypto";
import {
  decodeCursor,
  encodeCursor,
  cursorScope,
  type AgentPresence,
  type BridgeDelivery,
  type BridgeDeliveryEvent,
  type BridgeMessage,
  type BridgePrincipal,
  type RetryPolicy,
} from "./bridge-domain.js";
import type {
  BridgeStore,
  BridgeDiagnostics,
  ClaimOptions,
  InsertMessageResult,
  MessagePage,
  MessageQuery,
} from "./bridge-store.js";
import { assertIdempotentReplay } from "./idempotency.js";

export interface PgQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
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
    availableAt: asTimestamp(row.available_at) ?? "",
    leaseToken: row.lease_token ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: asTimestamp(row.lease_expires_at),
    lastError: row.last_error ?? undefined,
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
    recipient: String(row.recipient), fromState: row.from_state as BridgeDeliveryEvent["fromState"],
    toState: row.to_state as BridgeDeliveryEvent["toState"], attempt: Number(row.attempt),
    leaseOwner: row.lease_owner ?? undefined, error: row.error ?? undefined,
    createdAt: asTimestamp(row.created_at) ?? "",
  };
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
    ];

    const result = await this.db.query<Row>(
      `WITH inserted AS (
         INSERT INTO agent_bridge.messages (
           id, workspace, project, source, type, content, content_type, data, targets,
           thread_id, reply_to_id, correlation_id, causation_id, priority,
           expires_at, idempotency_key, atrib_receipt_id, informed_by, metadata
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
           $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb
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
           id, message_id, workspace, recipient, state, available_at
         )
         SELECT gen_random_uuid(), inserted.id, inserted.workspace, target, 'pending', now()
         FROM inserted
         CROSS JOIN LATERAL jsonb_array_elements_text(inserted.targets) AS target
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
    const owner = principal.instance ?? principal.agent;
    const token = randomUUID();
    const result = await this.db.query<Row>(
      `WITH expired AS (
         UPDATE agent_bridge.deliveries delivery
         SET state='dead', last_error='message expired', lease_token=NULL,
             lease_owner=NULL, lease_expires_at=NULL
         FROM agent_bridge.messages message
         WHERE delivery.workspace=$1 AND delivery.recipient=$2
           AND delivery.state IN ('pending', 'retrying', 'claimed')
           AND message.workspace=delivery.workspace AND message.id=delivery.message_id
           AND message.expires_at IS NOT NULL AND message.expires_at <= now()
         RETURNING delivery.id
       ), exhausted AS (
         UPDATE agent_bridge.deliveries delivery
         SET state='dead', last_error='maximum attempts reached', lease_token=NULL,
             lease_owner=NULL, lease_expires_at=NULL
         WHERE delivery.workspace=$1 AND delivery.recipient=$2 AND delivery.attempt >= $6
           AND (
             delivery.state IN ('pending', 'retrying')
             OR (delivery.state='claimed' AND delivery.lease_expires_at <= now())
           )
         RETURNING delivery.id
       ), candidate AS (
         SELECT delivery.id
         FROM agent_bridge.deliveries delivery
         JOIN agent_bridge.messages message
           ON message.workspace=delivery.workspace AND message.id=delivery.message_id
         WHERE delivery.workspace=$1 AND delivery.recipient=$2
           AND (
             (delivery.state IN ('pending', 'retrying') AND delivery.available_at <= now())
             OR (delivery.state='claimed' AND delivery.lease_expires_at <= now())
           )
           AND delivery.attempt < $6
           AND (message.expires_at IS NULL OR message.expires_at > now())
         ORDER BY delivery.available_at, delivery.id
         FOR UPDATE OF delivery SKIP LOCKED
         LIMIT 1
       )
       UPDATE agent_bridge.deliveries delivery
       SET state='claimed', attempt=delivery.attempt+1, lease_token=$3,
           lease_owner=$4, lease_expires_at=now() + ($5 * interval '1 millisecond')
       FROM candidate
       WHERE delivery.id=candidate.id
       RETURNING delivery.*`,
      [principal.workspace, principal.agent, token, owner, options.leaseMs, options.maxAttempts ?? 5],
    );
    return result.rows[0] ? asDelivery(result.rows[0]) : null;
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
    retryPolicy?: RetryPolicy,
  ): Promise<BridgeDelivery | null> {
    if (!retryPolicy) throw new Error("retry policy is required");
    const result = await this.db.query<Row>(
      `UPDATE agent_bridge.deliveries
       SET state=CASE
             WHEN $1='retrying' AND attempt >= $6 THEN 'dead'
             ELSE $1
           END,
           available_at=CASE
             WHEN $1='retrying' AND attempt < $6 THEN
               now() + (
                 LEAST($8::double precision, $7::double precision * power(2, GREATEST(attempt - 1, 0)))
                 * (1 + ((random() * 2) - 1) * $9::double precision)
                 * interval '1 millisecond'
               )
             ELSE available_at
           END,
           last_error=$2, lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL
       WHERE workspace=$3 AND recipient=$4 AND lease_owner=$5
         AND id=$10 AND lease_token=$11 AND state='claimed' AND lease_expires_at>now()
       RETURNING *`,
      [
        state,
        error?.slice(0, 1024) ?? null,
        principal.workspace,
        principal.agent,
        principal.instance ?? principal.agent,
        retryPolicy.maxAttempts,
        retryPolicy.baseDelayMs,
        retryPolicy.maxDelayMs,
        retryPolicy.jitterRatio,
        id,
        token,
      ],
    );
    return result.rows[0] ? asDelivery(result.rows[0]) : null;
  }

  async diagnostics(principal: BridgePrincipal): Promise<BridgeDiagnostics> {
    const result = await this.db.query<Row>(
      `SELECT state, count(*)::integer AS count, min(available_at) AS oldest
       FROM agent_bridge.deliveries
       WHERE workspace=$1 AND recipient=$2
       GROUP BY state`,
      [principal.workspace, principal.agent],
    );
    const counts = new Map(result.rows.map((row) => [String(row.state), Number(row.count)]));
    const oldest = result.rows
      .filter((row) => row.state === "pending" || row.state === "retrying")
      .map((row) => asTimestamp(row.oldest))
      .filter((value): value is string => Boolean(value))
      .sort()[0];
    return {
      schemaVersion: "postgres-v2",
      deliverySupported: true,
      pending: counts.get("pending") ?? 0,
      claimed: counts.get("claimed") ?? 0,
      retrying: counts.get("retrying") ?? 0,
      dead: counts.get("dead") ?? 0,
      oldestAvailableAt: oldest,
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

  async listDeliveryEvents(deliveryId: string): Promise<BridgeDeliveryEvent[]> {
    const result = await this.db.query<Row>(
      "SELECT * FROM agent_bridge.delivery_events WHERE delivery_id=$1 ORDER BY sequence",
      [deliveryId],
    );
    return result.rows.map(asDeliveryEvent);
  }
}
