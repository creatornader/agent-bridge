import { describe, expect, it } from "vitest";
import { PostgresBridgeStore, type PgQueryable } from "../src/postgres-bridge-store.js";

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
});
