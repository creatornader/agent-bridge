import { createHash, timingSafeEqual } from "node:crypto";
import type { BridgePrincipal } from "./bridge-domain.js";
import type { AuthorizationScope } from "./contracts/registry.js";
import type { PgQueryable } from "./postgres-bridge-store.js";

export interface AuthenticatedCredential {
  id: string;
  principal: BridgePrincipal;
  /** Canonical authorization scopes granted to this credential. */
  scopes: readonly AuthorizationScope[];
}

export interface CredentialResolver {
  resolve(token: string, signal?: AbortSignal): Promise<AuthenticatedCredential | null>;
}

export function hashCredential(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class PostgresCredentialResolver implements CredentialResolver {
  constructor(private readonly db: PgQueryable) {}

  async resolve(token: string, signal?: AbortSignal): Promise<AuthenticatedCredential | null> {
    if (signal?.aborted) throw signal.reason;
    const hash = hashCredential(token);
    const result = await this.db.query<{
      id: string; workspace_id: string; principal: string; scopes: AuthorizationScope[];
    }>(
      `SELECT credential.id, credential.workspace_id, agent.principal, credential.scopes
       FROM agent_bridge.credentials credential
       JOIN agent_bridge.agents agent
         ON agent.id=credential.agent_id AND agent.workspace_id=credential.workspace_id
       JOIN agent_bridge.workspaces workspace ON workspace.id=credential.workspace_id
       WHERE credential.token_hash=$1 AND credential.revoked_at IS NULL
         AND (credential.expires_at IS NULL OR credential.expires_at>now())
         AND (
           NOT EXISTS (
             SELECT 1 FROM agent_bridge.credentials successor
             WHERE successor.replaces_credential_id=credential.id
           )
           OR credential.expiry_grace_until>now()
         )
         AND agent.disabled_at IS NULL AND workspace.disabled_at IS NULL
       LIMIT 1`,
      [hash],
    );
    const row = result.rows[0];
    if (signal?.aborted) throw signal.reason;
    return row ? {
      id: row.id,
      principal: { workspace: row.workspace_id, agent: row.principal },
      scopes: row.scopes,
    } : null;
  }
}

export function bearerToken(value: string | undefined): string | null {
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice(7);
  if (!token || token.length > 4096 || /\s/.test(token)) return null;
  return token;
}

export function safeTokenHashEqual(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashCredential(token));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
