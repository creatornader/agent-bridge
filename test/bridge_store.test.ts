import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeService } from "../src/bridge-service.js";
import { SQLiteBridgeStore } from "../src/sqlite-bridge-store.js";

const temporaryDirectories: string[] = [];
const stores: SQLiteBridgeStore[] = [];
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-v2-"));
  temporaryDirectories.push(directory);
  const store = new SQLiteBridgeStore(join(directory, "bridge.sqlite"));
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** This contract is intentionally provider-neutral; the PostgreSQL adapter
 * implements the same BridgeStore operations against a Queryable client. */
function bridgeStoreContract(name: string, makeStore: () => SQLiteBridgeStore) {
  describe(`${name} BridgeStore contract`, () => {
    it("inserts idempotently and pages by an authoritative cursor", async () => {
      const service = new BridgeService(makeStore());
      const principal = { workspace: "acme", agent: "codex", instance: "one" };
      const first = await service.publish(principal, {
        id: "018f4a70-0000-7000-8000-000000000001",
        type: "agent-bridge.context",
        content: "first",
        idempotencyKey: "first-key",
      });
      const repeated = await service.publish(principal, {
        id: "018f4a70-0000-7000-8000-000000000002",
        type: "agent-bridge.context",
        content: "first",
        idempotencyKey: "first-key",
      });
      const second = await service.publish(principal, {
        id: "018f4a70-0000-7000-8000-000000000003",
        type: "agent-bridge.context",
        content: "second",
      });

      expect(repeated.created).toBe(false);
      expect(repeated.message.id).toBe(first.message.id);
      const page = await service.history(principal, { limit: 1 });
      expect(page.messages).toHaveLength(1);
      expect(page.messages[0]?.id).toBe(first.message.id);
      const next = await service.history(principal, { cursor: page.cursor, limit: 2 });
      expect(next.messages.map((message) => message.id)).toEqual([second.message.id]);
    });

    it("rejects a changed payload under an existing idempotency key", async () => {
      const service = new BridgeService(makeStore());
      const principal = { workspace: "acme", agent: "codex" };
      await service.publish(principal, {
        type: "agent-bridge.context",
        content: "first intent",
        targets: ["worker"],
        idempotencyKey: "stable-key",
      });
      await expect(service.publish(principal, {
        type: "agent-bridge.context",
        content: "changed intent",
        targets: ["other"],
        idempotencyKey: "stable-key",
      })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    });

    it("preserves project labels and filters them without changing workspace scope", async () => {
      const service = new BridgeService(makeStore());
      const principal = { workspace: "acme", agent: "codex" };
      const alpha = await service.publish(principal, {
        type: "agent-bridge.context",
        content: "alpha",
        project: "project-alpha",
      });
      const beta = await service.publish(principal, {
        type: "agent-bridge.context",
        content: "beta",
        project: "project-beta",
      });
      const unlabeled = await service.publish(principal, {
        type: "agent-bridge.context",
        content: "unlabeled",
      });

      expect(alpha.message).toMatchObject({ workspace: "acme", project: "project-alpha" });
      expect((await service.history(principal, { project: "project-alpha" })).messages)
        .toEqual([alpha.message]);
      expect((await service.history(principal)).messages.map((message) => message.id))
        .toEqual([alpha.message.id, beta.message.id, unlabeled.message.id]);
    });

    it("accepts an asterisk project label and treats project as immutable intent", async () => {
      const service = new BridgeService(makeStore());
      const principal = { workspace: "acme", agent: "codex" };
      const first = await service.publish(principal, {
        type: "agent-bridge.context",
        content: "legacy-compatible label",
        project: "*",
        idempotencyKey: "project-key",
      });
      expect(first.message.project).toBe("*");

      const replay = await service.publish(principal, {
        type: "agent-bridge.context",
        content: "legacy-compatible label",
        project: "*",
        idempotencyKey: "project-key",
      });
      expect(replay).toMatchObject({ created: false, message: { id: first.message.id } });

      await expect(service.publish(principal, {
        type: "agent-bridge.context",
        content: "legacy-compatible label",
        project: "different-project",
        idempotencyKey: "project-key",
      })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    });

    it("enforces workspace and recipient isolation and omits expired messages", async () => {
      const service = new BridgeService(makeStore());
      const sender = { workspace: "acme", agent: "codex", instance: "one" };
      await service.publish(sender, {
        id: "018f4a70-0000-7000-8000-000000000004",
        type: "agent-bridge.work",
        content: "for claude",
        targets: ["claude"],
      });
      await service.publish(sender, {
        id: "018f4a70-0000-7000-8000-000000000005",
        type: "agent-bridge.context",
        content: "old",
        expiresAt: "2000-01-01T00:00:00.000Z",
      });
      expect((await service.history({ workspace: "acme", agent: "sido" })).messages).toHaveLength(0);
      expect((await service.history({ workspace: "elsewhere", agent: "claude" })).messages).toHaveLength(0);
      expect((await service.history({ workspace: "acme", agent: "claude" })).messages).toHaveLength(1);
    });

    it("advances its cursor across messages that are invisible to the reader", async () => {
      const service = new BridgeService(makeStore());
      const sender = { workspace: "acme", agent: "codex" };
      const reader = { workspace: "acme", agent: "worker" };
      await service.publish(sender, {
        type: "agent-bridge.work",
        content: "for someone else",
        targets: ["claude"],
      });
      const empty = await service.history(reader);
      expect(empty.messages).toEqual([]);
      expect(empty.cursor).toBeDefined();
      const visible = await service.publish(sender, {
        type: "agent-bridge.context",
        content: "now visible",
      });
      const next = await service.history(reader, { cursor: empty.cursor });
      expect(next.messages.map((message) => message.id)).toEqual([visible.message.id]);
    });

    it("allows only one active delivery claim and recovers an expired lease", async () => {
      const store = makeStore();
      const service = new BridgeService(store);
      const source = { workspace: "acme", agent: "codex" };
      await service.publish(source, {
        id: "018f4a70-0000-7000-8000-000000000006",
        type: "agent-bridge.work",
        content: "do it",
        targets: ["worker"],
      });
      const worker = { workspace: "acme", agent: "worker", instance: "a" };
      const claim = await service.claim(worker, { leaseMs: 1_000 });
      expect(claim).not.toBeNull();
      expect(await service.claim({ ...worker, instance: "b" }, { leaseMs: 1_000 })).toBeNull();
      const recovered = await store.claimDelivery(
        { ...worker, instance: "b" },
        { leaseMs: 1_000, now: new Date(Date.now() + 1_001) },
      );
      expect(recovered?.attempt).toBe(2);
    });

    it("keeps read receipts and delivery settlement independent", async () => {
      const service = new BridgeService(makeStore());
      const sender = { workspace: "acme", agent: "codex" };
      const worker = { workspace: "acme", agent: "worker", instance: "one" };

      const readFirst = await service.publish(sender, {
        type: "agent-bridge.work",
        content: "read before claim",
        targets: ["worker"],
      });

      expect(await service.acknowledge(worker, [readFirst.message.id])).toBe(1);

      const claimedAfterRead = await service.claim(worker, { leaseMs: 1_000 });
      expect(claimedAfterRead?.delivery.messageId).toBe(readFirst.message.id);
      expect(
        (await service.ack(
          worker,
          claimedAfterRead!.delivery.id,
          claimedAfterRead!.leaseToken,
        ))?.state,
      ).toBe("acked");

      const settledWithoutRead = await service.publish(sender, {
        type: "agent-bridge.work",
        content: "settle before read",
        targets: ["worker"],
      });

      const secondClaim = await service.claim(worker, { leaseMs: 1_000 });
      expect(secondClaim?.delivery.messageId).toBe(settledWithoutRead.message.id);
      expect(
        (await service.ack(
          worker,
          secondClaim!.delivery.id,
          secondClaim!.leaseToken,
        ))?.state,
      ).toBe("acked");

      const unread = await service.history(worker, {
        unacknowledgedBy: "worker",
      });
      expect(unread.messages.map((message) => message.id)).toEqual([
        settledWithoutRead.message.id,
      ]);
    });

    it("binds settlement to the owner and dead-letters at the attempt limit", async () => {
      const store = makeStore();
      const service = new BridgeService(store);
      const source = { workspace: "acme", agent: "codex" };
      await service.publish(source, {
        id: "018f4a70-0000-7000-8000-000000000007",
        type: "agent-bridge.work",
        content: "poison",
        targets: ["worker"],
      });
      const owner = { workspace: "acme", agent: "worker", instance: "a" };
      const claim = await service.claim(owner, { leaseMs: 1_000 });

      expect(
        await service.ack(
          { ...owner, instance: "b" },
          claim!.delivery.id,
          claim!.leaseToken,
        ),
      ).toBeNull();
      const settled = await service.nack(
        owner,
        claim!.delivery.id,
        claim!.leaseToken,
        "failed",
        false,
        { maxAttempts: 1, jitterRatio: 0 },
      );
      expect(settled?.state).toBe("dead");
      expect((await store.listDeliveryEvents(claim!.delivery.id)).map((event) => event.toState))
        .toEqual(["pending", "claimed", "dead"]);
    });

    it("publishes leased runtime presence with capabilities", async () => {
      const service = new BridgeService(makeStore());
      const principal = { workspace: "acme", agent: "codex", instance: "desktop-1" };
      const joined = await service.heartbeat(principal, {
        leaseMs: 5_000,
        runtimeType: "codex-desktop",
        capabilities: ["mcp", "shell"],
      });
      expect(joined).toMatchObject({
        workspace: "acme", agent: "codex", instance: "desktop-1",
        runtimeType: "codex-desktop", capabilities: ["mcp", "shell"],
      });
      expect(await service.presence(principal)).toHaveLength(1);
    });

    it("caps active presence instances per agent", async () => {
      const service = new BridgeService(makeStore());
      for (let index = 0; index < 128; index += 1) {
        await service.heartbeat({
          workspace: "acme",
          agent: "codex",
          instance: `instance-${index}`,
        });
      }
      await expect(service.heartbeat({
        workspace: "acme",
        agent: "codex",
        instance: "instance-over-cap",
      })).rejects.toMatchObject({ code: "presence_limit", status: 429 });
      await service.heartbeat({
        workspace: "acme",
        agent: "claude-code",
        instance: "another-agent",
      });
      expect(await service.presence({ workspace: "acme", agent: "codex" }))
        .toHaveLength(129);
    });

    it("enforces receipt visibility and caps crash recovery attempts", async () => {
      const store = makeStore();
      const service = new BridgeService(store);
      const source = { workspace: "acme", agent: "codex" };
      const published = await service.publish(source, {
        id: "018f4a70-0000-7000-8000-000000000010",
        type: "agent-bridge.work",
        content: "private work",
        targets: ["worker"],
      });

      expect(await service.acknowledge({ ...source, agent: "stranger" }, [published.message.id])).toBe(0);
      expect(await service.acknowledge({ ...source, agent: "worker" }, [published.message.id])).toBe(1);

      const worker = { workspace: "acme", agent: "worker", instance: "a" };
      const first = await store.claimDelivery(worker, { leaseMs: 1_000, maxAttempts: 1 });
      const afterExpiry = await store.claimDelivery(worker, {
        leaseMs: 1_000,
        maxAttempts: 1,
        now: new Date(Date.now() + 1_001),
      });
      expect(first?.attempt).toBe(1);
      expect(afterExpiry).toBeNull();
    });

    it("preserves content whitespace and rejects byte-sized overflow", async () => {
      const service = new BridgeService(makeStore());
      const principal = { workspace: "acme", agent: "codex" };
      const result = await service.publish(principal, {
        id: "018f4a70-0000-7000-8000-000000000008",
        type: "agent-bridge.context",
        content: "  intentional whitespace  ",
      });
      expect(result.message.content).toBe("  intentional whitespace  ");
      await expect(
        service.publish(principal, {
          id: "018f4a70-0000-7000-8000-000000000009",
          type: "agent-bridge.context",
          content: "😀".repeat(20_000),
        }),
      ).rejects.toThrow("content exceeds 65536 bytes");
      await expect(service.publish(principal, {
        type: "agent-bridge.context",
        content: "bad provenance",
        informedBy: ["not-a-record-hash"],
      })).rejects.toThrow("informedBy must contain atrib record hashes");
      await expect(service.publish(principal, {
        type: "agent-bridge.context",
        content: "bad receipt",
        atribReceiptId: "not-a-receipt",
      })).rejects.toThrow("atribReceiptId is invalid");
    });
  });
}

bridgeStoreContract("SQLite", createStore);

describe("SQLite project schema upgrade", () => {
  it("adds the project column without losing messages from the prior schema", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-bridge-v2-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "bridge.sqlite");
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE bridge_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL, source TEXT NOT NULL, type TEXT NOT NULL,
        content TEXT NOT NULL, content_type TEXT NOT NULL, data TEXT,
        targets TEXT NOT NULL DEFAULT '[]', thread_id TEXT, reply_to_id TEXT,
        correlation_id TEXT, causation_id TEXT, priority TEXT NOT NULL,
        expires_at TEXT, idempotency_key TEXT, atrib_receipt_id TEXT,
        informed_by TEXT, metadata TEXT, created_at TEXT NOT NULL,
        UNIQUE(workspace, id)
      );
      INSERT INTO bridge_messages
        (id, workspace, source, type, content, content_type, targets, priority, created_at)
      VALUES
        ('018f4a70-0000-7000-8000-000000000099', 'acme', 'codex', 'note',
         'before project labels', 'text/plain', '[]', 'info', '2026-07-14T00:00:00.000Z');
    `);
    legacy.close();

    const store = new SQLiteBridgeStore(path);
    stores.push(store);
    await store.initialize();
    const page = await store.listMessages({ workspace: "acme", agent: "codex" });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      id: "018f4a70-0000-7000-8000-000000000099",
      content: "before project labels",
    });
    expect(page.messages[0]?.project).toBeUndefined();
  });

  it("allows concurrent processes to perform the first project-column upgrade", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-bridge-v2-concurrent-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "bridge.sqlite");
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE bridge_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL, source TEXT NOT NULL, type TEXT NOT NULL,
        content TEXT NOT NULL, content_type TEXT NOT NULL, data TEXT,
        targets TEXT NOT NULL DEFAULT '[]', thread_id TEXT, reply_to_id TEXT,
        correlation_id TEXT, causation_id TEXT, priority TEXT NOT NULL,
        expires_at TEXT, idempotency_key TEXT, atrib_receipt_id TEXT,
        informed_by TEXT, metadata TEXT, created_at TEXT NOT NULL,
        UNIQUE(workspace, id)
      );
    `);
    legacy.close();

    const sqliteModule = pathToFileURL(join(process.cwd(), "dist/sqlite.js")).href;
    const script = `
      import { SQLiteBridgeStore } from ${JSON.stringify(sqliteModule)};
      const store = new SQLiteBridgeStore(process.env.AGENT_BRIDGE_TEST_DB);
      await store.initialize();
      await store.close();
    `;
    await Promise.all(Array.from({ length: 8 }, () => execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { env: { ...process.env, AGENT_BRIDGE_TEST_DB: path } },
    )));

    const upgraded = new DatabaseSync(path);
    const columns = upgraded.prepare("PRAGMA table_info(bridge_messages)").all() as Array<{
      name: string;
    }>;
    expect(columns.filter((column) => column.name === "project")).toHaveLength(1);
    upgraded.close();
  }, 15_000);
});
