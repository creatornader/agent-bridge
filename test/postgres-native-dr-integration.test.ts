import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync,
  rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeService } from "../src/bridge-service.js";
import { runDrCommand } from "../src/dr-cli.js";
import { runMigrations } from "../src/migrations.js";
import { PostgresBridgeStore } from "../src/postgres-bridge-store.js";
import {
  backupPostgresNativeDr,
  buildPostgresDefaultPrivilegeStatements,
  buildPostgresRoleShellStatements,
  canonicalPostgresRoleInventory,
  collectPostgresRoleInventory,
  restorePostgresNativeDr,
  type PostgresDrClient,
  type PostgresNativeDrArtifactAnchor,
  type PostgresDrToolResult,
  type PostgresNativeDrDependencies,
  verifyPostgresNativeDrArtifacts,
} from "../src/postgres-native-dr.js";

const enabled = process.env.AGENT_BRIDGE_POSTGRES_NATIVE_DR_INTEGRATION === "1";
const integration = enabled ? describe : describe.skip;
const migrationDirectory = fileURLToPath(new URL("../sql/migrations", import.meta.url));
const password = "agent-bridge-native-dr-test";
const residues = new Set<string>();
const descriptors = new Set<number>();

afterEach(async () => {
  for (const descriptor of descriptors) closeSync(descriptor);
  descriptors.clear();
  for (const residue of [...residues]) {
    if (residue.startsWith("container:")) docker(["rm", "-f", residue.slice("container:".length)], true);
    else rmSync(residue, { recursive: true, force: true });
    residues.delete(residue);
  }
});

function anchorFor(path: string): PostgresNativeDrArtifactAnchor {
  const descriptor = openSync(path, constants.O_RDONLY);
  descriptors.add(descriptor);
  const stat = fstatSync(descriptor, { bigint: true });
  return {
    descriptor,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    ctimeNanoseconds: stat.ctimeNs.toString(),
    mtimeNanoseconds: stat.mtimeNs.toString(),
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function docker(args: string[], allowFailure = false, environment: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    env: environment,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`docker command failed with exit code ${result.status ?? -1}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

async function waitForDatabase(url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function runMigrationsThrough(pool: pg.Pool, maximumVersion: number): Promise<void> {
  const files = readdirSync(migrationDirectory)
    .filter((file) => /^(\d+)_([a-z0-9_]+)\.sql$/u.test(file))
    .filter((file) => Number(file.slice(0, file.indexOf("_"))) <= maximumVersion)
    .sort();
  for (const file of files) {
    const source = readFileSync(join(migrationDirectory, file), "utf8");
    const checksum = createHash("sha256").update(source, "utf8").digest("hex");
    const executable = source.replace(
      /^begin;\s/iu,
      "begin;\n\nselect pg_advisory_xact_lock_shared(1646705664);\n\n",
    ).replaceAll("__AGENT_BRIDGE_MIGRATION_CHECKSUM__", checksum);
    await pool.query(executable);
  }
}

async function startDatabase(
  name: string,
  image: string,
  port: number,
  user: string,
  directory: string,
): Promise<string> {
  const environmentFile = join(directory, `${name}.env`);
  writeFileSync(environmentFile, [
    `POSTGRES_DB=agent_bridge`,
    `POSTGRES_USER=${user}`,
    `POSTGRES_PASSWORD=${password}`,
    "",
  ].join("\n"), { mode: 0o600 });
  chmodSync(environmentFile, 0o600);
  docker([
    "run", "--rm", "--detach", "--name", name,
    "--env-file", environmentFile,
    "--publish", `127.0.0.1:${port}:${port}`,
    image, "-p", String(port),
  ]);
  residues.add(`container:${name}`);
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/agent_bridge`;
  await waitForDatabase(url);
  return url;
}

function dockerToolDependencies(
  image: string,
  databaseContainer: string,
  stagingDirectory: string,
): Pick<PostgresNativeDrDependencies, "resolveTool" | "runTool"> {
  return {
    resolveTool: (tool) => tool,
    runTool: async (command, args, environment, inputFileDescriptor): Promise<PostgresDrToolResult> => {
      const forwarded = Object.keys(environment).sort().flatMap((name) => ["--env", name]);
      const result = spawnSync("docker", [
        "run", "--rm",
        ...(inputFileDescriptor === undefined ? [] : ["--interactive"]),
        "--network", `container:${databaseContainer}`,
        "--volume", `${stagingDirectory}:${stagingDirectory}`,
        ...forwarded,
        image,
        command,
        ...args,
      ], {
        encoding: "utf8",
        env: { ...process.env, ...environment },
        stdio: [inputFileDescriptor ?? "ignore", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? -1 };
    },
  };
}

const allMajors = [
  { major: 15, image: "postgres:15", port: 55_515 },
  { major: 16, image: "postgres:16-alpine", port: 55_516 },
  { major: 17, image: "postgres:17-alpine", port: 55_517 },
  { major: 18, image: "postgres:18", port: 55_518 },
] as const;
const selectedMajor = process.env.AGENT_BRIDGE_TEST_POSTGRES_MAJOR;
const matrix = selectedMajor
  ? allMajors.filter(({ major }) => String(major) === selectedMajor)
  : allMajors;

integration.each(matrix)("PostgreSQL $major native DR", ({ major, image, port }) => {
  it("roundtrips global, scoped, revoked, and grantable default ACLs", async () => {
    const directory = mkdtempSync(join(process.cwd(), `.agent-bridge-pg${major}-acl-`));
    residues.add(directory);
    const sourceName = `agent-bridge-native-dr-${major}-acl-source`;
    const targetName = `agent-bridge-native-dr-${major}-acl-target`;
    const sourceUrl = await startDatabase(sourceName, image, port, "source_admin", directory);
    const source = new pg.Client({ connectionString: sourceUrl });
    await source.connect();
    let inventory: Awaited<ReturnType<typeof collectPostgresRoleInventory>>;
    try {
      const currentSuffix = createHash("md5").update("agent_bridge").digest("hex").slice(0, 16);
      await source.query(`
        CREATE ROLE default_acl_reader NOLOGIN;
        CREATE ROLE "PUBLIC" NOLOGIN;
        CREATE ROLE agent_bridge_control_owner_${currentSuffix} NOLOGIN;
        CREATE SCHEMA agent_bridge AUTHORIZATION source_admin;
        ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC;
        ALTER DEFAULT PRIVILEGES GRANT UPDATE ON TABLES TO "PUBLIC";
        ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES REVOKE USAGE ON TYPES FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES FOR ROLE agent_bridge_control_owner_${currentSuffix}
          REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES IN SCHEMA agent_bridge REVOKE ALL PRIVILEGES ON SEQUENCES FROM source_admin;
        ALTER DEFAULT PRIVILEGES IN SCHEMA agent_bridge GRANT SELECT ON TABLES TO default_acl_reader WITH GRANT OPTION;
      `);
      await expect(collectPostgresRoleInventory(source as unknown as PostgresDrClient, "agent_bridge"))
        .rejects.toThrow(/roles\[.*\]\.name is invalid/);
      await source.query(`
        ALTER DEFAULT PRIVILEGES REVOKE UPDATE ON TABLES FROM "PUBLIC";
        DROP ROLE "PUBLIC";
      `);
      inventory = await collectPostgresRoleInventory(source as unknown as PostgresDrClient, "agent_bridge");
      expect(inventory.defaultAcls.some((acl) => acl.grants.some((grant) => grant.granteeKind === "public"))).toBe(true);
      expect(inventory.defaultAcls.some((acl) =>
        acl.owner === `agent_bridge_control_owner_${currentSuffix}` && acl.schema === null)).toBe(true);
    } finally {
      await source.end();
      docker(["rm", "-f", sourceName], true);
      residues.delete(`container:${sourceName}`);
    }

    const targetUrl = await startDatabase(targetName, image, port, "target_admin", directory);
    const target = new pg.Client({ connectionString: targetUrl });
    await target.connect();
    try {
      for (const statement of buildPostgresRoleShellStatements(inventory)) await target.query(statement);
      const owner = inventory.roles.find((role) => role.kind === "schema-owner")!;
      await target.query(`CREATE SCHEMA agent_bridge AUTHORIZATION "${owner.name.replaceAll('"', '""')}"`);
      await target.query("BEGIN");
      for (const statement of buildPostgresDefaultPrivilegeStatements(inventory)) await target.query(statement);
      await target.query("COMMIT");
      const restored = await collectPostgresRoleInventory(target as unknown as PostgresDrClient, "agent_bridge");
      expect(canonicalPostgresRoleInventory(restored)).toBe(canonicalPostgresRoleInventory(inventory));
    } finally {
      await target.end();
    }
  }, 240_000);

  it("backs up and restores a claimed delivery into a fresh same-name cluster", async () => {
    const directory = mkdtempSync(join(process.cwd(), `.agent-bridge-pg${major}-dr-`));
    residues.add(directory);
    const sourceName = `agent-bridge-native-dr-${major}-source`;
    const targetName = `agent-bridge-native-dr-${major}-target`;
    const sourceUrl = await startDatabase(sourceName, image, port, "source_admin", directory);
    const sourcePool = new pg.Pool({ connectionString: sourceUrl, max: 4 });
    let backup: Awaited<ReturnType<typeof backupPostgresNativeDr>>;
    let sourceGatewayAuthorityId: string;
    try {
      await runMigrationsThrough(sourcePool, 15);
      const currentSuffix = createHash("md5").update("agent_bridge").digest("hex").slice(0, 16);
      await sourcePool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE agent_bridge_control_owner_${currentSuffix}
        REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
      await runMigrations(sourcePool, migrationDirectory);
      sourceGatewayAuthorityId = (await sourcePool.query<{ authority_id: string }>(
        "SELECT authority_id::text FROM agent_bridge.gateway_authority",
      )).rows[0]!.authority_id;
      await sourcePool.query(`CREATE ROLE other_admin LOGIN SUPERUSER PASSWORD '${password}'`);
      await sourcePool.query(`CREATE DATABASE agent_bridge_other OWNER other_admin`);
      const otherSuffix = createHash("md5").update("agent_bridge_other").digest("hex").slice(0, 16);
      for (const role of [
        "runtime", "data_owner", "context_reader", "event_writer", "control_owner",
        "control_operator", "control_auditor", "archive_operator",
      ]) {
        await sourcePool.query(`CREATE ROLE agent_bridge_${role}_${otherSuffix} NOLOGIN`);
        await sourcePool.query(`GRANT agent_bridge_${role}_${otherSuffix} TO other_admin WITH ADMIN OPTION`);
      }
      const multiDatabaseReadiness = await sourcePool.query(`SELECT
        agent_bridge.security_schema_ready() AS security,
        agent_bridge.owner_control_plane_ready() AS owner,
        agent_bridge.portable_archive_ready() AS portable`);
      expect(multiDatabaseReadiness.rows).toEqual([{ security: true, owner: true, portable: true }]);
      await sourcePool.query(
        `INSERT INTO agent_bridge.workspaces(id,name) VALUES($1,$2)`,
        ["native-dr", "Native DR integration"],
      );
      const service = new BridgeService(new PostgresBridgeStore(sourcePool));
      await service.publish(
        { workspace: "native-dr", agent: "publisher" },
        { type: "work", content: `PostgreSQL ${major} native DR`, targets: ["worker"] },
      );
      expect(await service.claim({ workspace: "native-dr", agent: "worker" })).not.toBeNull();
      backup = await backupPostgresNativeDr({
        stagingDirectory: directory,
        environment: { AGENT_BRIDGE_DR_SOURCE_DATABASE_URL: sourceUrl },
        dependencies: dockerToolDependencies(image, sourceName, directory),
      });
      expect(backup.schema.serverMajor).toBe(major);
      expect(backup.schema.claimedDeliveryCount).toBe("1");
      expect(readFileSync(backup.entries[1].path, "utf8")).not.toContain(`_${otherSuffix}`);
      expect(JSON.parse(readFileSync(backup.entries[1].path, "utf8")).defaultAcls).toEqual(
        expect.arrayContaining([expect.objectContaining({
          owner: `agent_bridge_control_owner_${currentSuffix}`,
          schema: null,
          objectType: "f",
        })]),
      );
    } finally {
      await sourcePool.end();
      docker(["rm", "-f", sourceName], true);
      residues.delete(`container:${sourceName}`);
    }

    const targetUrl = await startDatabase(targetName, image, port, "target_admin", directory);
    let restored: Awaited<ReturnType<typeof restorePostgresNativeDr>>;
    try {
      const artifactAnchors = {
        dump: anchorFor(backup.entries[0].path),
        roles: anchorFor(backup.entries[1].path),
      };
      const targetToolDependencies = dockerToolDependencies(image, targetName, directory);
      const verifiedArtifacts = await verifyPostgresNativeDrArtifacts({
        dumpPath: backup.entries[0].path,
        rolesPath: backup.entries[1].path,
        schema: backup.schema,
        artifactAnchors,
        dependencies: targetToolDependencies,
      });
      restored = await restorePostgresNativeDr({
        dumpPath: backup.entries[0].path,
        rolesPath: backup.entries[1].path,
        schema: backup.schema,
        artifactAnchors: verifiedArtifacts.artifactAnchors,
        acceptSourceSqlRisk: true,
        environment: { AGENT_BRIDGE_DR_TARGET_DATABASE_URL: targetUrl },
        dependencies: targetToolDependencies,
      });
    } catch (error) {
      if (process.env.AGENT_BRIDGE_KEEP_FAILED_DR === "1") {
        residues.delete(`container:${targetName}`);
        residues.delete(directory);
      }
      throw error;
    }
    expect(restored.normalizedClaimedDeliveries).toBe("1");
    const targetPool = new pg.Pool({ connectionString: targetUrl, max: 1 });
    try {
      const deliveries = await targetPool.query<{ state: string }>(
        `SELECT state FROM agent_bridge.deliveries`,
      );
      expect(deliveries.rows).toEqual([{ state: "retrying" }]);
      const events = await targetPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM agent_bridge.delivery_events WHERE action='lease_expired'`,
      );
      expect(events.rows[0]?.count).toBe("1");
      const excluded = await targetPool.query<{ count: string }>(`
        SELECT (
          (SELECT count(*) FROM agent_bridge.agent_instances)
          +(SELECT count(*) FROM agent_bridge.rate_limit_buckets)
          +(SELECT count(*) FROM agent_bridge.request_authorities)
          +(SELECT count(*) FROM agent_bridge.archive_transaction_authorizations)
        )::text AS count`);
      expect(excluded.rows[0]?.count).toBe("0");
      expect((await targetPool.query<{ authority_id: string }>(
        "SELECT authority_id::text FROM agent_bridge.gateway_authority",
      )).rows[0]!.authority_id).toBe(sourceGatewayAuthorityId);
      const external = await targetPool.query<{ rolcanlogin: boolean }>(
        `SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname='source_admin'`,
      );
      expect(external.rows).toEqual([{ rolcanlogin: false }]);
    } finally {
      await targetPool.end();
    }
  }, 240_000);

  it("refuses native DR backup when gateway authority trigger, catalog, or ACLs drift", async () => {
    const directory = mkdtempSync(join(process.cwd(), `.agent-bridge-pg${major}-dr-readiness-`));
    residues.add(directory);
    const sourceName = `agent-bridge-native-dr-${major}-readiness`;
    const sourceUrl = await startDatabase(sourceName, image, port, "source_admin", directory);
    const source = new pg.Pool({ connectionString: sourceUrl, max: 2 });
    try {
      await runMigrations(source, migrationDirectory);
      const suffix = createHash("md5").update("agent_bridge").digest("hex").slice(0, 16);
      const runtimeRole = `agent_bridge_runtime_${suffix}`;
      const drifts = [
        {
          apply: "ALTER TABLE agent_bridge.gateway_authority DISABLE TRIGGER gateway_authority_immutable",
          undo: "ALTER TABLE agent_bridge.gateway_authority ENABLE TRIGGER gateway_authority_immutable",
        },
        {
          apply: `ALTER TABLE agent_bridge.gateway_authority
            RENAME CONSTRAINT gateway_authority_id_unique TO gateway_authority_id_unique_drifted`,
          undo: `ALTER TABLE agent_bridge.gateway_authority
            RENAME CONSTRAINT gateway_authority_id_unique_drifted TO gateway_authority_id_unique`,
        },
        {
          apply: `GRANT SELECT ON agent_bridge.gateway_authority TO ${runtimeRole}`,
          undo: `REVOKE SELECT ON agent_bridge.gateway_authority FROM ${runtimeRole}`,
        },
      ];
      for (const drift of drifts) {
        await source.query(drift.apply);
        await expect(backupPostgresNativeDr({
          stagingDirectory: directory,
          environment: { AGENT_BRIDGE_DR_SOURCE_DATABASE_URL: sourceUrl },
          dependencies: dockerToolDependencies(image, sourceName, directory),
        })).rejects.toMatchObject({ code: "SOURCE_NOT_READY" });
        await source.query(drift.undo);
      }
    } finally {
      await source.end();
      docker(["rm", "-f", sourceName], true);
      residues.delete(`container:${sourceName}`);
    }
  }, 240_000);

  it("roundtrips through the public DR CLI handoff", async () => {
    const directory = mkdtempSync(join(process.cwd(), `.agent-bridge-pg${major}-cli-`));
    residues.add(directory);
    const sourceName = `agent-bridge-native-dr-${major}-cli-source`;
    const targetName = `agent-bridge-native-dr-${major}-cli-target`;
    const sourceUrl = await startDatabase(sourceName, image, port, "source_admin", directory);
    const sourcePool = new pg.Pool({ connectionString: sourceUrl, max: 4 });
    const bundle = join(directory, "native-dr.abdr");
    const backupId = `018f4a70-0000-7000-8000-${String(major).padStart(12, "0")}`;
    const requestId = `018f4a70-0000-7000-9000-${String(major).padStart(12, "0")}`;
    const sourceTools = dockerToolDependencies(image, sourceName, directory);
    try {
      await runMigrations(sourcePool, migrationDirectory);
      await sourcePool.query(`INSERT INTO agent_bridge.workspaces(id,name) VALUES($1,$2)`, ["native-dr-cli", "CLI native DR"]);
      const service = new BridgeService(new PostgresBridgeStore(sourcePool));
      await service.publish(
        { workspace: "native-dr-cli", agent: "publisher" },
        { type: "work", content: `PostgreSQL ${major} CLI native DR`, targets: ["worker"] },
      );
      expect(await service.claim({ workspace: "native-dr-cli", agent: "worker" })).not.toBeNull();
      const backedUp = await runDrCommand([
        "backup", "--provider", "postgres", "--output", bundle, "--backup-id", backupId,
      ], {
        environment: { AGENT_BRIDGE_DR_SOURCE_DATABASE_URL: sourceUrl },
        backupPostgres: (options) => backupPostgresNativeDr({ ...options, dependencies: sourceTools }),
        verifyPostgres: (options) => verifyPostgresNativeDrArtifacts({ ...options, dependencies: sourceTools }),
      });
      expect(backedUp).toMatchObject({ status: "ok", provider: "postgres", backupId });
      const verified = await runDrCommand(["verify", "--provider", "postgres", "--bundle", bundle], {
        verifyPostgres: (options) => verifyPostgresNativeDrArtifacts({ ...options, dependencies: sourceTools }),
      });
      expect(verified).toMatchObject({ status: "ok", provider: "postgres", backupId });
    } finally {
      await sourcePool.end();
      docker(["rm", "-f", sourceName], true);
      residues.delete(`container:${sourceName}`);
    }

    const targetUrl = await startDatabase(targetName, image, port, "target_admin", directory);
    const targetTools = dockerToolDependencies(image, targetName, directory);
    const restored = await runDrCommand([
      "restore", "--provider", "postgres", "--bundle", bundle, "--request-id", requestId,
      "--accept-source-sql-risk",
    ], {
      environment: { AGENT_BRIDGE_DR_TARGET_DATABASE_URL: targetUrl },
      restorePostgres: (options) => restorePostgresNativeDr({ ...options, dependencies: targetTools }),
    });
    expect(restored).toMatchObject({
      status: "ok", provider: "postgres", backupId, requestId, normalizedClaimedDeliveries: "1",
    });
    const targetPool = new pg.Pool({ connectionString: targetUrl, max: 1 });
    try {
      const deliveries = await targetPool.query<{ state: string }>("SELECT state FROM agent_bridge.deliveries");
      expect(deliveries.rows).toEqual([{ state: "retrying" }]);
    } finally { await targetPool.end(); }
  }, 240_000);
});
