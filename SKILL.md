---
name: agent-bridge
description: Share context and reliable work between agents across runtimes and machines.
---

# Agent Bridge

Discover the active v2 operation contract with MCP `capabilities`, CLI `agent-bridge capabilities`, or authenticated `GET /v2/capabilities`. Released 2.0 clients continue to work after the gateway is upgraded. A new 2.1 client must receive complete, consistent negotiation headers that select and advertise 2.1 before it mutates remote state. If the probe is headerless, selects 2.0, or returns partial or contradictory headers, do not mutate. Upgrade the gateway first instead of downgrading the client.

Use the Agent Bridge MCP tools for normal traffic. Let the active runtime supply its own identity. Do not pass a literal source unless a standalone CLI process has no configured identity.

If the MCP server is unavailable or disconnects, report the outage instead of implying
that a post, read, or acknowledgment succeeded. Run `agent-bridge doctor --json` from a
shell and follow [docs/troubleshooting.md](docs/troubleshooting.md). Reinstall the client
registration if its executable or environment is stale.

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

Before Agent Bridge takes lifecycle ownership of an existing Codex, Claude Code, or
Claude Desktop registration, run `agent-bridge clients inspect <runtime>` with its
exact `--identity`, stable `--instance`, and absolute `--backend-config` path. Supply
the installed command and Claude Code scope when they differ from defaults. Treat
`drifted` as a stop condition. `agent-bridge clients adopt` returns a plan by default;
only add `--apply` after reviewing an exact `unmanaged` result. Adoption writes
credential-free owner-private metadata only. It does not rewrite the MCP registration
or backend file, and inspection never returns backend values or contacts the gateway.
Desktop adoption records the normalized config path. Codex adoption records the active
profile config. Run Claude Code local or project adoption from the directory that
later lifecycle operations should use; the native CLI exposes no stronger target.
The backend and its immediate parent must already pass the owner-only no-link policy.
Treat registration state separately from connectivity health; applied adoption
re-inspects the registration before it reports success. Enrollment-based first-time
provisioning continues to refuse registration and backend-file collisions.
Use `agent-bridge clients operations` or append an operation UUID to inspect local
crash-safe operation state. Artifact contents remain confined to owner-private files;
inspection reports resumable, classification-required, blocked, or complete and names
the exact pending step only. Begin is lock-covered, resume is same-host only, and
ordered steps use no-replace before and verified after artifacts. Treat corrupt,
cross-host, or ambiguous state as a stop condition. Cleanup is restartable per artifact
and `committed` means verified writes plus removed artifacts. The terminal manifest
keeps a credential-free completion record but no request, step, digest, locator, or
artifact metadata.

For a managed registration, use `clients repair <runtime> --identity <name> --instance
<key>` to preview its recorded launch contract and backend privacy repair. Add `--apply`
only after reviewing the plan. Use `clients update` with the same metadata-selected
runtime and instance to validate a replacement launch contract. The same identity must
match the stored metadata and the immutable request. Native commands are one executable
contract. Do not pass arguments, URLs, or credential selectors in `--command`. Repair, update, and uninstall reject
`--backend-config`, `--scope`, and `--config-path`; `--identity` is an assertion, not a
locator. A no-op exact registration creates no journal. Native updates remove, prove
absence, add, and prove the target before metadata changes. Desktop updates replace only
the Agent Bridge entry and retain unrelated JSON values in memory. It publishes through
a private operation-scoped temporary file. A concurrent same-user Desktop writer can
still race this advisory single-file update because Node cannot provide an OS transaction.

Use `clients uninstall <runtime> --identity <name> --instance <key>` to preview a
forward-only removal. With `--apply`, it proves and removes the managed registration,
deletes the already private backend file, then deletes metadata. It refuses a backend
that needs privacy repair and never recreates an earlier target after a later failure.
Desktop removes only its Agent Bridge entry. Backend content never enters the journal.

Use `clients rollback <update-operation-id> --identity <name>` to inspect an explicit
reverse plan for a committed same-host v4 update. Add `--apply` only after reviewing
that plan. The source record retains only prior nonsecret managed metadata, its exact
registration contract, and forward-state digests. Rollback verifies those digests
against the current registration, then creates a separate reverse journal. Native
rollback removes the forward entry, adds the prior entry, and writes prior metadata
last. Claude Desktop replaces only its Agent Bridge entry and preserves unrelated JSON.
Repair has no rollback. Uninstall remains forward-only, so recovery is re-enrollment.

Resume an action-specific operation with the same action, runtime, instance, and
identity: `--apply --resume <uuid>`. The stored request controls resume. Do not supply
a new command unless it exactly matches the recorded update request. Use
`clients resume <uuid> [--recover-lock]` to resume from a recorded v3 or supported v4
request alone. It does
not accept replacement client authority. Use the generic form after uninstall has
deleted metadata. `--recover-lock` on an action-specific command also requires
`--apply`; it only recovers a stale same-host lock after process-death proof. Never
remove operation locks by hand.

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

Native DR is also an offline operator task. Use `agent-bridge dr backup|verify|restore`
for one complete SQLite or PostgreSQL authority. Local DR accepts the SQLite authority,
not the gateway edge store. PostgreSQL backup and restore authority come only from
`AGENT_BRIDGE_DR_SOURCE_DATABASE_URL` and
`AGENT_BRIDGE_DR_TARGET_DATABASE_URL`. PostgreSQL restore needs a fresh same-name,
same-major database, a superuser, an explicit request ID, and
`--accept-source-sql-risk`. Never activate the source and restored target together.
Treat the bundle as private database material; its hashes do not encrypt or authenticate
the source.

Use `project` only as an optional message label. Workspace remains the tenant and credential boundary. Omit a project filter to read labeled and unlabeled messages, or provide one for an exact match. Reusing a workspace/source idempotency key with a different project is a conflict.

For gateway mode, treat the credential-bound workspace and principal returned by the server as authoritative. Instance is an optional caller-supplied stable consumer key; it cannot select a workspace, agent, or scopes. Supported installers generate and persist it. Direct clients may do so when they need separate consumer state or presence. The gateway does not bind the key to an installer registration. Unless `AGENT_BRIDGE_CURSOR` is explicit, processes that share one key also share its cursor path. They also share delivery lease ownership and instance-keyed presence. Without a key or explicit cursor path, cursor storage uses `default`. Leases use the principal, and presence is unavailable. Instance is not a PID, unique live process, session, or thread. A production gateway reports row isolation only when transaction-bound request authority and every database readiness check pass. RLS isolates workspace and principal rows. The service still enforces lease transitions and target-to-delivery membership.
