import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

const SUPABASE_URL = process.env.AGENT_BRIDGE_URL;
const SUPABASE_KEY = process.env.AGENT_BRIDGE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "Missing AGENT_BRIDGE_URL or AGENT_BRIDGE_KEY environment variables"
  );
  process.exit(1);
}

const REST_URL = `${SUPABASE_URL}/rest/v1`;

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function supabaseRequest(
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  const url = `${REST_URL}${path}`;
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
}

export async function startServer() {
  const server = new Server(
    { name: "agent-bridge", version: "1.0.0" },
    { capabilities: { tools: {} } }
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
              description: 'Agent posting this entry (e.g. "claude-code", "sido")',
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
                "Scope to a project (e.g. whop-app, sahbi). Omit for cross-project.",
            },
            metadata: {
              type: "object",
              description: "Arbitrary structured data",
            },
            atrib_receipt_id: {
              type: "string",
              description:
                "Optional. Signed atrib record receipt_id for the wrapper that signed this post_context call. Set automatically by the agent-bridge-atrib wrapper; consumers reading the row use this as the informed_by anchor for cross-repo causal edges.",
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
              description: "ISO timestamp — only entries after this time",
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
        const body: Record<string, unknown> = {
          source: args?.source,
          category: args?.category,
          content: args?.content,
          priority: args?.priority || "info",
          project: args?.project || null,
          metadata: args?.metadata || {},
        };
        // Optional cross-tool causal anchor; written when the wrapper signs
        // this call before forwarding (see agent-bridge-atrib).
        if (typeof args?.atrib_receipt_id === "string" && args.atrib_receipt_id.length > 0) {
          body.atrib_receipt_id = args.atrib_receipt_id;
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
        const params: string[] = [
          "order=created_at.desc",
          `limit=${args?.limit || 20}`,
        ];
        if (args?.since) params.push(`created_at=gte.${args.since}`);
        if (args?.source) params.push(`source=eq.${args.source}`);
        if (args?.category) params.push(`category=eq.${args.category}`);
        if (args?.project) params.push(`project=eq.${args.project}`);
        if (args?.unacked_by)
          params.push(`acked_by=not.cs.%7B${args.unacked_by}%7D`);

        const data = await supabaseRequest(
          `/shared_context?${params.join("&")}`
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }

      case "ack_context": {
        const ids = args?.ids as number[];
        const agent = args?.agent as string;
        if (!ids?.length || !agent) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "ids (number[]) and agent (string) are required"
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
