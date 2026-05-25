import { describe, expect, it } from "vitest";
import { resolvePostSource } from "../src/source-identity.js";

describe("resolvePostSource", () => {
  it("accepts a source that matches the configured agent", () => {
    expect(resolvePostSource("codex", "codex")).toBe("codex");
  });

  it("falls back to the configured agent when no source is passed", () => {
    expect(resolvePostSource(undefined, "claude-code")).toBe("claude-code");
  });

  it("keeps legacy source arguments when no configured agent exists", () => {
    expect(resolvePostSource("sido", undefined)).toBe("sido");
  });

  it("rejects source labels that do not match the configured agent", () => {
    expect(() => resolvePostSource("claude-code", "codex")).toThrow(
      "source must match AGENT_BRIDGE_AGENT (codex); got claude-code"
    );
  });
});
