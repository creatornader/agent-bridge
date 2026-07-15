import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEnrollmentPath, readEnrollment } from "../src/enrollment-file.js";
import { runOwnerCommand, type OwnerDependencies } from "../src/owner-control.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function dependencies(
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>,
): OwnerDependencies {
  return {
    connect: (url) => {
      expect(url).toBe("postgresql://operator.test/bridge");
      return { db: { query } as any, close: async () => {} };
    },
    now: () => new Date("2026-07-14T12:00:00.000Z"),
    requestId: () => "11111111-1111-4111-8111-111111111111",
    token: () => "owner-generated-secret",
    instance: () => "codex-fixed-instance",
  };
}

describe("owner control CLI service", () => {
  it("creates the enrollment before provision and never returns its secret", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-owner-"));
    homes.push(home);
    let observedValues: unknown[] = [];
    const result = await runOwnerCommand("provision", {
      workspace: "team",
      "workspace-name": "Team",
      identity: "codex",
      runtime: "codex",
      "gateway-url": "https://bridge.example.test",
      "scope-set": "release-a-full",
    }, {
      HOME: home,
      AGENT_BRIDGE_OPERATOR_DATABASE_URL: "postgresql://operator.test/bridge",
    }, dependencies(async (_sql, values) => {
      observedValues = values ?? [];
      return { rows: [{
        workspace_id: "team",
        agent_id: "22222222-2222-4222-8222-222222222222",
        credential_id: "33333333-3333-4333-8333-333333333333",
        replayed: false,
      }] };
    }));
    expect(JSON.stringify(result)).not.toContain("owner-generated-secret");
    expect(JSON.stringify(result)).not.toContain(
      createHash("sha256").update("owner-generated-secret").digest("hex"),
    );
    expect(observedValues).toContain(
      createHash("sha256").update("owner-generated-secret").digest("hex"),
    );
    const file = readEnrollment(String(result.enrollmentFile), { HOME: home });
    expect(file.state).toBe("ready");
    expect(file.input.instance).toBe("codex-fixed-instance");
  });

  it("leaves a pending file on database failure and resumes its exact request", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-owner-"));
    homes.push(home);
    const env = {
      HOME: home,
      AGENT_BRIDGE_OPERATOR_DATABASE_URL: "postgresql://operator.test/bridge",
    };
    const options = {
      workspace: "team",
      "workspace-name": "Team",
      identity: "codex",
      runtime: "codex",
      "gateway-url": "https://bridge.example.test",
      "scope-set": "release-a-full",
    };
    const failed = runOwnerCommand("provision", options, env, dependencies(async () => {
      const error = Object.assign(new Error("secret database detail"), { detail: "token hash" });
      throw error;
    }));
    await expect(failed).rejects.toThrow("owner database operation failed");
    await failed.catch((error) => {
      const message = String(error);
      expect(message).not.toContain("secret database detail");
      expect(message).not.toContain("postgresql://operator.test/bridge");
      expect(message).not.toContain("control_provision");
      expect(message).not.toContain("owner-generated-secret");
    });
    const path = defaultEnrollmentPath("11111111-1111-4111-8111-111111111111", env);
    const pending = readEnrollment(path, env);
    expect(pending.state).toBe("pending");
    await expect(runOwnerCommand("provision", options, env, dependencies(
      async () => ({ rows: [] }),
    ))).rejects.toThrow(/EEXIST|already exists/);
    if (process.platform !== "win32") {
      chmodSync(path, 0o644);
      await expect(runOwnerCommand("provision", { resume: path }, env, dependencies(
        async () => ({ rows: [] }),
      ))).rejects.toThrow(/permissions are not owner-only/);
      chmodSync(path, 0o600);
    }
    const resumed = await runOwnerCommand("provision", { resume: path }, env, dependencies(
      async (_sql, values) => {
        expect(values?.[0]).toBe(pending.requestId);
        expect(values?.[6]).toBe(createHash("sha256").update(pending.token!).digest("hex"));
        return { rows: [{
          workspace_id: "team",
          agent_id: "22222222-2222-4222-8222-222222222222",
          credential_id: "33333333-3333-4333-8333-333333333333",
          replayed: true,
        }] };
      },
    ));
    expect(resumed).toMatchObject({ schemaVersion: 1, replayed: true, enrollmentState: "ready" });
    await expect(runOwnerCommand("provision", {
      resume: path,
      workspace: "different",
    }, env, dependencies(async () => ({ rows: [] })))).rejects.toThrow(/cannot be used with --resume/);
  });

  it("keeps inventory bounded and binds opaque cursors to a workspace", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-owner-"));
    homes.push(home);
    const env = {
      HOME: home,
      AGENT_BRIDGE_OPERATOR_DATABASE_URL: "postgresql://operator.test/bridge",
    };
    const db = dependencies(async () => ({ rows: [{
      credential_id: randomUUID(),
      workspace_id: "team",
      principal: "codex",
      scopes: ["messages:read"],
      created_at: new Date("2026-07-14T12:00:00.000Z"),
    }] }));
    const first = await runOwnerCommand("inventory", { workspace: "team", limit: "1" }, env, db);
    expect(first).toMatchObject({
      schemaVersion: 1,
      items: [expect.objectContaining({ workspaceId: "team", principal: "codex" })],
      page: { limit: 1, nextCursor: expect.any(String) },
    });
    const cursor = (first.page as { nextCursor: string }).nextCursor;
    await expect(runOwnerCommand("inventory", {
      workspace: "other",
      cursor,
    }, env, db)).rejects.toThrow("--cursor does not match this inventory request");
    await expect(runOwnerCommand("inventory", { limit: "1001" }, env, db))
      .rejects.toThrow("--limit must be an integer between 1 and 1000");
    const impossibleCursor = Buffer.from(JSON.stringify({
      v: 1,
      workspace: "team",
      createdAt: "2026-02-30T12:00:00Z",
      credentialId: randomUUID(),
    })).toString("base64url");
    await expect(runOwnerCommand("inventory", {
      workspace: "team",
      cursor: impossibleCursor,
    }, env, db)).rejects.toThrow("--cursor is not a valid owner inventory cursor");
    const invalidCredentialCursor = Buffer.from(JSON.stringify({
      v: 1,
      workspace: "team",
      createdAt: "2026-07-14T12:00:00.000Z",
      credentialId: "not-a-uuid",
    })).toString("base64url");
    await expect(runOwnerCommand("inventory", {
      workspace: "team",
      cursor: invalidCredentialCursor,
    }, env, db)).rejects.toThrow("--cursor is not a valid owner inventory cursor");
  });

  it("binds rotation to workspace and principal in one database call", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-bridge-owner-"));
    homes.push(home);
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const result = await runOwnerCommand("rotate", {
      workspace: "team",
      identity: "codex",
      runtime: "codex",
      instance: "codex-fixed-instance",
      "gateway-url": "https://bridge.example.test",
      "scope-set": "release-a-full",
      "credential-id": "22222222-2222-4222-8222-222222222222",
      "invalidate-immediately": true,
    }, {
      HOME: home,
      AGENT_BRIDGE_OPERATOR_DATABASE_URL: "postgresql://operator.test/bridge",
    }, dependencies(async (sql, values) => {
      calls.push({ sql, values: values ?? [] });
      return { rows: [{
        credential_id: "33333333-3333-4333-8333-333333333333",
        workspace_id: "team",
        principal: "codex",
        replayed: false,
      }] };
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("control_rotate_credential");
    expect(calls[0]!.values.slice(1, 5)).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "team",
      "codex",
      createHash("sha256").update("owner-generated-secret").digest("hex"),
    ]);
    expect(result).toMatchObject({
      workspaceId: "team",
      principal: "codex",
      credentialId: "33333333-3333-4333-8333-333333333333",
      replayed: false,
    });
  });

  it("sanitizes a synchronous database connection failure", async () => {
    const databaseUrl = new URL("postgresql://database.test/bridge");
    databaseUrl.username = "operator";
    databaseUrl.password = "secret";
    const secretUrl = databaseUrl.toString();
    const broken = dependencies(async () => ({ rows: [] }));
    broken.connect = () => {
      throw new Error("cannot parse " + secretUrl);
    };
    const failed = runOwnerCommand("inventory", {}, {
      AGENT_BRIDGE_OPERATOR_DATABASE_URL: secretUrl,
    }, broken);
    await expect(failed).rejects.toThrow("owner database connection failed");
    await failed.catch((error) => expect(String(error)).not.toContain(secretUrl));
  });
});
