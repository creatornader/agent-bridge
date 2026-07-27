import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteEdgeStore } from "../src/sqlite-edge-store.js";
import { rollbackSqliteTransaction } from "../src/sqlite-retry.js";
import { privateTestDirectory } from "./private-test-path.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function edgePath(): string {
  const root = privateTestDirectory("agent-bridge-edge-write-");
  roots.push(root);
  return join(root, "edge.sqlite3");
}

describe("SQLite edge write coordinator", () => {
  it("does not mask an error after SQLite already ended a transaction", () => {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(":memory:");
    database.exec("BEGIN IMMEDIATE");
    database.exec("ROLLBACK");
    expect(() => rollbackSqliteTransaction(database)).not.toThrow();
    database.close();
  });

  it("serializes simultaneous post, get, and ack cache mutations", async () => {
    const path = edgePath();
    const worker = `import { SQLiteEdgeStore } from ${JSON.stringify(new URL("../dist/sqlite.js", import.meta.url).pathname)};
const path=process.argv[1];const worker=Number(process.argv[2]);const edge=new SQLiteEdgeStore(path,{endpoint:'https://bridge.test',principal:{workspace:'w',agent:'codex',instance:'shared'}});await edge.initialize();for(let index=0;index<4;index+=1){const draft={id:'worker-'+worker+'-'+index,source:'codex',targets:[],type:'context',content:'x',contentType:'text/plain',priority:'info',deliveryPolicy:{mode:'mailbox'},idempotencyKey:'worker-'+worker+'-'+index};await edge.enqueue(draft);await edge.list({mailbox:'all'});let claimed;for(let attempt=0;attempt<100&&!claimed;attempt+=1){claimed=await edge.claimNext();if(!claimed)await new Promise(resolve=>setTimeout(resolve,2));}if(!claimed)throw new Error('outbox claim timed out');await edge.commit(claimed,{...claimed.draft,workspace:'w',sequence:String(worker*4+index+1),createdAt:'2026-07-26T00:00:00.000Z'});}await edge.close();`;
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", worker, path, "0"]);
    await Promise.all(Array.from({ length: 20 }, (_, workerId) => execFileAsync(
      process.execPath, ["--input-type=module", "--eval", worker, path, String(workerId + 1)],
    )));
    const edge = new SQLiteEdgeStore(path, { endpoint: "https://bridge.test", principal: { workspace: "w", agent: "codex", instance: "shared" } });
    await edge.initialize();
    expect(await edge.stats()).toMatchObject({ pending: 0, cached: 84 });
    await edge.close();
  }, 60_000);

  it("recovers a crashed writer lease and survives a WAL checkpoint and restart", async () => {
    const path = edgePath();
    const crashedWriter = `import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync(process.argv[1]);db.prepare(\"UPDATE edge_write_gates SET lease_token='crashed',lease_expires_at=? WHERE gate_key='edge'\").run(new Date(Date.now()+100).toISOString());process.kill(process.pid,'SIGKILL');`;
    const initial = new SQLiteEdgeStore(path, { endpoint: "https://bridge.test", principal: { workspace: "w", agent: "codex" } });
    await initial.initialize();
    await initial.close();
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", crashedWriter, path]).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const recovered = new SQLiteEdgeStore(path, { endpoint: "https://bridge.test", principal: { workspace: "w", agent: "codex" } });
    await recovered.enqueue({ id: "recovered", source: "codex", targets: [], type: "context", content: "x", contentType: "text/plain", priority: "info", deliveryPolicy: { mode: "mailbox" }, idempotencyKey: "recovered" });
    await recovered.close();

    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const checkpoint = new DatabaseSync(path);
    checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    checkpoint.close();
    const restarted = new SQLiteEdgeStore(path, { endpoint: "https://bridge.test", principal: { workspace: "w", agent: "codex" } });
    await restarted.initialize();
    expect((await restarted.stats()).pending).toBe(1);
    await restarted.close();
  });

  it("waits for a long transaction after its writer lease expires", async () => {
    const path = edgePath();
    const initial = new SQLiteEdgeStore(path, { endpoint: "https://bridge.test", principal: { workspace: "w", agent: "codex" } });
    await initial.initialize();
    await initial.close();
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const blocker = new DatabaseSync(path);
    blocker.exec("BEGIN IMMEDIATE");
    blocker.prepare("UPDATE edge_write_gates SET lease_token='live',lease_expires_at=? WHERE gate_key='edge'")
      .run(new Date(Date.now() + 100).toISOString());

    const edge = new SQLiteEdgeStore(path, { endpoint: "https://bridge.test", principal: { workspace: "w", agent: "codex" } }, 2_000, 100, 5_000);
    const startedAt = Date.now();
    const pending = edge.enqueue({ id: "after-live-lease", source: "codex", targets: [], type: "context", content: "x", contentType: "text/plain", priority: "info", deliveryPolicy: { mode: "mailbox" }, idempotencyKey: "after-live-lease" })
      .then(() => undefined, (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 250));
    blocker.exec("COMMIT");
    blocker.close();
    const error = await pending;
    if (error) throw error;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    await edge.close();
  }, 15_000);

});
