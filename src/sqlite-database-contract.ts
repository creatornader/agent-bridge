import { createHash } from "node:crypto";
import type { DatabaseSync as Database } from "node:sqlite";

type Row = Record<string, unknown>;

export const LOCAL_SQLITE_APPLICATION_ID = 0x41424732;
export const EDGE_SQLITE_APPLICATION_ID = 0x41424745;
export const SQLITE_DATABASE_SCHEMA_VERSION = 1;
export const SQLITE_METADATA_TABLE = "agent_bridge_metadata";
export const LOCAL_SQLITE_SCHEMA_CONTRACTS = Object.freeze([
  Object.freeze({ id: "current-created-schema", sha256: "e2f978c27ea5d151a4b4b3ec349166833441e42401fedfe60dc3ba20f3d713aa" }),
  Object.freeze({ id: "current-upgraded-project-column", sha256: "cb0975bbc1ccc7a2a66d8f4d76df619804449cf81119972337afad6cdab64451" }),
  Object.freeze({ id: "current-upgraded-delivery-policy", sha256: "d4fd8905ea73057b27662454c16c038834f5a1bf017db9cfc041792104aa2e6d" }),
  Object.freeze({ id: "current-upgraded-delivery-events", sha256: "35bdab0cbdf4ce619ba1c7d36032379ae4d9692bd7509e49bb90b409bbbcf632" }),
] as const);
export const EDGE_SQLITE_SCHEMA_CONTRACTS = Object.freeze([
  Object.freeze({ id: "current-created-schema", sha256: "27f22b2f4024585c87e8d6f76f8999a8df92bb1f585d46594a7a1e852fd53c4c" }),
  Object.freeze({ id: "current-upgraded-project-column", sha256: "171ae11f520b4963f517d3102de64cb8a5f45c080078ff02e20aeb17891b585c" }),
  Object.freeze({ id: "current-upgraded-project-column-migration-gate", sha256: "790b4bfed373ff776ba6700065154f7a3cbbecd94f37ea09a654768ac2a8455c" }),
  Object.freeze({ id: "current-upgraded-migration-gate", sha256: "64634eae28f344f02324e6c002e4cc35ea9a99fe878de843df018482bdde38ef" }),
] as const);
const localContractHashes = new Set<string>(LOCAL_SQLITE_SCHEMA_CONTRACTS.map((contract) => contract.sha256));
const edgeContractHashes = new Set<string>(EDGE_SQLITE_SCHEMA_CONTRACTS.map((contract) => contract.sha256));
export const isSupportedLocalSqliteSchemaContract = (hash: string): boolean => localContractHashes.has(hash);
export const isSupportedEdgeSqliteSchemaContract = (hash: string): boolean => edgeContractHashes.has(hash);

const localMetadata = {
  database_kind: "local-authority",
  schema_name: "agent-bridge-local-v2",
  schema_version: SQLITE_DATABASE_SCHEMA_VERSION,
} as const;

const edgeMetadata = {
  database_kind: "edge-cache",
  schema_name: "agent-bridge-edge-v1",
  schema_version: SQLITE_DATABASE_SCHEMA_VERSION,
} as const;

const localColumns: Record<string, readonly string[]> = {
  agent_bridge_metadata: ["singleton", "database_kind", "schema_name", "schema_version"],
  bridge_messages: [
    "sequence", "id", "workspace", "project", "source", "type", "content", "content_type", "data", "targets",
    "thread_id", "reply_to_id", "correlation_id", "causation_id", "priority", "expires_at", "idempotency_key",
    "atrib_receipt_id", "informed_by", "metadata", "delivery_policy", "created_at",
  ],
  bridge_receipts: ["workspace", "message_id", "principal", "read_at"],
  bridge_deliveries: [
    "id", "message_id", "workspace", "recipient", "state", "attempt", "cycle_attempt", "requeue_count", "created_at",
    "priority_rank", "available_at", "lease_token", "lease_owner", "lease_expires_at", "last_error", "last_actor", "last_action",
  ],
  bridge_delivery_events: [
    "sequence", "delivery_id", "message_id", "workspace", "recipient", "from_state", "to_state", "attempt", "cycle_attempt",
    "requeue_count", "lease_owner", "error", "actor", "action", "created_at",
  ],
  bridge_presence: ["workspace", "agent", "instance", "runtime_type", "capabilities", "lease_expires_at", "last_seen_at"],
};

const localObjects = new Map<string, [string, string]>([
  ["agent_bridge_metadata", ["table", "agent_bridge_metadata"]],
  ["bridge_deliveries", ["table", "bridge_deliveries"]],
  ["bridge_delivery_events", ["table", "bridge_delivery_events"]],
  ["bridge_messages", ["table", "bridge_messages"]],
  ["bridge_presence", ["table", "bridge_presence"]],
  ["bridge_receipts", ["table", "bridge_receipts"]],
  ["bridge_deliveries_claim", ["index", "bridge_deliveries"]],
  ["bridge_deliveries_publisher", ["index", "bridge_deliveries"]],
  ["bridge_deliveries_terminal", ["index", "bridge_deliveries"]],
  ["bridge_delivery_events_lookup", ["index", "bridge_delivery_events"]],
  ["bridge_messages_created", ["index", "bridge_messages"]],
  ["bridge_messages_cursor", ["index", "bridge_messages"]],
  ["bridge_messages_idempotency", ["index", "bridge_messages"]],
  ["bridge_messages_project", ["index", "bridge_messages"]],
  ["bridge_messages_source", ["index", "bridge_messages"]],
  ["bridge_messages_thread", ["index", "bridge_messages"]],
  ["bridge_presence_active", ["index", "bridge_presence"]],
  ["bridge_delivery_events_insert", ["trigger", "bridge_deliveries"]],
  ["bridge_delivery_events_update", ["trigger", "bridge_deliveries"]],
  ["bridge_messages_no_delete", ["trigger", "bridge_messages"]],
  ["bridge_messages_no_update", ["trigger", "bridge_messages"]],
  ["bridge_messages_policy_insert", ["trigger", "bridge_messages"]],
  ["bridge_messages_domain_insert", ["trigger", "bridge_messages"]],
  ["agent_bridge_metadata_no_delete", ["trigger", "agent_bridge_metadata"]],
  ["agent_bridge_metadata_no_update", ["trigger", "agent_bridge_metadata"]],
]);

const edgeColumns: Record<string, readonly string[]> = {
  agent_bridge_metadata: ["singleton", "database_kind", "schema_name", "schema_version"],
  edge_scopes: ["scope_key", "endpoint_hash", "workspace", "agent", "pull_cursor", "last_sync_at", "last_error", "last_outbound_sync_at", "last_inbound_sync_at", "last_attempt_at", "cache_contract"],
  edge_migration_gates: ["scope_key", "state", "operation_id", "lease_token", "lease_expires_at", "updated_at"],
  edge_outbox: ["position", "scope_key", "message_id", "idempotency_key", "payload_hash", "draft_json", "state", "attempts", "available_at", "lease_token", "lease_expires_at", "last_error", "blocked_at", "created_at"],
  edge_inbox: ["scope_key", "message_id", "remote_sequence", "sequence_key", "workspace", "project", "source", "type", "thread_id", "created_at", "expires_at", "message_json"],
};

const edgeObjects = new Map<string, [string, string]>([
  ["agent_bridge_metadata", ["table", "agent_bridge_metadata"]],
  ["edge_scopes", ["table", "edge_scopes"]],
  ["edge_migration_gates", ["table", "edge_migration_gates"]],
  ["edge_outbox", ["table", "edge_outbox"]],
  ["edge_inbox", ["table", "edge_inbox"]],
  ["edge_inbox_created", ["index", "edge_inbox"]],
  ["edge_inbox_cursor", ["index", "edge_inbox"]],
  ["edge_inbox_project", ["index", "edge_inbox"]],
  ["edge_inbox_source", ["index", "edge_inbox"]],
  ["edge_inbox_thread", ["index", "edge_inbox"]],
  ["edge_outbox_due", ["index", "edge_outbox"]],
  ["edge_migration_gates_state", ["index", "edge_migration_gates"]],
  ["edge_outbox_migration_gate_insert", ["trigger", "edge_outbox"]],
  ["agent_bridge_metadata_no_delete", ["trigger", "agent_bridge_metadata"]],
  ["agent_bridge_metadata_no_update", ["trigger", "agent_bridge_metadata"]],
]);

export class SQLiteDatabaseContractError extends Error {}

function normalizeSql(sql: string): string {
  let output = ""; let quote = ""; let pendingSpace = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (quote) {
      output += character;
      if ((quote === "]" && character === "]") || (quote !== "]" && character === quote)) {
        if (sql[index + 1] === character && quote !== "]") { output += sql[++index]!; }
        else quote = "";
      }
      continue;
    }
    if (/\s/u.test(character)) { pendingSpace = output.length > 0; continue; }
    if (pendingSpace && !/[(),;]/u.test(character) && !/[(),;]/u.test(output[output.length - 1] ?? "")) output += " ";
    pendingSpace = false;
    if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === "[") quote = "]";
    output += quote ? character : character.toLowerCase();
  }
  return output.trim();
}

function stableRows(rows: Row[]): Array<Record<string, string | number | null>> {
  return rows.map((row) => Object.fromEntries(Object.keys(row).sort().map((key) => {
    const value = row[key]; return [key, value === null ? null : typeof value === "number" ? value : String(value)];
  })));
}

function quoteIdentifier(value: string): string { return `"${value.split('"').join('""')}"`; }

export function sqliteSchemaContractHash(db: Database): string {
  const objects = (db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as Row[])
    .map((row) => ({ type: String(row.type), name: String(row.name), table: String(row.tbl_name), sql: normalizeSql(String(row.sql)) }));
  const tables = objects.filter((object) => object.type === "table").map((object) => ({
    name: object.name,
    columns: stableRows(db.prepare(`PRAGMA table_info(${quoteIdentifier(object.name)})`).all() as Row[]),
    foreignKeys: stableRows(db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(object.name)})`).all() as Row[]),
    indexes: (db.prepare(`PRAGMA index_list(${quoteIdentifier(object.name)})`).all() as Row[])
      .sort((left, right) => String(left.name).localeCompare(String(right.name))).map((row) => ({
        ...Object.fromEntries(Object.keys(row).filter((key) => key !== "seq").sort().map((key) => [key, row[key] === null ? null : typeof row[key] === "number" ? row[key] : String(row[key])])),
        columns: stableRows(db.prepare(`PRAGMA index_xinfo(${quoteIdentifier(String(row.name))})`).all() as Row[]),
      })),
  }));
  return createHash("sha256").update(JSON.stringify({ objects, tables })).digest("hex");
}

function assertUpgradeCandidate(db: Database, allowed: ReadonlyMap<string, [string, string]>, oppositePrefix: string, label: string): void {
  if (objectNames(db, oppositePrefix).length) throw new SQLiteDatabaseContractError(`${label} database kind is invalid`);
  const rows = db.prepare("SELECT type,name,tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[];
  for (const row of rows) {
    const expected = allowed.get(String(row.name));
    if (!expected || expected[0] !== String(row.type) || expected[1] !== String(row.tbl_name)) {
      throw new SQLiteDatabaseContractError(`${label} database has an unexpected pre-migration schema object`);
    }
  }
}

export function assertLocalUpgradeCandidate(db: Database): void { assertUpgradeCandidate(db, localObjects, "edge_", "local authority"); }
export function assertEdgeUpgradeCandidate(db: Database): void { assertUpgradeCandidate(db, edgeObjects, "bridge_", "edge"); }

function scalar(db: Database, pragma: string): number {
  const row = db.prepare(pragma).get() as Row;
  return Number(Object.values(row)[0]);
}

function objectNames(db: Database, prefix: string): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ? ORDER BY name").all(`${prefix}%`) as Row[])
    .map((row) => String(row.name));
}

function metadata(db: Database): Record<string, string | number> {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(SQLITE_METADATA_TABLE);
  if (!exists) return {};
  const row = db.prepare(`SELECT singleton,database_kind,schema_name,schema_version FROM ${SQLITE_METADATA_TABLE}`).get() as Row | undefined;
  if (!row || Number(row.singleton) !== 1) return {};
  return { database_kind: String(row.database_kind), schema_name: String(row.schema_name), schema_version: Number(row.schema_version) };
}

function installMarkers(db: Database, applicationId: number, expected: { database_kind: string; schema_name: string; schema_version: number }): void {
  const currentApplicationId = scalar(db, "PRAGMA application_id");
  if (currentApplicationId !== 0 && currentApplicationId !== applicationId) {
    throw new SQLiteDatabaseContractError("SQLite database kind marker does not match the selected store");
  }
  const currentVersion = scalar(db, "PRAGMA user_version");
  if (currentVersion !== 0 && currentVersion !== SQLITE_DATABASE_SCHEMA_VERSION) {
    throw new SQLiteDatabaseContractError("SQLite database schema version is unsupported");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS ${SQLITE_METADATA_TABLE} (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), database_kind TEXT NOT NULL,
    schema_name TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version>=1)
  ) WITHOUT ROWID`);
  const existing = metadata(db);
  if (Object.keys(existing).length && Object.entries(expected).some(([key, value]) => existing[key] !== value)) {
    throw new SQLiteDatabaseContractError("SQLite database metadata does not match the selected store");
  }
  db.prepare(`INSERT OR IGNORE INTO ${SQLITE_METADATA_TABLE}(singleton,database_kind,schema_name,schema_version) VALUES (1,?,?,?)`)
    .run(expected.database_kind, expected.schema_name, expected.schema_version);
  db.exec(`CREATE TRIGGER IF NOT EXISTS agent_bridge_metadata_no_update BEFORE UPDATE ON ${SQLITE_METADATA_TABLE}
    BEGIN SELECT RAISE(ABORT,'database metadata is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_bridge_metadata_no_delete BEFORE DELETE ON ${SQLITE_METADATA_TABLE}
    BEGIN SELECT RAISE(ABORT,'database metadata is immutable'); END`);
  db.exec(`PRAGMA application_id = ${applicationId}; PRAGMA user_version = ${SQLITE_DATABASE_SCHEMA_VERSION}`);
}

export function installLocalAuthorityMarkers(db: Database): void {
  if (objectNames(db, "edge_").length) throw new SQLiteDatabaseContractError("edge databases cannot be opened as local authority stores");
  installMarkers(db, LOCAL_SQLITE_APPLICATION_ID, localMetadata);
  assertLocalAuthorityDatabase(db);
}

export function installEdgeMarkers(db: Database): void {
  if (objectNames(db, "bridge_").length) throw new SQLiteDatabaseContractError("local authority databases cannot be opened as edge stores");
  installMarkers(db, EDGE_SQLITE_APPLICATION_ID, edgeMetadata);
  assertEdgeDatabase(db);
}

export function identifySqliteDatabase(db: Database): "local-authority" | "edge-cache" | "legacy-local" | "legacy-edge" | "unknown" {
  const applicationId = scalar(db, "PRAGMA application_id");
  const declared = metadata(db).database_kind;
  if ((applicationId === LOCAL_SQLITE_APPLICATION_ID && declared === "edge-cache")
    || (applicationId === EDGE_SQLITE_APPLICATION_ID && declared === "local-authority")) {
    throw new SQLiteDatabaseContractError("SQLite application and metadata kind markers conflict");
  }
  if (applicationId === LOCAL_SQLITE_APPLICATION_ID || declared === "local-authority") return "local-authority";
  if (applicationId === EDGE_SQLITE_APPLICATION_ID || declared === "edge-cache") return "edge-cache";
  if (objectNames(db, "edge_").length) return "legacy-edge";
  if (objectNames(db, "bridge_").length) return "legacy-local";
  return "unknown";
}

export function assertEdgeDatabase(db: Database): void {
  if (identifySqliteDatabase(db) !== "edge-cache") throw new SQLiteDatabaseContractError("database is not a marked edge store");
  if (scalar(db, "PRAGMA application_id") !== EDGE_SQLITE_APPLICATION_ID
    || scalar(db, "PRAGMA user_version") !== SQLITE_DATABASE_SCHEMA_VERSION) throw new SQLiteDatabaseContractError("edge database markers are invalid");
  const actualMetadata = metadata(db);
  if (Object.keys(actualMetadata).length !== Object.keys(edgeMetadata).length
    || Object.entries(edgeMetadata).some(([key, value]) => actualMetadata[key] !== value)) throw new SQLiteDatabaseContractError("edge database metadata is invalid");
  const rows = db.prepare("SELECT type,name,tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[];
  if (rows.length !== edgeObjects.size) throw new SQLiteDatabaseContractError("edge database has an unexpected schema object set");
  for (const row of rows) {
    const expected = edgeObjects.get(String(row.name));
    if (!expected || expected[0] !== String(row.type) || expected[1] !== String(row.tbl_name)) throw new SQLiteDatabaseContractError("edge database has an unexpected schema object");
  }
  for (const [table, expected] of Object.entries(edgeColumns)) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name));
    const ordered = [...columns].sort(); const expectedOrdered = [...expected].sort();
    if (ordered.length !== expectedOrdered.length || ordered.some((column, index) => column !== expectedOrdered[index])) throw new SQLiteDatabaseContractError("edge database column contract is invalid");
  }
  const contract = sqliteSchemaContractHash(db);
  if (!isSupportedEdgeSqliteSchemaContract(contract)) throw new SQLiteDatabaseContractError("edge database schema contract hash is invalid");
}

export function assertLocalAuthorityDatabase(db: Database): void {
  if (identifySqliteDatabase(db) !== "local-authority") throw new SQLiteDatabaseContractError("database is not a marked local authority store");
  if (scalar(db, "PRAGMA application_id") !== LOCAL_SQLITE_APPLICATION_ID
    || scalar(db, "PRAGMA user_version") !== SQLITE_DATABASE_SCHEMA_VERSION) {
    throw new SQLiteDatabaseContractError("local authority database markers are invalid");
  }
  const actualMetadata = metadata(db);
  if (Object.keys(actualMetadata).length !== Object.keys(localMetadata).length
    || Object.entries(localMetadata).some(([key, value]) => actualMetadata[key] !== value)) {
    throw new SQLiteDatabaseContractError("local authority database metadata is invalid");
  }
  const rows = db.prepare("SELECT type,name,tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[];
  if (rows.length !== localObjects.size) throw new SQLiteDatabaseContractError("local authority database has an unexpected schema object set");
  for (const row of rows) {
    const expected = localObjects.get(String(row.name));
    if (!expected || expected[0] !== String(row.type) || expected[1] !== String(row.tbl_name)) {
      throw new SQLiteDatabaseContractError("local authority database has an unexpected schema object");
    }
  }
  for (const [table, expected] of Object.entries(localColumns)) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name));
    const ordered = [...columns].sort(); const expectedOrdered = [...expected].sort();
    if (ordered.length !== expectedOrdered.length || ordered.some((column, index) => column !== expectedOrdered[index])) {
      throw new SQLiteDatabaseContractError("local authority database column contract is invalid");
    }
  }
  const contract = sqliteSchemaContractHash(db);
  if (!isSupportedLocalSqliteSchemaContract(contract)) throw new SQLiteDatabaseContractError("local authority database schema contract hash is invalid");
}

export function verifySqliteHealth(db: Database): void {
  const integrity = db.prepare("PRAGMA integrity_check").all() as Row[];
  if (integrity.length !== 1 || String(Object.values(integrity[0]!)[0]) !== "ok") {
    throw new SQLiteDatabaseContractError("SQLite integrity check failed");
  }
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all() as Row[];
  if (foreignKeys.length) throw new SQLiteDatabaseContractError("SQLite foreign key check failed");
}
