import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BridgeValidationError, type MessageDraft } from "./bridge-domain.js";
import { BridgeService } from "./bridge-service.js";
import type { BridgeStore } from "./bridge-store.js";
import { bearerToken, type CredentialResolver } from "./gateway-auth.js";

export interface GatewayOptions {
  store: BridgeStore;
  credentials: CredentialResolver;
  allowedOrigins?: string[];
  bodyLimitBytes?: number;
  requestDeadlineMs?: number;
  ready?: () => Promise<boolean>;
}

type Metrics = { requests: number; errors: number; timeouts: number; authFailures: number };
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function send(res: ServerResponse, status: number, value: unknown, requestId: string): void {
  if (res.writableEnded) return;
  res.writeHead(status, { ...jsonHeaders, "x-request-id": requestId });
  res.end(JSON.stringify(value));
}

function failure(res: ServerResponse, status: number, code: string, requestId: string): void {
  send(res, status, { error: { code, requestId } }, requestId);
}

async function body(
  req: IncomingMessage,
  limit: number,
  signal: AbortSignal,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (callback: () => void) => {
      cleanup();
      callback();
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        finish(() => reject(Object.assign(new Error("body too large"), {
          status: 413,
          code: "body_too_large",
        })));
        req.resume();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish(() => {
      if (!size) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400, code: "malformed_json" }));
      }
    });
    const onError = (error: Error) => finish(() => reject(error));
    const onAbort = () => {
      finish(() => reject(signal.reason));
      req.resume();
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function numberParam(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new BridgeValidationError(`${name} is invalid`);
  return result;
}

function active(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

export function createGateway(options: GatewayOptions) {
  const service = new BridgeService(options.store);
  const metrics: Metrics = { requests: 0, errors: 0, timeouts: 0, authFailures: 0 };
  const limit = options.bodyLimitBytes ?? 128 * 1024;
  const deadline = options.requestDeadlineMs ?? 10_000;
  const origins = new Set(options.allowedOrigins ?? []);

  return createServer((req, res) => {
    const requestId = randomUUID();
    const abort = new AbortController();
    let mutationStarted = false;
    metrics.requests += 1;
    const timer = setTimeout(() => {
      abort.abort(new Error("request deadline exceeded"));
      metrics.timeouts += 1; metrics.errors += 1;
      res.once("finish", () => {
        if (!req.complete) req.destroy();
      });
      failure(
        res,
        504,
        mutationStarted ? "mutation_outcome_unknown" : "request_timeout",
        requestId,
      );
    }, deadline);

    void (async () => {
      const url = new URL(req.url ?? "/", "http://gateway.invalid");
      if (req.method === "GET" && url.pathname === "/readyz") {
        let ready = false;
        try {
          ready = await (options.ready?.() ?? options.store.initialize().then(() => true));
        } catch {
          ready = false;
        }
        send(res, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" }, requestId);
        return;
      }
      const origin = req.headers.origin;
      if (origin && !origins.has(origin)) {
        failure(res, 403, "origin_forbidden", requestId); return;
      }
      const token = bearerToken(req.headers.authorization);
      const credential = token ? await options.credentials.resolve(token, abort.signal) : null;
      active(abort.signal);
      if (!credential) {
        metrics.authFailures += 1;
        failure(res, 401, "unauthorized", requestId); return;
      }
      if (req.method === "GET" && url.pathname === "/metrics") {
        res.writeHead(200, { ...jsonHeaders, "content-type": "text/plain; version=0.0.4", "x-request-id": requestId });
        res.end(Object.entries(metrics).map(([key, value]) => `agent_bridge_gateway_${key}_total ${value}`).join("\n") + "\n");
        return;
      }
      const instanceHeader = req.headers["x-agent-bridge-instance"];
      const principal = {
        ...credential.principal,
        instance: Array.isArray(instanceHeader) ? instanceHeader[0] : instanceHeader,
      };

      if (req.method === "GET" && url.pathname === "/v2/status") {
        if (!options.store.diagnostics) {
          send(res, 200, { schemaVersion: "postgres-v2", deliverySupported: false, pending: null, claimed: null, retrying: null, dead: null, principal: credential.principal }, requestId);
        } else {
          send(res, 200, { ...await options.store.diagnostics(principal), principal: credential.principal }, requestId);
        }
        return;
      }

      if (req.method === "POST" && req.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
        failure(res, 415, "unsupported_media_type", requestId); return;
      }

      if (req.method === "POST" && url.pathname === "/v2/messages") {
        const input = await body(req, limit, abort.signal) as unknown as MessageDraft;
        active(abort.signal);
        mutationStarted = true;
        send(res, 201, await service.publish(principal, input), requestId); return;
      }
      if (req.method === "GET" && url.pathname === "/v2/history") {
        const types = url.searchParams.getAll("type");
        send(res, 200, await service.history(principal, {
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: numberParam(url.searchParams.get("limit"), "limit"),
          types: types.length ? types : undefined,
          includeExpired: url.searchParams.get("includeExpired") === "true",
          source: url.searchParams.get("source") ?? undefined,
          since: url.searchParams.get("since") ?? undefined,
          unacknowledgedBy: url.searchParams.get("unacknowledgedBy") ?? undefined,
          threadId: url.searchParams.get("threadId") ?? undefined,
          latest: url.searchParams.get("latest") === "true",
        }), requestId); return;
      }
      if (req.method === "POST" && url.pathname === "/v2/receipts") {
        const input = await body(req, limit, abort.signal);
        active(abort.signal);
        mutationStarted = true;
        send(res, 200, { recorded: await service.acknowledge(principal, input.messageIds) }, requestId); return;
      }
      if (req.method === "POST" && url.pathname === "/v2/deliveries/claim") {
        const input = await body(req, limit, abort.signal);
        active(abort.signal);
        mutationStarted = true;
        send(res, 200, await service.claim(principal, input), requestId); return;
      }
      if (req.method === "POST" && url.pathname === "/v2/presence/heartbeat") {
        const input = await body(req, limit, abort.signal);
        active(abort.signal);
        mutationStarted = true;
        send(res, 200, await service.heartbeat(principal, input), requestId); return;
      }
      if (req.method === "GET" && url.pathname === "/v2/presence") {
        send(res, 200, { agents: await service.presence(principal) }, requestId); return;
      }
      const match = url.pathname.match(/^\/v2\/deliveries\/([^/]+)\/(extend|ack|nack)$/);
      if (req.method === "POST" && match) {
        const input = await body(req, limit, abort.signal);
        active(abort.signal);
        mutationStarted = true;
        const [, id, action] = match;
        const result = action === "extend"
          ? await service.extend(principal, id, input.leaseToken, input.leaseMs)
          : action === "ack"
            ? await service.ack(principal, id, input.leaseToken)
            : await service.nack(principal, id, input.leaseToken, input.error, input.dead, input.retryPolicy);
        if (!result) failure(res, 409, "lease_conflict", requestId);
        else send(res, 200, result, requestId);
        return;
      }
      failure(res, 404, "not_found", requestId);
    })().catch((error: any) => {
      if (res.writableEnded) return;
      metrics.errors += 1;
      if (error instanceof BridgeValidationError) failure(res, 400, error.code, requestId);
      else failure(res, error?.status ?? 500, error?.code ?? "internal_error", requestId);
    }).finally(() => clearTimeout(timer));
  });
}
