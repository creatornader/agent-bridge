import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgentBridgeServer, MCP_IMPLEMENTATION_VERSION } from "../src/server.js";
import { formatContractArtifact, normalizeContractArtifact } from "../src/contracts/artifact-format.js";
import {
  availableOperations,
  capabilityDocument,
  negotiateProtocolVersion,
  operationForCli,
  operations,
  parseCliResponse,
  parseResponse,
  parseResponseForProtocol,
  SCOPE_ENFORCEMENT,
  SUPPORTED_PROTOCOL_VERSIONS,
  validateRequest,
} from "../src/contracts/registry.js";
import { validateMessageDraft } from "../src/bridge-domain.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("canonical v2 contract registry", () => {
  it("defines typed operations and reserved scope metadata", () => {
    expect(operations.map((operation) => operation.id)).toEqual([
      "capabilities", "status", "issue_endpoint_migration_challenge", "consume_endpoint_migration_challenge", "client_status", "gateway_metrics", "publish_message", "history",
      "record_receipt", "claim_delivery", "list_deliveries", "list_delivery_events",
      "cancel_delivery", "requeue_delivery", "extend_delivery", "acknowledge_delivery",
      "negative_acknowledge_delivery", "heartbeat", "presence", "sync",
    ]);
    expect(SCOPE_ENFORCEMENT).toBe(true);
    expect(operations.find((entry) => entry.id === "capabilities")?.scopes).toEqual([]);
    for (const operation of operations) {
      expect(operation.request).toBeTruthy();
      expect(operation.response).toBeTruthy();
      expect(operation.providers.length).toBeGreaterThan(0);
      expect(operation.mcp || operation.http || operation.cli).toBeTruthy();
      expect(operation.scopes.every((scope) => !scope.startsWith("bridge:"))).toBe(true);
    }
  });

  it("keeps operation and surface identifiers unique", () => {
    const unique = (values: string[]) => expect(new Set(values).size).toBe(values.length);
    unique(operations.map((entry) => entry.id));
    unique(operations.flatMap((entry) => entry.mcp ? [entry.mcp.name] : []));
    unique(operations.flatMap((entry) => entry.http ? [`${entry.http.method} ${entry.http.path}`] : []));
    unique(operations.flatMap((entry) => entry.cli ? [entry.cli.command, ...(entry.cli.aliases ?? [])] : []));
  });

  it("resolves conditional CLI variants through the registry", () => {
    expect(operationForCli("get", "local")?.id).toBe("history");
    expect(operationForCli("ack", "local")?.id).toBe("acknowledge_delivery");
    expect(operationForCli("ack", "local", ["ids"])?.id).toBe("record_receipt");
  });

  it("validates closed requests and additive responses", () => {
    expect(() => validateRequest("publish_message", { type: "note", content: "ok", surprise: true })).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    const uuidv7 = "018f4a70-0000-7000-8000-000000000123";
    expect(validateRequest("publish_message", { id: uuidv7, type: "note", content: "ok" })).toMatchObject({ id: uuidv7 });
    expect(() => validateRequest("publish_message", { id: "018f4a70-0000-4000-8000-000000000123", type: "note", content: "ok" })).toThrow();
    expect(validateMessageDraft({ id: uuidv7, type: "note", content: "ok" }).id).toBe(uuidv7);
    expect(validateMessageDraft({ id: uuidv7.toUpperCase(), type: "note", content: "ok" }).id).toBe(uuidv7);
    expect(validateMessageDraft({ id: "018f4a70-0000-8000-8000-000000000123", type: "note", content: "ok" }).id)
      .toBe("018f4a70-0000-8000-8000-000000000123");
    expect(() => validateRequest("publish_message", { workspace: "client-space", type: "note", content: "ok" })).toThrow();
    expect(validateRequest("publish_message", { source: "worker", type: "note", content: "ok" })).toMatchObject({ source: "worker" });
    expect(parseResponse("record_receipt", { recorded: 1, futureField: true })).toMatchObject({ futureField: true });
    expect(parseResponse("claim_delivery", { delivery: null })).toEqual({ delivery: null });
    expect(() => parseResponse("claim_delivery", { delivery: null, leaseToken: "unexpected" })).toThrow();
    expect(parseResponse("status", {
      schemaVersion: "postgres-v2", deliverySupported: true,
      pending: 0, claimed: 0, retrying: 0, dead: 0,
    })).not.toHaveProperty("gatewayAuthorityId");
    expect(parseResponse("status", {
      schemaVersion: "postgres-v2", deliverySupported: true,
      pending: 0, claimed: 0, retrying: 0, dead: 0,
      gatewayAuthorityId: "00000000-0000-4000-8000-000000000003",
      credentialId: "00000000-0000-4000-8000-000000000004",
    })).toMatchObject({
      gatewayAuthorityId: "00000000-0000-4000-8000-000000000003",
      credentialId: "00000000-0000-4000-8000-000000000004",
    });
    expect(parseResponse("capabilities", {
      protocolVersion: "2.1", currentProtocolVersion: "2.1", selectedProtocolVersion: "2.1",
      supportedProtocolVersions: ["2.0", "2.1"], scopeEnforcement: true, requestAuthority: true,
      rowIsolation: true, authorizationModel: "scoped-credential", surface: "http", provider: "gateway",
      grantedScopes: ["status:read", "messages:write"], operations: [],
    })).toMatchObject({ grantedScopes: ["status:read", "messages:write"] });
  });

  it("negotiates only versions the gateway serves", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(["2.0", "2.1"]);
    expect(negotiateProtocolVersion(undefined)).toBe("2.0");
    expect(negotiateProtocolVersion("2.0")).toBe("2.0");
    expect(negotiateProtocolVersion("2.1")).toBe("2.1");
    expect(() => negotiateProtocolVersion("2.7")).toThrowError(expect.objectContaining({ status: 426, code: "unsupported_protocol_version", supported: "2.0,2.1" }));
    expect(() => negotiateProtocolVersion("3.0")).toThrowError(expect.objectContaining({ status: 426 }));
  });

  it("validates and normalizes the released d8184fe wire fixtures as protocol 2.0", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/legacy-contracts.json", import.meta.url), "utf8")).gateway_2_0;
    expect(parseResponseForProtocol("publish_message", { created: true, message: fixture.message }, "2.0"))
      .toEqual({ created: true, message: fixture.message });
    expect(parseResponseForProtocol("history", { messages: [fixture.message] }, "2.0"))
      .toEqual({ messages: [fixture.message] });
    expect(parseResponseForProtocol("claim_delivery", { delivery: fixture.delivery, leaseToken: "lease-token" }, "2.0"))
      .toMatchObject({ delivery: fixture.delivery });
    expect(parseResponseForProtocol("acknowledge_delivery", fixture.delivery, "2.0"))
      .toEqual({ delivery: fixture.delivery });
    expect((parseResponseForProtocol("publish_message", { created: true, message: fixture.message }, "2.0") as any).message)
      .not.toHaveProperty("deliveryPolicy");
  });

  it("filters capabilities by surface and provider", () => {
    for (const surface of ["mcp", "http", "cli"] as const) {
      for (const provider of ["local", "gateway", "legacy-supabase"] as const) {
        const document = capabilityDocument({ surface, provider });
        expect(document.scopeEnforcement).toBe(provider === "gateway");
        expect(document.authorizationModel).toBe(provider === "gateway" ? "scoped-credential" : provider === "local" ? "process-identity" : "legacy-key");
        expect(document.operations.map((entry) => entry.id)).toEqual(
          availableOperations({ surface, provider }).map((entry) => entry.id),
        );
      }
    }
    expect(capabilityDocument({ surface: "mcp", provider: "legacy-supabase" }).operations.map((entry) => entry.id)).toEqual([
      "capabilities", "publish_message", "history",
    ]);
    expect(capabilityDocument({ surface: "http", provider: "gateway" }).operations.some((entry) => entry.id === "sync")).toBe(false);
    expect(capabilityDocument({ surface: "http", provider: "gateway" }).requestAuthority).toBe(false);
    expect(capabilityDocument({ surface: "http", provider: "gateway", requestAuthority: true }).requestAuthority).toBe(true);
    expect(capabilityDocument({ surface: "http", provider: "gateway", rowIsolation: true }).rowIsolation).toBe(false);
    expect(capabilityDocument({ surface: "http", provider: "gateway", requestAuthority: true, rowIsolation: true }).rowIsolation).toBe(true);
    expect(capabilityDocument({ surface: "mcp", provider: "local", rowIsolation: true }).rowIsolation).toBe(false);
    expect(capabilityDocument({ surface: "cli", provider: "local" }).operations.find((entry) => entry.id === "client_status")?.cli).toMatchObject({ command: "status", aliases: ["doctor"] });
    const cli = capabilityDocument({ surface: "cli", provider: "local" });
    expect(cli.operations.find((entry) => entry.id === "history")?.cli?.variants).toEqual([
      expect.objectContaining({
        command: "get",
        condition: { kind: "always" },
        routesTo: "history",
      }),
    ]);
    expect(cli.operations.find((entry) => entry.id === "record_receipt")?.cli?.variants).toEqual([
      expect.objectContaining({
        command: "ack",
        condition: { kind: "option-present", option: "ids" },
        routesTo: "record_receipt",
      }),
    ]);
  });

  it("validates CLI compatibility variant output schemas", () => {
    const row = {
      id: "018f4a70-0000-7000-8000-000000000123",
      source: "worker",
      category: "note",
      content: "ok",
      priority: "info",
      project: null,
      metadata: {},
      created_at: "2026-07-14T12:00:00.000Z",
    };
    expect(parseCliResponse("history", [row], { command: "get" })).toEqual([row]);
    expect(() => parseCliResponse("history", [{ ...row, created_at: 42 }], { command: "get" })).toThrowError(expect.objectContaining({ code: "protocol_mismatch" }));
    expect(parseCliResponse("record_receipt", { acknowledged: 1, agent: "worker" }, {
      command: "ack",
      optionNames: ["ids"],
    })).toEqual({ acknowledged: 1, agent: "worker" });
  });

  it("keeps the MCP implementation version independent from the package release", () => {
    const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
    expect(MCP_IMPLEMENTATION_VERSION).toBe("2.0.0");
    expect(MCP_IMPLEMENTATION_VERSION).not.toBe(packageVersion);
  });
});

describe("generated contract artifacts", () => {
  it("keeps generated bytes and drift checks independent of host line endings", () => {
    const generated = formatContractArtifact({ contract: "v2" });
    expect(generated).toBe('{\n  "contract": "v2"\n}\n');
    expect(normalizeContractArtifact(generated.replaceAll("\n", "\r\n"))).toBe(generated);
    expect(normalizeContractArtifact('{"contract":"v3"}\r\n')).not.toBe(generated);

    const attributes = readFileSync(resolve(root, ".gitattributes"), "utf8");
    expect(attributes).toContain("schemas/*.json text eol=lf");
    expect(attributes).toContain("openapi/*.json text eol=lf");
  });

  it("uses local references and complete OpenAPI operation metadata", () => {
    const schema = JSON.parse(readFileSync(resolve(root, "schemas/agent-bridge-v2.schema.json"), "utf8"));
    const mcp = JSON.parse(readFileSync(resolve(root, "schemas/agent-bridge-v2.mcp.json"), "utf8"));
    const openapi = JSON.parse(readFileSync(resolve(root, "openapi/agent-bridge-v2.openapi.json"), "utf8"));
    const serialized = JSON.stringify({ schema, openapi });
    const refs = [...serialized.matchAll(/"\$ref":"([^"]+)"/g)].map((match) => match[1]);
    expect(refs.every((ref) => ref.startsWith("#/"))).toBe(true);
    expect(openapi.openapi).toBe("3.1.2");
    expect(schema.scopeEnforcementByProvider).toEqual({
      local: false,
      gateway: true,
      "legacy-supabase": false,
    });
    expect(mcp.scopeEnforcementByProvider).toEqual(schema.scopeEnforcementByProvider);
    expect(schema).not.toHaveProperty("scopeEnforcement");
    expect(mcp).not.toHaveProperty("scopeEnforcement");
    expect(openapi["x-agent-bridge-scope-enforcement"]).toBe(true);
    expect(openapi["x-agent-bridge-openapi-protocol-version"]).toBe("2.1");
    expect(openapi["x-agent-bridge-schemas-2.0"].Message.properties).not.toHaveProperty("deliveryPolicy");
    expect(openapi.paths["/v2/messages"].post.parameters).toContainEqual(expect.objectContaining({ name: "x-agent-bridge-protocol-version", required: true, schema: { type: "string", enum: ["2.1"] } }));
    expect(openapi.paths["/v2/messages"].post.responses["201"]).toBeTruthy();
    expect(openapi.paths["/v2/messages"].post.security).toEqual([{ bearerAuth: [] }]);
    expect(openapi.paths["/v2/capabilities"].get["x-agent-bridge-required-scopes"]).toEqual([]);
    expect(openapi.paths["/v2/deliveries/{deliveryId}/ack"].post.parameters).toContainEqual(expect.objectContaining({ name: "deliveryId", in: "path", required: true }));
    expect(openapi.paths["/v2/deliveries/{deliveryId}/ack"].post.requestBody.content["application/json"].schema.properties).not.toHaveProperty("deliveryId");
    expect(openapi.paths["/v2/deliveries/{deliveryId}/cancel"].post).not.toHaveProperty("requestBody");
    expect(openapi.paths["/v2/deliveries/{deliveryId}/requeue"].post).not.toHaveProperty("requestBody");
    expect(openapi.paths["/v2/deliveries/claim"].post.requestBody.required).toBe(false);
    expect(openapi.paths["/v2/presence/heartbeat"].post.requestBody.required).toBe(false);
    expect(openapi.paths["/v2/messages"].post.requestBody.required).toBe(true);
    expect(openapi.paths["/v2/messages"].post.responses["502"]).toBeTruthy();
    expect(schema.$defs.client_statusCliResponse).toBeTruthy();
    expect(schema.$defs.record_receiptCliResponse.properties).toHaveProperty("acknowledged");
    expect(schema.$defs.historyCliVariantGetResponse.type).toBe("array");
    expect(schema.$defs.record_receiptCliVariantAckResponse.properties).toHaveProperty("acknowledged");
    expect(schema.$defs.publish_messageRequest.properties.id.pattern).toContain("-7");
    expect(openapi.paths["/v2/history"].get.parameters).toContainEqual(expect.objectContaining({ name: "type", in: "query", explode: true }));
    expect(openapi.paths["/v2/history"].get.parameters).toContainEqual(expect.objectContaining({ name: "unacked_by", deprecated: true }));
    expect(openapi.paths["/v2/deliveries"].get.parameters).toContainEqual(expect.objectContaining({ name: "state", explode: true }));
  });

  it("includes every published contract artifact in the npm tarball", () => {
    const args = ["pack", "--json", "--dry-run", "--ignore-scripts"];
    const command = process.env.npm_execpath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
    const packed = JSON.parse(execFileSync(command, process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args, {
      cwd: root, encoding: "utf8", timeout: 20_000,
    }));
    const files = new Set(packed[0].files.map((entry: { path: string }) => entry.path));
    for (const path of [
      "schemas/agent-bridge-v2.schema.json",
      "schemas/agent-bridge-v2.mcp.json",
      "schemas/agent-bridge-v2.capabilities.json",
      "openapi/agent-bridge-v2.openapi.json",
    ]) expect(files.has(path)).toBe(true);
  }, 30_000);
});

describe("MCP contract surfaces", () => {
  it("advertises exactly the provider operations plus frozen compatibility tools", async () => {
    const server = createAgentBridgeServer({ provider: "local", databasePath: ":memory:", agent: "worker" });
    const client = new Client({ name: "contract-test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const names = (await client.listTools()).tools.map((entry) => entry.name);
      expect(names).toEqual([
        "post_context", "get_context", "ack_context",
        ...availableOperations({ surface: "mcp", provider: "local" }).map((entry) => entry.mcp!.name),
      ]);
      await expect(client.callTool({ name: "capabilities", arguments: { surprise: true } })).rejects.toThrow();
      await expect(client.callTool({ name: "send", arguments: { type: "note", content: "ok", surprise: true } })).rejects.toThrow();
    } finally { await client.close(); await server.close(); }
  });
});

describe("legacy MCP compatibility fixtures", () => {
  it("keeps exact post_context, get_context, and ack_context schemas frozen", async () => {
    const fixtures = JSON.parse(readFileSync(new URL("./fixtures/legacy-contracts.json", import.meta.url), "utf8"));
    const server = createAgentBridgeServer({ supabaseUrl: "https://bridge.example.test", supabaseKey: "key", agent: "worker" });
    const client = new Client({ name: "contract-test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = (await client.listTools()).tools;
      for (const name of ["post_context", "get_context", "ack_context"] as const) {
        const tool = tools.find((entry) => entry.name === name)!;
        expect(tool.inputSchema).toEqual(fixtures[name].inputSchema);
        expect(tool.outputSchema ?? null).toEqual(fixtures[name].outputSchema);
      }
    } finally { await client.close(); await server.close(); }
  });
});
