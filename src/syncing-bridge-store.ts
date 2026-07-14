import type {
  BridgeDelivery,
  BridgeMessage,
  BridgePrincipal,
  DeliveryState,
  RetryPolicy,
} from "./bridge-domain.js";
import type {
  BridgeDiagnostics,
  BridgeStore,
  ClaimOptions,
  InsertMessageResult,
  MessagePage,
  MessageQuery,
} from "./bridge-store.js";
import {
  edgeMessageFingerprint,
  type PendingMessage,
  SQLiteEdgeStore,
} from "./sqlite-edge-store.js";

export interface SyncInsertResult extends InsertMessageResult {
  disposition: "committed" | "queued";
  authoritative: boolean;
}

export interface CachedMessagePage extends MessagePage {
  source: "remote" | "cache";
  stale: boolean;
  lastSyncedAt?: string;
}

export interface SyncReport {
  online: boolean;
  pushed: number;
  deduplicated: number;
  pulled: number;
  pending: number;
  blocked: number;
  cached: number;
  cursor?: string;
  lastSyncedAt?: string;
  lastError?: string;
  failureRetryable?: boolean;
}

export interface SyncDiagnostics extends BridgeDiagnostics {
  remoteReachable: boolean;
  outboxPending: number;
  outboxBlocked: number;
  cachedMessages: number;
  lastSyncAt?: string;
  lastSyncError?: string;
}

export interface SyncingBridgeStoreOptions {
  now?: () => Date;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  leaseMs?: number;
}

type FlushResult =
  | { state: "empty" }
  | { state: "committed"; result: InsertMessageResult; messageId: string }
  | { state: "retry"; error: Error; retryable: boolean }
  | { state: "blocked"; error: Error };

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = Number((error as { status?: unknown }).status);
  return Number.isFinite(status) ? status : undefined;
}

function codeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code.slice(0, 128);
  }
  return error instanceof Error ? error.name.slice(0, 128) : "sync_error";
}

export function isRetryableSyncError(error: unknown): boolean {
  const status = statusOf(error);
  const code = codeOf(error);
  if (["invalid_input", "idempotency_conflict", "principal_mismatch"].includes(code)) return false;
  return status === undefined || status === 0 || status === 408 || status === 425 ||
    status === 429 || status >= 500;
}

function provisional(draft: PendingMessage, createdAt: string): BridgeMessage {
  return { ...draft, sequence: "0", createdAt };
}

export class SyncingBridgeStore implements BridgeStore {
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly leaseMs: number;
  private remoteReady: Promise<void> | undefined;

  constructor(
    private readonly edge: SQLiteEdgeStore,
    private readonly remote: BridgeStore,
    private readonly principal: BridgePrincipal,
    options: SyncingBridgeStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 5 * 60_000;
    this.leaseMs = options.leaseMs ?? 30_000;
  }

  async initialize(): Promise<void> {
    // Remote readiness is intentionally deferred so clients can start offline.
    await this.edge.initialize();
  }

  async verifyRemote(): Promise<void> {
    await this.ensureRemote();
  }

  private async ensureRemote(): Promise<void> {
    if (!this.remoteReady) {
      this.remoteReady = this.remote.initialize().catch((error) => {
        this.remoteReady = undefined;
        throw error;
      });
    }
    await this.remoteReady;
  }

  private assertPrincipal(principal: BridgePrincipal, includeInstance = true): void {
    if (
      principal.workspace !== this.principal.workspace ||
      principal.agent !== this.principal.agent ||
      (includeInstance && principal.instance !== this.principal.instance)
    ) {
      const error = new Error("principal does not match the synchronized edge scope");
      Object.assign(error, { status: 403, code: "principal_mismatch" });
      throw error;
    }
  }

  private delay(attempts: number): number {
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(attempts, 20));
    const jitter = 0.8 + this.random() * 0.4;
    return Math.max(1, Math.round(exponential * jitter));
  }

  private async flushOne(): Promise<FlushResult> {
    try {
      await this.ensureRemote();
    } catch (error) {
      await this.edge.noteError(codeOf(error));
      return {
        state: "retry",
        error: error instanceof Error ? error : new Error(String(error)),
        retryable: isRetryableSyncError(error),
      };
    }
    const record = await this.edge.claimNext(this.now(), this.leaseMs);
    if (!record) return { state: "empty" };
    try {
      const result = await this.remote.insertMessage(record.draft);
      if (edgeMessageFingerprint(result.message) !== record.payloadHash) {
        const error = new Error("idempotency key resolved to different message content");
        Object.assign(error, { status: 409, code: "idempotency_conflict" });
        await this.edge.block(record, codeOf(error));
        return { state: "blocked", error };
      }
      const cacheVisible = result.message.targets.length === 0 ||
        result.message.targets.includes(this.principal.agent);
      await this.edge.commit(record, result.message, cacheVisible, this.now());
      return { state: "committed", result, messageId: record.draft.id };
    } catch (error) {
      const caught = error instanceof Error ? error : new Error(String(error));
      if (isRetryableSyncError(error)) {
        await this.edge.retry(
          record,
          codeOf(error),
          new Date(this.now().getTime() + this.delay(record.attempts)),
        );
        return { state: "retry", error: caught, retryable: true };
      }
      await this.edge.block(record, codeOf(error));
      return { state: "blocked", error: caught };
    }
  }

  async insertMessage(message: PendingMessage): Promise<SyncInsertResult> {
    this.assertPrincipal({ workspace: message.workspace, agent: message.source }, false);
    const queued = await this.edge.enqueue(message, this.now());
    const draft = queued.draft;
    const flushed = await this.flushOne();
    if (flushed.state === "blocked") throw flushed.error;
    if (flushed.state === "retry" && !flushed.retryable) throw flushed.error;
    if (flushed.state === "committed" && flushed.messageId === draft.id) {
      return { ...flushed.result, disposition: "committed", authoritative: true };
    }
    return {
      message: provisional(draft, this.now().toISOString()),
      created: queued.created,
      disposition: "queued",
      authoritative: false,
    };
  }

  private async pull(maxPages: number): Promise<{
    online: boolean;
    pulled: number;
    error?: Error;
    retryable?: boolean;
  }> {
    let pulled = 0;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const before = await this.edge.pullCursor();
      try {
        await this.ensureRemote();
        const page = await this.remote.listMessages(this.principal, {
          cursor: before,
          limit: 200,
          includeExpired: true,
        });
        await this.edge.cachePage(page.messages, page.cursor, this.now());
        pulled += page.messages.length;
        if (page.messages.length < 200 || !page.cursor || page.cursor === before) break;
      } catch (error) {
        await this.edge.noteError(codeOf(error));
        return {
          online: false,
          pulled,
          error: error instanceof Error ? error : new Error(String(error)),
          retryable: isRetryableSyncError(error),
        };
      }
    }
    return { online: true, pulled };
  }

  async sync(options: { maxPush?: number; maxPages?: number } = {}): Promise<SyncReport> {
    await this.edge.initialize();
    const maxPush = Math.min(Math.max(Math.trunc(options.maxPush ?? 100), 0), 1_000);
    const maxPages = Math.min(Math.max(Math.trunc(options.maxPages ?? 20), 0), 100);
    let pushed = 0;
    let deduplicated = 0;
    let online = true;
    let lastError: string | undefined;
    let failureRetryable: boolean | undefined;

    for (let index = 0; index < maxPush; index += 1) {
      const result = await this.flushOne();
      if (result.state === "empty") break;
      if (result.state === "committed") {
        pushed += 1;
        if (!result.result.created) deduplicated += 1;
        continue;
      }
      lastError = codeOf(result.error);
      failureRetryable = result.state === "retry" ? result.retryable : false;
      if (result.state === "retry") online = false;
      break;
    }

    let pulled = 0;
    if (maxPages > 0) {
      const pull = await this.pull(maxPages);
      online = online && pull.online;
      pulled = pull.pulled;
      if (pull.error) {
        lastError = codeOf(pull.error);
        failureRetryable = pull.retryable;
      }
    }

    const stats = await this.edge.stats();
    return {
      online,
      pushed,
      deduplicated,
      pulled,
      pending: stats.pending,
      blocked: stats.blocked,
      cached: stats.cached,
      cursor: stats.pullCursor,
      lastSyncedAt: stats.lastSyncAt,
      lastError: lastError ?? stats.lastError,
      failureRetryable,
    };
  }

  async listMessages(principal: BridgePrincipal, query: MessageQuery = {}): Promise<CachedMessagePage> {
    this.assertPrincipal(principal);
    if (query.unacknowledgedBy) {
      await this.ensureRemote();
      const remotePage = await this.remote.listMessages(principal, query);
      await this.edge.cacheLatest(remotePage.messages, this.now());
      const stats = await this.edge.stats();
      return { ...remotePage, source: "remote", stale: false, lastSyncedAt: stats.lastSyncAt };
    }
    if (query.latest) {
      try {
        await this.ensureRemote();
        const remotePage = await this.remote.listMessages(principal, query);
        await this.edge.cacheLatest(remotePage.messages, this.now());
        const stats = await this.edge.stats();
        return { ...remotePage, source: "remote", stale: false, lastSyncedAt: stats.lastSyncAt };
      } catch (error) {
        if (!isRetryableSyncError(error)) throw error;
        await this.edge.noteError(codeOf(error));
        const cached = await this.edge.list(query);
        const stats = await this.edge.stats();
        return { ...cached, source: "cache", stale: true, lastSyncedAt: stats.lastSyncAt };
      }
    }
    await this.sync({ maxPush: 20, maxPages: 0 });
    try {
      await this.ensureRemote();
      const remotePage = await this.remote.listMessages(principal, query);
      await this.edge.cacheLatest(remotePage.messages, this.now());
      const stats = await this.edge.stats();
      return { ...remotePage, source: "remote", stale: false, lastSyncedAt: stats.lastSyncAt };
    } catch (error) {
      if (!isRetryableSyncError(error)) throw error;
      await this.edge.noteError(codeOf(error));
      const cached = await this.edge.list(query);
      const stats = await this.edge.stats();
      return { ...cached, source: "cache", stale: true, lastSyncedAt: stats.lastSyncAt };
    }
  }

  async recordReceipt(
    workspace: string,
    messageIds: string[],
    principal: string,
    readAt?: Date,
  ): Promise<number> {
    this.assertPrincipal({ workspace, agent: principal }, false);
    await this.ensureRemote();
    return this.remote.recordReceipt(workspace, messageIds, principal, readAt);
  }

  async claimDelivery(principal: BridgePrincipal, options: ClaimOptions): Promise<BridgeDelivery | null> {
    this.assertPrincipal(principal);
    await this.ensureRemote();
    return this.remote.claimDelivery(principal, options);
  }

  async renewDelivery(
    principal: BridgePrincipal,
    deliveryId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<BridgeDelivery | null> {
    this.assertPrincipal(principal);
    await this.ensureRemote();
    return this.remote.renewDelivery(principal, deliveryId, leaseToken, leaseMs);
  }

  async settleDelivery(
    principal: BridgePrincipal,
    deliveryId: string,
    leaseToken: string,
    state: Extract<DeliveryState, "acked" | "retrying" | "dead">,
    error: string | undefined,
    retryPolicy: RetryPolicy,
  ): Promise<BridgeDelivery | null> {
    this.assertPrincipal(principal);
    await this.ensureRemote();
    return this.remote.settleDelivery(principal, deliveryId, leaseToken, state, error, retryPolicy);
  }

  async diagnostics(principal: BridgePrincipal): Promise<SyncDiagnostics> {
    this.assertPrincipal(principal);
    const edge = await this.edge.stats();
    let remote: BridgeDiagnostics | undefined;
    try {
      await this.ensureRemote();
      remote = await this.remote.diagnostics?.(principal);
    } catch {
      // Edge diagnostics remain available during an outage.
    }
    return {
      schemaVersion: remote?.schemaVersion ?? "postgres-v2",
      deliverySupported: remote?.deliverySupported ?? true,
      pending: remote?.pending ?? null,
      claimed: remote?.claimed ?? null,
      retrying: remote?.retrying ?? null,
      dead: remote?.dead ?? null,
      oldestAvailableAt: remote?.oldestAvailableAt,
      principal: { workspace: principal.workspace, agent: principal.agent },
      remoteReachable: Boolean(remote),
      outboxPending: edge.pending,
      outboxBlocked: edge.blocked,
      cachedMessages: edge.cached,
      lastSyncAt: edge.lastSyncAt,
      lastSyncError: edge.lastError,
    };
  }

  async heartbeat(principal: BridgePrincipal, leaseMs: number, runtimeType?: string, capabilities: string[] = []) {
    this.assertPrincipal(principal);
    await this.ensureRemote();
    if (!this.remote.heartbeat) throw new Error("presence is not supported by the remote provider");
    return this.remote.heartbeat(principal, leaseMs, runtimeType, capabilities);
  }

  async listPresence(principal: BridgePrincipal) {
    this.assertPrincipal(principal);
    await this.ensureRemote();
    if (!this.remote.listPresence) throw new Error("presence is not supported by the remote provider");
    return this.remote.listPresence(principal);
  }

  async close(): Promise<void> {
    await this.edge.close();
    await this.remote.close?.();
  }
}
