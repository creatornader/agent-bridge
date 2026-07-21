import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadMigrationPlan,
  migrationRecordMatches,
  migrationsReady,
  runMigrations,
  type AppliedMigration,
} from "../src/migrations.js";

const released = [
  [7, "runtime_role", "70cca251f736c5e5a9835d5b80645e8816131767127a11a5daa9281bd38004fc"],
  [13, "row_isolation", "52ed880fe6df145181f102421be8a757731713a561acfcc98acdbbca12dcf8e4"],
  [14, "owner_control_plane", "7249901ab5db665fa36d6854202c9db4339f6b989a7c5b8c46b3819c5ab54353"],
  [15, "portable_archives", "b019bbd9b6cfbdc0501d2cb78541de04001cde47c55fd7e011e1f88bd072460d"],
  [16, "native_dr_fence", "801edad796813320bfd5d194abf35c108ab51380027af4f160b7a14a4fc79e11"],
  [18, "endpoint_migration_challenges", "353285c04d8c4287dea75b30779c26f0e38e8572618403c4ed8f8a346eed0c97"],
  [19, "endpoint_migration_same_successor", "feb805b9ba00f82e303a294ec26e3a7ae0f587438e5138f3ead6ad84f54bee5f"],
] as const;

const releasedByIdentity = new Map(released.map(([version, name, checksum]) =>
  [`${version}_${name}`, checksum]
));

class LedgerDatabase {
  readonly statements: string[] = [];

  constructor(readonly migrations: AppliedMigration[]) {}

  async query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
    this.statements.push(sql);
    if (sql.includes("to_regclass('agent_bridge.schema_migrations')")) {
      return { rows: [{ table_name: "agent_bridge.schema_migrations" }] as T[], rowCount: 1 };
    }
    if (sql.includes("SELECT version, name, checksum FROM agent_bridge.schema_migrations")) {
      return { rows: this.migrations as T[], rowCount: this.migrations.length };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

describe("migration checksum compatibility", () => {
  it.each(released)("accepts the released checksum for %s_%s", (version, name, checksum) => {
    expect(migrationRecordMatches(
      { version, name, checksum },
      { version, name, checksum: "f".repeat(64) },
    )).toBe(true);
  });

  it("accepts the current exact checksum without an allowlist entry", () => {
    expect(migrationRecordMatches(
      { version: 20, name: "managed_authority_compat", checksum: "a".repeat(64) },
      { version: 20, name: "managed_authority_compat", checksum: "a".repeat(64) },
    )).toBe(true);
  });

  it("rejects arbitrary drift for a released migration", () => {
    expect(migrationRecordMatches(
      { version: 7, name: "runtime_role", checksum: "0".repeat(64) },
      { version: 7, name: "runtime_role", checksum: "f".repeat(64) },
    )).toBe(false);
  });

  it("does not transfer a released checksum to another identity", () => {
    expect(migrationRecordMatches(
      { version: 8, name: "message_projects", checksum: released[0][2] },
      { version: 8, name: "message_projects", checksum: "f".repeat(64) },
    )).toBe(false);
    expect(migrationRecordMatches(
      { version: 7, name: "message_projects", checksum: released[0][2] },
      { version: 7, name: "runtime_role", checksum: "f".repeat(64) },
    )).toBe(false);
  });

  it("keeps released ledgers ready without executing their migrations again", async () => {
    const directory = fileURLToPath(new URL("../sql/migrations", import.meta.url));
    const plan = await loadMigrationPlan(directory);
    const ledger = plan.map(({ version, name, checksum }) => ({
      version,
      name,
      checksum: releasedByIdentity.get(`${version}_${name}`) ?? checksum,
    }));
    const db = new LedgerDatabase(ledger);

    expect(await migrationsReady(db, plan)).toBe(true);
    await expect(runMigrations(db, directory)).resolves.toEqual(ledger);
    expect(db.statements.every((sql) => !/^begin;/iu.test(sql.trim()))).toBe(true);
  });

  it("keeps arbitrary ledger drift closed in readiness and migration execution", async () => {
    const directory = fileURLToPath(new URL("../sql/migrations", import.meta.url));
    const plan = await loadMigrationPlan(directory);
    const ledger = plan.map(({ version, name, checksum }) => ({ version, name, checksum }));
    ledger[6] = { ...ledger[6]!, checksum: "0".repeat(64) };
    const db = new LedgerDatabase(ledger);

    expect(await migrationsReady(db, plan)).toBe(false);
    await expect(runMigrations(db, directory)).rejects.toThrow(
      "migration 7_runtime_role conflicts with schema state",
    );
  });
});
