import type pg from "pg";
import type { BridgePrincipal } from "./bridge-domain.js";
import type { AuthorizationScope } from "./contracts/registry.js";
import { PostgresBridgeStore, type PgQueryable } from "./postgres-bridge-store.js";
import { PostgresGatewaySecurity } from "./gateway-security.js";

export interface RequestAuthorityContext {
  credential: { id: string; principal: BridgePrincipal; scopes: readonly AuthorizationScope[] };
  store: PostgresBridgeStore;
  security: PostgresGatewaySecurity;
  /** Establishes the savepoint separating durable security accounting from domain work. */
  beginDomainWork(): Promise<void>;
}

export interface RequestAuthority {
  run<T>(credentialId: string, credentialHash: string, requestId: string, signal: AbortSignal, work: (context: RequestAuthorityContext) => Promise<T>): Promise<T>;
}

type AuthorityRow = {
  credential_id: string;
  workspace_id: string;
  principal: string;
  scopes: AuthorizationScope[];
};

export class MutationOutcomeUnknownError extends Error {
  readonly status = 503;
  readonly code = "mutation_outcome_unknown";
  constructor() { super("The database commit outcome is unknown"); }
}

export class PostgresRequestAuthority implements RequestAuthority {
  constructor(private readonly pool: Pick<pg.Pool, "connect">) {}

  async run<T>(credentialId: string, credentialHash: string, requestId: string, signal: AbortSignal, work: (context: RequestAuthorityContext) => Promise<T>): Promise<T> {
    if (signal.aborted) throw signal.reason;
    const client = await this.pool.connect();
    const db: PgQueryable = { inTransaction: true, query: (sql, values) => client.query(sql, values) };
    let transactionOpen = false;
    let domainSavepoint = false;
    let commitDispatched = false;
    let commitCompleted = false;
    let discard: Error | undefined;
    try {
      if (signal.aborted) throw signal.reason;
      await client.query("BEGIN");
      transactionOpen = true;
      const opened = await client.query<AuthorityRow>(
        `SELECT credential_id,workspace_id,principal,scopes
         FROM agent_bridge.open_request_authority($1::uuid,$2::text,$3::uuid)`,
        [credentialId, credentialHash, requestId],
      );
      const row = opened.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        throw Object.assign(new Error("Credential is not active"), { status: 401, code: "unauthorized" });
      }
      if (signal.aborted) throw signal.reason;
      const context: RequestAuthorityContext = {
        credential: { id: row.credential_id, principal: { workspace: row.workspace_id, agent: row.principal }, scopes: row.scopes },
        store: new PostgresBridgeStore(db),
        security: new PostgresGatewaySecurity(db),
        beginDomainWork: async () => {
          if (domainSavepoint) return;
          if (signal.aborted) throw signal.reason;
          await client.query("SAVEPOINT agent_bridge_domain_work");
          if (signal.aborted) throw signal.reason;
          domainSavepoint = true;
        },
      };
      try {
        const result = await work(context);
        if (signal.aborted) throw signal.reason;
        await client.query("SELECT agent_bridge.close_request_authority()");
        if (signal.aborted) throw signal.reason;
        commitDispatched = true;
        await client.query("COMMIT");
        commitCompleted = true;
        transactionOpen = false;
        return result;
      } catch (error) {
        if (commitDispatched) throw new MutationOutcomeUnknownError();
        if (signal.aborted) throw error;
        try {
          if (domainSavepoint) {
            await client.query("ROLLBACK TO SAVEPOINT agent_bridge_domain_work");
          }
          await client.query("SELECT agent_bridge.close_request_authority()");
        } catch {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
          }
          transactionOpen = false;
          throw error;
        }
        if (signal.aborted) throw signal.reason;
        commitDispatched = true;
        await client.query("COMMIT");
        commitCompleted = true;
        transactionOpen = false;
        throw error;
      }
    } catch (error) {
      if (commitDispatched && !commitCompleted) {
        discard = error instanceof Error ? error : new Error(String(error));
        throw error instanceof MutationOutcomeUnknownError ? error : new MutationOutcomeUnknownError();
      }
      if (transactionOpen) {
        try { await client.query("ROLLBACK"); transactionOpen = false; }
        catch (rollbackError) { discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)); }
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

}
