import { closeSync, constants, fsyncSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NATIVE_DR_MAX_BUNDLE_BYTES, NativeDrBundleReader, validateNativeDrAggregateSize, writeNativeDrBundle,
  type NativeDrBundleInput,
} from "../src/native-dr-bundle.js";
import { privateTestDirectory, secureTestFile } from "./private-test-path.js";

const roots: string[] = [];
function root(): string { const path = privateTestDirectory("agent-bridge-dr-bundle-"); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const backupId = "018f4a70-0000-7000-8000-000000000201";
const excluded = [
  "agent_bridge.agent_instances", "agent_bridge.rate_limit_buckets", "agent_bridge.request_authorities",
  "agent_bridge.archive_transaction_authorizations",
];
function pgInput(database: string, roles: string): NativeDrBundleInput {
  return {
    backupId, createdAt: "2026-07-15T00:00:00.000Z", kind: "postgres",
    entries: [{ name: "postgres/database.dump", path: database }, { name: "postgres/roles.json", path: roles }],
    schema: {
      databaseName: "agent_bridge", serverVersionNum: 170005, serverMajor: 17, schemaVersion: 16,
      migrations: [{ version: 1, name: "gateway_v2", checksum: "a".repeat(64) }],
      tableCounts: { "agent_bridge.messages": "12" }, excludedDataTables: excluded,
      pgDumpVersion: "pg_dump (PostgreSQL) 17.5", roleInventorySha256: "b".repeat(64), claimedDeliveryCount: "2",
      readinessAttestations: {
        securitySchemaSha256: "c".repeat(64), rowIsolationSha256: "d".repeat(64),
        ownerControlSha256: "e".repeat(64), portableArchiveSha256: "f".repeat(64),
      },
    },
  };
}

function writeBundle(path: string, input: NativeDrBundleInput, hooks: Parameters<typeof writeNativeDrBundle>[3] = {}): void {
  for (const entry of input.entries) secureTestFile(entry.path);
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  secureTestFile(path);
  try { writeNativeDrBundle(descriptor, input, path, hooks); } finally { closeSync(descriptor); }
}

describe("native DR bundle framing", () => {
  it("streams and verifies the exact ordered PostgreSQL entry set", () => {
    const directory = root(); const database = join(directory, "database.dump"); const roles = join(directory, "roles.json"); const bundle = join(directory, "backup.abdr");
    writeFileSync(database, Buffer.from("custom dump bytes"), { mode: 0o600 }); writeFileSync(roles, Buffer.from('{"roles":[]}\n'), { mode: 0o600 });
    writeBundle(bundle, pgInput(database, roles));
    const extractedDatabase = join(directory, "extracted.dump"); const extractedRoles = join(directory, "extracted.json");
    const outputs = new Map([
      ["postgres/database.dump", openSync(extractedDatabase, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)],
      ["postgres/roles.json", openSync(extractedRoles, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)],
    ]);
    secureTestFile(extractedDatabase); secureTestFile(extractedRoles);
    const reader = new NativeDrBundleReader(bundle);
    try {
      const metadata = reader.inspect((entry) => outputs.get(entry.name));
      expect(metadata.manifest.entries.map((entry) => entry.name)).toEqual(["postgres/database.dump", "postgres/roles.json"]);
      expect(metadata.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally { reader.close(); for (const descriptor of outputs.values()) { fsyncSync(descriptor); closeSync(descriptor); } }
    expect(readFileSync(extractedDatabase)).toEqual(readFileSync(database)); expect(readFileSync(extractedRoles)).toEqual(readFileSync(roles));
  });

  it("rejects mutation between the hash and payload passes", () => {
    const directory = root(); const database = join(directory, "database.dump"); const roles = join(directory, "roles.json"); const bundle = join(directory, "backup.abdr");
    writeFileSync(database, "alpha", { mode: 0o600 }); writeFileSync(roles, "roles", { mode: 0o600 });
    expect(() => writeBundle(bundle, pgInput(database, roles), { afterHash: () => writeFileSync(database, "bravo", { mode: 0o600 }) }))
      .toThrow(/changed between hashing and bundling|changed while bundling/);
  });

  it("rejects malformed Unicode and provider-entry mismatches", () => {
    const directory = root(); const database = join(directory, "database.dump"); const roles = join(directory, "roles.json");
    writeFileSync(database, "dump", { mode: 0o600 }); writeFileSync(roles, "roles", { mode: 0o600 });
    const malformed = pgInput(database, roles); malformed.schema.databaseName = "bad\ud800name";
    expect(() => writeBundle(join(directory, "malformed.abdr"), malformed)).toThrow(/unpaired surrogate/);
    expect(() => writeBundle(join(directory, "wrong-kind.abdr"), {
      backupId, createdAt: "2026-07-15T00:00:00.000Z", kind: "sqlite",
      entries: [{ name: "postgres/database.dump", path: database }], schema: { applicationId: 1, userVersion: 1, schemaContractSha256: "c".repeat(64) },
    })).toThrow(/provider kind/);
  });

  it("rejects aggregate overflow without allocating a giant buffer", () => {
    expect(() => validateNativeDrAggregateSize([NATIVE_DR_MAX_BUNDLE_BYTES, 1])).toThrow(/aggregate size/);
  });

  it("rejects trailing bytes after the final frame", () => {
    const directory = root(); const source = join(directory, "db.sqlite3"); const bundle = join(directory, "backup.abdr");
    writeFileSync(source, "sqlite bytes", { mode: 0o600 });
    writeBundle(bundle, { backupId, createdAt: "2026-07-15T00:00:00.000Z", kind: "sqlite", entries: [{ name: "sqlite/database.sqlite3", path: source }], schema: { applicationId: 1094862642, userVersion: 1, schemaContractSha256: "c".repeat(64) } });
    writeFileSync(bundle, Buffer.concat([readFileSync(bundle), Buffer.from([0])]), { mode: 0o600 });
    const reader = new NativeDrBundleReader(bundle);
    try { expect(() => reader.inspect()).toThrow(/trailing bytes/); } finally { reader.close(); }
  });
});
