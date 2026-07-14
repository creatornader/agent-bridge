import type { PgQueryable } from "./postgres-bridge-store.js";
import type { OperationId } from "./contracts/registry.js";

export interface RateLimitDecision {
  allowed: boolean;
  policyId: string | null;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export interface GatewaySecurity {
  recordScopeDenial(
    credentialId: string,
    operationId: OperationId,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  consume(
    credentialId: string,
    operationId: OperationId,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<RateLimitDecision>;
}

export class PostgresGatewaySecurity implements GatewaySecurity {
  constructor(private readonly db: PgQueryable) {}

  async recordScopeDenial(
    credentialId: string,
    operationId: OperationId,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    await this.db.query(
      "SELECT agent_bridge.record_scope_denial($1::uuid, $2::text, $3::uuid)",
      [credentialId, operationId, requestId],
    );
    if (signal?.aborted) throw signal.reason;
  }

  async consume(
    credentialId: string,
    operationId: OperationId,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<RateLimitDecision> {
    if (signal?.aborted) throw signal.reason;
    const result = await this.db.query<{
      allowed: boolean;
      limit_value: string | number;
      remaining_value: string | number;
      retry_after_seconds: string | number;
      denied_policy_id: string | null;
    }>(
      `SELECT allowed, limit_value, remaining_value, retry_after_seconds, denied_policy_id
       FROM agent_bridge.consume_rate_limit($1::uuid, $2::text, $3::uuid)`,
      [credentialId, operationId, requestId],
    );
    if (signal?.aborted) throw signal.reason;
    const row = result.rows[0];
    if (!row) throw new Error("rate limit policy is missing");
    return {
      allowed: row.allowed,
      policyId: row.denied_policy_id,
      limit: Math.max(0, Number(row.limit_value)),
      remaining: Math.max(0, Number(row.remaining_value)),
      retryAfterSeconds: Math.max(0, Number(row.retry_after_seconds)),
    };
  }
}
