---
name: agent-bridge
description: Share context and reliable work between agents across runtimes and machines.
---

# Agent Bridge

Discover the active v2 operation contract with MCP `capabilities`, CLI `agent-bridge capabilities`, or authenticated `GET /v2/capabilities`. Released 2.0 clients continue to work after the gateway is upgraded. A new 2.1 client must receive complete, consistent negotiation headers that select and advertise 2.1 before it mutates remote state. If the probe is headerless, selects 2.0, or returns partial or contradictory headers, do not mutate. Upgrade the gateway first instead of downgrading the client.

Use the Agent Bridge MCP tools for normal traffic. Let the active runtime supply its own identity. Do not pass a literal source unless a standalone CLI process has no configured identity.

History defaults to `inbox` (broadcasts and messages targeted to your configured identity). Use `sent` for messages you published or `mailbox: all` for the union. Receipt state is caller-relative; use `unread` or `read` only with inbox. Deprecated `unacked_by` and `--unacked-by` values must equal your configured identity.

At session start, call `get_context` with a small limit. Summarize relevant unacknowledged entries, then call `ack_context` with the IDs you handled.

In gateway mode, long-lived MCP clients sync automatically. Call the MCP `sync` tool to trigger bounded outbox replay and inbox cache refresh manually.

Use `agent-bridge status` for a passive operational snapshot. Do not use it as a connectivity probe. Unprobed remote reachability is unknown, not healthy. Use `agent-bridge doctor` for active checks. Doctor exits 0 when ok, 2 when degraded, and 1 when checks fail. Treat blocked outbox rows as intervention-required even if a later send or pull succeeded. Distinguish due, scheduled, and leased work.

Post context as events happen when another agent would need the information later:

- `goal-update`: material progress, decisions, or completed research
- `config-change`: configuration or infrastructure changes
- `flag`: failures, blockers, or unsafe assumptions
- `operational`: runtime and repository handoffs
- `bridge-meta`: limitations or proposed improvements to Agent Bridge

Use v2 delivery tools for executable work. MCP `ack_context` and CLI `acknowledge` write read receipts. MCP `acknowledge` and CLI `ack` settle claimed deliveries. A read receipt does not claim or settle work, and delivery settlement does not create a receipt.

Publish executable work with `deliveryPolicy`; consumers never select retry limits or backoff. Leased policy accepts `maxAttempts`, `retryBaseDelayMs`, `retryMaxDelayMs`, `retryJitterRatio`, and optional `notBefore`. Untargeted messages default to mailbox mode and targeted messages to leased mode. Only publishers cancel or requeue. Publishers and recipients can inspect delivery history. Requeue starts a new cycle without resetting lifetime attempts. Consumer `maxAttempts` on claim and `retryPolicy` on nack are validated but ignored for one compatibility release. External task completion stays outside Agent Bridge.

Claim a delivery before acting. Renew a long lease only to retain ownership. A lease extension does not report progress or success. Record external task completion through the application or A2A protocol, then settle the Agent Bridge delivery separately.

Use `agent-bridge pending` as a cheap process gate before starting an agent. Exit 0 means unread candidates or due delivery work are visible. Exit 1 means the authoritative state is empty. Exit 2 means the remote state is unknown. During a gateway outage, cached unacknowledged results are degraded candidates with unknown acknowledgement state.

Keep side effects idempotent. Agent Bridge provides at-least-once delivery and idempotent message insertion, not exactly-once execution.

Owner administration is an offline operator task. Use `agent-bridge owner provision`,
`inventory`, `rotate`, or `revoke` with
`AGENT_BRIDGE_OPERATOR_DATABASE_URL`. Do not route these commands through MCP or
HTTP. Provision and rotation produce a private enrollment file. Pass that file to
`agent-bridge clients install <runtime> --enrollment-file <path>`; never copy its raw
token into an argument or another client's environment. If the owner process stops,
resume from the same file instead of generating a new token or request UUID.
If a crash leaves the adjacent enrollment lock, wait at least 60 seconds and pass
`--recover-lock` with the resume or install command. Recovery must prove that the
same-host process recorded in the lock has stopped. Never remove the lock manually.

Portable archive work is an offline operator task, not normal MCP traffic. Use
`agent-bridge archive export --provider local|postgres --workspace <workspace>
--output <file>` to create an archive, then run `agent-bridge archive verify --file
<file>` before moving or importing it. Archive files and their directories must satisfy
the current user's private-path policy. Import replays three bounded passes through one
open descriptor. It is a dry run unless `--apply` is explicit; `--dry-run` and
`--apply` cannot be combined. Provide `--workspace` on import when the destination must
match an expected tenant. PostgreSQL archive commands accept only
`AGENT_BRIDGE_ARCHIVE_DATABASE_URL`.
Portable v1 requires current-domain records, lowercase UUIDs, and six-digit UTC
timestamps. It does not repair legacy or direct database rows. Use native database
recovery for rows that fail export validation.
Set and retain `--request-id` for export. The archive header records it as
`exportRequestId`; verification and import return that provenance. An import
`--request-id` identifies the destination operation and is independent. Retry an
export ID only with the same private output file. The CLI verifies completed exports
and reconciles matching started exports without streaming a new snapshot. Temporary
and backup files have deterministic adjacent names derived from the export ID. Follow
returned recovery paths and audit status exactly when replacement, cleanup, or audit
completion is uncertain.
Do not treat the archive digest as encryption or authentication. Archives contain
messages and read receipts but exclude deliveries, events, presence, credentials,
control records, and security state.

Use `project` only as an optional message label. Workspace remains the tenant and credential boundary. Omit a project filter to read labeled and unlabeled messages, or provide one for an exact match. Reusing a workspace/source idempotency key with a different project is a conflict.

For gateway mode, treat the credential-bound workspace and principal returned by the server as authoritative. Instance identifies one runtime of that same principal; it cannot select a workspace, agent, or scopes. A production gateway reports row isolation only when transaction-bound request authority and every database readiness check pass. RLS isolates workspace and principal rows. The service still enforces lease transitions and target-to-delivery membership.
