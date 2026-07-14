import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "bin", "agent-bridge");
const temporaryHomes: string[] = [];

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-"));
  temporaryHomes.push(home);
  mkdirSync(join(home, ".agent-bridge"), { recursive: true });
  writeFileSync(
    join(home, ".agent-bridge", "config"),
    "AGENT_BRIDGE_URL=https://bridge.example.test\nAGENT_BRIDGE_KEY=test-key\n",
  );

  const binDir = join(home, "bin");
  mkdirSync(binDir);
  const curlPath = join(binDir, "curl");
  writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-d" ]]; then
    printf '%s' "$2"
    exit 0
  fi
  shift
done
`,
  );
  chmodSync(curlPath, 0o755);
  return { home, binDir };
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  return spawnSync(cliPath, args, {
    encoding: "utf8",
    env,
  });
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("agent-bridge CLI", () => {
  it("defaults post source from AGENT_BRIDGE_AGENT", () => {
    const { home, binDir } = setupHome();
    const result = runCli(
      ["post", "--category", "operational", "Bridge is ready"],
      {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH}`,
        AGENT_BRIDGE_AGENT: "codex",
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      source: "codex",
      category: "operational",
      content: "Bridge is ready",
    });
  });

  it("explains when a source is required", () => {
    const { home, binDir } = setupHome();
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
    };
    delete env.AGENT_BRIDGE_AGENT;

    const result = runCli(
      ["post", "--category", "operational", "Bridge is ready"],
      env,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--source is required only when AGENT_BRIDGE_AGENT is unset",
    );
  });
});
