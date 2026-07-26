import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteEdgeStore } from "../src/sqlite-edge-store.js";
import { SQLiteWriteGate } from "../src/sqlite-write-gate.js";
import { privateTestDirectory } from "./private-test-path.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function edgePath(): string {
  const root = privateTestDirectory("agent-bridge-edge-write-");
  roots.push(root);
  return join(root, "edge.sqlite3");
}

describe("SQLite edge write coordinator", () => {
  it("serializes simultaneous multi-process outbox writes", async () => {
    const path = edgePath();
    const worker = `import { SQLiteEdgeStore } from ${JSON.stringify(new URL("../dist/sqlite.js", import.meta.url).pathname)};
const path=process.argv[1];const worker=process.argv[2];const edge=new SQLiteEdgeStore(path,{endpoint:'https://bridge.test',principal:{workspace:'w',agent:'codex',instance:'shared'}});await edge.initialize();for(let index=0;index<32;index+=1){await edge.enqueue({id:'worker-'+worker+'-'+index,source:'codex',targets:[],type:'context',content:'x',contentType:'text/plain',priority:'info',deliveryPolicy:{mode:'mailbox'},idempotencyKey:'worker-'+worker+'-'+index});}await edge.close();`;
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", worker, path, "0"]);
    await Promise.all(Array.from({ length: 20 }, (_, workerId) => execFileAsync(
      process.execPath, ["--input-type=module", "--eval", worker, path, String(workerId + 1)],
    )));
    const edge = new SQLiteEdgeStore(path, { endpoint: "https://bridge.test", principal: { workspace: "w", agent: "codex", instance: "shared" } });
    await edge.initialize();
    expect((await edge.stats()).pending).toBe(672);
    await edge.close();
  }, 60_000);

  it("reclaims a crashed writer and releases after a long local critical section", async () => {
    const path = edgePath();
    const lock = `${path}.write.lock`;
    const crashedWriter = `const fs=require('node:fs');const os=require('node:os');fs.writeFileSync(process.argv[1],JSON.stringify({schema:'agent-bridge.edge-write-lock',version:1,pid:process.pid,host:os.hostname()})+'\\n',{mode:0o600});`;
    await execFileAsync(process.execPath, ["--eval", crashedWriter, lock]);
    const gate = new SQLiteWriteGate(path, 1_000);
    const started = Date.now();
    await gate.run(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
    expect(existsSync(lock)).toBe(false);
  });
});
