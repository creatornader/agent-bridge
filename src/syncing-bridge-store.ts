import type {
  BridgeDelivery,
  BridgeMessage,
  BridgePrincipal,
  DeliveryState,
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
  EdgeMigrationDrainingError,
  EdgeMigrationLeaseError,
  EdgeMigrationRetiredError,
  edgeMessageFingerprint,
  type EdgeDrainLease,
  type EdgeMigrationGateState,
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
  degraded: boolean;
  acknowledgements: "authoritative" | "unknown";
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
  migrationState?: EdgeMigrationGateState;
  migrationOperationId?: string;
  migrationLeaseExpiresAt?: string;
}

export interface SyncDiagnostics extends BridgeDiagnostics {
  remoteReachable: boolean | null;
  outboxPending: number;
  outboxBlocked: number;
  cachedMessages: number;
  lastSyncAt?: string;
  lastSyncError?: string;
  outboxDue: number;
  outboxScheduled: number;
  outboxLeased: number;
  outboxOldestDueAt?: string;
  outboxQueueLagMs: number;
  outboxOldestBlockedAt?: string;
  outboxBlockedAgeMs: number | null;
  outboxBlockedMaxAttempts: number;
  outboxBlockedLastError?: string;
  outboxNextRetryAt?: string;
  lastOutboundSyncAt?: string;
  lastInboundSyncAt?: string;
  lastSyncAttemptAt?: string;
  syncLoopState: "disabled" | "idle" | "running" | "backoff" | "paused" | "stopped" | "failed";
  syncLoopError?: string;
  remoteError?: string;
  migrationState: EdgeMigrationGateState;
  migrationOperationId?: string;
  migrationLeaseExpiresAt?: string;
}

export interface SyncingBridgeStoreOptions {
  now?: () => Date;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  leaseMs?: number;
  autoSync?: boolean;
  idleDelayMs?: number;
  edgeDrainLease?: EdgeDrainLease;
  /** A maintenance caller may retain the edge while closing the sync wrapper. */
  closeEdge?: boolean;
}

type FlushResult =
  | { state: "empty" }
  | { state: "committed"; result: InsertMessageResult; messageId: string }
  | { state: "retry"; error: Error; retryable: boolean }
  | { state: "blocked"; error: Error; messageId: string }
  | { state: "paused"; error: EdgeMigrationDrainingError | EdgeMigrationRetiredError | EdgeMigrationLeaseError }
  | { state: "fatal"; error: Error };

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
  if (["network_error", "request_timeout"].includes(code)) return true;
  if (["invalid_input", "idempotency_conflict", "edge_idempotency_conflict", "principal_mismatch", "protocol_mismatch", "store_closed", "client_migration_draining", "client_migration_retired", "client_migration_lease_lost"].includes(code)) return false;
  return status === 0 || status === 408 || status === 425 ||
    status === 429 || (status !== undefined && status >= 500);
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
  private readonly autoSync: boolean;
  private readonly idleDelayMs: number;
  private edgeDrainLease?: EdgeDrainLease;
  private readonly closeEdge: boolean;
  private remoteReady: Promise<void> | undefined;
  private stopped = false;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private wake: (() => void) | undefined;
  private background: Promise<void> | undefined;
  private readonly closeController = new AbortController();
  private backgroundError: unknown;
  private wakeRequested = false;
  private remoteReachable: boolean | null = null;
  private loopState: SyncDiagnostics["syncLoopState"];

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
    this.autoSync = options.autoSync ?? true;
    this.idleDelayMs = Math.max(this.baseDelayMs + 1, options.idleDelayMs ?? 30_000);
    this.edgeDrainLease = options.edgeDrainLease;
    this.closeEdge = options.closeEdge ?? true;
    this.loopState = this.autoSync ? "idle" : "disabled";
  }

  async initialize(): Promise<void> {
    // Remote readiness is intentionally deferred so clients can start offline.
    await this.edge.initialize();
    if (this.autoSync) this.startTransportLoop();
  }

  /** Replace a renewed maintenance lease without creating another edge wrapper. */
  setDrainLease(lease: EdgeDrainLease | undefined): void {
    this.edgeDrainLease = lease;
  }

  private startTransportLoop(): void {
    if (this.background) return;
    this.background = this.transportLoop().catch((error) => {
      this.backgroundError = error;
      this.loopState = "failed";
    });
  }

  private async wait(delayMs: number): Promise<void> {
    if (this.stopped) return;
    if (this.wakeRequested) {
      this.wakeRequested = false;
      return;
    }
    await new Promise<void>((resolve) => {
      this.wake = resolve;
      this.wakeTimer = setTimeout(resolve, delayMs);
      this.wakeTimer.unref?.();
    });
    this.wake = undefined;
    this.wakeTimer = undefined;
  }

  private wakeTransport(): void {
    if (this.wake) {
      if (this.wakeTimer) clearTimeout(this.wakeTimer);
      this.wake();
    }
    else this.wakeRequested = true;
  }

  private fatal(error: unknown): Error {
    if (this.backgroundError instanceof Error) return this.backgroundError;
    const cause = error instanceof Error ? error : new Error(String(error));
    const fatal = Object.assign(new Error(`fatal local edge failure: ${cause.message}`), {
      code: "local_edge_commit_failed",
      cause,
    });
    this.backgroundError = fatal;
    return fatal;
  }

  private assertHealthy(): void {
    if (this.backgroundError) throw this.backgroundError;
  }

  private async transportLoop(): Promise<void> {
    let failures = 0;
    await this.wait(this.delay(0));
    while (!this.stopped) {
      this.loopState = "running";
      const report = await this.sync({ maxPush: 100, maxPages: 1, signal: this.closeController.signal });
      if (this.stopped) break;
      if (report.migrationState !== "active" && !this.edgeDrainLease) {
        this.loopState = "paused";
        await this.wait(this.idleDelayMs);
        continue;
      }
      if (report.failureRetryable === false) {
        this.backgroundError = Object.assign(
          new Error(`gateway synchronization failed permanently: ${report.lastError ?? "sync_error"}`),
          { code: report.lastError ?? "sync_error" },
        );
        this.loopState = "failed";
        return;
      }
      failures = report.online ? 0 : Math.min(failures + 1, 20);
      this.loopState = report.online ? "idle" : "backoff";
      await this.wait(report.pending > 0 ? this.delay(Math.max(0, failures - 1)) : this.idleDelayMs);
    }
  }

  async verifyRemote(): Promise<void> {
    await this.ensureRemote();
  }

  private async ensureRemote(signal?: AbortSignal): Promise<void> {
    if (!this.remoteReady) {
      this.remoteReady = this.remote.initialize({ signal }).catch((error) => {
        this.remoteReady = undefined;
        throw error;
      });
    }
    try {
      await this.remoteReady;
      this.remoteReachable = true;
    } catch (error) {
      this.remoteReachable = false;
      throw error;
    }
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

  private cancelled(signal?: AbortSignal): boolean {
    return this.stopped || Boolean(signal?.aborted);
  }

  private async flushOne(signal?: AbortSignal): Promise<FlushResult> {
    await this.edge.noteAttempt(this.now());
    try {
      if (this.edgeDrainLease) await this.edge.assertDrainLease(this.edgeDrainLease, this.now());
      else await this.edge.assertScopeActive();
    } catch (error) {
      if (error instanceof EdgeMigrationDrainingError
        || error instanceof EdgeMigrationRetiredError
        || error instanceof EdgeMigrationLeaseError) return { state: "paused", error };
      throw error;
    }
    try {
      await this.ensureRemote(signal);
    } catch (error) {
      await this.edge.noteError(codeOf(error));
      return {
        state: "retry",
        error: error instanceof Error ? error : new Error(String(error)),
        retryable: isRetryableSyncError(error),
      };
    }
    let record;
    try {
      record = await this.edge.claimNext(this.now(), this.leaseMs, this.edgeDrainLease);
    } catch (error) {
      if (error instanceof EdgeMigrationDrainingError
        || error instanceof EdgeMigrationRetiredError
        || error instanceof EdgeMigrationLeaseError) return { state: "paused", error };
      throw error;
    }
    if (!record) return { state: "empty" };
    try {
      const result = await this.remote.insertMessage(record.draft, { signal });
      this.remoteReachable = true;
      if (result.message.id !== record.draft.id) {
        const error = new Error("idempotency key resolved to a different message ID");
        Object.assign(error, { status: 409, code: "idempotency_conflict" });
        await this.edge.block(record, codeOf(error), this.now());
        return { state: "blocked", error, messageId: record.draft.id };
      }
      if (edgeMessageFingerprint(result.message) !== record.payloadHash) {
        const error = new Error("idempotency key resolved to different message content");
        Object.assign(error, { status: 409, code: "idempotency_conflict" });
        await this.edge.block(record, codeOf(error), this.now());
        return { state: "blocked", error, messageId: record.draft.id };
      }
      try {
        await this.edge.commit(record, result.message, this.now());
      } catch (error) {
        return { state: "fatal", error: this.fatal(error) };
      }
      return { state: "committed", result, messageId: record.draft.id };
    } catch (error) {
      const caught = error instanceof Error ? error : new Error(String(error));
      this.remoteReachable = isRetryableSyncError(error) ? false : true;
      if (this.cancelled(signal)) {
        await this.edge.retry(record, "request_cancelled", this.now());
        return { state: "retry", error: caught, retryable: true };
      }
      if (isRetryableSyncError(error)) {
        await this.edge.retry(
          record,
          codeOf(error),
          new Date(this.now().getTime() + this.delay(record.attempts)),
        );
        return { state: "retry", error: caught, retryable: true };
      }
      await this.edge.block(record, codeOf(error), this.now());
      return { state: "blocked", error: caught, messageId: record.draft.id };
    }
  }

  async insertMessage(message: PendingMessage): Promise<SyncInsertResult> {
    this.assertHealthy();
    this.assertPrincipal({ workspace: message.workspace, agent: message.source }, false);
    // A drain lease authorizes only claimNext for work that existed before the
    // gate closed. It never authorizes new publication or an early remote call.
    await this.edge.assertScopeActive();
    let remoteError: unknown;
    try {
      await this.ensureRemote();
    } catch (error) {
      if (!isRetryableSyncError(error)) throw error;
      remoteError = error;
    }
    const queued = await this.edge.enqueue(message, this.now());
    const draft = queued.draft;
    if (remoteError) {
      await this.edge.noteError(codeOf(remoteError));
      this.wakeTransport();
      return {
        message: provisional(draft, this.now().toISOString()),
        created: queued.created,
        disposition: "queued",
        authoritative: false,
      };
    }
    const flushed = await this.flushOne();
    if (flushed.state === "fatal") throw flushed.error;
    if (flushed.state === "blocked" && flushed.messageId === draft.id) throw flushed.error;
    if (flushed.state === "retry" && !flushed.retryable) throw flushed.error;
    if (flushed.state === "committed" && flushed.messageId === draft.id) {
      return { ...flushed.result, disposition: "committed", authoritative: true };
    }
    this.wakeTransport();
    return {
      message: provisional(draft, this.now().toISOString()),
      created: queued.created,
      disposition: "queued",
      authoritative: false,
    };
  }

  async enqueueMessage(message: PendingMessage): Promise<SyncInsertResult & { disposition: "queued"; authoritative: false }> {
    this.assertHealthy();
    this.assertPrincipal({ workspace: message.workspace, agent: message.source }, false);
    await this.edge.assertScopeActive();
    const queued = await this.edge.enqueue(message, this.now());
    return {
      message: provisional(queued.draft, this.now().toISOString()),
      created: queued.created,
      disposition: "queued",
      authoritative: false,
    };
  }

  private async pull(maxPages: number, signal?: AbortSignal): Promise<{
    online: boolean;
    pulled: number;
    error?: Error;
    retryable?: boolean;
  }> {
    let pulled = 0;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      if (this.cancelled(signal)) break;
      const before = await this.edge.pullCursor();
      let page: MessagePage;
      try {
        await this.ensureRemote(signal);
        page = await this.remote.listMessages(this.principal, {
          cursor: before,
          limit: 200,
          includeExpired: true,
          mailbox: "all",
        }, { signal });
        this.remoteReachable = true;
      } catch (error) {
        this.remoteReachable = isRetryableSyncError(error) ? false : true;
        await this.edge.noteError(codeOf(error));
        return {
          online: false,
          pulled,
          error: error instanceof Error ? error : new Error(String(error)),
          retryable: isRetryableSyncError(error),
        };
      }
      try {
        await this.edge.cachePage(page.messages, page.cursor, this.now());
      } catch (error) {
        throw this.fatal(error);
      }
      pulled += page.messages.length;
      if (page.messages.length < 200 || !page.cursor || page.cursor === before) break;
    }
    return { online: true, pulled };
  }

  async sync(options: { maxPush?: number; maxPages?: number; signal?: AbortSignal } = {}): Promise<SyncReport> {
    this.assertHealthy();
    await this.edge.initialize();
    await this.edge.noteAttempt(this.now());
    const maxPush = Math.min(Math.max(Math.trunc(options.maxPush ?? 100), 0), 1_000);
    const maxPages = Math.min(Math.max(Math.trunc(options.maxPages ?? 20), 0), 100);
    let pushed = 0;
    let deduplicated = 0;
    let online = true;
    let lastError: string | undefined;
    let failureRetryable: boolean | undefined;

    if (options.signal?.aborted) {
      const stats = await this.edge.stats(this.now());
      return {
        online: false, pushed: 0, deduplicated: 0, pulled: 0,
        pending: stats.pending, blocked: stats.blocked, cached: stats.cached,
        cursor: stats.pullCursor, lastSyncedAt: stats.lastSyncAt,
        lastError: "request_cancelled", failureRetryable: true,
      };
    }

    for (let index = 0; index < maxPush; index += 1) {
      if (this.cancelled(options.signal)) break;
      const result = await this.flushOne(options.signal);
      if (result.state === "empty") break;
      if (result.state === "committed") {
        pushed += 1;
        if (!result.result.created) deduplicated += 1;
        continue;
      }
      if (result.state === "fatal") throw result.error;
      if (result.state === "paused") {
        lastError = codeOf(result.error);
        break;
      }
      lastError = codeOf(result.error);
      failureRetryable = result.state === "retry" ? result.retryable : undefined;
      if (result.state === "retry") online = false;
      if (result.state === "retry") break;
    }

    let pulled = 0;
    if (maxPages > 0 && !this.cancelled(options.signal) && !lastError?.startsWith("client_migration_")) {
      const pull = await this.pull(maxPages, options.signal);
      online = online && pull.online;
      pulled = pull.pulled;
      if (pull.error) {
        lastError = codeOf(pull.error);
        failureRetryable = pull.retryable;
      }
    }

    const stats = await this.edge.stats(this.now());
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
      migrationState: stats.migrationState,
      migrationOperationId: stats.migrationOperationId,
      migrationLeaseExpiresAt: stats.migrationLeaseExpiresAt,
    };
  }

  async listMessages(principal: BridgePrincipal, query: MessageQuery = {}): Promise<CachedMessagePage> {
    this.assertHealthy();
    this.assertPrincipal(principal);
    await this.sync({ maxPush: 20, maxPages: 0 });
    let remotePage: MessagePage;
    try {
      await this.ensureRemote();
      remotePage = await this.remote.listMessages(principal, query);
    } catch (error) {
      const retryable = isRetryableSyncError(error);
      this.remoteReachable = retryable ? false : true;
      if (!retryable) throw error;
      await this.edge.noteError(codeOf(error));
      let cached: MessagePage;
      let stats: Awaited<ReturnType<SQLiteEdgeStore["stats"]>>;
      try {
        cached = await this.edge.list(query);
        stats = await this.edge.stats(this.now());
      } catch (cacheError) {
        throw this.fatal(cacheError);
      }
      return { ...cached, source: "cache", stale: true, degraded: true,
        acknowledgements: (query.receiptState && query.receiptState !== "any") || "unacknowledgedBy" in query ? "unknown" : "authoritative",
        lastSyncedAt: stats.lastSyncAt };
    }
    try {
      this.remoteReachable = true;
      await this.edge.cacheLatest(remotePage.messages, this.now());
      const stats = await this.edge.stats(this.now());
      return { ...remotePage, source: "remote", stale: false, degraded: false,
        acknowledgements: "authoritative", lastSyncedAt: stats.lastSyncAt };
    } catch (error) {
      throw this.fatal(error);
    }
  }

  async recordReceipt(
    principal: BridgePrincipal,
    messageIds: string[],
    readAt?: Date,
  ): Promise<number> {
    this.assertPrincipal(principal, false);
    await this.ensureRemote();
    return this.remote.recordReceipt(principal, messageIds, readAt);
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
    error?: string,
    _retryPolicy?: import("./bridge-domain.js").RetryPolicy,
  ): Promise<BridgeDelivery | null> {
    this.assertPrincipal(principal);
    await this.ensureRemote();
    return this.remote.settleDelivery(principal, deliveryId, leaseToken, state, error);
  }

  async listDeliveries(principal: BridgePrincipal, query: import("./bridge-store.js").DeliveryQuery = {}) { this.assertPrincipal(principal); await this.ensureRemote(); if(!this.remote.listDeliveries) throw new Error("delivery listing is not supported"); return this.remote.listDeliveries(principal,query); }
  async listDeliveryEvents(principal: BridgePrincipal,id:string,query:{cursor?:string;limit?:number}={}) { this.assertPrincipal(principal);await this.ensureRemote();if(!this.remote.listDeliveryEvents)throw new Error("delivery event listing is not supported");return this.remote.listDeliveryEvents(principal,id,query); }
  async cancelDelivery(principal:BridgePrincipal,id:string){this.assertPrincipal(principal);await this.ensureRemote();if(!this.remote.cancelDelivery)throw new Error("delivery cancellation is not supported");return this.remote.cancelDelivery(principal,id);}
  async requeueDelivery(principal:BridgePrincipal,id:string){this.assertPrincipal(principal);await this.ensureRemote();if(!this.remote.requeueDelivery)throw new Error("delivery requeue is not supported");return this.remote.requeueDelivery(principal,id);}

  async diagnostics(principal: BridgePrincipal, options: { mode?: "snapshot" | "probe" } = {}): Promise<SyncDiagnostics> {
    this.assertPrincipal(principal);
    const edge = await this.edge.stats(this.now());
    let remote: BridgeDiagnostics | undefined;
    let remoteError: string | undefined;
    if (options.mode === "probe") {
      try {
        if (this.remote.diagnostics) remote = await this.remote.diagnostics(principal);
        else await this.ensureRemote();
        this.remoteReachable = true;
      } catch (error) {
        const retryable = isRetryableSyncError(error);
        this.remoteReachable = retryable ? false : true;
        remoteError = codeOf(error);
      }
    }
    return {
      schemaVersion: remote?.schemaVersion ?? "postgres-v2",
      deliverySupported: remote?.deliverySupported ?? true,
      pending: remote?.pending ?? null,
      claimed: remote?.claimed ?? null,
      retrying: remote?.retrying ?? null,
      dead: remote?.dead ?? null,
      cancelled: remote?.cancelled ?? null,
      oldestAvailableAt: remote?.oldestAvailableAt,
      due: remote?.due ?? null,
      scheduled: remote?.scheduled ?? null,
      expiredLeases: remote?.expiredLeases ?? null,
      oldestDueAt: remote?.oldestDueAt,
      queueLagMs: remote?.queueLagMs ?? null,
      principal: { workspace: principal.workspace, agent: principal.agent },
      remoteReachable: options.mode === "probe" ? this.remoteReachable : null,
      outboxPending: edge.pending,
      outboxBlocked: edge.blocked,
      cachedMessages: edge.cached,
      lastSyncAt: edge.lastSyncAt,
      lastSyncError: edge.lastError,
      outboxDue: edge.due,
      outboxScheduled: edge.scheduled,
      outboxLeased: edge.leased,
      outboxOldestDueAt: edge.oldestDueAt,
      outboxQueueLagMs: edge.queueLagMs,
      outboxOldestBlockedAt: edge.oldestBlockedAt,
      outboxBlockedAgeMs: edge.blockedAgeMs,
      outboxBlockedMaxAttempts: edge.blockedMaxAttempts,
      outboxBlockedLastError: edge.blockedLastError,
      outboxNextRetryAt: edge.nextRetryAt,
      lastOutboundSyncAt: edge.lastOutboundSyncAt,
      lastInboundSyncAt: edge.lastInboundSyncAt,
      lastSyncAttemptAt: edge.lastAttemptAt,
      syncLoopState: this.backgroundError ? "failed" : this.loopState,
      syncLoopError: this.backgroundError ? codeOf(this.backgroundError) : undefined,
      remoteError,
      migrationState: edge.migrationState,
      migrationOperationId: edge.migrationOperationId,
      migrationLeaseExpiresAt: edge.migrationLeaseExpiresAt,
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
    this.stopped = true;
    this.loopState = "stopped";
    this.closeController.abort(new Error("synchronization stopped"));
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wake?.();
    const results = await Promise.allSettled([
      this.remote.close?.() ?? Promise.resolve(),
      this.background ?? Promise.resolve(),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (this.backgroundError) failures.push(this.backgroundError);
    if (this.closeEdge) {
      try { await this.edge.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw Object.assign(new Error("failed to close synchronized bridge store"), { errors: failures });
  }
}
