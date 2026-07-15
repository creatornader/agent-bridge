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
- Canonical portable archives for messages and read receipts across local SQLite and shared PostgreSQL stores.
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
- PostgreSQL 15, 16, 17, or 18 for gateway mode. New PostgreSQL majors fail the
  migration prerequisite and live readiness checks until their catalog digest is
  certified.

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

## Portable archives

Portable archives move one workspace's immutable messages and read receipts between
canonical local SQLite and PostgreSQL stores. Export writes a private file through a
same-directory temporary file, file fsync, atomic publication, and directory fsync.
The export audit completes only after durable publication. A failed export records a
bounded abandonment code. Export and import paths must satisfy the current user's
private-path policy. Export refuses to replace an existing file unless `--force` is
present. Export accepts `--request-id`, embeds it as `exportRequestId` in the archive
header, and returns it on success. Verification and import also return that export
provenance. An import request ID is a separate destination operation identifier.
Reusing an export request ID verifies a completed file or reconciles a matching file
whose audit response was lost. A missing or mismatched file stays started and requires
a new export request ID or owner reconciliation. Recovery artifacts use deterministic
same-directory names derived from the export request ID, so a retry can report and
clean only its own private temporary file or backup. Force replacement keeps that
backup until the new file is durable. Errors report whether publication, backup
cleanup, or audit state is known.

Portable v1 accepts only records in the current Agent Bridge domain. New API writes
use lowercase UUIDs. Archives require lowercase UUIDs and UTC timestamps with six
fractional digits. They do not trim strings, remove duplicates, apply defaults, or
rewrite message content. Export rejects legacy or direct database rows outside these
rules. Recover those rows through native database backup and restore tools.

```bash
install -d -m 700 "$HOME/.agent-bridge/archives"

agent-bridge archive export \
  --provider local \
  --workspace team \
  --request-id 00000000-0000-4000-8000-000000000001 \
  --db "$HOME/.agent-bridge/bridge.sqlite3" \
  --output "$HOME/.agent-bridge/archives/team.ndjson"

agent-bridge archive verify --file "$HOME/.agent-bridge/archives/team.ndjson"

# Import is a rollback-backed dry run unless --apply is explicit.
agent-bridge archive import \
  --provider local \
  --db /path/to/target.sqlite3 \
  --file "$HOME/.agent-bridge/archives/team.ndjson" \
  --workspace team \
  --dry-run

agent-bridge archive import \
  --provider local \
  --db /path/to/target.sqlite3 \
  --file "$HOME/.agent-bridge/archives/team.ndjson" \
  --workspace team \
  --request-id 00000000-0000-4000-8000-000000000001 \
  --apply
```

Local commands use `--db`, `AGENT_BRIDGE_DB`, the selected shared config, or the
canonical local database path, in that order. PostgreSQL commands accept database
authority only from `AGENT_BRIDGE_ARCHIVE_DATABASE_URL` and require a login registered
for the archive boundary created by the current migrations. They do not fall back to
the schema-owner, gateway runtime, owner-control, or client database settings.

The archive digest detects accidental changes to the canonical bytes. It is neither
encryption nor authentication. Archives contain message content and routing metadata,
so protect them as private data. They exclude deliveries, delivery events, presence,
credentials, owner-control records, security events, and other control or security
state. The library API is available from `@creatornader/agent-bridge/archive`.
Import opens the archive once without following links. It verifies the file, replays
messages, then replays receipts through the same descriptor. Every pass checks framing,
order, counts, and the client-computed digest. Batches are limited by row count and a
4 MiB byte budget. `--dry-run` and `--apply` are mutually exclusive.

## Native disaster recovery

Native DR preserves one complete local authority or shared PostgreSQL deployment. Use
it for recovery, not for moving a workspace between providers. The framed `.abdr`
bundle records its provider, schema contract, and entry hashes. Commands calculate and
return a separate whole-file SHA-256 digest. The hashes detect changed bytes. The bundle
is not encrypted or authenticated, and it may contain credentials and message content.
Store and transfer it as private database material.

Local backup uses SQLite's online backup API, so the source may remain open. It accepts
only the local authority database. Gateway edge caches and outboxes are rejected because
PostgreSQL remains their authority. Restore requires a new target path and verifies the
exact local schema contract before publication.

```bash
agent-bridge dr backup \
  --provider local \
  --source "$HOME/.agent-bridge/bridge.sqlite3" \
  --output "$HOME/.agent-bridge/archives/local.abdr" \
  --backup-id 00000000-0000-4000-8000-000000000010

agent-bridge dr verify \
  --provider local \
  --bundle "$HOME/.agent-bridge/archives/local.abdr"

agent-bridge dr restore \
  --provider local \
  --bundle "$HOME/.agent-bridge/archives/local.abdr" \
  --target /path/to/new-bridge.sqlite3 \
  --request-id 00000000-0000-4000-8000-000000000011
```

PostgreSQL backup takes a repeatable-read snapshot while holding the native DR fence.
It stores the `agent_bridge` schema dump plus a canonical inventory of required roles,
memberships, and default privileges. The backup excludes transient data from agent
instances, rate-limit buckets, request authority, and archive transaction authority.
Restore turns claimed deliveries into immediately retryable work because a database
restore cannot preserve a live lease.

PostgreSQL authority comes only from the process environment. Backup reads
`AGENT_BRIDGE_DR_SOURCE_DATABASE_URL`; restore reads
`AGENT_BRIDGE_DR_TARGET_DATABASE_URL`. URLs are not accepted as command arguments.
`pg_dump` and `pg_restore` must match the database major exactly. Native DR supports
PostgreSQL 15 through 18. If matching tools are not on `PATH`, pass their directory to
PostgreSQL backup, verify, or restore with `--tool-directory`. Local verification does
not use PostgreSQL tools and rejects that option.

```bash
AGENT_BRIDGE_DR_SOURCE_DATABASE_URL='postgresql://backup-admin@db/agent_bridge' \
  agent-bridge dr backup \
    --provider postgres \
    --output "$HOME/.agent-bridge/archives/postgres.abdr" \
    --backup-id 00000000-0000-4000-8000-000000000020

agent-bridge dr verify \
  --provider postgres \
  --bundle "$HOME/.agent-bridge/archives/postgres.abdr"

AGENT_BRIDGE_DR_TARGET_DATABASE_URL='postgresql://restore-admin@new-db/agent_bridge' \
  agent-bridge dr restore \
    --provider postgres \
    --bundle "$HOME/.agent-bridge/archives/postgres.abdr" \
    --request-id 00000000-0000-4000-8000-000000000021 \
    --accept-source-sql-risk
```

PostgreSQL restore executes SQL from the dump, so use `--accept-source-sql-risk` only
for a bundle from a source you trust. The target must be a dedicated fresh database
with the same database name and PostgreSQL major as the backup. Restore requires a
superuser because it recreates object owners, role shells, memberships, and default
privileges. It never enables login on restored external principals. If a restore fails
after mutation begins, Agent Bridge disables new target connections and reports any
residual roles or recovery paths. Inspect and clean those artifacts before retrying.
Never run the source and restored target as active authorities at the same time.

Backup publication never replaces an existing output. Deterministic adjacent staging
paths use the backup or request UUID. A retry with the same UUID reports retained
recovery paths instead of overwriting them. File and directory synchronization is
strongest on platforms that support directory fsync; Windows cannot provide the same
directory durability proof. Successful Windows commands report
`directoryDurability: "unavailable"` or
`cleanupDirectoryDurability: "unavailable"` instead of claiming that proof. The
library API is available from
`@creatornader/agent-bridge/dr`.

## Install client integrations

Agent identity and gateway credentials belong to each client process, not the shared `~/.agent-bridge/config` file.

```bash
agent-bridge clients install codex --identity codex
agent-bridge clients install claude-code --identity claude-code
agent-bridge clients install claude-desktop --identity claude-desktop
```

For gateway mode, use the owner enrollment workflow below for new credentials. The
older token handoff remains available for credentials issued by external tooling:

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

Migration 014 provides the database owner control plane. The schema-owner connection
registers provisioning and inventory logins with `register_control_member`. It can
remove them with `revoke_control_member`. Do not grant the database-specific operator,
auditor, or owner roles directly. Operators call the narrow
`control_provision`, `control_rotate_credential`, and `control_revoke_credential`
functions with a fresh request UUID. Operators and auditors can call
`control_credential_inventory`; it never exposes credential digest material. Inventory
accepts an optional workspace, an optional `(created_at, credential_id)` cursor, and
a row limit. The default is 100 rows and the maximum is 1,000.

Each mutation takes a transaction lock for its request UUID before checking the
request ledger. An identical concurrent call returns the stored result. Reusing the
UUID with changed content fails. Provisioning reuses an existing workspace only when
its name matches, so one workspace can contain several principals. Rotation supports
credentials without an expiry and a null grace cutoff for immediate replacement. A
rotation request includes the expected workspace and principal. The function checks
both while it locks the predecessor, then returns the stored canonical identity.
The database derives the audit actor from `session_user`.

This temporary operator workflow creates an eligible login and registers it through
the protected SQL boundary. The owner CLI then provisions a token-bound `codex`
principal. It generates the raw token locally, writes it to a private enrollment file
before contacting PostgreSQL, and sends only the SHA-256 hash to the database.

```bash
OPERATOR_LOGIN="agent_bridge_operator_$(date +%s)"
OPERATOR_PASSWORD="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
MEMBERSHIP_REQUEST="$(node -e "process.stdout.write(require('node:crypto').randomUUID())")"
PROVISION_REQUEST="$(node -e "process.stdout.write(require('node:crypto').randomUUID())")"
export AGENT_BRIDGE_OPERATOR_LOGIN="$OPERATOR_LOGIN"
export AGENT_BRIDGE_OPERATOR_PASSWORD="$OPERATOR_PASSWORD"
export AGENT_BRIDGE_MEMBERSHIP_REQUEST="$MEMBERSHIP_REQUEST"
export AGENT_BRIDGE_PROVISION_REQUEST="$PROVISION_REQUEST"

psql -v ON_ERROR_STOP=1 "$AGENT_BRIDGE_DATABASE_URL" <<'SQL'
\getenv operator_login AGENT_BRIDGE_OPERATOR_LOGIN
\getenv operator_password AGENT_BRIDGE_OPERATOR_PASSWORD
\getenv membership_request AGENT_BRIDGE_MEMBERSHIP_REQUEST
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L',
  :'operator_login',
  :'operator_password'
) \gexec
SELECT * FROM agent_bridge.register_control_member(
  :'membership_request'::uuid,
  :'operator_login'::name,
  'operator'
);
SQL

export AGENT_BRIDGE_OPERATOR_DATABASE_URL="postgresql://${OPERATOR_LOGIN}:${OPERATOR_PASSWORD}@host/database"
export AGENT_BRIDGE_URL="https://bridge.example.com"
ENROLLMENT_FILE="${AGENT_BRIDGE_ENROLLMENT_DIR:-$HOME/.agent-bridge/enrollments}/${PROVISION_REQUEST}.json"

agent-bridge owner provision \
  --request-id "$PROVISION_REQUEST" \
  --workspace team \
  --workspace-name Team \
  --identity codex \
  --runtime codex \
  --instance codex-machine \
  --scope-set release-a-full

agent-bridge clients install codex --enrollment-file "$ENROLLMENT_FILE"

REVOKE_REQUEST="$(node -e "process.stdout.write(require('node:crypto').randomUUID())")"
export AGENT_BRIDGE_REVOKE_REQUEST="$REVOKE_REQUEST"
psql -v ON_ERROR_STOP=1 "$AGENT_BRIDGE_DATABASE_URL" <<'SQL'
\getenv operator_login AGENT_BRIDGE_OPERATOR_LOGIN
\getenv revoke_request AGENT_BRIDGE_REVOKE_REQUEST
SELECT * FROM agent_bridge.revoke_control_member(
  :'revoke_request'::uuid,
  :'operator_login'::name,
  'operator'
);
SELECT format('DROP ROLE %I', :'operator_login') \gexec
SQL
unset OPERATOR_PASSWORD AGENT_BRIDGE_OPERATOR_PASSWORD
unset AGENT_BRIDGE_OPERATOR_LOGIN AGENT_BRIDGE_MEMBERSHIP_REQUEST
unset AGENT_BRIDGE_PROVISION_REQUEST AGENT_BRIDGE_REVOKE_REQUEST
unset AGENT_BRIDGE_OPERATOR_DATABASE_URL
```

`AGENT_BRIDGE_OPERATOR_DATABASE_URL` is the owner CLI's only database authority. It
does not fall back to the schema migration URL, runtime URL, shared client config, or
active client identity. `owner inventory` returns at most 100 rows by default and
1,000 when requested. Its opaque cursor is bound to the selected workspace.

Provision and rotation enrollment files stay under
`$AGENT_BRIDGE_ENROLLMENT_DIR` or `~/.agent-bridge/enrollments`. The CLI requires an
owner-only root and private path components. It refuses symlinks, path escapes, and
directory replacement during an operation. Every file has a monotonic revision. A
per-file exclusive lock covers the read, state transition, database call, and client
installation side effects. Each transition compares the revision, state, request,
operation, and token with the current file before atomic replacement.

If provisioning fails, rerun the same operation with `--resume "$ENROLLMENT_FILE"`.
A process crash can leave the adjacent lock file behind. Do not delete it manually.
After at least 60 seconds, use `--recover-lock` with `--resume` or the client install
command. Recovery succeeds only when the lock belongs to this host and user and its
recorded process no longer exists. The stored request UUID, inputs, instance, and raw
token are reused exactly.

`clients install <runtime> --enrollment-file <path>` derives the gateway URL,
workspace, principal, instance, and token from the file. It rejects conflicting flags
or environment values. Provisioning registers the host MCP server. Rotation updates
only that instance's existing private backend file and never repeats host registration.
The backend must contain the predecessor credential ID, principal, and instance metadata
written by an enrollment-based provision. Rotation fails closed for older backend files
without this metadata. It also verifies the exact live MCP registration before replacing
the token.
The installer removes the enrollment file only after installation succeeds. A failed
delete returns `enrollmentStatus: "consumed-file-retained"` and the consumed file path.
An already missing file returns `consumed-file-missing`. If unlink succeeds but the
directory identity check or fsync fails, the result is
`consumed-deletion-durability-unknown`; it never claims that the path was retained.
`lockReleaseStatus` separately reports `released`, `retained`, or `durability-unknown`.
A lock-release failure after successful installation does not replace the installation
result with a generic error. The consumed artifact no longer contains the raw token. A retry validates the
live backend and MCP registration before deleting a retained consumed file.

`--token` and `AGENT_BRIDGE_CLIENT_TOKEN` remain available for the older manual
installation flow, but they cannot be combined with `--enrollment-file`. The final SQL
block revokes and drops the temporary operator after the client installation has
stored the credential.

Rotate the credential for one installed instance with an explicit grace cutoff or
`--invalidate-immediately`, then consume the resulting enrollment file:

```bash
ROTATE_REQUEST="$(node -e "process.stdout.write(require('node:crypto').randomUUID())")"
ROTATION_FILE="${AGENT_BRIDGE_ENROLLMENT_DIR:-$HOME/.agent-bridge/enrollments}/${ROTATE_REQUEST}.json"
agent-bridge owner rotate \
  --request-id "$ROTATE_REQUEST" \
  --credential-id "<current credential UUID>" \
  --workspace team \
  --identity codex \
  --runtime codex \
  --instance codex-machine \
  --scope-set release-a-full \
  --invalidate-immediately
agent-bridge clients install codex --enrollment-file "$ROTATION_FILE"
```

Control membership is an offline SQL administration boundary. The gateway and MCP
server do not expose it. Runtime readiness compares PostgreSQL membership with the
append-only registry. It fails for an unregistered operator or auditor, an external
owner holder, a missing registered grant, any extra role inherited by a registered
member, or any role that inherits a registered member. Protected operations recheck
the live registry and direct membership after taking a member-global transaction lock,
followed by capability locks in operator-before-auditor order. Registration and
revocation use the same order. A stale session that remains in a revoked role cannot
continue operating. The schema owner is the only bootstrap holder of all three control
roles and the only role with ordinary execution authority on the registration
functions. PostgreSQL superusers remain inside this trusted database-administration
boundary. Readiness checks the running PostgreSQL major on every call, so upgrading an
already-migrated database to an uncertified major disables the runtime.

Direct credential inserts default to empty scopes rather than full access. Issued
identity, scope, label, expiry, and lineage fields cannot be edited directly. Existing
migration-013 rows retain their values and remain revocable during upgrade. Runtime
readiness compares the live owner-control catalog with the protected migration-014
attestation. Migration 014 refuses to create that baseline if critical workspace,
agent, credential, index, trigger, function, ownership, or row-isolation dependencies
have already drifted. Unrelated additive schema objects do not change readiness.
The migration also blocks unsafe direct and default privileges on protected objects.
Global and workspace inventory use fixed-origin expression indexes for their keyset
ordering.

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

These shared settings are enough before `clients install`. The secure flow reads
the principal-bound token and exact client settings from an enrollment file. The
compatibility flow accepts `AGENT_BRIDGE_CLIENT_TOKEN`. Both write a private client
backend and register `AGENT_BRIDGE_AGENT`, `AGENT_BRIDGE_INSTANCE`, and that file's
path with the host. Gateway initialization checks readiness, token validity, and that
the token-bound principal matches that process identity.

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

`status` is a passive snapshot. It does not synchronize or probe a remote provider. An unprobed remote reports `status: "unknown"`, `connected: false`, and `remoteReachable: null`. Passive status still exits 0. `doctor` evaluates named checks and exits 0 for `ok`, 2 for `degraded`, and 1 for `failed`. Both return JSON with:

- Provider and actual schema version.
- Bound workspace, agent, and instance.
- Endpoint or database path.
- Cursor and queue state.
- Pending, claimed, retrying, and dead delivery counts, plus due versus scheduled work, expired leases, oldest-due time, and bounded queue lag.
- Gateway reachability, outbox due/scheduled/leased/blocked depth, cache size, blocked age/attempt/error, next retry, last outbound/inbound sync, and last attempt.
- Explicit check results. Blocked outbox rows, expired leases, dead deliveries, or a known-unreachable gateway prevent a healthy result.

Local edge health and remote reachability are separate. A healthy offline gateway client after a doctor probe reports `localHealthy: true`, `remoteReachable: false`, `connected: false`, and `status: "degraded"` while retaining usable cached reads and queued sends. Fatal local edge errors report `localHealthy: false` without hiding the queue snapshot. Blocked age is null for rows created by an older client before transition timestamps existed.

Client-local outbox and synchronization fields appear only in CLI status output. Authenticated HTTP `/v2/status` reports gateway delivery diagnostics and does not advertise client-local state.

In-process `SyncingBridgeStore` diagnostics also expose the current loop state and a sanitized loop error. Standalone CLI health commands omit those fields because their short-lived diagnostic runtime is not the long-lived MCP client.

The gateway exposes unauthenticated `/readyz`. `/v2/status` and `/metrics` require a valid credential.

Each gateway operation checks the scopes in the canonical registry. `capabilities` needs an active credential but no named scope. For requests with bodies, the gateway validates media type, size, and JSON before it opens the request transaction. It then audits scope denials and applies both a credential-wide token bucket and an operation bucket before domain work begins. Missing policy state or a failed denial audit closes the request with `security_unavailable`. Rate denials return the same rounded delay in `Retry-After` and `error.details.retryAfterSeconds`.

Migration 012 makes PostgreSQL the authority for each production gateway request that passes credential preflight. Node hashes the bearer credential before PostgreSQL receives it. The gateway checks out one connection, opens one explicit transaction, matches the credential ID and hash inside a narrow security-definer function, and derives the workspace, principal, and scopes from current database state. Security accounting and domain work share that transaction and backend. Delivery claim, cancel, and requeue reuse it without nested `BEGIN`. Runtime logins cannot read credential hashes, agent records, workspace records, or request-authority records.

Migration 013 enables and forces row-level security on messages, receipts, deliveries, delivery events, and presence. Policies read workspace and principal from the transaction-bound request authority. The runtime role cannot set that authority through session variables, inherit a table-owner role, or bypass RLS. Separate no-login roles own domain tables, read request context, and write delivery audit events. Delivery identity and publisher bindings are immutable. A trigger lets recipients perform recipient lifecycle actions and reserves cancel and requeue for publishers.

The migration records a catalog attestation after it creates the policies, constraints, triggers, and security functions. `/readyz` fails if the current catalog no longer matches that owner-created baseline. Gateway capabilities report `rowIsolation: true` only when request authority is enabled and the migration, catalog attestation, ownership, policy, privilege, and function checks all pass. An owner-approved schema change must update the attestation in its migration.

RLS does not replace operation checks. The service still enforces lease tokens, valid state transitions, and target-to-delivery membership. The database binds each delivery to its publisher and message, but it does not prove that the recipient appears in the message target list. PostgreSQL superusers and roles with `BYPASSRLS` remain outside this boundary; do not use either for the gateway login.

Credential replacement links are immutable and stay within one workspace and principal. A replacement grace period can shorten the predecessor's lifetime but cannot extend ordinary expiry or override revocation. Replacement, revocation, scope denial, and rate denial events use explicit append-only columns. They do not store tokens, hashes, authorization headers, request bodies, message content, arbitrary metadata, URLs, IP addresses, or database errors.

Before dropping an Agent Bridge database, remove its gateway login and database-specific runtime role. Run this while connected to that database so `current_database()` still identifies the right role:

```sql
drop role if exists agent_bridge_gateway;
do $cleanup$
declare
  suffix text := substr(md5(current_database()), 1, 16);
  role_name text;
begin
  foreach role_name in array array[
    'agent_bridge_runtime_' || suffix,
    'agent_bridge_data_owner_' || suffix,
    'agent_bridge_context_reader_' || suffix,
    'agent_bridge_event_writer_' || suffix
  ] loop
    if exists (select 1 from pg_roles where rolname=role_name) then
      execute format('reassign owned by %I to %I', role_name, current_user);
      execute format('drop owned by %I', role_name);
      execute format('drop role %I', role_name);
    end if;
  end loop;
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

Set `AGENT_BRIDGE_TEST_DATABASE_URL` to run the live PostgreSQL contract and migration
tests. CI runs Node 22 and 24 on Linux, macOS, and Windows. PostgreSQL 15 through 18 each
pack and install the npm tarball, register a least-privilege operator, and exercise
owner provision, inventory, rotation, and revocation. Enrollment roots, components,
files, locks, and persistent credential backends require the current Windows SID as
owner before the code applies or accepts a protected current-user-only DACL. Node file
identity checks and native Windows reparse attributes must also agree before and after
policy validation; symlinks, junctions, and other reparse objects fail closed. Windows
CI covers static and fault behavior for this policy. Native Windows ACL race and
durability behavior has not yet been proved on a dedicated Windows host.

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
