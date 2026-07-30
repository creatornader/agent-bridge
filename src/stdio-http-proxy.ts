import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { validateLoopbackMcpUrl } from "./client-lifecycle.js";
import { packageVersion } from "./package-metadata.js";

export interface StdioHttpProxyRuntime {
  server: Server;
  close(): Promise<void>;
}

export async function createStdioHttpProxyRuntime(endpoint: string): Promise<StdioHttpProxyRuntime> {
  const url = validateLoopbackMcpUrl(endpoint, "--endpoint");
  const upstreamTransport = new StreamableHTTPClientTransport(new URL(url));
  const upstream = new Client({ name: "agent-bridge-stdio-http-proxy", version: packageVersion() });
  await upstream.connect(upstreamTransport);
  const listed = await upstream.listTools();
  const server = new Server(
    { name: "agent-bridge-stdio-http-proxy", version: packageVersion() },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    upstream.callTool(request.params) as Promise<CallToolResult>);
  return {
    server,
    close: async () => {
      await Promise.allSettled([server.close(), upstream.close(), upstreamTransport.close()]);
    },
  };
}

export async function startStdioHttpProxy(endpoint: string): Promise<void> {
  const runtime = await createStdioHttpProxyRuntime(endpoint);
  const transport = new StdioServerTransport();
  const shutdown = () => void Promise.allSettled([transport.close(), runtime.close()]).finally(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await runtime.server.connect(transport);
}

function usage(): string {
  return "Usage: agent-bridge-stdio-http-proxy --endpoint http://127.0.0.1:<port>/mcp\n";
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) process.stdout.write(usage());
  else {
    const index = args.indexOf("--endpoint");
    const endpoint = index < 0 ? undefined : args[index + 1];
    if (!endpoint || args.length !== 2) {
      process.stderr.write(`agent-bridge-stdio-http-proxy: ${usage()}`);
      process.exitCode = 1;
    } else {
      void startStdioHttpProxy(endpoint).catch((error) => {
        process.stderr.write(`agent-bridge-stdio-http-proxy: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
    }
  }
}
