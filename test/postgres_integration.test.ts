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
import { AUTHORIZATION_SCOPES } from "../src/contracts/registry.js";
import { hashCredential, PostgresCredentialResolver } from "../src/gateway-auth.js";
import { PostgresGatewaySecurity } from "../src/gateway-security.js";
import { legacyNumericMessageId } from "../src/legacy-compat.js";
import { reconcileLegacyProjects } from "../src/legacy-project-reconciliation.js";
import {
  loadMigrationPlan,
  migrationsReady,
  runMigrations,
  runtimeSchemaReady,
} from "../src/migrations.js";
import { PostgresBridgeStore } from "../src/postgres-bridge-store.js";
import { PostgresRequestAuthority } from "../src/postgres-request-authority.js";
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
  const suffix = createHash("md5").update(name).digest("hex").slice(0, 16);
  const roleNames = ["runtime", "data_owner", "context_reader", "event_writer"]
    .map((kind) => `agent_bridge_${kind}_${suffix}`);
  const adminUrl = new URL(databaseUrl!);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const failures: unknown[] = [];
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const temporaryUrl = new URL(databaseUrl!);
    temporaryUrl.pathname = `/${name}`;
    const temporary = new pg.Pool({ connectionString: temporaryUrl.toString(), max: 2 });
    try {
      await run(temporary);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await temporary.end();
      } catch (error) {
        failures.push(error);
      }
    }
  } catch (error) {
    failures.push(error);
  }
  for (const cleanup of [
    () => admin.query(`DROP DATABASE IF EXISTS "${name}"`),
    ...roleNames.map((roleName) => () => admin.query(`DROP ROLE IF EXISTS ${roleName}`)),
    () => admin.end(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "temporary PostgreSQL database run and cleanup failed");
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

async function withRuntimeAuthority<T>(
  database: pg.Pool,
  credentialId: string,
  token: string,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      "SELECT * FROM agent_bridge.open_request_authority($1::uuid,$2::text,$3::uuid)",
      [credentialId, hashCredential(token), randomUUID()],
    );
    const result = await run(client);
    await client.query("SELECT agent_bridge.close_request_authority()");
    await client.query("COMMIT");
    transactionOpen = false;
    return result;
  } finally {
    if (transactionOpen) await client.query("ROLLBACK");
    client.release();
  }
}

async function expectStatementRejected(
  client: pg.PoolClient,
  sql: string,
  values: unknown[],
  pattern: RegExp,
): Promise<void> {
  await client.query("SAVEPOINT hostile_statement");
  await expect(client.query(sql, values)).rejects.toThrow(pattern);
  await client.query("ROLLBACK TO SAVEPOINT hostile_statement");
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
    const worker = { ...principal, agent: "worker" };
    await expect(service.history(worker, { cursor: firstPage.cursor, limit: 2 }))
      .rejects.toThrow("cursor is invalid");
    const workerFirstPage = await service.history(worker, { limit: 1 });
    expect(workerFirstPage.messages.map((message) => message.id)).toEqual([first.message.id]);
    const secondPage = await service.history(
      worker,
      { cursor: workerFirstPage.cursor, limit: 2 },
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
      deliveryPolicy: { mode: "leased", maxAttempts: 1, retryJitterRatio: 0 },
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
      deliveryPolicy: { mode: "leased", maxAttempts: 1 },
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

  it("enforces publisher delivery policy, controls, audit events, and cursor scope", async () => {
    const service = new BridgeService(new PostgresBridgeStore(pool!));
    const principal = { workspace: await workspace(), agent: "publisher" };
    const worker = { workspace: principal.workspace, agent: "worker", instance: "one" };
    const mailbox = await service.publish(principal, {
      id: uuidv7(), type: "note", content: "targeted mailbox", targets: ["worker"],
      deliveryPolicy: { mode: "mailbox" },
    });
    expect(mailbox.message.deliveryPolicy).toEqual({ mode: "mailbox" });
    expect(await service.claim(worker, { leaseMs: 1_000 })).toBeNull();

    const work = await service.publish(principal, {
      id: uuidv7(), type: "work", content: "controlled", targets: ["worker"],
      idempotencyKey: "controlled-work",
      deliveryPolicy: { mode: "leased", maxAttempts: 1, retryJitterRatio: 0 },
    });
    await expect(service.publish(principal, {
      id: uuidv7(), type: "work", content: "controlled", targets: ["worker"],
      idempotencyKey: "controlled-work",
      deliveryPolicy: { mode: "leased", maxAttempts: 2, retryJitterRatio: 0 },
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });

    const claim = await service.claim(worker, { leaseMs: 1_000, maxAttempts: 99 });
    expect(claim?.delivery.messageId).toBe(work.message.id);
    const cancelled = await service.cancel(principal, claim!.delivery.id);
    expect(cancelled?.state).toBe("cancelled");
    expect(await service.cancel(principal, claim!.delivery.id)).toEqual(cancelled);
    expect(await service.ack(worker, claim!.delivery.id, claim!.leaseToken)).toBeNull();
    expect(await service.cancel({ ...principal, agent: "other" }, claim!.delivery.id)).toBeNull();

    const requeues = await Promise.allSettled([
      service.requeue(principal, claim!.delivery.id),
      service.requeue(principal, claim!.delivery.id),
    ]);
    expect(requeues.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(requeues.filter((result) => result.status === "rejected")).toHaveLength(1);
    const reclaimed = await service.claim(worker, { leaseMs: 1_000 });
    expect(reclaimed?.delivery).toMatchObject({ attempt: 2, cycleAttempt: 1, requeueCount: 1 });
    expect((await service.nack(worker, reclaimed!.delivery.id, reclaimed!.leaseToken, "failed", "retry"))?.state)
      .toBe("dead");
    await expect(service.cancel(principal, reclaimed!.delivery.id))
      .rejects.toMatchObject({ code: "delivery_state_conflict", status: 409 });
    const events = await service.deliveryEvents(principal, reclaimed!.delivery.id);
    expect(events.events.map((event) => event.action))
      .toEqual(["created", "claim", "cancel", "requeue", "claim", "attempts_exhausted"]);

    await service.publish(principal, { id: uuidv7(), type: "work", content: "another", targets: ["worker"] });
    const page = await service.deliveries(worker, { role: "recipient", limit: 1 });
    expect(page.deliveries).toHaveLength(1);
    await expect(service.deliveries(principal, { role: "publisher", cursor: page.cursor }))
      .rejects.toThrow("cursor is invalid");
  });

  it("fences delivery control and expired-at-limit races", async () => {
    const service = new BridgeService(new PostgresBridgeStore(pool!));
    const publisher = { workspace: await workspace(), agent: "publisher" };
    const worker = { workspace: publisher.workspace, agent: "worker", instance: "race" };
    await service.publish(publisher, {
      id: uuidv7(), type: "work", content: "cancel versus nack", targets: ["worker"],
      deliveryPolicy: { mode: "leased", maxAttempts: 1 },
    });
    const claim = await service.claim(worker, { leaseMs: 1_000 });
    await Promise.allSettled([
      service.cancel(publisher, claim!.delivery.id),
      service.nack(worker, claim!.delivery.id, claim!.leaseToken, "terminal", "dead"),
    ]);
    expect((await service.deliveryEvents(publisher, claim!.delivery.id)).events
      .filter((event) => event.action === "cancel" || event.action === "nack_dead"))
      .toHaveLength(1);

    const requeueRace = await Promise.allSettled([
      service.requeue(publisher, claim!.delivery.id),
      service.claim(worker, { leaseMs: 1_000 }),
    ]);
    expect((await service.deliveryEvents(publisher, claim!.delivery.id)).events
      .filter((event) => event.action === "requeue")).toHaveLength(1);
    const racedClaim = requeueRace[1]?.status === "fulfilled" ? requeueRace[1].value : null;
    const cleanup = racedClaim ?? await service.claim(worker, { leaseMs: 1_000 });
    if (cleanup) await service.ack(worker, cleanup.delivery.id, cleanup.leaseToken);

    await service.publish(publisher, {
      id: uuidv7(), type: "work", content: "expire at limit", targets: ["worker"],
      deliveryPolicy: { mode: "leased", maxAttempts: 1 },
    });
    const limited = await service.claim(worker, { leaseMs: 1_000 });
    await pool!.query(
      "UPDATE agent_bridge.deliveries SET lease_expires_at=now() - interval '1 second' WHERE id=$1",
      [limited!.delivery.id],
    );
    await Promise.all([
      service.claim(worker, { leaseMs: 1_000 }),
      service.claim(worker, { leaseMs: 1_000 }),
    ]);
    expect((await service.deliveryEvents(publisher, limited!.delivery.id)).events
      .filter((event) => event.action === "attempts_exhausted")).toHaveLength(1);
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
      `INSERT INTO agent_bridge.credentials (workspace_id, agent_id, token_hash, scopes, scope_set_name)
       VALUES ($1, $2, $3,
         (SELECT scopes FROM agent_bridge.credential_scope_sets WHERE name='release-a-full'),
         'release-a-full') RETURNING id`,
      [workspaceId, agent.rows[0]!.id, hashCredential(token)],
    );
    const resolver = new PostgresCredentialResolver(pool!);

    expect(await resolver.resolve(token)).toEqual({
      id: credential.rows[0]!.id,
      principal: { workspace: workspaceId, agent: "worker" },
      scopes: [
        "deliveries:claim", "deliveries:manage", "deliveries:read", "deliveries:settle",
        "gateway:metrics", "messages:read", "messages:write", "presence:read",
        "presence:write", "receipts:write", "status:read",
      ],
    });
    await pool!.query("UPDATE agent_bridge.agents SET disabled_at=now() WHERE id=$1", [agent.rows[0]!.id]);
    expect(await resolver.resolve(token)).toBeNull();
    await pool!.query("UPDATE agent_bridge.agents SET disabled_at=NULL WHERE id=$1", [agent.rows[0]!.id]);
    await pool!.query(
      "SELECT agent_bridge.revoke_credential($1,'test','operator_request',$2)",
      [credential.rows[0]!.id, randomUUID()],
    );
    expect(await resolver.resolve(token)).toBeNull();
  });

  it("consumes token buckets atomically for a credential and operation", async () => {
    const workspaceId = await workspace();
    const agent = await pool!.query<{ id: string }>(
      "INSERT INTO agent_bridge.agents(workspace_id,principal) VALUES ($1,'limited') RETURNING id",
      [workspaceId],
    );
    const credential = await pool!.query<{ id: string }>(
      `INSERT INTO agent_bridge.credentials(workspace_id,agent_id,token_hash)
       VALUES ($1,$2,$3) RETURNING id`,
      [workspaceId, agent.rows[0]!.id, hashCredential(`limited-${randomUUID()}`)],
    );
    await pool!.query("UPDATE agent_bridge.rate_limit_policies SET capacity=1,refill_per_second=0.01 WHERE operation_id='status'");
    await pool!.query("DELETE FROM agent_bridge.rate_limit_buckets WHERE credential_id=$1", [credential.rows[0]!.id]);
    try {
      const security = new PostgresGatewaySecurity(pool!);
      const decisions = await Promise.all([
        security.consume(credential.rows[0]!.id, "status", randomUUID()),
        security.consume(credential.rows[0]!.id, "status", randomUUID()),
      ]);
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
      expect(decisions.find((decision) => !decision.allowed)!.retryAfterSeconds).toBeGreaterThan(90);
      expect((await pool!.query(
        "SELECT event_type,reason_code,operation_id FROM agent_bridge.security_events WHERE credential_id=$1 ORDER BY sequence DESC LIMIT 1",
        [credential.rows[0]!.id],
      )).rows).toEqual([{
        event_type: "rate_denied",
        reason_code: "rate_limit_exceeded",
        operation_id: "status",
      }]);
    } finally {
      await pool!.query("UPDATE agent_bridge.rate_limit_policies SET capacity=30,refill_per_second=1 WHERE operation_id='status'");
    }
  });

  it("applies a global bucket across operations and fails closed on missing policy", async () => {
    const workspaceId = await workspace();
    const agent = await pool!.query<{ id: string }>(
      "INSERT INTO agent_bridge.agents(workspace_id,principal) VALUES ($1,'global-limited') RETURNING id",
      [workspaceId],
    );
    const credential = await pool!.query<{ id: string }>(
      "INSERT INTO agent_bridge.credentials(workspace_id,agent_id,token_hash) VALUES ($1,$2,$3) RETURNING id",
      [workspaceId, agent.rows[0]!.id, hashCredential(`global-${randomUUID()}`)],
    );
    const security = new PostgresGatewaySecurity(pool!);
    await pool!.query("UPDATE agent_bridge.rate_limit_policies SET capacity=1,refill_per_second=0.01 WHERE policy_id='global'");
    await pool!.query("DELETE FROM agent_bridge.rate_limit_buckets WHERE credential_id=$1", [credential.rows[0]!.id]);
    try {
      expect((await security.consume(credential.rows[0]!.id, "status", randomUUID())).allowed).toBe(true);
      const denied = await security.consume(credential.rows[0]!.id, "history", randomUUID());
      expect(denied).toMatchObject({ allowed: false, policyId: "global", remaining: 0 });
      await pool!.query("UPDATE agent_bridge.rate_limit_policies SET enabled=false WHERE operation_id='status'");
      await expect(
        security.consume(credential.rows[0]!.id, "status", randomUUID()),
      ).rejects.toThrow(/unavailable/);
    } finally {
      await pool!.query("UPDATE agent_bridge.rate_limit_policies SET capacity=300,refill_per_second=50 WHERE policy_id='global'");
      await pool!.query("UPDATE agent_bridge.rate_limit_policies SET enabled=true WHERE operation_id='status'");
    }
  });

  it("clamps existing operation tokens after a capacity reduction", async () => {
    const workspaceId = await workspace();
    const agent = await pool!.query<{ id: string }>(
      "INSERT INTO agent_bridge.agents(workspace_id,principal) VALUES ($1,'capacity-clamp') RETURNING id",
      [workspaceId],
    );
    const credential = await pool!.query<{ id: string }>(
      "INSERT INTO agent_bridge.credentials(workspace_id,agent_id,token_hash) VALUES ($1,$2,$3) RETURNING id",
      [workspaceId, agent.rows[0]!.id, hashCredential(`capacity-${randomUUID()}`)],
    );
    const security = new PostgresGatewaySecurity(pool!);
    await pool!.query("UPDATE agent_bridge.rate_limit_policies SET capacity=3,refill_per_second=0.01 WHERE operation_id='status'");
    await pool!.query("DELETE FROM agent_bridge.rate_limit_buckets WHERE credential_id=$1", [credential.rows[0]!.id]);
    try {
      expect(await security.consume(credential.rows[0]!.id, "status", randomUUID()))
        .toMatchObject({ allowed: true, remaining: 2 });
      await pool!.query("UPDATE agent_bridge.rate_limit_policies SET capacity=1 WHERE operation_id='status'");
      expect(await security.consume(credential.rows[0]!.id, "status", randomUUID()))
        .toMatchObject({ allowed: true, limit: 1, remaining: 0 });
      expect((await security.consume(credential.rows[0]!.id, "status", randomUUID())).allowed)
        .toBe(false);
    } finally {
      await pool!.query("UPDATE agent_bridge.rate_limit_policies SET capacity=30,refill_per_second=1 WHERE operation_id='status'");
    }
  });

  it("records scope denials through the narrow audited function", async () => {
    const workspaceId = await workspace();
    const agent = await pool!.query<{ id: string }>(
      "INSERT INTO agent_bridge.agents(workspace_id,principal) VALUES ($1,'scope-audit') RETURNING id",
      [workspaceId],
    );
    const credential = await pool!.query<{ id: string }>(
      "INSERT INTO agent_bridge.credentials(workspace_id,agent_id,token_hash) VALUES ($1,$2,$3) RETURNING id",
      [workspaceId, agent.rows[0]!.id, hashCredential(`scope-audit-${randomUUID()}`)],
    );
    const security = new PostgresGatewaySecurity(pool!);
    const requestId = randomUUID();
    await security.recordScopeDenial(credential.rows[0]!.id, "history", requestId);
    expect((await pool!.query(
      `SELECT event_type,outcome,reason_code,workspace_id,principal,actor_principal,
         credential_id,operation_id,request_id,policy_id,retry_after_seconds
       FROM agent_bridge.security_events WHERE request_id=$1`,
      [requestId],
    )).rows).toEqual([{
      event_type: "scope_denied",
      outcome: "denied",
      reason_code: "missing_scope",
      workspace_id: workspaceId,
      principal: "scope-audit",
      actor_principal: "scope-audit",
      credential_id: credential.rows[0]!.id,
      operation_id: "history",
      request_id: requestId,
      policy_id: null,
      retry_after_seconds: null,
    }]);
    await expect(pool!.query(
      "SELECT agent_bridge.record_scope_denial($1,'not-an-operation',$2)",
      [credential.rows[0]!.id, randomUUID()],
    )).rejects.toThrow(/active request authority is required/);
  });

  it("enforces canonical scopes and preserves the transitional full default", async () => {
    const workspaceId = await workspace();
    const agent = await pool!.query<{ id: string }>(
      "INSERT INTO agent_bridge.agents(workspace_id,principal) VALUES ($1,'scope-test') RETURNING id",
      [workspaceId],
    );
    const full = await pool!.query<{ scopes: string[] }>(
      "INSERT INTO agent_bridge.credentials(workspace_id,agent_id,token_hash) VALUES ($1,$2,$3) RETURNING scopes",
      [workspaceId, agent.rows[0]!.id, hashCredential(`full-${randomUUID()}`)],
    );
    expect(full.rows[0]!.scopes).toEqual(AUTHORIZATION_SCOPES);
    await expect(pool!.query(
      "INSERT INTO agent_bridge.credentials(workspace_id,agent_id,token_hash,scopes) VALUES ($1,$2,$3,$4)",
      [workspaceId, agent.rows[0]!.id, hashCredential(`empty-${randomUUID()}`), []],
    )).resolves.toBeTruthy();
    for (const scopes of [
      ["messages:write", "messages:read"],
      ["messages:read", "messages:read"],
      ["messages:delete"],
    ]) {
      await expect(pool!.query(
        "INSERT INTO agent_bridge.credentials(workspace_id,agent_id,token_hash,scopes) VALUES ($1,$2,$3,$4)",
        [workspaceId, agent.rows[0]!.id, hashCredential(`invalid-${randomUUID()}`), scopes],
      )).rejects.toThrow();
    }
    await expect(pool!.query(
      "UPDATE agent_bridge.credential_scope_sets SET scopes='{}'::text[] WHERE name='release-a-full'",
    )).rejects.toThrow(/immutable/);
  });

  it("rotates and revokes credentials with immutable audit events", async () => {
    const workspaceId = await workspace();
    const agent = await pool!.query<{ id: string }>(
      "INSERT INTO agent_bridge.agents(workspace_id,principal) VALUES ($1,'rotation-test') RETURNING id",
      [workspaceId],
    );
    const predecessorToken = `predecessor-${randomUUID()}`;
    const successorToken = `successor-${randomUUID()}`;
    const predecessor = await pool!.query<{ id: string }>(
      "INSERT INTO agent_bridge.credentials(workspace_id,agent_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour') RETURNING id",
      [workspaceId, agent.rows[0]!.id, hashCredential(predecessorToken)],
    );
    const replacement = await pool!.query<{ succeeded: boolean; credential_id: string; failure_code: string | null }>(
      `SELECT * FROM agent_bridge.replace_credential(
        $1,$2::char(64),$3::text[],$4,$5,now()+interval '2 hours',
        now()+interval '30 minutes',$6,$7
      )`,
      [
        predecessor.rows[0]!.id,
        hashCredential(successorToken),
        [...AUTHORIZATION_SCOPES],
        "release-a-full",
        "rotated",
        "operator",
        randomUUID(),
      ],
    );
    expect(replacement.rows[0]).toMatchObject({ succeeded: true, failure_code: null });
    const resolver = new PostgresCredentialResolver(pool!);
    expect(await resolver.resolve(predecessorToken)).not.toBeNull();
    expect(await resolver.resolve(successorToken)).not.toBeNull();
    await expect(pool!.query(
      "UPDATE agent_bridge.credentials SET expiry_grace_until=now()-interval '1 second' WHERE id=$1",
      [predecessor.rows[0]!.id],
    )).rejects.toThrow(/lifecycle function/);
    expect(await resolver.resolve(predecessorToken)).not.toBeNull();
    expect(await pool!.query(
      "SELECT agent_bridge.revoke_credential($1,'operator','rotation',$2) AS revoked",
      [replacement.rows[0]!.credential_id, randomUUID()],
    )).toMatchObject({ rows: [{ revoked: true }] });
    expect(await resolver.resolve(successorToken)).toBeNull();
    await expect(pool!.query(
      "UPDATE agent_bridge.credentials SET replaces_credential_id=NULL WHERE id=$1",
      [replacement.rows[0]!.credential_id],
    )).rejects.toThrow(/lineage is immutable/);
    await expect(pool!.query(
      "UPDATE agent_bridge.credentials SET revoked_at=now(),revoked_by='direct',revocation_reason='operator_request' WHERE id=$1",
      [predecessor.rows[0]!.id],
    )).rejects.toThrow(/lifecycle function/);
    await expect(pool!.query(
      `INSERT INTO agent_bridge.credentials(workspace_id,agent_id,token_hash,replaces_credential_id)
       VALUES ($1,$2,$3,$4)`,
      [workspaceId, agent.rows[0]!.id, hashCredential(`second-${randomUUID()}`), predecessor.rows[0]!.id],
    )).rejects.toThrow();
    const otherAgent = await pool!.query<{ id: string }>(
      "INSERT INTO agent_bridge.agents(workspace_id,principal) VALUES ($1,'rotation-other') RETURNING id",
      [workspaceId],
    );
    await expect(pool!.query(
      `INSERT INTO agent_bridge.credentials(workspace_id,agent_id,token_hash,replaces_credential_id)
       VALUES ($1,$2,$3,$4)`,
      [workspaceId, otherAgent.rows[0]!.id, hashCredential(`cross-${randomUUID()}`), predecessor.rows[0]!.id],
    )).rejects.toThrow(/same workspace and agent/);

    const failed = await pool!.query<{ succeeded: boolean; failure_code: string }>(
      `SELECT * FROM agent_bridge.replace_credential(
        $1,$2::char(64),$3::text[],$4,$5,NULL,now()+interval '2 hours',$6,$7
      )`,
      [
        predecessor.rows[0]!.id,
        hashCredential(`invalid-${randomUUID()}`),
        [...AUTHORIZATION_SCOPES],
        "release-a-full",
        "invalid",
        "operator",
        randomUUID(),
      ],
    );
    expect(failed.rows[0]).toMatchObject({ succeeded: false, failure_code: "invalid_grace" });
    const immediateToken = `immediate-${randomUUID()}`;
    const immediatePredecessorToken = `immediate-predecessor-${randomUUID()}`;
    const immediatePredecessor = await pool!.query<{ id: string }>(
      "INSERT INTO agent_bridge.credentials(workspace_id,agent_id,token_hash) VALUES ($1,$2,$3) RETURNING id",
      [workspaceId, agent.rows[0]!.id, hashCredential(immediatePredecessorToken)],
    );
    const immediate = await pool!.query<{ succeeded: boolean }>(
      `SELECT * FROM agent_bridge.replace_credential(
        $1,$2::char(64),$3::text[],$4,$5,NULL,NULL,$6,$7
      )`,
      [
        immediatePredecessor.rows[0]!.id,
        hashCredential(immediateToken),
        [...AUTHORIZATION_SCOPES],
        "release-a-full",
        "immediate",
        "operator",
        randomUUID(),
      ],
    );
    expect(immediate.rows[0]!.succeeded).toBe(true);
    expect(await resolver.resolve(immediatePredecessorToken)).toBeNull();
    expect(await resolver.resolve(immediateToken)).not.toBeNull();
    const expiredToken = `expired-${randomUUID()}`;
    await pool!.query(
      "INSERT INTO agent_bridge.credentials(workspace_id,agent_id,token_hash,expires_at) VALUES ($1,$2,$3,now()-interval '1 second')",
      [workspaceId, agent.rows[0]!.id, hashCredential(expiredToken)],
    );
    expect(await resolver.resolve(expiredToken)).toBeNull();
    const events = await pool!.query<{ event_type: string }>(
      "SELECT event_type FROM agent_bridge.security_events WHERE workspace_id=$1 ORDER BY sequence",
      [workspaceId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "credential_replaced",
      "credential_revoked",
      "credential_replacement_failed",
      "credential_replaced",
    ]);
    const eventColumns = (await pool!.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='agent_bridge' AND table_name='security_events'",
    )).rows.map((row) => row.column_name);
    for (const forbidden of ["token", "token_hash", "authorization", "metadata", "body", "content", "url", "ip"]) {
      expect(eventColumns).not.toContain(forbidden);
    }
    await expect(pool!.query("UPDATE agent_bridge.security_events SET reason_code='missing_scope' WHERE workspace_id=$1", [workspaceId])).rejects.toThrow(/append-only/);
    await expect(pool!.query("DELETE FROM agent_bridge.security_events WHERE workspace_id=$1", [workspaceId])).rejects.toThrow(/append-only/);
    await expect(pool!.query("TRUNCATE agent_bridge.security_events")).rejects.toThrow(/append-only/);
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

  it("fails closed when the restricted role has no request authority", async () => {
    const workspaceId = await workspace();
    const agent = await pool!.query<{ id: string }>(
      `INSERT INTO agent_bridge.agents (workspace_id, principal)
       VALUES ($1, 'worker') RETURNING id`,
      [workspaceId],
    );
    const token = `runtime-role-${randomUUID()}`;
    await pool!.query(
      `INSERT INTO agent_bridge.credentials (workspace_id, agent_id, token_hash, scopes, scope_set_name)
       VALUES ($1, $2, $3,
         (SELECT scopes FROM agent_bridge.credential_scope_sets WHERE name='release-a-full'),
         'release-a-full')`,
      [workspaceId, agent.rows[0]!.id, hashCredential(token)],
    );
    const client = await pool!.connect();
    try {
      await client.query(`SET ROLE ${await runtimeRole(client)}`);
      expect(await runtimeSchemaReady(client)).toBe(false);
      expect(await new PostgresCredentialResolver(client).resolve(token)).toMatchObject({
        principal: { workspace: workspaceId, agent: "worker" },
      });
      await expect(new PostgresGatewaySecurity(client).consume(
        (await new PostgresCredentialResolver(client).resolve(token))!.id,
        "status",
        randomUUID(),
      )).rejects.toThrow(/permission denied/);
      await expect(
        client.query("SELECT * FROM agent_bridge.rate_limit_policies"),
      ).rejects.toThrow(/permission denied/);
      for (const table of ["credentials", "agents", "workspaces", "request_authorities"]) {
        await expect(
          client.query(`SELECT * FROM agent_bridge.${table}`),
        ).rejects.toThrow(/permission denied/);
      }
      await expect(
        client.query(
          "SELECT agent_bridge.record_scope_denial($1,'history',$2)",
          [(await new PostgresCredentialResolver(client).resolve(token))!.id, randomUUID()],
        ),
      ).rejects.toThrow(/active request authority is required/);
      await expect(
        client.query("INSERT INTO agent_bridge.security_events(event_type) VALUES ('scope_denied')"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        client.query(
          "SELECT agent_bridge.revoke_credential($1,'runtime','operator_request',$2)",
          [(await new PostgresCredentialResolver(client).resolve(token))!.id, randomUUID()],
        ),
      ).rejects.toThrow(/permission denied/);
      const service = new BridgeService(new PostgresBridgeStore(client));
      await expect(service.publish(
        { workspace: workspaceId, agent: "worker", instance: "runtime-one" },
        { type: "agent-bridge.work", content: "restricted role", targets: ["worker"] },
      )).rejects.toThrow(/row-level security policy/);
      await expect(
        client.query("INSERT INTO agent_bridge.workspaces (id, name) VALUES ('forbidden', 'forbidden')"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        client.query("UPDATE agent_bridge.messages SET content='changed'"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        client.query("CREATE TABLE agent_bridge.forbidden (id integer)"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.query("RESET ROLE");
      client.release();
    }
  });

  it("enforces row isolation for a real runtime login", async () => {
    const publisherWorkspace = await workspace();
    const outsiderWorkspace = await workspace();
    const principals = [
      { workspace: publisherWorkspace, principal: "publisher" },
      { workspace: publisherWorkspace, principal: "recipient" },
      { workspace: publisherWorkspace, principal: "bystander" },
      { workspace: outsiderWorkspace, principal: "outsider" },
    ];
    const credentials = new Map<string, { id: string; token: string }>();
    for (const entry of principals) {
      const agent = await pool!.query<{ id: string }>(
        `INSERT INTO agent_bridge.agents (workspace_id,principal)
         VALUES ($1,$2) RETURNING id`,
        [entry.workspace, entry.principal],
      );
      const token = `${entry.principal}-${randomUUID()}`;
      const credential = await pool!.query<{ id: string }>(
        `INSERT INTO agent_bridge.credentials (
           workspace_id,agent_id,token_hash,scopes,scope_set_name
         ) VALUES (
           $1,$2,$3,
           (SELECT scopes FROM agent_bridge.credential_scope_sets WHERE name='release-a-full'),
           'release-a-full'
         ) RETURNING id`,
        [entry.workspace, agent.rows[0]!.id, hashCredential(token)],
      );
      credentials.set(entry.principal, { id: credential.rows[0]!.id, token });
    }

    const login = `bridge_rls_${randomUUID().replaceAll("-", "")}`;
    const password = randomUUID();
    await pool!.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}'`);
    let runtime: pg.Pool | undefined;
    try {
      await pool!.query(`GRANT ${await runtimeRole(pool!)} TO ${login}`);
      const runtimeUrl = new URL(databaseUrl!);
      runtimeUrl.username = login;
      runtimeUrl.password = password;
      runtime = new pg.Pool({ connectionString: runtimeUrl.toString(), max: 3 });
      expect(await runtimeSchemaReady(runtime)).toBe(true);
      await pool!.query(`ALTER ROLE ${login} BYPASSRLS`);
      expect(await runtimeSchemaReady(runtime)).toBe(false);
      await pool!.query(`ALTER ROLE ${login} NOBYPASSRLS`);
      expect(await runtimeSchemaReady(runtime)).toBe(true);
      for (const [unsafe, safe] of [
        ["CREATEROLE", "NOCREATEROLE"],
        ["CREATEDB", "NOCREATEDB"],
        ["REPLICATION", "NOREPLICATION"],
      ] as const) {
        await pool!.query(`ALTER ROLE ${login} ${unsafe}`);
        expect(await runtimeSchemaReady(runtime), unsafe).toBe(false);
        await pool!.query(`ALTER ROLE ${login} ${safe}`);
        expect(await runtimeSchemaReady(runtime), safe).toBe(true);
      }
      const unexpectedRole = `bridge_extra_${randomUUID().replaceAll("-", "")}`;
      await pool!.query(`CREATE ROLE ${unexpectedRole} NOLOGIN`);
      try {
        await pool!.query(`GRANT ${unexpectedRole} TO ${login}`);
        expect(await runtimeSchemaReady(runtime)).toBe(false);
        await pool!.query(`REVOKE ${unexpectedRole} FROM ${login}`);
        expect(await runtimeSchemaReady(runtime)).toBe(true);
      } finally {
        await pool!.query(`REVOKE ${unexpectedRole} FROM ${login}`).catch(() => {});
        await pool!.query(`DROP ROLE IF EXISTS ${unexpectedRole}`);
      }
      const outside = await runtime.connect();
      try {
        expect((await outside.query("SELECT agent_bridge.current_request_workspace() AS workspace")).rows[0]!.workspace).toBeNull();
        await outside.query("SET agent_bridge.workspace='forged-workspace'");
        expect((await outside.query("SELECT agent_bridge.current_request_workspace() AS workspace")).rows[0]!.workspace).toBeNull();
        expect((await outside.query("SELECT count(*)::integer AS count FROM agent_bridge.messages")).rows[0]!.count).toBe(0);
        await expect(outside.query(
          `INSERT INTO agent_bridge.messages (
             id,workspace,source,type,content,targets,delivery_mode,created_at
           ) VALUES ($1,$2,'publisher','agent-bridge.work','forged','[]'::jsonb,'mailbox',now())`,
          [uuidv7(), publisherWorkspace],
        )).rejects.toThrow(/row-level security policy/);
        await expect(outside.query(`SET ROLE ${await pool!.query<{ role_name: string }>(
          `SELECT 'agent_bridge_data_owner_' || substr(md5(current_database()),1,16) AS role_name`,
        ).then((result) => result.rows[0]!.role_name)}`)).rejects.toThrow(/permission denied/);
      } finally {
        outside.release();
      }

      const authority = new PostgresRequestAuthority(runtime);
      const runService = async <T,>(
        principal: string,
        work: (service: BridgeService, principal: { workspace: string; agent: string }) => Promise<T>,
      ) => {
        const credential = credentials.get(principal)!;
        return authority.run(
          credential.id,
          hashCredential(credential.token),
          randomUUID(),
          new AbortController().signal,
          async (context) => {
            await context.beginDomainWork();
            return work(new BridgeService(context.store), context.credential.principal);
          },
        );
      };
      const publishThroughAuthority = async (principal: string, content: string, targets: string[]) =>
        runService(principal, (service, authenticated) => service.publish(
          authenticated,
          { type: "agent-bridge.work", content, targets },
        ));
      const [published, outsiderMessage] = await Promise.all([
        publishThroughAuthority("publisher", "isolated publisher message", ["recipient"]),
        publishThroughAuthority("outsider", "isolated outsider message", ["outsider"]),
      ]);

      const publisherCredential = credentials.get("publisher")!;
      await withRuntimeAuthority(runtime, publisherCredential.id, publisherCredential.token, async (client) => {
        const visible = await client.query<{ id: string }>(
          "SELECT id FROM agent_bridge.messages ORDER BY sequence",
        );
        expect(visible.rows.map((row) => row.id)).toContain(published.message.id);
        expect(visible.rows.map((row) => row.id)).not.toContain(outsiderMessage.message.id);
        const explain = await client.query<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>(
          "EXPLAIN (ANALYZE, COSTS OFF, FORMAT JSON) SELECT * FROM agent_bridge.messages",
        );
        const planNodes: Array<Record<string, unknown>> = [];
        const visitPlan = (node: Record<string, unknown>) => {
          planNodes.push(node);
          for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) {
            visitPlan(child);
          }
        };
        visitPlan(explain.rows[0]!["QUERY PLAN"][0]!.Plan);
        const initPlans = planNodes.filter((node) => node["Parent Relationship"] === "InitPlan");
        expect(initPlans.length).toBeGreaterThanOrEqual(2);
        expect(initPlans.some((node) => node["Actual Loops"] === 1)).toBe(true);
        expect(initPlans.every((node) => Number(node["Actual Loops"]) <= 1)).toBe(true);
        expect(planNodes.filter((node) => node["Parent Relationship"] === "SubPlan")).toHaveLength(0);
        await expectStatementRejected(
          client,
          "UPDATE agent_bridge.deliveries SET state='claimed',last_action='claim' WHERE message_id=$1",
          [published.message.id],
          /only the delivery recipient may update delivery state/,
        );
        await expectStatementRejected(
          client,
          "UPDATE agent_bridge.deliveries SET lease_owner='publisher-forged' WHERE message_id=$1",
          [published.message.id],
          /only the delivery recipient may update lease state/,
        );
        await expectStatementRejected(
          client,
          `UPDATE agent_bridge.deliveries
           SET state='cancelled',last_action='cancel',last_actor='forged'
           WHERE message_id=$1`,
          [published.message.id],
          /publisher delivery actor must match request authority/,
        );
        await expectStatementRejected(
          client,
          `INSERT INTO agent_bridge.deliveries (
             id,message_id,workspace,publisher,recipient,state,last_actor,last_action
           ) VALUES ($1,$2,$3,'publisher','recipient','acked','forged','ack')`,
          [uuidv7(), published.message.id, publisherWorkspace],
          /publisher delivery creation must use canonical initial state/,
        );
        await expectStatementRejected(
          client,
          `INSERT INTO agent_bridge.delivery_events (
             delivery_id,message_id,workspace,publisher,recipient,to_state,actor,action
           ) SELECT id,message_id,workspace,publisher,recipient,state,'forged','created'
             FROM agent_bridge.deliveries WHERE message_id=$1`,
          [published.message.id],
          /permission denied/,
        );
        await expectStatementRejected(
          client,
          `INSERT INTO agent_bridge.messages (
             id,workspace,source,type,content,targets,delivery_mode,created_at
           ) VALUES ($1,$2,'publisher','agent-bridge.work','cross-workspace','[]'::jsonb,'mailbox',now())`,
          [uuidv7(), outsiderWorkspace],
          /row-level security policy/,
        );
      });

      const recipientCredential = credentials.get("recipient")!;
      await withRuntimeAuthority(runtime, recipientCredential.id, recipientCredential.token, async (client) => {
        await expectStatementRejected(
          client,
          "UPDATE agent_bridge.deliveries SET state='cancelled',last_action='cancel' WHERE message_id=$1",
          [published.message.id],
          /only the delivery publisher may cancel/,
        );
        await expectStatementRejected(
          client,
          `UPDATE agent_bridge.deliveries
           SET state='claimed',attempt=attempt+1,cycle_attempt=cycle_attempt+1,
             last_action='claim',last_actor='publisher'
           WHERE message_id=$1`,
          [published.message.id],
          /recipient delivery actor must match request authority/,
        );
      });

      const settled = await runService("recipient", async (service, authenticated) => {
        const principal = { ...authenticated, instance: "recipient-runtime" };
        const claim = await service.claim(principal, { leaseMs: 5_000 });
        expect(claim?.delivery.messageId).toBe(published.message.id);
        expect((await service.ack(principal, claim!.delivery.id, claim!.leaseToken))?.state).toBe("acked");
        expect(await service.acknowledge(principal, [published.message.id])).toBe(1);
        await service.heartbeat(principal, { leaseMs: 5_000, runtimeType: "test", capabilities: ["claim"] });
        return {
          deliveryId: claim!.delivery.id,
          actions: (await service.deliveryEvents(principal, claim!.delivery.id)).events.map((event) => event.action),
        };
      });
      expect(settled.actions).toEqual(expect.arrayContaining(["created", "claim", "ack"]));

      const bystanderCredential = credentials.get("bystander")!;
      await withRuntimeAuthority(runtime, bystanderCredential.id, bystanderCredential.token, async (client) => {
        for (const table of ["messages", "deliveries", "delivery_events", "receipts"] as const) {
          const result = await client.query<{ count: number }>(
            `SELECT count(*)::integer AS count FROM agent_bridge.${table}`,
          );
          expect(result.rows[0]!.count, table).toBe(0);
        }
        expect((await client.query(
          "UPDATE agent_bridge.deliveries SET lease_owner='bystander' WHERE message_id=$1",
          [published.message.id],
        )).rowCount).toBe(0);
      });

      await runService("outsider", async (service, authenticated) => {
        await service.heartbeat(
          { ...authenticated, instance: "outsider-runtime" },
          { leaseMs: 5_000, runtimeType: "test" },
        );
      });
      const cancelledMessage = await publishThroughAuthority(
        "publisher",
        "publisher lifecycle message",
        ["recipient"],
      );
      const publisherProof = await runService("publisher", async (service, authenticated) => {
        const delivery = (await service.deliveries(authenticated, {
          messageId: cancelledMessage.message.id,
          role: "publisher",
        })).deliveries[0]!;
        expect((await service.cancel(authenticated, delivery.id))?.state).toBe("cancelled");
        expect((await service.requeue(authenticated, delivery.id))?.state).toBe("pending");
        const present = await service.presence(authenticated);
        return {
          deliveryId: delivery.id,
          actions: (await service.deliveryEvents(authenticated, delivery.id)).events.map((event) => event.action),
          presence: present.map((entry) => `${entry.agent}/${entry.instance}`),
        };
      });
      expect(publisherProof.actions).toEqual(expect.arrayContaining(["created", "cancel", "requeue"]));
      expect(publisherProof.presence).toContain("recipient/recipient-runtime");
      expect(publisherProof.presence).not.toContain("outsider/outsider-runtime");
      await withRuntimeAuthority(runtime, publisherCredential.id, publisherCredential.token, async (client) => {
        expect((await client.query(
          "SELECT count(*)::integer AS count FROM agent_bridge.receipts WHERE message_id=$1",
          [published.message.id],
        )).rows[0]!.count).toBe(0);
      });

      const reused = await runtime.connect();
      try {
        expect((await reused.query("SELECT agent_bridge.current_request_principal() AS principal")).rows[0]!.principal).toBeNull();
      } finally {
        reused.release();
      }
    } finally {
      await runtime?.end();
      await pool!.query(`DROP ROLE IF EXISTS ${login}`);
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
      `INSERT INTO agent_bridge.credentials (workspace_id, agent_id, token_hash, label, scopes, scope_set_name)
       VALUES
         ($1, $2, $3, 'codex test', (SELECT scopes FROM agent_bridge.credential_scope_sets WHERE name='release-a-full'), 'release-a-full'),
         ($1, $4, $5, 'claude test', (SELECT scopes FROM agent_bridge.credential_scope_sets WHERE name='release-a-full'), 'release-a-full')`,
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
    let home: string | undefined;
    let child: ChildProcess | undefined;
    let codexRuntime: Awaited<ReturnType<typeof createClientRuntime>> | undefined;
    let claudeRuntime: Awaited<ReturnType<typeof createClientRuntime>> | undefined;
    let stderr = "";
    try {
      await pool!.query(`GRANT ${await runtimeRole(pool!)} TO ${login}`);
      const runtimeUrl = new URL(databaseUrl!);
      runtimeUrl.username = login;
      runtimeUrl.password = password;
      const port = await freePort();
      const gatewayUrl = `http://127.0.0.1:${port}`;
      home = mkdtempSync(join(tmpdir(), "agent-bridge-pg-gateway-"));
      child = spawn(process.execPath, [
        fileURLToPath(new URL("../dist/gateway-main.js", import.meta.url)),
      ], {
        env: {
          ...process.env,
          AGENT_BRIDGE_RUNTIME_DATABASE_URL: runtimeUrl.toString(),
          AGENT_BRIDGE_HOST: "127.0.0.1",
          AGENT_BRIDGE_PORT: String(port),
          AGENT_BRIDGE_DATABASE_POOL_SIZE: "1",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      await waitForGateway(child, gatewayUrl, () => stderr);
      const capabilities = await fetch(`${gatewayUrl}/v2/capabilities`, {
        headers: {
          authorization: `Bearer ${codexToken}`,
          "x-agent-bridge-protocol-version": "2.1",
        },
      });
      expect(capabilities.status).toBe(200);
      expect(await capabilities.json()).toMatchObject({
        requestAuthority: true,
        rowIsolation: true,
      });
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
      expect((await pool!.query("SELECT count(*)::integer AS count FROM agent_bridge.request_authorities")).rows[0]!.count).toBe(0);
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
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      if (home) rmSync(home, { recursive: true, force: true });
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

  it("detects request-authority privilege and definer drift", async () => {
    const client = await pool!.connect();
    const role = await runtimeRole(client);
    const ready = () => runtimeSchemaReady(client, { allowPrivilegedCaller: true });
    try {
      expect(await ready()).toBe(true);

      await client.query(`GRANT INSERT ON agent_bridge.request_authorities TO ${role}`);
      expect(await ready()).toBe(false);
      await client.query(`REVOKE INSERT ON agent_bridge.request_authorities FROM ${role}`);
      expect(await ready()).toBe(true);

      await client.query(
        "ALTER FUNCTION agent_bridge.open_request_authority(uuid,text,uuid) SECURITY INVOKER",
      );
      expect(await ready()).toBe(false);
      await client.query(
        "ALTER FUNCTION agent_bridge.open_request_authority(uuid,text,uuid) SECURITY DEFINER",
      );
      expect(await ready()).toBe(true);
    } finally {
      await client.query(`REVOKE INSERT ON agent_bridge.request_authorities FROM ${role}`);
      await client.query(
        "ALTER FUNCTION agent_bridge.open_request_authority(uuid,text,uuid) SECURITY DEFINER",
      );
      client.release();
    }
  });

  it("upgrades v0.2 credentials with compatible canonical scopes and exact migration state", async () => {
    await withTemporaryDatabase(async (upgrade) => {
      const directory = fileURLToPath(new URL("../sql/migrations", import.meta.url));
      const plan = await loadMigrationPlan(directory);
      for (const migration of plan.slice(0, 10)) {
        await upgrade.query(migration.source.split("__AGENT_BRIDGE_MIGRATION_CHECKSUM__").join(migration.checksum));
      }
      await upgrade.query("INSERT INTO agent_bridge.workspaces(id,name) VALUES ('upgrade-security','upgrade-security')");
      const agent = await upgrade.query<{ id: string }>(
        "INSERT INTO agent_bridge.agents(workspace_id,principal) VALUES ('upgrade-security','worker') RETURNING id",
      );
      await upgrade.query(
        `INSERT INTO agent_bridge.credentials(workspace_id,agent_id,token_hash,revoked_at)
         VALUES ('upgrade-security',$1,$2,NULL),('upgrade-security',$1,$3,now())`,
        [agent.rows[0]!.id, "a".repeat(64), "b".repeat(64)],
      );
      const migration = plan[10]!;
      await upgrade.query(migration.source.split("__AGENT_BRIDGE_MIGRATION_CHECKSUM__").join(migration.checksum));
      const credentials = await upgrade.query<{ active: boolean; scopes: string[]; revoked_by: string | null; revocation_reason: string | null }>(
        "SELECT revoked_at IS NULL active,scopes,revoked_by,revocation_reason FROM agent_bridge.credentials ORDER BY revoked_at NULLS FIRST",
      );
      expect(credentials.rows[0]!.scopes).toEqual(AUTHORIZATION_SCOPES);
      expect(credentials.rows[1]).toMatchObject({
        active: false,
        scopes: AUTHORIZATION_SCOPES,
        revoked_by: null,
        revocation_reason: null,
      });
      const direct = await upgrade.query<{ scopes: string[] }>(
        "INSERT INTO agent_bridge.credentials(workspace_id,agent_id,token_hash) VALUES ('upgrade-security',$1,$2) RETURNING scopes",
        [agent.rows[0]!.id, "c".repeat(64)],
      );
      expect(direct.rows[0]!.scopes).toEqual(AUTHORIZATION_SCOPES);
      expect((await upgrade.query("SELECT name,checksum FROM agent_bridge.schema_migrations WHERE version=11")).rows)
        .toEqual([{ name: "credential_security", checksum: migration.checksum }]);
    });
  });

  it("backfills v0.2 delivery history and preserves deterministic claim order", async () => {
    await withTemporaryDatabase(async (upgrade) => {
      const directory = fileURLToPath(new URL("../sql/migrations", import.meta.url));
      const plan = await loadMigrationPlan(directory);
      for (const migration of plan.slice(0, 9)) {
        await upgrade.query(
          migration.source.split("__AGENT_BRIDGE_MIGRATION_CHECKSUM__").join(migration.checksum),
        );
      }
      await upgrade.query("INSERT INTO agent_bridge.workspaces (id,name) VALUES ('migration-test','migration-test')");
      const legacy = [
        { messageId: "018f4a70-0000-7000-8000-000000000101", deliveryId: "018f4a70-0000-7000-8000-000000000111", state: "acked", attempt: 1, actor: "worker-ack", error: null },
        { messageId: "018f4a70-0000-7000-8000-000000000102", deliveryId: "018f4a70-0000-7000-8000-000000000112", state: "claimed", attempt: 1, actor: "worker-claim", error: null },
        { messageId: "018f4a70-0000-7000-8000-000000000103", deliveryId: "018f4a70-0000-7000-8000-000000000113", state: "retrying", attempt: 2, actor: "worker-retry", error: "retry" },
        { messageId: "018f4a70-0000-7000-8000-000000000104", deliveryId: "018f4a70-0000-7000-8000-000000000114", state: "dead", attempt: 3, actor: "worker-dead", error: "legacy failure" },
      ] as const;
      for (const [index, row] of legacy.entries()) {
        const createdAt = `2026-07-1${index}T00:00:00.000Z`;
        await upgrade.query(`INSERT INTO agent_bridge.messages
          (id,workspace,source,type,content,targets,priority,created_at)
          VALUES ($1,'migration-test','publisher','work',$2,'["worker"]'::jsonb,'high',$3)`,
        [row.messageId, row.state, createdAt]);
        await upgrade.query(`INSERT INTO agent_bridge.deliveries
          (id,message_id,workspace,recipient,state,attempt,available_at)
          VALUES ($1,$2,'migration-test','worker','pending',0,$3)`,
        [row.deliveryId, row.messageId, createdAt]);
        await upgrade.query(`UPDATE agent_bridge.deliveries
          SET state='claimed',attempt=$2,lease_token=$3,lease_owner=$4,
            lease_expires_at='2026-08-01T00:00:00.000Z'
          WHERE id=$1`, [row.deliveryId, row.attempt, randomUUID(), row.actor]);
        if (row.state !== "claimed") {
          await upgrade.query(`UPDATE agent_bridge.deliveries
            SET state=$2,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error=$3
            WHERE id=$1`, [row.deliveryId, row.state, row.error]);
        }
      }
      await upgrade.query(`INSERT INTO agent_bridge.delivery_events
        (delivery_id,message_id,workspace,recipient,from_state,to_state,attempt,lease_owner,error,created_at)
        VALUES
          ('018f4a70-0000-7000-8000-000000000114','018f4a70-0000-7000-8000-000000000104','migration-test','worker','claimed','dead',3,NULL,'message expired','2026-07-13T23:59:58.000Z'),
          ('018f4a70-0000-7000-8000-000000000114','018f4a70-0000-7000-8000-000000000104','migration-test','worker','claimed','dead',3,NULL,'maximum attempts reached','2026-07-13T23:59:59.000Z')`);
      const migration = plan[9]!;
      await upgrade.query(
        migration.source.split("__AGENT_BRIDGE_MIGRATION_CHECKSUM__").join(migration.checksum),
      );
      const migrated = await upgrade.query<{
        state: string; created_matches: boolean; last_action: string; last_actor: string;
      }>(`SELECT delivery.state,delivery.created_at=message.created_at AS created_matches,
          delivery.last_action,delivery.last_actor
        FROM agent_bridge.deliveries delivery JOIN agent_bridge.messages message
          ON message.workspace=delivery.workspace AND message.id=delivery.message_id
        ORDER BY delivery.id`);
      expect(migrated.rows).toEqual([
        { state: "acked", created_matches: true, last_action: "ack", last_actor: "worker-ack" },
        { state: "claimed", created_matches: true, last_action: "claim", last_actor: "worker-claim" },
        { state: "retrying", created_matches: true, last_action: "nack_retry", last_actor: "worker-retry" },
        { state: "dead", created_matches: true, last_action: "nack_dead", last_actor: "worker-dead" },
      ]);
      const actions = await upgrade.query<{ to_state: string; action: string; actor: string }>(`
        SELECT to_state,action,actor FROM agent_bridge.delivery_events
        WHERE workspace='migration-test' AND from_state IS NOT NULL
          AND error IS DISTINCT FROM 'message expired'
          AND error IS DISTINCT FROM 'maximum attempts reached'
          AND to_state<>'claimed'
        ORDER BY delivery_id,sequence`);
      expect(actions.rows).toEqual([
        { to_state: "acked", action: "ack", actor: "worker-ack" },
        { to_state: "retrying", action: "nack_retry", actor: "worker-retry" },
        { to_state: "dead", action: "nack_dead", actor: "worker-dead" },
      ]);
      const claimActors = await upgrade.query<{ actor: string }>(`
        SELECT actor FROM agent_bridge.delivery_events
        WHERE workspace='migration-test' AND to_state='claimed'
        ORDER BY delivery_id`);
      expect(claimActors.rows).toEqual(legacy.map((row) => ({ actor: row.actor })));
      const createdActors = await upgrade.query<{ action: string; actor: string }>(`
        SELECT action,actor FROM agent_bridge.delivery_events
        WHERE workspace='migration-test' AND from_state IS NULL
        ORDER BY delivery_id`);
      expect(createdActors.rows).toEqual(Array.from({ length: 4 }, () => ({
        action: "created", actor: "publisher",
      })));
      const automatedActors = await upgrade.query<{ error: string; action: string; actor: string }>(`
        SELECT error,action,actor FROM agent_bridge.delivery_events
        WHERE workspace='migration-test'
          AND error IN ('message expired','maximum attempts reached')
        ORDER BY error`);
      expect(automatedActors.rows).toEqual([
        { error: "maximum attempts reached", action: "attempts_exhausted", actor: "agent-bridge" },
        { error: "message expired", action: "message_expired", actor: "agent-bridge" },
      ]);

      const sameTime = "2026-07-14T12:00:00.000Z";
      const ordered = [
        { messageId: "018f4a70-0000-7000-8000-000000000121", deliveryId: "018f4a70-0000-7000-8000-000000000131", priority: "info", rank: 2 },
        { messageId: "018f4a70-0000-7000-8000-000000000122", deliveryId: "018f4a70-0000-7000-8000-000000000132", priority: "high", rank: 1 },
        { messageId: "018f4a70-0000-7000-8000-000000000123", deliveryId: "018f4a70-0000-7000-8000-000000000134", priority: "urgent", rank: 0 },
        { messageId: "018f4a70-0000-7000-8000-000000000124", deliveryId: "018f4a70-0000-7000-8000-000000000133", priority: "urgent", rank: 0 },
      ] as const;
      for (const row of ordered) {
        await upgrade.query(`INSERT INTO agent_bridge.messages
          (id,workspace,source,type,content,targets,priority,created_at,delivery_mode,
           delivery_max_attempts,delivery_retry_base_delay_ms,delivery_retry_max_delay_ms,
           delivery_retry_jitter_ratio)
          VALUES ($1,'migration-test','publisher','work',$2,'["order-worker"]'::jsonb,$3,$4,
            'leased',5,1000,60000,0.2)`, [row.messageId, row.priority, row.priority, sameTime]);
        await upgrade.query(`INSERT INTO agent_bridge.deliveries
          (id,message_id,workspace,recipient,state,created_at,priority_rank,available_at,last_actor,last_action)
          VALUES ($1,$2,'migration-test','order-worker','pending',$3,$4,$3,'publisher','created')`,
        [row.deliveryId, row.messageId, sameTime, row.rank]);
      }
      const service = new BridgeService(new PostgresBridgeStore(upgrade));
      const worker = { workspace: "migration-test", agent: "order-worker", instance: "order" };
      const actual: string[] = [];
      for (let index = 0; index < ordered.length; index += 1) {
        const claim = await service.claim(worker, { leaseMs: 1_000 });
        actual.push(claim!.delivery.messageId);
        await service.ack(worker, claim!.delivery.id, claim!.leaseToken);
      }
      expect(actual).toEqual([
        "018f4a70-0000-7000-8000-000000000124",
        "018f4a70-0000-7000-8000-000000000123",
        "018f4a70-0000-7000-8000-000000000122",
        "018f4a70-0000-7000-8000-000000000121",
      ]);
    });
  });

  it("upgrades populated deliveries to row isolation and serves them through request authority", async () => {
    await withTemporaryDatabase(async (upgrade) => {
      const directory = fileURLToPath(new URL("../sql/migrations", import.meta.url));
      const plan = await loadMigrationPlan(directory);
      for (const migration of plan.slice(0, 12)) {
        await upgrade.query(
          migration.source.split("__AGENT_BRIDGE_MIGRATION_CHECKSUM__").join(migration.checksum),
        );
      }
      const rowIsolationMigration = plan[12]!;
      expect(rowIsolationMigration).toMatchObject({ version: 13, name: "row_isolation" });

      const workspaceId = "upgrade-row-isolation";
      const messageId = "018f4a70-0000-7000-8000-000000000201";
      const deliveryId = "018f4a70-0000-7000-8000-000000000211";
      await upgrade.query(
        "INSERT INTO agent_bridge.workspaces(id,name) VALUES ($1,$1)",
        [workspaceId],
      );
      const credentialRecords = new Map<string, { id: string; token: string }>();
      for (const principal of ["publisher", "recipient"] as const) {
        const agent = await upgrade.query<{ id: string }>(
          "INSERT INTO agent_bridge.agents(workspace_id,principal) VALUES ($1,$2) RETURNING id",
          [workspaceId, principal],
        );
        const token = `${principal}-${randomUUID()}`;
        const credential = await upgrade.query<{ id: string }>(
          `INSERT INTO agent_bridge.credentials(
             workspace_id,agent_id,token_hash,scopes,scope_set_name
           ) VALUES (
             $1,$2,$3,
             (SELECT scopes FROM agent_bridge.credential_scope_sets WHERE name='release-a-full'),
             'release-a-full'
           ) RETURNING id`,
          [workspaceId, agent.rows[0]!.id, hashCredential(token)],
        );
        credentialRecords.set(principal, { id: credential.rows[0]!.id, token });
      }
      await upgrade.query(
        `INSERT INTO agent_bridge.messages (
           id,workspace,source,type,content,targets,delivery_mode,
           delivery_max_attempts,delivery_retry_base_delay_ms,
           delivery_retry_max_delay_ms,delivery_retry_jitter_ratio,created_at
         ) VALUES (
           $1,$2,'publisher','agent-bridge.work','upgrade existing delivery',
           '["recipient"]'::jsonb,'leased',5,1000,60000,0.2,
           '2026-07-14T12:00:00.000Z'
         )`,
        [messageId, workspaceId],
      );
      await upgrade.query(
        `INSERT INTO agent_bridge.deliveries (
           id,message_id,workspace,recipient,state,created_at,available_at,last_actor,last_action
         ) VALUES (
           $1,$2,$3,'recipient','pending',
           '2026-07-14T12:00:00.000Z','2026-07-14T12:00:00.000Z','publisher','created'
         )`,
        [deliveryId, messageId, workspaceId],
      );
      const before = await upgrade.query<{
        delivery_id: string; event_sequence: string; action: string; actor: string;
        delivery_created_at: string; event_created_at: string;
      }>(`SELECT delivery.id AS delivery_id,event.sequence::text AS event_sequence,
            event.action,event.actor,delivery.created_at::text AS delivery_created_at,
            event.created_at::text AS event_created_at
          FROM agent_bridge.deliveries delivery
          JOIN agent_bridge.delivery_events event ON event.delivery_id=delivery.id
          WHERE delivery.id=$1`, [deliveryId]);
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0]).toMatchObject({ action: "created", actor: "publisher" });

      await upgrade.query(
        rowIsolationMigration.source
          .split("__AGENT_BRIDGE_MIGRATION_CHECKSUM__")
          .join(rowIsolationMigration.checksum),
      );
      expect(await migrationsReady(upgrade, plan)).toBe(true);
      expect(await runtimeSchemaReady(upgrade, { allowPrivilegedCaller: true })).toBe(true);
      expect((await upgrade.query(
        "SELECT name,checksum FROM agent_bridge.schema_migrations WHERE version=13",
      )).rows).toEqual([{ name: "row_isolation", checksum: rowIsolationMigration.checksum }]);
      const after = await upgrade.query<{
        delivery_id: string; event_sequence: string; action: string; actor: string;
        publisher: string; event_publisher: string;
        delivery_created_at: string; event_created_at: string;
      }>(`SELECT delivery.id AS delivery_id,event.sequence::text AS event_sequence,
            event.action,event.actor,delivery.publisher,event.publisher AS event_publisher,
            delivery.created_at::text AS delivery_created_at,
            event.created_at::text AS event_created_at
          FROM agent_bridge.deliveries delivery
          JOIN agent_bridge.delivery_events event ON event.delivery_id=delivery.id
          WHERE delivery.id=$1`, [deliveryId]);
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]).toEqual({
        ...before.rows[0],
        publisher: "publisher",
        event_publisher: "publisher",
      });

      const login = `bridge_upgrade_login_${randomUUID().replaceAll("-", "")}`;
      const password = randomUUID();
      let runtime: pg.Pool | undefined;
      const loginFailures: unknown[] = [];
      await upgrade.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}'`);
      try {
        await upgrade.query(`GRANT ${await runtimeRole(upgrade)} TO ${login}`);
        const databaseName = (await upgrade.query<{ name: string }>(
          "SELECT current_database() AS name",
        )).rows[0]!.name;
        const runtimeUrl = new URL(databaseUrl!);
        runtimeUrl.pathname = `/${databaseName}`;
        runtimeUrl.username = login;
        runtimeUrl.password = password;
        runtime = new pg.Pool({ connectionString: runtimeUrl.toString(), max: 2 });
        expect(await runtimeSchemaReady(runtime)).toBe(true);

        const authority = new PostgresRequestAuthority(runtime);
        const runAs = async <T,>(
          principal: "publisher" | "recipient",
          work: (service: BridgeService, authenticated: { workspace: string; agent: string }) => Promise<T>,
        ) => {
          const credential = credentialRecords.get(principal)!;
          return authority.run(
            credential.id,
            hashCredential(credential.token),
            randomUUID(),
            new AbortController().signal,
            async (context) => {
              await context.beginDomainWork();
              return work(new BridgeService(context.store), context.credential.principal);
            },
          );
        };
        const recipientEvents = await runAs("recipient", async (service, authenticated) => {
          const principal = { ...authenticated, instance: "upgrade-runtime" };
          const claim = await service.claim(principal, { leaseMs: 5_000 });
          expect(claim?.delivery).toMatchObject({ id: deliveryId, messageId });
          expect((await service.ack(principal, deliveryId, claim!.leaseToken))?.state).toBe("acked");
          return (await service.deliveryEvents(principal, deliveryId)).events.map((event) => event.action);
        });
        expect(recipientEvents).toEqual(["created", "claim", "ack"]);

        await runAs("publisher", async (service, authenticated) => {
          expect((await service.deliveries(authenticated, {
            messageId,
            role: "publisher",
          })).deliveries).toEqual([expect.objectContaining({ id: deliveryId, state: "acked" })]);
          expect((await service.deliveryEvents(authenticated, deliveryId)).events.map((event) => event.action))
            .toEqual(["created", "claim", "ack"]);
        });
        expect((await upgrade.query(
          "SELECT count(*)::integer AS count FROM agent_bridge.request_authorities",
        )).rows[0]!.count).toBe(0);
      } catch (error) {
        loginFailures.push(error);
      }
      for (const cleanup of [
        async () => { await runtime?.end(); },
        async () => { await upgrade.query(`DROP ROLE IF EXISTS ${login}`); },
      ]) {
        try {
          await cleanup();
        } catch (error) {
          loginFailures.push(error);
        }
      }
      if (loginFailures.length === 1) throw loginFailures[0];
      if (loginFailures.length > 1) {
        throw new AggregateError(loginFailures, "temporary PostgreSQL login run and cleanup failed");
      }
    });
  });

  it("reports a missing runtime table as not ready", async () => {
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query("DROP TABLE agent_bridge.receipts");
      expect(await runtimeSchemaReady(client, { allowPrivilegedCaller: true })).toBe(false);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await runtimeSchemaReady(pool!, { allowPrivilegedCaller: true })).toBe(true);
  });

  it("reports security policy, trigger, and grant drift as not ready", async () => {
    const runtime = await runtimeRole(pool!);
    const internal = (await pool!.query<{ context_reader: string; event_writer: string }>(
      `SELECT
         'agent_bridge_context_reader_' || substr(md5(current_database()),1,16) AS context_reader,
         'agent_bridge_event_writer_' || substr(md5(current_database()),1,16) AS event_writer`,
    )).rows[0]!;
    const cases = [
      "UPDATE agent_bridge.rate_limit_policies SET capacity=31 WHERE operation_id='status'",
      "ALTER TABLE agent_bridge.security_events DISABLE TRIGGER security_events_append_only",
      `GRANT SELECT ON agent_bridge.rate_limit_policies TO ${runtime}`,
      `GRANT CREATE ON SCHEMA agent_bridge TO ${runtime}`,
      `GRANT CREATE ON SCHEMA agent_bridge TO ${internal.context_reader}`,
      `GRANT CREATE ON SCHEMA agent_bridge TO ${internal.event_writer}`,
      `GRANT UPDATE ON SEQUENCE agent_bridge.delivery_events_sequence_seq TO ${runtime}`,
      `GRANT SELECT ON agent_bridge.messages TO ${internal.context_reader}`,
      `GRANT SELECT ON agent_bridge.messages TO ${internal.event_writer}`,
      `GRANT EXECUTE ON FUNCTION agent_bridge.replace_credential(uuid,character,text[],text,text,timestamptz,timestamptz,text,uuid) TO ${runtime}`,
      `GRANT EXECUTE ON FUNCTION agent_bridge.revoke_credential(uuid,text,text,uuid) TO ${runtime}`,
    ];
    for (const change of cases) {
      const client = await pool!.connect();
      try {
        await client.query("BEGIN");
        await client.query(change);
        expect(await runtimeSchemaReady(client, { allowPrivilegedCaller: true }), change).toBe(false);
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    }
    expect(await runtimeSchemaReady(pool!, { allowPrivilegedCaller: true })).toBe(true);
  });

  it("rejects broadened policies and same-name catalog replacements", async () => {
    const runtime = await runtimeRole(pool!);
    const cases = [
      `DROP POLICY messages_runtime_select ON agent_bridge.messages;
       CREATE POLICY messages_runtime_select ON agent_bridge.messages
       FOR SELECT TO ${runtime} USING (true)`,
      `ALTER TABLE agent_bridge.deliveries DROP CONSTRAINT deliveries_publisher_message_fk;
       ALTER TABLE agent_bridge.deliveries ADD CONSTRAINT deliveries_publisher_message_fk
       CHECK (publisher <> '')`,
      `DROP TRIGGER deliveries_actor_role ON agent_bridge.deliveries;
       CREATE TRIGGER deliveries_actor_role BEFORE UPDATE ON agent_bridge.deliveries
       FOR EACH ROW EXECUTE FUNCTION agent_bridge.reject_delivery_identity_mutation()`,
      `CREATE TRIGGER messages_unexpected BEFORE UPDATE ON agent_bridge.messages
       FOR EACH ROW EXECUTE FUNCTION agent_bridge.reject_message_mutation()`,
      "ALTER TABLE agent_bridge.deliveries ALTER COLUMN publisher DROP NOT NULL",
      "ALTER TABLE agent_bridge.delivery_events ALTER COLUMN publisher DROP NOT NULL",
      "UPDATE agent_bridge.row_isolation_attestations SET catalog_definition='forged' WHERE name='domain-v1'",
      "GRANT EXECUTE ON FUNCTION agent_bridge.reject_delivery_identity_mutation() TO public",
      `GRANT UPDATE ON agent_bridge.row_isolation_attestations TO ${runtime}`,
    ];
    for (const change of cases) {
      const client = await pool!.connect();
      try {
        await client.query("BEGIN");
        await client.query(change);
        expect(await runtimeSchemaReady(client, { allowPrivilegedCaller: true }), change).toBe(false);
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    }
    expect(await runtimeSchemaReady(pool!, { allowPrivilegedCaller: true })).toBe(true);
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
