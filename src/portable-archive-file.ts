import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, type Stats,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { verifyPrivatePathAccess } from "./private-path.js";
import {
  canonicalJson, parsePortableArchiveMessage, parsePortableArchiveReceipt,
  PORTABLE_ARCHIVE_BATCH_BYTES, PORTABLE_ARCHIVE_BATCH_ROWS, PORTABLE_ARCHIVE_FORMAT, PORTABLE_ARCHIVE_MAX_BYTES, PORTABLE_ARCHIVE_MAX_LINE_BYTES,
  PORTABLE_ARCHIVE_VERSION, PortableArchiveError, validateArchiveWorkspace,
  validatePortableArchiveRequestId,
} from "./portable-archive-format.js";
import type {
  PortableArchiveImportPasses, PortableArchiveMessage, PortableArchiveMetadata,
  PortableArchiveReceipt,
} from "./portable-archive-store.js";

type ParsedRecord =
  | { kind: "header"; requestId: string; workspace: string }
  | { kind: "message"; message: PortableArchiveMessage }
  | { kind: "receipt"; receipt: PortableArchiveReceipt }
  | { kind: "footer"; digest: string; messages: number; receipts: number };

function exact(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PortableArchiveError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort(); const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) throw new PortableArchiveError(`${label} has unexpected fields`);
  return record;
}

function parseLine(bytes: Buffer, lineNumber: number): { raw: Buffer; record: ParsedRecord } {
  if (!bytes.length || bytes.length > PORTABLE_ARCHIVE_MAX_LINE_BYTES || bytes.includes(0x0d) || bytes.includes(0x00)) {
    throw new PortableArchiveError(`archive line ${lineNumber} is invalid`);
  }
  if (lineNumber === 1 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new PortableArchiveError("archive must not contain a BOM");
  let line: string;
  try { line = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new PortableArchiveError(`archive line ${lineNumber} is not valid UTF-8`); }
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new PortableArchiveError(`archive line ${lineNumber} contains invalid JSON`); }
  if (canonicalJson(value) !== line) throw new PortableArchiveError(`archive line ${lineNumber} contains noncanonical JSON`);
  const outer = value as Record<string, unknown>;
  let record: ParsedRecord;
  if (outer.kind === "header") {
    const header = exact(value, ["exportRequestId", "format", "kind", "version", "workspace"], "header");
    if (header.format !== PORTABLE_ARCHIVE_FORMAT || header.version !== PORTABLE_ARCHIVE_VERSION) throw new PortableArchiveError("unsupported archive header");
    const requestId = validatePortableArchiveRequestId(header.exportRequestId);
    if (requestId !== header.exportRequestId) throw new PortableArchiveError("archive header exportRequestId is not canonical");
    record = { kind: "header", requestId, workspace: validateArchiveWorkspace(header.workspace) };
  } else if (outer.kind === "message") {
    const wrapped = exact(value, ["kind", "message"], "message record");
    record = { kind: "message", message: parsePortableArchiveMessage(wrapped.message) };
  } else if (outer.kind === "receipt") {
    const wrapped = exact(value, ["kind", "receipt"], "receipt record");
    record = { kind: "receipt", receipt: parsePortableArchiveReceipt(wrapped.receipt) };
  } else if (outer.kind === "footer") {
    const footer = exact(value, ["digest", "kind", "messages", "receipts"], "footer");
    if (typeof footer.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(footer.digest)
      || !Number.isSafeInteger(footer.messages) || Number(footer.messages) < 0
      || !Number.isSafeInteger(footer.receipts) || Number(footer.receipts) < 0) throw new PortableArchiveError("invalid archive footer");
    record = { kind: "footer", digest: footer.digest, messages: Number(footer.messages), receipts: Number(footer.receipts) };
  } else throw new PortableArchiveError(`archive line ${lineNumber} has an unknown record kind`);
  return { raw: bytes, record };
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export class PortableArchiveFile implements PortableArchiveImportPasses {
  readonly path: string;
  private readonly descriptor: number;
  private readonly identity: Stats;
  private closed = false;
  private verified?: PortableArchiveMetadata;

  constructor(path: string) {
    const target = resolve(path);
    this.path = target;
    verifyPrivatePathAccess(dirname(target), "directory");
    verifyPrivatePathAccess(target, "file");
    const before = lstatSync(target);
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    this.descriptor = openSync(target, constants.O_RDWR | noFollow);
    try {
      this.identity = fstatSync(this.descriptor);
      const after = lstatSync(target);
      if (!this.identity.isFile() || before.isSymbolicLink() || !sameFile(before, this.identity) || !sameFile(after, this.identity)) {
        throw new PortableArchiveError("archive path identity changed or is not a regular file");
      }
      if (this.identity.size < 1 || this.identity.size > PORTABLE_ARCHIVE_MAX_BYTES) throw new PortableArchiveError("archive size is invalid");
    } catch (error) { closeSync(this.descriptor); throw error; }
  }

  private assertIdentity(): void {
    if (this.closed) throw new PortableArchiveError("archive file is closed");
    if (!sameFile(this.identity, fstatSync(this.descriptor))) throw new PortableArchiveError("archive file changed between passes");
  }

  private *lines(): Generator<{ raw: Buffer; record: ParsedRecord }> {
    this.assertIdentity();
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0; let pending = Buffer.alloc(0); let lineNumber = 0; let endedWithLf = false;
    while (position < this.identity.size) {
      const read = readSync(this.descriptor, chunk, 0, Math.min(chunk.length, this.identity.size - position), position);
      if (read <= 0) throw new PortableArchiveError("archive ended before its recorded size");
      position += read;
      const input = pending.length ? Buffer.concat([pending, chunk.subarray(0, read)]) : Buffer.from(chunk.subarray(0, read));
      let start = 0;
      for (let index = 0; index < input.length; index += 1) {
        if (input[index] !== 0x0a) continue;
        const line = input.subarray(start, index); lineNumber += 1; endedWithLf = true;
        yield parseLine(line, lineNumber); start = index + 1;
      }
      pending = Buffer.from(input.subarray(start));
      if (pending.length > PORTABLE_ARCHIVE_MAX_LINE_BYTES) throw new PortableArchiveError("archive line exceeds 1 MiB");
      if (pending.length) endedWithLf = false;
    }
    if (pending.length || !endedWithLf) throw new PortableArchiveError("archive must end with one LF");
    this.assertIdentity();
  }

  private *validatedRecords(expected?: PortableArchiveMetadata): Generator<ParsedRecord, PortableArchiveMetadata> {
    const digest = createHash("sha256");
    let requestId: string | undefined; let workspace: string | undefined; let footer: Extract<ParsedRecord, { kind: "footer" }> | undefined;
    let messages = 0; let receipts = 0; let previousMessage = ""; let currentMessage: PortableArchiveMessage | undefined; let previousPrincipal = "";
    let lineNumber = 0;
    for (const { raw, record } of this.lines()) {
      lineNumber += 1;
      if (footer) throw new PortableArchiveError("archive contains records after the footer");
      if (record.kind !== "footer") digest.update(raw).update("\n");
      if (lineNumber === 1) {
        if (record.kind !== "header") throw new PortableArchiveError("archive must start with one header");
        requestId = record.requestId; workspace = record.workspace; continue;
      }
      if (record.kind === "header") throw new PortableArchiveError("archive contains more than one header");
      if (record.kind === "message") {
        const order = `${record.message.createdAt}\0${record.message.id}`;
        if (order <= previousMessage) throw new PortableArchiveError("messages are duplicated or out of order");
        previousMessage = order; currentMessage = record.message; previousPrincipal = ""; messages += 1; yield record;
      } else if (record.kind === "receipt") {
        if (!currentMessage || record.receipt.messageId !== currentMessage.id || record.receipt.principal <= previousPrincipal) throw new PortableArchiveError("receipts are out of order or not adjacent to their message");
        if (currentMessage.targets.length > 0 && !currentMessage.targets.includes(record.receipt.principal)) throw new PortableArchiveError("receipt principal is not eligible for the message");
        previousPrincipal = record.receipt.principal; receipts += 1; yield record;
      } else footer = record;
    }
    if (!requestId || !workspace || !footer) throw new PortableArchiveError("archive footer is missing");
    const calculated = `sha256:${digest.digest("hex")}`;
    if (footer.digest !== calculated || footer.messages !== messages || footer.receipts !== receipts) throw new PortableArchiveError("archive footer verification failed");
    const metadata = { exportRequestId: requestId, workspace, digest: calculated, messageCount: messages, receiptCount: receipts };
    if (expected && (expected.exportRequestId !== metadata.exportRequestId || expected.workspace !== metadata.workspace || expected.digest !== metadata.digest
      || expected.messageCount !== metadata.messageCount || expected.receiptCount !== metadata.receiptCount)) {
      throw new PortableArchiveError("archive changed between passes");
    }
    return metadata;
  }

  verify(): PortableArchiveMetadata {
    const iterator = this.validatedRecords();
    let next = iterator.next(); while (!next.done) next = iterator.next();
    this.verified = next.value;
    return next.value;
  }

  proveDurable(): void {
    this.assertIdentity();
    const before = lstatSync(this.path);
    if (before.isSymbolicLink() || !sameFile(this.identity, before)) throw new PortableArchiveError("archive path changed before durability proof");
    fsyncSync(this.descriptor);
    const afterFileSync = lstatSync(this.path);
    if (afterFileSync.isSymbolicLink() || !sameFile(this.identity, afterFileSync)) throw new PortableArchiveError("archive path changed during durability proof");
    if (process.platform !== "win32") {
      const directory = openSync(dirname(this.path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    const afterDirectorySync = lstatSync(this.path);
    if (afterDirectorySync.isSymbolicLink() || !sameFile(this.identity, afterDirectorySync)) throw new PortableArchiveError("archive path changed during durability proof");
  }

  async *messageBatches(): AsyncIterable<readonly PortableArchiveMessage[]> {
    const batch: PortableArchiveMessage[] = [];
    let batchBytes = 0;
    const expected = this.verified ?? this.verify();
    for (const record of this.validatedRecords(expected)) {
      if (record.kind === "message") {
        const bytes = Buffer.byteLength(canonicalJson({ kind: "message", message: record.message })) + 1;
        if (batch.length && (batch.length === PORTABLE_ARCHIVE_BATCH_ROWS || batchBytes + bytes > PORTABLE_ARCHIVE_BATCH_BYTES)) {
          yield batch.splice(0); batchBytes = 0;
        }
        batch.push(record.message);
        batchBytes += bytes;
      }
    }
    if (batch.length) yield batch;
  }

  async *receiptBatches(): AsyncIterable<readonly PortableArchiveReceipt[]> {
    const batch: PortableArchiveReceipt[] = [];
    let batchBytes = 0;
    const expected = this.verified ?? this.verify();
    for (const record of this.validatedRecords(expected)) {
      if (record.kind === "receipt") {
        const bytes = Buffer.byteLength(canonicalJson({ kind: "receipt", receipt: record.receipt })) + 1;
        if (batch.length && (batch.length === PORTABLE_ARCHIVE_BATCH_ROWS || batchBytes + bytes > PORTABLE_ARCHIVE_BATCH_BYTES)) {
          yield batch.splice(0); batchBytes = 0;
        }
        batch.push(record.receipt);
        batchBytes += bytes;
      }
    }
    if (batch.length) yield batch;
  }

  close(): void { if (!this.closed) { this.closed = true; closeSync(this.descriptor); } }
}
