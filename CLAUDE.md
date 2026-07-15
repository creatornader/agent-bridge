## Project: Agent Bridge

Provider-neutral MCP server, CLI, and HTTPS gateway for messaging between AI agents.

### Key files

- `src/server.ts`: MCP server with v1 compatibility and v2 messaging, delivery, and presence tools
- `src/index.ts`: Entry point
- `src/gateway.ts`: Authenticated v2 HTTP boundary
- `src/postgres-bridge-store.ts`: Canonical shared PostgreSQL store
- `src/sqlite-bridge-store.ts`: Local-only SQLite store
- `src/sqlite-edge-store.ts`: Gateway outbox, inbox cache, and sync state
- `src/syncing-bridge-store.ts`: Offline gateway wrapper and replay loop
- `bin/agent-bridge`: Cross-platform Node CLI launcher
- `sql/migrations/`: Ordered gateway schema migrations
- `sql/setup.sql`: Legacy Supabase v1 schema
- `docs/postmortems/2026-07-08-wrapper-source-drift.md`: Incident note for wrapper/source drift
- `docs/decisions/0001-protocol-layers-and-acknowledgment-semantics.md`: Protocol boundary and acknowledgment semantics
- `docs/decisions/0002-canonical-operation-contract-registry.md`: Canonical v2 contracts and version negotiation
- `docs/architecture-v2.md`: Accepted v2 protocol, storage, security, delivery, and migration design
- `SKILL.md`: Runtime-neutral instructions for agents using the bridge
- `llms.txt`: Compact package and interface map for model tooling
- `.github/workflows/test.yml`: Cross-platform, PostgreSQL, and packed-install checks
- `.github/workflows/release.yml`: Tagged package verification and gated npm publication

### Documentation ownership

- Hub doc: `README.md` is the public entry point and links to the other maintained docs.
- `CLAUDE.md` records repository working rules and active architecture constraints.
- `README.md` describes installation, public behavior, and supported interfaces.
- `docs/architecture-v2.md` is the source of truth for v2 architecture and acceptance checks.
- ADRs under `docs/decisions/` record durable protocol and architecture choices. `docs/architecture-v2.md` describes the resulting system.
- `CHANGELOG.md` records released behavior.
- `SKILL.md` records the public agent operating contract.
- `llms.txt` provides a compact index and must match the public commands and identity model.
- Postmortems under `docs/postmortems/` record incidents and corrective policy.

Sync triggers:

| Event | Docs to update |
| --- | --- |
| Public command, tool, or config changes | `README.md`, `CHANGELOG.md` |
| Agent operating contract changes | `SKILL.md`, `llms.txt`, `README.md` |
| Protocol, storage, identity, or delivery decision changes | `docs/architecture-v2.md`, `CLAUDE.md`, `README.md` |
| Release version changes | `package.json`, `CHANGELOG.md`, `README.md` when compatibility changes |
| Incident changes operating policy | Matching postmortem, `CLAUDE.md`, and any affected public setup docs |
| New maintained document | `README.md`, `CLAUDE.md`, and related docs that should link to it |

### Architecture decisions

- Agent Bridge is the durable, pull-first mailbox and work-delivery control plane. A2A and application task semantics sit above it.
- MCP, CLI, and HTTPS are access surfaces. Optional transports may sit below the core but cannot replace authoritative cursor replay.
- Read receipts, delivery claims, lease extensions, delivery settlement, and external task completion are separate semantics.
- agmsg is a reference for adapters, interoperability, and client experience, not the protocol authority.
- PostgreSQL is the canonical shared store. Supabase is an optional PostgreSQL host and a named legacy adapter.
- SQLite is the local authority in local mode. In gateway mode it stores the durable outbox, cache, and cursor state.
- Shared config contains backend settings only. `AGENT_BRIDGE_AGENT` is accepted only from the active process or an explicit CLI identity argument.
- Client installers write separate owner-only backend files. Gateway tokens are bound to one principal and never stored in the shared config.
- Gateway credentials bind workspace and principal. Client source and workspace fields are not trusted.
- Migrations use the schema-owner `AGENT_BRIDGE_DATABASE_URL`. The gateway requires a restricted `AGENT_BRIDGE_RUNTIME_DATABASE_URL` and never runs migrations at startup.
- Message content and routing are immutable. Receipts, deliveries, delivery events, and presence use separate records.
- History defaults to caller-relative inbox visibility. Sent is source-equal-to-caller, all is their union, and receipt state is caller-bound and inbox-only. Cursors bind identity, visibility, and normalized filters.
- Project is an optional immutable message label. Workspace remains the tenant and credential boundary; omitted project reads all labels.
- The legacy Supabase schema is global and has no tenant workspace. Legacy clients report workspace `*` and use project only as a message label.
- Migration 008 adds project storage. Migration 006 remains unchanged and its imported rows are corrected only by the schema-owner reconciliation command.
- Cursor pulls are authoritative. Notifications may wake a client but never replace replay.
- Delivery is at least once through claim, lease, ack, nack, retry, and dead-letter state.
- Immutable publisher delivery policy owns delivery mode, retry limits, and backoff. Cancel and requeue are publisher-only. Requeue resets cycle attempt but not lifetime attempt. Consumer `maxAttempts` and `retryPolicy` inputs are validated and ignored for one compatibility release.
- Exact idempotent replay deduplicates. Changed content under an existing idempotency key fails.
- Direct fetch remains in the legacy adapter. The normal remote path uses the authenticated gateway.
- Local and edge SQLite files use WAL, bounded busy waits, and owner-only modes where supported.
- Runtime manifests and installers inject identity per client. They do not write one identity into shared config.
- URL-encoded braces in PostgREST array contains filter (`%7B`/`%7D` instead of `{`/`}`): curl strips unencoded braces
- Permissive RLS belongs only to the legacy schema. The private v2 schema denies Supabase Data API roles.
- `ack_context` uses a Postgres RPC function (`security definer`, `set search_path`) for atomic `array_append`: avoids race conditions and reduces network calls from 2 to 1
- `bridge-meta` category enables agents to suggest improvements to the bridge itself
- `agent-bridge-atrib` is an optional signed HTTP wrapper, not the canonical implementation; clients should keep a direct source-repo MCP path available when wrapper liveness is uncertain
- `src/contracts/registry.ts` is the canonical v2 operation contract. Generated schema, OpenAPI, MCP, and capability artifacts must pass `npm run contracts:check`.
- HTTP protocol 2.1 is current. The gateway accepts exactly 2.0 and 2.1; a missing request header selects the 2.0 compatibility shape, and every other version returns 426. Package, MCP implementation, protocol, and migration versions are independent.
- Upgraded gateways preserve released 2.0 clients. New 2.1 clients require complete, consistent 2.1 negotiation before mutation and reject headerless or selected 2.0 gateways instead of downgrading. Upgrade the gateway before 2.1 clients.
- OpenAPI paths describe protocol 2.1. The embedded 2.0 vendor extensions contain limited compatibility schema metadata, not a second OpenAPI description.
- Gateway credentials enforce the canonical operation scopes. Capabilities requires an active credential but no named scope. Local and legacy providers report scope enforcement as false.
- For requests with bodies, the gateway validates media type, size, and JSON before opening the request transaction. Every authorized operation then consumes a credential-wide rate bucket and an operation bucket through narrow security-definer functions. Scope and rate denials append secret-free security events before domain work begins.
- Production request authority, security accounting, and domain work use one checked-out client and one explicit outer transaction. Readiness uses a separate one-connection pool. Node hashes the bearer credential before PostgreSQL receives it. Migration 012 matches that hash and derives canonical workspace, principal, and scopes on the request backend. Migration 013 forces RLS on the five domain tables and records a protected catalog attestation. Gateway capabilities report row isolation only after live readiness checks pass. Lease transitions and target-to-delivery membership remain application-enforced.
- Credential replacement links are immutable and principal-bound. Revocation and ordinary expiry always win; a successor grace cutoff may only shorten predecessor access.
- Migration 014 is the offline PostgreSQL owner control plane. Database-specific control owner, operator, and auditor roles expose exactly replayable provisioning and credential lifecycle functions. The schema owner registers operator and auditor logins through protected SQL functions; direct control-role grants fail readiness. Registered members cannot inherit unrelated roles, and no role may inherit a registered member. Protected operations recheck `session_user` against the live registry and direct membership. Operation, registration, and revocation paths take a member-global transaction lock before operator and auditor capability locks. The gateway and MCP server have no membership administration route. A request UUID serializes each mutation before database work begins. Rotation fingerprints the expected workspace and principal, checks them while locking the predecessor, and returns the canonical identity. Inventory uses an optional workspace filter and a `(created_at, credential_id)` keyset cursor, with 100 rows by default and a limit of 1,000. Fixed-origin expression indexes serve global and workspace ordering. The control owner cannot select credential hashes. The migration refuses critical dependency or privilege drift before recording a scoped catalog attestation. Runtime readiness checks prerequisite definitions, default privileges, the running server major, and the exact registered membership graph while permitting unrelated additive schema objects. Credential-security prerequisite digests are certified separately for PostgreSQL 15, 16, 17, and 18; unknown future majors fail closed before and after migration. New raw credentials default to no scopes.
- `agent-bridge owner` is the offline CLI for migration 014. It accepts database authority only from `AGENT_BRIDGE_OPERATOR_DATABASE_URL`; it stays outside MCP, HTTP, and the operation registry. Provision and rotation create revisioned private enrollment files before database work. An exclusive file lock covers database and installer side effects, and every transition compares current disk state before replacement. Provision registers the host once. Rotation requires predecessor credential, principal, instance, gateway, workspace, and live registration matches before replacing the backend. Enrollment and credential paths on Windows must already be owned by the current SID before the code applies or accepts a protected current-user-only DACL. Node identity checks and native reparse attributes reject symlinks, junctions, other reparse objects, and path replacement around DACL work. Deletion and lock-release results distinguish retained objects from completed operations whose directory durability could not be proved.
- Client `status` is passive and reports unknown remote reachability without claiming a connection. `doctor` performs explicit checks. It exits 0, 2, or 1 for ok, degraded, or failed. Diagnostics preserve blocked edge-outbox evidence across later successful synchronization and distinguish due, scheduled, and leased work.

### Providers

- Local: `AGENT_BRIDGE_PROVIDER=local`
- Gateway: shared URL and workspace plus a separate principal-bound token in each installed client's backend file
- Legacy: `AGENT_BRIDGE_PROVIDER=legacy-supabase`, Supabase URL and key

### Integration points

- Any MCP-compatible client: register `agent-bridge-mcp` and inject its own `AGENT_BRIDGE_AGENT`.
- Any CLI-driven agent: invoke `agent-bridge` with process identity or an explicit send source.
- Shared config: `~/.agent-bridge/config` for backend location and workspace, never client identity or gateway tokens.
- Optional signed wrapper: `agent-bridge-atrib` lives outside this repo and must prove `/mcp/health`, not only a running launchd process

### Dev commands

```bash
npm run build  # production build
npm run dev    # watch mode
npm start      # run MCP server
```
