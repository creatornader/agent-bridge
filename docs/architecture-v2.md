# Agent Bridge v2 architecture

Status: living architecture for the 0.3.0 development line. Version 0.2.0 was released on July 14, 2026.

## Product boundary

Agent Bridge is the durable, pull-first mailbox and work-delivery control plane for agents that run in different clients, processes, sessions, and machines. It supports two operating modes:

History visibility is caller-relative. `inbox` is the default and preserves broadcast-plus-targeted visibility; `sent` is source equal to the caller; `all` is their union. Receipt state (`any`, `unread`, `read`) is valid only for inbox and is always evaluated for the authenticated caller. Opaque v2 cursors bind workspace, caller, mailbox, and normalized filters. Readers temporarily accept v1 sequence cursors but emit only v2. After an edge cache contract upgrade, the gateway resets the authoritative pull cursor and replays `all` visibility; the publication outbox is never treated as sent history.

These authorization guarantees apply to local v2 and the authenticated gateway. The legacy Supabase adapter can enforce them only cooperatively because its publishable key can call the underlying PostgREST table and receipt RPC directly.

- Local mode runs without an account or network connection.
- Shared mode uses a remote service so agents on different machines see the same history and delivery state.

The protocol must support informational context and executable work without treating them as the same thing. A2A and application task semantics sit above Agent Bridge. MCP, CLI, and HTTPS are access surfaces. Optional transports may sit below the core, but they cannot replace authoritative cursor replay or durable delivery state.

[ADR-0001](decisions/0001-protocol-layers-and-acknowledgment-semantics.md) defines these layers and the distinct meanings of receipts, claims, leases, delivery settlement, and external task completion.

## Decisions

### PostgreSQL is the shared source of truth

PostgreSQL stores shared messages, identities, receipts, deliveries, and migration state. Supabase remains a supported managed PostgreSQL provider, but clients do not depend on Supabase-specific behavior.

A standalone Agent Bridge API sits between remote clients and PostgreSQL. Clients authenticate to the API with scoped credentials. They do not receive a database password or rely on a shared Supabase publishable key for identity.

Supabase can still host the database. Existing direct PostgREST deployments remain available through an explicitly named legacy adapter while they migrate.

### SQLite is local storage

SQLite WAL provides local-only operation, a durable outbox, an inbox cache, cursor state, and a cheap pending-work check. Outbox writes use `synchronous=FULL`. It is not the canonical multi-machine database.

The gateway outbox queues immutable message publication. Receipt and lease mutations still require the remote authority because replaying them after ownership or identity changes can settle the wrong work.

Long-lived gateway MCP clients own a cancellable transport loop that replays publications and refreshes the inbox cache with bounded exponential backoff. It is transport maintenance, not agent monitoring. Manual MCP and CLI sync use the same replay path. A publication timeout after the gateway may have committed remains queued under its stable idempotency key. A retry resolves to the original immutable message instead of publishing a duplicate.

Local initialization must be idempotent. Every connection uses a bounded busy timeout. The minimum supported SQLite build must include the WAL-reset corruption fix. Node 22.23.1 on the current development machine embeds SQLite 3.51.3, which includes that fix.

### Messages are immutable

The protocol stores message content and routing fields in an immutable message record. Read and execution state live in separate tables.

Each message has:

- A client-generated UUIDv7 ID.
- A backend-assigned sequence number for the authoritative shared cursor.
- A workspace and source principal.
- A display source for v1 compatibility.
- Category, kind, and priority.
- Target principals or broadcast scope.
- Thread, reply, correlation, and causation IDs.
- Content and optional structured or referenced payload data.
- Creation and expiry timestamps.
- An optional idempotency key.
- An optional validated project label that is immutable with the message. It does not affect workspace, identity, delivery, or cursor authority.
- Optional atrib receipt and informed-by references.

Frequently queried fields are columns with indexes. Extension data remains JSON.

The v2 envelope uses fields that can be mapped to CloudEvents without changing stored message identity or payload data. Agent Bridge fields such as workspace, targets, thread, priority, expiry, and causal references remain protocol-specific extensions. A concrete CloudEvents serializer is deferred until an external integration needs one.

### Receipts and deliveries are different records

A receipt records that a principal read a message.

A delivery records executable work for a recipient. Its state is one of `pending`, `claimed`, `acked`, `retrying`, or `dead`. A claim includes an opaque lease token, owner instance, expiry time, and attempt number.

A receipt does not change delivery state. A claim or settlement does not create a receipt. Lease renewal proves only that the current owner retained its claim. External task completion belongs to A2A or the application layer and must be recorded separately when a workflow needs both task state and delivery settlement.

Each delivery transition also appends an audit event. Runtime presence uses a separate leased record keyed by workspace, agent, and instance. Presence can carry a runtime type and declared capabilities without using a PID as ownership proof. Expired rows are pruned during normal presence operations. Each agent is limited to 128 active instances, and each workspace is limited to 4,096.

The system promises at-least-once delivery. It does not promise exactly-once execution. Idempotency keys prevent duplicate insertion, and consumers must make side effects idempotent.

Project participates in the idempotency fingerprint. Reads without a project filter span labeled and unlabeled messages inside the credential-bound workspace. An exact filter narrows that same cursor authority. Migration 008 adds the PostgreSQL column and index. Existing local and edge SQLite databases add their project columns during initialization. Migration 006 is not rewritten. A schema-owner command dry-runs or reconciles its rows into workspace `agent-bridge` in one transaction. It preserves IDs, timestamps, receipts, and row counts, and it verifies that no delivery exists before or after the change.

The legacy Supabase schema has no tenant workspace column. Its adapter reports workspace `*` and uses the legacy `project` column only as a message label. It rejects per-command workspace overrides because assigning a caller-selected workspace to global rows would create a false isolation boundary.

The delivery API supports:

- Atomic claim with row locking.
- Lease renewal for long-running work.
- Acknowledgment after successful processing.
- Negative acknowledgment with a bounded error message.
- Retry scheduling with exponential backoff and jitter.
- Maximum attempts and dead-letter state.
- Recovery of expired leases.

PostgreSQL claims use `FOR UPDATE SKIP LOCKED` so workers do not wait on rows that another worker already owns. SQLite uses a short immediate transaction to provide the same store contract on one machine.

### Cursor pull is authoritative

Reads use an opaque cursor backed by the backend sequence number. UUIDv7 improves index locality and offline identity, but it does not replace the server cursor because client clocks can drift. Filters run in the storage layer. Clients never fetch an arbitrary recent sample and filter it in memory.

During gateway outages, normal inbox and pending reads return the locally cached candidate set with explicit degraded and stale metadata. Because receipt state is remote authority and is not mirrored, an offline `unacknowledgedBy` result reports acknowledgement state as unknown; it must not be interpreted as proof that every returned message is unread.

Realtime, hooks, webhooks, and desktop notifications may wake a client. The client still pulls from its last durable cursor. This closes notification gaps and makes reconnect behavior testable.

Supabase documents that Realtime does not guarantee every database change. Agent Bridge therefore treats it as an optional delivery hint, not a message log.

### Identity is bound at the client boundary

The identity model separates:

- Workspace.
- Agent principal.
- Human-readable name.
- Runtime type.
- Client instance.
- Session or thread.
- Optional role.
- Authentication subject and credential.

Remote credentials bind the workspace and principal. Each installed client gets a separate owner-only backend file containing only its bound token and backend settings. The shared config does not hold a gateway token. A client cannot claim another source label. Local mode binds identity through its process configuration. `AGENT_BRIDGE_AGENT` remains the compatibility field for MCP and CLI clients.

### The core is provider-neutral

Protocol logic depends on a `BridgeStore` interface, not a provider SDK. The initial stores are:

- SQLite for local mode and edge state.
- PostgreSQL for a standalone shared deployment.
- Supabase legacy REST for v1 compatibility during migration.
- Agent Bridge HTTP API for normal remote clients.

Runtime and wakeup adapters are independent from storage. A client manifest declares identity injection, supported wake modes, config locations, health checks, and install actions for Codex, Claude Code, Claude Desktop, OpenClaw, or a generic MCP client.

### v1 compatibility is additive

The MCP tools `post_context`, `get_context`, and `ack_context` remain available. Existing CLI verbs and flags remain accepted. Text responses remain present while v2 adds structured result data.

Legacy Supabase rows remain readable as broadcast messages. A migration command checks schema state, backfills v2 records, and verifies counts before activation. Secure shared mode cannot silently inherit the old permissive RLS policies.

## Security boundary

Shared mode uses a token-authenticated API. The service stores only token hashes. Credentials are scoped to a workspace and principal, can expire, and can be revoked.

Schema migration and provisioning use a database-owner connection. The running gateway uses a different login that inherits a database-specific runtime role. The role name includes a digest of the database name so permission does not bleed between Agent Bridge databases on one PostgreSQL cluster. That role can read runtime state, insert immutable messages and receipts, transition deliveries, append delivery events, and maintain leased presence. It cannot change workspaces, agents, credentials, message content, schema objects, or migration records. Gateway startup does not run migrations.

The database denies direct message updates. Constrained operations handle insertion, receipts, claims, renewals, acknowledgments, and negative acknowledgments. Every query includes workspace scope, and recipient visibility is enforced in storage rather than by client-side filtering.

Limits apply to content bytes, payload bytes, metadata depth, target count, batch size, lease duration, and page size. Network calls have connect and total deadlines. Errors have stable codes and do not return secrets or raw database messages.

## Operations and observability

The CLI provides `init`, `doctor`, `status`, `demo`, `send`, `inbox`, `history`, `claim`, `ack`, `nack`, `watch`, `sync`, and migration commands. Existing `post` and `get` aliases remain available.

`/readyz` reports storage and schema readiness. Authenticated status output reports the bound principal, provider schema, delivery counts, the oldest due delivery, and local edge state when the caller uses a gateway client. Client `doctor` and `status` distinguish healthy local edge storage from remote gateway reachability rather than claiming connectivity from local startup alone.

Gateway responses carry a request ID, including stable error envelopes. Authenticated Prometheus output counts requests, errors, timeouts, and authentication failures. Responses and metrics exclude bearer tokens, database URLs, payload bodies, and credential material.

## Packaging and release

The unscoped npm name `agent-bridge` belongs to another project. This repository uses `@creatornader/agent-bridge`. Tagged builds always produce a package artifact. Publishing stays gated by the protected `npm` environment, npm's OIDC trusted-publisher binding to `release.yml`, and the `NPM_PUBLISH_ENABLED` repository variable.

The package must contain built runtime files, migrations, client manifests, license, README, and changelog. A clean tarball install runs in CI. Releases use one version source, a tag-to-version check, npm provenance, and a human approval gate.

## Acceptance checks

The v2 implementation is not accepted until all of these checks pass:

1. Unit tests and the production build.
2. One store contract suite against SQLite and PostgreSQL.
3. Concurrent claim tests that prove one active lease per delivery.
4. Crash-after-claim recovery through lease expiry.
5. Idempotent insertion and retry tests.
6. Cursor replay with equal timestamps and expiry filtering.
7. Workspace and recipient isolation tests.
8. HTTP timeout, authentication, redaction, and malformed-input tests.
9. MCP transport tests for the three v1 tools and all added v2 tools.
10. CLI config precedence, identity, local demo, doctor, and package-install tests.
11. Upgrade tests from the current `shared_context` schema.
12. A two-client local run and a two-client PostgreSQL run.

## Deferred work

NATS, JetStream, SLIM, or another transport stays optional until measured throughput, wakeup, queue-group, or geographic requirements justify it. Any transport adapter must preserve cursored replay, idempotency, identity binding, and delivery leases. A dashboard also waits. The CLI and structured health surface come first.

End-to-end payload encryption needs a separate threat model and key-management design. The current ciphertext field does not imply that routing metadata is encrypted. OpenClaw and generic MCP config mutation remains operator-managed because their host config formats are not stable enough for blind edits.

## Source notes

- agmsg current architecture and implementation: <https://github.com/fujibee/agmsg>
- SQLite WAL behavior: <https://sqlite.org/wal.html>
- SQLite WAL-reset bug: <https://sqlite.org/forum/forumpost/0b7fd7f028>
- PostgreSQL row locking and `SKIP LOCKED`: <https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE>
- Supabase self-hosting responsibilities: <https://supabase.com/docs/guides/self-hosting>
- Supabase Realtime delivery limitations: <https://supabase.com/docs/reference/self-hosting-realtime>
- MCP tools specification: <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
- MCP transport specification: <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
- UUIDv7: <https://www.rfc-editor.org/rfc/rfc9562.html#name-uuid-version-7>
- CloudEvents core attributes: <https://github.com/cloudevents/spec/blob/ce%40stable/cloudevents/spec.md#required-attributes>
