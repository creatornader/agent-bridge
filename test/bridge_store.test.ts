import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeService } from "../src/bridge-service.js";
import { encodeCursor } from "../src/bridge-domain.js";
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
      for (const field of ["threadId", "replyToId", "correlationId", "causationId", "expiresAt", "atribReceiptId"] as const) {
        expect(first.message[field]).toBeUndefined();
      }
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

    it("supports caller-relative inbox, sent, all, and receipt states", async () => {
      const service = new BridgeService(makeStore());
      const sender = { workspace: "acme", agent: "sender" };
      const worker = { workspace: "acme", agent: "worker" };
      const other = { workspace: "acme", agent: "other" };
      const targeted = await service.publish(sender, { type: "work", content: "targeted", targets: ["worker"] });
      const away = await service.publish(sender, { type: "work", content: "away", targets: ["other"] });
      const broadcast = await service.publish(other, { type: "context", content: "broadcast" });

      expect((await service.history(worker)).messages.map((message) => message.id)).toEqual([targeted.message.id, broadcast.message.id]);
      expect((await service.history(sender, { mailbox: "sent" })).messages.map((message) => message.id)).toEqual([targeted.message.id, away.message.id]);
      expect((await service.history(sender, { mailbox: "all" })).messages.map((message) => message.id)).toEqual([targeted.message.id, away.message.id, broadcast.message.id]);
      await service.acknowledge(worker, [targeted.message.id]);
      expect((await service.history(worker, { receiptState: "read" })).messages.map((message) => message.id)).toEqual([targeted.message.id]);
      expect((await service.history(worker, { receiptState: "unread" })).messages.map((message) => message.id)).toEqual([broadcast.message.id]);
      await expect(service.history(worker, { mailbox: "sent", receiptState: "read" })).rejects.toThrow("receiptState is valid only for inbox");
      await expect(service.history(worker, { unacknowledgedBy: "other" })).rejects.toMatchObject({
        code: "principal_mismatch",
        status: 403,
      });
      expect((await service.history({ workspace: "elsewhere", agent: "sender" }, { mailbox: "sent" })).messages).toEqual([]);
    });

    it("binds v2 cursors to principal and normalized query scope while accepting v1", async () => {
      const service = new BridgeService(makeStore());
      const sender = { workspace: "acme", agent: "sender" };
      await service.publish(sender, { type: "work", content: "one", targets: ["worker"] });
      await service.publish(sender, { type: "work", content: "two", targets: ["worker"] });
      const page = await service.history({ workspace: "acme", agent: "worker" }, { limit: 1 });
      await expect(service.history({ workspace: "acme", agent: "other" }, { cursor: page.cursor })).rejects.toThrow("cursor is invalid");
      await expect(service.history({ workspace: "acme", agent: "worker" }, { cursor: page.cursor, project: "different" })).rejects.toThrow("cursor is invalid");
      const legacy = await service.history({ workspace: "acme", agent: "worker" }, { cursor: encodeCursor("1") });
      expect(legacy.messages).toHaveLength(1);
      expect(JSON.parse(Buffer.from(legacy.cursor!, "base64url").toString()).v).toBe(2);
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

      const unread = await service.history(worker, { receiptState: "unread" });
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
        deliveryPolicy: { mode: "leased", maxAttempts: 1, retryJitterRatio: 0 },
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
        { maxAttempts: 99, jitterRatio: 1 },
      );
      expect(settled?.state).toBe("dead");
      expect((await store.listDeliveryEvents(source, claim!.delivery.id)).events.map((event) => event.toState))
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
        deliveryPolicy: { mode: "leased", maxAttempts: 1 },
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
    it("uses publisher policy, priority, authorization, cancellation, and monotonic requeue counters", async () => {
      const store = makeStore();
      const service = new BridgeService(store);
      const publisher = { workspace: "acme", agent: "publisher" };
      const worker = { workspace: "acme", agent: "worker", instance: "one" };
      const mailbox = await service.publish(publisher, { type: "note", content: "mail" });
      expect(mailbox.message.deliveryPolicy.mode).toBe("mailbox");
      await service.publish(publisher, { type: "work", content: "low", targets: ["worker"], priority: "info" });
      const urgent = await service.publish(publisher, { type: "work", content: "urgent", targets: ["worker"], priority: "urgent", deliveryPolicy: { mode: "leased", maxAttempts: 1, retryJitterRatio: 0 } });
      const claim = await service.claim(worker, { leaseMs: 1_000, maxAttempts: 99 });
      expect(claim?.delivery.messageId).toBe(urgent.message.id);
      expect((await service.nack(worker, claim!.delivery.id, claim!.leaseToken, "fail", false, { maxAttempts: 99 }))?.state).toBe("dead");
      expect((await service.deliveries({ ...publisher, agent: "stranger" })).deliveries).toHaveLength(0);
      const requeued = await service.requeue(publisher, claim!.delivery.id);
      expect(requeued).toMatchObject({ attempt: 1, cycleAttempt: 0, requeueCount: 1, state: "pending" });
      const reclaimed = await service.claim(worker, { leaseMs: 1_000 });
      expect(reclaimed?.delivery).toMatchObject({ attempt: 2, cycleAttempt: 1, requeueCount: 1 });
      expect((await service.cancel(publisher, reclaimed!.delivery.id))?.state).toBe("cancelled");
      expect(await service.ack(worker, reclaimed!.delivery.id, reclaimed!.leaseToken)).toBeNull();
      expect((await service.deliveryEvents(publisher, reclaimed!.delivery.id)).events.map((event) => event.toState)).toEqual(["pending", "claimed", "dead", "pending", "claimed", "cancelled"]);
    });

    it("normalizes delivery policies and keeps mailbox sends out of the work queue", async () => {
      const service = new BridgeService(makeStore());
      const publisher = { workspace: "acme", agent: "publisher" };
      const worker = { workspace: "acme", agent: "worker", instance: "one" };
      const broadcast = await service.publish(publisher, { type: "note", content: "broadcast" });
      expect(broadcast.message.deliveryPolicy).toEqual({ mode: "mailbox" });
      const targeted = await service.publish(publisher, { type: "work", content: "default", targets: ["worker"] });
      expect(targeted.message.deliveryPolicy).toEqual({
        mode: "leased", maxAttempts: 5, retryBaseDelayMs: 1_000,
        retryMaxDelayMs: 60_000, retryJitterRatio: 0.2,
      });
      await service.publish(publisher, {
        type: "note", content: "targeted mailbox", targets: ["worker"],
        deliveryPolicy: { mode: "mailbox" },
      });
      expect((await service.claim(worker, { leaseMs: 1_000 }))?.delivery.messageId)
        .toBe(targeted.message.id);
      await expect(service.publish(publisher, {
        type: "work", content: "missing target", deliveryPolicy: { mode: "leased" },
      })).rejects.toThrow("leased deliveryPolicy requires targets");
      await expect(service.publish(publisher, {
        type: "note", content: "bad mailbox", deliveryPolicy: { mode: "mailbox", maxAttempts: 2 },
      })).rejects.toThrow("mailbox deliveryPolicy accepts only mode");
      await expect(service.publish(publisher, {
        type: "work", content: "unknown", targets: ["worker"],
        deliveryPolicy: { mode: "leased", retryDelayMs: 5 },
      })).rejects.toThrow("deliveryPolicy.retryDelayMs is not supported");
    });

    it("enforces not-before and treats normalized policy as idempotent intent", async () => {
      const store = makeStore(); const service = new BridgeService(store);
      const publisher = { workspace: "acme", agent: "publisher" };
      const worker = { workspace: "acme", agent: "worker", instance: "one" };
      const notBefore = new Date(Date.now() + 60_000).toISOString();
      const expiresAt = new Date(Date.now() + 120_000).toISOString();
      const first = await service.publish(publisher, {
        type: "work", content: "scheduled", targets: ["worker"], expiresAt,
        idempotencyKey: "scheduled-work",
        deliveryPolicy: { mode: "leased", notBefore },
      });
      expect(first.message.deliveryPolicy).toMatchObject({ mode: "leased", notBefore });
      expect(await store.diagnostics!(worker)).toMatchObject({
        due: 0,
        scheduled: 1,
        queueLagMs: 0,
      });
      expect(await store.claimDelivery(worker, { leaseMs: 1_000, now: new Date() })).toBeNull();
      expect((await store.claimDelivery(worker, { leaseMs: 1_000, now: new Date(Date.now() + 61_000) }))?.messageId)
        .toBe(first.message.id);
      await expect(service.publish(publisher, {
        type: "work", content: "scheduled", targets: ["worker"], expiresAt,
        idempotencyKey: "scheduled-work",
        deliveryPolicy: { mode: "leased", notBefore: new Date(Date.now() + 30_000).toISOString() },
      })).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(service.publish(publisher, {
        type: "work", content: "invalid window", targets: ["worker"], expiresAt: notBefore,
        deliveryPolicy: { mode: "leased", notBefore },
      })).rejects.toThrow("deliveryPolicy.notBefore must be before expiresAt");
    });

    it("binds delivery pages and control transitions to the caller", async () => {
      const service = new BridgeService(makeStore());
      const publisher = { workspace: "acme", agent: "publisher" };
      const worker = { workspace: "acme", agent: "worker", instance: "one" };
      await service.publish(publisher, { type: "work", content: "one", targets: ["worker"] });
      await service.publish(publisher, { type: "work", content: "two", targets: ["worker"] });
      const page = await service.deliveries(worker, { role: "recipient", limit: 1 });
      expect(page.deliveries).toHaveLength(1);
      await expect(service.deliveries(publisher, { role: "publisher", cursor: page.cursor }))
        .rejects.toThrow("cursor is invalid");
      await expect(service.deliveries(worker, { role: "recipient", states: ["dead"], cursor: page.cursor }))
        .rejects.toThrow("cursor is invalid");
      const malformedDeliveryCursor = JSON.parse(Buffer.from(page.cursor!, "base64url").toString()) as {
        position: { createdAt: string };
      };
      malformedDeliveryCursor.position.createdAt = "2026-07-14";
      await expect(service.deliveries(worker, {
        role: "recipient",
        cursor: Buffer.from(JSON.stringify(malformedDeliveryCursor)).toString("base64url"),
      })).rejects.toThrow("cursor is invalid");
      const claim = await service.claim(worker, { leaseMs: 1_000 });
      const cancelled = await service.cancel(publisher, claim!.delivery.id);
      expect(cancelled?.state).toBe("cancelled");
      expect(await service.cancel(publisher, claim!.delivery.id)).toEqual(cancelled);
      expect(await service.ack(worker, claim!.delivery.id, claim!.leaseToken)).toBeNull();
      expect(await service.cancel({ ...publisher, agent: "other" }, claim!.delivery.id)).toBeNull();
      const events = await service.deliveryEvents(publisher, claim!.delivery.id);
      expect(events.events.map((event) => event.action)).toEqual(["created", "claim", "cancel"]);
      expect(events.events.map((event) => event.actor)).toEqual(["publisher", "worker", "publisher"]);
      expect(events.events[0]?.fromState).toBeUndefined();
      expect(events.events[0]?.leaseOwner).toBeUndefined();
      expect(events.events[0]?.error).toBeUndefined();
      expect(events.events.map((event) => [event.cycleAttempt, event.requeueCount]))
        .toEqual([[0, 0], [1, 0], [1, 0]]);
      expect((await service.requeue(publisher, claim!.delivery.id))?.state).toBe("pending");
      await expect(service.requeue(publisher, claim!.delivery.id))
        .rejects.toMatchObject({ code: "delivery_state_conflict", status: 409 });
      const eventPage = await service.deliveryEvents(publisher, claim!.delivery.id, { limit: 1 });
      const malformedEventCursor = JSON.parse(Buffer.from(eventPage.cursor!, "base64url").toString()) as {
        position: string;
      };
      malformedEventCursor.position = "9223372036854775808";
      await expect(service.deliveryEvents(publisher, claim!.delivery.id, {
        cursor: Buffer.from(JSON.stringify(malformedEventCursor)).toString("base64url"),
      })).rejects.toThrow("cursor is invalid");
      await expect(service.deliveryEvents(publisher, claim!.delivery.id, { limit: 0 }))
        .rejects.toThrow("limit must be between 1 and 200");
      await expect(service.deliveryEvents(publisher, claim!.delivery.id, { limit: 1.5 }))
        .rejects.toThrow("limit must be between 1 and 200");
    });

    it("fences cancel, nack, requeue, claim, and expired-at-limit races", async () => {
      const store = makeStore(); const service = new BridgeService(store);
      const publisher = { workspace: "acme", agent: "publisher" };
      const worker = { workspace: "acme", agent: "worker", instance: "one" };
      await service.publish(publisher, {
        type: "work", content: "race", targets: ["worker"],
        deliveryPolicy: { mode: "leased", maxAttempts: 1 },
      });
      const claim = await service.claim(worker, { leaseMs: 1_000 });
      await Promise.allSettled([
        service.cancel(publisher, claim!.delivery.id),
        service.nack(worker, claim!.delivery.id, claim!.leaseToken, "terminal", "dead"),
      ]);
      const terminalEvents = (await service.deliveryEvents(publisher, claim!.delivery.id)).events
        .filter((event) => event.action === "cancel" || event.action === "nack_dead");
      expect(terminalEvents).toHaveLength(1);
      const requeueRace = await Promise.allSettled([
        service.requeue(publisher, claim!.delivery.id),
        service.claim(worker, { leaseMs: 1_000 }),
      ]);
      expect(requeueRace.some((result) => result.status === "fulfilled")).toBe(true);
      expect((await service.deliveryEvents(publisher, claim!.delivery.id)).events
        .filter((event) => event.action === "requeue")).toHaveLength(1);
      const racedClaim = requeueRace[1]?.status === "fulfilled" ? requeueRace[1].value : null;
      const cleanupClaim = racedClaim ?? await service.claim(worker, { leaseMs: 1_000 });
      if (cleanupClaim) await service.ack(worker, cleanupClaim.delivery.id, cleanupClaim.leaseToken);

      await service.publish(publisher, {
        type: "work", content: "expire once", targets: ["worker"],
        deliveryPolicy: { mode: "leased", maxAttempts: 1 },
      });
      const limited = await service.claim(worker, { leaseMs: 1_000 });
      expect(await store.claimDelivery(worker, {
        leaseMs: 1_000, now: new Date(Date.now() + 1_001),
      })).toBeNull();
      expect(await store.claimDelivery(worker, {
        leaseMs: 1_000, now: new Date(Date.now() + 2_002),
      })).toBeNull();
      const terminal = (await service.deliveryEvents(publisher, limited!.delivery.id)).events
        .filter((event) => event.action === "attempts_exhausted");
      expect(terminal).toHaveLength(1);
    });
  });
}

bridgeStoreContract("SQLite", createStore);

describe("SQLite project schema upgrade", () => {
  it("claims exact same-time work by urgent, high, info, then delivery ID", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-bridge-priority-")); temporaryDirectories.push(directory);
    const path = join(directory, "bridge.sqlite"); const store = new SQLiteBridgeStore(path); stores.push(store);
    const service = new BridgeService(store); const publisher = { workspace: "acme", agent: "publisher" };
    const worker = { workspace: "acme", agent: "worker", instance: "one" };
    const info = await service.publish(publisher, { id: "018f4a70-0000-7000-8000-000000000081", type: "work", content: "info", targets: ["worker"], priority: "info" });
    const high = await service.publish(publisher, { id: "018f4a70-0000-7000-8000-000000000082", type: "work", content: "high", targets: ["worker"], priority: "high" });
    const urgentA = await service.publish(publisher, { id: "018f4a70-0000-7000-8000-000000000083", type: "work", content: "urgent-a", targets: ["worker"], priority: "urgent" });
    const urgentB = await service.publish(publisher, { id: "018f4a70-0000-7000-8000-000000000084", type: "work", content: "urgent-b", targets: ["worker"], priority: "urgent" });
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite"); const raw = new DatabaseSync(path);
    raw.exec("UPDATE bridge_deliveries SET created_at='2026-07-14T00:00:00.000Z',available_at='2026-07-14T00:00:00.000Z'");
    const urgentOrder = raw.prepare(`
      SELECT message_id FROM bridge_deliveries
      WHERE message_id IN (?, ?)
      ORDER BY id
    `).all(urgentA.message.id, urgentB.message.id) as Array<{ message_id: string }>;
    raw.close();
    const expected = urgentOrder.map((row) => row.message_id).concat(high.message.id, info.message.id);
    const actual: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const claim = await service.claim(worker, { leaseMs: 1_000 }); actual.push(claim!.delivery.messageId);
      await service.ack(worker, claim!.delivery.id, claim!.leaseToken);
    }
    expect(actual).toEqual(expected);
  });

  it("shares one initialization across concurrent calls on the same store", async () => {
    const store = new SQLiteBridgeStore();
    stores.push(store);
    await Promise.all(Array.from({ length: 8 }, () => store.initialize()));
    expect((await store.listMessages({ workspace: "acme", agent: "codex" })).messages)
      .toEqual([]);
  });

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

  it("preserves modern policies across restart and rejects invalid direct SQL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-bridge-policy-restart-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "bridge.sqlite");
    const firstStore = new SQLiteBridgeStore(path);
    const service = new BridgeService(firstStore);
    const publisher = { workspace: "acme", agent: "publisher" };
    const mailbox = await service.publish(publisher, {
      id: "018f4a70-0000-7000-8000-000000000091",
      type: "note",
      content: "targeted mailbox",
      targets: ["worker"],
      deliveryPolicy: { mode: "mailbox" },
    });
    const leased = await service.publish(publisher, {
      id: "018f4a70-0000-7000-8000-000000000092",
      type: "work",
      content: "future policy field",
      targets: ["worker"],
      deliveryPolicy: { mode: "leased", maxAttempts: 3, retryJitterRatio: 0 },
    });
    await firstStore.close();

    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec("DROP TRIGGER bridge_messages_no_update");
    raw.prepare(`UPDATE bridge_messages
      SET delivery_policy=json_set(delivery_policy,'$.futurePolicyVersion',2)
      WHERE id=?`).run(leased.message.id);
    const before = raw.prepare(`SELECT id,delivery_policy FROM bridge_messages
      WHERE id IN (?,?) ORDER BY id`).all(mailbox.message.id, leased.message.id) as Array<{
        id: string; delivery_policy: string;
      }>;
    raw.close();

    const restarted = new SQLiteBridgeStore(path);
    await restarted.initialize();
    await restarted.close();
    const verified = new DatabaseSync(path);
    const after = verified.prepare(`SELECT id,delivery_policy FROM bridge_messages
      WHERE id IN (?,?) ORDER BY id`).all(mailbox.message.id, leased.message.id) as Array<{
        id: string; delivery_policy: string;
      }>;
    expect(after).toEqual(before);

    const insert = verified.prepare(`INSERT INTO bridge_messages
      (id,workspace,source,type,content,content_type,targets,priority,expires_at,delivery_policy,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const invalidPolicies: Array<{ policy: Record<string, unknown>; targets?: string; expiresAt?: string }> = [
      { policy: { mode: "mailbox", maxAttempts: 2 } },
      { policy: { mode: "leased", maxAttempts: 2, retryBaseDelayMs: 1, retryMaxDelayMs: 2, retryJitterRatio: 0 }, targets: "[]" },
      { policy: { mode: "leased", maxAttempts: 1.5, retryBaseDelayMs: 1, retryMaxDelayMs: 2, retryJitterRatio: 0 } },
      { policy: { mode: "leased", maxAttempts: 2, retryBaseDelayMs: 0, retryMaxDelayMs: 2, retryJitterRatio: 0 } },
      { policy: { mode: "leased", maxAttempts: 2, retryBaseDelayMs: 2, retryMaxDelayMs: 1, retryJitterRatio: 0 } },
      { policy: { mode: "leased", maxAttempts: 2, retryBaseDelayMs: 1, retryMaxDelayMs: 2, retryJitterRatio: 2 } },
      { policy: { mode: "leased", maxAttempts: 2, retryBaseDelayMs: 1, retryMaxDelayMs: 2, retryJitterRatio: 0, notBefore: "2026-07-15T00:00:00.000Z" }, expiresAt: "2026-07-14T00:00:00.000Z" },
      { policy: { mode: "leased", maxAttempts: 2, retryBaseDelayMs: 1, retryMaxDelayMs: 2, retryJitterRatio: 0, unknown: true } },
    ];
    invalidPolicies.forEach(({ policy, targets = '["worker"]', expiresAt = null }, index) => {
      expect(() => insert.run(
        `invalid-${index}`, "acme", "publisher", "work", "invalid", "text/plain",
        targets, "info", expiresAt, JSON.stringify(policy), "2026-07-14T00:00:00.000Z",
      )).toThrow(/invalid delivery policy|CHECK constraint failed/);
    });
    verified.close();
  });

  it("rewrites only legacy policy rows and preserves unknown policy fields", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-bridge-policy-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "bridge.sqlite");
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE bridge_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,workspace TEXT NOT NULL,project TEXT,source TEXT NOT NULL,
      type TEXT NOT NULL,content TEXT NOT NULL,content_type TEXT NOT NULL,data TEXT,targets TEXT NOT NULL DEFAULT '[]',
      thread_id TEXT,reply_to_id TEXT,correlation_id TEXT,causation_id TEXT,priority TEXT NOT NULL,expires_at TEXT,
      idempotency_key TEXT,atrib_receipt_id TEXT,informed_by TEXT,metadata TEXT,delivery_policy TEXT NOT NULL,created_at TEXT NOT NULL,
      UNIQUE(workspace,id)
    )`);
    const insert = legacy.prepare(`INSERT INTO bridge_messages
      (id,workspace,source,type,content,content_type,targets,priority,delivery_policy,created_at)
      VALUES (?,'acme','publisher','work',?,'text/plain',?,'info',?,'2026-07-14T00:00:00.000Z')`);
    const modernLeased = '{"mode":"leased","maxAttempts":3,"retryBaseDelayMs":1000,"retryMaxDelayMs":60000,"retryJitterRatio":0,"futurePolicyVersion":4}';
    const modernMailbox = '{"mode":"mailbox"}';
    insert.run("modern-leased", "modern leased", '["worker"]', modernLeased);
    insert.run("modern-mailbox", "targeted mailbox", '["worker"]', modernMailbox);
    insert.run("legacy-mailbox", "legacy mailbox", '["worker"]', '{"mode":"mailbox","publisherOwned":true,"maxAttempts":7,"futureMailbox":"keep"}');
    insert.run("legacy-leased", "legacy leased", '["worker"]', '{"mode":"leased","publisherOwned":true,"maxAttempts":4,"baseDelayMs":2000,"maxDelayMs":70000,"jitterRatio":0.3,"futureLeased":"keep"}');
    legacy.close();

    const store = new SQLiteBridgeStore(path);
    await store.initialize();
    await store.close();
    const upgraded = new DatabaseSync(path);
    const policies = new Map((upgraded.prepare(
      "SELECT id,delivery_policy FROM bridge_messages ORDER BY id",
    ).all() as Array<{ id: string; delivery_policy: string }>).map((row) => [row.id, row.delivery_policy]));
    expect(policies.get("modern-leased")).toBe(modernLeased);
    expect(policies.get("modern-mailbox")).toBe(modernMailbox);
    expect(JSON.parse(policies.get("legacy-mailbox")!)).toEqual({ mode: "mailbox", futureMailbox: "keep" });
    expect(JSON.parse(policies.get("legacy-leased")!)).toEqual({
      mode: "leased", maxAttempts: 4, retryBaseDelayMs: 2_000,
      retryMaxDelayMs: 70_000, retryJitterRatio: 0.3, futureLeased: "keep",
    });
    upgraded.close();
  });

  it("allows concurrent processes to upgrade legacy messages, deliveries, and events", async () => {
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
      CREATE TABLE bridge_deliveries (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, workspace TEXT NOT NULL,
        recipient TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL, lease_token TEXT, lease_owner TEXT,
        lease_expires_at TEXT, last_error TEXT, UNIQUE(message_id, recipient)
      );
      CREATE TABLE bridge_delivery_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL,
        message_id TEXT NOT NULL, workspace TEXT NOT NULL, recipient TEXT NOT NULL,
        from_state TEXT, to_state TEXT NOT NULL, attempt INTEGER NOT NULL,
        lease_owner TEXT, error TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX bridge_deliveries_claim ON bridge_deliveries(workspace,recipient,state,available_at);
      CREATE INDEX bridge_delivery_events_lookup ON bridge_delivery_events(workspace,delivery_id,sequence);
      CREATE TRIGGER bridge_delivery_events_insert AFTER INSERT ON bridge_deliveries BEGIN SELECT 1; END;
      CREATE TRIGGER bridge_delivery_events_update AFTER UPDATE ON bridge_deliveries BEGIN SELECT 1; END;
      INSERT INTO bridge_messages
        (id,workspace,source,type,content,content_type,targets,priority,created_at)
      VALUES
        ('018f4a70-0000-7000-8000-000000000098','acme','publisher','work','legacy work','text/plain','["worker"]','high','2026-07-14T00:00:00.000Z');
      INSERT INTO bridge_deliveries
        (id,message_id,workspace,recipient,state,attempt,available_at,last_error)
      VALUES
        ('018f4a70-0000-7000-8000-000000000097','018f4a70-0000-7000-8000-000000000098','acme','worker','dead',2,'2026-07-14T00:00:00.000Z','legacy failure');
      INSERT INTO bridge_delivery_events
        (delivery_id,message_id,workspace,recipient,from_state,to_state,attempt,lease_owner,error,created_at)
      VALUES
        ('018f4a70-0000-7000-8000-000000000097','018f4a70-0000-7000-8000-000000000098','acme','worker',NULL,'pending',0,NULL,NULL,'2026-07-13T23:59:57.000Z'),
        ('018f4a70-0000-7000-8000-000000000097','018f4a70-0000-7000-8000-000000000098','acme','worker','pending','claimed',2,'worker-instance',NULL,'2026-07-13T23:59:58.000Z'),
        ('018f4a70-0000-7000-8000-000000000097','018f4a70-0000-7000-8000-000000000098','acme','worker','claimed','dead',2,NULL,'legacy failure','2026-07-13T23:59:59.000Z'),
        ('018f4a70-0000-7000-8000-000000000097','018f4a70-0000-7000-8000-000000000098','acme','worker','claimed','dead',2,NULL,'maximum attempts reached','2026-07-14T00:00:00.000Z');
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
    const delivery = upgraded.prepare("SELECT * FROM bridge_deliveries").get() as Record<string, unknown>;
    expect(delivery).toMatchObject({ attempt: 2, cycle_attempt: 2, requeue_count: 0, priority_rank: 1, last_actor: "worker-instance", last_action: "nack_dead" });
    const event = upgraded.prepare("SELECT * FROM bridge_delivery_events WHERE action='nack_dead'").get() as Record<string, unknown>;
    expect(event).toMatchObject({ attempt: 2, cycle_attempt: 2, requeue_count: 0, actor: "worker-instance", action: "nack_dead" });
    const actors = upgraded.prepare(
      "SELECT action,actor FROM bridge_delivery_events ORDER BY sequence",
    ).all() as Array<{ action: string; actor: string }>;
    expect(actors).toEqual([
      { action: "created", actor: "publisher" },
      { action: "claim", actor: "worker-instance" },
      { action: "nack_dead", actor: "worker-instance" },
      { action: "attempts_exhausted", actor: "agent-bridge" },
    ]);
    upgraded.close();
  }, 15_000);
});
