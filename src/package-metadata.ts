import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("package version is unavailable");
  }
  return manifest.version;
}

export function buildRevision(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^[0-9a-f]{7,40}$/u.test(value)) {
    throw new Error("AGENT_BRIDGE_BUILD_REVISION must be a lowercase Git commit hash");
  }
  return value;
}
