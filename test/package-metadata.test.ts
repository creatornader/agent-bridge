import { describe, expect, it } from "vitest";
import { buildRevision, packageVersion } from "../src/package-metadata.js";

describe("package metadata", () => {
  it("reads the installed package version", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("accepts Git revisions and rejects untrusted labels", () => {
    expect(buildRevision(undefined)).toBeUndefined();
    expect(buildRevision("")).toBeUndefined();
    expect(buildRevision("a".repeat(40))).toBe("a".repeat(40));
    expect(() => buildRevision("main")).toThrow("must be a lowercase Git commit hash");
  });
});
