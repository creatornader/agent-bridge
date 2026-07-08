import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { normalizeReceiptId } from "./atrib-receipt.js";
import {
  buildMessageEnvelope,
  filterContextRows,
  mergeEnvelopeMetadata,
} from "./message-envelope.js";
import { resolvePostSource } from "./source-identity.js";

export interface AgentBridgeServerConfig {
  supabaseUrl: string;
  supabaseKey: string;
  agent?: string;
}

export interface AgentBridgeServerEnv {
  AGENT_BRIDGE_URL?: string;
  AGENT_BRIDGE_KEY?: string;
  AGENT_BRIDGE_AGENT?: string;
  AGENT_BRIDGE_CONFIG?: string;
  HOME?: string;
}

function normalizedConfigValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function defaultConfigPath(env: AgentBridgeServerEnv): string {
  return (
    normalizedConfigValue(env.AGENT_BRIDGE_CONFIG) ??
    join(normalizedConfigValue(env.HOME) ?? homedir(), ".agent-bridge", "config")
  );
}

function unquoteShellValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function readConfigFile(
  configPath: string,
): Pick<Partial<AgentBridgeServerEnv>, "AGENT_BRIDGE_URL" | "AGENT_BRIDGE_KEY"> {
  if (!existsSync(configPath)) {
    return {};
  }

  const parsed: Pick<
    Partial<AgentBridgeServerEnv>,
    "AGENT_BRIDGE_URL" | "AGENT_BRIDGE_KEY"
  > = {};

  for (const line of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = unquoteShellValue(trimmed.slice(separator + 1));
    if (key === "AGENT_BRIDGE_URL" || key === "AGENT_BRIDGE_KEY") {
      parsed[key] = value;
    }
  }

  return parsed;
}

export function configFromEnv(
  env: AgentBridgeServerEnv = process.env,
): AgentBridgeServerConfig {
  const fileConfig = readConfigFile(defaultConfigPath(env));
  const supabaseUrl =
    normalizedConfigValue(env.AGENT_BRIDGE_URL) ??
    normalizedConfigValue(fileConfig.AGENT_BRIDGE_URL);
  const supabaseKey =
    normalizedConfigValue(env.AGENT_BRIDGE_KEY) ??
    normalizedConfigValue(fileConfig.AGENT_BRIDGE_KEY);
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Missing AGENT_BRIDGE_URL or AGENT_BRIDGE_KEY environment variables or ~/.agent-bridge/config",
    );
  }
  return {
    supabaseUrl,
    supabaseKey,
    agent: normalizedConfigValue(env.AGENT_BRIDGE_AGENT),
  };
}

function buildSupabaseRequest(config: AgentBridgeServerConfig) {
  const restUrl = `${config.supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  const headers = {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  return async function supabaseRequest(
    path: string,
    options: RequestInit = {},
  ): Promise<unknown> {
    const url = `${restUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: { ...headers, ...(options.headers as Record<string, string>) },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase request failed (${res.status}): ${body}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
}

export function createAgentBridgeServer(
  config: AgentBridgeServerConfig,
): Server {
  const supabaseRequest = buildSupabaseRequest(config);
  const server = new Server(
    { name: "agent-bridge", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "post_context",
        description:
          "Post a shared context entry visible to all agents. Categories: operational, config-change, goal-update, flag, bridge-meta (for suggesting improvements to the Agent Bridge itself).",
        inputSchema: {
          type: "object" as const,
          properties: {
            source: {
              type: "string",
              description:
                "Agent posting this entry. Must match AGENT_BRIDGE_AGENT when configured.",
            },
            category: {
              type: "string",
              description:
                "Entry type: operational | config-change | goal-update | flag | bridge-meta",
            },
            content: {
              type: "string",
              description: "The context message",
            },
            priority: {
              type: "string",
              description: "info (default) | high | urgent",
            },
            project: {
              type: "string",
              description:
                "Scope to a project (e.g. project-a, project-b). Omit for cross-project.",
            },
            metadata: {
              type: "object",
              description: "Arbitrary structured data",
            },
            message_id: {
              type: "string",
              description:
                "Stable message id. Generated by the bridge when omitted.",
            },
            target_agents: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional target agent names. Empty or omitted means broadcast.",
            },
            thread_id: {
              type: "string",
              description: "Optional conversation/thread id.",
            },
            reply_to_id: {
              type: "string",
              description: "Optional parent message id for reply threading.",
            },
            kind: {
              type: "string",
              description:
                "Message kind: operational | config-change | goal-update | flag | bridge-meta | handoff | request | result",
            },
            payload_mime: {
              type: "string",
              description:
                "Payload MIME type. Defaults to text/plain for the content column.",
            },
            payload: {
              anyOf: [
                { type: "object" },
                { type: "array" },
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "null" },
              ],
              description:
                "Optional structured payload stored in metadata.message_envelope.",
            },
            payload_ref: {
              type: "string",
              description: "Optional external blob pointer for large payloads.",
            },
            payload_ciphertext: {
              type: "string",
              description:
                "Optional inline encrypted payload for small encrypted messages.",
            },
            informed_by: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional atrib record hashes (sha256:<64-hex>) this message depends on.",
            },
            expires_at: {
              type: "string",
              description: "Optional ISO timestamp retention boundary.",
            },
            atrib_receipt_id: {
              type: "string",
              description:
                "Optional. Signed atrib record receipt_id for the wrapper that signed this post_context call. Set automatically by an atrib-signing wrapper; consumers reading the row use this as the informed_by anchor for cross-process causal edges.",
            },
          },
          required: ["source", "category", "content"],
        },
      },
      {
        name: "get_context",
        description:
          "Read shared context entries, newest first. Filter by source, category, project, or unacknowledged entries.",
        inputSchema: {
          type: "object" as const,
          properties: {
            since: {
              type: "string",
              description: "ISO timestamp. Only entries after this time",
            },
            source: {
              type: "string",
              description: "Filter by posting agent",
            },
            category: {
              type: "string",
              description: "Filter by category",
            },
            project: {
              type: "string",
              description: "Filter by project scope",
            },
            unacked_by: {
              type: "string",
              description:
                "Only entries NOT yet acknowledged by this agent name",
            },
            limit: {
              type: "number",
              description: "Max entries to return (default 20)",
            },
            target_agent: {
              type: "string",
              description:
                "Return broadcast entries plus entries targeted to this agent.",
            },
            thread_id: {
              type: "string",
              description: "Filter by metadata.message_envelope.thread_id.",
            },
            kind: {
              type: "string",
              description: "Filter by metadata.message_envelope.kind.",
            },
          },
        },
      },
      {
        name: "ack_context",
        description:
          "Acknowledge context entries so they won't appear in unacked queries for this agent.",
        inputSchema: {
          type: "object" as const,
          properties: {
            ids: {
              type: "array",
              items: { type: "number" },
              description: "Entry IDs to acknowledge",
            },
            agent: {
              type: "string",
              description: "Agent name acknowledging (e.g. claude-code)",
            },
          },
          required: ["ids", "agent"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "post_context": {
        let source: string | undefined;
        try {
          source = resolvePostSource(args?.source, config.agent);
        } catch (e) {
          throw new McpError(
            ErrorCode.InvalidParams,
            e instanceof Error ? e.message : "source identity mismatch",
          );
        }
        const postArgs = { ...(args ?? {}), source };
        const receiptId = normalizeReceiptId(args?.atrib_receipt_id);
        const envelope = buildMessageEnvelope(postArgs, receiptId);
        const body: Record<string, unknown> = {
          source,
          category: args?.category,
          content: args?.content,
          priority: args?.priority || "info",
          project: args?.project || null,
          metadata: mergeEnvelopeMetadata(args?.metadata, envelope),
        };
        // Optional cross-tool causal anchor; written when an atrib-signing
        // wrapper signs this call before forwarding. Format-validated so
        // unexpected producers cannot pollute the column with garbage.
        if (receiptId) {
          body.atrib_receipt_id = receiptId;
        }
        const data = await supabaseRequest("/shared_context", {
          method: "POST",
          body: JSON.stringify(body),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }

      case "get_context": {
        const requestedLimit =
          typeof args?.limit === "number" && args.limit > 0
            ? Math.trunc(args.limit)
            : 20;
        const hasEnvelopeFilter = Boolean(
          args?.target_agent || args?.thread_id || args?.kind,
        );
        const fetchLimit = hasEnvelopeFilter
          ? Math.min(Math.max(requestedLimit * 5, 50), 200)
          : requestedLimit;
        const params: string[] = [
          "order=created_at.desc",
          `limit=${fetchLimit}`,
        ];
        if (args?.since)
          params.push(
            `created_at=gte.${encodeURIComponent(String(args.since))}`,
          );
        if (args?.source)
          params.push(`source=eq.${encodeURIComponent(String(args.source))}`);
        if (args?.category)
          params.push(
            `category=eq.${encodeURIComponent(String(args.category))}`,
          );
        if (args?.project)
          params.push(`project=eq.${encodeURIComponent(String(args.project))}`);
        if (args?.unacked_by)
          params.push(
            `acked_by=not.cs.%7B${encodeURIComponent(String(args.unacked_by))}%7D`,
          );

        const data = await supabaseRequest(
          `/shared_context?${params.join("&")}`,
        );
        const filtered = filterContextRows(data, args, requestedLimit);
        return {
          content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
        };
      }

      case "ack_context": {
        const ids = args?.ids as number[];
        const agent = args?.agent as string;
        if (!ids?.length || !agent) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "ids (number[]) and agent (string) are required",
          );
        }
        const data = await supabaseRequest("/rpc/ack_context", {
          method: "POST",
          body: JSON.stringify({ entry_ids: ids, agent_name: agent }),
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ acknowledged: data, agent }),
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  });

  return server;
}

export async function startServer(
  config: AgentBridgeServerConfig = configFromEnv(),
) {
  const server = createAgentBridgeServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
