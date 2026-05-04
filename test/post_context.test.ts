import { describe, it, expect } from "vitest";
import { normalizeReceiptId } from "../src/atrib-receipt.js";

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
