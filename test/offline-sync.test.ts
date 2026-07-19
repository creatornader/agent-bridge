import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it as nativeIt, vi } from "vitest";
import { BridgeService } from "../src/bridge-service.js";
import type {
  BridgeDelivery,
  BridgeMessage,
  BridgePrincipal,
  DeliveryState,
  RetryPolicy,
} from "../src/bridge-domain.js";
import { cursorScope, decodeCursor, encodeCursor } from "../src/bridge-domain.js";
import { privateTestDirectory, secureTestFile } from "./private-test-path.js";
import type {
  BridgeDiagnostics,
  BridgeStore,
  ClaimOptions,
  InsertMessageResult,
  MessagePage,
  MessageQuery,
} from "../src/bridge-store.js";
import { edgeMessageFingerprint, edgeScopeKey, SQLiteEdgeStore, stableIdempotency } from "../src/sqlite-edge-store.js";
import { SQLiteBridgeStore } from "../src/sqlite-bridge-store.js";
import { EDGE_SQLITE_SCHEMA_CONTRACTS, sqliteSchemaContractHash } from "../src/sqlite-database-contract.js";
import { SyncingBridgeStore } from "../src/syncing-bridge-store.js";
import { privatePathIt } from "./private-path-policy.js";

const it = privatePathIt;

const directories: string[] = [];
const remoteStores: SQLiteBridgeStore[] = [];
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

function networkError(): Error {
  return Object.assign(new Error("gateway unavailable"), { status: 0, code: "network_error" });
}

class SwitchableRemote implements BridgeStore {
  online = false;
  initializeFailure?: Error;
  insertFailure?: Error;
  failAfterCommit = false;
  responseDeliveryPolicy?: BridgeMessage["deliveryPolicy"];

  constructor(readonly inner = new SQLiteBridgeStore()) {
    remoteStores.push(inner);
  }

  private check(): void {
    if (!this.online) throw networkError();
  }

  async initialize(): Promise<void> {
    this.check();
    if (this.initializeFailure) throw this.initializeFailure;
    await this.inner.initialize();
  }

  async insertMessage(message: Omit<BridgeMessage, "sequence" | "createdAt">): Promise<InsertMessageResult> {
    this.check();
    if (this.insertFailure) throw this.insertFailure;
    const result = await this.inner.insertMessage(message);
    if (this.failAfterCommit) {
      this.failAfterCommit = false;
      throw Object.assign(new Error("response lost after commit"), {
        status: 504,
        code: "request_timeout",
      });
    }
    return this.responseDeliveryPolicy
      ? { ...result, message: { ...result.message, deliveryPolicy: this.responseDeliveryPolicy } }
      : result;
  }

  async listMessages(principal: BridgePrincipal, query?: MessageQuery): Promise<MessagePage> {
    this.check();
    return this.inner.listMessages(principal, query);
  }

  async recordReceipt(principal: BridgePrincipal, ids: string[], readAt?: Date): Promise<number> {
    this.check();
    return this.inner.recordReceipt(principal, ids, readAt);
  }

  async claimDelivery(principal: BridgePrincipal, options: ClaimOptions): Promise<BridgeDelivery | null> {
    this.check();
    return this.inner.claimDelivery(principal, options);
  }

  async renewDelivery(principal: BridgePrincipal, id: string, token: string, leaseMs: number): Promise<BridgeDelivery | null> {
    this.check();
    return this.inner.renewDelivery(principal, id, token, leaseMs);
  }

  async settleDelivery(
    principal: BridgePrincipal,
    id: string,
    token: string,
    state: Extract<DeliveryState, "acked" | "retrying" | "dead">,
    error: string | undefined,
    retryPolicy?: RetryPolicy,
  ): Promise<BridgeDelivery | null> {
    this.check();
    return this.inner.settleDelivery(principal, id, token, state, error, retryPolicy);
  }

  async diagnostics(principal: BridgePrincipal): Promise<BridgeDiagnostics> {
    this.check();
    return this.inner.diagnostics(principal);
  }

  async close(): Promise<void> {
    // Tests reopen edge clients while retaining one remote authority.
  }
}

function directory(): string {
  const path = privateTestDirectory("agent-bridge-edge-");
  directories.push(path);
  return path;
}

function draft(
  principal: BridgePrincipal,
  id = "018f4a70-0000-7000-8000-000000000101",
): Omit<BridgeMessage, "sequence" | "createdAt"> {
  return {
    id,
    workspace: principal.workspace,
    source: principal.agent,
    type: "request",
    content: "durable offline work",
    contentType: "text/plain",
    targets: [],
    priority: "high",
  };
}

function edge(path: string, principal: BridgePrincipal): SQLiteEdgeStore {
  return new SQLiteEdgeStore(path, { endpoint: "https://bridge.example.test", principal });
}

afterEach(async () => {
  await Promise.all(remoteStores.splice(0).map((store) => store.close()));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("offline SQLite synchronization", () => {
  it("replaces stale reachability after a failed probe", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const remote = new SwitchableRemote();
    remote.online = true;
    const syncing = new SyncingBridgeStore(
      edge(join(root, "edge.sqlite3"), principal), remote, principal, { autoSync: false },
    );
    await syncing.initialize();
    expect(await syncing.diagnostics(principal, { mode: "probe" })).toMatchObject({ remoteReachable: true });
    remote.online = false;
    expect(await syncing.diagnostics(principal, { mode: "probe" })).toMatchObject({
      remoteReachable: false,
      remoteError: "network_error",
    });
    await syncing.close();
  });

  it("reports scheduled, due, and leased outbox work without head-of-line blocking", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const localEdge = edge(join(root, "edge.sqlite3"), principal);
    const now = new Date("2026-07-14T12:00:00.000Z");
    await localEdge.enqueue(draft(principal), now);
    const first = await localEdge.claimNext(now, 30_000);
    expect(first).toBeDefined();
    await localEdge.retry(first!, "network_error", new Date(now.getTime() + 60_000));
    await localEdge.enqueue(draft(principal, "018f4a70-0000-7000-8000-000000000102"), now);

    expect(await localEdge.stats(now)).toMatchObject({ pending: 2, due: 1, scheduled: 1, leased: 0 });
    const second = await localEdge.claimNext(now, 30_000);
    expect(second?.draft.id).toBe("018f4a70-0000-7000-8000-000000000102");
    expect(await localEdge.stats(now)).toMatchObject({ pending: 2, due: 0, scheduled: 1, leased: 1 });
    await localEdge.close();
  });

  it("closes normal publication before a remote attempt while a stage lease drains prior work", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender", instance: "desktop" };
    const databasePath = join(root, "edge.sqlite3");
    const writer = edge(databasePath, principal);
    const now = new Date("2026-07-19T12:00:00.000Z");
    await writer.enqueue(draft(principal), now);
    await writer.assertScopeActive();
    const lease = await writer.acquireDrainLease("019f7f32-0000-7000-8000-000000000001", now, 60_000);

    const remote = new SwitchableRemote(); remote.online = true;
    const initialize = vi.spyOn(remote, "initialize");
    const normal = new SyncingBridgeStore(edge(databasePath, principal), remote, principal, { autoSync: false });
    await normal.initialize();
    await expect(normal.insertMessage(draft(principal, "019f7f32-0000-7000-8000-000000000002")))
      .rejects.toMatchObject({ code: "client_migration_draining" });
    await expect(normal.sync({ maxPush: 1, maxPages: 1 })).resolves.toMatchObject({
      pushed: 0,
      pulled: 0,
      lastError: "client_migration_draining",
      migrationState: "draining",
    });
    expect(initialize).not.toHaveBeenCalled();

    const drainer = new SyncingBridgeStore(edge(databasePath, principal), remote, principal, {
      autoSync: false,
      edgeDrainLease: lease,
      now: () => now,
    });
    await drainer.initialize();
    await expect(drainer.sync({ maxPush: 1, maxPages: 0 })).resolves.toMatchObject({ pushed: 1, pending: 0 });
    await writer.retireScope(lease, new Date(now.getTime() + 1_000));
    await expect(writer.enqueue(draft(principal, "019f7f32-0000-7000-8000-000000000003")))
      .rejects.toMatchObject({ code: "client_migration_retired" });
    await drainer.close();
    await normal.close();
    await writer.close();
  });

  it("refuses an expired stage lease without an outbound remote attempt", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const databasePath = join(root, "edge.sqlite3");
    const local = edge(databasePath, principal);
    const now = new Date("2026-07-19T12:00:00.000Z");
    await local.enqueue(draft(principal), now);
    const lease = await local.acquireDrainLease("019f7f32-0000-7000-8000-000000000004", now, 1_000);
    const remote = new SwitchableRemote(); remote.online = true;
    const initialize = vi.spyOn(remote, "initialize");
    const drainer = new SyncingBridgeStore(edge(databasePath, principal), remote, principal, {
      autoSync: false,
      edgeDrainLease: lease,
      now: () => new Date(now.getTime() + 1_001),
    });
    await drainer.initialize();
    await expect(drainer.sync({ maxPush: 1, maxPages: 0 })).resolves.toMatchObject({
      pushed: 0,
      lastError: "client_migration_lease_lost",
      migrationState: "draining",
    });
    expect(initialize).not.toHaveBeenCalled();
    await drainer.close();
    await local.close();
  });

  it("database-fences a pre-gate raw SQLite publisher", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const databasePath = join(root, "edge.sqlite3");
    const bootstrap = edge(databasePath, principal);
    await bootstrap.initialize();
    await bootstrap.close();
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("DROP TRIGGER edge_outbox_migration_gate_insert");
    const legacyInsert = legacy.prepare(`INSERT INTO edge_outbox
      (scope_key,message_id,idempotency_key,payload_hash,draft_json,state,attempts,available_at,created_at)
      VALUES (?,?,?,?,?,'pending',0,?,?)`);
    const now = new Date("2026-07-19T12:00:00.000Z");
    const current = edge(databasePath, principal);
    await current.initialize();
    await current.acquireDrainLease("019f7f32-0000-7000-8000-000000000005", now, 60_000);
    expect(() => legacyInsert.run(
      current.scopeKey,
      "019f7f32-0000-7000-8000-000000000006",
      "legacy-publisher-key",
      "legacy-payload-hash",
      "{}",
      now.toISOString(),
      now.toISOString(),
    )).toThrow("edge migration gate rejects outbox publication");
    legacy.close();
    await current.close();
  });

  it("persists one drain lease across reopen, renewal, and expiry", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const databasePath = join(root, "edge.sqlite3");
    const now = new Date("2026-07-19T12:00:00.000Z");
    const first = edge(databasePath, principal);
    const lease = await first.acquireDrainLease("019f7f32-0000-7000-8000-000000000007", now, 1_000);
    await first.close();

    const reopened = edge(databasePath, principal);
    await expect(reopened.migrationGate()).resolves.toMatchObject({
      state: "draining", operationId: lease.operationId, leaseExpiresAt: lease.leaseExpiresAt,
    });
    await expect(reopened.acquireDrainLease("019f7f32-0000-7000-8000-000000000008", now, 1_000))
      .rejects.toMatchObject({ code: "client_migration_draining" });
    const renewed = await reopened.renewDrainLease(lease, new Date(now.getTime() + 500), 2_000);
    await expect(reopened.assertDrainLease(lease, new Date(now.getTime() + 501)))
      .rejects.toMatchObject({ code: "client_migration_lease_lost" });
    await expect(reopened.assertDrainLease(renewed, new Date(now.getTime() + 501))).resolves.toBeUndefined();
    const replacement = await reopened.acquireDrainLease(
      lease.operationId, new Date(now.getTime() + 2_501), 1_000,
    );
    expect(replacement.leaseToken).not.toBe(renewed.leaseToken);
    await reopened.close();
  });

  it("measures blocked age from the blocked transition", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const localEdge = edge(join(root, "edge.sqlite3"), principal);
    const enqueuedAt = new Date("2026-07-14T10:00:00.000Z");
    const blockedAt = new Date("2026-07-14T11:00:00.000Z");
    await localEdge.enqueue(draft(principal), enqueuedAt);
    const record = await localEdge.claimNext(enqueuedAt, 30_000);
    expect(record).toBeDefined();
    await localEdge.block(record!, "invalid_input", blockedAt);

    expect(await localEdge.stats(new Date(blockedAt.getTime() + 5_000))).toMatchObject({
      blocked: 1,
      oldestBlockedAt: blockedAt.toISOString(),
      blockedAgeMs: 5_000,
      blockedLastError: "invalid_input",
    });
    await localEdge.close();
  });

  it("includes remote cancelled deliveries in syncing diagnostics", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "worker", instance: "one" };
    const publisher = { workspace: "acme", agent: "publisher" };
    const remote = new SwitchableRemote(); remote.online = true;
    const authority = new BridgeService(remote.inner);
    await authority.publish(publisher, {
      type: "work", content: "cancelled", targets: ["worker"],
    });
    const claim = await authority.claim(principal, { leaseMs: 1_000 });
    await authority.cancel(publisher, claim!.delivery.id);
    const syncing = new SyncingBridgeStore(
      edge(join(root, "edge.sqlite3"), principal), remote, principal, { autoSync: false },
    );
    await syncing.initialize();
    expect(await syncing.diagnostics(principal, { mode: "probe" })).toMatchObject({ cancelled: 1 });
    await syncing.close();
  });

  it("binds delivery policy into edge idempotency and recovery equivalence", async () => {
    const root = directory(); const principal = { workspace: "acme", agent: "sender" };
    const localEdge = edge(join(root, "edge.sqlite3"), principal);
    const leased = {
      ...draft(principal), targets: ["worker"],
      deliveryPolicy: { mode: "leased" as const, maxAttempts: 2, retryBaseDelayMs: 1_000, retryMaxDelayMs: 60_000, retryJitterRatio: 0.2 },
    };
    const changed = { ...leased, deliveryPolicy: { ...leased.deliveryPolicy, maxAttempts: 3 } };
    expect(edgeMessageFingerprint(leased)).not.toBe(edgeMessageFingerprint(changed));
    await localEdge.enqueue(leased);
    await expect(localEdge.enqueue(changed)).rejects.toMatchObject({ code: "edge_idempotency_conflict" });
    await localEdge.close();

    const recoveryEdge = edge(join(root, "recovery.sqlite3"), principal);
    const remote = new SwitchableRemote(); remote.online = true;
    remote.responseDeliveryPolicy = { ...leased.deliveryPolicy, maxAttempts: 4 };
    const syncing = new SyncingBridgeStore(recoveryEdge, remote, principal, { autoSync: false });
    await syncing.initialize();
    await expect(syncing.insertMessage({
      ...leased, id: "018f4a70-0000-7000-8000-000000000102",
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(await syncing.diagnostics(principal)).toMatchObject({ outboxPending: 0, outboxBlocked: 1 });
    await syncing.close();
  });
  it("shares one edge initialization across concurrent calls on the same store", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const localEdge = edge(join(root, "edge.sqlite3"), principal);
    await Promise.all(Array.from({ length: 8 }, () => localEdge.initialize()));
    expect((await localEdge.list()).messages).toEqual([]);
    await localEdge.close();
  });

  it("queues through restart, reconnects, and caches the authoritative message", async () => {
    const root = directory();
    const path = join(root, "edge.sqlite3");
    const principal = { workspace: "acme", agent: "sender", instance: "desktop" };
    const remote = new SwitchableRemote();
    let clock = Date.now();
    const options = { random: () => 0.5, now: () => new Date(clock) };
    const first = new SyncingBridgeStore(edge(path, principal), remote, principal, options);
    await first.initialize();

    const queued = await first.insertMessage(draft(principal));
    expect(queued).toMatchObject({ disposition: "queued", authoritative: false, created: true });
    const replayed = await first.insertMessage(draft(principal));
    expect(replayed).toMatchObject({ disposition: "queued", authoritative: false, created: false });
    expect((await first.diagnostics(principal)).outboxPending).toBe(1);
    await first.close();

    remote.online = true;
    clock += 1_001;
    const restarted = new SyncingBridgeStore(edge(path, principal), remote, principal, options);
    const report = await restarted.sync();
    expect(report).toMatchObject({ online: true, pushed: 1, pending: 0, blocked: 0, cached: 1 });
    expect((await remote.inner.listMessages({ workspace: "acme", agent: "worker" })).messages).toHaveLength(1);

    remote.online = false;
    const cached = await restarted.listMessages(principal);
    expect(cached).toMatchObject({ source: "cache", stale: true });
    expect(cached.messages.map((message) => message.content)).toEqual(["durable offline work"]);
    await restarted.close();
  });

  it("keeps a committed targeted-away send in sent cache and advances inbox cursor", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const remote = new SwitchableRemote();
    remote.online = true;
    const localEdge = edge(join(root, "edge.sqlite3"), principal);
    const syncing = new SyncingBridgeStore(localEdge, remote, principal, { autoSync: false });
    const targeted = {
      ...draft(principal, "018f4a70-0000-7000-8000-000000000188"),
      targets: ["worker"],
    };

    expect(await syncing.insertMessage(targeted)).toMatchObject({
      disposition: "committed",
      authoritative: true,
    });
    remote.online = false;
    expect((await syncing.listMessages(principal, { mailbox: "sent" })).messages)
      .toMatchObject([{ id: targeted.id }]);
    const emptyInbox = await localEdge.list({ mailbox: "inbox" });
    expect(emptyInbox.messages).toEqual([]);
    expect(emptyInbox.cursor).toBeDefined();
    await syncing.close();
  });

  it("preserves the sync high-water mark across empty filtered cache reads", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const localEdge = edge(join(root, "edge.sqlite3"), principal);
    const syncScope = cursorScope(principal, { mailbox: "all", includeExpired: true });
    const inboxScope = cursorScope(principal, { mailbox: "inbox" });
    await localEdge.cachePage([], encodeCursor("100", syncScope));

    const empty = await localEdge.list({ mailbox: "inbox" });
    expect(empty.messages).toEqual([]);
    expect(decodeCursor(empty.cursor, inboxScope)).toBe("100");

    const laterCursor = encodeCursor("150", inboxScope);
    const later = await localEdge.list({ mailbox: "inbox", cursor: laterCursor });
    expect(later.messages).toEqual([]);
    expect(decodeCursor(later.cursor, inboxScope)).toBe("150");
    await localEdge.close();
  });

  it("preserves project labels through replay and exact cache filtering", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender", instance: "desktop" };
    const remote = new SwitchableRemote();
    const syncing = new SyncingBridgeStore(
      edge(join(root, "edge.sqlite3"), principal),
      remote,
      principal,
      { autoSync: false },
    );
    await syncing.initialize();
    await syncing.insertMessage({
      ...draft(principal),
      project: "project-alpha",
      idempotencyKey: "offline-project-key",
    });

    remote.online = true;
    expect(await syncing.sync()).toMatchObject({ pushed: 1, pending: 0, cached: 1 });
    expect((await remote.inner.listMessages(principal, { project: "project-alpha" })).messages)
      .toMatchObject([{ project: "project-alpha", content: "durable offline work" }]);

    remote.online = false;
    expect((await syncing.listMessages(principal, { project: "project-alpha" })).messages)
      .toMatchObject([{ project: "project-alpha" }]);
    expect((await syncing.listMessages(principal, { project: "project-beta" })).messages)
      .toEqual([]);
    expect((await syncing.listMessages(principal)).messages)
      .toMatchObject([{ project: "project-alpha" }]);
    await syncing.close();
  });

  it("rejects an offline idempotency replay when only its project changes", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const localEdge = edge(join(root, "edge.sqlite3"), principal);
    const first = {
      ...draft(principal),
      project: "project-alpha",
      idempotencyKey: "offline-project-key",
    };
    await localEdge.enqueue(first);
    await expect(localEdge.enqueue({ ...first, project: "project-beta" }))
      .rejects.toMatchObject({ code: "edge_idempotency_conflict" });
    await localEdge.close();
  });

  it("deduplicates an ambiguous committed send and preserves cache scope isolation", async () => {
    const root = directory();
    const path = join(root, "edge.sqlite3");
    const sender = { workspace: "acme", agent: "sender" };
    const stranger = { workspace: "acme", agent: "stranger" };
    const remote = new SwitchableRemote();
    remote.online = true;
    await remote.inner.initialize();
    const message = stableIdempotency(draft(sender, "018f4a70-0000-7000-8000-000000000102"));

    await remote.inner.insertMessage(message);
    const senderEdge = edge(path, sender);
    await senderEdge.enqueue(message);
    const syncing = new SyncingBridgeStore(senderEdge, remote, sender, { random: () => 0.5 });
    const report = await syncing.sync();
    expect(report).toMatchObject({ pushed: 1, deduplicated: 1, pending: 0, cached: 1 });
    expect((await remote.inner.listMessages({ workspace: "acme", agent: "worker" })).messages).toHaveLength(1);
    await syncing.close();

    remote.online = false;
    const isolated = new SyncingBridgeStore(edge(path, stranger), remote, stranger);
    const page = await isolated.listMessages(stranger);
    expect(page.messages).toEqual([]);
    expect(page).toMatchObject({ source: "cache", stale: true });
    await isolated.close();
  });

  it("blocks replay when remote idempotency resolves to a different message ID", async () => {
    const root = directory();
    const sender = { workspace: "acme", agent: "sender" };
    const remote = new SwitchableRemote();
    remote.online = true;
    await remote.inner.initialize();
    const idempotencyKey = "shared-offline-key";
    const authoritative = {
      ...draft(sender, "018f4a70-0000-7000-8000-000000000201"),
      idempotencyKey,
    };
    const queued = {
      ...authoritative,
      id: "018f4a70-0000-7000-8000-000000000202",
    };

    const inserted = await remote.inner.insertMessage(authoritative);
    const directReplay = await remote.inner.insertMessage(queued);
    expect(directReplay).toMatchObject({ created: false, message: { id: inserted.message.id } });
    expect(edgeMessageFingerprint(queued)).toBe(edgeMessageFingerprint(inserted.message));

    const localEdge = edge(join(root, "edge.sqlite3"), sender);
    await localEdge.enqueue(queued);
    const syncing = new SyncingBridgeStore(localEdge, remote, sender, { autoSync: false });
    const report = await syncing.sync({ maxPages: 0 });

    expect(report).toMatchObject({
      pushed: 0,
      deduplicated: 0,
      pending: 0,
      blocked: 1,
      lastError: "idempotency_conflict",
    });
    expect((await remote.inner.listMessages(sender)).messages).toMatchObject([
      { id: authoritative.id, idempotencyKey },
    ]);
    await syncing.close();
  });

  it("retries an unknown publication outcome idempotently", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const remote = new SwitchableRemote();
    remote.online = true;
    remote.failAfterCommit = true;
    let clock = Date.now();
    const syncing = new SyncingBridgeStore(
      edge(join(root, "edge.sqlite3"), principal),
      remote,
      principal,
      { autoSync: false, random: () => 0.5, now: () => new Date(clock), baseDelayMs: 10 },
    );
    await syncing.initialize();

    await expect(syncing.insertMessage(draft(principal))).resolves.toMatchObject({
      disposition: "queued",
      authoritative: false,
    });
    clock += 11;
    expect(await syncing.sync({ maxPages: 0 })).toMatchObject({
      pushed: 1,
      deduplicated: 1,
      pending: 0,
    });
    expect((await remote.inner.listMessages(principal)).messages).toHaveLength(1);
    await syncing.close();
  });

  it("returns cached unread candidates with explicitly unknown acknowledgement state", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "worker" };
    const remote = new SwitchableRemote();
    remote.online = true;
    const syncing = new SyncingBridgeStore(
      edge(join(root, "edge.sqlite3"), principal), remote, principal, { autoSync: false },
    );
    await syncing.initialize();
    await remote.inner.insertMessage(draft({ workspace: "acme", agent: "worker" }));
    await syncing.listMessages(principal, { latest: true });
    remote.online = false;

    const cached = await syncing.listMessages(principal, {
      latest: true,
      receiptState: "unread",
    });
    expect(cached).toMatchObject({
      source: "cache",
      stale: true,
      degraded: true,
      acknowledgements: "unknown",
    });
    expect(cached.messages).toHaveLength(1);
    await syncing.close();
  });

  it("replays queued sends autonomously and stops its bounded transport loop on close", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const remote = new SwitchableRemote();
    const syncing = new SyncingBridgeStore(
      edge(join(root, "edge.sqlite3"), principal),
      remote,
      principal,
      { baseDelayMs: 5, maxDelayMs: 20, random: () => 0.5 },
    );
    await syncing.initialize();
    await syncing.insertMessage(draft(principal));
    remote.online = true;
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect((await syncing.diagnostics(principal)).outboxPending).toBe(0);
    expect((await remote.inner.listMessages(principal)).messages).toHaveLength(1);
    await syncing.close();
  });

  it("schedules idle polling, queued wakeups, and committed sends without extra requests", async () => {
    vi.useFakeTimers();
    try {
      const root = directory();
      const principal = { workspace: "acme", agent: "sender" };
      const remote = new SwitchableRemote();
      remote.online = true;
      const initialize = vi.spyOn(remote, "initialize");
      const list = vi.spyOn(remote, "listMessages");
      const insert = vi.spyOn(remote, "insertMessage");
      const syncing = new SyncingBridgeStore(
        edge(join(root, "edge.sqlite3"), principal), remote, principal,
        { baseDelayMs: 100, idleDelayMs: 1_000, random: () => 0.5 },
      );
      await syncing.initialize();

      await vi.advanceTimersByTimeAsync(99);
      expect(initialize).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(list).toHaveBeenCalledTimes(1);

      await expect(syncing.insertMessage(draft(principal))).resolves.toMatchObject({
        disposition: "committed", authoritative: true,
      });
      expect(insert).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(list).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0);

      remote.online = false;
      await expect(syncing.insertMessage(draft(
        principal, "018f4a70-0000-7000-8000-000000000188",
      ))).resolves.toMatchObject({ disposition: "queued" });
      const callsAfterForegroundFailure = insert.mock.calls.length;
      remote.online = true;
      await vi.advanceTimersByTimeAsync(100);
      expect(insert.mock.calls.length).toBeGreaterThan(callsAfterForegroundFailure);
      await syncing.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records cache write failures as fatal local edge state", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const remote = new SwitchableRemote();
    remote.online = true;
    const localEdge = edge(join(root, "edge.sqlite3"), principal);
    vi.spyOn(localEdge, "cacheLatest").mockRejectedValueOnce(new Error("disk full"));
    const syncing = new SyncingBridgeStore(localEdge, remote, principal, { autoSync: false });
    await syncing.initialize();
    await expect(syncing.listMessages(principal)).rejects.toMatchObject({
      code: "local_edge_commit_failed",
    });
    const insert = vi.spyOn(remote, "insertMessage");
    await expect(syncing.insertMessage(draft(principal))).rejects.toMatchObject({
      code: "local_edge_commit_failed",
    });
    expect(insert).not.toHaveBeenCalled();
    await expect(syncing.sync()).rejects.toMatchObject({ code: "local_edge_commit_failed" });
    await expect(syncing.diagnostics(principal)).resolves.toMatchObject({
      syncLoopState: "failed",
      syncLoopError: "local_edge_commit_failed",
    });
    await expect(syncing.close()).rejects.toMatchObject({ code: "local_edge_commit_failed" });
  });

  it("records cursor page cache failures as fatal local edge state", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const remote = new SwitchableRemote();
    remote.online = true;
    const localEdge = edge(join(root, "edge.sqlite3"), principal);
    vi.spyOn(localEdge, "cachePage").mockRejectedValueOnce(new Error("disk full"));
    const syncing = new SyncingBridgeStore(localEdge, remote, principal, { autoSync: false });
    await syncing.initialize();

    await expect(syncing.sync({ maxPush: 0, maxPages: 1 })).rejects.toMatchObject({
      code: "local_edge_commit_failed",
    });
    const insert = vi.spyOn(remote, "insertMessage");
    await expect(syncing.insertMessage(draft(principal))).rejects.toMatchObject({
      code: "local_edge_commit_failed",
    });
    expect(insert).not.toHaveBeenCalled();
    await expect(syncing.diagnostics(principal)).resolves.toMatchObject({
      syncLoopState: "failed",
      syncLoopError: "local_edge_commit_failed",
    });
    await expect(syncing.close()).rejects.toMatchObject({
      code: "local_edge_commit_failed",
    });
  });

  it("never queues lease operations while the gateway is offline", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "worker", instance: "one" };
    const remote = new SwitchableRemote();
    const syncing = new SyncingBridgeStore(edge(join(root, "edge.sqlite3"), principal), remote, principal);
    await syncing.initialize();

    await expect(syncing.claimDelivery(principal, { leaseMs: 30_000 })).rejects.toMatchObject({
      code: "network_error",
    });
    expect((await syncing.diagnostics(principal)).outboxPending).toBe(0);
    await syncing.close();
  });

  it("rejects protocol mismatch before adding a message to the outbox", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const remote = new SwitchableRemote();
    remote.online = true;
    remote.initializeFailure = Object.assign(new Error("gateway protocol is incompatible"), {
      status: 502,
      code: "protocol_mismatch",
    });
    const localEdge = edge(join(root, "edge.sqlite3"), principal);
    const syncing = new SyncingBridgeStore(localEdge, remote, principal, {
      autoSync: false,
    });
    await syncing.initialize();

    await expect(syncing.insertMessage(draft(principal))).rejects.toMatchObject({
      status: 502,
      code: "protocol_mismatch",
    });
    expect(await localEdge.stats()).toMatchObject({ pending: 0, blocked: 0 });
    await syncing.close();
  });

  it("blocks permanent publication errors instead of retrying them", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const remote = new SwitchableRemote();
    remote.online = true;
    remote.insertFailure = Object.assign(new Error("invalid message"), {
      status: 400,
      code: "invalid_input",
    });
    const syncing = new SyncingBridgeStore(edge(join(root, "edge.sqlite3"), principal), remote, principal);
    await syncing.initialize();

    await expect(syncing.insertMessage(draft(principal))).rejects.toMatchObject({ code: "invalid_input" });
    expect(await syncing.diagnostics(principal)).toMatchObject({
      outboxPending: 0,
      outboxBlocked: 1,
      outboxBlockedMaxAttempts: 1,
      outboxBlockedLastError: "invalid_input",
    });
    expect(await syncing.sync({ maxPages: 0 })).toMatchObject({ pushed: 0, blocked: 1 });

    remote.insertFailure = undefined;
    const next = await syncing.insertMessage(draft(
      principal,
      "018f4a70-0000-7000-8000-000000000103",
    ));
    expect(next).toMatchObject({ disposition: "committed", authoritative: true });
    expect(await syncing.diagnostics(principal)).toMatchObject({
      outboxPending: 0,
      outboxBlocked: 1,
      outboxBlockedMaxAttempts: 1,
      outboxBlockedLastError: "invalid_input",
      lastOutboundSyncAt: expect.any(String),
    });
    await syncing.close();
  });

  it("continues autonomous replay past a message-specific publication conflict", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const remote = new SwitchableRemote();
    remote.online = true;
    const firstId = "018f4a70-0000-7000-8000-000000000111";
    const secondId = "018f4a70-0000-7000-8000-000000000112";
    const originalInsert = remote.insertMessage.bind(remote);
    remote.insertMessage = async (message) => {
      if (message.id === firstId) throw Object.assign(new Error("conflict"), {
        status: 409, code: "idempotency_conflict",
      });
      return originalInsert(message);
    };
    const localEdge = edge(join(root, "edge.sqlite3"), principal);
    await localEdge.enqueue(draft(principal, firstId));
    await localEdge.enqueue(draft(principal, secondId));
    const syncing = new SyncingBridgeStore(localEdge, remote, principal, {
      baseDelayMs: 5, idleDelayMs: 10_000, random: () => 0.5,
    });
    await syncing.initialize();
    await vi.waitFor(async () => {
      expect((await remote.inner.listMessages(principal)).messages.map((message) => message.id))
        .toContain(secondId);
    });
    expect(await syncing.diagnostics(principal)).toMatchObject({
      outboxPending: 0, outboxBlocked: 1,
    });
    await syncing.close();
  });

  it("queues a new send behind an older rejected message and wakes replay", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const remote = new SwitchableRemote();
    remote.online = true;
    const firstId = "018f4a70-0000-7000-8000-000000000113";
    const secondId = "018f4a70-0000-7000-8000-000000000114";
    const originalInsert = remote.insertMessage.bind(remote);
    remote.insertMessage = async (message) => {
      if (message.id === firstId) throw Object.assign(new Error("conflict"), {
        status: 409, code: "idempotency_conflict",
      });
      return originalInsert(message);
    };
    const localEdge = edge(join(root, "edge.sqlite3"), principal);
    await localEdge.enqueue(draft(principal, firstId));
    const syncing = new SyncingBridgeStore(localEdge, remote, principal, {
      baseDelayMs: 30_000, idleDelayMs: 60_000, random: () => 0.5,
    });
    await syncing.initialize();

    await expect(syncing.insertMessage(draft(principal, secondId))).resolves.toMatchObject({
      message: { id: secondId },
      disposition: "queued",
      authoritative: false,
    });
    await vi.waitFor(async () => {
      expect((await remote.inner.listMessages(principal)).messages.map((message) => message.id))
        .toContain(secondId);
    }, { timeout: 500 });
    expect(await syncing.diagnostics(principal)).toMatchObject({
      outboxPending: 0, outboxBlocked: 1,
    });
    await syncing.close();
  });

  it("preserves recoverable outbox state and exposes a fatal local commit failure", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const remote = new SwitchableRemote();
    remote.online = true;
    const localEdge = edge(join(root, "edge.sqlite3"), principal);
    vi.spyOn(localEdge, "commit").mockRejectedValueOnce(new Error("disk full"));
    const syncing = new SyncingBridgeStore(localEdge, remote, principal, { autoSync: false });
    await syncing.initialize();
    await expect(syncing.insertMessage(draft(principal))).rejects.toMatchObject({
      code: "local_edge_commit_failed",
    });
    expect((await remote.inner.listMessages(principal)).messages).toHaveLength(1);
    expect((await localEdge.stats()).pending).toBe(1);
    const remoteInsert = vi.spyOn(remote, "insertMessage");
    await expect(syncing.insertMessage(draft(principal, "018f4a70-0000-7000-8000-000000000199")))
      .rejects.toMatchObject({ code: "local_edge_commit_failed" });
    expect(remoteInsert).not.toHaveBeenCalled();
    expect((await localEdge.stats()).pending).toBe(1);
    await expect(syncing.sync()).rejects.toMatchObject({ code: "local_edge_commit_failed" });
    await expect(syncing.diagnostics(principal)).resolves.toMatchObject({
      syncLoopState: "failed",
      syncLoopError: "local_edge_commit_failed",
    });
    await expect(syncing.close()).rejects.toMatchObject({ code: "local_edge_commit_failed" });
  });

  it("reports a pre-cancelled synchronization without contacting the remote", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    const remote = new SwitchableRemote();
    const initialize = vi.spyOn(remote, "initialize");
    const syncing = new SyncingBridgeStore(
      edge(join(root, "edge.sqlite3"), principal), remote, principal, { autoSync: false },
    );
    const controller = new AbortController();
    controller.abort();
    await expect(syncing.sync({ signal: controller.signal })).resolves.toMatchObject({
      online: false, pushed: 0, pulled: 0,
      lastError: "request_cancelled", failureRetryable: true,
    });
    expect(initialize).not.toHaveBeenCalled();
    await syncing.close();
  });

  it("does not use a remote until its bound principal is verified", async () => {
    const root = directory();
    const principal = { workspace: "acme", agent: "sender" };
    let insertCalls = 0;
    const mismatch = Object.assign(new Error("wrong credential principal"), {
      status: 403,
      code: "principal_mismatch",
    });
    const remote: BridgeStore = {
      initialize: async () => { throw mismatch; },
      insertMessage: async () => {
        insertCalls += 1;
        throw new Error("must not be reached");
      },
      listMessages: async () => ({ messages: [] }),
      recordReceipt: async () => 0,
      claimDelivery: async () => null,
      renewDelivery: async () => null,
      settleDelivery: async () => null,
    };
    const syncing = new SyncingBridgeStore(
      edge(join(root, "edge.sqlite3"), principal),
      remote,
      principal,
    );
    await expect(syncing.insertMessage(draft(principal))).rejects.toMatchObject({
      code: "principal_mismatch",
    });
    expect(insertCalls).toBe(0);
    await expect(syncing.diagnostics(principal)).resolves.toMatchObject({
      remoteReachable: null,
    });
    await expect(syncing.diagnostics(principal, { mode: "probe" })).resolves.toMatchObject({
      remoteReachable: true,
      remoteError: "principal_mismatch",
    });
    await syncing.close();
  });

  it("adds the project cache column without losing prior edge history", async () => {
    const root = directory();
    const path = join(root, "edge.sqlite3");
    const principal = { workspace: "acme", agent: "sender" };
    const scope = { endpoint: "https://bridge.example.test", principal };
    const scopeKey = edgeScopeKey(scope);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const legacy = new DatabaseSync(path);
    const message = {
      ...draft(principal),
      sequence: "1",
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    legacy.exec(`
      CREATE TABLE edge_scopes (
        scope_key TEXT PRIMARY KEY, endpoint_hash TEXT NOT NULL, workspace TEXT NOT NULL,
        agent TEXT NOT NULL, pull_cursor TEXT, last_sync_at TEXT, last_error TEXT
      );
      CREATE TABLE edge_inbox (
        scope_key TEXT NOT NULL REFERENCES edge_scopes(scope_key), message_id TEXT NOT NULL,
        remote_sequence TEXT NOT NULL, sequence_key TEXT NOT NULL, workspace TEXT NOT NULL,
        source TEXT NOT NULL, type TEXT NOT NULL, thread_id TEXT, created_at TEXT NOT NULL,
        expires_at TEXT, message_json TEXT NOT NULL, PRIMARY KEY(scope_key, message_id),
        UNIQUE(scope_key, sequence_key)
      );
    `);
    legacy.prepare(`INSERT INTO edge_scopes
      (scope_key, endpoint_hash, workspace, agent) VALUES (?, ?, ?, ?)`)
      .run(scopeKey, "legacy-endpoint-hash", principal.workspace, principal.agent);
    legacy.prepare(`INSERT INTO edge_inbox
      (scope_key, message_id, remote_sequence, sequence_key, workspace, source, type,
       thread_id, created_at, expires_at, message_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(scopeKey, message.id, "1", "0000000000000000001", principal.workspace,
        principal.agent, message.type, null, message.createdAt, null, JSON.stringify(message));
    legacy.close(); secureTestFile(path);

    const upgraded = edge(path, principal);
    await upgraded.initialize();
    expect((await upgraded.list()).messages).toMatchObject([{
      id: message.id,
      content: "durable offline work",
    }]);
    await upgraded.close();
    const verified = new DatabaseSync(path, { readOnly: true });
    expect(sqliteSchemaContractHash(verified)).toBe(EDGE_SQLITE_SCHEMA_CONTRACTS.find(
      (contract) => contract.id === "current-upgraded-project-column-migration-gate",
    )!.sha256);
    verified.close();
  });

  it("resets the old inbox cursor and backfills prior sent targeted messages", async () => {
    const root = directory();
    const path = join(root, "edge.sqlite3");
    const principal = { workspace: "acme", agent: "sender" };
    const first = edge(path, principal);
    await first.initialize();
    await first.close();

    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const oldCache = new DatabaseSync(path);
    oldCache.prepare("UPDATE edge_scopes SET cache_contract=0, pull_cursor=?")
      .run(encodeCursor("1"));
    oldCache.close();

    const remote = new SwitchableRemote();
    remote.online = true;
    const targeted = {
      ...draft(principal, "018f4a70-0000-7000-8000-000000000199"),
      targets: ["worker"],
    };
    await remote.inner.insertMessage(targeted);
    const syncing = new SyncingBridgeStore(
      edge(path, principal),
      remote,
      principal,
      { autoSync: false },
    );
    expect(await syncing.sync()).toMatchObject({ online: true, pulled: 1 });

    remote.online = false;
    const sent = await syncing.listMessages(principal, { mailbox: "sent" });
    expect(sent).toMatchObject({ source: "cache", stale: true });
    expect(sent.messages.map((message) => message.id)).toEqual([targeted.id]);
    const database = new DatabaseSync(path);
    expect(database.prepare("SELECT count(*) AS count FROM edge_outbox").get())
      .toMatchObject({ count: 0 });
    database.close();
    await syncing.close();
  });

  nativeIt("allows concurrent processes to perform the first edge project-column upgrade", async () => {
    const root = directory();
    const path = join(root, "edge.sqlite3");
    const principal = { workspace: "acme", agent: "sender" };
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE edge_scopes (
        scope_key TEXT PRIMARY KEY, endpoint_hash TEXT NOT NULL, workspace TEXT NOT NULL,
        agent TEXT NOT NULL, pull_cursor TEXT, last_sync_at TEXT, last_error TEXT
      );
      CREATE TABLE edge_inbox (
        scope_key TEXT NOT NULL REFERENCES edge_scopes(scope_key), message_id TEXT NOT NULL,
        remote_sequence TEXT NOT NULL, sequence_key TEXT NOT NULL, workspace TEXT NOT NULL,
        source TEXT NOT NULL, type TEXT NOT NULL, thread_id TEXT, created_at TEXT NOT NULL,
        expires_at TEXT, message_json TEXT NOT NULL, PRIMARY KEY(scope_key, message_id),
        UNIQUE(scope_key, sequence_key)
      );
    `);
    legacy.close(); secureTestFile(path);

    const sqliteModule = pathToFileURL(join(process.cwd(), "dist/sqlite.js")).href;
    const script = `
      import { SQLiteEdgeStore } from ${JSON.stringify(sqliteModule)};
      const edge = new SQLiteEdgeStore(process.env.AGENT_BRIDGE_TEST_DB, {
        endpoint: "https://bridge.example.test",
        principal: { workspace: "acme", agent: "sender" },
      });
      await edge.initialize();
      await edge.close();
    `;
    await Promise.all(Array.from({ length: 8 }, () => execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { env: { ...process.env, AGENT_BRIDGE_TEST_DB: path }, timeout: 30_000 },
    )));

    const upgraded = new DatabaseSync(path);
    const columns = upgraded.prepare("PRAGMA table_info(edge_inbox)").all() as Array<{
      name: string;
    }>;
    expect(columns.filter((column) => column.name === "project")).toHaveLength(1);
    expect(sqliteSchemaContractHash(upgraded)).toBe(EDGE_SQLITE_SCHEMA_CONTRACTS.find(
      (contract) => contract.id === "current-upgraded-project-column-migration-gate",
    )!.sha256);
    upgraded.close();
  }, process.platform === "win32" ? 45_000 : 15_000);
});
