import {
  chmodSync, closeSync, constants, fstatSync, openSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBoundedToolOutput } from "../src/bounded-tool-output.js";
import {
  buildPgDumpArgs,
  buildPgRestoreArgs,
  buildPostgresDefaultPrivilegeStatements,
  assertPostgresRestoreAuthority,
  buildPostgresMembershipStatements,
  buildPostgresRoleShellStatements,
  backupPostgresNativeDr,
  canonicalPostgresRoleInventory,
  createPostgresDrLibpqFiles,
  parsePostgresToolMajor,
  POSTGRES_NATIVE_DR_EXCLUDED_DATA_TABLES,
  PostgresNativeDrError,
  restorePostgresNativeDr,
  type PostgresDrClient,
  type PostgresNativeDrArtifactAnchor,
  type PostgresNativeDrDependencies,
  validatePostgresDumpToc,
  validatePostgresRoleInventory,
  verifyPostgresNativeDrArtifacts,
} from "../src/postgres-native-dr.js";
import { canonicalJson } from "../src/portable-archive-format.js";
import { privateTestDirectory, secureTestFile } from "./private-test-path.js";

const directories: string[] = [];
const descriptors: number[] = [];
function pgDirectory(): string {
  const path = privateTestDirectory("agent-bridge-pg-dr-");
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const descriptor of descriptors.splice(0)) closeSync(descriptor);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function anchorFor(path: string): PostgresNativeDrArtifactAnchor {
  const descriptor = openSync(path, constants.O_RDONLY);
  descriptors.push(descriptor);
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

describe("PostgreSQL native DR process boundary", () => {
  it("captures exactly 16 MiB without truncation", () => {
    const limit = 16 * 1024 * 1024;
    const capture = createBoundedToolOutput(limit);
    capture.push(Buffer.alloc(limit, 0x61));
    const result = capture.read();
    expect(result.bytes).toHaveLength(limit);
    expect(result.truncated).toBe(false);
  });

  it("marks a 16 MiB plus one byte output as truncated", () => {
    const limit = 16 * 1024 * 1024;
    const capture = createBoundedToolOutput(limit);
    capture.push(Buffer.alloc(limit + 1, 0x62));
    const result = capture.read();
    expect(result.bytes).toHaveLength(limit);
    expect(result.truncated).toBe(true);
  });

  it("tracks multi-chunk stdout and stderr capture independently", () => {
    const stdout = createBoundedToolOutput(4);
    const stderr = createBoundedToolOutput(4);
    stdout.push(Buffer.from("ab"));
    stderr.push(Buffer.from("12"));
    stdout.push(Buffer.from("cde"));
    stderr.push(Buffer.from("34"));
    expect(stdout.read()).toEqual({ bytes: Buffer.from("abcd"), truncated: true });
    expect(stderr.read()).toEqual({ bytes: Buffer.from("1234"), truncated: false });
  });

  it("keeps credentials out of child arguments and the inherited environment", () => {
    const directory = pgDirectory();
    const databaseUrl = new URL(
      "postgresql://db.example:6543/agent_bridge?sslmode=verify-full&sslrootcert=%2Fprivate%2Froot.crt",
    );
    databaseUrl.username = "dr-user";
    databaseUrl.password = "s3cr:et";
    const files = createPostgresDrLibpqFiles(databaseUrl.toString(), directory);
    const args = buildPgDumpArgs("/private/stage.dump", "00000001-00000001-1", files.serviceName);
    const serialized = JSON.stringify({ args, env: files.environment });
    expect(serialized).not.toContain("s3cr:et");
    expect(serialized).not.toContain("postgresql://");
    expect(args).toContain("--dbname=service=agent_bridge_dr");
    expect(readFileSync(files.passFile, "utf8")).toContain("s3cr\\:et");
    expect(readFileSync(files.serviceFile, "utf8")).toContain("sslmode=verify-full");
    expect(Object.keys(files.environment).sort()).toEqual([
      "LC_ALL", "PGAPPNAME", "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE",
    ]);
  });

  it("rejects connection parameters outside the SSL allowlist", () => {
    const directory = pgDirectory();
    const databaseUrl = new URL(
      "postgresql://db.example/agent_bridge?options=-c%20search_path%3Dpublic",
    );
    databaseUrl.username = "dr-user";
    databaseUrl.password = "secret";
    expect(() => createPostgresDrLibpqFiles(databaseUrl.toString(), directory))
      .toThrow(/unsupported PostgreSQL connection parameter/);
  });

  it("normalizes IPv6 brackets while preserving service values and escaping pgpass fields", () => {
    const directory = pgDirectory();
    const databaseUrl = new URL(
      "postgresql://[2001:db8::1]:5432/db%3Aname?sslrootcert=C%3A%5Ccerts%5C%23root.crt",
    );
    databaseUrl.username = "user:name";
    databaseUrl.password = "p:\\word";
    const files = createPostgresDrLibpqFiles(databaseUrl.toString(), directory);
    const service = readFileSync(files.serviceFile, "utf8");
    const pass = readFileSync(files.passFile, "utf8");
    expect(service).toContain("host=2001:db8::1\n");
    expect(service).toContain("sslrootcert=C:\\certs\\#root.crt\n");
    expect(pass).toContain("2001\\:db8\\:\\:1:5432:db\\:name:user\\:name:p\\:\\\\word");
  });

  it("builds a fenced custom dump with ephemeral table data excluded", () => {
    expect(buildPgDumpArgs("/private/stage.dump", "00000001-00000001-1", "agent_bridge_dr")).toEqual([
      "--format=custom",
      "--file=/private/stage.dump",
      "--schema=agent_bridge",
      "--no-tablespaces",
      "--snapshot=00000001-00000001-1",
      "--exclude-table-data=agent_bridge.agent_instances",
      "--exclude-table-data=agent_bridge.rate_limit_buckets",
      "--exclude-table-data=agent_bridge.request_authorities",
      "--exclude-table-data=agent_bridge.archive_transaction_authorizations",
      "--dbname=service=agent_bridge_dr",
    ]);
  });

  it("restores in one transaction without dropping schemas or suppressing ownership", () => {
    expect(buildPgRestoreArgs("/private/stage.dump", "agent_bridge_dr")).toEqual([
      "--exit-on-error", "--single-transaction", "--no-tablespaces",
      "--schema=agent_bridge",
      "--dbname=service=agent_bridge_dr", "/private/stage.dump",
    ]);
  });

  it("requires an exact supported PostgreSQL tool major", () => {
    expect(parsePostgresToolMajor("pg_dump (PostgreSQL) 17.5")).toBe(17);
    expect(() => parsePostgresToolMajor("not postgres")).toThrow(/version/);
  });

  it("accepts tab-separated PostgreSQL TOC fields", () => {
    expect(() => validatePostgresDumpToc(
      "1;\t2615\t1\tSCHEMA - agent_bridge owner\n",
    )).not.toThrow();
  });

  it("rejects adversarial TOC records with long numeric prefixes", () => {
    const record = `${"9".repeat(2 * 1024 * 1024)}; 2615 1`;
    expect(() => validatePostgresDumpToc(record)).toThrowError(expect.objectContaining({
      code: "PG_DUMP_TOC_INVALID",
    }));
  });

  it("rejects adversarial TOC records with long separators", () => {
    const record = `1; ${" ".repeat(2 * 1024 * 1024)}x`;
    expect(() => validatePostgresDumpToc(record)).toThrowError(expect.objectContaining({
      code: "PG_DUMP_TOC_INVALID",
    }));
  });
});

class FakePostgresDrClient implements PostgresDrClient {
  readonly statements: Array<{ sql: string; values?: unknown[] }> = [];
  constructor(private readonly answer: (sql: string, values?: unknown[]) => unknown[]) {}
  async connect(): Promise<void> {}
  async end(): Promise<void> {}
  async query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    this.statements.push({ sql, values });
    const rows = this.answer(sql, values) as T[];
    return { rows, rowCount: rows.length };
  }
}

describe("PostgreSQL native DR role inventory", () => {
  const inventory = {
    schema: "agent-bridge.postgres-native-dr-roles",
    version: 1,
    databaseName: "agent_bridge",
    roles: [
      { name: "agent_bridge_data_owner_12fce09c58ce487d", kind: "derived" },
      { name: "agent_bridge_control_operator_12fce09c58ce487d", kind: "derived" },
      { name: "bridge_schema_owner", kind: "schema-owner" },
      { name: "external_operator", kind: "external-principal" },
    ],
    memberships: [
      { role: "agent_bridge_data_owner_12fce09c58ce487d", member: "bridge_schema_owner", adminOption: true, inheritOption: true, setOption: true },
      { role: "agent_bridge_control_operator_12fce09c58ce487d", member: "external_operator", adminOption: false, inheritOption: true, setOption: true },
    ],
    defaultAcls: [
      { owner: "bridge_schema_owner", schema: null, objectType: "f", grants: [
        { grantor: "bridge_schema_owner", granteeKind: "public", privilege: "EXECUTE", grantable: false },
      ] },
      { owner: "bridge_schema_owner", schema: "agent_bridge", objectType: "r", grants: [
        { grantor: "bridge_schema_owner", granteeKind: "role", grantee: "agent_bridge_data_owner_12fce09c58ce487d", privilege: "SELECT", grantable: true },
      ] },
    ],
  } as const;

  it("canonicalizes a bounded roles.json without credential or role-setting fields", () => {
    const validated = validatePostgresRoleInventory(inventory);
    const text = canonicalPostgresRoleInventory(validated);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toMatch(/password|setting|login/i);
    expect(JSON.parse(text)).toEqual(validated);
  });

  it("creates every restore shell as NOLOGIN with no elevated attributes", () => {
    const statements = buildPostgresRoleShellStatements(validatePostgresRoleInventory(inventory));
    expect(statements).toHaveLength(4);
    expect(statements.every((sql) => sql.includes("NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"))).toBe(true);
    expect(statements.join("\n")).not.toContain("PASSWORD");
  });

  it("preserves PostgreSQL 16 membership options and maps PostgreSQL 15 explicitly", () => {
    const validated = validatePostgresRoleInventory(inventory);
    const pg16 = buildPostgresMembershipStatements(validated, 16).find((sql) => sql.includes("bridge_schema_owner"));
    const pg15 = buildPostgresMembershipStatements(validated, 15).find((sql) => sql.includes("bridge_schema_owner"));
    expect(pg16).toContain("WITH ADMIN OPTION, INHERIT TRUE, SET TRUE");
    expect(pg15).toContain("WITH ADMIN OPTION");
    expect(pg15).not.toContain("INHERIT TRUE");
    expect(() => buildPostgresMembershipStatements(validatePostgresRoleInventory({
      ...inventory,
      memberships: [{ ...inventory.memberships[0], inheritOption: false }],
    }), 15)).toThrow(/PostgreSQL 15 cannot preserve/);
  });

  it("restores global and schema-scoped default privileges without credentials", () => {
    const statements = buildPostgresDefaultPrivilegeStatements(validatePostgresRoleInventory(inventory));
    expect(statements).toEqual([
      'SET LOCAL ROLE "bridge_schema_owner"; ALTER DEFAULT PRIVILEGES FOR ROLE "bridge_schema_owner" REVOKE ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE "bridge_schema_owner" REVOKE ALL PRIVILEGES ON FUNCTIONS FROM "bridge_schema_owner"; ALTER DEFAULT PRIVILEGES FOR ROLE "bridge_schema_owner" GRANT EXECUTE ON FUNCTIONS TO PUBLIC; RESET ROLE;',
      'SET LOCAL ROLE "bridge_schema_owner"; ALTER DEFAULT PRIVILEGES FOR ROLE "bridge_schema_owner" IN SCHEMA "agent_bridge" REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE "bridge_schema_owner" IN SCHEMA "agent_bridge" REVOKE ALL PRIVILEGES ON TABLES FROM "bridge_schema_owner"; ALTER DEFAULT PRIVILEGES FOR ROLE "bridge_schema_owner" IN SCHEMA "agent_bridge" GRANT SELECT ON TABLES TO "agent_bridge_data_owner_12fce09c58ce487d" WITH GRANT OPTION; RESET ROLE;',
    ]);
  });

  it("preserves an empty default ACL and explicit PUBLIC revocation", () => {
    const empty = validatePostgresRoleInventory({
      ...inventory,
      defaultAcls: [{ owner: "bridge_schema_owner", schema: null, objectType: "f", grants: [] }],
    });
    expect(buildPostgresDefaultPrivilegeStatements(empty)).toEqual([
      'SET LOCAL ROLE "bridge_schema_owner"; ALTER DEFAULT PRIVILEGES FOR ROLE "bridge_schema_owner" REVOKE ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE "bridge_schema_owner" REVOKE ALL PRIVILEGES ON FUNCTIONS FROM "bridge_schema_owner"; RESET ROLE;',
    ]);
  });

  it("rejects reserved and delimiter-bearing role names before restore", () => {
    expect(() => validatePostgresRoleInventory({
      ...inventory,
      roles: [...inventory.roles, { name: "PUBLIC", kind: "object-role" }],
      defaultAcls: [{ owner: "bridge_schema_owner", schema: null, objectType: "r", grants: [
        { grantor: "bridge_schema_owner", granteeKind: "role", grantee: "PUBLIC", privilege: "UPDATE", grantable: false },
      ] }],
    })).toThrow(/roles\[4\].name is invalid/);
    expect(() => validatePostgresRoleInventory({
      ...inventory,
      roles: [...inventory.roles, { name: "role:with:delimiter", kind: "object-role" }],
    })).toThrow(/name is invalid/);
  });

  it("rejects out-of-scope default ACLs and unsupported distinct grantors", () => {
    expect(() => validatePostgresRoleInventory({
      ...inventory,
      defaultAcls: [{ owner: "bridge_schema_owner", schema: "public", objectType: "r", grants: [] }],
    })).toThrow(/outside Agent Bridge/);
    expect(() => validatePostgresRoleInventory({
      ...inventory,
      defaultAcls: [{ owner: "bridge_schema_owner", schema: null, objectType: "T", grants: [{
        grantor: "external_operator", granteeKind: "public", privilege: "USAGE", grantable: false,
      }] }],
    })).toThrow(/grantor distinct/);
  });

  it("rejects unknown fields and membership references outside the inventory", () => {
    expect(() => validatePostgresRoleInventory({ ...inventory, password: "secret" })).toThrow(/unexpected/);
    expect(() => validatePostgresRoleInventory({
      ...inventory,
      memberships: [{ role: "missing", member: "external_operator", adminOption: false, inheritOption: true, setOption: true }],
    })).toThrow(/membership/);
  });
});

describe("PostgreSQL native DR orchestration", () => {
  const migration = { version: 16, name: "native_dr_fence", checksum: "a".repeat(64) };
  const tableNames = [
    "deliveries", "delivery_events", "agent_instances", "rate_limit_buckets",
    "request_authorities", "archive_transaction_authorizations",
  ];
  const roleInventory = validatePostgresRoleInventory({
    schema: "agent-bridge.postgres-native-dr-roles",
    version: 1,
    databaseName: "agent_bridge",
    roles: [{ name: "agent_bridge_data_owner_12fce09c58ce487d", kind: "schema-owner" }],
    memberships: [],
    defaultAcls: [],
  });
  const schemaFor = (rolesText: string) => ({
    databaseName: "agent_bridge",
    serverVersionNum: 170005,
    serverMajor: 17,
    schemaVersion: 16,
    migrations: [migration],
    tableCounts: {
      "agent_bridge.deliveries": "2",
      "agent_bridge.delivery_events": "3",
      "agent_bridge.agent_instances": "9",
      "agent_bridge.rate_limit_buckets": "8",
      "agent_bridge.request_authorities": "7",
      "agent_bridge.archive_transaction_authorizations": "6",
    },
    excludedDataTables: [...POSTGRES_NATIVE_DR_EXCLUDED_DATA_TABLES],
    claimedDeliveryCount: "1",
    pgDumpVersion: "pg_dump (PostgreSQL) 17.5",
    roleInventorySha256: createHash("sha256").update(rolesText).digest("hex"),
    readinessAttestations: {
      securitySchemaSha256: createHash("sha256").update("security").digest("hex"),
      rowIsolationSha256: createHash("sha256").update("row").digest("hex"),
      ownerControlSha256: createHash("sha256").update("owner").digest("hex"),
      portableArchiveSha256: createHash("sha256").update("archive").digest("hex"),
    },
  });
  const anchorsFor = (dumpPath: string, rolesPath: string) => ({
    dump: anchorFor(dumpPath),
    roles: anchorFor(rolesPath),
  });
  const verificationDependencies: Partial<PostgresNativeDrDependencies> = {
    resolveTool: (tool) => `/tools/${tool}`,
    runTool: async (command, args) => {
      if (args[0] === "--version") {
        return { stdout: `${command.includes("dump") ? "pg_dump" : "pg_restore"} (PostgreSQL) 17.5\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "1; 2615 1 SCHEMA - agent_bridge owner\n2; 0 0 ACL - SCHEMA agent_bridge owner\n", stderr: "", exitCode: 0 };
    },
  };

  it("seals canonical PostgreSQL artifacts and detects in-place dump replacement", async () => {
    const directory = pgDirectory();
    const dumpPath = join(directory, "database.dump");
    const rolesPath = join(directory, "roles.json");
    const rolesText = canonicalPostgresRoleInventory(roleInventory);
    writeFileSync(dumpPath, "custom dump", { mode: 0o600 });
    writeFileSync(rolesPath, rolesText, { mode: 0o600 });
    secureTestFile(dumpPath); secureTestFile(rolesPath);
    const artifactAnchors = anchorsFor(dumpPath, rolesPath);
    const toolInputs: Array<{ args: string[]; inputFileDescriptor?: number }> = [];
    const verified = await verifyPostgresNativeDrArtifacts({
      dumpPath,
      rolesPath,
      schema: schemaFor(rolesText),
      artifactAnchors,
      dependencies: {
        ...verificationDependencies,
        runTool: async (command, args, _environment, inputFileDescriptor) => {
          toolInputs.push({ args, inputFileDescriptor });
          if (args[0] === "--version") {
            return { stdout: `${command.includes("dump") ? "pg_dump" : "pg_restore"} (PostgreSQL) 17.5\n`, stderr: "", exitCode: 0 };
          }
          return { stdout: "1; 2615 1 SCHEMA - agent_bridge owner\n2; 0 0 ACL - SCHEMA agent_bridge owner\n", stderr: "", exitCode: 0 };
        },
      },
    });
    expect(verified.roleInventory).toEqual(roleInventory);
    expect(toolInputs).toHaveLength(2);
    expect(toolInputs[0]).toEqual({ args: ["--version"], inputFileDescriptor: undefined });
    expect(toolInputs[1]?.args).toEqual(["--list"]);
    expect(toolInputs[1]?.inputFileDescriptor).toEqual(expect.any(Number));
    expect(toolInputs.some(({ args }) => args.includes(dumpPath))).toBe(false);
    writeFileSync(dumpPath, "replaced dump", { mode: 0o600 });
    await expect(verifyPostgresNativeDrArtifacts({
      dumpPath,
      rolesPath,
      schema: schemaFor(rolesText),
      artifactAnchors: verified.artifactAnchors,
      dependencies: verificationDependencies,
    })).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_MISMATCH" });
  });

  it("rejects a forbidden TOC entry beyond the former 1 MiB capture boundary", async () => {
    const directory = pgDirectory();
    const dumpPath = join(directory, "database.dump");
    const rolesPath = join(directory, "roles.json");
    const rolesText = canonicalPostgresRoleInventory(roleInventory);
    writeFileSync(dumpPath, "custom dump", { mode: 0o600 });
    writeFileSync(rolesPath, rolesText, { mode: 0o600 });
    secureTestFile(dumpPath); secureTestFile(rolesPath);
    const validEntry = "3; 1259 1 TABLE agent_bridge messages owner\n";
    const validPrefix = "1; 2615 1 SCHEMA - agent_bridge owner\n2; 0 0 ACL - SCHEMA agent_bridge owner\n"
      + validEntry.repeat(Math.ceil((1024 * 1024) / Buffer.byteLength(validEntry)));
    await expect(verifyPostgresNativeDrArtifacts({
      dumpPath,
      rolesPath,
      schema: schemaFor(rolesText),
      artifactAnchors: anchorsFor(dumpPath, rolesPath),
      dependencies: {
        ...verificationDependencies,
        runTool: async (command, args) => args[0] === "--version"
          ? { stdout: `${command.includes("dump") ? "pg_dump" : "pg_restore"} (PostgreSQL) 17.5\n`, stderr: "", exitCode: 0 }
          : { stdout: `${validPrefix}4; 1259 2 TABLE public injected owner\n`, stderr: "", exitCode: 0 },
      },
    })).rejects.toMatchObject({ code: "PG_DUMP_TOC_OUT_OF_SCOPE" });
  });

  it("rejects an explicitly truncated TOC before validating its prefix", async () => {
    const directory = pgDirectory();
    const dumpPath = join(directory, "database.dump");
    const rolesPath = join(directory, "roles.json");
    const rolesText = canonicalPostgresRoleInventory(roleInventory);
    writeFileSync(dumpPath, "custom dump", { mode: 0o600 });
    writeFileSync(rolesPath, rolesText, { mode: 0o600 });
    secureTestFile(dumpPath); secureTestFile(rolesPath);
    await expect(verifyPostgresNativeDrArtifacts({
      dumpPath,
      rolesPath,
      schema: schemaFor(rolesText),
      artifactAnchors: anchorsFor(dumpPath, rolesPath),
      dependencies: {
        ...verificationDependencies,
        runTool: async (command, args) => args[0] === "--version"
          ? { stdout: `${command.includes("dump") ? "pg_dump" : "pg_restore"} (PostgreSQL) 17.5\n`, stderr: "", exitCode: 0 }
          : {
              stdout: "1; 2615 1 SCHEMA - agent_bridge owner\n2; 0 0 ACL - SCHEMA agent_bridge owner\n",
              stderr: "",
              exitCode: 0,
              stdoutTruncated: true,
            },
      },
    })).rejects.toMatchObject({ code: "PG_DUMP_TOC_TRUNCATED" });
  });

  it("rejects a non-superuser even when lesser restore authorities may be available", async () => {
    const client = new FakePostgresDrClient((sql) => sql.includes("rolsuper AS") ? [{ isSuperuser: false }] : []);
    await expect(assertPostgresRestoreAuthority(client)).rejects.toMatchObject({ code: "TARGET_AUTHORITY_INSUFFICIENT" });
  });

  it("fails immediately when another restore holds the target fence", async () => {
    const directory = pgDirectory();
    const dumpPath = join(directory, "database.dump");
    const rolesPath = join(directory, "roles.json");
    const rolesText = canonicalPostgresRoleInventory(roleInventory);
    writeFileSync(dumpPath, "custom dump", { mode: 0o600 });
    writeFileSync(rolesPath, rolesText, { mode: 0o600 });
    secureTestFile(dumpPath); secureTestFile(rolesPath);
    const target = new FakePostgresDrClient((sql) => sql.includes("pg_try_advisory_lock") ? [{ acquired: false }] : []);
    const schema = schemaFor(rolesText);
    await expect(restorePostgresNativeDr({
      dumpPath, rolesPath, schema, artifactAnchors: anchorsFor(dumpPath, rolesPath), acceptSourceSqlRisk: true,
      environment: { AGENT_BRIDGE_DR_TARGET_DATABASE_URL: "postgresql://target:secret@localhost/agent_bridge" },
      dependencies: { ...verificationDependencies, createClient: () => target },
    })).rejects.toMatchObject({
      code: "RESTORE_IN_PROGRESS",
      details: { targetMutated: false, restoreCompleted: false },
    });
    expect(target.statements.some(({ sql }) => sql.startsWith("CREATE ROLE"))).toBe(false);
  });

  it("preserves restore failure details when credential cleanup also fails", async () => {
    const directory = pgDirectory();
    const dumpPath = join(directory, "database.dump");
    const rolesPath = join(directory, "roles.json");
    const rolesText = canonicalPostgresRoleInventory(roleInventory);
    writeFileSync(dumpPath, "custom dump", { mode: 0o600 });
    writeFileSync(rolesPath, rolesText, { mode: 0o600 });
    secureTestFile(dumpPath); secureTestFile(rolesPath);
    const target = new FakePostgresDrClient((sql) => sql.includes("pg_try_advisory_lock") ? [{ acquired: false }] : []);
    const schema = schemaFor(rolesText);
    await expect(restorePostgresNativeDr({
      dumpPath, rolesPath, schema, artifactAnchors: anchorsFor(dumpPath, rolesPath), acceptSourceSqlRisk: true,
      environment: { AGENT_BRIDGE_DR_TARGET_DATABASE_URL: "postgresql://target:secret@localhost/agent_bridge" },
      dependencies: {
        ...verificationDependencies,
        createClient: () => target,
        removePath: () => { throw new Error("injected cleanup failure"); },
      },
    })).rejects.toMatchObject({
      code: "CREDENTIAL_CLEANUP_FAILED",
      details: {
        causeCode: "RESTORE_IN_PROGRESS",
        targetMutated: false,
        restoreCompleted: false,
        recoveryPaths: [expect.stringContaining(".postgres-dr-libpq-")],
      },
    });
  });

  it("keeps a failed target offline and reports residual role shells", async () => {
    const directory = pgDirectory();
    const dumpPath = join(directory, "database.dump");
    const rolesPath = join(directory, "roles.json");
    const rolesText = canonicalPostgresRoleInventory(roleInventory);
    writeFileSync(dumpPath, "custom dump", { mode: 0o600 });
    writeFileSync(rolesPath, rolesText, { mode: 0o600 });
    secureTestFile(dumpPath); secureTestFile(rolesPath);
    const target = new FakePostgresDrClient((sql) => {
      if (sql.includes("pg_try_advisory_lock")) return [{ acquired: true }];
      if (sql.includes("to_regnamespace")) return [{ databaseName: "agent_bridge", serverVersionNum: "170005", schemaExists: false, databaseFresh: true }];
      if (sql.includes("rolsuper AS")) return [{ isSuperuser: true }];
      return [];
    });
    const admin = new FakePostgresDrClient(() => []);
    let clientIndex = 0;
    const schema = schemaFor(rolesText);
    await expect(restorePostgresNativeDr({
      dumpPath, rolesPath, schema, artifactAnchors: anchorsFor(dumpPath, rolesPath), acceptSourceSqlRisk: true,
      environment: { AGENT_BRIDGE_DR_TARGET_DATABASE_URL: "postgresql://target:secret@localhost/agent_bridge" },
      dependencies: {
        createClient: () => [target, admin][clientIndex++]!,
        resolveTool: (tool) => `/tools/${tool}`,
        runTool: async (command, args) => {
          if (args[0] === "--version") return { stdout: `${command.includes("dump") ? "pg_dump" : "pg_restore"} (PostgreSQL) 17.5\n`, stderr: "", exitCode: 0 };
          if (args[0] === "--list") return { stdout: "1; 2615 1 SCHEMA - agent_bridge owner\n2; 0 0 ACL - SCHEMA agent_bridge owner\n", stderr: "", exitCode: 0 };
          if (args.some((argument) => argument.startsWith("--use-list="))) return { stdout: "", stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "injected restore failure", exitCode: 1 };
        },
      },
    })).rejects.toMatchObject({
      code: "PG_RESTORE_FAILED",
      details: {
        residualRoleShells: ["agent_bridge_data_owner_12fce09c58ce487d"],
        targetOffline: true,
        targetMutated: true,
        restoreCompleted: false,
      },
    });
    expect(admin.statements.some(({ sql }) => sql.includes("ALLOW_CONNECTIONS false"))).toBe(true);
  });

  it("holds the fence across a snapshot dump and keeps source authority out of child calls", async () => {
    const directory = pgDirectory();
    const source = new FakePostgresDrClient((sql) => {
      if (sql.includes("pg_export_snapshot")) return [{ snapshot: "00000001-00000001-1" }];
      if (sql.includes("current_setting('server_version_num')")) return [{ databaseName: "agent_bridge", serverVersionNum: "170005" }];
      if (sql.includes("schema_migrations ORDER BY")) return [migration];
      if (sql.includes("information_schema.tables")) return tableNames.map((tableName) => ({ tableName }));
      if (sql.includes("WHERE state='claimed'")) return [{ count: "1" }];
      if (sql.includes("credential_security_prerequisite_definition")) return [{
        security: true, ownerControl: true, portableArchive: true,
        securityDefinition: "security", rowIsolationDefinition: "row",
        ownerControlDefinition: "owner", portableArchiveDefinition: "archive",
      }];
      if (sql.includes("count(*)::text")) return [{ count: sql.includes("delivery_events") ? "3" : "2" }];
      if (sql.includes("WITH derived_names")) return roleInventory.roles;
      if (sql.includes("pg_auth_members membership")) return [];
      return [];
    });
    const postInventory = new FakePostgresDrClient((sql) => {
      if (sql.includes("WITH derived_names")) return roleInventory.roles;
      if (sql.includes("pg_auth_members membership")) return [];
      return [];
    });
    const clients = [source, postInventory];
    const childCalls: Array<{ command: string; args: string[]; environment: Record<string, string> }> = [];
    const dependencies: Partial<PostgresNativeDrDependencies> = {
      createClient: () => clients.shift()!,
      resolveTool: (tool) => `/tools/${tool}`,
      runTool: async (command, args, environment) => {
        childCalls.push({ command, args, environment });
        if (args[0] === "--version") return { stdout: `${command.includes("dump") ? "pg_dump" : "pg_restore"} (PostgreSQL) 17.5\n`, stderr: "", exitCode: 0 };
        const output = args.find((argument) => argument.startsWith("--file="));
        if (output) {
          const path = output.slice("--file=".length);
          writeFileSync(path, "custom dump");
          secureTestFile(path);
        }
        return { stdout: command.includes("restore") ? "1; 2615 1 SCHEMA - agent_bridge owner\n2; 0 0 ACL - SCHEMA agent_bridge owner\n" : "", stderr: "", exitCode: 0 };
      },
      randomId: () => "00000000-0000-4000-8000-000000000001",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      checkRowIsolationReady: async () => true,
    };
    const result = await backupPostgresNativeDr({
      stagingDirectory: directory,
      environment: { AGENT_BRIDGE_DR_SOURCE_DATABASE_URL: "postgresql://source:s3cret@localhost/agent_bridge" },
      dependencies,
    });
    expect(result.schema.claimedDeliveryCount).toBe("1");
    expect(result.entries.map((entry) => entry.name)).toEqual(["postgres/database.dump", "postgres/roles.json"]);
    const dumpCall = childCalls.find((call) => call.command.endsWith("pg_dump") && call.args[0] !== "--version")!;
    expect(dumpCall.args).toContain("--snapshot=00000001-00000001-1");
    expect(JSON.stringify(childCalls)).not.toContain("s3cret");
    const lockIndex = source.statements.findIndex(({ sql }) => sql.includes("pg_advisory_lock"));
    const unlockIndex = source.statements.findIndex(({ sql }) => sql.includes("pg_advisory_unlock"));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(unlockIndex).toBeGreaterThan(lockIndex);
  });

  it("reports credential residue when backup cleanup fails", async () => {
    const directory = pgDirectory();
    const source = new FakePostgresDrClient((sql) => {
      if (sql.includes("pg_advisory_lock")) throw new PostgresNativeDrError("INJECTED_BACKUP_FAILURE", "injected");
      return [];
    });
    await expect(backupPostgresNativeDr({
      stagingDirectory: directory,
      environment: { AGENT_BRIDGE_DR_SOURCE_DATABASE_URL: "postgresql://source:secret@localhost/agent_bridge" },
      dependencies: {
        createClient: () => source,
        removePath: (path) => {
          if (path.includes(".postgres-dr-libpq-")) throw new Error("injected cleanup failure");
          rmSync(path, { recursive: true, force: true });
        },
      },
    })).rejects.toMatchObject({
      code: "CREDENTIAL_CLEANUP_FAILED",
      details: { causeCode: "INJECTED_BACKUP_FAILURE" },
    });
  });

  it("reports completed backup outputs when credential cleanup blocks publication", async () => {
    const directory = pgDirectory();
    const answer = (sql: string): unknown[] => {
      if (sql.includes("pg_export_snapshot")) return [{ snapshot: "00000001-00000001-1" }];
      if (sql.includes("current_setting('server_version_num')")) return [{ databaseName: "agent_bridge", serverVersionNum: "170005" }];
      if (sql.includes("schema_migrations ORDER BY")) return [migration];
      if (sql.includes("information_schema.tables")) return tableNames.map((tableName) => ({ tableName }));
      if (sql.includes("WHERE state='claimed'")) return [{ count: "1" }];
      if (sql.includes("credential_security_prerequisite_definition")) return [{
        security: true, ownerControl: true, portableArchive: true,
        securityDefinition: "security", rowIsolationDefinition: "row",
        ownerControlDefinition: "owner", portableArchiveDefinition: "archive",
      }];
      if (sql.includes("count(*)::text")) return [{ count: sql.includes("delivery_events") ? "3" : "2" }];
      if (sql.includes("WITH derived_names")) return roleInventory.roles;
      return [];
    };
    const clients = [new FakePostgresDrClient(answer), new FakePostgresDrClient(answer)];
    await expect(backupPostgresNativeDr({
      stagingDirectory: directory,
      environment: { AGENT_BRIDGE_DR_SOURCE_DATABASE_URL: "postgresql://source:secret@localhost/agent_bridge" },
      dependencies: {
        createClient: () => clients.shift()!,
        resolveTool: (tool) => `/tools/${tool}`,
        runTool: async (command, args) => {
          if (args[0] === "--version") return { stdout: `${command.includes("dump") ? "pg_dump" : "pg_restore"} (PostgreSQL) 17.5\n`, stderr: "", exitCode: 0 };
          const output = args.find((argument) => argument.startsWith("--file="));
          if (output) {
            const path = output.slice("--file=".length);
            writeFileSync(path, "custom dump");
            secureTestFile(path);
          }
          return { stdout: command.includes("restore") ? "1; 2615 1 SCHEMA - agent_bridge owner\n2; 0 0 ACL - SCHEMA agent_bridge owner\n" : "", stderr: "", exitCode: 0 };
        },
        randomId: () => "00000000-0000-4000-8000-000000000001",
        checkRowIsolationReady: async () => true,
        removePath: (path) => {
          if (path.includes(".postgres-dr-libpq-")) throw new Error("injected cleanup failure");
          rmSync(path, { recursive: true, force: true });
        },
      },
    })).rejects.toMatchObject({
      code: "CREDENTIAL_CLEANUP_FAILED",
      details: {
        recoveryPaths: expect.arrayContaining([
          expect.stringContaining(".postgres-dr-libpq-"),
          expect.stringContaining("postgres-database.dump"),
          expect.stringContaining("postgres-roles.json"),
        ]),
      },
    });
  });

  it("reports a completed restore when credential cleanup fails", async () => {
    const directory = pgDirectory();
    const dumpPath = join(directory, "database.dump");
    const rolesPath = join(directory, "roles.json");
    const rolesText = canonicalPostgresRoleInventory(roleInventory);
    writeFileSync(dumpPath, "custom dump", { mode: 0o600 });
    writeFileSync(rolesPath, rolesText, { mode: 0o600 });
    secureTestFile(dumpPath); secureTestFile(rolesPath);
    chmodSync(dumpPath, 0o600); chmodSync(rolesPath, 0o600);
    const targetCounts: Record<string, string> = {
      "agent_bridge.deliveries": "2",
      "agent_bridge.delivery_events": "4",
      "agent_bridge.agent_instances": "0",
      "agent_bridge.rate_limit_buckets": "0",
      "agent_bridge.request_authorities": "0",
      "agent_bridge.archive_transaction_authorizations": "0",
    };
    const target = new FakePostgresDrClient((sql) => {
      if (sql.includes("pg_try_advisory_lock")) return [{ acquired: true }];
      if (sql.includes("to_regnamespace")) return [{ databaseName: "agent_bridge", serverVersionNum: "170005", schemaExists: false, databaseFresh: true }];
      if (sql.includes("rolsuper AS")) return [{ isSuperuser: true }];
      if (sql.includes("rolname=ANY") && sql.includes("ORDER BY rolname")) return [];
      if (sql.includes("WITH changed AS")) return [{ count: "1" }];
      if (sql.includes("schema_migrations ORDER BY")) return [migration];
      if (sql.includes("information_schema.tables")) return tableNames.map((tableName) => ({ tableName }));
      if (sql.includes("count(*)::text")) {
        const name = tableNames.find((tableName) => sql.includes(`\"${tableName}\"`))!;
        return [{ count: targetCounts[`agent_bridge.${name}`] }];
      }
      if (sql.includes("security_schema_ready")) return [{
        security: true, ownerControl: true, portableArchive: true,
        securityDefinition: "security", rowIsolationDefinition: "row",
        ownerControlDefinition: "owner", portableArchiveDefinition: "archive",
      }];
      return [];
    });
    const admin = new FakePostgresDrClient(() => []);
    const schema = JSON.parse(canonicalJson(schemaFor(rolesText))) as ReturnType<typeof schemaFor>;
    const toolCalls: Array<{ command: string; args: string[]; inputFileDescriptor?: number }> = [];
    await expect(restorePostgresNativeDr({
      dumpPath, rolesPath, schema, artifactAnchors: anchorsFor(dumpPath, rolesPath), acceptSourceSqlRisk: true,
      environment: { AGENT_BRIDGE_DR_TARGET_DATABASE_URL: "postgresql://target:s3cret@localhost/agent_bridge" },
      dependencies: {
        createClient: (() => { const clients = [target, admin]; return () => clients.shift()!; })(),
        resolveTool: (tool) => `/tools/${tool}`,
        runTool: async (command, args, _environment, inputFileDescriptor) => {
          toolCalls.push({ command, args, inputFileDescriptor });
          if (args[0] === "--version") return { stdout: `${command.includes("dump") ? "pg_dump" : "pg_restore"} (PostgreSQL) 17.5\n`, stderr: "", exitCode: 0 };
          return { stdout: args[0] === "--list" ? "1; 2615 1 SCHEMA - agent_bridge owner\n2; 0 0 ACL - SCHEMA agent_bridge owner\n" : "", stderr: "", exitCode: 0 };
        },
        checkRowIsolationReady: async () => true,
        removePath: () => { throw new Error("injected cleanup failure"); },
      },
    })).rejects.toMatchObject({
      code: "CREDENTIAL_CLEANUP_FAILED",
      details: {
        targetMutated: true,
        restoreCompleted: true,
        recoveryPaths: [expect.stringContaining(".postgres-dr-libpq-")],
      },
    });
    expect(toolCalls.some(({ args }) => args.includes("--single-transaction"))).toBe(true);
    const archiveCalls = toolCalls.filter(({ args }) => args[0] !== "--version");
    expect(archiveCalls).toHaveLength(3);
    expect(archiveCalls.every(({ args }) => !args.includes(dumpPath))).toBe(true);
    expect(archiveCalls.every(({ inputFileDescriptor }) => typeof inputFileDescriptor === "number")).toBe(true);
    expect(target.statements.some(({ sql }) => sql.includes("last_action='lease_expired'"))).toBe(true);
  });
});
import { createHash } from "node:crypto";
