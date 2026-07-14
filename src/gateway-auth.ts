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
    const result = await this.db.query<{
      credential_id: string; workspace_id: string; principal: string; scopes: AuthorizationScope[];
    }>(
      `SELECT credential_id,workspace_id,principal,scopes
       FROM agent_bridge.resolve_credential_hash($1::text)`,
      [hashCredential(token)],
    );
    const row = result.rows[0];
    if (signal?.aborted) throw signal.reason;
    return row ? {
      id: row.credential_id,
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
