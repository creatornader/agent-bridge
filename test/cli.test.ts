import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cli = join(root, "bin", "agent-bridge");
const homes: string[] = [];
function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
  return runAt(home, args, extra);
}
function runAt(home: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, HOME: home, AGENT_BRIDGE_PROVIDER: "local", AGENT_BRIDGE_DB: join(home, "bridge.sqlite3"), ...extra } });
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("agent-bridge CLI", () => {
  it("does not load SQLite for a legacy provider command", () => {
    const result = run(["help"], {
      AGENT_BRIDGE_PROVIDER: "legacy-supabase",
      AGENT_BRIDGE_URL: "https://supabase.test",
      AGENT_BRIDGE_KEY: "publishable-key",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("ExperimentalWarning: SQLite");
  });
  it("keeps post as an alias and defaults source from runtime identity", () => {
    const result = run(["post", "--category", "operational", "Bridge is ready"], { AGENT_BRIDGE_AGENT: "codex" });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout).message).toMatchObject({ source: "codex", type: "operational", content: "Bridge is ready" });
  });
  it("accepts an explicit source when the environment has no identity", () => {
    const result = run(["send", "--source", "codex", "Bridge is ready"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).message.source).toBe("codex");
  });
  it("rejects a conflicting explicit source", () => {
    const result = run(["send", "--source", "claude-code", "Bridge is ready"], { AGENT_BRIDGE_AGENT: "codex" });
    expect(result.status).toBe(1); expect(result.stderr).toContain("source must match AGENT_BRIDGE_AGENT (codex)");
  });
  it("runs the deterministic two-client local demo", () => {
    const result = run(["demo"], { AGENT_BRIDGE_AGENT: "operator" });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ status: "ok", principals: ["demo-sender", "demo-worker"], acknowledged: true });
  });
  it("does not treat an unacknowledged filter as caller identity", () => {
    const result = run(["get", "--unacked-by", "worker"], { AGENT_BRIDGE_AGENT: undefined });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGENT_BRIDGE_AGENT is required");
  });
  it("preserves legacy envelope flags", () => {
    const result = run([
      "post", "--source", "codex", "--kind", "request",
      "--payload-ref", "file:///tmp/result.json",
      "--payload-ciphertext", "ciphertext", "run task",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).message).toMatchObject({
      type: "request",
      metadata: { message_envelope: {
        payload_ref: "file:///tmp/result.json",
        payload_ciphertext: "ciphertext",
      } },
    });
  });
  it("rejects non-object metadata before envelope fields are lost", () => {
    const result = run(["post", "--source", "codex", "--metadata", "[]", "--payload-ref", "file:///tmp/result", "run"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--metadata must be a JSON object");
  });
  it("rejects unknown flags before a targeted post can become a broadcast", () => {
    const result = run(["post", "--source", "codex", "--no-such-option", "worker", "secret"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown option: --no-such-option");
  });
  it("rejects a missing target value instead of routing to a true literal", () => {
    const result = run(["post", "--source", "codex", "--target-agent", "--category", "request", "secret"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--target-agent requires a value");
  });
  it("rejects invalid client installation scopes", () => {
    const result = run(["clients", "install", "claude-code", "--identity", "claude-work", "--scope", "machine"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scope must be local, user, or project");
  });
  it("parses explicit boolean values without truthy string coercion", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const config = join(home, ".agent-bridge", "config");
    expect(runAt(home, ["init", "--provider", "local", "--config", config]).status).toBe(0);
    const retained = runAt(home, [
      "init", "--provider", "local", "--config", config, "--force", "false",
    ]);
    expect(retained.status).toBe(1);
    expect(retained.stderr).toContain("Config already exists");
    const invalid = runAt(home, ["watch", "--polls", "0", "--json", "sometimes"], {
      AGENT_BRIDGE_AGENT: "codex",
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("--json must be true or false");
  });
  it("reconstructs the complete compatibility envelope on read", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const sent = runAt(home, [
      "post", "--source", "codex", "--target-agent", "worker",
      "--thread-id", "thread-1", "--payload-ref", "file:///tmp/result.json", "run task",
    ]);
    expect(sent.status).toBe(0);
    const result = runAt(home, ["get", "--as", "worker"], { AGENT_BRIDGE_AGENT: undefined });
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout)[0].metadata.message_envelope;
    expect(envelope).toMatchObject({
      source_agent: "codex",
      kind: "operational",
      target_agents: ["worker"],
      thread_id: "thread-1",
      payload_ref: "file:///tmp/result.json",
    });
    expect(envelope.message_id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("returns legacy get rows newest first", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    expect(runAt(home, ["post", "--source", "codex", "first"]).status).toBe(0);
    expect(runAt(home, ["post", "--source", "codex", "second"]).status).toBe(0);
    const result = runAt(home, ["get", "--as", "codex", "--limit", "2"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).map((row: { content: string }) => row.content)).toEqual(["second", "first"]);
  });
  it("creates a private config and initializes local storage", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const config = join(home, ".agent-bridge", "config");
    const database = join(home, ".agent-bridge", "bridge.sqlite3");
    const result = spawnSync(process.execPath, [cli,
      "init", "--provider", "local",
    ], { encoding: "utf8", env: { ...process.env, HOME: home, AGENT_BRIDGE_CONFIG: config } });
    expect(result.status).toBe(0);
    if (process.platform !== "win32") expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(readFileSync(config, "utf8")).not.toContain("AGENT_BRIDGE_AGENT");
    if (process.platform !== "win32") {
      expect(statSync(join(home, ".agent-bridge")).mode & 0o777).toBe(0o700);
      expect(statSync(database).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(database)).toBe(true);
  });
  it("keeps the previous config when forced initialization cannot connect", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const config = join(home, ".agent-bridge", "config");
    const previous = "AGENT_BRIDGE_PROVIDER=local\nAGENT_BRIDGE_WORKSPACE=working\n";
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, previous);
    const result = spawnSync(process.execPath, [cli,
      "init", "--force", "--provider", "gateway",
      "--url", "http://127.0.0.1:1", "--token", "bad-token",
    ], { encoding: "utf8", env: { ...process.env, HOME: home, AGENT_BRIDGE_CONFIG: config } });
    expect(result.status).toBe(1);
    expect(readFileSync(config, "utf8")).toBe(previous);
  });
  it("reports real local queue diagnostics", () => {
    const result = run(["doctor"], { AGENT_BRIDGE_AGENT: "codex" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      connected: true,
      queue: { deliverySupported: true, pending: 0, claimed: 0, retrying: 0, dead: 0 },
    });
  });
  it("provides a cheap pending-work process gate", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const empty = runAt(home, ["pending"], { AGENT_BRIDGE_AGENT: "worker" });
    expect(empty.status).toBe(1);
    expect(JSON.parse(empty.stdout)).toMatchObject({
      available: false,
      unread: false,
      deliveryAvailable: false,
      authoritative: true,
    });
    expect(runAt(home, [
      "send", "--source", "codex", "--target", "worker", "run the task",
    ]).status).toBe(0);
    const ready = runAt(home, ["pending"], { AGENT_BRIDGE_AGENT: "worker" });
    expect(ready.status).toBe(0);
    expect(JSON.parse(ready.stdout)).toMatchObject({
      available: true,
      unread: true,
      deliveryAvailable: true,
      pending: 1,
    });
  });
});
