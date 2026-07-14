import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

import { normalizeReceiptId } from "./atrib-receipt.js";
import {
  buildMessageEnvelope,
  filterContextRows,
  mergeEnvelopeMetadata,
} from "./message-envelope.js";
import { resolveAgentIdentity, resolvePostSource } from "./source-identity.js";
import { BridgeService } from "./bridge-service.js";
import {
  BridgeValidationError,
  validateProject,
  validateMessageDraft,
  type BridgePrincipal,
  type MessageDraft,
  type RetryPolicy,
} from "./bridge-domain.js";
import { createStore } from "./client-runtime.js";
import { legacyContextMetadata, legacyNumericMessageId } from "./legacy-compat.js";
import {
  readClientConfigFile,
  resolveClientConfig,
  type ClientConfig,
  type ClientEnvironment,
  type ClientProvider,
} from "./client-config.js";

export interface AgentBridgeServerConfig {
  supabaseUrl?: string;
  supabaseKey?: string;
  agent?: string;
  provider?: ClientProvider;
  workspace?: string;
  instance?: string;
  databasePath?: string;
  edgeDatabasePath?: string;
  cursorPath?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
}

const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export interface AgentBridgeServerEnv {
  AGENT_BRIDGE_URL?: string;
  AGENT_BRIDGE_KEY?: string;
  AGENT_BRIDGE_AGENT?: string;
  AGENT_BRIDGE_CONFIG?: string;
  HOME?: string;
  AGENT_BRIDGE_PROVIDER?: string;
  AGENT_BRIDGE_TOKEN?: string;
  AGENT_BRIDGE_WORKSPACE?: string;
  AGENT_BRIDGE_INSTANCE?: string;
  AGENT_BRIDGE_DB?: string;
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

export function configFromEnv(
  env: AgentBridgeServerEnv = process.env,
): AgentBridgeServerConfig {
  const sharedFile = readClientConfigFile(defaultConfigPath(env));
  const value = (key: keyof AgentBridgeServerEnv) =>
    normalizedConfigValue(env[key]) ?? normalizedConfigValue(sharedFile[key]);
  const runtimeAgent = normalizedConfigValue(env.AGENT_BRIDGE_AGENT);
  const rawProvider = normalizedConfigValue(env.AGENT_BRIDGE_PROVIDER) ??
    normalizedConfigValue(sharedFile.AGENT_BRIDGE_PROVIDER);
  const provider = rawProvider === "legacy" || rawProvider === "supabase"
    ? "legacy-supabase"
    : rawProvider ?? (value("AGENT_BRIDGE_TOKEN") ? "gateway" : "legacy-supabase");
  if (!(["local", "gateway", "legacy-supabase"] as string[]).includes(provider)) {
    throw new Error(`Unsupported AGENT_BRIDGE_PROVIDER: ${rawProvider}`);
  }
  if (provider === "local" || provider === "gateway") {
    const client = resolveClientConfig(env as ClientEnvironment);
    return {
      provider: client.provider,
      agent: client.principal.agent,
      workspace: client.principal.workspace,
      instance: client.principal.instance,
      databasePath: client.databasePath,
      edgeDatabasePath: client.edgeDatabasePath,
      cursorPath: client.cursorPath,
      gatewayUrl: client.provider === "gateway" ? client.url : undefined,
      gatewayToken: client.provider === "gateway" ? client.credential : undefined,
    };
  }
  const supabaseUrl =
    value("AGENT_BRIDGE_URL");
  const supabaseKey =
    value("AGENT_BRIDGE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Missing AGENT_BRIDGE_URL or AGENT_BRIDGE_KEY environment variables or ~/.agent-bridge/config",
    );
  }
  return {
    supabaseUrl,
    supabaseKey,
    agent: runtimeAgent,
    provider: provider as ClientProvider,
    workspace: value("AGENT_BRIDGE_WORKSPACE") ?? "*",
    instance: normalizedConfigValue(env.AGENT_BRIDGE_INSTANCE),
  };
}

function buildSupabaseRequest(config: AgentBridgeServerConfig & { supabaseUrl: string; supabaseKey: string }) {
  const parsed = new URL(config.supabaseUrl);
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("Agent Bridge requires HTTPS for non-loopback legacy providers");
  }
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
      signal: options.signal ?? AbortSignal.timeout(10_000),
      headers: { ...headers, ...(options.headers as Record<string, string>) },
    });
    if (!res.ok) {
      throw new Error(`Supabase request failed (${res.status})`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
}

export function createAgentBridgeServer(
  config: AgentBridgeServerConfig,
): Server {
  const supabaseRequest = config.supabaseUrl && config.supabaseKey ? buildSupabaseRequest(config as AgentBridgeServerConfig & { supabaseUrl: string; supabaseKey: string }) : undefined;
  const provider = config.provider ?? (config.gatewayToken ? "gateway" : config.supabaseUrl ? "legacy-supabase" : "local");
  const principal: BridgePrincipal | undefined = config.agent ? {
    workspace: provider === "legacy-supabase" ? "*" : config.workspace ?? "default",
    agent: config.agent,
    instance: config.instance,
  } : undefined;
  const clientConfig: ClientConfig | undefined = principal ? {
    provider, principal,
    url: config.gatewayUrl ?? config.supabaseUrl, credential: config.gatewayToken ?? config.supabaseKey,
    databasePath: config.databasePath ?? ":memory:", edgeDatabasePath: config.edgeDatabasePath ?? config.databasePath ?? ":memory:", cursorPath: config.cursorPath ?? "", configPath: "",
  } : undefined;
  const store = clientConfig ? createStore(clientConfig) : undefined;
  const service = store ? new BridgeService(store) : undefined;
  const deliveryToolsAvailable = Boolean(
    service && clientConfig?.provider !== "legacy-supabase",
  );
  const server = new Server(
    { name: "agent-bridge", version: packageVersion },
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
                "Optional posting agent. Defaults to AGENT_BRIDGE_AGENT when configured; an explicit value must match it.",
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
                "Optional immutable message label. Omit for an unlabeled message.",
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
          required: ["category", "content"],
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
              description: "Filter by an exact project label",
            },
            unacked_by: {
              type: "string",
              description:
                "Only entries NOT yet acknowledged by this agent name. Defaults to AGENT_BRIDGE_AGENT when configured.",
            },
            limit: {
              type: "number",
              description: "Max entries to return (default 20)",
              minimum: 1,
              maximum: 200,
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
        outputSchema: {
          type: "object" as const,
          properties: {
            entries: { type: "array", items: { type: "object", additionalProperties: true } },
            source: { type: "string", enum: ["remote", "cache"] },
            stale: { type: "boolean" }, degraded: { type: "boolean" },
            acknowledgements: { type: "string", enum: ["authoritative", "unknown"] },
            lastSyncedAt: { type: ["string", "null"] },
          },
          required: ["entries"],
          additionalProperties: false,
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
              items: { anyOf: [{ type: "number" }, { type: "string" }] },
              description: "Legacy numeric entry IDs or v2 UUID message IDs to acknowledge",
            },
            agent: {
              type: "string",
              description:
                "Optional acknowledging agent. Defaults to AGENT_BRIDGE_AGENT when configured; an explicit value must match it.",
            },
          },
          required: ["ids"],
        },
      },
      ...(service ? [{
        name: "send",
        description: "Create an immutable Agent Bridge v2 message.",
        inputSchema: {
          type: "object" as const,
          properties: {
            source: { type: "string", description: "Optional identity assertion; must match AGENT_BRIDGE_AGENT." },
            project: { type: "string", description: "Optional immutable message label." },
            type: { type: "string" }, content: { type: "string" }, contentType: { type: "string" },
            data: {}, targets: { type: "array", items: { type: "string" } },
            threadId: { type: "string" }, replyToId: { type: "string" }, correlationId: { type: "string" }, causationId: { type: "string" },
            priority: { type: "string", enum: ["info", "high", "urgent"] }, expiresAt: { type: "string" },
            idempotencyKey: { type: "string" }, atribReceiptId: { type: "string" },
            informedBy: { type: "array", items: { type: "string" } }, metadata: {},
          },
          required: ["type", "content"],
          additionalProperties: false,
        },
        outputSchema: { type: "object" as const, properties: { created: { type: "boolean" }, message: { type: "object", additionalProperties: true } }, required: ["created", "message"] },
      },
      {
        name: "history",
        description: "Read visible Agent Bridge v2 messages after an opaque cursor.",
        inputSchema: { type: "object" as const, properties: {
          cursor: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 200 }, types: { type: "array", items: { type: "string" } },
          includeExpired: { type: "boolean" }, source: { type: "string" }, project: { type: "string" }, since: { type: "string" }, unacknowledgedBy: { type: "string" },
          threadId: { type: "string" }, latest: { type: "boolean" },
        }, additionalProperties: false },
        outputSchema: { type: "object" as const, properties: {
          messages: { type: "array", items: { type: "object", additionalProperties: true } },
          cursor: { type: "string" }, source: { type: "string", enum: ["remote", "cache"] },
          stale: { type: "boolean" }, degraded: { type: "boolean" },
          acknowledgements: { type: "string", enum: ["authoritative", "unknown"] },
          lastSyncedAt: { type: "string" },
        }, required: ["messages"], additionalProperties: false },
      }] : []),
      ...(store?.sync ? [{
        name: "sync",
        description: "Manually replay the gateway outbox and refresh the local inbox cache.",
        inputSchema: { type: "object" as const, properties: {
          maxPush: { type: "number", minimum: 0, maximum: 1000 },
          maxPages: { type: "number", minimum: 0, maximum: 100 },
        }, additionalProperties: false },
        outputSchema: { type: "object" as const, properties: {
          online: { type: "boolean" }, pushed: { type: "number" }, deduplicated: { type: "number" },
          pulled: { type: "number" }, pending: { type: "number" }, blocked: { type: "number" },
          cached: { type: "number" }, cursor: { type: "string" }, lastSyncedAt: { type: "string" },
          lastError: { type: "string" }, failureRetryable: { type: "boolean" },
        }, required: ["online", "pushed", "deduplicated", "pulled", "pending", "blocked", "cached"], additionalProperties: false },
      }] : []),
      ...(deliveryToolsAvailable ? [{
        name: "claim",
        description: "Atomically claim the next targeted delivery.",
        inputSchema: { type: "object" as const, properties: { leaseMs: { type: "number" }, maxAttempts: { type: "number" } }, additionalProperties: false },
        outputSchema: { type: "object" as const, additionalProperties: true },
      },
      ...["extend", "acknowledge", "negative_acknowledge"].map((name) => ({
        name,
        description: `Agent Bridge v2 ${name.replace(/_/g, " ")} delivery operation.`,
        inputSchema: {
          type: "object" as const,
          properties: {
            deliveryId: { type: "string" }, leaseToken: { type: "string" },
            ...(name === "extend" ? { leaseMs: { type: "number" } } : {}),
            ...(name === "negative_acknowledge" ? { error: { type: "string" }, dead: { type: "boolean" }, retryPolicy: { type: "object", additionalProperties: true } } : {}),
          },
          required: ["deliveryId", "leaseToken"],
          additionalProperties: false,
        },
        outputSchema: { type: "object" as const, additionalProperties: true },
      })),
      {
        name: "heartbeat",
        description: "Publish a leased runtime presence record and capabilities.",
        inputSchema: { type: "object" as const, properties: {
          leaseMs: { type: "number", minimum: 1000, maximum: 900000 }, runtimeType: { type: "string" },
          capabilities: { type: "array", items: { type: "string" } },
        }, additionalProperties: false },
        outputSchema: { type: "object" as const, additionalProperties: true },
      },
      {
        name: "presence",
        description: "List active agent runtime instances in this workspace.",
        inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
        outputSchema: { type: "object" as const, properties: { agents: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["agents"] },
      }] : []),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
      case "post_context": {
        let source: string | undefined;
        try {
          source = resolvePostSource(args?.source, config.agent);
          if (!source) {
            throw new Error(
              "source is required when AGENT_BRIDGE_AGENT is not configured",
            );
          }
        } catch (e) {
          throw new McpError(
            ErrorCode.InvalidParams,
            e instanceof Error ? e.message : "source identity mismatch",
          );
        }
        const project = validateProject(args?.project);
        const postArgs = { ...(args ?? {}), source, project };
        const receiptId = normalizeReceiptId(args?.atrib_receipt_id);
        const envelope = buildMessageEnvelope(postArgs, receiptId);
        const draft = validateMessageDraft({
          id: String(envelope.message_id),
          project,
          type: String(args?.kind ?? args?.category),
          content: String(args?.content ?? ""),
          contentType: String(args?.payload_mime ?? "text/plain"),
          data: args?.payload as MessageDraft["data"],
          targets: Array.isArray(args?.target_agents) ? args.target_agents.map(String) : [],
          threadId: args?.thread_id as string | undefined,
          replyToId: args?.reply_to_id as string | undefined,
          priority: (args?.priority ?? "info") as MessageDraft["priority"],
          expiresAt: args?.expires_at as string | undefined,
          atribReceiptId: receiptId,
          informedBy: Array.isArray(args?.informed_by) ? args.informed_by.map(String) : [],
          metadata: mergeEnvelopeMetadata(args?.metadata, envelope) as MessageDraft["metadata"],
        });
        const body: Record<string, unknown> = {
          source,
          category: draft.type,
          content: draft.content,
          priority: draft.priority,
          project: draft.project ?? null,
          metadata: draft.metadata,
        };
        // Optional cross-tool causal anchor; written when an atrib-signing
        // wrapper signs this call before forwarding. Format-validated so
        // unexpected producers cannot pollute the column with garbage.
        if (receiptId) {
          body.atrib_receipt_id = receiptId;
        }
        if (!supabaseRequest) {
          if (!service || !principal) throw new McpError(ErrorCode.InternalError, "bridge provider is not configured");
          const result = await service.publish(principal, draft);
          return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as unknown as Record<string, unknown> };
        }
        if (!supabaseRequest) throw new McpError(ErrorCode.InternalError, "bridge provider is not configured");
        const data = await supabaseRequest("/shared_context", {
          method: "POST",
          body: JSON.stringify(body),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }

      case "get_context": {
        const project = validateProject(args?.project);
        const contextArgs = { ...(args ?? {}), project };
        const rawLimit = args?.limit;
        if (
          rawLimit !== undefined &&
          (typeof rawLimit !== "number" || !Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 200)
        ) {
          throw new McpError(ErrorCode.InvalidParams, "limit must be between 1 and 200");
        }
        const requestedLimit = rawLimit ?? 20;
        if (service && principal) {
          if (!service || !principal) throw new McpError(ErrorCode.InternalError, "bridge provider is not configured");
          if (args?.target_agent && String(args.target_agent) !== principal.agent) {
            return { content: [{ type: "text", text: "[]" }], structuredContent: { entries: [] } };
          }
          const result = await service.history(principal, {
            limit: requestedLimit,
            types: args?.kind ? [String(args.kind)] : args?.category ? [String(args.category)] : undefined,
            source: args?.source ? String(args.source) : undefined,
            project,
            since: args?.since ? String(args.since) : undefined,
            unacknowledgedBy: args?.unacked_by ? String(args.unacked_by) : config.agent,
            threadId: args?.thread_id ? String(args.thread_id) : undefined,
            latest: true,
          });
          const entries = result.messages
            .slice(0, requestedLimit)
            .map((message) => ({
              id: clientConfig?.provider === "legacy-supabase" && /^\d+$/.test(message.sequence)
                ? Number.isSafeInteger(Number(message.sequence)) ? Number(message.sequence) : message.sequence
                : message.id,
              source: message.source,
              category: message.type,
              content: message.content,
              priority: message.priority,
              project: message.project ?? null,
              metadata: legacyContextMetadata(message),
              atrib_receipt_id: message.atribReceiptId ?? null,
              created_at: message.createdAt,
            }));
          const cachedResult = result as typeof result & {
            source?: "remote" | "cache";
            stale?: boolean;
            degraded?: boolean;
            acknowledgements?: "authoritative" | "unknown";
            lastSyncedAt?: string;
          };
          const cacheMetadata = cachedResult.source
            ? {
                source: cachedResult.source,
                stale: Boolean(cachedResult.stale),
                degraded: Boolean(cachedResult.degraded),
                acknowledgements: cachedResult.acknowledgements ?? "authoritative",
                lastSyncedAt: cachedResult.lastSyncedAt ?? null,
              }
            : {};
          return {
            content: [
              { type: "text", text: JSON.stringify(entries, null, 2) },
              ...(cachedResult.stale || cachedResult.degraded ? [{
                type: "text" as const,
                text: `WARNING: cached Agent Bridge context is ${cachedResult.stale ? "stale" : "degraded"}; acknowledgement authority is ${cachedResult.acknowledgements ?? "unknown"}.`,
              }] : []),
            ],
            structuredContent: { entries, ...cacheMetadata },
          };
        }
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
        if (project)
          params.push(`project=eq.${encodeURIComponent(project)}`);
        const unackedBy = args?.unacked_by ?? config.agent;
        if (unackedBy)
          params.push(
            `acked_by=not.cs.%7B${encodeURIComponent(String(unackedBy))}%7D`,
          );

        if (!supabaseRequest) throw new McpError(ErrorCode.InternalError, "bridge provider is not configured");
        const data = await supabaseRequest(
          `/shared_context?${params.join("&")}`,
        );
        const filtered = filterContextRows(data, contextArgs, requestedLimit);
        return {
          content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
          structuredContent: { entries: filtered },
        };
      }

      case "ack_context": {
        const ids = args?.ids as unknown[];
        let agent: string | undefined;
        try {
          agent = resolveAgentIdentity(args?.agent, config.agent);
        } catch (e) {
          throw new McpError(
            ErrorCode.InvalidParams,
            e instanceof Error ? e.message : "agent identity mismatch",
          );
        }
        if (!ids?.length || !agent) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "ids are required; agent is required when AGENT_BRIDGE_AGENT is not configured",
          );
        }
        if (service && principal) {
          if (!service || !principal) throw new McpError(ErrorCode.InternalError, "bridge provider is not configured");
          const rawIds = ids.map(String);
          const acknowledged = clientConfig?.provider === "legacy-supabase" &&
              store?.recordLegacyReceipt && rawIds.every((id) => /^\d+$/.test(id))
            ? await store.recordLegacyReceipt(rawIds, principal.agent)
            : await service.acknowledge(
                principal,
                ids.map((id) => legacyNumericMessageId(id as string | number)),
              );
          return { content: [{ type: "text", text: JSON.stringify({ acknowledged, agent }) }], structuredContent: { acknowledged, agent } };
        }
        if (!supabaseRequest) throw new McpError(ErrorCode.InternalError, "bridge provider is not configured");
        const data = await supabaseRequest("/rpc/ack_context", {
          method: "POST",
          body: JSON.stringify({ entry_ids: ids.map(String), agent_name: agent }),
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

      case "send": {
        if (!service || !principal) throw new McpError(ErrorCode.InvalidParams, "AGENT_BRIDGE_AGENT is required");
        try { resolvePostSource(args?.source, principal.agent); } catch (error) { throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : "source identity mismatch"); }
        const result = await service.publish(principal, args as unknown as MessageDraft);
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as unknown as Record<string, unknown> };
      }
      case "history": {
        if (!service || !principal) throw new McpError(ErrorCode.InvalidParams, "AGENT_BRIDGE_AGENT is required");
        const result = await service.history(principal, args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as unknown as Record<string, unknown> };
      }
      case "sync": {
        if (!store?.sync) throw new McpError(ErrorCode.InvalidParams, "sync is available only with the gateway provider");
        const result = await store.sync({
          maxPush: args?.maxPush as number | undefined,
          maxPages: args?.maxPages as number | undefined,
          signal: extra.signal,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
      }
      case "claim": {
        if (!service || !principal) throw new McpError(ErrorCode.InvalidParams, "AGENT_BRIDGE_AGENT is required");
        const result = await service.claim(principal, { leaseMs: args?.leaseMs as number | undefined, maxAttempts: args?.maxAttempts as number | undefined });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: (result ?? { delivery: null }) as unknown as Record<string, unknown> };
      }
      case "extend": case "acknowledge": case "negative_acknowledge": {
        if (!service || !principal) throw new McpError(ErrorCode.InvalidParams, "AGENT_BRIDGE_AGENT is required");
        const id = String(args?.deliveryId ?? ""), token = String(args?.leaseToken ?? "");
        const result = name === "extend" ? await service.extend(principal, id, token, args?.leaseMs as number | undefined)
          : name === "acknowledge" ? await service.ack(principal, id, token)
          : await service.nack(
            principal,
            id,
            token,
            (args?.error ?? "negative acknowledgment") as string,
            (args?.dead ?? false) as boolean,
            args?.retryPolicy as Partial<RetryPolicy> | undefined,
          );
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: (result ?? { delivery: null }) as unknown as Record<string, unknown> };
      }
      case "heartbeat": {
        if (!service || !principal) throw new McpError(ErrorCode.InvalidParams, "AGENT_BRIDGE_AGENT is required");
        const result = await service.heartbeat(principal, {
          leaseMs: args?.leaseMs as number | undefined,
          runtimeType: args?.runtimeType as string | undefined,
          capabilities: args?.capabilities as string[] | undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as unknown as Record<string, unknown> };
      }
      case "presence": {
        if (!service || !principal) throw new McpError(ErrorCode.InvalidParams, "AGENT_BRIDGE_AGENT is required");
        const result = { agents: await service.presence(principal) };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (error instanceof BridgeValidationError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw error;
    }
  });

  let initialization: Promise<void> | undefined;
  const initializeStore = () => initialization ??= clientConfig?.provider === "gateway"
    ? store?.initialize() ?? Promise.resolve()
    : Promise.resolve();
  let closure: Promise<void> | undefined;
  const closeStore = () => closure ??= store?.close?.() ?? Promise.resolve();
  const connect = server.connect.bind(server);
  server.connect = async (transport) => {
    await initializeStore();
    await connect(transport);
  };
  const close = server.close.bind(server);
  server.close = async () => {
    let transportError: unknown;
    try { await close(); } catch (error) { transportError = error; }
    try { await closeStore(); } catch (error) {
      if (transportError) throw Object.assign(new Error("failed to close Agent Bridge server"), {
        errors: [transportError, error],
      });
      throw error;
    }
    if (transportError) throw transportError;
  };
  server.onclose = () => {
    void closeStore().catch((error) => server.onerror?.(error instanceof Error ? error : new Error(String(error))));
  };

  return server;
}

export async function startServer(
  config: AgentBridgeServerConfig = configFromEnv(),
) {
  const server = createAgentBridgeServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
