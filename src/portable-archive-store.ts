import type { DeliveryPolicy, JsonValue, MessagePriority } from "./bridge-domain.js";

export interface PortableArchiveMessage {
  id: string; project: string | null; source: string; type: string; content: string;
  contentType: string; data: JsonValue | null; targets: string[]; threadId: string | null;
  replyToId: string | null; correlationId: string | null; causationId: string | null;
  priority: MessagePriority; expiresAt: string | null; idempotencyKey: string | null;
  atribReceiptId: string | null; informedBy: string[]; metadata: JsonValue | null;
  deliveryPolicy: DeliveryPolicy; createdAt: string;
}

export interface PortableArchiveReceipt { messageId: string; principal: string; readAt: string }

/** In-memory helper used by format tests and small programmatic archives. Stores do not use it. */
export interface PortableArchiveContents {
  exportRequestId: string;
  workspace: string;
  messages: PortableArchiveMessage[];
  receipts: PortableArchiveReceipt[];
  digest?: string;
}

export interface PortableArchiveMetadata {
  exportRequestId: string;
  workspace: string;
  digest: string;
  messageCount: number;
  receiptCount: number;
}

export type PortableArchiveAbandonCode = "stream_failed" | "snapshot_failed" | "publication_failed" | "audit_failed" | "not_published";

export interface PortableArchiveExportSession {
  messages(): AsyncIterable<PortableArchiveMessage>;
  receipts(): AsyncIterable<PortableArchiveReceipt>;
  complete(result: PortableArchiveMetadata & { publishedAt: string }): Promise<void>;
  reconcile(result: PortableArchiveMetadata & { publishedAt: string }): Promise<void>;
  abandon(reason: PortableArchiveAbandonCode): Promise<void>;
  close(): Promise<void> | void;
}

export type PortableArchiveExportStart =
  | { status: "active"; session: PortableArchiveExportSession; replayed: boolean }
  | { status: "completed"; metadata: PortableArchiveMetadata & { publishedAt: string } };

export interface PortableArchiveImportPasses {
  messageBatches(): AsyncIterable<readonly PortableArchiveMessage[]>;
  receiptBatches(): AsyncIterable<readonly PortableArchiveReceipt[]>;
}

export interface PortableArchiveResult {
  requestId: string; workspace: string; digest: string; apply: boolean;
  messages: { created: number; replayed: number };
  receipts: { created: number; replayed: number };
}

export interface PortableArchiveStore {
  beginExport(requestId: string, workspace: string): Promise<PortableArchiveExportStart>;
  importWorkspace(
    requestId: string,
    metadata: PortableArchiveMetadata,
    passes: PortableArchiveImportPasses,
    options: { apply: boolean },
  ): Promise<PortableArchiveResult>;
  close?(): Promise<void> | void;
}
