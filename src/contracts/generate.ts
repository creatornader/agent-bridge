import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatContractArtifact, normalizeContractArtifact } from "./artifact-format.js";
import {
  capabilityDocument,
  ErrorEnvelopeSchema,
  LegacyDeliverySchema,
  LegacyMessageDraftSchema,
  LegacyMessageSchema,
  LEGACY_PROTOCOL_VERSION,
  operations,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  SCOPE_ENFORCEMENT,
  SUPPORTED_PROTOCOL_HEADER,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./registry.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function objectWithout(schema: Record<string, any>, excluded: ReadonlySet<string>): Record<string, any> {
  const result = clone(schema);
  if (!result.properties) return result;
  result.properties = Object.fromEntries(Object.entries(result.properties).filter(([name]) => !excluded.has(name)));
  if (Array.isArray(result.required)) {
    result.required = result.required.filter((name: string) => !excluded.has(name));
    if (!result.required.length) delete result.required;
  }
  return result;
}

const scopeEnforcementByProvider = {
  local: false,
  gateway: SCOPE_ENFORCEMENT,
};

const schemas = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agent-bridge.dev/schemas/v2/operations.json",
  title: "Agent Bridge v2 operation contracts",
  protocolVersion: PROTOCOL_VERSION,
  scopeEnforcementByProvider,
  $defs: {
    ErrorEnvelope: ErrorEnvelopeSchema,
    legacy20MessageDraft: LegacyMessageDraftSchema,
    legacy20Message: LegacyMessageSchema,
    legacy20Delivery: LegacyDeliverySchema,
    ...Object.fromEntries(operations.flatMap((operation) => [
      [`${operation.id}Request`, operation.request],
      [`${operation.id}Response`, operation.response],
      ...(operation.cli ? [[`${operation.id}CliResponse`, operation.cli.response ?? operation.response] as const] : []),
      ...(operation.cli?.variants?.map((variant) => [
        `${operation.id}CliVariant${variant.command.replace(/(^|[-_])(\w)/g, (_match, _separator, character: string) => character.toUpperCase())}Response`,
        variant.response,
      ] as const) ?? []),
    ])),
  },
};

const protocolHeaders = {
  [PROTOCOL_HEADER]: {
    description: "Selected Agent Bridge protocol version.",
    required: true,
    schema: { type: "string", enum: [...SUPPORTED_PROTOCOL_VERSIONS] },
  },
  [SUPPORTED_PROTOCOL_HEADER]: {
    description: "Comma-separated protocol versions supported by this gateway.",
    required: true,
    schema: { type: "string" },
  },
};

function errorResponse(description: string) {
  return {
    description,
    headers: protocolHeaders,
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
  };
}

const canonicalErrors = {
  "400": errorResponse("The request does not match the operation contract."),
  "401": errorResponse("The bearer credential is missing or invalid."),
  "403": errorResponse("The credential cannot access the requested principal or origin."),
  "404": errorResponse("The route or requested resource does not exist."),
  "409": errorResponse("The request conflicts with current delivery or idempotency state."),
  "413": errorResponse("The request body exceeds the configured limit."),
  "415": errorResponse("The request content type is not application/json."),
  "426": errorResponse("The requested protocol version is unsupported."),
  "429": errorResponse("The gateway has rate-limited the request."),
  "500": errorResponse("The gateway could not complete the request."),
  "502": errorResponse("The upstream response does not match the selected protocol contract."),
  "503": errorResponse("The backing service is unavailable."),
  "504": errorResponse("The request exceeded the gateway deadline."),
};

const paths: Record<string, Record<string, unknown>> = {};
for (const operation of operations.filter((entry) => entry.http)) {
  const http = operation.http!;
  const pathItem = paths[http.path] ??= {};
  const pathNames = [...http.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  const pathSet = new Set(pathNames);
  const request = clone(operation.request as Record<string, any>);
  const parameters: Array<Record<string, unknown>> = [{
    name: PROTOCOL_HEADER,
    in: "header",
    required: true,
    description: "This OpenAPI operation describes protocol 2.1. Headerless protocol 2.0 uses the separate schemas named by x-agent-bridge-protocol-2.0.",
    schema: { type: "string", enum: [PROTOCOL_VERSION] },
  }, ...pathNames.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: request.properties?.[name] ?? { type: "string" },
  }))];

  if (http.method === "GET" && request.properties) {
    for (const [propertyName, propertySchema] of Object.entries(request.properties) as Array<[string, Record<string, any>]>) {
      if (pathSet.has(propertyName)) continue;
      const queryName = propertyName === "types" ? "type" : propertyName === "states" ? "state" : propertyName;
      const repeated = propertySchema.type === "array";
      parameters.push({
        name: queryName,
        in: "query",
        required: request.required?.includes(propertyName) ?? false,
        ...(repeated ? { style: "form", explode: true } : {}),
        schema: propertySchema,
      });
      for (const alias of http.queryAliases?.[propertyName] ?? []) {
        parameters.push({
          name: alias,
          in: "query",
          required: false,
          deprecated: true,
          description: `Compatibility alias for ${queryName}.`,
          schema: propertySchema,
        });
      }
    }
  }

  const contentType = http.responseContentType ?? "application/json";
  const successStatus = String(http.successStatus ?? 200);
  const successResponse = {
    description: "Successful response.",
    headers: protocolHeaders,
    content: { [contentType]: { schema: clone(operation.response) } },
  };
  const bodySchema = objectWithout(request, pathSet);
  const hasBodyFields = Object.keys(bodySchema.properties ?? {}).length > 0;
  const hasRequiredBodyFields = Array.isArray(bodySchema.required) && bodySchema.required.length > 0;
  pathItem[http.method.toLowerCase()] = {
    operationId: operation.id,
    summary: operation.summary,
    security: [{ bearerAuth: [] }],
    "x-agent-bridge-required-scopes": [...operation.scopes],
    "x-agent-bridge-scope-enforcement": SCOPE_ENFORCEMENT,
    ...(parameters.length ? { parameters } : {}),
    ...(http.method === "POST" && hasBodyFields ? {
      requestBody: {
        required: hasRequiredBodyFields,
        content: { "application/json": { schema: bodySchema } },
      },
    } : {}),
    responses: { [successStatus]: successResponse, ...canonicalErrors },
  };
}

const openapi = {
  openapi: "3.1.2",
  info: {
    title: "Agent Bridge Gateway",
    description: "Let AI agents message each other and hand off work across tools, sessions, and machines.",
    version: PROTOCOL_VERSION,
    license: { name: "Apache-2.0", identifier: "Apache-2.0" },
  },
  servers: [{ url: "/" }],
  "x-agent-bridge-protocol-versions": [...SUPPORTED_PROTOCOL_VERSIONS],
  "x-agent-bridge-openapi-protocol-version": PROTOCOL_VERSION,
  "x-agent-bridge-protocol-2.0": {
    description: "Limited schema metadata for the released headerless 0.2.0 compatibility contract derived from d8184fe. This is not a complete OpenAPI route description. It does not support project, deliveryPolicy, delivery management/listing, or current delivery bookkeeping fields.",
    requestSchemas: { publish_message: "#/x-agent-bridge-schemas-2.0/MessageDraft" },
    responseSchemas: { message: "#/x-agent-bridge-schemas-2.0/Message", delivery: "#/x-agent-bridge-schemas-2.0/Delivery" },
  },
  "x-agent-bridge-schemas-2.0": {
    MessageDraft: LegacyMessageDraftSchema,
    Message: LegacyMessageSchema,
    Delivery: LegacyDeliverySchema,
  },
  "x-agent-bridge-scope-enforcement": SCOPE_ENFORCEMENT,
  paths,
  components: {
    schemas: { ErrorEnvelope: ErrorEnvelopeSchema },
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  },
};

const mcp = {
  schemaVersion: "agent-bridge-mcp-manifest-v1",
  protocolVersion: PROTOCOL_VERSION,
  scopeEnforcementByProvider,
  tools: operations.filter((entry) => entry.mcp).map((entry) => ({
    name: entry.mcp!.name,
    description: entry.summary,
    inputSchema: entry.request,
    outputSchema: entry.response,
    requiredScopes: entry.scopes,
    providers: entry.providers,
  })),
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outputs = new Map([
  [resolve(root, "schemas/agent-bridge-v2.schema.json"), formatContractArtifact(schemas)],
  [resolve(root, "openapi/agent-bridge-v2.openapi.json"), formatContractArtifact(openapi)],
  [resolve(root, "schemas/agent-bridge-v2.mcp.json"), formatContractArtifact(mcp)],
  [resolve(root, "schemas/agent-bridge-v2.capabilities.json"), formatContractArtifact(capabilityDocument())],
]);
const check = process.argv.includes("--check");
const drift: string[] = [];
for (const [path, contents] of outputs) {
  if (check) {
    let current = "";
    try { current = readFileSync(path, "utf8"); } catch {}
    if (normalizeContractArtifact(current) !== normalizeContractArtifact(contents)) {
      drift.push(path.slice(root.length + 1));
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}
if (drift.length) {
  for (const path of drift) process.stderr.write(`ERROR contract artifact drift: ${path}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`contracts ${check ? "match" : "generated"}: ${outputs.size} artifacts, ${operations.length} operations\n`);
}
