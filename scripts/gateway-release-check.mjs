import { pathToFileURL } from "node:url";

const COMMIT = /^[0-9a-f]{7,40}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function fail(message) {
  throw new Error(message);
}

function argument(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1 || args[index + 1].startsWith("--")) {
    fail(`${name} is required`);
  }
  return args[index + 1];
}

export function normalizeExpectedRelease(version, revision) {
  if (!VERSION.test(version)) fail("expected version is invalid");
  if (!COMMIT.test(revision)) fail("expected revision is invalid");
  return { version, revision };
}

export async function checkGatewayRelease({
  gatewayOrigin,
  token,
  expectedVersion,
  expectedRevision,
  fetchImpl = fetch,
}) {
  const expected = normalizeExpectedRelease(expectedVersion, expectedRevision);
  const origin = new URL(gatewayOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    fail("AGENT_BRIDGE_URL must be an HTTPS origin without credentials, path, query, or fragment");
  }
  if (typeof token !== "string" || token.length === 0) fail("AGENT_BRIDGE_TOKEN is required");

  const response = await fetchImpl(new URL("/v2/capabilities", origin), {
    headers: {
      authorization: `Bearer ${token}`,
      "x-agent-bridge-protocol-version": "2.1",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail(`gateway capability probe returned HTTP ${response.status}`);
  if (response.headers.get("x-agent-bridge-protocol-version") !== "2.1") {
    fail("gateway did not select protocol 2.1");
  }
  const body = await response.json();
  if (body.selectedProtocolVersion !== "2.1" || body.currentProtocolVersion !== "2.1") {
    fail("gateway capability document does not report protocol 2.1");
  }
  if (body.requestAuthority !== true || body.rowIsolation !== true) {
    fail("gateway request authority or row isolation is not ready");
  }
  if (body.implementationVersion !== expected.version) {
    fail(`gateway version mismatch: expected ${expected.version}, received ${String(body.implementationVersion)}`);
  }
  if (body.implementationRevision !== expected.revision) {
    fail(`gateway revision mismatch: expected ${expected.revision}, received ${String(body.implementationRevision)}`);
  }
  return {
    gatewayOrigin: origin.origin,
    implementationVersion: body.implementationVersion,
    implementationRevision: body.implementationRevision,
    protocolVersion: body.selectedProtocolVersion,
    requestAuthority: true,
    rowIsolation: true,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: gateway-release-check --version <semver> --revision <git-sha>\n");
    return;
  }
  const result = await checkGatewayRelease({
    gatewayOrigin: process.env.AGENT_BRIDGE_URL,
    token: process.env.AGENT_BRIDGE_TOKEN,
    expectedVersion: argument(args, "--version"),
    expectedRevision: argument(args, "--revision"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
