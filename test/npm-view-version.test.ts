import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const parser = fileURLToPath(new URL("../scripts/npm-view-version.mjs", import.meta.url));

function parseNpmViewVersion(value: string): string {
  return execFileSync(process.execPath, [parser, value], { encoding: "utf8" });
}

describe("npm view version output", () => {
  it("accepts scalar and array JSON responses", () => {
    expect(parseNpmViewVersion('"0.7.8"')).toBe("0.7.8");
    expect(parseNpmViewVersion('["0.7.8"]')).toBe("0.7.8");
  });

  it("rejects empty and non-string responses", () => {
    expect(() => parseNpmViewVersion("[]")).toThrow();
    expect(() => parseNpmViewVersion('{"version":"0.7.8"}')).toThrow();
  });
});
