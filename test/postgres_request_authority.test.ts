import { describe, expect, it } from "vitest";
import { MutationOutcomeUnknownError, PostgresRequestAuthority } from "../src/postgres-request-authority.js";

function fixture(overrides: { failCommit?: boolean; failRollback?: boolean; onQuery?: (sql: string) => void } = {}) {
  const calls: string[] = [];
  let released: unknown;
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      overrides.onQuery?.(sql);
      if (sql === "COMMIT" && overrides.failCommit) throw new Error("connection lost");
      if (sql === "ROLLBACK" && overrides.failRollback) throw new Error("rollback lost");
      if (sql.includes("open_request_authority")) return { rows: [{
        gateway_authority_id: "00000000-0000-4000-8000-000000000003",
        credential_id: "00000000-0000-4000-8000-000000000001",
        workspace_id: "workspace-a",
        principal: "agent-a",
        scopes: ["messages:write"],
      }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: (error?: unknown) => { released = error; },
  };
  return { authority: new PostgresRequestAuthority({ connect: async () => client } as any), calls, released: () => released };
}

describe("PostgresRequestAuthority", () => {
  it("uses one client and outer transaction while inner store transactions do not nest", async () => {
    const value = fixture();
    await value.authority.run("00000000-0000-4000-8000-000000000001", "a".repeat(64), "00000000-0000-4000-8000-000000000002", new AbortController().signal, async (context) => {
      expect(context.gatewayAuthorityId).toBe("00000000-0000-4000-8000-000000000003");
      await context.beginDomainWork();
      await context.store.claimDelivery({ workspace: "workspace-a", agent: "agent-a" }, { leaseMs: 1000 });
      return "ok";
    });
    expect(value.calls.filter((sql) => sql === "BEGIN")).toHaveLength(1);
    expect(value.calls.some((sql) => sql.includes("open_request_authority_bound"))).toBe(true);
    expect(value.calls).toContain("SAVEPOINT agent_bridge_domain_work");
    expect(value.calls.at(-1)).toBe("COMMIT");
    expect(value.released()).toBeUndefined();
  });

  it("rolls domain work back to its savepoint but commits security effects on expected rejection", async () => {
    const value = fixture();
    await expect(value.authority.run("00000000-0000-4000-8000-000000000001", "a".repeat(64), "00000000-0000-4000-8000-000000000002", new AbortController().signal, async (context) => {
      await context.beginDomainWork();
      throw Object.assign(new Error("conflict"), { status: 409, code: "conflict" });
    })).rejects.toMatchObject({ code: "conflict" });
    expect(value.calls).toContain("ROLLBACK TO SAVEPOINT agent_bridge_domain_work");
    expect(value.calls.at(-1)).toBe("COMMIT");
  });

  it("returns mutation_outcome_unknown and discards the client after commit ambiguity", async () => {
    const value = fixture({ failCommit: true });
    await expect(value.authority.run("00000000-0000-4000-8000-000000000001", "a".repeat(64), "00000000-0000-4000-8000-000000000002", new AbortController().signal, async () => undefined))
      .rejects.toBeInstanceOf(MutationOutcomeUnknownError);
    expect(value.calls.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(value.calls).not.toContain("ROLLBACK");
    expect(value.released()).toBeInstanceOf(Error);
  });

  it("rolls back an abort before commit", async () => {
    const value = fixture();
    const abort = new AbortController();
    await expect(value.authority.run("00000000-0000-4000-8000-000000000001", "a".repeat(64), "00000000-0000-4000-8000-000000000002", abort.signal, async () => {
      abort.abort(new Error("aborted"));
    })).rejects.toThrow("aborted");
    expect(value.calls.at(-1)).toBe("ROLLBACK");
    expect(value.calls).not.toContain("COMMIT");
  });

  it("rolls back when the deadline fires while authority is closing", async () => {
    const abort = new AbortController();
    const value = fixture({
      onQuery: (sql) => {
        if (sql.includes("close_request_authority")) abort.abort(new Error("deadline"));
      },
    });
    await expect(value.authority.run(
      "00000000-0000-4000-8000-000000000001",
      "a".repeat(64),
      "00000000-0000-4000-8000-000000000002",
      abort.signal,
      async () => undefined,
    )).rejects.toThrow("deadline");
    expect(value.calls).toContain("ROLLBACK");
    expect(value.calls).not.toContain("COMMIT");
  });

  it("discards the client when rollback fails", async () => {
    const value = fixture({ failRollback: true });
    const abort = new AbortController();
    await expect(value.authority.run("00000000-0000-4000-8000-000000000001", "a".repeat(64), "00000000-0000-4000-8000-000000000002", abort.signal, async () => {
      abort.abort(new Error("aborted"));
    })).rejects.toThrow("aborted");
    expect(value.released()).toBeInstanceOf(Error);
  });
});
