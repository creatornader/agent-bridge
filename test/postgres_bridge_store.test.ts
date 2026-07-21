import { describe, expect, it } from "vitest";
import { PostgresBridgeStore, type PgQueryable } from "../src/postgres-bridge-store.js";
import { parseResponse } from "../src/contracts/registry.js";

describe("PostgresBridgeStore", () => {
  it("omits informedBy when a migrated row stores SQL NULL", async () => {
    const db: PgQueryable = {
      query: async () => ({
        rows: [{
          id: "018f4a70-0000-7000-8000-000000000001",
          workspace: "acme",
          project: null,
          source: "legacy-agent",
          sequence: "1",
          type: "agent-bridge.context",
          content: "legacy message",
          content_type: "text/plain",
          data: null,
          targets: [],
          thread_id: null,
          reply_to_id: null,
          correlation_id: null,
          causation_id: null,
          priority: "info",
          expires_at: null,
          idempotency_key: null,
          atrib_receipt_id: null,
          informed_by: null,
          metadata: null,
          delivery_mode: "mailbox",
          created_at: new Date("2026-07-20T00:00:00.000Z"),
        }],
        rowCount: 1,
      }),
    };
    const page = await new PostgresBridgeStore(db).listMessages(
      { workspace: "acme", agent: "codex" },
      { latest: true },
    );

    expect(page.messages[0]?.informedBy).toBeUndefined();
    expect(() => parseResponse("history", page)).not.toThrow();
  });

  it("uses storage-side recipient filtering and SKIP LOCKED claims", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const db: PgQueryable = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [], rowCount: 0 }; } };
    const store = new PostgresBridgeStore(db);
    await store.listMessages({ workspace: "acme", agent: "worker" });
    await store.claimDelivery({ workspace: "acme", agent: "worker", instance: "one" }, { leaseMs: 30_000 });

    const history = calls.find((call) => call.sql.includes("targets ? $3"));
    expect(history?.sql).toContain("targets ? $3");
    expect(history?.sql).toContain("expires_at IS NULL OR expires_at > now()");
    const claim = calls.find((call) => call.sql.includes("FOR UPDATE OF delivery SKIP LOCKED"));
    expect(claim?.sql).toContain("FOR UPDATE OF delivery SKIP LOCKED");
    expect(calls.some((call) => call.sql.includes("lease_expires_at<=now()"))).toBe(true);
  });

  it("binds exact-message claim maintenance and selection to one message", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const db: PgQueryable = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [], rowCount: 0 }; } };
    const store = new PostgresBridgeStore(db);
    const messageId = "018f4a70-0000-7000-8000-000000000018";

    await store.claimDelivery(
      { workspace: "acme", agent: "worker", instance: "one" },
      { leaseMs: 30_000, messageId },
    );

    const deliveryQueries = calls.filter((call) => call.sql.includes("agent_bridge.deliveries"));
    expect(deliveryQueries).toHaveLength(4);
    for (const call of deliveryQueries) {
      expect(call.sql).toContain("delivery.message_id=$3");
      expect(call.values?.[2]).toBe(messageId);
    }
  });

  it("normalizes nullable delivery event columns before contract validation", async () => {
    const db: PgQueryable = {
      query: async () => ({
        rows: [{
          sequence: "1",
          delivery_id: "delivery-one",
          message_id: "message-one",
          workspace: "acme",
          recipient: "worker",
          from_state: null,
          to_state: "pending",
          attempt: 0,
          cycle_attempt: 0,
          requeue_count: 0,
          lease_owner: null,
          error: null,
          actor: "sender",
          action: "created",
          created_at: new Date("2026-07-14T00:00:00.000Z"),
        }],
        rowCount: 1,
      }),
    };
    const store = new PostgresBridgeStore(db);
    const page = await store.listDeliveryEvents(
      { workspace: "acme", agent: "worker" },
      "delivery-one",
    );

    expect(page.events[0]).toMatchObject({
      fromState: undefined,
      leaseOwner: undefined,
      error: undefined,
    });
    expect(() => parseResponse("list_delivery_events", page)).not.toThrow();
  });
});
