import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { BridgeService } from "./bridge-service.js";
import type { BridgeStore } from "./bridge-store.js";
import { HttpBridgeStore } from "./http-bridge-store.js";
import { type EdgeDrainLease, SQLiteEdgeStore } from "./sqlite-edge-store.js";
import { SyncingBridgeStore } from "./syncing-bridge-store.js";
import { LegacySupabaseRestStore } from "./legacy-supabase-store.js";
import { SQLiteBridgeStore } from "./sqlite-bridge-store.js";
import type { ClientConfig } from "./client-config.js";
import { securePrivatePath } from "./private-path.js";

export interface ClientRuntime { config: ClientConfig; store: BridgeStore; service: BridgeService; close(): Promise<void>; }
export interface ClientRuntimeOptions {
  autoSync?: boolean;
  initializationMode?: "active" | "passive";
  edgeDrainLease?: EdgeDrainLease;
}

function prepareStoreDirectory(path: string): void {
  const directory = dirname(path);
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existed || basename(directory) === ".agent-bridge") securePrivatePath(directory, "directory");
}

export function createStore(config: ClientConfig, options: ClientRuntimeOptions = {}): BridgeStore {
  if (config.provider === "local") {
    if (config.databasePath !== ":memory:") prepareStoreDirectory(config.databasePath);
    return new SQLiteBridgeStore(config.databasePath);
  }
  if (config.provider === "gateway") {
    prepareStoreDirectory(config.edgeDatabasePath);
    const remote = new HttpBridgeStore({ baseUrl: config.url!, token: config.credential!, principal: config.principal });
    const edge = new SQLiteEdgeStore(config.edgeDatabasePath, { endpoint: config.url!, principal: config.principal });
    return new SyncingBridgeStore(edge, remote, config.principal, {
      autoSync: options.autoSync,
      edgeDrainLease: options.edgeDrainLease,
    });
  }
  return new LegacySupabaseRestStore(config.url!, config.credential!);
}

export async function createClientRuntime(config: ClientConfig, options: ClientRuntimeOptions = {}): Promise<ClientRuntime> {
  const store = createStore(config, options);
  await store.initialize({ mode: options.initializationMode });
  return { config, store, service: new BridgeService(store), close: async () => { await store.close?.(); } };
}
