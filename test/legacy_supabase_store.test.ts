import { describe, expect, it, vi } from "vitest";
import { LegacySupabaseError, LegacySupabaseRestStore } from "../src/legacy-supabase-store.js";
import { legacyMessageIdFromSequence } from "../src/legacy-compat.js";

describe("LegacySupabaseRestStore", () => {
  it("rejects plaintext credentials for remote providers", () => {
    expect(() => new LegacySupabaseRestStore("http://bridge.example.test", "key"))
      .toThrow("requires HTTPS");
    expect(() => new LegacySupabaseRestStore("http://127.0.0.1:54321", "key"))
      .not.toThrow();
  });

  it("rejects idempotency keys that the legacy schema cannot enforce", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const store = new LegacySupabaseRestStore("https://example.test", "key", fetchImpl);

    await expect(
      store.insertMessage({
        id: "018f4a70-0000-7000-8000-000000000011",
        workspace: "acme",
        source: "codex",
        type: "agent-bridge.context",
        content: "message",
        contentType: "text/plain",
        targets: [],
        priority: "info",
        idempotencyKey: "unsupported",
      }),
    ).rejects.toThrow("cannot enforce idempotency keys");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves envelope UUIDs when acknowledgment runs in a new process", async () => {
    const id = "018f4a70-0000-7000-8000-000000000011";
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/rpc/ack_context")) {
        expect(JSON.parse(String(init?.body))).toEqual({ entry_ids: ["42"], agent_name: "codex" });
        return new Response("1", { status: 200 });
      }
      return new Response(JSON.stringify([{ id: 42, metadata: { message_envelope: { message_id: id } } }]), { status: 200 });
    });
    const store = new LegacySupabaseRestStore("https://example.test", "key", fetchImpl);
    expect(await store.recordReceipt("*", [id], "codex")).toBe(1);
  });

  it("normalizes network failures for watcher retry classification", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new TypeError("offline"); });
    const store = new LegacySupabaseRestStore("https://example.test", "key", fetchImpl);
    await expect(store.initialize()).rejects.toMatchObject<Partial<LegacySupabaseError>>({
      status: 0,
      code: "network_error",
    });
  });

  it("maps large bigint IDs with the migration-compatible UUID", async () => {
    const sequence = "281474976710656";
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([{
      id: Number(sequence),
      source: "codex",
      category: "operational",
      content: "large legacy row",
      priority: "info",
      project: null,
      metadata: {},
      acked_by: [],
      created_at: "2026-07-14T00:00:00.000Z",
    }]), { status: 200 }));
    const store = new LegacySupabaseRestStore("https://example.test", "key", fetchImpl);
    const page = await store.listMessages({ workspace: "*", agent: "codex" }, { latest: true });
    expect(page.messages[0]?.id).toBe(legacyMessageIdFromSequence(sequence));
  });

  it("paginates newest-first legacy reads until envelope filters match", async () => {
    const irrelevant = Array.from({ length: 50 }, (_, index) => ({
      id: 100 - index,
      source: "codex",
      category: "request",
      content: "not for worker",
      priority: "info",
      project: "team",
      metadata: { message_envelope: { target_agents: ["other"] } },
      acked_by: [],
      created_at: "2026-07-14T00:00:00.000Z",
    }));
    const matching = {
      ...irrelevant[0],
      id: 50,
      content: "for worker",
      metadata: { message_envelope: { target_agents: ["worker"] } },
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => new Response(
      JSON.stringify(String(input).includes("id=lt.51") ? [matching] : irrelevant),
      { status: 200 },
    ));
    const store = new LegacySupabaseRestStore("https://example.test", "key", fetchImpl);
    const page = await store.listMessages(
      { workspace: "team", agent: "worker" },
      { latest: true, limit: 1 },
    );
    expect(page.messages.map((message) => message.content)).toEqual(["for worker"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("acknowledges large numeric IDs without Number coercion", async () => {
    const sequence = "9007199254740991";
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        entry_ids: [sequence],
        agent_name: "codex",
      });
      return new Response("1", { status: 200 });
    });
    const store = new LegacySupabaseRestStore("https://example.test", "key", fetchImpl);
    expect(await store.recordLegacyReceipt([sequence], "codex")).toBe(1);
  });

  it("reverses a large mapped UUID for acknowledgment after restart", async () => {
    const sequence = "9007199254740991";
    const mapped = legacyMessageIdFromSequence(sequence);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (!String(input).includes("/rpc/ack_context")) {
        return new Response("[]", { status: 200 });
      }
      expect(JSON.parse(String(init?.body))).toEqual({
        entry_ids: [sequence],
        agent_name: "codex",
      });
      return new Response("1", { status: 200 });
    });
    const restarted = new LegacySupabaseRestStore(
      "https://example.test",
      "key",
      fetchImpl,
    );
    expect(await restarted.recordReceipt("*", [mapped], "codex")).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("prefers an exact envelope UUID over a synthetic-looking ID", async () => {
    const envelopeId = "00000000-0000-8000-8000-000000000042";
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (!String(input).includes("/rpc/ack_context")) {
        return new Response(JSON.stringify([{
          id: 100,
          metadata: { message_envelope: { message_id: envelopeId } },
        }]), { status: 200 });
      }
      expect(JSON.parse(String(init?.body))).toEqual({
        entry_ids: ["100"],
        agent_name: "codex",
      });
      return new Response("1", { status: 200 });
    });
    const restarted = new LegacySupabaseRestStore(
      "https://example.test",
      "key",
      fetchImpl,
    );
    expect(await restarted.recordReceipt("*", [envelopeId], "codex")).toBe(1);
  });
});
