import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeService } from "../src/bridge-service.js";
import { uuidv7 } from "../src/bridge-domain.js";
import { hashCredential, PostgresCredentialResolver } from "../src/gateway-auth.js";
import { legacyNumericMessageId } from "../src/legacy-compat.js";
import { reconcileLegacyProjects } from "../src/legacy-project-reconciliation.js";
import {
  loadMigrationPlan,
  migrationsReady,
  runMigrations,
  runtimeSchemaReady,
} from "../src/migrations.js";
import { PostgresBridgeStore } from "../src/postgres-bridge-store.js";
import { installClient } from "../src/client-installer.js";
import { resolveClientConfig } from "../src/client-config.js";
import { createClientRuntime } from "../src/client-runtime.js";

const databaseUrl = process.env.AGENT_BRIDGE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 8 }) : undefined;

async function withTemporaryDatabase(
  run: (database: pg.Pool) => Promise<void>,
): Promise<void> {
  const name = `bridge_upgrade_${randomUUID().replaceAll("-", "")}`;
  const roleName = `agent_bridge_runtime_${createHash("md5").update(name).digest("hex").slice(0, 16)}`;
  const adminUrl = new URL(databaseUrl!);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const temporaryUrl = new URL(databaseUrl!);
    temporaryUrl.pathname = `/${name}`;
    const temporary = new pg.Pool({ connectionString: temporaryUrl.toString(), max: 2 });
    try {
      await run(temporary);
    } finally {
      await temporary.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`DROP ROLE IF EXISTS ${roleName}`);
    await admin.end();
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForGateway(child: ChildProcess, url: string, stderr: () => string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`gateway exited early: ${stderr()}`);
    try {
      const response = await fetch(`${url}/readyz`);
      if (response.ok) return;
    } catch {
      // The process may still be binding its listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`gateway did not become ready: ${stderr()}`);
}

async function workspace(): Promise<string> {
  const id = `test-${randomUUID()}`;
  await pool!.query("INSERT INTO agent_bridge.workspaces (id, name) VALUES ($1, $1)", [id]);
  return id;
}

async function runtimeRole(database: { query: pg.Pool["query"] }): Promise<string> {
  const result = await database.query<{ role_name: string }>(
    `SELECT 'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16) AS role_name`,
  );
  const role = result.rows[0]!.role_name;
  if (!/^agent_bridge_runtime_[0-9a-f]{16}$/.test(role)) {
    throw new Error("unexpected runtime role name");
  }
  return role;
}

integration("PostgreSQL BridgeStore integration", () => {
  beforeAll(async () => {
    await runMigrations(pool!, fileURLToPath(new URL("../sql/migrations", import.meta.url)));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("runs the message, cursor, recipient, and idempotency contract", async () => {
    const service = new BridgeService(new PostgresBridgeStore(pool!));
    const principal = { workspace: await workspace(), agent: "codex", instance: "one" };
    const first = await service.publish(principal, {
      id: uuidv7(),
      type: "agent-bridge.context",
      content: "first",
      idempotencyKey: "first-key",
    });
    const repeated = await service.publish(principal, {
      id: uuidv7(),
      type: "agent-bridge.context",
      content: "first",
      idempotencyKey: "first-key",
    });
    const targeted = await service.publish(principal, {
      id: uuidv7(),
      type: "agent-bridge.work",
      content: "targeted",
      targets: ["worker"],
    });

    expect(repeated.created).toBe(false);
    expect(repeated.message.id).toBe(first.message.id);
    const firstPage = await service.history(principal, { limit: 1 });
    expect(firstPage.messages.map((message) => message.id)).toEqual([first.message.id]);
    const secondPage = await service.history(
      { ...principal, agent: "worker" },
      { cursor: firstPage.cursor, limit: 2 },
    );
    expect(secondPage.messages.map((message) => message.id)).toEqual([targeted.message.id]);
    expect((await service.history({ ...principal, agent: "stranger" })).messages).toHaveLength(1);
  });

  it("deduplicates concurrent publication on separate pool connections", async () => {
    const service = new BridgeService(new PostgresBridgeStore(pool!));
    const principal = { workspace: await workspace(), agent: "codex", instance: "one" };
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.publish(principal, {
          id: uuidv7(),
          type: "agent-bridge.context",
          content: "same concurrent attempt",
          idempotencyKey: key,
        }),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.message.id)).size).toBe(1);
  });

  it("rejects a changed payload under an existing idempotency key", async () => {
    const service = new BridgeService(new PostgresBridgeStore(pool!));
    const principal = { workspace: await workspace(), agent: "codex" };
    await service.publish(principal, {
      type: "agent-bridge.context",
      content: "first intent",
      idempotencyKey: "stable-key",
    });
    await expect(service.publish(principal, {
      type: "agent-bridge.context",
      content: "changed intent",
      idempotencyKey: "stable-key",
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("preserves, filters, and immutably fingerprints optional project labels", async () => {
    const service = new BridgeService(new PostgresBridgeStore(pool!));
    const principal = { workspace: await workspace(), agent: "codex" };
    const alpha = await service.publish(principal, {
      type: "agent-bridge.context",
      content: "alpha",
      project: "project-alpha",
      idempotencyKey: "project-key",
    });
    const unlabeled = await service.publish(principal, {
      type: "agent-bridge.context",
      content: "unlabeled",
    });
    const star = await service.publish(principal, {
      type: "agent-bridge.context",
      content: "legacy-compatible",
      project: "*",
    });

    expect((await service.history(principal, { project: "project-alpha" })).messages)
      .toEqual([alpha.message]);
    expect((await service.history(principal)).messages.map((message) => message.id))
      .toEqual([alpha.message.id, unlabeled.message.id, star.message.id]);
    await expect(service.publish(principal, {
      type: "agent-bridge.context",
      content: "alpha",
      project: "project-beta",
      idempotencyKey: "project-key",
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    await expect(pool!.query(
      "UPDATE agent_bridge.messages SET project='changed' WHERE id=$1",
      [alpha.message.id],
    )).rejects.toThrow(/immutable/i);
  });

  it("advances its cursor across messages invisible to the reader", async () => {
    const service = new BridgeService(new PostgresBridgeStore(pool!));
    const sender = { workspace: await workspace(), agent: "codex" };
    const reader = { ...sender, agent: "worker" };
    await service.publish(sender, {
      type: "agent-bridge.work",
      content: "for someone else",
      targets: ["claude"],
    });
    const empty = await service.history(reader);
    expect(empty.messages).toEqual([]);
    expect(empty.cursor).toBeDefined();
    const visible = await service.publish(sender, {
      type: "agent-bridge.context",
      content: "now visible",
    });
    const next = await service.history(reader, { cursor: empty.cursor });
    expect(next.messages.map((message) => message.id)).toEqual([visible.message.id]);
  });

  it("allows one claim and binds settlement to the active owner", async () => {
    const service = new BridgeService(new PostgresBridgeStore(pool!));
    const principal = { workspace: await workspace(), agent: "codex", instance: "one" };
    await service.publish(principal, {
      id: uuidv7(),
      type: "agent-bridge.work",
      content: "run once",
      targets: ["worker"],
    });
    const workerA = { workspace: principal.workspace, agent: "worker", instance: "a" };
    const workerB = { ...workerA, instance: "b" };
    const claims = await Promise.all([
      service.claim(workerA, { leaseMs: 1_000 }),
      service.claim(workerB, { leaseMs: 1_000 }),
    ]);
    const claim = claims.find((entry) => entry !== null)!;
    const owner = claims[0] ? workerA : workerB;
    const other = claims[0] ? workerB : workerA;

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await service.ack(other, claim.delivery.id, claim.leaseToken)).toBeNull();
    expect((await service.ack(owner, claim.delivery.id, claim.leaseToken))?.state).toBe("acked");
    const events = await pool!.query<{ to_state: string }>(
      "SELECT to_state FROM agent_bridge.delivery_events WHERE delivery_id=$1 ORDER BY sequence",
      [claim.delivery.id],
    );
    expect(events.rows.map((event) => event.to_state)).toEqual(["pending", "claimed", "acked"]);
  });

  it("publishes leased runtime presence", async () => {
    const service = new BridgeService(new PostgresBridgeStore(pool!));
    const principal = { workspace: await workspace(), agent: "codex", instance: "desktop-1" };
    await service.heartbeat(principal, { leaseMs: 5_000, runtimeType: "codex", capabilities: ["mcp"] });
    expect(await service.presence(principal)).toMatchObject([{
      workspace: principal.workspace, agent: "codex", instance: "desktop-1", capabilities: ["mcp"],
    }]);
  });

  it("does not claim expired work and dead-letters at the attempt limit", async () => {
    const service = new BridgeService(new PostgresBridgeStore(pool!));
    const principal = { workspace: await workspace(), agent: "codex", instance: "one" };
    await service.publish(principal, {
      id: uuidv7(),
      type: "agent-bridge.work",
      content: "expired",
      targets: ["worker"],
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    expect(await service.claim({ ...principal, agent: "worker" }, { leaseMs: 1_000 })).toBeNull();

    await service.publish(principal, {
      id: uuidv7(),
      type: "agent-bridge.work",
      content: "poison",
      targets: ["worker"],
    });
    const worker = { ...principal, agent: "worker" };
    const claim = await service.claim(worker, { leaseMs: 1_000 });
    const settled = await service.nack(
      worker,
      claim!.delivery.id,
      claim!.leaseToken,
      "failed",
      false,
      { maxAttempts: 1, jitterRatio: 0 },
    );
    expect(settled?.state).toBe("dead");
  });

  it("rejects settlement after lease expiry", async () => {
    const service = new BridgeService(new PostgresBridgeStore(pool!));
    const principal = { workspace: await workspace(), agent: "codex", instance: "one" };
    await service.publish(principal, {
      id: uuidv7(),
      type: "agent-bridge.work",
      content: "expire the lease",
      targets: ["worker"],
    });
    const worker = { ...principal, agent: "worker" };
    const claim = await service.claim(worker, { leaseMs: 1_000 });
    await pool!.query(
      "UPDATE agent_bridge.deliveries SET lease_expires_at=now() - interval '1 second' WHERE id=$1",
      [claim!.delivery.id],
    );
    expect(await service.ack(worker, claim!.delivery.id, claim!.leaseToken)).toBeNull();
  });

  it("enforces receipt visibility and caps expired-lease recovery", async () => {
    const service = new BridgeService(new PostgresBridgeStore(pool!));
    const principal = { workspace: await workspace(), agent: "codex", instance: "one" };
    const published = await service.publish(principal, {
      id: uuidv7(),
      type: "agent-bridge.work",
      content: "private work",
      targets: ["worker"],
    });
    expect(
      await service.acknowledge({ ...principal, agent: "stranger" }, [published.message.id]),
    ).toBe(0);
    expect(
      await service.acknowledge({ ...principal, agent: "worker" }, [published.message.id]),
    ).toBe(1);

    const worker = { ...principal, agent: "worker" };
    const claim = await service.claim(worker, { leaseMs: 1_000, maxAttempts: 1 });
    await pool!.query(
      "UPDATE agent_bridge.deliveries SET lease_expires_at=now() - interval '1 second' WHERE id=$1",
      [claim!.delivery.id],
    );
    expect(await service.claim(worker, { leaseMs: 1_000, maxAttempts: 1 })).toBeNull();
  });

  it("authenticates active credentials and rejects disabled or revoked principals", async () => {
    const workspaceId = await workspace();
    const agent = await pool!.query<{ id: string }>(
      `INSERT INTO agent_bridge.agents (workspace_id, principal)
       VALUES ($1, 'worker') RETURNING id`,
      [workspaceId],
    );
    const token = `test-token-${randomUUID()}`;
    const credential = await pool!.query<{ id: string }>(
      `INSERT INTO agent_bridge.credentials (workspace_id, agent_id, token_hash)
       VALUES ($1, $2, $3) RETURNING id`,
      [workspaceId, agent.rows[0]!.id, hashCredential(token)],
    );
    const resolver = new PostgresCredentialResolver(pool!);

    expect(await resolver.resolve(token)).toEqual({
      id: credential.rows[0]!.id,
      principal: { workspace: workspaceId, agent: "worker" },
    });
    await pool!.query("UPDATE agent_bridge.credentials SET revoked_at=now() WHERE id=$1", [credential.rows[0]!.id]);
    expect(await resolver.resolve(token)).toBeNull();
    await pool!.query("UPDATE agent_bridge.credentials SET revoked_at=NULL WHERE id=$1", [credential.rows[0]!.id]);
    await pool!.query("UPDATE agent_bridge.agents SET disabled_at=now() WHERE id=$1", [agent.rows[0]!.id]);
    expect(await resolver.resolve(token)).toBeNull();
  });

  it("keeps the private schema inaccessible to Supabase Data API roles", async () => {
    await pool!.query(`do $roles$ begin
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
    end $roles$`);
    for (const role of ["anon", "authenticated"]) {
      const client = await pool!.connect();
      try {
        await client.query(`set role ${role}`);
        await expect(client.query("SELECT * FROM agent_bridge.messages LIMIT 1")).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await client.query("reset role");
        client.release();
      }
    }
  });

  it("runs gateway operations through the restricted database role", async () => {
    const workspaceId = await workspace();
    const agent = await pool!.query<{ id: string }>(
      `INSERT INTO agent_bridge.agents (workspace_id, principal)
       VALUES ($1, 'worker') RETURNING id`,
      [workspaceId],
    );
    const token = `runtime-role-${randomUUID()}`;
    await pool!.query(
      `INSERT INTO agent_bridge.credentials (workspace_id, agent_id, token_hash)
       VALUES ($1, $2, $3)`,
      [workspaceId, agent.rows[0]!.id, hashCredential(token)],
    );
    const client = await pool!.connect();
    try {
      await client.query(`SET ROLE ${await runtimeRole(client)}`);
      expect(await runtimeSchemaReady(client)).toBe(true);
      expect(await new PostgresCredentialResolver(client).resolve(token)).toMatchObject({
        principal: { workspace: workspaceId, agent: "worker" },
      });
      const service = new BridgeService(new PostgresBridgeStore(client));
      const published = await service.publish(
        { workspace: workspaceId, agent: "worker", instance: "runtime-one" },
        { type: "agent-bridge.work", content: "restricted role", targets: ["worker"] },
      );
      const claim = await service.claim(
        { workspace: workspaceId, agent: "worker", instance: "runtime-one" },
        { leaseMs: 1_000 },
      );
      expect(claim?.delivery.messageId).toBe(published.message.id);
      expect((await service.ack(
        { workspace: workspaceId, agent: "worker", instance: "runtime-one" },
        claim!.delivery.id,
        claim!.leaseToken,
      ))?.state).toBe("acked");
      await service.heartbeat(
        { workspace: workspaceId, agent: "worker", instance: "runtime-one" },
        { leaseMs: 1_000, capabilities: ["mcp"] },
      );
      await expect(
        client.query("INSERT INTO agent_bridge.workspaces (id, name) VALUES ('forbidden', 'forbidden')"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        client.query("UPDATE agent_bridge.messages SET content='changed' WHERE id=$1", [published.message.id]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        client.query("CREATE TABLE agent_bridge.forbidden (id integer)"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.query("RESET ROLE");
      client.release();
    }
  });

  it("isolates runtime roles across databases on one PostgreSQL cluster", async () => {
    const primaryRole = await runtimeRole(pool!);
    await withTemporaryDatabase(async (otherDatabase) => {
      await runMigrations(
        otherDatabase,
        fileURLToPath(new URL("../sql/migrations", import.meta.url)),
      );
      expect(await runtimeRole(otherDatabase)).not.toBe(primaryRole);
      const client = await otherDatabase.connect();
      try {
        await client.query(`SET ROLE ${primaryRole}`);
        await expect(
          client.query("SELECT * FROM agent_bridge.messages LIMIT 1"),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await client.query("RESET ROLE");
        client.release();
      }
    });
  });

  it("runs two installed clients through gateway-main and the restricted login", async () => {
    const workspaceId = await workspace();
    const codexAgent = await pool!.query<{ id: string }>(
      `INSERT INTO agent_bridge.agents (workspace_id, principal, runtime_type)
       VALUES ($1, 'codex', 'codex') RETURNING id`,
      [workspaceId],
    );
    const claudeAgent = await pool!.query<{ id: string }>(
      `INSERT INTO agent_bridge.agents (workspace_id, principal, runtime_type)
       VALUES ($1, 'claude-code', 'claude-code') RETURNING id`,
      [workspaceId],
    );
    const codexToken = `codex-${randomUUID()}`;
    const claudeToken = `claude-${randomUUID()}`;
    await pool!.query(
      `INSERT INTO agent_bridge.credentials (workspace_id, agent_id, token_hash, label)
       VALUES ($1, $2, $3, 'codex test'), ($1, $4, $5, 'claude test')`,
      [
        workspaceId,
        codexAgent.rows[0]!.id,
        hashCredential(codexToken),
        claudeAgent.rows[0]!.id,
        hashCredential(claudeToken),
      ],
    );
    const login = `bridge_gateway_${randomUUID().replaceAll("-", "")}`;
    const password = randomUUID();
    await pool!.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}'`);
    await pool!.query(`GRANT ${await runtimeRole(pool!)} TO ${login}`);
    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = login;
    runtimeUrl.password = password;
    const port = await freePort();
    const gatewayUrl = `http://127.0.0.1:${port}`;
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-pg-gateway-"));
    let child: ChildProcess | undefined;
    let codexRuntime: Awaited<ReturnType<typeof createClientRuntime>> | undefined;
    let claudeRuntime: Awaited<ReturnType<typeof createClientRuntime>> | undefined;
    let stderr = "";
    try {
      child = spawn(process.execPath, [
        fileURLToPath(new URL("../dist/gateway-main.js", import.meta.url)),
      ], {
        env: {
          ...process.env,
          AGENT_BRIDGE_RUNTIME_DATABASE_URL: runtimeUrl.toString(),
          AGENT_BRIDGE_HOST: "127.0.0.1",
          AGENT_BRIDGE_PORT: String(port),
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      await waitForGateway(child, gatewayUrl, () => stderr);
      const installEnvironment = {
        HOME: home,
        AGENT_BRIDGE_PROVIDER: "gateway",
        AGENT_BRIDGE_URL: gatewayUrl,
        AGENT_BRIDGE_WORKSPACE: workspaceId,
      };
      const execute = () => ({
        pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null,
      });
      const codexInstall = installClient("codex", "codex", {
        env: installEnvironment,
        token: codexToken,
        instance: "codex-pg-client",
      }, execute);
      const claudeInstall = installClient("claude-code", "claude-code", {
        env: installEnvironment,
        token: claudeToken,
        instance: "claude-pg-client",
      }, execute);
      codexRuntime = await createClientRuntime(resolveClientConfig({
        HOME: home,
        AGENT_BRIDGE_AGENT: "codex",
        AGENT_BRIDGE_INSTANCE: codexInstall.instance,
        AGENT_BRIDGE_CONFIG: codexInstall.backendConfigPath,
      }));
      claudeRuntime = await createClientRuntime(resolveClientConfig({
        HOME: home,
        AGENT_BRIDGE_AGENT: "claude-code",
        AGENT_BRIDGE_INSTANCE: claudeInstall.instance,
        AGENT_BRIDGE_CONFIG: claudeInstall.backendConfigPath,
      }));
      const sent = await codexRuntime.service.publish(
        codexRuntime.config.principal,
        {
          type: "agent-bridge.work",
          content: "process-level PostgreSQL proof",
          targets: ["claude-code"],
        },
      );
      const history = await claudeRuntime.service.history(claudeRuntime.config.principal);
      expect(history.messages.map((message) => message.id)).toContain(sent.message.id);
      const claim = await claudeRuntime.service.claim(
        claudeRuntime.config.principal,
        { leaseMs: 1_000 },
      );
      expect(claim?.delivery.messageId).toBe(sent.message.id);
      expect((await claudeRuntime.service.ack(
        claudeRuntime.config.principal,
        claim!.delivery.id,
        claim!.leaseToken,
      ))?.state).toBe("acked");
    } finally {
      await claudeRuntime?.close();
      await codexRuntime?.close();
      if (child && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      rmSync(home, { recursive: true, force: true });
      await pool!.query(`DROP ROLE IF EXISTS ${login}`);
    }
  });

  it("detects migration checksum drift and reports readiness", async () => {
    const directory = fileURLToPath(new URL("../sql/migrations", import.meta.url));
    const plan = await loadMigrationPlan(directory);
    expect(await migrationsReady(pool!, plan)).toBe(true);
    const recorded = await pool!.query<{ checksum: string }>(
      "SELECT checksum FROM agent_bridge.schema_migrations WHERE version=3",
    );
    await pool!.query(
      "UPDATE agent_bridge.schema_migrations SET checksum=$1 WHERE version=3",
      ["0".repeat(64)],
    );
    await expect(
      runMigrations(pool!, directory),
    ).rejects.toThrow(/conflicts with schema state/);
    expect(await migrationsReady(pool!, plan)).toBe(false);
    await pool!.query(
      "UPDATE agent_bridge.schema_migrations SET checksum=$1 WHERE version=3",
      [recorded.rows[0]!.checksum],
    );
  });

  it("reports a missing runtime table as not ready", async () => {
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query("DROP TABLE agent_bridge.receipts");
      expect(await runtimeSchemaReady(client)).toBe(false);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await runtimeSchemaReady(pool!)).toBe(true);
  });

  it("imports a legacy shared_context database through fresh migrations", async () => {
    await withTemporaryDatabase(async (upgrade) => {
        await upgrade.query(`CREATE TABLE public.shared_context (
          id bigint PRIMARY KEY,
          source text NOT NULL,
          category text NOT NULL,
          content text NOT NULL,
          priority text NOT NULL DEFAULT 'info',
          project text,
          metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          acked_by text[] NOT NULL DEFAULT '{}'
        )`);
        const preservedId = randomUUID();
        await upgrade.query(
          `INSERT INTO public.shared_context
            (id, source, category, content, project, metadata, acked_by)
           VALUES
            ($1, 'codex', 'operational', 'large legacy ID', null, '{}'::jsonb, array['claude-code']),
            (2, 'claude-code', 'request', 'preserved envelope ID', 'agent-bridge',
             jsonb_build_object('message_envelope', jsonb_build_object(
               'message_id', $2::text,
               'target_agents', jsonb_build_array('codex'),
               'correlation_id', 'correlation-1',
               'causation_id', 'causation-1',
               'idempotency_key', 'legacy-key-1',
               'atrib_receipt_id', $3::text
             )), array[]::text[]),
            (3, 'codex', 'operational', 'normal legacy ID', 'agent-bridge',
             '{}'::jsonb, array[]::text[])`,
          [Number.MAX_SAFE_INTEGER, preservedId, `${"a".repeat(43)}.${"b".repeat(43)}`],
        );
        await runMigrations(
          upgrade,
          fileURLToPath(new URL("../sql/migrations", import.meta.url)),
        );
        const imported = await upgrade.query<{
          messages: string;
          receipts: string;
          deliveries: string;
          preserved: boolean;
          compatible: boolean;
          correlation_id: string;
          causation_id: string;
          idempotency_key: string;
          atrib_receipt_id: string;
        }>(`SELECT
          (SELECT count(*) FROM agent_bridge.messages)::text AS messages,
          (SELECT count(*) FROM agent_bridge.receipts)::text AS receipts,
          (SELECT count(*) FROM agent_bridge.deliveries)::text AS deliveries,
          EXISTS (SELECT 1 FROM agent_bridge.messages WHERE id=$1) AS preserved,
          EXISTS (
            SELECT 1 FROM agent_bridge.messages
            WHERE id='00000000-0000-8000-8000-000000000003'
          ) AS compatible,
          (SELECT correlation_id FROM agent_bridge.messages WHERE id=$1) AS correlation_id,
          (SELECT causation_id FROM agent_bridge.messages WHERE id=$1) AS causation_id,
          (SELECT idempotency_key FROM agent_bridge.messages WHERE id=$1) AS idempotency_key,
          (SELECT atrib_receipt_id FROM agent_bridge.messages WHERE id=$1) AS atrib_receipt_id`, [preservedId]);
        expect(imported.rows[0]).toEqual({
          messages: "3",
          receipts: "1",
          deliveries: "0",
          preserved: true,
          compatible: true,
          correlation_id: "correlation-1",
          causation_id: "causation-1",
          idempotency_key: "legacy-key-1",
          atrib_receipt_id: `${"a".repeat(43)}.${"b".repeat(43)}`,
        });
        const service = new BridgeService(new PostgresBridgeStore(upgrade));
        expect(await service.acknowledge(
          { workspace: "legacy", agent: "codex" },
          [legacyNumericMessageId(String(Number.MAX_SAFE_INTEGER))],
        )).toBe(1);
        const legacyColumn = await upgrade.query<{ present: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='shared_context'
            AND column_name='atrib_receipt_id'
        ) AS present`);
        expect(legacyColumn.rows[0]?.present).toBe(true);
    });
  });

  it("reconciles legacy project workspaces into canonical project labels", async () => {
    await withTemporaryDatabase(async (upgrade) => {
      const directory = fileURLToPath(new URL("../sql/migrations", import.meta.url));
      const plan = await loadMigrationPlan(directory);
      const migrationChecksum = plan.find((migration) => migration.version === 8)?.checksum;
      expect(migrationChecksum).toMatch(/^[0-9a-f]{64}$/);
      await upgrade.query(`CREATE TABLE public.shared_context (
        id bigint PRIMARY KEY,
        source text NOT NULL,
        category text NOT NULL,
        content text NOT NULL,
        priority text NOT NULL DEFAULT 'info',
        project text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        acked_by text[] NOT NULL DEFAULT '{}'
      )`);
      await upgrade.query(`INSERT INTO public.shared_context
        (id, source, category, content, project, metadata, acked_by)
        VALUES
          (1, 'codex', 'operational', 'star project', '*', '{}'::jsonb, array['worker']),
          (2, 'codex', 'operational', 'unlabeled', null, '{}'::jsonb, array[]::text[])`);
      await runMigrations(
        upgrade,
        directory,
      );
      await upgrade.query(
        "INSERT INTO agent_bridge.workspaces (id, name) VALUES ('agent-bridge', 'agent-bridge')",
      );

      expect(await reconcileLegacyProjects(upgrade, { migrationChecksum: migrationChecksum! }))
        .toEqual({
          mode: "dry-run",
          workspace: "agent-bridge",
          messages: 2,
          receipts: 1,
          deliveries: 0,
          changed: 2,
        });
      expect(await reconcileLegacyProjects(upgrade, {
        migrationChecksum: migrationChecksum!,
        apply: true,
      })).toMatchObject({
        mode: "apply",
        messages: 2,
        receipts: 1,
        changed: 2,
      });

      const rows = await upgrade.query<{
        workspace: string;
        project: string | null;
        content: string;
      }>("SELECT workspace, project, content FROM agent_bridge.messages ORDER BY sequence");
      expect(rows.rows).toEqual([
        { workspace: "agent-bridge", project: "*", content: "star project" },
        { workspace: "agent-bridge", project: null, content: "unlabeled" },
      ]);
      const receipts = await upgrade.query<{ workspace: string; principal: string }>(
        "SELECT workspace, principal FROM agent_bridge.receipts",
      );
      expect(receipts.rows).toEqual([{ workspace: "agent-bridge", principal: "worker" }]);
      expect(await reconcileLegacyProjects(upgrade, { migrationChecksum: migrationChecksum! }))
        .toMatchObject({ changed: 0 });
    });
  });

  it("refuses a legacy message ID collision with existing v2 history", async () => {
    await withTemporaryDatabase(async (upgrade) => {
      await upgrade.query(`CREATE TABLE public.shared_context (
        id bigint PRIMARY KEY,
        source text NOT NULL,
        category text NOT NULL,
        content text NOT NULL,
        priority text NOT NULL DEFAULT 'info',
        project text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        acked_by text[] NOT NULL DEFAULT '{}'
      )`);
      const collisionId = randomUUID();
      await upgrade.query(
        `INSERT INTO public.shared_context
          (id, source, category, content, project, metadata)
         VALUES (1, 'legacy', 'operational', 'legacy content', 'v2',
           jsonb_build_object('message_envelope', jsonb_build_object('message_id', $1::text)))`,
        [collisionId],
      );
      const directory = fileURLToPath(new URL("../sql/migrations", import.meta.url));
      const plan = await loadMigrationPlan(directory);
      for (const migration of plan.slice(0, 5)) {
        await upgrade.query(
          migration.source.split("__AGENT_BRIDGE_MIGRATION_CHECKSUM__").join(migration.checksum),
        );
      }
      await upgrade.query("INSERT INTO agent_bridge.workspaces (id, name) VALUES ('v2', 'v2')");
      await upgrade.query(
        `INSERT INTO agent_bridge.messages
          (id, workspace, source, type, content, content_type, targets, priority)
         VALUES ($1, 'v2', 'new', 'operational', 'existing v2 content',
           'text/plain', '[]'::jsonb, 'info')`,
        [collisionId],
      );

      await expect(runMigrations(upgrade, directory)).rejects.toThrow(
        "legacy shared_context message ID collides with existing v2 history",
      );
      const retained = await upgrade.query<{ source: string; content: string }>(
        "SELECT source, content FROM agent_bridge.messages WHERE id=$1",
        [collisionId],
      );
      expect(retained.rows).toEqual([{ source: "new", content: "existing v2 content" }]);
    });
  });
});
