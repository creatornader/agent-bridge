import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SQLiteEdgeStore } from "../src/sqlite-edge-store.js";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cli = join(root, "bin", "agent-bridge");
const homes: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
  return runAt(home, args, extra);
}
function runAt(home: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 20_000, env: { ...process.env, HOME: home, AGENT_BRIDGE_PROVIDER: "local", AGENT_BRIDGE_DB: join(home, "bridge.sqlite3"), ...extra } });
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
  it("uses exact owner and installer command contracts", () => {
    const owner = run(["owner", "inventory", "extra"]);
    expect(owner.status).toBe(1);
    expect(JSON.parse(owner.stderr)).toEqual({
      schemaVersion: 1,
      status: "error",
      operation: "inventory",
      error: {
        code: "OWNER_COMMAND_ERROR",
        message: "usage: agent-bridge owner <provision|inventory|rotate|revoke>",
      },
    });
    const client = run([
      "clients", "install", "codex", "--identity", "codex", "--workspace", "ignored",
    ]);
    expect(client.status).toBe(1);
    expect(client.stderr).toContain("--workspace is not valid for clients install");
    const extra = run(["clients", "install", "codex", "extra", "--identity", "codex"]);
    expect(extra.status).toBe(1);
    expect(extra.stderr).toContain("usage: agent-bridge clients install");
  });
  it("does not load SQLite for a legacy provider command", () => {
    const result = run(["help"], {
      AGENT_BRIDGE_PROVIDER: "legacy-supabase",
      AGENT_BRIDGE_URL: "https://supabase.test",
      AGENT_BRIDGE_KEY: "publishable-key",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("ExperimentalWarning: SQLite");
  });
  it("rejects options outside the canonical command contract", () => {
    const result = run(["capabilities", "--as", "worker", "--content", "surprise"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--content is not valid for capabilities");
  });
  it("keeps post as an alias and defaults source from runtime identity", () => {
    const result = run(["post", "--category", "operational", "Bridge is ready"], { AGENT_BRIDGE_AGENT: "codex" });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout).message).toMatchObject({ source: "codex", type: "operational", content: "Bridge is ready" });
  });
  it("publishes and settles leased work with publisher-owned CLI policy", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const sent = runAt(home, [
      "send", "--source", "publisher", "--target", "worker",
      "--delivery-mode", "leased", "--delivery-max-attempts", "1",
      "--retry-base-ms", "1000", "--retry-max-ms", "60000",
      "--retry-jitter", "0", "work",
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(sent.status).toBe(0);
    expect(JSON.parse(sent.stdout).message.deliveryPolicy).toMatchObject({
      mode: "leased", maxAttempts: 1, retryBaseDelayMs: 1000,
      retryMaxDelayMs: 60000, retryJitterRatio: 0,
    });
    const claimed = runAt(home, ["claim", "--as", "worker", "--instance", "one", "--lease-ms", "30000"], { AGENT_BRIDGE_AGENT: undefined });
    const claim = JSON.parse(claimed.stdout);
    const nacked = runAt(home, [
      "nack", "--as", "worker", "--instance", "one",
      "--delivery-id", claim.delivery.id, "--lease-token", claim.leaseToken,
      "--disposition", "retry", "--error", "failed",
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(JSON.parse(nacked.stdout).state).toBe("dead");
    const dead = runAt(home, ["dead-letters", "--as", "worker", "--role", "recipient"], { AGENT_BRIDGE_AGENT: undefined });
    expect(JSON.parse(dead.stdout).deliveries).toHaveLength(1);
    const invalid = runAt(home, [
      "send", "--source", "publisher", "--delivery-mode", "mailbox",
      "--retry-base-ms", "1000", "invalid",
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("mailbox delivery mode does not accept retry or scheduling flags");
  }, 30_000);
  it("accepts an explicit source when the environment has no identity", () => {
    const result = run(["send", "--source", "codex", "Bridge is ready"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).message.source).toBe("codex");
  });
  it("rejects a conflicting explicit source", () => {
    const result = run(["send", "--source", "claude-code", "Bridge is ready"], { AGENT_BRIDGE_AGENT: "codex" });
    expect(result.status).toBe(1); expect(result.stderr).toContain("source must match AGENT_BRIDGE_AGENT (codex)");
  });
  it("exposes sent mail and caller-relative receipt state", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const targeted = runAt(home, [
      "send", "--source", "sender", "--target", "worker", "targeted",
    ], { AGENT_BRIDGE_AGENT: undefined });
    const targetedId = JSON.parse(targeted.stdout).message.id as string;
    expect(runAt(home, ["send", "--source", "sender", "broadcast"], {
      AGENT_BRIDGE_AGENT: undefined,
    }).status).toBe(0);

    const inbox = runAt(home, ["inbox", "--as", "sender"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(JSON.parse(inbox.stdout).messages.map((message: { content: string }) => message.content))
      .toEqual(["broadcast"]);
    const sent = runAt(home, ["sent", "--as", "sender"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(JSON.parse(sent.stdout).messages.map((message: { content: string }) => message.content))
      .toEqual(["targeted", "broadcast"]);
    const all = runAt(home, ["history", "--as", "sender", "--mailbox", "all"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(JSON.parse(all.stdout).messages).toHaveLength(2);

    const acknowledgement = runAt(home, [
      "ack", "--agent", "worker", "--ids", targetedId,
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(acknowledgement.status).toBe(0);
    expect(JSON.parse(acknowledgement.stdout)).toEqual({ acknowledged: 1, agent: "worker" });
    const read = runAt(home, [
      "inbox", "--as", "worker", "--receipt-state", "read",
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(JSON.parse(read.stdout).messages.map((message: { id: string }) => message.id))
      .toEqual([targetedId]);
  }, 30_000);
  it("rejects another principal's receipt assertion before opening storage", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const database = join(home, "must-not-exist.sqlite3");
    const result = runAt(home, [
      "history", "--as", "sender", "--unacked-by", "worker", "--db", database,
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--unacked-by must equal the configured principal");
    expect(existsSync(database)).toBe(false);
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
  it("routes aliases through their canonical option contracts", () => {
    const rejectedPost = run(["post", "--source", "codex", "--limit", "1", "message"]);
    expect(rejectedPost.status).toBe(1);
    expect(rejectedPost.stderr).toContain("--limit is not valid for post");

    const invalidDeadLetters = run(["dead-letters", "--as", "worker", "--content", "surprise"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(invalidDeadLetters.status).toBe(1);
    expect(invalidDeadLetters.stderr).toContain("--content is not valid for dead-letters");
  });
  it("applies invocation backend flags before opening a runtime", () => {
    const result = run([
      "post", "--source", "codex", "--provider", "local", "--db", ":memory:", "local override",
    ], {
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: "http://127.0.0.1:1",
      AGENT_BRIDGE_TOKEN: "test-token",
      AGENT_BRIDGE_WORKSPACE: "acme",
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).message.content).toBe("local override");
  });
  it("accepts the deprecated sync limit alias", () => {
    const result = run(["sync", "--limit", "1"], {
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: "http://127.0.0.1:1",
      AGENT_BRIDGE_TOKEN: "test-token",
      AGENT_BRIDGE_AGENT: "worker",
      AGENT_BRIDGE_WORKSPACE: "acme",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ online: false, pushed: 0 });
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
      checks: expect.arrayContaining([expect.objectContaining({ name: "blocked-outbox", status: "ok" })]),
    });
  });
  it("keeps status passive and makes an unreachable gateway doctor degraded", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const environment = {
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: "http://127.0.0.1:1",
      AGENT_BRIDGE_TOKEN: "test-token",
      AGENT_BRIDGE_WORKSPACE: "acme",
      AGENT_BRIDGE_AGENT: "worker",
    };
    const status = runAt(home, ["status"], environment);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      status: "unknown",
      connected: false,
      remoteReachable: null,
      checks: expect.arrayContaining([expect.objectContaining({ name: "remote", status: "unknown" })]),
    });
    const doctor = runAt(home, ["doctor"], environment);
    expect(doctor.status).toBe(2);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      status: "degraded",
      remoteReachable: false,
      checks: expect.arrayContaining([expect.objectContaining({ name: "remote", status: "degraded" })]),
    });
  });
  it("does not contact a gateway while reading passive status", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test gateway did not bind TCP");
    try {
      const result = await runAtAsync(home, ["status"], {
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
        AGENT_BRIDGE_TOKEN: "test-token",
        AGENT_BRIDGE_WORKSPACE: "acme",
        AGENT_BRIDGE_AGENT: "worker",
      });
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({ status: "unknown", connected: false });
      expect(payload.queue).not.toHaveProperty("syncLoopState");
      expect(payload.queue).not.toHaveProperty("syncLoopError");
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("does not contact a legacy provider while reading passive status", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end(JSON.stringify([]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test legacy provider did not bind TCP");
    try {
      const result = await runAtAsync(home, ["status"], {
        AGENT_BRIDGE_PROVIDER: "legacy-supabase",
        AGENT_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
        AGENT_BRIDGE_KEY: "test-key",
        AGENT_BRIDGE_WORKSPACE: "acme",
        AGENT_BRIDGE_AGENT: "worker",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "unknown", connected: false });
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("degrades doctor when the status probe returns a retryable failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    let statusRequests = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("x-agent-bridge-protocol-version", "2.1");
      response.setHeader("x-agent-bridge-supported-protocol-versions", "2.0,2.1");
      if (request.url === "/readyz") {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.url === "/v2/status") {
        statusRequests += 1;
        response.statusCode = 503;
        response.end(JSON.stringify({ error: { code: "gateway_unavailable" } }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "not_found" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test gateway did not bind TCP");
    try {
      const result = await runAtAsync(home, ["doctor"], {
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
        AGENT_BRIDGE_TOKEN: "test-token",
        AGENT_BRIDGE_WORKSPACE: "acme",
        AGENT_BRIDGE_AGENT: "worker",
      });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "degraded",
        connected: false,
        remoteReachable: false,
      });
      expect(statusRequests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it.each(["doctor", "status"] as const)("returns sanitized failed %s JSON when local initialization fails", (command) => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const database = join(home, "not-a-database");
    mkdirSync(database);
    const result = runAt(home, [command], { AGENT_BRIDGE_DB: database });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("Error:");
    const payload = JSON.parse(result.stdout);
    expect(payload.checks[0].message).not.toContain(database);
    expect(payload).toMatchObject({
      status: "failed",
      localHealthy: false,
      checks: [{ name: "local-store", status: "failed" }],
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
  it("propagates project labels through send, history, and inbox", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    expect(runAt(home, [
      "send", "--source", "codex", "--project", "alpha", "alpha message",
    ]).status).toBe(0);
    expect(runAt(home, [
      "send", "--source", "codex", "--project", "beta", "beta message",
    ]).status).toBe(0);

    const history = runAt(home, ["history", "--as", "worker", "--project", "alpha"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(history.status).toBe(0);
    expect(JSON.parse(history.stdout).messages).toEqual([
      expect.objectContaining({ project: "alpha", content: "alpha message" }),
    ]);

    const inbox = runAt(home, ["inbox", "--as", "worker", "--project", "beta"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(inbox.status).toBe(0);
    expect(JSON.parse(inbox.stdout).messages).toEqual([
      expect.objectContaining({ project: "beta", content: "beta message" }),
    ]);
  });
  it("accepts a star as a project label", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const sent = runAt(home, ["send", "--source", "codex", "--project", "*", "star project"]);
    expect(sent.status).toBe(0);
    expect(JSON.parse(sent.stdout).message.project).toBe("*");
    const history = runAt(home, ["history", "--as", "worker", "--project", "*"], {
      AGENT_BRIDGE_AGENT: undefined,
    });
    expect(history.status).toBe(0);
    expect(JSON.parse(history.stdout).messages).toEqual([
      expect.objectContaining({ project: "*", content: "star project" }),
    ]);
  });
  it("filters pending checks by project", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    expect(runAt(home, [
      "send", "--source", "codex", "--project", "alpha", "alpha update",
    ]).status).toBe(0);

    const unrelated = runAt(home, ["pending", "--project", "beta"], {
      AGENT_BRIDGE_AGENT: "worker",
    });
    expect(unrelated.status).toBe(1);
    expect(JSON.parse(unrelated.stdout)).toMatchObject({
      available: false,
      unread: false,
    });

    const matching = runAt(home, ["pending", "--project", "alpha"], {
      AGENT_BRIDGE_AGENT: "worker",
    });
    expect(matching.status).toBe(0);
    expect(JSON.parse(matching.stdout)).toMatchObject({
      available: true,
      unread: true,
    });
  });
  it("keeps watch cursors independent between projects", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    expect(runAt(home, [
      "send", "--source", "codex", "--project", "beta", "beta one",
    ]).status).toBe(0);
    expect(runAt(home, [
      "send", "--source", "codex", "--project", "alpha", "alpha one",
    ]).status).toBe(0);
    const first = runAt(home, [
      "watch", "--as", "worker", "--project", "alpha", "--polls", "1",
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ project: "alpha", content: "alpha one" });

    const beta = runAt(home, [
      "watch", "--as", "worker", "--project", "beta", "--polls", "1",
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(beta.status).toBe(0);
    expect(JSON.parse(beta.stdout)).toMatchObject({ project: "beta", content: "beta one" });

    expect(runAt(home, [
      "send", "--source", "codex", "--project", "alpha", "alpha two",
    ]).status).toBe(0);
    const second = runAt(home, [
      "watch", "--as", "worker", "--project", "alpha", "--polls", "1",
    ], { AGENT_BRIDGE_AGENT: undefined });
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ project: "alpha", content: "alpha two" });
    expect(second.stdout).not.toContain("beta one");
  });
  it("uses a local workspace override for only that invocation", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const environment = {
      AGENT_BRIDGE_AGENT: undefined,
      AGENT_BRIDGE_WORKSPACE: "default-workspace",
    };
    expect(runAt(home, [
      "send", "--source", "codex", "--workspace", "project-workspace", "isolated",
    ], environment).status).toBe(0);

    const defaultHistory = runAt(home, ["history", "--as", "worker"], environment);
    expect(defaultHistory.status).toBe(0);
    expect(JSON.parse(defaultHistory.stdout).messages).toEqual([]);

    const projectHistory = runAt(home, [
      "history", "--as", "worker", "--workspace", "project-workspace",
    ], environment);
    expect(projectHistory.status).toBe(0);
    expect(JSON.parse(projectHistory.stdout).messages).toEqual([
      expect.objectContaining({ workspace: "project-workspace", content: "isolated" }),
    ]);
  });
  it("rejects a legacy workspace override because v1 has no tenant boundary", () => {
    const result = run(["doctor", "--as", "worker", "--workspace", "project-workspace"], {
      AGENT_BRIDGE_PROVIDER: "legacy-supabase",
      AGENT_BRIDGE_URL: "http://127.0.0.1:1",
      AGENT_BRIDGE_KEY: "publishable-key",
      AGENT_BRIDGE_AGENT: undefined,
      AGENT_BRIDGE_WORKSPACE: "*",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--workspace is not supported by the global legacy Supabase schema",
    );
    expect(result.stderr).not.toContain("network_error");
  });
  it("rejects a mismatched gateway workspace before network access", () => {
    const result = run(["doctor", "--as", "worker", "--workspace", "other"], {
      AGENT_BRIDGE_PROVIDER: "gateway",
      AGENT_BRIDGE_URL: "http://127.0.0.1:1",
      AGENT_BRIDGE_TOKEN: "test-token",
      AGENT_BRIDGE_AGENT: undefined,
      AGENT_BRIDGE_WORKSPACE: "acme",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--workspace must match the workspace bound to the gateway credential");
    expect(result.stderr).not.toContain("fetch failed");
  });
  it("accepts a gateway workspace assertion that matches the credential", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("x-agent-bridge-protocol-version", "2.1");
      response.setHeader("x-agent-bridge-supported-protocol-versions", "2.0,2.1");
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
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "not_found" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test gateway did not bind TCP");
    try {
      const result = await runAtAsync(home, ["doctor", "--as", "worker", "--workspace", "acme"], {
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
        AGENT_BRIDGE_TOKEN: "test-token",
        AGENT_BRIDGE_AGENT: undefined,
        AGENT_BRIDGE_WORKSPACE: "acme",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        provider: "gateway",
        workspace: "acme",
        connected: true,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
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
  it("reports gateway delivery work when there is no unread message", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-cli-")); homes.push(home);
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("x-agent-bridge-protocol-version", "2.1");
      response.setHeader("x-agent-bridge-supported-protocol-versions", "2.0,2.1");
      if (request.url === "/readyz") {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.url === "/v2/status") {
        response.end(JSON.stringify({
          schemaVersion: "postgres-v2",
          deliverySupported: true,
          pending: 1,
          claimed: 0,
          retrying: 0,
          dead: 0,
          oldestAvailableAt: new Date(Date.now() - 1_000).toISOString(),
          principal: { workspace: "acme", agent: "worker" },
        }));
        return;
      }
      if (request.url?.startsWith("/v2/history")) {
        response.end(JSON.stringify({ messages: [] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "not_found" } }));
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
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        available: true,
        unread: false,
        deliveryAvailable: true,
        pending: 1,
        authoritative: true,
        state: "available",
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
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
      response.setHeader("x-agent-bridge-protocol-version", "2.1");
      response.setHeader("x-agent-bridge-supported-protocol-versions", "2.0,2.1");
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
