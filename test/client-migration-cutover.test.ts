import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { adoptClient } from "../src/client-lifecycle.js";
import {
  cutoverClientMigration, finalizeClientMigration, resumeClientMigrationCutover,
} from "../src/client-migration-cutover.js";
import {
  acquireClientOperationLock, hasClientOperationLock, listClientOperations, readClientOperation,
} from "../src/client-operation.js";
import { stageClientMigrationTarget } from "../src/client-migration-stage.js";
import { createPendingEnrollment, defaultEnrollmentPath, transitionEnrollment, type EnrollmentFile } from "../src/enrollment-file.js";
import { loadManagedClientMetadata } from "../src/client-lifecycle.js";
import { SQLiteEdgeStore } from "../src/sqlite-edge-store.js";
import { securePrivatePath } from "../src/private-path.js";
import { privatePathIt } from "./private-path-policy.js";
import { privateTestDirectory } from "./private-test-path.js";

const it = privatePathIt;
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

interface Registration {
  command: string;
  identity: string;
  instance: string;
  backendConfigPath: string;
}
function codexRegistration(registration: Registration): string {
  return JSON.stringify({
    name: "agent-bridge", enabled: true,
    transport: {
      type: "stdio", command: registration.command, args: [],
      env: {
        AGENT_BRIDGE_AGENT: registration.identity,
        AGENT_BRIDGE_INSTANCE: registration.instance,
        AGENT_BRIDGE_CONFIG: registration.backendConfigPath,
      },
    },
  });
}
function commandResult(stdout = "") {
  return { pid: 1, output: [], stdout, stderr: "", status: 0, signal: null };
}
function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "x-agent-bridge-protocol-version": "2.1",
      "x-agent-bridge-supported-protocol-versions": "2.0, 2.1",
    },
  });
}

function fixture(runtime: "codex" | "claude-desktop" = "codex") {
  const home = realpathSync(privateTestDirectory(runtime === "claude-desktop"
    ? "agent-bridge-cutover-desktop-" : "agent-bridge-cutover-"));
  homes.push(home);
  const env = { HOME: home, CODEX_HOME: join(home, ".codex") };
  const instance = "codex-cutover";
  const identity = "cutover-worker";
  const predecessorCredentialId = "019f7fd1-0000-7000-8000-000000000011";
  const successorCredentialId = "019f7fd1-0000-7000-8000-000000000012";
  const clients = join(home, ".agent-bridge", "clients");
  mkdirSync(clients, { recursive: true, mode: 0o700 });
  securePrivatePath(join(home, ".agent-bridge"), "directory"); securePrivatePath(clients, "directory");
  const sourceEdgePath = join(home, ".agent-bridge", "source-edge.sqlite3");
  const backendConfigPath = join(clients, "codex-cutover.config");
  writeFileSync(backendConfigPath, [
    "AGENT_BRIDGE_PROVIDER=gateway",
    "AGENT_BRIDGE_WORKSPACE=team",
    "AGENT_BRIDGE_URL=https://old.bridge.example.test",
    "AGENT_BRIDGE_TOKEN=source-token",
    `AGENT_BRIDGE_EDGE_DB=${sourceEdgePath}`,
    `AGENT_BRIDGE_CREDENTIAL_ID=${predecessorCredentialId}`,
    `AGENT_BRIDGE_PRINCIPAL=${identity}`,
    `AGENT_BRIDGE_CLIENT_INSTANCE=${instance}`,
    "",
  ].join("\n"), { mode: 0o600 });
  securePrivatePath(backendConfigPath, "file");
  let registration: Registration | null = {
    command: "agent-bridge-mcp", identity, instance, backendConfigPath,
  };
  let crashAfterRemove = false;
  let authorityMismatch = false;
  let routeMismatch: "issuer" | "verifier" | "consumed" | null = null;
  let grantedScopes: unknown = ["status:read", "messages:write"];
  let issuedCredentialId: string | undefined;
  let verifiedCredentialId: string | undefined;
  const commandCalls: string[][] = [];
  const events: string[] = [];
  const execute = (_command: string, args: string[]) => {
    commandCalls.push(args);
    events.push(`command:${args.slice(0, 2).join(" ")}`);
    if (args[0] === "mcp" && args[1] === "get") {
      return registration
        ? commandResult(codexRegistration(registration))
        : { ...commandResult(), stdout: "", stderr: "Error: No MCP server named 'agent-bridge' found.", status: 1 };
    }
    if (args[0] === "mcp" && args[1] === "remove") {
      registration = null;
      return crashAfterRemove ? { ...commandResult(), status: 1 } : commandResult();
    }
    if (args[0] === "mcp" && args[1] === "add") {
      const config = args.find((value) => value.startsWith("AGENT_BRIDGE_CONFIG="))?.slice("AGENT_BRIDGE_CONFIG=".length);
      if (!config) throw new Error("test registration add omitted backend");
      registration = { command: "agent-bridge-mcp", identity, instance, backendConfigPath: config };
      return commandResult();
    }
    return commandResult();
  };
  const desktopConfigPath = join(home, "desktop.json");
  const desktopCommand = realpathSync(process.execPath);
  if (runtime === "claude-desktop") {
    writeFileSync(desktopConfigPath, JSON.stringify({ mcpServers: {
      "agent-bridge": { command: desktopCommand, args: [], env: {
        AGENT_BRIDGE_AGENT: identity, AGENT_BRIDGE_INSTANCE: instance, AGENT_BRIDGE_CONFIG: backendConfigPath,
      } },
    } }), { mode: 0o600 });
    securePrivatePath(desktopConfigPath, "file");
  }
  const adopted = runtime === "codex"
    ? adoptClient("codex", identity, { instance, backendConfigPath, apply: true, env }, execute)
    : adoptClient("claude-desktop", identity, {
      instance, backendConfigPath, command: desktopCommand, configPath: desktopConfigPath, apply: true, env,
    });
  const enrollment: EnrollmentFile = {
    schema: "agent-bridge.enrollment", version: 1, provider: "gateway", revision: 0,
    state: "pending", operation: "rotate", requestId: "019f7fd1-0000-7000-8000-000000000013",
    createdAt: new Date().toISOString(), completedAt: null,
    input: {
      gatewayUrl: "https://new.bridge.example.test", workspaceId: "team", principal: identity,
      runtime, instance, credentialId: predecessorCredentialId, workspaceName: null,
      displayName: null, runtimeType: runtime, label: null, scopeSetName: "release-a-full", expiresAt: null,
      graceUntil: new Date(Date.now() + 60 * 60_000).toISOString(), invalidateImmediately: false,
    }, token: "successor-token", result: null,
  };
  const enrollmentFile = defaultEnrollmentPath(enrollment.requestId, env);
  createPendingEnrollment(enrollmentFile, enrollment, env);
  transitionEnrollment(enrollmentFile, enrollment, "ready", {
    completedAt: new Date().toISOString(),
    result: { workspaceId: "team", principal: identity, agentId: null, credentialId: successorCredentialId, replayed: false },
  }, env);
  const fetchCalls: string[] = [];
  const challengeRequests: Array<{ url: string; body: Record<string, string>; authorization: string | null }> = [];
  const messageRequests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  const authorityId = "019f7fd1-0000-7000-8000-000000000099";
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input); fetchCalls.push(url); events.push(`fetch:${url}`);
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.endsWith("/readyz")) return new Response("ready", { status: 200 });
    const source = url.startsWith("https://old.bridge.example.test/");
    if (url.endsWith("/v2/status")) return response({
      schemaVersion: "postgres-v2", deliverySupported: true, pending: 0, claimed: 0, retrying: 0, dead: 0,
      principal: { workspace: "team", agent: identity },
      credentialId: source ? predecessorCredentialId : successorCredentialId,
      gatewayAuthorityId: authorityMismatch && !source
        ? "019f7fd1-0000-7000-8000-000000000098" : authorityId,
    });
    if (url.endsWith("/v2/capabilities")) return response({
      protocolVersion: "2.1", currentProtocolVersion: "2.1", selectedProtocolVersion: "2.1",
      supportedProtocolVersions: ["2.0", "2.1"], scopeEnforcement: true, requestAuthority: true,
      rowIsolation: true, authorizationModel: "scoped-credential", surface: "http", provider: "gateway",
      grantedScopes,
      operations: [],
    });
    if (url.endsWith("/v2/endpoint-migration-challenges")) {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      challengeRequests.push({ url, body, authorization });
      if (source && authorization === "Bearer source-token") issuedCredentialId = predecessorCredentialId;
      else if ((source || url.startsWith("https://new.bridge.example.test/")) && authorization === "Bearer successor-token") issuedCredentialId = successorCredentialId;
      else throw new Error("route challenge used an unexpected credential");
      verifiedCredentialId = body.verifierCredentialId;
      return response({
        gatewayAuthorityId: authorityId,
        issuerCredentialId: routeMismatch === "issuer" ? verifiedCredentialId : issuedCredentialId,
        verifierCredentialId: routeMismatch === "verifier" ? issuedCredentialId : verifiedCredentialId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    if (url.endsWith("/v2/endpoint-migration-challenges/consume")) {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      challengeRequests.push({ url, body, authorization });
      if (!issuedCredentialId || !verifiedCredentialId) throw new Error("consume without issued challenge");
      if (!url.startsWith("https://new.bridge.example.test/") || authorization !== "Bearer successor-token") {
        throw new Error("route challenge was not consumed by the successor credential");
      }
      if (body.issuerCredentialId !== issuedCredentialId) throw new Error("consume used an unexpected issuer credential");
      return response({
        gatewayAuthorityId: authorityId,
        issuerCredentialId: routeMismatch === "issuer" ? verifiedCredentialId : issuedCredentialId,
        verifierCredentialId: routeMismatch === "verifier" ? issuedCredentialId : verifiedCredentialId,
        expiresAt: null, consumed: routeMismatch !== "consumed",
      });
    }
    if (url.endsWith("/v2/messages")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      messageRequests.push({ url, body, authorization });
      if (!url.startsWith("https://new.bridge.example.test/") || authorization !== "Bearer successor-token") {
        throw new Error("source replay did not use the target successor gateway");
      }
      return response({
        created: true,
        message: {
          ...body, workspace: "team", source: identity, sequence: "1",
          createdAt: new Date().toISOString(), deliveryPolicy: { mode: "mailbox" },
        },
      }, 201);
    }
    throw new Error(`unexpected gateway request ${url}`);
  };
  return {
    home, env, instance, identity, runtime, execute, backendConfigPath, sourceEdgePath, predecessorCredentialId,
    successorCredentialId, authorityId, registration: () => registration, adopted, enrollmentFile, fetch, fetchCalls,
    challengeRequests, messageRequests, commandCalls, events,
    setCrashAfterRemove: (value: boolean) => { crashAfterRemove = value; },
    setAuthorityMismatch: (value: boolean) => { authorityMismatch = value; },
    setRouteMismatch: (value: "issuer" | "verifier" | "consumed" | null) => { routeMismatch = value; },
    setGrantedScopes: (value: unknown) => { grantedScopes = value; },
  };
}

async function stage(state: ReturnType<typeof fixture>) {
  const plan = await stageClientMigrationTarget({
    runtime: state.runtime, identity: state.identity, instance: state.instance, enrollmentFile: state.enrollmentFile,
    apply: true, env: state.env, execute: state.execute, verifySource: async () => {}, verifyTarget: async () => {},
  });
  if (!plan.operationId || !plan.targetBackendPath) throw new Error("test staging did not produce an operation");
  return plan;
}

async function enqueueSource(state: ReturnType<typeof fixture>, id: string, now = new Date()) {
  const source = new SQLiteEdgeStore(state.sourceEdgePath, {
    endpoint: "https://old.bridge.example.test", principal: { workspace: "team", agent: state.identity },
  });
  await source.initialize();
  await source.enqueue({
    id, workspace: "team", source: state.identity, type: "note", content: "queued cutover work",
    contentType: "text/plain", targets: [], priority: "high",
  }, now);
  return source;
}

function addManagedSourceAlias(state: ReturnType<typeof fixture>) {
  const backend = join(state.home, ".agent-bridge", "clients", "source-alias.config");
  linkSync(state.backendConfigPath, backend);
  const configPath = join(state.home, "source-alias-desktop.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {
    "agent-bridge": { command: realpathSync(process.execPath), args: [], env: {
      AGENT_BRIDGE_AGENT: state.identity,
      AGENT_BRIDGE_INSTANCE: "source-alias",
      AGENT_BRIDGE_CONFIG: backend,
    } },
  } }), { mode: 0o600 });
  securePrivatePath(backend, "file"); securePrivatePath(configPath, "file");
  return adoptClient("claude-desktop", state.identity, {
    instance: "source-alias", backendConfigPath: backend, command: realpathSync(process.execPath),
    configPath, apply: true, env: state.env,
  });
}

function createRecoverableClientLock(state: ReturnType<typeof fixture>) {
  const lock = acquireClientOperationLock(state.runtime, state.instance, state.env);
  const metadata = JSON.parse(readFileSync(lock.lockPath, "utf8")) as Record<string, unknown>;
  metadata.pid = 2_147_483_647;
  metadata.host = hostname();
  metadata.createdAt = new Date(0).toISOString();
  writeFileSync(lock.lockPath, JSON.stringify(metadata), { mode: 0o600 });
  securePrivatePath(lock.lockPath, "file");
  return lock;
}

describe("client endpoint migration cutover", () => {
  it("keeps dry-run read-only and does not contact either gateway", async () => {
    const state = fixture(); const staged = await stage(state);
    const metadataBefore = readFileSync(state.adopted.metadataPath, "utf8");
    const edgeBefore = existsSync(state.sourceEdgePath);
    const plan = await cutoverClientMigration({ stageOperationId: staged.operationId!, exclusiveEdge: true, env: state.env, execute: state.execute, fetch: state.fetch });
    expect(plan).toMatchObject({ applied: false, action: "migrate-cutover" });
    expect(readFileSync(state.adopted.metadataPath, "utf8")).toBe(metadataBefore);
    expect(state.fetchCalls).toEqual([]);
    expect(existsSync(state.sourceEdgePath)).toBe(edgeBefore);
  });

  it("proves both gateways before draining, then retains full forward contracts", async () => {
    const state = fixture(); const staged = await stage(state);
    const result = await cutoverClientMigration({
      stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
      env: state.env, execute: state.execute, fetch: state.fetch,
    });
    const operation = readClientOperation(result.operationId!, state.env);
    const retained = operation.completion?.migration;
    expect(result).toMatchObject({ applied: true, action: "migrate-cutover" });
    expect(retained).toMatchObject({
      kind: "migrate-cutover", stageContract: { stageOperationId: staged.operationId },
      sourceMetadata: { backendConfigPath: state.backendConfigPath },
      targetMetadata: { backendConfigPath: staged.targetBackendPath },
      sourceRegistration: { state: "exact", observed: { state: "present" } },
      targetRegistration: { state: "exact", observed: { state: "present" } },
      sourceGatewayUrl: "https://old.bridge.example.test",
    });
    expect(state.fetchCalls.findIndex((url) => url.endsWith("/endpoint-migration-challenges"))).toBeGreaterThanOrEqual(0);
    const [issued, consumed] = state.challengeRequests;
    expect(issued).toMatchObject({
      url: "https://old.bridge.example.test/v2/endpoint-migration-challenges",
      body: {
        expectedGatewayAuthorityId: state.authorityId,
        verifierCredentialId: state.successorCredentialId,
      },
      authorization: "Bearer source-token",
    });
    expect(consumed).toMatchObject({
      url: "https://new.bridge.example.test/v2/endpoint-migration-challenges/consume",
      body: {
        expectedGatewayAuthorityId: state.authorityId,
        issuerCredentialId: state.predecessorCredentialId,
      },
      authorization: "Bearer successor-token",
    });
    expect(consumed!.body.challenge).toBe(issued!.body.challenge);
    const sourceIssues = state.challengeRequests.filter((request) =>
      request.url === "https://old.bridge.example.test/v2/endpoint-migration-challenges",
    );
    expect(sourceIssues[0]).toMatchObject({ authorization: "Bearer source-token" });
    expect(sourceIssues.slice(1)).not.toHaveLength(0);
    expect(sourceIssues.slice(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        authorization: "Bearer successor-token",
        body: expect.objectContaining({ verifierCredentialId: state.successorCredentialId }),
      }),
    ]));
    expect(state.events.findIndex((event) => event === "command:mcp remove")).toBeGreaterThan(
      state.events.findIndex((event) => event.includes("/endpoint-migration-challenges/consume")),
    );
    expect(state.registration()).toMatchObject({ backendConfigPath: staged.targetBackendPath });
    expect(loadManagedClientMetadata("codex", state.instance, state.env).backendConfigPath).toBe(staged.targetBackendPath);
    const source = new SQLiteEdgeStore(state.sourceEdgePath, { endpoint: "https://old.bridge.example.test", principal: { workspace: "team", agent: state.identity } });
    await source.initialize();
    expect(await source.migrationGate()).toMatchObject({ state: "draining", operationId: result.operationId });
    await source.close();
  });

  it("rejects challenge responses that do not bind the staged route pair", async () => {
    for (const mismatch of ["issuer", "verifier", "consumed"] as const) {
      const state = fixture(); const staged = await stage(state);
      state.setRouteMismatch(mismatch);
      await expect(cutoverClientMigration({
        stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
        env: state.env, execute: state.execute, fetch: state.fetch,
      })).rejects.toThrow("gateway");
    }
  }, 30_000);

  it("refuses a successor without the required status and publish scopes before draining", async () => {
    for (const scopes of [["messages:write"], ["status:read"]]) {
      const state = fixture(); const staged = await stage(state);
      state.setGrantedScopes(scopes);
      await expect(cutoverClientMigration({
        stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
        env: state.env, execute: state.execute, fetch: state.fetch,
      })).rejects.toThrow("successor credential lacks");
      const source = new SQLiteEdgeStore(state.sourceEdgePath, {
        endpoint: "https://old.bridge.example.test", principal: { workspace: "team", agent: state.identity },
      });
      await source.initialize();
      expect(await source.migrationGate()).toMatchObject({ state: "active" });
      await source.close();
      expect(state.registration()).toMatchObject({ backendConfigPath: state.backendConfigPath });
      expect(state.commandCalls.some((args) => args[1] === "remove")).toBe(false);
    }
  });

  it("refuses a successor whose capabilities omit a valid granted-scope list", async () => {
    for (const granted of [undefined, "status:read", ["status:read", ""]]) {
      const state = fixture(); const staged = await stage(state);
      state.setGrantedScopes(granted);
      await expect(cutoverClientMigration({
        stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
        env: state.env, execute: state.execute, fetch: state.fetch,
      })).rejects.toThrow("does not include valid granted scopes");
      expect(state.commandCalls.some((args) => args[1] === "remove")).toBe(false);
    }
  });

  it("replays queued source outbox work through the target successor gateway", async () => {
    const state = fixture(); const staged = await stage(state);
    const source = await enqueueSource(state, "018f4a70-0000-7000-8000-000000000141");
    await source.close();
    await expect(cutoverClientMigration({
      stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
      env: state.env, execute: state.execute, fetch: state.fetch,
    })).resolves.toMatchObject({ applied: true, action: "migrate-cutover" });
    expect(state.messageRequests).toEqual([
      expect.objectContaining({
        url: "https://new.bridge.example.test/v2/messages", authorization: "Bearer successor-token",
        body: expect.objectContaining({ id: "018f4a70-0000-7000-8000-000000000141" }),
      }),
    ]);
  });

  it("resumes a scheduled source retry after predecessor grace has elapsed", async () => {
    const state = fixture(); const staged = await stage(state);
    const beforeGrace = new Date();
    const afterGrace = new Date(beforeGrace.getTime() + 2 * 60 * 60_000);
    const source = await enqueueSource(state, "018f4a70-0000-7000-8000-000000000142", beforeGrace);
    const pending = await source.claimNext(beforeGrace);
    if (!pending) throw new Error("test source outbox did not enqueue");
    await source.retry(pending, "network_error", new Date(beforeGrace.getTime() + 90 * 60_000));
    await source.close();
    await expect(cutoverClientMigration({
      stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
      env: state.env, execute: state.execute, fetch: state.fetch, now: () => beforeGrace,
    })).rejects.toThrow("scheduled, leased, or retrying work");
    const operation = listClientOperations(state.env).find((item) => item.operation === "migrate-cutover");
    if (!operation) throw new Error("test migration operation is missing");
    await expect(resumeClientMigrationCutover({
      operationId: operation.operationId, env: state.env, execute: state.execute, fetch: state.fetch,
      now: () => afterGrace,
    })).resolves.toMatchObject({ applied: true, action: "migrate-cutover" });
    expect(state.messageRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: "https://new.bridge.example.test/v2/messages", authorization: "Bearer successor-token",
        body: expect.objectContaining({ id: "018f4a70-0000-7000-8000-000000000142" }),
      }),
    ]));
  });

  it("resumes an intent-recorded native removal from its exact absent state", async () => {
    const state = fixture(); const staged = await stage(state);
    state.setCrashAfterRemove(true);
    await expect(cutoverClientMigration({
      stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
      env: state.env, execute: state.execute, fetch: state.fetch,
    })).rejects.toThrow("MCP remove failed");
    const pending = readClientOperation(
      listClientOperations(state.env)
        .find((item) => item.operation === "migrate-cutover")!.operationId,
      state.env,
    );
    expect(pending.steps[1]).toMatchObject({ state: "intent-recorded" });
    // The retained contract must resume from the target backend and its
    // credential-free source route. The predecessor file and grace can both
    // disappear after the journal has begun.
    rmSync(state.backendConfigPath);
    state.setCrashAfterRemove(false);
    await expect(resumeClientMigrationCutover({
      operationId: pending.operationId, env: state.env, execute: state.execute, fetch: state.fetch,
    })).rejects.toThrow("edge scope is draining");
    await expect(resumeClientMigrationCutover({
      operationId: pending.operationId, env: state.env, execute: state.execute, fetch: state.fetch,
      now: () => new Date(Date.now() + 60_000),
    })).resolves.toMatchObject({ applied: true, action: "migrate-cutover" });
    expect(state.registration()).toMatchObject({ backendConfigPath: staged.targetBackendPath });
    expect(state.challengeRequests.filter((request) =>
      request.url === "https://old.bridge.example.test/v2/endpoint-migration-challenges",
    ).slice(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorization: "Bearer successor-token" }),
    ]));
  });

  it("rejects retained resume when the successor backend provider drifts from gateway", async () => {
    const state = fixture(); const staged = await stage(state);
    state.setCrashAfterRemove(true);
    await expect(cutoverClientMigration({
      stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
      env: state.env, execute: state.execute, fetch: state.fetch,
    })).rejects.toThrow("MCP remove failed");
    const pending = listClientOperations(state.env).find((item) => item.operation === "migrate-cutover");
    if (!pending) throw new Error("test migration operation is missing");
    state.setCrashAfterRemove(false);
    writeFileSync(staged.targetBackendPath!, readFileSync(staged.targetBackendPath!, "utf8")
      .replace("AGENT_BRIDGE_PROVIDER=gateway", "AGENT_BRIDGE_PROVIDER=local"), { mode: 0o600 });
    securePrivatePath(staged.targetBackendPath!, "file");
    await expect(resumeClientMigrationCutover({
      operationId: pending.operationId, env: state.env, execute: state.execute, fetch: state.fetch,
      now: () => new Date(Date.now() + 60_000),
    })).rejects.toThrow("managed backend must use gateway provider");
  });

  it("re-attests the source cohort before a resumed host mutation", async () => {
    const state = fixture(); const staged = await stage(state);
    state.setCrashAfterRemove(true);
    await expect(cutoverClientMigration({
      stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
      env: state.env, execute: state.execute, fetch: state.fetch,
    })).rejects.toThrow("MCP remove failed");
    const pending = listClientOperations(state.env).find((item) => item.operation === "migrate-cutover");
    if (!pending) throw new Error("test migration operation is missing");
    state.setCrashAfterRemove(false);
    addManagedSourceAlias(state);
    await expect(resumeClientMigrationCutover({
      operationId: pending.operationId, env: state.env, execute: state.execute, fetch: state.fetch,
      now: () => new Date(Date.now() + 60_000),
    })).rejects.toThrow("shared_edge_cohort");
    expect(state.registration()).toBeNull();
  });

  it("refuses finalization before grace expiry and finalizes after it", async () => {
    const state = fixture(); const staged = await stage(state);
    const forward = await cutoverClientMigration({ stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true, env: state.env, execute: state.execute, fetch: state.fetch });
    const forwardManifest = readClientOperation(forward.operationId!, state.env);
    const grace = new Date((forwardManifest.completion!.migration as { predecessorGraceUntil: string }).predecessorGraceUntil);
    const beforeGrace = new Date(Date.now() + 60_000);
    const afterGrace = new Date(grace.getTime() + 1);
    createRecoverableClientLock(state);
    await expect(finalizeClientMigration({ cutoverOperationId: forward.operationId!, apply: true, exclusiveEdge: true, env: state.env, execute: state.execute, fetch: state.fetch, now: () => beforeGrace }))
      .rejects.toThrow("not eligible for finalization");
    await expect(finalizeClientMigration({ cutoverOperationId: forward.operationId!, apply: true, exclusiveEdge: true, recoverLock: true, env: state.env, execute: state.execute, fetch: state.fetch, now: () => afterGrace }))
      .resolves.toMatchObject({ applied: true, action: "migrate-finalize" });
    expect(hasClientOperationLock(state.runtime, state.instance, state.env)).toBe(false);
  });

  it("uses the Desktop-shaped cutover journal", async () => {
    const state = fixture("claude-desktop"); const staged = await stage(state);
    const forward = await cutoverClientMigration({
      stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
      env: state.env, execute: state.execute, fetch: state.fetch,
    });
    const forwardManifest = readClientOperation(forward.operationId!, state.env);
    expect(forwardManifest.completion?.stepCount).toBe(3);
    expect(loadManagedClientMetadata("claude-desktop", state.instance, state.env).backendConfigPath).toBe(staged.targetBackendPath);
  });

  it("keeps all phase dry-runs local and side-effect free", async () => {
    const state = fixture(); const staged = await stage(state);
    const forward = await cutoverClientMigration({
      stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
      env: state.env, execute: state.execute, fetch: state.fetch,
    });
    const metadataBefore = readFileSync(state.adopted.metadataPath, "utf8");
    const fetchBefore = state.fetchCalls.length;
    const edgeDirectoryBefore = readdirSync(dirname(state.sourceEdgePath)).sort();
    const grace = new Date((readClientOperation(forward.operationId!, state.env).completion!.migration as { predecessorGraceUntil: string }).predecessorGraceUntil);
    await expect(finalizeClientMigration({
      cutoverOperationId: forward.operationId!, exclusiveEdge: true,
      env: state.env, execute: state.execute, fetch: state.fetch, now: () => new Date(grace.getTime() + 1),
    })).resolves.toMatchObject({ applied: false });
    expect(readFileSync(state.adopted.metadataPath, "utf8")).toBe(metadataBefore);
    expect(state.fetchCalls.length).toBe(fetchBefore);
    expect(readdirSync(dirname(state.sourceEdgePath)).sort()).toEqual(edgeDirectoryBefore);
  });

  it("refuses source retirement when another managed client retains a hardlinked source backend", async () => {
    const state = fixture(); const staged = await stage(state);
    const forward = await cutoverClientMigration({
      stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
      env: state.env, execute: state.execute, fetch: state.fetch,
    });
    addManagedSourceAlias(state);
    const retained = readClientOperation(forward.operationId!, state.env).completion!.migration as { predecessorGraceUntil: string };
    await expect(finalizeClientMigration({
      cutoverOperationId: forward.operationId!, apply: true, exclusiveEdge: true,
      env: state.env, execute: state.execute, fetch: state.fetch,
      now: () => new Date(new Date(retained.predecessorGraceUntil).getTime() + 1),
    })).rejects.toThrow("source_edge_cohort");
  });

  it("recovers a stale same-host lock before finalization applies", async () => {
    const state = fixture(); const staged = await stage(state);
    const forward = await cutoverClientMigration({
      stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
      env: state.env, execute: state.execute, fetch: state.fetch,
    });
    const retained = readClientOperation(forward.operationId!, state.env).completion!.migration as { predecessorGraceUntil: string };
    createRecoverableClientLock(state);
    await expect(finalizeClientMigration({
      cutoverOperationId: forward.operationId!, apply: true, exclusiveEdge: true, recoverLock: true,
      env: state.env, execute: state.execute, fetch: state.fetch,
      now: () => new Date(new Date(retained.predecessorGraceUntil).getTime() + 1),
    })).resolves.toMatchObject({ applied: true, action: "migrate-finalize" });
    expect(hasClientOperationLock(state.runtime, state.instance, state.env)).toBe(false);
  });

  it("rejects a managed hardlink cohort and authority drift before host removal", async () => {
    const state = fixture(); const staged = await stage(state);
    const otherBackend = join(state.home, ".agent-bridge", "clients", "other.config");
    linkSync(state.backendConfigPath, otherBackend);
    const otherConfig = join(state.home, "other-desktop.json");
    writeFileSync(otherConfig, JSON.stringify({ mcpServers: {
      "agent-bridge": { command: realpathSync(process.execPath), args: [], env: {
        AGENT_BRIDGE_AGENT: state.identity, AGENT_BRIDGE_INSTANCE: "other-instance", AGENT_BRIDGE_CONFIG: otherBackend,
      } },
    } }), { mode: 0o600 });
    securePrivatePath(otherBackend, "file"); securePrivatePath(otherConfig, "file");
    const other = adoptClient("claude-desktop", state.identity, {
      instance: "other-instance", backendConfigPath: otherBackend, command: realpathSync(process.execPath),
      configPath: otherConfig, apply: true, env: state.env,
    });
    await expect(cutoverClientMigration({
      stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
      env: state.env, execute: state.execute, fetch: state.fetch,
    })).rejects.toThrow("shared_edge_cohort");
    state.setAuthorityMismatch(true);
    // Remove the test-only extra metadata so the following rejection proves the
    // live authority preflight, not cohort detection.
    rmSync(other.metadataPath, { force: true });
    await expect(cutoverClientMigration({
      stageOperationId: staged.operationId!, apply: true, exclusiveEdge: true,
      env: state.env, execute: state.execute, fetch: state.fetch,
    })).rejects.toThrow("gateway authority IDs differ");
    expect(state.commandCalls.some((args) => args[1] === "remove")).toBe(false);
  });
});
