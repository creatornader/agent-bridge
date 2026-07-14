import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BridgePrincipalMismatchError, BridgeValidationError, type MessageDraft } from "./bridge-domain.js";
import { BridgeService } from "./bridge-service.js";
import type { BridgeStore } from "./bridge-store.js";
import { bearerToken, hashCredential, type CredentialResolver } from "./gateway-auth.js";
import type { GatewaySecurity } from "./gateway-security.js";
import type { RequestAuthority, RequestAuthorityContext } from "./postgres-request-authority.js";
import {
  capabilityDocument,
  ContractResponseError,
  ContractValidationError,
  LEGACY_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  operationContract,
  parseResponse,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_HEADER,
  SUPPORTED_PROTOCOL_VERSIONS,
  type OperationId,
  validateRequest,
  validateRequestForProtocol,
} from "./contracts/registry.js";

export interface GatewayOptions {
  store: BridgeStore;
  credentials: CredentialResolver;
  security: GatewaySecurity;
  allowedOrigins?: string[];
  bodyLimitBytes?: number;
  requestDeadlineMs?: number;
  ready?: () => Promise<boolean>;
  /** Reports whether the configured database has verified row isolation. */
  rowIsolationReady?: () => Promise<boolean>;
  /** Production PostgreSQL request authority. Other providers omit this. */
  requestAuthority?: RequestAuthority;
}

type Metrics = { requests: number; errors: number; timeouts: number; authFailures: number };
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

interface ResponseWriter {
  readonly writableEnded: boolean;
  getHeader(name: string): string | number | readonly string[] | undefined;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  writeHead(status: number, headers?: any): unknown;
  end(chunk?: any): unknown;
}

class BufferedResponse implements ResponseWriter {
  private readonly headers = new Map<string, string | number | readonly string[]>();
  private status: number | undefined;
  private headHeaders: any;
  private body: any;

  constructor(private readonly target: ServerResponse) {}
  get writableEnded(): boolean { return this.body !== undefined; }
  getHeader(name: string) { return this.headers.get(name.toLowerCase()) ?? this.target.getHeader(name); }
  setHeader(name: string, value: string | number | readonly string[]) { this.headers.set(name.toLowerCase(), value); return this; }
  writeHead(status: number, headers?: any) {
    this.status = status;
    this.headHeaders = headers;
    return this;
  }
  end(chunk?: any) { this.body = chunk ?? null; return this; }
  flush(): void {
    if (this.target.writableEnded) return;
    for (const [name, value] of this.headers) this.target.setHeader(name, value);
    if (this.status !== undefined) this.target.writeHead(this.status, this.headHeaders);
    if (this.body !== undefined) this.target.end(this.body);
  }
}

function send(res: ResponseWriter, status: number, value: unknown, requestId: string): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    ...jsonHeaders,
    "x-request-id": requestId,
  });
  res.end(JSON.stringify(value));
}

function sendOperation(res: ResponseWriter, status: number, operation: string, value: unknown, requestId: string): void {
  const canonical = parseResponse(operation, value) as Record<string, unknown>;
  const protocolVersion = String(res.getHeader(PROTOCOL_HEADER) ?? PROTOCOL_VERSION);
  if (protocolVersion !== LEGACY_PROTOCOL_VERSION) {
    send(res, status, canonical, requestId);
    return;
  }
  if (operation === "claim_delivery") {
    send(res, status, canonical.delivery === null ? null : canonical, requestId);
    return;
  }
  if (["cancel_delivery", "requeue_delivery", "extend_delivery", "acknowledge_delivery", "negative_acknowledge_delivery"].includes(operation)) {
    send(res, status, canonical.delivery, requestId);
    return;
  }
  send(res, status, canonical, requestId);
}

function failure(
  res: ResponseWriter,
  status: number,
  code: string,
  requestId: string,
  details: Record<string, unknown> = {},
): void {
  send(res, status, { error: { code, requestId, ...details } }, requestId);
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

async function jsonBody(
  req: IncomingMessage,
  limit: number,
  signal: AbortSignal,
): Promise<Record<string, any>> {
  if (hasRequestBody(req) && req.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
    throw Object.assign(new Error("unsupported media type"), {
      status: 415,
      code: "unsupported_media_type",
    });
  }
  return body(req, limit, signal);
}

function numberParam(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new BridgeValidationError(`${name} is invalid`);
  return result;
}

function booleanParam(value: string | null, name: string): boolean | undefined {
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new BridgeValidationError(`${name} must be true or false`);
}

function hasRequestBody(req: IncomingMessage): boolean {
  const length = req.headers["content-length"];
  return req.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
}

function pathBoundInput(
  operation: string,
  deliveryId: string,
  rawInput: Record<string, unknown>,
  protocolVersion?: string,
): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(rawInput, "deliveryId")) {
    throw new ContractValidationError(operation, [{ path: "/deliveryId", message: "deliveryId is supplied by the request path" }]);
  }
  const value = { ...rawInput, deliveryId };
  return protocolVersion
    ? validateRequestForProtocol(operation, value, protocolVersion)
    : validateRequest(operation, value);
}

function active(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function closedQuery(url: URL, operation: string, allowed: readonly string[]): void {
  const unknown = [...url.searchParams.keys()].find((key) => !allowed.includes(key));
  if (unknown) throw new ContractValidationError(operation, [{ path: `/${unknown}`, message: "Unexpected query parameter" }]);
}

function selectedProtocol(res: ResponseWriter): string {
  return String(res.getHeader(PROTOCOL_HEADER) ?? PROTOCOL_VERSION);
}

function requireCurrentProtocol(res: ResponseWriter): void {
  if (selectedProtocol(res) === LEGACY_PROTOCOL_VERSION) {
    const error = new Error("Operation is not available in protocol 2.0") as Error & { status: number; code: string };
    error.status = 404;
    error.code = "not_found";
    throw error;
  }
}

export function createGateway(options: GatewayOptions) {
  const metrics: Metrics = { requests: 0, errors: 0, timeouts: 0, authFailures: 0 };
  const limit = options.bodyLimitBytes ?? 128 * 1024;
  const deadline = options.requestDeadlineMs ?? 10_000;
  const origins = new Set(options.allowedOrigins ?? []);

  return createServer((req, res) => {
    const requestId = randomUUID();
    const abort = new AbortController();
    let mutationStarted = false;
    metrics.requests += 1;
    const requestedProtocol = req.headers[PROTOCOL_HEADER];
    const rawRequestedProtocol = Array.isArray(requestedProtocol) ? requestedProtocol[0] : requestedProtocol;
    const initialProtocol = rawRequestedProtocol === undefined || rawRequestedProtocol.trim() === ""
      ? LEGACY_PROTOCOL_VERSION
      : (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(rawRequestedProtocol.trim())
        ? rawRequestedProtocol.trim()
        : PROTOCOL_VERSION;
    res.setHeader(PROTOCOL_HEADER, initialProtocol);
    res.setHeader(SUPPORTED_PROTOCOL_HEADER, SUPPORTED_PROTOCOL_VERSIONS.join(","));
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
    let parsedBody: Promise<Record<string, any>> | undefined;
    const requestBody = () => parsedBody ??= jsonBody(req, limit, abort.signal);

    const dispatch = async (authority?: RequestAuthorityContext, response: ResponseWriter = res): Promise<void> => {
      const url = new URL(req.url ?? "/", "http://gateway.invalid");
      if (req.method === "GET" && url.pathname === "/readyz") {
        let ready = false;
        try {
          ready = await (options.ready?.() ?? options.store.initialize().then(() => true));
        } catch {
          ready = false;
        }
        send(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" }, requestId);
        return;
      }
      const origin = req.headers.origin;
      if (origin && !origins.has(origin)) {
        failure(response, 403, "origin_forbidden", requestId); return;
      }
      const token = bearerToken(req.headers.authorization);
      if (options.requestAuthority && !authority) {
        if (!token) {
          metrics.authFailures += 1;
          failure(response, 401, "unauthorized", requestId); return;
        }
        const preflight = await options.credentials.resolve(token, abort.signal);
        active(abort.signal);
        if (!preflight) {
          metrics.authFailures += 1;
          failure(response, 401, "unauthorized", requestId); return;
        }
        if (hasRequestBody(req)) await requestBody();
        active(abort.signal);
        const buffered = new BufferedResponse(res);
        await options.requestAuthority!.run(
          preflight.id,
          hashCredential(token),
          requestId,
          abort.signal,
          (context) => dispatch(context, buffered),
        );
        active(abort.signal);
        buffered.flush();
        return;
      }
      const credential = authority?.credential ?? (token ? await options.credentials.resolve(token, abort.signal) : null);
      active(abort.signal);
      if (!credential) {
        metrics.authFailures += 1;
        failure(response, 401, "unauthorized", requestId); return;
      }
      if (!Array.isArray(credential.scopes)) {
        failure(response, 503, "security_unavailable", requestId); return;
      }
      const service = new BridgeService(authority?.store ?? options.store);
      const security = authority?.security ?? options.security;
      if (url.pathname.startsWith("/v2/") || url.pathname === "/metrics") {
        response.setHeader(PROTOCOL_HEADER, negotiateProtocolVersion(req.headers[PROTOCOL_HEADER]));
      }
      const authorize = async (operationId: OperationId): Promise<void> => {
        const requiredScopes = operationContract(operationId).scopes;
        if (requiredScopes.some((scope) => !credential.scopes.includes(scope))) {
          try {
            await security.recordScopeDenial(credential.id, operationId, requestId, abort.signal);
          } catch {
            throw Object.assign(new Error("Scope denial could not be audited"), {
              status: 503,
              code: "security_unavailable",
            });
          }
          throw Object.assign(new Error("Credential lacks a required scope"), {
            status: 403, code: "insufficient_scope", requiredScopes,
          });
        }
        let decision;
        try {
          decision = await security.consume(credential.id, operationId, requestId, abort.signal);
        } catch {
          throw Object.assign(new Error("Rate limit state is unavailable"), {
            status: 503,
            code: "security_unavailable",
          });
        }
        if (!decision.allowed) {
          const retryAfter = Math.max(1, Math.ceil(decision.retryAfterSeconds));
          response.setHeader("retry-after", String(retryAfter));
          throw Object.assign(new Error("Credential rate limit exceeded"), {
            status: 429, code: "rate_limited", retryAfterSeconds: retryAfter,
          });
        }
      };
      if (req.method === "GET" && url.pathname === "/metrics") {
        await authorize("gateway_metrics");
        validateRequest("gateway_metrics", {});
        const result = Object.entries(metrics).map(([key, value]) => `agent_bridge_gateway_${key}_total ${value}`).join("\n") + "\n";
        parseResponse("gateway_metrics", result);
        response.writeHead(200, {
          ...jsonHeaders,
          "content-type": "text/plain; version=0.0.4",
          "x-request-id": requestId,
        });
        response.end(result);
        return;
      }
      const instanceHeader = req.headers["x-agent-bridge-instance"];
      const principal = {
        ...credential.principal,
        instance: Array.isArray(instanceHeader) ? instanceHeader[0] : instanceHeader,
      };

      if (req.method === "GET" && url.pathname === "/v2/capabilities") {
        requireCurrentProtocol(response);
        await authorize("capabilities");
        closedQuery(url, "capabilities", []);
        validateRequest("capabilities", {});
        let rowIsolation = false;
        if (options.requestAuthority && options.rowIsolationReady) {
          try {
            rowIsolation = await options.rowIsolationReady();
          } catch {
            rowIsolation = false;
          }
        }
        sendOperation(response, 200, "capabilities", capabilityDocument({ surface: "http", provider: "gateway", selectedProtocolVersion: String(response.getHeader(PROTOCOL_HEADER)), requestAuthority: Boolean(options.requestAuthority), rowIsolation }), requestId); return;
      }

      if (req.method === "GET" && url.pathname === "/v2/status") {
        await authorize("status");
        closedQuery(url, "status", []);
        validateRequest("status", {});
        const activeStore = authority?.store ?? options.store;
        if (!activeStore.diagnostics) {
          sendOperation(response, 200, "status", { schemaVersion: "postgres-v2", deliverySupported: false, pending: null, claimed: null, retrying: null, dead: null, principal: credential.principal }, requestId);
        } else {
          sendOperation(response, 200, "status", { ...await activeStore.diagnostics(principal), principal: credential.principal }, requestId);
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/v2/messages") {
        await authorize("publish_message");
        const input = validateRequestForProtocol("publish_message", await requestBody(), String(response.getHeader(PROTOCOL_HEADER)));
        if (input.source !== undefined && input.source !== principal.agent) {
          throw new BridgePrincipalMismatchError("source must match the authenticated principal");
        }
        const { source: _source, ...draft } = input;
        active(abort.signal);
        await authority?.beginDomainWork(); mutationStarted = true;
        sendOperation(response, 201, "publish_message", await service.publish(principal, draft as unknown as MessageDraft), requestId); return;
      }
      if (req.method === "GET" && url.pathname === "/v2/history") {
        await authorize("history");
        closedQuery(url, "history", ["cursor", "mailbox", "receiptState", "limit", "type", "includeExpired", "source", "project", "since", "unacknowledgedBy", "unacked_by", "threadId", "latest"]);
        const types = url.searchParams.getAll("type");
        const input = validateRequestForProtocol("history", {
          cursor: url.searchParams.get("cursor") ?? undefined,
          mailbox: url.searchParams.get("mailbox") ?? undefined as any,
          receiptState: url.searchParams.get("receiptState") ?? undefined as any,
          limit: numberParam(url.searchParams.get("limit"), "limit"),
          types: types.length ? types : undefined,
          includeExpired: booleanParam(url.searchParams.get("includeExpired"), "includeExpired"),
          source: url.searchParams.get("source") ?? undefined,
          project: url.searchParams.get("project") ?? undefined,
          since: url.searchParams.get("since") ?? undefined,
          unacknowledgedBy: url.searchParams.get("unacknowledgedBy") ?? url.searchParams.get("unacked_by") ?? undefined,
          threadId: url.searchParams.get("threadId") ?? undefined,
          latest: booleanParam(url.searchParams.get("latest"), "latest"),
        }, String(response.getHeader(PROTOCOL_HEADER)));
        sendOperation(response, 200, "history", await service.history(principal, input), requestId); return;
      }
      if (req.method === "POST" && url.pathname === "/v2/receipts") {
        await authorize("record_receipt");
        const input = validateRequest("record_receipt", await requestBody());
        active(abort.signal);
        await authority?.beginDomainWork(); mutationStarted = true;
        sendOperation(response, 200, "record_receipt", { recorded: await service.acknowledge(principal, input.messageIds as string[]) }, requestId); return;
      }
      if (req.method === "POST" && url.pathname === "/v2/deliveries/claim") {
        await authorize("claim_delivery");
        const input = validateRequest("claim_delivery", await requestBody());
        active(abort.signal);
        await authority?.beginDomainWork(); mutationStarted = true;
        sendOperation(response, 200, "claim_delivery", await service.claim(principal, input) ?? { delivery: null }, requestId); return;
      }
      if (req.method === "GET" && url.pathname === "/v2/deliveries") {
        requireCurrentProtocol(response);
        await authorize("list_deliveries");
        closedQuery(url, "list_deliveries", ["cursor", "limit", "role", "messageId", "recipient", "state"]);
        const input = validateRequest("list_deliveries", {cursor:url.searchParams.get("cursor")??undefined,limit:numberParam(url.searchParams.get("limit"),"limit"),role:url.searchParams.get("role")??undefined,messageId:url.searchParams.get("messageId")??undefined,recipient:url.searchParams.get("recipient")??undefined,states:url.searchParams.getAll("state")});
        sendOperation(response,200,"list_deliveries",await service.deliveries(principal,input as any),requestId);return;
      }
      const eventsMatch=url.pathname.match(/^\/v2\/deliveries\/([^/]+)\/events$/);
      if(req.method==="GET"&&eventsMatch){requireCurrentProtocol(response);await authorize("list_delivery_events");closedQuery(url,"list_delivery_events",["cursor","limit"]);const input=validateRequest("list_delivery_events",{deliveryId:eventsMatch[1],cursor:url.searchParams.get("cursor")??undefined,limit:numberParam(url.searchParams.get("limit"),"limit")});sendOperation(response,200,"list_delivery_events",await service.deliveryEvents(principal,eventsMatch[1]!,input as any),requestId);return;}
      const controlMatch=url.pathname.match(/^\/v2\/deliveries\/([^/]+)\/(cancel|requeue)$/);
      if(req.method==="POST"&&controlMatch){requireCurrentProtocol(response);const operation=controlMatch[2]==="cancel"?"cancel_delivery":"requeue_delivery";await authorize(operation);pathBoundInput(operation,controlMatch[1]!,await requestBody());await authority?.beginDomainWork();mutationStarted=true;const result=controlMatch[2]==="cancel"?await service.cancel(principal,controlMatch[1]!):await service.requeue(principal,controlMatch[1]!);if(!result)failure(response,404,"not_found",requestId);else sendOperation(response,200,operation,{delivery:result},requestId);return;}
      if (req.method === "POST" && url.pathname === "/v2/presence/heartbeat") {
        await authorize("heartbeat");
        const input = validateRequest("heartbeat", await requestBody());
        active(abort.signal);
        await authority?.beginDomainWork(); mutationStarted = true;
        sendOperation(response, 200, "heartbeat", await service.heartbeat(principal, input), requestId); return;
      }
      if (req.method === "GET" && url.pathname === "/v2/presence") {
        await authorize("presence");
        closedQuery(url, "presence", []);
        validateRequest("presence", {});
        sendOperation(response, 200, "presence", { agents: await service.presence(principal) }, requestId); return;
      }
      const match = url.pathname.match(/^\/v2\/deliveries\/([^/]+)\/(extend|ack|nack)$/);
      if (req.method === "POST" && match) {
        const operationId = match[2] === "extend" ? "extend_delivery" : match[2] === "ack" ? "acknowledge_delivery" : "negative_acknowledge_delivery";
        await authorize(operationId);
        const rawInput = await requestBody();
        const protocolVersion = String(response.getHeader(PROTOCOL_HEADER) ?? PROTOCOL_VERSION);
        const input = pathBoundInput(operationId, match[1]!, rawInput, protocolVersion);
        active(abort.signal);
        await authority?.beginDomainWork(); mutationStarted = true;
        const [, id, action] = match;
        const result = action === "extend"
          ? await service.extend(principal, id, input.leaseToken as string, input.leaseMs as number)
          : action === "ack"
            ? await service.ack(principal, id, input.leaseToken as string)
            : await service.nack(
                principal,
                id,
                input.leaseToken as string,
                (input.error as string | undefined) ?? "negative acknowledgment",
                (input.disposition ?? input.dead ?? "retry") as "retry" | "dead" | boolean,
                input.retryPolicy,
              );
        if (!result) failure(response, 409, "lease_conflict", requestId);
        else sendOperation(response, 200, operationId, { delivery: result }, requestId);
        return;
      }
      failure(response, 404, "not_found", requestId);
    };
    void dispatch().catch((error: any) => {
      if (res.writableEnded) return;
      metrics.errors += 1;
      if (error instanceof ContractValidationError || error instanceof ContractResponseError) {
        failure(res, error.status, error.code, requestId, { operation: error.operation, issues: error.issues });
      } else if (error?.status === 426) {
        failure(res, 426, error.code, requestId, { supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] });
      } else if (error?.code === "insufficient_scope") {
        failure(res, 403, error.code, requestId, { details: { requiredScopes: [...error.requiredScopes] } });
      } else if (error?.code === "rate_limited") {
        res.setHeader("retry-after", String(error.retryAfterSeconds));
        failure(res, 429, error.code, requestId, { details: { retryAfterSeconds: error.retryAfterSeconds } });
      } else if (error instanceof BridgeValidationError || error instanceof BridgePrincipalMismatchError) {
        failure(res, "status" in error ? error.status : 400, error.code, requestId, { message: error.message });
      } else {
        failure(res, error?.status ?? 500, error?.code ?? "internal_error", requestId);
      }
    }).finally(() => clearTimeout(timer));
  });
}
