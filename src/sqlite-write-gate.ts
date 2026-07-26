import { closeSync, existsSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

const DEFAULT_WAIT_MS = 5_000;

export class SQLiteWriteGateError extends Error {
  constructor() {
    super("edge write coordinator remained busy");
    this.name = "SQLiteWriteGateError";
    this.code = "edge_write_coordinator_busy";
  }

  readonly code: string;
}

interface LockRecord {
  schema: "agent-bridge.edge-write-lock";
  version: 1;
  pid: number;
  host: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function liveLocalHolder(path: string): boolean {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    if (record.schema !== "agent-bridge.edge-write-lock" || record.version !== 1
      || record.host !== hostname() || !Number.isInteger(record.pid) || record.pid! <= 0) return false;
    process.kill(record.pid!, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && (error.code === "ESRCH" || error.code === "ENOENT"));
  }
}

export class SQLiteWriteGate {
  private readonly path: string;

  constructor(databasePath: string, private readonly waitMs = DEFAULT_WAIT_MS) {
    this.path = `${databasePath}.write.lock`;
  }

  async run<T>(work: () => T | Promise<T>): Promise<T> {
    const deadline = Date.now() + Math.max(1, Math.trunc(this.waitMs));
    let descriptor: number | undefined;
    let pause = 2;
    while (descriptor === undefined) {
      try {
        descriptor = openSync(this.path, "wx", 0o600);
        writeFileSync(descriptor, `${JSON.stringify({ schema: "agent-bridge.edge-write-lock", version: 1, pid: process.pid, host: hostname() })}\n`);
      } catch (error) {
        if (descriptor !== undefined) throw error;
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        if (!liveLocalHolder(this.path)) {
          try { unlinkSync(this.path); } catch (removeError) {
            if (!(removeError && typeof removeError === "object" && "code" in removeError && removeError.code === "ENOENT")) throw removeError;
          }
          continue;
        }
        if (Date.now() >= deadline) throw new SQLiteWriteGateError();
        await delay(pause);
        pause = Math.min(Math.ceil(pause * 1.7), 25);
      }
    }
    try {
      return await work();
    } finally {
      try { closeSync(descriptor); } finally {
        if (existsSync(this.path)) rmSync(this.path, { force: true });
      }
    }
  }
}
