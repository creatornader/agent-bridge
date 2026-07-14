import { describe, it, expect } from "vitest";
import { normalizeReceiptId } from "../src/atrib-receipt.js";
import {
  buildMessageEnvelope,
  filterContextRows,
  mergeEnvelopeMetadata,
  MESSAGE_ENVELOPE_SCHEMA,
} from "../src/message-envelope.js";

// A real §1.5.2 token from the Loop 5 smoke test (row #210, log entry 497).
// Format: <43 base64url>.<43 base64url>.
const VALID_TOKEN =
  "OL9GMj6QjKD55xWpOB6AvYIf-2--Ivh3Al6XuorYh3k.haoZK4D1AXmy_r05GJP4CZGOv0zh0iK1l7ls1FA8oZI";

describe("normalizeReceiptId", () => {
  it("accepts a well-formed §1.5.2 propagation token", () => {
    expect(normalizeReceiptId(VALID_TOKEN)).toBe(VALID_TOKEN);
  });

  it("rejects undefined", () => {
    expect(normalizeReceiptId(undefined)).toBeUndefined();
  });

  it("rejects null", () => {
    expect(normalizeReceiptId(null)).toBeUndefined();
  });

  it("rejects an empty string", () => {
    expect(normalizeReceiptId("")).toBeUndefined();
  });

  it("rejects a non-string value", () => {
    expect(normalizeReceiptId(123)).toBeUndefined();
    expect(normalizeReceiptId({ token: VALID_TOKEN })).toBeUndefined();
    expect(normalizeReceiptId([VALID_TOKEN])).toBeUndefined();
  });

  it("rejects a token missing the dot separator", () => {
    const noDot = VALID_TOKEN.replace(".", "");
    expect(normalizeReceiptId(noDot)).toBeUndefined();
  });

  it("rejects a token with the wrong half-lengths", () => {
    // 42 chars on the left half (one short).
    const shortHash = VALID_TOKEN.slice(1);
    expect(normalizeReceiptId(shortHash)).toBeUndefined();
    // 42 chars on the right half (one short).
    const shortKey = VALID_TOKEN.slice(0, -1);
    expect(normalizeReceiptId(shortKey)).toBeUndefined();
    // 44 chars on the left half (one long).
    const longHash = "A" + VALID_TOKEN;
    expect(normalizeReceiptId(longHash)).toBeUndefined();
  });

  it("rejects a token with non-base64url characters", () => {
    // base64url alphabet excludes + and /; standard base64 includes them.
    const standardBase64 = VALID_TOKEN.replace(/-/g, "+").replace(/_/g, "/");
    if (standardBase64 !== VALID_TOKEN) {
      expect(normalizeReceiptId(standardBase64)).toBeUndefined();
    }
    // Whitespace is also out.
    expect(normalizeReceiptId(VALID_TOKEN + " ")).toBeUndefined();
    expect(normalizeReceiptId(" " + VALID_TOKEN)).toBeUndefined();
  });

  it("rejects garbage strings of the right total length", () => {
    // 87 chars but not a valid format (e.g., all dots).
    const garbage = ".".repeat(87);
    expect(normalizeReceiptId(garbage)).toBeUndefined();
  });
});

describe("message envelope", () => {
  it("builds the default envelope for a legacy post", () => {
    const envelope = buildMessageEnvelope({
      source: "codex",
      category: "goal-update",
      content: "Shipped the thing",
    });

    expect(envelope.schema).toBe(MESSAGE_ENVELOPE_SCHEMA);
    expect(envelope.source_agent).toBe("codex");
    expect(envelope.kind).toBe("goal-update");
    expect(envelope.priority).toBe("info");
    expect(envelope.payload_mime).toBe("text/plain");
    expect(envelope.message_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("normalizes envelope routing and causal fields", () => {
    const envelope = buildMessageEnvelope(
      {
        source: "codex",
        category: "goal-update",
        message_id: "msg-1",
        target_agents: ["sido", "sido", "claude-code"],
        thread_id: "thread-1",
        reply_to_id: "msg-0",
        kind: "handoff",
        priority: "high",
        payload_mime: "application/json",
        payload: { ok: true },
        payload_ref: "r2://bucket/key",
        payload_ciphertext: "age:abc",
        informed_by: [
          "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          "not-a-record",
        ],
        expires_at: "2026-05-25T12:34:56-05:00",
      },
      VALID_TOKEN
    );

    expect(envelope).toMatchObject({
      schema: MESSAGE_ENVELOPE_SCHEMA,
      message_id: "msg-1",
      source_agent: "codex",
      target_agents: ["sido", "claude-code"],
      thread_id: "thread-1",
      reply_to_id: "msg-0",
      kind: "handoff",
      priority: "high",
      payload_mime: "application/json",
      payload: { ok: true },
      payload_ref: "r2://bucket/key",
      payload_ciphertext: "age:abc",
      atrib_receipt_id: VALID_TOKEN,
      informed_by: [
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
      expires_at: "2026-05-25T17:34:56.000Z",
    });
  });

  it("merges the canonical envelope into existing metadata", () => {
    const metadata = mergeEnvelopeMetadata(
      { existing: true, message_envelope: { spoofed: true } },
      { schema: MESSAGE_ENVELOPE_SCHEMA, message_id: "msg-1" }
    );

    expect(metadata).toEqual({
      existing: true,
      message_envelope: {
        schema: MESSAGE_ENVELOPE_SCHEMA,
        message_id: "msg-1",
      },
    });
  });

  it("filters rows by target, thread, and kind", () => {
    const rows = [
      {
        id: 1,
        metadata: {
          message_envelope: {
            target_agents: ["codex"],
            thread_id: "thread-a",
            kind: "request",
          },
        },
      },
      {
        id: 2,
        metadata: {
          message_envelope: {
            target_agents: ["sido"],
            thread_id: "thread-a",
            kind: "request",
          },
        },
      },
      {
        id: 3,
        metadata: {
          message_envelope: {
            thread_id: "thread-a",
            kind: "request",
          },
        },
      },
      {
        id: 4,
        metadata: {},
      },
    ];

    expect(
      filterContextRows(
        rows,
        { target_agent: "codex", thread_id: "thread-a", kind: "request" },
        20
      )
    ).toEqual([rows[0], rows[2]]);
  });
});
