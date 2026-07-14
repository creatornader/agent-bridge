import { describe, expect, it } from "vitest";
import type { PgQueryable } from "../src/postgres-bridge-store.js";
import { reconcileLegacyProjects } from "../src/legacy-project-reconciliation.js";

type CountRow = { messages: number; receipts: number; changed: number };
const migrationChecksum = "a".repeat(64);

function databaseReturning(rows: CountRow[]) {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  let summaryCall = 0;
  let active = rows[0] ?? { messages: 0, receipts: 0, changed: 0 };
  const db: PgQueryable = {
    async query<T extends Record<string, unknown>>(sql: string, values: unknown[] = []) {
      statements.push(sql);
      parameters.push(values);
      if (/count\(\*\)::int AS messages,[\s\S]*AS changed,/i.test(sql)) {
        active = rows[Math.min(summaryCall++, rows.length - 1)] ?? active;
        return { rows: [active as T], rowCount: 1 };
      }
      if (/AS mismatches,[\s\S]*AS deliveries/i.test(sql)) {
        return {
          rows: [{
            messages: active.messages,
            receipts: active.receipts,
            mismatches: 0,
            deliveries: 0,
          } as T],
          rowCount: 1,
        };
      }
      if (/agent_bridge\.messages\) AS messages,[\s\S]*agent_bridge\.receipts\) AS receipts/i.test(sql)) {
        return {
          rows: [{ messages: active.messages, receipts: active.receipts } as T],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { db, statements, parameters };
}

describe("legacy project reconciliation", () => {
  it("defaults to a read-only dry run and returns the complete report", async () => {
    const { db, statements } = databaseReturning([
      { messages: 4, receipts: 3, changed: 2 },
    ]);

    await expect(reconcileLegacyProjects(db, { migrationChecksum })).resolves.toEqual({
      mode: "dry-run",
      workspace: "agent-bridge",
      messages: 4,
      receipts: 3,
      deliveries: 0,
      changed: 2,
    });
    const sql = statements.join(";\n");
    expect(sql).toMatch(/\bROLLBACK\b/i);
    expect(sql).not.toMatch(/UPDATE\s+agent_bridge\.messages/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+agent_bridge\.receipts/i);
    expect(sql).not.toMatch(/DISABLE\s+TRIGGER/i);
  });

  it("runs mutations only when apply is explicitly true", async () => {
    const { db, statements } = databaseReturning([
      { messages: 4, receipts: 3, changed: 2 },
    ]);

    const report = await reconcileLegacyProjects(db, { apply: true, migrationChecksum });
    expect(report).toMatchObject({ mode: "apply", changed: 2 });
    const sql = statements.join(";\n");
    expect(sql).toMatch(/UPDATE\s+agent_bridge\.messages/i);
    expect(sql).toMatch(/\bCOMMIT\b/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+agent_bridge\.workspaces/i);
  });

  it("locks every reconciled table before changing immutable rows", async () => {
    const { db, statements } = databaseReturning([
      { messages: 1, receipts: 1, changed: 1 },
    ]);

    await reconcileLegacyProjects(db, { apply: true, migrationChecksum });
    const sql = statements.join(";\n");
    expect(sql).toMatch(/LOCK\s+TABLE\s+public\.shared_context\s+IN\s+SHARE\s+MODE/i);
    expect(sql).toMatch(/LOCK\s+TABLE\s+agent_bridge\.messages\s+IN\s+ACCESS\s+EXCLUSIVE\s+MODE/i);
    expect(sql).toMatch(/LOCK\s+TABLE\s+agent_bridge\.receipts\s+IN\s+SHARE\s+ROW\s+EXCLUSIVE\s+MODE/i);
    expect(sql).toMatch(/LOCK\s+TABLE\s+agent_bridge\.deliveries\s+IN\s+SHARE\s+MODE/i);
  });

  it("preflights source-scoped candidate idempotency collisions and deliveries", async () => {
    const { db, statements } = databaseReturning([
      { messages: 2, receipts: 0, changed: 2 },
    ]);

    await reconcileLegacyProjects(db, { migrationChecksum });
    const sql = statements.join(";\n");
    expect(sql).toMatch(
      /GROUP\s+BY\s+(?:\w+\.)?source\s*,\s*(?:\w+\.)?idempotency_key\s+HAVING\s+count\(\*\)\s*>\s*1/i,
    );
    expect(sql).toMatch(/agent_bridge\.deliveries/i);
    expect(sql).toMatch(/cannot be reconciled/i);
  });

  it("surfaces preflight refusals without returning a success report", async () => {
    const db: PgQueryable = {
      async query() {
        throw new Error("legacy idempotency key collides in canonical workspace");
      },
    };

    await expect(reconcileLegacyProjects(db, { apply: true, migrationChecksum })).rejects.toThrow(
      "legacy idempotency key collides in canonical workspace",
    );
  });

  it("reports a repeated apply as an idempotent zero-change run", async () => {
    const { db } = databaseReturning([
      { messages: 3, receipts: 2, changed: 3 },
      { messages: 3, receipts: 2, changed: 0 },
    ]);

    await expect(reconcileLegacyProjects(db, { apply: true, migrationChecksum })).resolves.toMatchObject({
      mode: "apply",
      messages: 3,
      receipts: 2,
      changed: 3,
    });
    await expect(reconcileLegacyProjects(db, { apply: true, migrationChecksum })).resolves.toMatchObject({
      mode: "apply",
      messages: 3,
      receipts: 2,
      changed: 0,
    });
  });

  it("rejects an invalid migration checksum before opening a transaction", async () => {
    const { db, statements } = databaseReturning([
      { messages: 0, receipts: 0, changed: 0 },
    ]);

    await expect(reconcileLegacyProjects(db, { migrationChecksum: "not-a-checksum" })).rejects.toThrow(
      "migrationChecksum must be 64 lowercase hexadecimal characters",
    );
    expect(statements).toEqual([]);
  });

  it("preflights the exact migration record and project schema", async () => {
    const { db, statements, parameters } = databaseReturning([
      { messages: 1, receipts: 0, changed: 1 },
    ]);

    await reconcileLegacyProjects(db, { migrationChecksum });
    const sql = statements.join(";\n");
    expect(sql).toMatch(/agent_bridge\.schema_migrations/i);
    expect(sql).toMatch(/version\s*=\s*8/i);
    expect(sql).toMatch(/name\s*=\s*'message_projects'/i);
    expect(sql.includes(migrationChecksum) || parameters.flat().includes(migrationChecksum)).toBe(true);
    expect(sql).toMatch(/information_schema\.columns/i);
    expect(sql).toMatch(/table_schema\s*=\s*'agent_bridge'/i);
    expect(sql).toMatch(/table_name\s*=\s*'messages'/i);
    expect(sql).toMatch(/column_name\s*=\s*'project'/i);
    expect(sql).toMatch(/data_type\s*=\s*'text'/i);
    expect(sql).toMatch(/messages_project_label/i);
    expect(sql).toMatch(/convalidated/i);
    expect(sql).toMatch(/messages_project/i);
    expect(sql).toMatch(/indisvalid/i);
  });
});
