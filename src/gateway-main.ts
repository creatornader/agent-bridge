import { fileURLToPath } from "node:url";
import pg from "pg";
import { PostgresCredentialResolver } from "./gateway-auth.js";
import { PostgresGatewaySecurity } from "./gateway-security.js";
import { createGateway } from "./gateway.js";
import {
  loadMigrationPlan,
  migrationsReady,
  runMigrations,
  runtimeSchemaReady,
} from "./migrations.js";
import { PostgresBridgeStore } from "./postgres-bridge-store.js";
import { PostgresRequestAuthority } from "./postgres-request-authority.js";

function integer(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function main(): Promise<void> {
  const migrationsDirectory = fileURLToPath(new URL("../sql/migrations", import.meta.url));
  if (process.argv.includes("--migrate-only")) {
    const databaseUrl = process.env.AGENT_BRIDGE_DATABASE_URL;
    if (!databaseUrl) throw new Error("AGENT_BRIDGE_DATABASE_URL is required for migrations");
    const migrationPool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      application_name: "agent-bridge-migrator",
    });
    try {
      await runMigrations(migrationPool, migrationsDirectory);
    } finally {
      await migrationPool.end();
    }
    return;
  }
  if (process.env.AGENT_BRIDGE_MIGRATE === "1") {
    throw new Error("AGENT_BRIDGE_MIGRATE is not supported; run agent-bridge migrate separately");
  }
  const databaseUrl = process.env.AGENT_BRIDGE_RUNTIME_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("AGENT_BRIDGE_RUNTIME_DATABASE_URL is required for the gateway");
  }

  const deadline = integer(process.env.AGENT_BRIDGE_REQUEST_DEADLINE_MS, 10_000, "request deadline");
  const databaseTimeout = integer(
    process.env.AGENT_BRIDGE_DATABASE_TIMEOUT_MS,
    Math.max(1, Math.floor(deadline / 3)),
    "database timeout",
  );
  const poolSize = integer(process.env.AGENT_BRIDGE_DATABASE_POOL_SIZE, 10, "database pool size");
  const bodyLimitBytes = integer(
    process.env.AGENT_BRIDGE_BODY_LIMIT_BYTES,
    128 * 1024,
    "body limit",
  );
  const host = process.env.AGENT_BRIDGE_HOST ?? "127.0.0.1";
  const port = integer(process.env.AGENT_BRIDGE_PORT, 8787, "gateway port");
  const allowedOrigins = process.env.AGENT_BRIDGE_ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const migrationPlan = await loadMigrationPlan(migrationsDirectory);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: poolSize,
    connectionTimeoutMillis: databaseTimeout,
    query_timeout: databaseTimeout,
    statement_timeout: databaseTimeout,
    application_name: "agent-bridge-gateway",
  });
  const readinessPool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: databaseTimeout,
    query_timeout: databaseTimeout,
    statement_timeout: databaseTimeout,
    application_name: "agent-bridge-gateway-readiness",
  });

  const store = new PostgresBridgeStore(pool);
  let readinessCheckedAt = 0;
  let readinessValue = false;
  let readinessInFlight: Promise<boolean> | undefined;
  const probeSchema = async () =>
    await migrationsReady(readinessPool, migrationPlan) && await runtimeSchemaReady(readinessPool);
  const schemaReady = (force = false): Promise<boolean> => {
    if (!force && Date.now() - readinessCheckedAt < 1_000) {
      return Promise.resolve(readinessValue);
    }
    if (readinessInFlight) return readinessInFlight;
    let current: Promise<boolean>;
    current = probeSchema()
      .then((ready) => {
        readinessValue = ready;
        readinessCheckedAt = Date.now();
        return ready;
      })
      .finally(() => {
        if (readinessInFlight === current) readinessInFlight = undefined;
      });
    readinessInFlight = current;
    return current;
  };
  try {
    if (!await schemaReady(true)) {
      throw new Error("runtime database is not ready for enforced row isolation");
    }
  } catch (error) {
    await Promise.allSettled([pool.end(), readinessPool.end()]);
    throw error;
  }
  const gateway = createGateway({
    store,
    credentials: new PostgresCredentialResolver(pool),
    security: new PostgresGatewaySecurity(pool),
    requestAuthority: new PostgresRequestAuthority(pool),
    allowedOrigins,
    bodyLimitBytes,
    requestDeadlineMs: deadline,
    ready: schemaReady,
    rowIsolationReady: schemaReady,
  });

  gateway.listen(port, host, () => {
    process.stderr.write(`Agent Bridge gateway listening on ${host}:${port}\n`);
  });

  let stopping = false;
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((resolve, reject) => {
      gateway.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all([pool.end(), readinessPool.end()]);
  }

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
