import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgePrincipal } from "./bridge-domain.js";

export type ClientProvider = "local" | "gateway" | "legacy-supabase";

export interface ClientEnvironment extends NodeJS.ProcessEnv {
  AGENT_BRIDGE_PROVIDER?: string;
  AGENT_BRIDGE_URL?: string;
  AGENT_BRIDGE_KEY?: string;
  AGENT_BRIDGE_TOKEN?: string;
  AGENT_BRIDGE_AGENT?: string;
  AGENT_BRIDGE_WORKSPACE?: string;
  AGENT_BRIDGE_INSTANCE?: string;
  AGENT_BRIDGE_DB?: string;
  AGENT_BRIDGE_EDGE_DB?: string;
  AGENT_BRIDGE_CONFIG?: string;
  AGENT_BRIDGE_CURSOR?: string;
}

export interface ClientConfig {
  provider: ClientProvider;
  principal: BridgePrincipal;
  url?: string;
  credential?: string;
  databasePath: string;
  edgeDatabasePath: string;
  cursorPath: string;
  configPath: string;
}

function pathComponent(value: string): string {
  const readable = value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 48) || "_";
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${readable}-${suffix}`;
}

function clean(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function unquote(value: string): string {
  const input = value.trim();
  if (input.length > 1 && ((input[0] === '"' && input[input.length - 1] === '"') || (input[0] === "'" && input[input.length - 1] === "'"))) return input.slice(1, -1);
  return input;
}

export function readClientConfigFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const result: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0) result[line.slice(0, separator).trim()] = unquote(line.slice(separator + 1));
  }
  return result;
}

export function resolveClientConfig(
  env: ClientEnvironment = process.env,
  explicitAgent?: string,
): ClientConfig {
  const home = clean(env.HOME) ?? homedir();
  const configPath = clean(env.AGENT_BRIDGE_CONFIG) ?? join(home, ".agent-bridge", "config");
  const file = readClientConfigFile(configPath);
  const value = (key: keyof ClientEnvironment) => clean(env[key]) ?? clean(file[key]);
  const rawProvider = value("AGENT_BRIDGE_PROVIDER") ?? (value("AGENT_BRIDGE_TOKEN") ? "gateway" : value("AGENT_BRIDGE_URL") ? "legacy-supabase" : "local");
  const provider = rawProvider === "legacy" || rawProvider === "supabase" ? "legacy-supabase" : rawProvider;
  if (!(["local", "gateway", "legacy-supabase"] as string[]).includes(provider)) throw new Error(`Unsupported AGENT_BRIDGE_PROVIDER: ${rawProvider}`);
  // Identity belongs to the active client process. A shared config file must
  // never make one runtime impersonate the client that initialized the bridge.
  const configuredAgent = clean(env.AGENT_BRIDGE_AGENT);
  const requestedAgent = clean(explicitAgent);
  if (configuredAgent && requestedAgent && configuredAgent !== requestedAgent) {
    throw new Error(`source must match AGENT_BRIDGE_AGENT (${configuredAgent}); got ${requestedAgent}`);
  }
  const agent = requestedAgent ?? configuredAgent;
  if (!agent) throw new Error("AGENT_BRIDGE_AGENT is required");
  const url = value("AGENT_BRIDGE_URL");
  const credential = provider === "gateway" ? value("AGENT_BRIDGE_TOKEN") : value("AGENT_BRIDGE_KEY");
  if (provider !== "local" && (!url || !credential)) throw new Error(`${provider} requires AGENT_BRIDGE_URL and ${provider === "gateway" ? "AGENT_BRIDGE_TOKEN" : "AGENT_BRIDGE_KEY"}`);
  const workspace = provider === "legacy-supabase"
    ? "*"
    : value("AGENT_BRIDGE_WORKSPACE") ?? "default";
  const instance = clean(env.AGENT_BRIDGE_INSTANCE);
  const databasePath = value("AGENT_BRIDGE_DB") ?? join(home, ".agent-bridge", "bridge.sqlite3");
  const edgeDatabasePath = value("AGENT_BRIDGE_EDGE_DB") ?? join(home, ".agent-bridge", "edge.sqlite3");
  const cursorScope = createHash("sha256")
    .update(`${provider}\0${provider === "local" ? databasePath : url}`)
    .digest("hex")
    .slice(0, 16);
  return {
    provider: provider as ClientProvider,
    principal: { workspace, agent, instance },
    url,
    credential,
    databasePath,
    edgeDatabasePath,
    cursorPath: value("AGENT_BRIDGE_CURSOR") ?? join(
      home,
      ".agent-bridge",
      "cursors",
      pathComponent(provider),
      cursorScope,
      pathComponent(workspace),
      pathComponent(agent),
      pathComponent(instance ?? "default"),
    ),
    configPath,
  };
}
