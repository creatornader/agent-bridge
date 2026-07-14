import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BridgeDelivery,
  BridgeMessage,
  BridgePrincipal,
  DeliveryState,
  RetryPolicy,
} from "../src/bridge-domain.js";
import type {
  BridgeDiagnostics,
  BridgeStore,
  ClaimOptions,
  InsertMessageResult,
  MessagePage,
  MessageQuery,
} from "../src/bridge-store.js";
import { SQLiteEdgeStore, stableIdempotency } from "../src/sqlite-edge-store.js";
import { SQLiteBridgeStore } from "../src/sqlite-bridge-store.js";
import { SyncingBridgeStore } from "../src/syncing-bridge-store.js";

const directories: string[] = [];
const remoteStores: SQLiteBridgeStore[] = [];

function networkError(): Error {
  return Object.assign(new Error("gateway unavailable"), { status: 0, code: "network_error" });
}

class SwitchableRemote implements BridgeStore {
  online = false;
  insertFailure?: Error;

  constructor(readonly inner = new SQLiteBridgeStore()) {
    remoteStores.push(inner);
  }

  private check(): void {
    if (!this.online) throw networkError();
  }

  async initialize(): Promise<void> {
    this.check();
    await this.inner.initialize();
  }

  async insertMessage(message: Omit<BridgeMessage, "sequence" | "createdAt">): Promise<InsertMessageResult> {
    this.check();
    if (this.insertFailure) throw this.insertFailure;
    return this.inner.insertMessage(message);
  }

  async listMessages(principal: BridgePrincipal, query?: MessageQuery): Promise<MessagePage> {
    this.check();
    return this.inner.listMessages(principal, query);
  }

  async recordReceipt(workspace: string, ids: string[], principal: string, readAt?: Date): Promise<number> {
    this.check();
    return this.inner.recordReceipt(workspace, ids, principal, readAt);
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
    retryPolicy: RetryPolicy,
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
  const path = mkdtempSync(join(tmpdir(), "agent-bridge-edge-"));
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
    });
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
    expect(await syncing.diagnostics(principal)).toMatchObject({
      remoteReachable: false,
      outboxPending: 1,
      outboxBlocked: 0,
      lastSyncError: "principal_mismatch",
    });
    await syncing.close();
  });
});
