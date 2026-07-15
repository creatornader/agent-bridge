import { createHash } from "node:crypto";
import {
  canonicalJson, decodePortableArchive, parsePortableArchiveMessage, parsePortableArchiveReceipt,
  PORTABLE_ARCHIVE_BATCH_BYTES, PORTABLE_ARCHIVE_BATCH_ROWS, PORTABLE_ARCHIVE_MAX_BYTES, PORTABLE_ARCHIVE_MAX_LINE_BYTES,
  PortableArchiveError, validateArchiveWorkspace, validatePortableArchiveRequestId,
} from "./portable-archive-format.js";
import type {
  PortableArchiveExportSession, PortableArchiveImportPasses, PortableArchiveMessage,
  PortableArchiveMetadata, PortableArchiveReceipt, PortableArchiveResult, PortableArchiveStore,
} from "./portable-archive-store.js";

export async function streamPortableArchive(
  session: PortableArchiveExportSession,
  workspaceValue: string,
  exportRequestIdValue: string,
  write: (bytes: Buffer) => void | Promise<void>,
): Promise<PortableArchiveMetadata> {
  const workspace = validateArchiveWorkspace(workspaceValue);
  const exportRequestId = validatePortableArchiveRequestId(exportRequestIdValue);
  const hash = createHash("sha256");
  let messageCount = 0; let receiptCount = 0; let totalBytes = 0;
  const line = async (value: unknown, includeInDigest = true) => {
    const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
    if (bytes.length - 1 > PORTABLE_ARCHIVE_MAX_LINE_BYTES) throw new PortableArchiveError("archive export line exceeds 1 MiB");
    if (totalBytes + bytes.length > PORTABLE_ARCHIVE_MAX_BYTES) throw new PortableArchiveError("archive export exceeds maximum size");
    if (includeInDigest) hash.update(bytes);
    await write(bytes);
    totalBytes += bytes.length;
  };
  await line({ exportRequestId, format: "agent-bridge.portable-archive", kind: "header", version: 1, workspace });
  const messages = session.messages()[Symbol.asyncIterator]();
  let nextMessage = await messages.next();
  const receipts = session.receipts()[Symbol.asyncIterator]();
  let nextReceipt = await receipts.next();
  let previousMessage = "";
  while (!nextMessage.done) {
    const message = parsePortableArchiveMessage(nextMessage.value);
    const order = `${message.createdAt}\0${message.id}`;
    if (order <= previousMessage) throw new Error("archive export messages are duplicated or out of order");
    previousMessage = order;
    await line({ kind: "message", message }); messageCount += 1;
    let previousPrincipal = "";
    while (!nextReceipt.done && nextReceipt.value.messageId === message.id) {
      const receipt = parsePortableArchiveReceipt(nextReceipt.value);
      if (receipt.principal <= previousPrincipal) throw new Error("archive export receipts are duplicated or out of order");
      if (message.targets.length > 0 && !message.targets.includes(receipt.principal)) throw new Error("archive export receipt principal is not eligible");
      previousPrincipal = receipt.principal;
      await line({ kind: "receipt", receipt }); receiptCount += 1;
      nextReceipt = await receipts.next();
    }
    nextMessage = await messages.next();
  }
  if (!nextReceipt.done) throw new Error("archive export receipt references a missing message");
  const digest = `sha256:${hash.digest("hex")}`;
  await line({ digest, kind: "footer", messages: messageCount, receipts: receiptCount }, false);
  return { exportRequestId, workspace, digest, messageCount, receiptCount };
}

/** Small in-memory compatibility helper. It abandons the durable export audit. */
export async function exportPortableArchive(store: PortableArchiveStore, workspace: string, exportRequestIdValue: string): Promise<Buffer> {
  const exportRequestId = validatePortableArchiveRequestId(exportRequestIdValue);
  const start = await store.beginExport(exportRequestId, workspace);
  if (start.status === "completed") throw new PortableArchiveError("archive export request is already complete");
  const session = start.session;
  const chunks: Buffer[] = [];
  try {
    await streamPortableArchive(session, workspace, exportRequestId, (bytes) => { chunks.push(bytes); });
    await session.abandon("not_published");
    return Buffer.concat(chunks);
  } catch (error) {
    await session.abandon("stream_failed").catch(() => undefined);
    throw error;
  } finally { await session.close(); }
}

function inMemoryPasses(messages: PortableArchiveMessage[], receipts: PortableArchiveReceipt[]): PortableArchiveImportPasses {
  return {
    async *messageBatches() {
      let batch: PortableArchiveMessage[] = []; let bytes = 0;
      for (const message of messages) {
        const size = Buffer.byteLength(canonicalJson({ kind: "message", message })) + 1;
        if (batch.length && (batch.length === PORTABLE_ARCHIVE_BATCH_ROWS || bytes + size > PORTABLE_ARCHIVE_BATCH_BYTES)) { yield batch; batch = []; bytes = 0; }
        batch.push(message); bytes += size;
      }
      if (batch.length) yield batch;
    },
    async *receiptBatches() {
      let batch: PortableArchiveReceipt[] = []; let bytes = 0;
      for (const receipt of receipts) {
        const size = Buffer.byteLength(canonicalJson({ kind: "receipt", receipt })) + 1;
        if (batch.length && (batch.length === PORTABLE_ARCHIVE_BATCH_ROWS || bytes + size > PORTABLE_ARCHIVE_BATCH_BYTES)) { yield batch; batch = []; bytes = 0; }
        batch.push(receipt); bytes += size;
      }
      if (batch.length) yield batch;
    },
  };
}

/** Small in-memory compatibility helper. CLI imports use PortableArchiveFile instead. */
export async function importPortableArchive(
  store: PortableArchiveStore,
  bytes: Uint8Array,
  options: { requestId: string; apply?: boolean },
): Promise<PortableArchiveResult> {
  const archive = decodePortableArchive(bytes);
  const requestId = validatePortableArchiveRequestId(options.requestId);
  return store.importWorkspace(requestId, {
    exportRequestId: archive.exportRequestId, workspace: archive.workspace, digest: archive.digest,
    messageCount: archive.messages.length, receiptCount: archive.receipts.length,
  }, inMemoryPasses(archive.messages, archive.receipts), { apply: options.apply === true });
}
