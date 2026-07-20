import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPostgresProductionPreflight } from "../src/postgres-production-preflight.js";

const migrationsDirectory = fileURLToPath(new URL("../sql/migrations", import.meta.url));

function authority(overrides: Record<string, unknown> = {}) {
  return {
    serverVersionNum: "160010",
    inRecovery: false,
    canLogin: true,
    inherits: true,
    isSuperuser: false,
    canCreateRole: true,
    canCreateDatabaseObject: true,
    bridgeSchema: null,
    migrationTable: null,
    legacyTable: null,
    ssl: true,
    databaseBytes: "10485760",
    ...overrides,
  };
}

class FakeDatabase {
  readonly statements: string[] = [];

  constructor(
    private readonly authorityRow: ReturnType<typeof authority>,
    private readonly migrations: Array<{ version: number; name: string; checksum: string }> = [],
    private readonly legacyRows: Array<{ columnName: string; typeName: string }> = [],
  ) {}

  async query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
    this.statements.push(sql);
    let rows: unknown[] = [];
    if (sql.includes("pg_is_in_recovery")) rows = [this.authorityRow];
    else if (sql.includes("FROM agent_bridge.schema_migrations")) rows = this.migrations;
    else if (sql.includes("WITH names(role_name)")) rows = [{ count: "0" }];
    else if (sql.includes("relation.relowner=current_user")) rows = [{ ownedByCaller: true }];
    else if (sql.includes("information_schema.columns")) rows = this.legacyRows;
    else if (sql.includes("WITH mapped AS")) rows = [{ rowCount: "7", duplicateMessageIds: "0" }];
    return { rows: rows as T[], rowCount: rows.length };
  }
}

describe("PostgreSQL production preflight", () => {
  it("accepts an uninitialized supported authority without mutating it", async () => {
    const db = new FakeDatabase(authority());

    const report = await runPostgresProductionPreflight(db, migrationsDirectory);

    expect(report.ok).toBe(true);
    expect(report.observations).toMatchObject({
      serverMajor: 16,
      migrationState: "uninitialized",
      appliedMigrationCount: 0,
      requiredMigrationCount: 19,
      legacyTable: false,
      ssl: true,
    });
    expect(db.statements[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(db.statements.at(-1)).toBe("COMMIT");
    expect(db.statements.every((sql) =>
      !/^\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE)\b/iu.test(sql)
    )).toBe(true);
  });

  it("checks the legacy import contract before migration 006", async () => {
    const columns = [
      ["id", "int8"], ["source", "text"], ["category", "text"], ["content", "text"],
      ["priority", "text"], ["project", "text"], ["metadata", "jsonb"],
      ["created_at", "timestamptz"], ["acked_by", "_text"],
    ].map(([columnName, typeName]) => ({ columnName: columnName!, typeName: typeName! }));
    const db = new FakeDatabase(authority({ legacyTable: "shared_context" }), [], columns);

    const report = await runPostgresProductionPreflight(db, migrationsDirectory);

    expect(report.ok).toBe(true);
    expect(report.observations).toMatchObject({ legacyTable: true, legacyRows: "7" });
    expect(report.checks.find((entry) => entry.name === "legacy.owner")?.ok).toBe(true);
    expect(report.checks.find((entry) => entry.name === "legacy.columns")?.ok).toBe(true);
    expect(report.checks.find((entry) => entry.name === "legacy.message_ids")?.ok).toBe(true);
  });

  it("rejects migration ledger drift", async () => {
    const db = new FakeDatabase(
      authority({ bridgeSchema: "agent_bridge", migrationTable: "agent_bridge.schema_migrations" }),
      [{ version: 1, name: "schema_state", checksum: "0".repeat(64) }],
    );

    const report = await runPostgresProductionPreflight(db, migrationsDirectory);

    expect(report.ok).toBe(false);
    expect(report.observations.migrationState).toBe("invalid");
    expect(report.checks.find((entry) => entry.name === "schema.migrations")?.ok).toBe(false);
  });

  it("rejects an existing schema with an empty migration ledger", async () => {
    const db = new FakeDatabase(
      authority({ bridgeSchema: "agent_bridge", migrationTable: "agent_bridge.schema_migrations" }),
    );

    const report = await runPostgresProductionPreflight(db, migrationsDirectory);

    expect(report.ok).toBe(false);
    expect(report.observations.migrationState).toBe("invalid");
  });

  it("rejects a role that cannot administer the migration roles", async () => {
    const db = new FakeDatabase(authority({ canCreateRole: false }));

    const report = await runPostgresProductionPreflight(db, migrationsDirectory);

    expect(report.ok).toBe(false);
    expect(report.checks.find((entry) => entry.name === "authority.roles")?.ok).toBe(false);
  });

  it("enforces TLS only when the operator requires it", async () => {
    const withoutRequirement = await runPostgresProductionPreflight(
      new FakeDatabase(authority({ ssl: false })),
      migrationsDirectory,
    );
    const required = await runPostgresProductionPreflight(
      new FakeDatabase(authority({ ssl: false })),
      migrationsDirectory,
      { requireSsl: true },
    );

    expect(withoutRequirement.ok).toBe(true);
    expect(required.ok).toBe(false);
    expect(required.checks.find((entry) => entry.name === "connection.ssl")?.ok).toBe(false);
  });

  it("accepts a TLS client connection through a pooler", async () => {
    const report = await runPostgresProductionPreflight(
      new FakeDatabase(authority({ ssl: false })),
      migrationsDirectory,
      { requireSsl: true, clientTransportSsl: true },
    );

    expect(report.ok).toBe(true);
    expect(report.observations.ssl).toBe(true);
    expect(report.checks.find((entry) => entry.name === "connection.ssl")).toEqual({
      name: "connection.ssl",
      ok: true,
      detail: "client transport uses TLS",
    });
  });
});
