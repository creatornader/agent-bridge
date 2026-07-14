import { describe, expect, it } from "vitest";
import { PostgresBridgeStore, type PgQueryable } from "../src/postgres-bridge-store.js";
import { parseResponse } from "../src/contracts/registry.js";

describe("PostgresBridgeStore", () => {
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
