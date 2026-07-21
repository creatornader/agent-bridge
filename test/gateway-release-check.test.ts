import { describe, expect, it } from "vitest";
import { checkGatewayRelease, normalizeExpectedRelease } from "../scripts/gateway-release-check.mjs";

const revision = "a".repeat(40);

function response(body: Record<string, unknown>, protocol = "2.1") {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-agent-bridge-protocol-version": protocol,
    },
  });
}

describe("gateway release check", () => {
  it("accepts the exact deployed package and source revision", async () => {
    const result = await checkGatewayRelease({
      gatewayOrigin: "https://gateway.example.com",
      token: "secret-token",
      expectedVersion: "0.6.1",
      expectedRevision: revision,
      fetchImpl: async (url: URL, init: RequestInit) => {
        expect(url.href).toBe("https://gateway.example.com/v2/capabilities");
        expect(init.headers).toMatchObject({ authorization: "Bearer secret-token" });
        return response({
          selectedProtocolVersion: "2.1",
          currentProtocolVersion: "2.1",
          requestAuthority: true,
          rowIsolation: true,
          implementationVersion: "0.6.1",
          implementationRevision: revision,
        });
      },
    });
    expect(result).toEqual({
      gatewayOrigin: "https://gateway.example.com",
      implementationVersion: "0.6.1",
      implementationRevision: revision,
      protocolVersion: "2.1",
      requestAuthority: true,
      rowIsolation: true,
    });
  });

  it("rejects a stale deployment", async () => {
    await expect(checkGatewayRelease({
      gatewayOrigin: "https://gateway.example.com",
      token: "secret-token",
      expectedVersion: "0.6.1",
      expectedRevision: revision,
      fetchImpl: async () => response({
        selectedProtocolVersion: "2.1",
        currentProtocolVersion: "2.1",
        requestAuthority: true,
        rowIsolation: true,
        implementationVersion: "0.6.0",
        implementationRevision: "b".repeat(40),
      }),
    })).rejects.toThrow("gateway version mismatch");
  });

  it("rejects invalid release expectations and non-HTTPS origins", async () => {
    expect(() => normalizeExpectedRelease("next", revision)).toThrow("expected version is invalid");
    await expect(checkGatewayRelease({
      gatewayOrigin: "http://gateway.example.com",
      token: "secret-token",
      expectedVersion: "0.6.1",
      expectedRevision: revision,
      fetchImpl: async () => response({}),
    })).rejects.toThrow("must be an HTTPS origin");
  });
});
