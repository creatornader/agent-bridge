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
    expect(await store.recordReceipt({ workspace: "*", agent: "codex" }, [id])).toBe(1);
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

  it("preserves project labels on legacy writes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("metadata=cs.")) return Response.json([]);
      expect(JSON.parse(String(init?.body))).toMatchObject({ project: "project-alpha" });
      return Response.json([{
        id: 42,
        source: "codex",
        category: "operational",
        content: "project-scoped",
        priority: "info",
        project: "project-alpha",
        metadata: {},
        acked_by: [],
        created_at: "2026-07-14T00:00:00.000Z",
      }]);
    });
    const store = new LegacySupabaseRestStore("https://example.test", "key", fetchImpl);
    const result = await store.insertMessage({
      id: "018f4a70-0000-7000-8000-000000000012",
      workspace: "agent-bridge",
      project: "project-alpha",
      source: "codex",
      type: "operational",
      content: "project-scoped",
      contentType: "text/plain",
      targets: [],
      priority: "info",
    });
    expect(result.message).toMatchObject({ workspace: "agent-bridge", project: "project-alpha" });
  });

  it("replays an exact legacy UUID and rejects changed immutable intent", async () => {
    let stored: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("metadata=cs.")) {
        return Response.json(stored ? [stored] : []);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      stored = {
        id: 42,
        ...body,
        acked_by: [],
        created_at: "2026-07-14T00:00:00.000Z",
      };
      return Response.json([stored]);
    });
    const store = new LegacySupabaseRestStore("https://example.test", "key", fetchImpl);
    const exact = {
      id: "018f4a70-0000-7000-8000-000000000013",
      workspace: "agent-bridge",
      project: "project-alpha",
      source: "codex",
      type: "operational",
      content: "stable intent",
      contentType: "text/plain",
      targets: [] as string[],
      priority: "info" as const,
    };

    expect(await store.insertMessage(exact)).toMatchObject({ created: true });
    expect(await store.insertMessage(exact)).toMatchObject({
      created: false,
      message: { id: exact.id, project: "project-alpha", content: "stable intent" },
    });
    await expect(store.insertMessage({ ...exact, project: "project-beta" }))
      .rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    await expect(store.insertMessage({ ...exact, content: "changed intent" }))
      .rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("uses exact project filtering and leaves omitted reads cross-project", async () => {
    const rows = [
      {
        id: 1, source: "codex", category: "operational", content: "alpha",
        priority: "info", project: "project-alpha", metadata: {}, acked_by: [],
        created_at: "2026-07-14T00:00:00.000Z",
      },
      {
        id: 2, source: "codex", category: "operational", content: "unlabeled",
        priority: "info", project: null, metadata: {}, acked_by: [],
        created_at: "2026-07-14T00:00:01.000Z",
      },
    ];
    const urls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      urls.push(url);
      return Response.json(url.includes("project=eq.project-alpha") ? [rows[0]] : rows);
    });
    const store = new LegacySupabaseRestStore("https://example.test", "key", fetchImpl);

    expect((await store.listMessages(
      { workspace: "agent-bridge", agent: "codex" },
      { project: "project-alpha" },
    )).messages.map((message) => message.content)).toEqual(["alpha"]);
    expect((await store.listMessages(
      { workspace: "agent-bridge", agent: "codex" },
    )).messages.map((message) => message.content)).toEqual(["alpha", "unlabeled"]);
    expect(urls[0]).toContain("project=eq.project-alpha");
    expect(urls[1]).not.toContain("project=eq.");
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
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (!String(input).includes("/rpc/ack_context")) {
        return Response.json([{ id: sequence, source: "sender", metadata: {} }]);
      }
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
        if (String(input).includes("metadata=cs.")) return new Response("[]", { status: 200 });
        return Response.json([{ id: sequence, source: "sender", metadata: {} }]);
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
    expect(await restarted.recordReceipt({ workspace: "*", agent: "codex" }, [mapped])).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not acknowledge a targeted row for an unrelated principal", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("/rpc/ack_context")) {
        throw new Error("receipt RPC must not be called");
      }
      return Response.json([{
        id: 42,
        source: "sender",
        metadata: { message_envelope: { target_agents: ["worker"] } },
      }]);
    });
    const store = new LegacySupabaseRestStore("https://example.test", "key", fetchImpl);
    expect(await store.recordLegacyReceipt(["42"], "other")).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("batches legacy receipt visibility checks and caps the request", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/rpc/ack_context")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          entry_ids: ["42", "43"],
          agent_name: "worker",
        });
        return new Response("2", { status: 200 });
      }
      expect(String(input)).toContain("id=in.(42,43)");
      return Response.json([
        { id: 43, source: "sender", metadata: {} },
        { id: 42, source: "sender", metadata: {} },
      ]);
    });
    const store = new LegacySupabaseRestStore("https://example.test", "key", fetchImpl);
    expect(await store.recordLegacyReceipt(["42", "43"], "worker")).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(store.recordLegacyReceipt(
      Array.from({ length: 201 }, (_, index) => String(index + 1)),
      "worker",
    )).rejects.toThrow("between 1 and 200");
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
    expect(await restarted.recordReceipt({ workspace: "*", agent: "codex" }, [envelopeId])).toBe(1);
  });
});
