import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
describe("runtime manifests", () => {
  for (const runtime of ["codex", "claude-code", "claude-desktop", "openclaw", "generic-mcp"]) it(`${runtime} injects identity instead of hardcoding it`, () => {
    const manifest = JSON.parse(readFileSync(join(root, "clients", `${runtime}.json`), "utf8"));
    expect(manifest.runtime).toBe(runtime); expect(manifest.identity).toEqual({ source: "env", variable: "AGENT_BRIDGE_AGENT", required: true }); expect(JSON.stringify(manifest)).not.toContain(`\"agent\":\"${runtime}\"`);
    expect(manifest.instance).toEqual({ source: "env", variable: "AGENT_BRIDGE_INSTANCE", required: true });
    expect(manifest.backendConfig).toEqual({ source: "env", variable: "AGENT_BRIDGE_CONFIG", perClient: true });
    expect(manifest.install.identityValue).toBe("operator-selected");
    if (["codex", "claude-code"].includes(runtime)) {
      expect(manifest.install.command.join(" ")).toContain("AGENT_BRIDGE_AGENT={{identity}}");
      expect(manifest.install.command.join(" ")).toContain("AGENT_BRIDGE_INSTANCE={{instance}}");
      expect(manifest.install.command.join(" ")).toContain("AGENT_BRIDGE_CONFIG={{backendConfig}}");
      expect(manifest.install.instanceValue).toBe("installer-generated");
    }
  });
});
