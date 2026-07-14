import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteEdgeStore } from "../src/sqlite-edge-store.js";

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
function runAtAsync(home: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, HOME: home, AGENT_BRIDGE_PROVIDER: "local", AGENT_BRIDGE_DB: join(home, "bridge.sqlite3"), ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
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
  it("reports unknown when gateway pending has no authoritative data", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const result = runAt(home, ["pending"], {
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: "http://127.0.0.1:1",
      AGENT_BRIDGE_TOKEN: "test-token",
      AGENT_BRIDGE_AGENT: "worker",
      AGENT_BRIDGE_WORKSPACE: "acme",
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      available: false,
      unread: false,
      authoritative: false,
      state: "unknown",
    });
  });
  it("reports cached gateway candidates as available but not authoritative", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const endpoint = "http://127.0.0.1:1";
    const principal = { workspace: "acme", agent: "worker" };
    const path = join(home, ".agent-bridge", "edge.sqlite3");
    mkdirSync(dirname(path), { recursive: true });
    const edge = new SQLiteEdgeStore(path, { endpoint, principal });
    await edge.initialize();
    await edge.cacheLatest([{
      id: "018f4a70-0000-7000-8000-000000000199",
      sequence: "1",
      workspace: "acme",
      source: "codex",
      type: "request",
      content: "cached work",
      contentType: "text/plain",
      targets: ["worker"],
      priority: "high",
      createdAt: new Date().toISOString(),
    }]);
    await edge.close();

    const result = runAt(home, ["pending"], {
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: endpoint,
      AGENT_BRIDGE_TOKEN: "test-token",
      AGENT_BRIDGE_AGENT: "worker",
      AGENT_BRIDGE_WORKSPACE: "acme",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      available: true,
      unread: true,
      authoritative: false,
      state: "available",
    });
  });
  it("keeps pending non-authoritative when gateway authority changes mid-command", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/readyz") {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.url === "/v2/status") {
        response.end(JSON.stringify({
          schemaVersion: "postgres-v2",
          deliverySupported: true,
          pending: 0,
          claimed: 0,
          retrying: 0,
          dead: 0,
          principal: { workspace: "acme", agent: "worker" },
        }));
        return;
      }
      response.statusCode = 503;
      response.end(JSON.stringify({ error: { code: "gateway_unavailable" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test gateway did not bind TCP");
    try {
      const result = await runAtAsync(home, ["pending"], {
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
        AGENT_BRIDGE_TOKEN: "test-token",
        AGENT_BRIDGE_AGENT: "worker",
        AGENT_BRIDGE_WORKSPACE: "acme",
      });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        available: false,
        authoritative: false,
        state: "unknown",
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
