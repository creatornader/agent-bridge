import { decodeCursor, encodeCursor, type BridgeDelivery, type BridgeMessage, type BridgePrincipal, type RetryPolicy } from "./bridge-domain.js";
import type {
  BridgeStore,
  BridgeDiagnostics,
  ClaimOptions,
  InsertMessageResult,
  MessagePage,
  MessageQuery,
} from "./bridge-store.js";
import { legacyMessageIdFromSequence, legacySequenceFromMessageId } from "./legacy-compat.js";
import { assertIdempotentReplay } from "./idempotency.js";

type LegacyRow = Record<string, any>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class LegacySupabaseError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Legacy Supabase request failed: ${code}`);
  }
}

function messageId(row: LegacyRow): string {
  const envelopeId = row.metadata?.message_envelope?.message_id;
  return typeof envelopeId === "string" && UUID_RE.test(envelopeId)
    ? envelopeId
    : legacyMessageIdFromSequence(String(row.id));
}

function isVisible(row: LegacyRow, principal: BridgePrincipal, query: MessageQuery): boolean {
  const envelope = row.metadata?.message_envelope;
  const targets = Array.isArray(envelope?.target_agents) ? envelope.target_agents : [];
  if (targets.length && !targets.includes(principal.agent)) return false;

  const type = envelope?.kind ?? row.category;
  if (query.types?.length && !query.types.includes(type)) return false;
  if (query.threadId && envelope?.thread_id !== query.threadId) return false;

  const expiresAt = envelope?.expires_at;
  if (!query.includeExpired && expiresAt && new Date(expiresAt).getTime() <= Date.now()) return false;
  return true;
}

function asMessage(row: LegacyRow, principal: BridgePrincipal): BridgeMessage {
  const envelope = row.metadata?.message_envelope;
  return {
    id: messageId(row),
    sequence: String(row.id),
    workspace: principal.workspace,
    project: row.project ?? undefined,
    source: row.source,
    type: envelope?.kind ?? row.category,
    content: row.content,
    contentType: envelope?.payload_mime ?? "text/plain",
    data: envelope?.payload,
    targets: envelope?.target_agents ?? [],
    threadId: envelope?.thread_id,
    replyToId: envelope?.reply_to_id,
    correlationId: envelope?.correlation_id,
    causationId: envelope?.causation_id,
    priority: row.priority ?? "info",
    expiresAt: envelope?.expires_at,
    idempotencyKey: envelope?.idempotency_key,
    atribReceiptId: row.atrib_receipt_id ?? envelope?.atrib_receipt_id,
    informedBy: envelope?.informed_by,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export class LegacySupabaseRestStore implements BridgeStore {
  private readonly legacyIds = new Map<string, string>();
  private initialized = false;

  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    const parsed = new URL(url);
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      throw new Error("Agent Bridge requires HTTPS for non-loopback legacy providers");
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("/shared_context?select=id&limit=1");
    this.initialized = true;
  }

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    try {
      const response = await this.fetchImpl(`${this.url.replace(/\/$/, "")}/rest/v1${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          ...(init.headers ?? {}),
        },
      });
      if (!response.ok) {
        throw new LegacySupabaseError(response.status, "provider_error");
      }
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } catch (error) {
      if (error instanceof LegacySupabaseError) throw error;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new LegacySupabaseError(504, "request_timeout");
      }
      throw new LegacySupabaseError(0, "network_error");
    }
  }

  async insertMessage(
    input: Omit<BridgeMessage, "sequence" | "createdAt">,
  ): Promise<InsertMessageResult> {
    if (input.idempotencyKey) {
      throw new Error(
        "legacy Supabase mode cannot enforce idempotency keys; migrate to shared mode",
      );
    }
    const existingMetadata = input.metadata &&
      typeof input.metadata === "object" &&
      !Array.isArray(input.metadata)
      ? input.metadata
      : {};
    const existingEnvelope = existingMetadata.message_envelope &&
      typeof existingMetadata.message_envelope === "object"
      ? existingMetadata.message_envelope as Record<string, unknown>
      : {};
    const storedMetadata = JSON.parse(JSON.stringify({
      ...existingMetadata,
      message_envelope: {
        ...existingEnvelope,
        schema: "agent-bridge.message-envelope.v1",
        message_id: input.id,
        source_agent: input.source,
        kind: input.type,
        payload_mime: input.contentType,
        payload: input.data,
        target_agents: input.targets,
        thread_id: input.threadId,
        reply_to_id: input.replyToId,
        correlation_id: input.correlationId,
        causation_id: input.causationId,
        expires_at: input.expiresAt,
        informed_by: input.informedBy,
      },
    }));
    const body = {
      source: input.source,
      category: input.type,
      content: input.content,
      priority: input.priority,
      project: input.project ?? null,
      metadata: storedMetadata,
      atrib_receipt_id: input.atribReceiptId,
    };
    const lookup = encodeURIComponent(
      JSON.stringify({ message_envelope: { message_id: input.id } }),
    );
    const existing = await this.request(
      `/shared_context?metadata=cs.${lookup}&order=id.asc&limit=1`,
    );
    if (existing[0]) {
      const message = asMessage(existing[0], { workspace: input.workspace, agent: input.source });
      assertIdempotentReplay(message, { ...input, metadata: storedMetadata });
      this.legacyIds.set(message.id, String(existing[0].id));
      return { created: false, message };
    }
    const rows = await this.request("/shared_context", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const row = rows[0];
    this.legacyIds.set(input.id, String(row.id));
    return {
      created: true,
      message: { ...input, sequence: String(row.id), createdAt: row.created_at },
    };
  }

  async listMessages(
    principal: BridgePrincipal,
    query: MessageQuery = {},
  ): Promise<MessagePage> {
    const limit = query.limit ?? 50;
    let after = decodeCursor(query.cursor) ?? "0";
    let before: string | undefined;
    let latestCursor: string | undefined;
    const messages: BridgeMessage[] = [];

    while (messages.length < limit) {
      const batchLimit = Math.min(Math.max(limit * 2, 50), 200);
      const workspaceFilter = query.project
        ? `&project=eq.${encodeURIComponent(query.project)}`
        : "";
      const sourceFilter = query.source
        ? `&source=eq.${encodeURIComponent(query.source)}`
        : "";
      const sinceFilter = query.since
        ? `&created_at=gte.${encodeURIComponent(query.since)}`
        : "";
      const unacknowledgedFilter = query.unacknowledgedBy
        ? `&acked_by=not.cs.%7B${encodeURIComponent(query.unacknowledgedBy)}%7D`
        : "";
      const cursorFilter = query.latest
        ? before ? `&id=lt.${encodeURIComponent(before)}` : ""
        : `&id=gt.${encodeURIComponent(after)}`;
      const rows = (await this.request(
        `/shared_context?select=*${cursorFilter}` +
          `${workspaceFilter}${sourceFilter}${sinceFilter}${unacknowledgedFilter}` +
          `&order=id.${query.latest ? "desc" : "asc"}&limit=${batchLimit}`,
      )) as LegacyRow[];
      if (!rows.length) break;
      if (query.latest && latestCursor === undefined) latestCursor = String(rows[0].id);

      for (const row of rows) {
        after = String(row.id);
        const id = messageId(row);
        this.legacyIds.set(id, after);
        if (isVisible(row, principal, query)) messages.push(asMessage(row, principal));
        if (messages.length === limit) break;
      }
      if (query.latest) before = String(rows[rows.length - 1]!.id);
      if (rows.length < batchLimit || messages.length === limit) break;
    }

    const next = query.latest ? latestCursor : after === "0" ? undefined : after;
    return { messages, cursor: next ? encodeCursor(next) : query.cursor };
  }

  async recordReceipt(_workspace: string, ids: string[], principal: string): Promise<number> {
    const entryIds = await Promise.all(ids.map(async (id) => {
      const mapped = this.legacyIds.get(id);
      if (mapped) return mapped;
      const lookup = encodeURIComponent(JSON.stringify({ message_envelope: { message_id: id } }));
      const rows = await this.request(`/shared_context?select=id,metadata&metadata=cs.${lookup}&limit=2`);
      if (Array.isArray(rows) && rows.length === 1) {
        const sequence = String(rows[0].id);
        this.legacyIds.set(id, sequence);
        return sequence;
      }
      if (Array.isArray(rows) && rows.length > 1) {
        throw new LegacySupabaseError(409, "ambiguous_message_id");
      }
      const decodedSequence = legacySequenceFromMessageId(id);
      if (decodedSequence !== undefined) return decodedSequence;
      throw new LegacySupabaseError(404, "message_not_found");
    }));
    return this.request("/rpc/ack_context", {
      method: "POST",
      body: JSON.stringify({ entry_ids: entryIds, agent_name: principal }),
    });
  }

  async recordLegacyReceipt(ids: string[], principal: string): Promise<number> {
    const entryIds = ids.map((id) => {
      if (!/^\d+$/.test(id)) throw new Error("legacy receipt IDs must be numeric");
      const value = BigInt(id);
      if (value > 0x7fffffffffffffffn) throw new Error("legacy receipt ID exceeds bigint range");
      return value.toString();
    });
    return this.request("/rpc/ack_context", {
      method: "POST",
      body: JSON.stringify({ entry_ids: entryIds, agent_name: principal }),
    });
  }

  async claimDelivery(
    _principal: BridgePrincipal,
    _options: ClaimOptions,
  ): Promise<BridgeDelivery | null> {
    throw new Error("legacy Supabase adapter does not support deliveries");
  }

  async renewDelivery(
    _principal: BridgePrincipal,
    _deliveryId: string,
    _leaseToken: string,
    _leaseMs: number,
  ): Promise<BridgeDelivery | null> {
    throw new Error("legacy Supabase adapter does not support deliveries");
  }

  async settleDelivery(
    _principal: BridgePrincipal,
    _deliveryId: string,
    _leaseToken: string,
    _state: "acked" | "retrying" | "dead",
    _error: string | undefined,
    _retryPolicy: RetryPolicy,
  ): Promise<BridgeDelivery | null> {
    throw new Error("legacy Supabase adapter does not support deliveries");
  }

  async diagnostics(_principal: BridgePrincipal): Promise<BridgeDiagnostics> {
    return { schemaVersion: "legacy-v1", deliverySupported: false, pending: null, claimed: null, retrying: null, dead: null };
  }
}
