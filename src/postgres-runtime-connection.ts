import type { PoolConfig } from "pg";

const MAX_CA_PEM_BYTES = 256 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/u;
const CLIENT_CERTIFICATE_PARAMETERS = [
  "sslcert",
  "sslkey",
  "sslpassword",
] as const;

function decodeCaPem(encoded: string): string {
  const value = encoded.trim();
  if (!value) throw new Error("AGENT_BRIDGE_RUNTIME_DATABASE_CA_BASE64 cannot be empty");
  if (!BASE64_PATTERN.test(value)) {
    throw new Error("AGENT_BRIDGE_RUNTIME_DATABASE_CA_BASE64 must be canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error("AGENT_BRIDGE_RUNTIME_DATABASE_CA_BASE64 must be canonical base64");
  }
  if (bytes.byteLength > MAX_CA_PEM_BYTES) {
    throw new Error("AGENT_BRIDGE_RUNTIME_DATABASE_CA_BASE64 exceeds 256 KiB after decoding");
  }
  const pem = bytes.toString("utf8").trim();
  if (pem.includes("\0") || !CERTIFICATE_PATTERN.test(pem)) {
    throw new Error("AGENT_BRIDGE_RUNTIME_DATABASE_CA_BASE64 must decode to a PEM certificate bundle");
  }
  return pem;
}

export function runtimePostgresConnectionConfig(
  connectionString: string,
  caBase64: string | undefined,
): Pick<PoolConfig, "connectionString" | "ssl"> {
  if (caBase64 === undefined) return { connectionString };

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("AGENT_BRIDGE_RUNTIME_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("AGENT_BRIDGE_RUNTIME_DATABASE_URL must use postgresql:// or postgres://");
  }

  if (CLIENT_CERTIFICATE_PARAMETERS.some((parameter) => parsed.searchParams.has(parameter))) {
    throw new Error(
      "AGENT_BRIDGE_RUNTIME_DATABASE_CA_BASE64 cannot be combined with client certificate URL parameters",
    );
  }
  if (parsed.searchParams.has("ssl")) {
    throw new Error(
      "AGENT_BRIDGE_RUNTIME_DATABASE_CA_BASE64 cannot be combined with the ssl URL parameter",
    );
  }
  parsed.searchParams.delete("sslmode");
  parsed.searchParams.delete("sslrootcert");
  return {
    connectionString: parsed.toString(),
    ssl: {
      ca: decodeCaPem(caBase64),
      rejectUnauthorized: true,
    },
  };
}
