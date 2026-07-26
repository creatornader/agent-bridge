import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteBridgeStore } from "../src/sqlite-bridge-store.js";
import { privateTestDirectory } from "./private-test-path.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const roots: string[] = [];

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function databasePath(): string {
  const root = privateTestDirectory("agent-bridge-local-write-");
  roots.push(root);
  return join(root, "bridge.sqlite3");
}

describe("SQLite local-authority write coordinator", () => {
  it("serializes simultaneous post, get, and receipt mutations", async () => {
    const path = databasePath();
    const worker = `import { SQLiteBridgeStore } from ${JSON.stringify(new URL("../dist/sqlite.js", import.meta.url).pathname)};
const path=process.argv[1];const worker=Number(process.argv[2]);const store=new SQLiteBridgeStore(path,20);await store.initialize();for(let index=0;index<4;index+=1){const id='worker-'+worker+'-'+index;await store.insertMessage({id,workspace:'w',source:'codex',targets:[],type:'context',content:'x',contentType:'text/plain',priority:'info',deliveryPolicy:{mode:'mailbox'}});await store.listMessages({workspace:'w',agent:'codex'},{mailbox:'all'});await store.recordReceipt({workspace:'w',agent:'codex'},[id]);}await store.close();`;
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", worker, path, "0"]);
    await Promise.all(Array.from({ length: 20 }, (_, workerId) => execFileAsync(
      process.execPath, ["--input-type=module", "--eval", worker, path, String(workerId + 1)],
    )));
    const store = new SQLiteBridgeStore(path);
    await store.initialize();
    expect((await store.listMessages({ workspace: "w", agent: "codex" }, { mailbox: "all", limit: 200 })).messages).toHaveLength(84);
    expect(await store.recordReceipt({ workspace: "w", agent: "codex" }, ["worker-0-0"])).toBe(0);
    await store.close();
  }, 60_000);

  it("recovers a crashed writer lease and survives a WAL checkpoint and restart", async () => {
    const path = databasePath();
    const initial = new SQLiteBridgeStore(path);
    await initial.initialize();
    await initial.close();
    const crashedWriter = `import { DatabaseSync } from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.prepare("UPDATE bridge_write_gates SET lease_token='crashed',lease_expires_at=? WHERE gate_key='local'").run(new Date(Date.now()+100).toISOString());process.kill(process.pid,'SIGKILL');`;
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", crashedWriter, path]).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const recovered = new SQLiteBridgeStore(path);
    await recovered.insertMessage({ id: "recovered", workspace: "w", source: "codex", targets: [], type: "context", content: "x", contentType: "text/plain", priority: "info", deliveryPolicy: { mode: "mailbox" } });
    await recovered.close();

    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const checkpoint = new DatabaseSync(path);
    checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    checkpoint.close();
    const restarted = new SQLiteBridgeStore(path);
    await restarted.initialize();
    expect((await restarted.listMessages({ workspace: "w", agent: "codex" })).messages.map((message) => message.id)).toEqual(["recovered"]);
    await restarted.close();
  });

  it("waits for a long transaction after its writer lease expires", async () => {
    const path = databasePath();
    const initial = new SQLiteBridgeStore(path);
    await initial.initialize();
    await initial.close();
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const blocker = new DatabaseSync(path);
    blocker.exec("BEGIN IMMEDIATE");
    blocker.prepare("UPDATE bridge_write_gates SET lease_token='live',lease_expires_at=? WHERE gate_key='local'")
      .run(new Date(Date.now() + 100).toISOString());

    const store = new SQLiteBridgeStore(path);
    const startedAt = Date.now();
    const pending = store.insertMessage({ id: "after-live-lease", workspace: "w", source: "codex", targets: [], type: "context", content: "x", contentType: "text/plain", priority: "info", deliveryPolicy: { mode: "mailbox" } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    blocker.exec("COMMIT");
    blocker.close();
    await pending;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    await store.close();
  });
});
