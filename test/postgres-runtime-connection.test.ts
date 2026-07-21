import { describe, expect, it } from "vitest";
import pg from "pg";
import { runtimePostgresConnectionConfig } from "../src/postgres-runtime-connection.js";

const CA_PEM = `-----BEGIN CERTIFICATE-----
Y2VydGlmaWNhdGU=
-----END CERTIFICATE-----`;

describe("runtime PostgreSQL connection config", () => {
  it("preserves the URL when no separate CA secret is configured", () => {
    const connectionString = "postgresql://gateway@db.example/bridge?sslmode=verify-full";

    expect(runtimePostgresConnectionConfig(connectionString, undefined)).toEqual({ connectionString });
  });

  it("uses the decoded CA and removes file-based TLS parameters", () => {
    const connectionString = "postgresql://gateway@db.example/bridge" +
      "?application_name=bridge&sslmode=verify-full&sslrootcert=%2Fmissing%2Fca.crt";

    const config = runtimePostgresConnectionConfig(
      connectionString,
      Buffer.from(CA_PEM).toString("base64"),
    );
    const parsed = new URL(config.connectionString!);

    expect(parsed.searchParams.get("application_name")).toBe("bridge");
    expect(parsed.searchParams.has("sslmode")).toBe(false);
    expect(parsed.searchParams.has("sslrootcert")).toBe(false);
    expect(config.ssl).toEqual({ ca: CA_PEM, rejectUnauthorized: true });

    const client = new pg.Client(config);
    expect(client.connectionParameters.ssl).toEqual({
      ca: CA_PEM,
      rejectUnauthorized: true,
    });
  });

  it("rejects client certificate file parameters with the CA secret", () => {
    expect(() => runtimePostgresConnectionConfig(
      "postgresql://gateway@db.example/bridge?sslcert=%2Fclient.crt",
      Buffer.from(CA_PEM).toString("base64"),
    )).toThrow(/cannot be combined with client certificate URL parameters/u);
  });

  it.each(["0", "true", "no-verify"])(
    "rejects an ssl=%s URL override with the CA secret",
    (ssl) => {
      expect(() => runtimePostgresConnectionConfig(
        `postgresql://gateway@db.example/bridge?ssl=${ssl}`,
        Buffer.from(CA_PEM).toString("base64"),
      )).toThrow(/cannot be combined with the ssl URL parameter/u);
    },
  );

  it.each([
    ["", /cannot be empty/u],
    ["not base64", /canonical base64/u],
    [Buffer.from("not a certificate").toString("base64"), /PEM certificate bundle/u],
  ])("rejects an invalid CA secret", (encoded, expected) => {
    expect(() => runtimePostgresConnectionConfig(
      "postgresql://gateway@db.example/bridge",
      encoded,
    )).toThrow(expected);
  });

  it("rejects an oversized decoded CA bundle", () => {
    const oversized = `-----BEGIN CERTIFICATE-----\n${"A".repeat(256 * 1024)}\n-----END CERTIFICATE-----`;

    expect(() => runtimePostgresConnectionConfig(
      "postgresql://gateway@db.example/bridge",
      Buffer.from(oversized).toString("base64"),
    )).toThrow(/exceeds 256 KiB/u);
  });
});
