# Agent Bridge

Agent Bridge is a durable, pull-first mailbox and work-delivery control plane for AI agents that run in different clients, processes, sessions, and machines.

It supports three operating modes:

| Mode | Store | Use case |
| --- | --- | --- |
| Local | SQLite WAL | One machine, no service or account |
| Gateway | PostgreSQL plus a local SQLite edge store | Cross-machine messaging, offline sends, claims, retries, and presence |
| Legacy Supabase | Existing `shared_context` table through PostgREST | Compatibility while a v1 deployment migrates |

PostgreSQL remains the authority in gateway mode. SQLite holds local-only messages or gateway edge state. Supabase is one way to host PostgreSQL, not a protocol dependency.

## What v2 provides

- Immutable messages with UUIDv7 IDs and opaque server cursors.
- Indexed source, thread, timestamp, workspace, and delivery queries.
- Read receipts separated from executable delivery state.
- Atomic claim, lease renewal, acknowledgment, negative acknowledgment, retry, and dead-letter operations.
- Immutable publisher-owned delivery policy with mailbox and leased modes, strict urgent/high/info claim priority, publisher cancel and requeue controls, authorized audit pagination, and fenced leases.
- Append-only delivery transition history.
- Idempotency conflict detection. Exact replay deduplicates; changed content under the same key fails.
- Scoped credentials that bind a remote workspace and agent principal.
- SQLite outbox and inbox cache for gateway clients.
- Leased runtime presence with instance IDs and capabilities.
- MCP, CLI, Codex, Claude Code, and Claude Desktop integration paths.
- Existing `post_context`, `get_context`, `ack_context`, `post`, and `get` behavior during migration.

The accepted protocol and storage decisions live in [docs/architecture-v2.md](docs/architecture-v2.md).

The canonical v2 operation registry generates [JSON Schema](schemas/agent-bridge-v2.schema.json), [OpenAPI 3.1.2](openapi/agent-bridge-v2.openapi.json), and the [MCP manifest](schemas/agent-bridge-v2.mcp.json). Use `GET /v2/capabilities`, MCP `capabilities`, or CLI `agent-bridge capabilities` to discover the operations for that surface and provider. Capabilities distinguish the current, selected, and supported protocol versions.

Protocol 2.1 uses a gateway-first rollout. An upgraded gateway continues to serve released 2.0 clients, including headerless requests and their direct or null delivery results. A 2.1 client probes before mutation and proceeds only when complete, consistent response headers select 2.1 and advertise 2.1 support. It rejects mutation against a headerless or 2.0 gateway instead of downgrading. Upgrade the gateway before installing or starting 2.1 clients.

The OpenAPI paths describe protocol 2.1. The embedded `x-agent-bridge-protocol-2.0` and `x-agent-bridge-schemas-2.0` vendor extensions contain frozen compatibility schema metadata for released 2.0 clients. They are not a second OpenAPI description. Gateway credentials enforce the operation scopes declared by the canonical registry. Local mode uses process identity, and legacy mode uses its configured key. Provider-neutral artifacts report this difference instead of claiming one authorization model for every backend.

## Architecture

```text
 Codex       Claude Code       Claude Desktop       scripts
   |              |                  |                 |
   +--------------+------------------+-----------------+
                          MCP or CLI
                              |
                  process-scoped agent identity
                              |
             +----------------+----------------+
             |                                 |
       local SQLite                  SQLite edge store
                                               |
                                     authenticated HTTPS
                                               |
                                      Agent Bridge gateway
                                               |
                                          PostgreSQL
```

Realtime notifications or hooks may wake a client, but cursored reads remain authoritative. A missed notification does not lose a message.

A2A and application task semantics sit above Agent Bridge. MCP, CLI, and HTTPS are access surfaces. Optional transports such as SLIM or NATS may provide wakeups or transport below the core, but authoritative recovery still uses cursored pull. agmsg remains a reference for adapters, interoperability, and client experience.

[ADR-0001](docs/decisions/0001-protocol-layers-and-acknowledgment-semantics.md) defines this boundary and the distinct acknowledgment meanings.

## Requirements

- Node.js 22.23.1 or newer.
- SQLite 3.51.3 or newer for local and edge storage. The supported Node version includes it.
- PostgreSQL 15 or newer for gateway mode.

## Install from source

The unscoped npm name belongs to another project. This repository uses the published package `@creatornader/agent-bridge`. The release workflow builds every tagged package before the protected npm publication step.

```bash
git clone https://github.com/creatornader/agent-bridge.git
cd agent-bridge
npm ci
npm run build
npm link
```

The package exposes three executables:

- `agent-bridge`: CLI.
- `agent-bridge-mcp`: stdio MCP server.
- `agent-bridge-gateway`: HTTP gateway.

`npm pack` builds the package before creating a tarball. CI installs that tarball into an empty project, imports the provider-neutral library API, and runs the packaged CLI. Importing the package root does not start the MCP server.

## Local quick start

Initialize backend settings. `init` does not write an agent identity into the shared config.

```bash
agent-bridge init --provider local
```

Each client supplies its own identity:

```bash
AGENT_BRIDGE_AGENT=codex agent-bridge post --category operational "Bridge is ready"
AGENT_BRIDGE_AGENT=claude-code agent-bridge get --unacked-by claude-code
```

You can also pass `--source` to a standalone send. If the process already has `AGENT_BRIDGE_AGENT`, an explicit identity must match it.

Run a two-principal local proof:

```bash
agent-bridge demo
```

## Install client integrations

Agent identity and gateway credentials belong to each client process, not the shared `~/.agent-bridge/config` file.

```bash
agent-bridge clients install codex --identity codex
agent-bridge clients install claude-code --identity claude-code
agent-bridge clients install claude-desktop --identity claude-desktop
```

For gateway mode, issue a distinct principal-bound token for each client and pass it only during that client's installation:

```bash
AGENT_BRIDGE_CLIENT_TOKEN=<codex token> \
  agent-bridge clients install codex --identity codex
AGENT_BRIDGE_CLIENT_TOKEN=<claude-code token> \
  agent-bridge clients install claude-code --identity claude-code
AGENT_BRIDGE_CLIENT_TOKEN=<claude-desktop token> \
  agent-bridge clients install claude-desktop --identity claude-desktop
```

`--token` accepts the same value, but the environment form avoids putting a credential in shell history. Each install writes an owner-only backend file under `~/.agent-bridge/clients/`. The host MCP registration receives that file path, the client identity, and a generated instance ID. Tokens are not copied into the shared config, and one client cannot reuse a token bound to another principal.

Codex and Claude Code installation uses their native MCP commands. Claude Desktop installation merges the `agent-bridge` server into its JSON config with an atomic write. Restart the client after installation.

The runtime contracts are under [`clients/`](clients/). OpenClaw and generic MCP manifests declare the required environment variable and command but leave config mutation to the operator because their host config shapes vary.

[`SKILL.md`](SKILL.md) provides concise runtime-neutral operating instructions for agents. [`llms.txt`](llms.txt) gives tools and model crawlers a compact map of the package, modes, commands, and identity rules.

## Gateway setup

Apply migrations to a PostgreSQL database:

```bash
PGUSER=schema_owner PGPASSWORD='<password>' \
AGENT_BRIDGE_DATABASE_URL=postgresql://host/database \
  agent-bridge migrate
```

The migration sequence creates or refreshes a database-specific restricted role. Get its name, then create a login that inherits it. Keep the schema-owner URL out of the gateway process:

```sql
create role agent_bridge_gateway login password '<generated password>';
do $grant$
declare
  runtime_role text := 'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16);
begin
  execute format('grant %I to agent_bridge_gateway', runtime_role);
end
$grant$;
```

The database-derived suffix prevents a gateway login for one database from inheriting access to another Agent Bridge database on the same PostgreSQL cluster. Do not grant the login another database's runtime role.

Create a workspace, agent, and credential with the migration or provisioning connection. Store only a SHA-256 token hash:

```sql
insert into agent_bridge.workspaces (id, name)
values ('team', 'Team');

insert into agent_bridge.agents (workspace_id, principal, runtime_type)
values ('team', 'codex', 'codex')
returning id;

insert into agent_bridge.credentials (workspace_id, agent_id, token_hash, label)
values ('team', '<agent uuid>', '<sha256 token hash>', 'codex laptop');
```

Migration 011 gives direct inserts the full compatibility scope set. This keeps the released provisioning command working until owner commands replace raw SQL. A capabilities-only credential may use an empty `scopes` array. Custom arrays must use only the declared scopes, without duplicates, in lexical order. Repeat the agent and credential inserts for Claude Code, Claude Desktop, or any other principal. Each plaintext token should be random, unique, and shown only to the matching client installer.

Start the gateway:

```bash
PGUSER=agent_bridge_gateway PGPASSWORD='<password>' \
AGENT_BRIDGE_RUNTIME_DATABASE_URL=postgresql://host/database \
AGENT_BRIDGE_HOST=127.0.0.1 \
AGENT_BRIDGE_PORT=8787 \
agent-bridge-gateway
```

Put the gateway behind TLS for any non-loopback deployment.

Configure a client backend without storing its identity:

```text
AGENT_BRIDGE_PROVIDER=gateway
AGENT_BRIDGE_URL=https://bridge.example.com
AGENT_BRIDGE_WORKSPACE=team
```

These shared settings are enough before `clients install`. The installer takes `AGENT_BRIDGE_CLIENT_TOKEN`, creates a private client backend file containing the matching token, and registers `AGENT_BRIDGE_AGENT`, `AGENT_BRIDGE_INSTANCE`, and that file's path with the host. Gateway initialization checks readiness, token validity, and that the token-bound principal matches that process identity.

## Offline gateway behavior

Gateway clients use `~/.agent-bridge/edge.sqlite3` by default.

When a send cannot reach the gateway:

1. The validated message is written to the SQLite outbox with a stable idempotency key.
2. The CLI or MCP result reports `disposition: "queued"` and `authoritative: false`.
3. Long-lived MCP gateway clients retry due messages automatically with bounded exponential backoff. `agent-bridge sync` and the MCP `sync` tool trigger the same bounded replay and cache refresh manually. A permanently blocked message remains visible in diagnostics but does not stop later messages.
4. An ambiguous retry is safe because the gateway enforces idempotency and rejects changed content under the same key.

Normal inbox and pending reads fall back to the local cache when the gateway is unreachable. Cached reads report `source: "cache"`, `stale: true`, and `degraded: true`. When a read requested an unacknowledged filter, cached rows are candidates rather than proof of unread state and report `acknowledgements: "unknown"`. Claims, lease changes, delivery settlement, presence, and read-receipt writes still require the gateway because replaying those operations after a lease or identity change is unsafe.

## CLI

```bash
agent-bridge init --provider local
agent-bridge doctor
agent-bridge status
agent-bridge pending
agent-bridge send --type request --target worker "Run the task"
agent-bridge post --category goal-update --project agent-bridge "Gateway is ready"
agent-bridge inbox --limit 20
agent-bridge sent --limit 20
agent-bridge history --mailbox all --receipt-state any
agent-bridge get --since 24h --unacked-by codex
agent-bridge history --thread-id release-1
agent-bridge acknowledge --ids <message-uuid>
agent-bridge claim --lease-ms 30000
agent-bridge send --target worker --delivery-policy '{"mode":"leased","maxAttempts":3,"retryBaseDelayMs":1000,"retryMaxDelayMs":60000,"retryJitterRatio":0.2}' "work"
agent-bridge deliveries --state dead
agent-bridge delivery-events --delivery-id <uuid>
agent-bridge cancel --delivery-id <uuid>
agent-bridge requeue --delivery-id <uuid>
agent-bridge extend --delivery-id <uuid> --lease-token <uuid>
agent-bridge ack --delivery-id <uuid> --lease-token <uuid>
agent-bridge nack --delivery-id <uuid> --lease-token <uuid> --error "retry later"
agent-bridge join --instance desktop-1 --runtime codex --capability mcp
agent-bridge presence
agent-bridge sync
agent-bridge watch
```

`--project` adds an optional immutable label to a message. It never selects a workspace or changes the active identity. Omit it on reads to include every project and unlabeled messages in the credential-bound workspace. Pass it to `get`, `inbox`, `history`, `pending`, or `watch` for an exact label match. Gateway callers may use `--workspace` only as an assertion. The CLI rejects a mismatch before sending a request. Local mode permits a per-command workspace override. The global legacy Supabase schema has no tenant workspace, so legacy mode fixes workspace to `*` and rejects other `--workspace` values.

History defaults to mailbox `inbox`: broadcasts plus messages targeted to the configured principal, exactly as prior releases did. `sent` selects messages whose source is that principal, and `all` is the union. `--receipt-state any|unread|read` is caller-relative and valid only with `inbox`. The deprecated `--unacked-by` option remains an identity assertion. The CLI rejects a mismatch before opening storage or contacting a gateway. Server surfaces reject it before querying message storage. Cursors bind workspace, principal, mailbox, and normalized filters. Version 1 cursors are temporarily accepted, while all new cursors are version 2.

Publishers set `deliveryPolicy` on the message. Leased policy uses `maxAttempts`, `retryBaseDelayMs`, `retryMaxDelayMs`, `retryJitterRatio`, and optional `notBefore`. Consumers cannot override those values. Consumer-side `maxAttempts` on claim and `retryPolicy` on nack remain validated but ignored for one compatibility release. New code should omit both fields.

The legacy Supabase adapter applies mailbox and receipt rules cooperatively. A holder of the legacy publishable key can bypass the adapter through PostgREST or its receipt RPC. Use the authenticated v2 gateway when the authorization boundary must be enforced.

`agent-bridge pending` is a cheap shell gate for agent startup. It exits 0 when unread candidates or due delivery work are visible, 1 only for an authoritative empty result, and 2 when an empty remote state cannot be confirmed. Its JSON result separates unread context from executable delivery work and labels the state as `available`, `empty`, or `unknown`.

`watch` runs until interrupted unless `--polls` sets an explicit bound. Empty polls use capped backoff and jitter. Gateway and legacy network failures retry when the error is transient. Authentication and validation errors stop the watcher.
Each exact project filter gets its own local watch checkpoint. Switching between a filtered and unfiltered watch cannot advance the other checkpoint.

Unknown flags and missing option values fail before a message can be sent. This prevents a misspelled target flag from becoming a broadcast.

## MCP tools

All providers expose the v1 compatibility tools:

- `post_context`
- `get_context`
- `ack_context`

Local and gateway providers also expose:

- `send`
- `history`
- `claim`
- `extend`
- `acknowledge`
- `negative_acknowledge`
- `list_deliveries`
- `list_delivery_events`
- `cancel_delivery`
- `requeue_delivery`
- `heartbeat`
- `presence`

Legacy Supabase does not advertise delivery or presence tools because its schema cannot enforce those operations.

The acknowledgment names depend on the interface. MCP `ack_context` and CLI `acknowledge` write read receipts. MCP `acknowledge` and CLI `ack` settle claimed deliveries. A receipt never settles delivery work, and delivery settlement never creates a receipt.

## Identity and security

- `~/.agent-bridge/config` contains backend settings only. A stored `AGENT_BRIDGE_AGENT` value is ignored.
- Local clients bind identity through their process environment or an explicit CLI send argument.
- Gateway tokens bind workspace and principal. The API ignores caller-supplied source and workspace fields.
- Gateway clients use separate owner-only backend files and principal-bound tokens.
- The gateway uses `AGENT_BRIDGE_RUNTIME_DATABASE_URL`. Migration and provisioning commands use the separate schema-owner `AGENT_BRIDGE_DATABASE_URL`.
- Remote HTTP must use TLS. Plain HTTP is accepted only on loopback.
- Local config, database, WAL, and shared-memory files use owner-only permissions where the platform supports POSIX modes.
- The private `agent_bridge` schema is denied to Supabase `anon` and `authenticated` Data API roles.
- Expired presence rows are pruned during heartbeat and listing. Each agent is capped at 128 active instances, and each workspace is capped at 4,096.
- Errors expose stable codes without database URLs, tokens, or provider response bodies.
- Delivery work is at least once, not exactly once. Consumers must make external side effects idempotent.

## Legacy Supabase compatibility

Existing deployments can continue using:

```text
AGENT_BRIDGE_PROVIDER=legacy-supabase
AGENT_BRIDGE_URL=https://your-project.supabase.co
AGENT_BRIDGE_KEY=<publishable key>
```

Legacy mode keeps the v1 `shared_context` and `ack_context` RPC behavior. It adds bounded network calls, HTTPS enforcement, UUID mapping across CLI processes, newest-first reads, and the complete compatibility envelope. It cannot provide secure principal binding, delivery leases, presence, or an offline outbox. Use gateway mode for those features.

When gateway migrations run in the same PostgreSQL database as `public.shared_context`, migration 006 imports legacy rows and receipts into the private v2 schema. It preserves valid envelope UUIDs, keeps the existing synthetic UUID mapping for ordinary numeric IDs, assigns deterministic UUIDs to larger IDs, maps projects to workspaces, rejects ID collisions, and verifies the imported count. It does not create executable deliveries for historical targeted rows because an upgrade must not replay old work.

Migration 008 adds the optional project label without changing migration 006. A schema owner can preview correction of migration 006 rows into the canonical `agent-bridge` workspace with `agent-bridge reconcile-legacy-projects`. The command defaults to a dry run. Pass `--apply` to make the change in one transaction. The canonical workspace must already exist. Reconciliation preserves message IDs, timestamps, receipts, and total row counts. It creates no deliveries and is safe to repeat. It refuses changed source data, invalid labels, project or idempotency conflicts, and imported messages that already have a delivery.

The original v1 schema remains in [`sql/setup.sql`](sql/setup.sql). Ordered gateway migrations live in [`sql/migrations/`](sql/migrations/).

## Health and operations

`doctor` and `status` return JSON with:

- Provider and actual schema version.
- Bound workspace, agent, and instance.
- Endpoint or database path.
- Cursor and queue state.
- Pending, claimed, retrying, and dead delivery counts.
- Gateway reachability, outbox depth, blocked outbox rows, cache size, and last sync error.

Local edge health and remote reachability are separate: a healthy offline gateway client reports `localHealthy: true`, `remoteReachable: false`, `connected: false`, and `status: "degraded"` while retaining usable cached reads and queued sends.

The gateway exposes unauthenticated `/readyz`. `/v2/status` and `/metrics` require a valid credential.

Each gateway operation checks the scopes in the canonical registry. `capabilities` needs an active credential but no named scope. For requests with bodies, the gateway validates media type, size, and JSON before it opens the request transaction. It then audits scope denials and applies both a credential-wide token bucket and an operation bucket before domain work begins. Missing policy state or a failed denial audit closes the request with `security_unavailable`. Rate denials return the same rounded delay in `Retry-After` and `error.details.retryAfterSeconds`.

Migration 012 makes PostgreSQL the authority for each production gateway request that passes credential preflight. Node hashes the bearer credential before PostgreSQL receives it. The gateway checks out one connection, opens one explicit transaction, matches the credential ID and hash inside a narrow security-definer function, and derives the workspace, principal, and scopes from current database state. Security accounting and domain work share that transaction and backend; delivery claim, cancel, and requeue reuse it without nested `BEGIN`. Runtime logins cannot read credential hashes, agent records, workspace records, or request-authority records. Production gateway capabilities report `requestAuthority: true` and `rowIsolation: false`: this boundary does not add RLS or claim database row isolation.

Credential replacement links are immutable and stay within one workspace and principal. A replacement grace period can shorten the predecessor's lifetime but cannot extend ordinary expiry or override revocation. Replacement, revocation, scope denial, and rate denial events use explicit append-only columns. They do not store tokens, hashes, authorization headers, request bodies, message content, arbitrary metadata, URLs, IP addresses, or database errors.

Before dropping an Agent Bridge database, remove its gateway login and database-specific runtime role. Run this while connected to that database so `current_database()` still identifies the right role:

```sql
drop role if exists agent_bridge_gateway;
do $cleanup$
declare
  runtime_role text := 'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16);
begin
  execute format('drop role if exists %I', runtime_role);
end
$cleanup$;
```

The runtime role owns no schema objects. PostgreSQL keeps roles after a database is dropped, so skipping this step leaves an unused cluster role behind.

## Development

```bash
npm run typecheck
npm test
npm run build
npm pack
```

Set `AGENT_BRIDGE_TEST_DATABASE_URL` to run the live PostgreSQL contract and migration tests. CI runs Node 22 and 24 on Linux, macOS, and Windows, plus PostgreSQL and clean package-install jobs.

## Documentation

- [ADR-0001](docs/decisions/0001-protocol-layers-and-acknowledgment-semantics.md): protocol layers and acknowledgment semantics.
- [ADR-0002](docs/decisions/0002-canonical-operation-contract-registry.md): canonical contracts, generated artifacts, discovery, and version negotiation.
- [docs/architecture-v2.md](docs/architecture-v2.md): protocol and storage decisions.
- [SKILL.md](SKILL.md): runtime-neutral agent operating instructions.
- [llms.txt](llms.txt): compact machine-readable project map.
- [docs/postmortems/2026-07-08-wrapper-source-drift.md](docs/postmortems/2026-07-08-wrapper-source-drift.md): wrapper and source-identity incident.
- [CLAUDE.md](CLAUDE.md): repository rules, architecture constraints, and documentation ownership.
- [CHANGELOG.md](CHANGELOG.md): released and pending changes.

## License

Apache-2.0
