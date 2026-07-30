import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { configFromEnv, createAgentBridgeServer } from "./server.js";
import { verifyPrivatePathAccess } from "./private-path.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8794;
const DEFAULT_PATH = "/mcp";
const DEFAULT_SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

export interface LoopbackHostOptions {
  host?: string;
  port?: number;
  path?: string;
  sessionIdleMs?: number;
}

export interface LoopbackHost {
  endpoint: string;
  healthEndpoint: string;
  close(): Promise<void>;
}

export interface LaunchdInstallOptions extends Required<LoopbackHostOptions> {
  serviceName: string;
  configPath: string;
  agent: string;
  instance: string;
  home?: string;
  executablePath?: string;
}

interface Session {
  bridge: ReturnType<typeof createAgentBridgeServer>;
  transport: StreamableHTTPServerTransport;
  id?: string;
  lastSeenAt: number;
  closing: boolean;
}

function normalizePath(raw: string): string {
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function endpoint(host: string, port: number, path: string): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}${path}`;
}

function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function sessionId(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"];
  return Array.isArray(value) ? value[0] : value;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
  });
  res.end(bytes);
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  reply(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  return value ? JSON.parse(value) : undefined;
}

function listen(server: HttpServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function boundPort(server: HttpServer): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback host did not bind a TCP port");
  return (address as AddressInfo).port;
}

export async function startLoopbackHost(options: LoopbackHostOptions = {}): Promise<LoopbackHost> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const mcpPath = normalizePath(options.path ?? DEFAULT_PATH);
  const healthPath = `${mcpPath}/health`;
  const sessionIdleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  if (!isLoopback(host)) throw new Error("--host must be 127.0.0.1, ::1, or localhost");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
  if (!Number.isInteger(sessionIdleMs) || sessionIdleMs <= 0) throw new Error("--session-idle-ms must be a positive integer");

  const sessions = new Map<string, Session>();
  let openedSessions = 0;
  let closedSessions = 0;
  let closing = false;
  const closeSession = async (session: Session): Promise<void> => {
    if (session.closing) return;
    session.closing = true;
    if (session.id) sessions.delete(session.id);
    closedSessions += 1;
    await Promise.allSettled([session.transport.close(), session.bridge.close()]);
  };
  const sweep = (): void => {
    const cutoff = Date.now() - sessionIdleMs;
    for (const session of sessions.values()) {
      if (session.lastSeenAt < cutoff) void closeSession(session);
    }
  };
  const sweepTimer = setInterval(sweep, Math.min(sessionIdleMs, 60_000));
  sweepTimer.unref();

  const server = createServer(async (req, res) => {
    const path = requestPath(req);
    if (path === healthPath || path === "/health") {
      reply(res, 200, {
        status: "healthy",
        report: {
          bridgeRuntime: "agent-bridge",
          transport: "streamable-http",
          sessions: { active: sessions.size, opened: openedSessions, closed: closedSessions, idleTimeoutMs: sessionIdleMs },
        },
      });
      return;
    }
    if (path !== mcpPath) return jsonRpcError(res, 404, -32000, "Not Found");
    if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) {
      return jsonRpcError(res, 405, -32000, "Method Not Allowed");
    }
    sweep();
    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const existingId = sessionId(req);
      if (existingId) {
        const session = sessions.get(existingId);
        if (!session) return jsonRpcError(res, 404, -32000, "Session not found");
        session.lastSeenAt = Date.now();
        await session.transport.handleRequest(req, res, body);
        return;
      }
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        return jsonRpcError(res, 400, -32000, "initialize first or provide mcp-session-id");
      }
      let session: Session | undefined;
      try {
        const bridge = createAgentBridgeServer(configFromEnv());
        session = {
          bridge,
          transport: new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (id) => {
              if (!session) return;
              session.id = id;
              session.lastSeenAt = Date.now();
              sessions.set(id, session);
            },
          }),
          lastSeenAt: Date.now(),
          closing: false,
        };
        session.transport.onclose = () => { if (session) void closeSession(session); };
        await bridge.connect(session.transport);
        openedSessions += 1;
        await session.transport.handleRequest(req, res, body);
      } finally {
        if (session && !session.id && !session.closing) await closeSession(session);
      }
    } catch (error) {
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : String(error);
        jsonRpcError(res, 500, -32603, `Internal server error: ${message}`);
      }
    }
  });
  await listen(server, host, port);
  const actualPort = boundPort(server);
  const mcpEndpoint = endpoint(host, actualPort, mcpPath);
  const healthEndpoint = endpoint(host, actualPort, healthPath);
  process.stdout.write(`${JSON.stringify({ status: "ready", endpoint: mcpEndpoint, healthEndpoint })}\n`);

  return {
    endpoint: mcpEndpoint,
    healthEndpoint,
    close: async () => {
      if (closing) return;
      closing = true;
      clearInterval(sweepTimer);
      await Promise.allSettled([...sessions.values()].map(closeSession));
      await closeServer(server);
    },
  };
}

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  return args[index + 1] ?? (() => { throw new Error(`${name} requires a value`); })();
}

function usage(): string {
  return `Usage:
  agent-bridge-loopback-host [--host 127.0.0.1] [--port 8794] [--path /mcp] [--session-idle-ms 43200000]
  agent-bridge-loopback-host --install-launchd --service-name <name> --config <private-backend> --agent <identity> --instance <stable-key> [host options]
  agent-bridge-loopback-host --uninstall-launchd --service-name <name> --port <port>
`;
}

function required(args: string[], name: string): string {
  const value = option(args, name, "");
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function serviceLabel(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("--service-name must contain only letters, numbers, _ or -");
  return `com.creatornader.agent-bridge.${name}`;
}

function launchctl(args: string[]): void {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  if (result.status !== 0 && result.status !== 3 && result.status !== 113) {
    throw new Error(`launchctl ${args[0]} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
}

function currentUserId(): number {
  if (!process.getuid) throw new Error("launchd requires a POSIX user identity");
  return process.getuid();
}

export function launchdPlist(options: LaunchdInstallOptions): string {
  const executable = options.executablePath ?? fileURLToPath(import.meta.url);
  const label = serviceLabel(options.serviceName);
  const environment = {
    AGENT_BRIDGE_CONFIG: options.configPath,
    AGENT_BRIDGE_AGENT: options.agent,
    AGENT_BRIDGE_INSTANCE: options.instance,
  };
  const encode = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const strings = (values: string[]): string => values.map((value) => `    <string>${encode(value)}</string>`).join("\n");
  const env = Object.entries(environment).map(([key, value]) => `    <key>${key}</key>\n    <string>${encode(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${strings([process.execPath, executable, "--host", options.host, "--port", String(options.port), "--path", options.path, "--session-idle-ms", String(options.sessionIdleMs)])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${encode(join(options.home ?? homedir(), ".agent-bridge", "logs", `${options.serviceName}.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${encode(join(options.home ?? homedir(), ".agent-bridge", "logs", `${options.serviceName}.err.log`))}</string>
</dict>
</plist>
`;
}

async function waitForHealth(healthEndpoint: string): Promise<void> {
  let lastError = "no response";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(healthEndpoint, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json() as { status?: unknown };
      if (response.ok && body.status === "healthy") return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`launchd started but ${healthEndpoint} did not become healthy: ${lastError}`);
}

export async function installLaunchdHost(options: LaunchdInstallOptions): Promise<{ label: string; plistPath: string; healthEndpoint: string }> {
  if (process.platform !== "darwin") throw new Error("--install-launchd is supported only on macOS");
  if (!isLoopback(options.host)) throw new Error("--host must be 127.0.0.1, ::1, or localhost");
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("--port must be an integer from 1 to 65535 for launchd");
  if (!isAbsolute(options.configPath) || !existsSync(options.configPath)) throw new Error(`--config must be an existing absolute path: ${options.configPath}`);
  verifyPrivatePathAccess(options.configPath, "file");
  const home = options.home ?? homedir();
  const label = serviceLabel(options.serviceName);
  const agents = join(home, "Library", "LaunchAgents");
  const logs = join(home, ".agent-bridge", "logs");
  const plistPath = join(agents, `${label}.plist`);
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  chmodSync(agents, 0o700);
  chmodSync(logs, 0o700);
  launchctl(["bootout", `gui/${currentUserId()}/${label}`]);
  writeFileSync(plistPath, launchdPlist({ ...options, home }), { mode: 0o600 });
  chmodSync(plistPath, 0o600);
  launchctl(["bootstrap", `gui/${currentUserId()}`, plistPath]);
  const healthEndpoint = endpoint(options.host, options.port, `${normalizePath(options.path)}/health`);
  await waitForHealth(healthEndpoint);
  return { label, plistPath, healthEndpoint };
}

async function portIsOpen(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

async function waitForPortClosed(host: string, port: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!await portIsOpen(host, port)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`launchd unloaded but ${host}:${port} is still accepting connections`);
}

export async function uninstallLaunchdHost(
  serviceName: string,
  port: number,
  host = DEFAULT_HOST,
  home = homedir(),
): Promise<{ label: string; plistPath: string }> {
  if (process.platform !== "darwin") throw new Error("--uninstall-launchd is supported only on macOS");
  if (!isLoopback(host)) throw new Error("--host must be 127.0.0.1, ::1, or localhost");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535 for launchd");
  const label = serviceLabel(serviceName);
  const plistPath = join(home, "Library", "LaunchAgents", `${label}.plist`);
  launchctl(["bootout", `gui/${currentUserId()}/${label}`]);
  rmSync(plistPath, { force: true });
  await waitForPortClosed(host, port);
  return { label, plistPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) process.stdout.write(usage());
  else if (args.includes("--install-launchd")) {
    void (async () => {
      try {
        const result = await installLaunchdHost({
          serviceName: required(args, "--service-name"),
          configPath: required(args, "--config"),
          agent: required(args, "--agent"),
          instance: required(args, "--instance"),
          host: option(args, "--host", DEFAULT_HOST),
          port: Number(option(args, "--port", String(DEFAULT_PORT))),
          path: option(args, "--path", DEFAULT_PATH),
          sessionIdleMs: Number(option(args, "--session-idle-ms", String(DEFAULT_SESSION_IDLE_MS))),
        });
        process.stdout.write(`${JSON.stringify({ status: "installed", ...result })}\n`);
      } catch (error) {
        process.stderr.write(`agent-bridge-loopback-host: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    })();
  } else if (args.includes("--uninstall-launchd")) {
    void (async () => {
      try {
        const result = await uninstallLaunchdHost(
          required(args, "--service-name"),
          Number(required(args, "--port")),
          option(args, "--host", DEFAULT_HOST),
        );
        process.stdout.write(`${JSON.stringify({ status: "uninstalled", ...result })}\n`);
      } catch (error) {
        process.stderr.write(`agent-bridge-loopback-host: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    })();
  }
  else void startLoopbackHost({
    host: option(args, "--host", DEFAULT_HOST),
    port: Number(option(args, "--port", String(DEFAULT_PORT))),
    path: option(args, "--path", DEFAULT_PATH),
    sessionIdleMs: Number(option(args, "--session-idle-ms", String(DEFAULT_SESSION_IDLE_MS))),
  }).then((host) => {
    const shutdown = () => void host.close().finally(() => process.exit(0));
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch((error) => {
    process.stderr.write(`agent-bridge-loopback-host: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
