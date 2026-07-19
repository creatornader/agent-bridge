# Agent Bridge v2 architecture

Status: living architecture. Version 0.3.1 was released on July 15, 2026.

## Product boundary

Agent Bridge is the durable, pull-first mailbox and work-delivery control plane for agents that run in different clients, processes, sessions, and machines. It supports three operating modes: local SQLite, the authenticated PostgreSQL gateway, and the legacy Supabase adapter.

History visibility is caller-relative. `inbox` is the default and preserves broadcast-plus-targeted visibility; `sent` is source equal to the caller; `all` is their union. Receipt state (`any`, `unread`, `read`) is valid only for inbox and is always evaluated for the authenticated caller. Opaque v2 cursors bind workspace, caller, mailbox, and normalized filters. Readers temporarily accept v1 sequence cursors but emit only v2. After an edge cache contract upgrade, the gateway resets the authoritative pull cursor and replays `all` visibility; the publication outbox is never treated as sent history.

These authorization guarantees apply to local v2 and the authenticated gateway. The legacy Supabase adapter can enforce them only cooperatively because its publishable key can call the underlying PostgREST table and receipt RPC directly.

- Local mode runs without an account or network connection.
- Shared mode uses a remote service so agents on different machines see the same history and delivery state.

The protocol must support informational context and executable work without treating them as the same thing. A2A and application task semantics sit above Agent Bridge. MCP, CLI, HTTPS, and the Node library are access surfaces. Agent harnesses and host applications use those surfaces through host adapters or direct integration. Optional transports may sit below the core, but they cannot replace authoritative cursor replay or durable delivery state.

[ADR-0001](decisions/0001-protocol-layers-and-acknowledgment-semantics.md) defines these layers and the distinct meanings of receipts, claims, leases, delivery settlement, and external task completion.

[ADR-0002](decisions/0002-canonical-operation-contract-registry.md) defines the canonical cross-surface operation contract, deterministic artifacts, capability discovery, and protocol negotiation.

[ADR-0003](decisions/0003-host-adapters-and-consumer-instance-keys.md) separates harnesses, hosts, adapters, and access surfaces and defines the consumer instance-key contract.

## Decisions

### PostgreSQL is the shared source of truth

PostgreSQL stores shared messages, identities, receipts, deliveries, and migration state. Supabase remains a supported managed PostgreSQL provider, but clients do not depend on Supabase-specific behavior.

A standalone Agent Bridge API sits between remote clients and PostgreSQL. Clients authenticate to the API with scoped credentials. They do not receive a database password or rely on a shared Supabase publishable key for identity.

Supabase can still host the database. Existing direct PostgREST deployments remain available through an explicitly named legacy adapter while they migrate.

### Deployment separates schema and request authority

The schema-owner connection runs migrations as an explicit one-shot operation. A
separate bootstrap step creates or updates a restricted runtime login and grants only
the database-derived runtime role. The gateway starts only after both steps succeed and
receives no schema-owner authority. Its readiness check fails on an incomplete
migration plan, unsupported PostgreSQL major, row-isolation drift, protected catalog
drift, or an invalid owner-control membership graph.

The repository Compose stack publishes the gateway and PostgreSQL on loopback for
development. Production deployments put PostgreSQL on a private network, terminate TLS
before every non-loopback gateway, and source credentials from the platform's secret
manager. A persistent volume is runtime storage, not a backup.

Upgrade order is database backup, migration, runtime bootstrap, readiness, then client
or gateway rollout. Because an older image may reject the newer migration plan, schema
rollback cannot rely on starting the previous container image. Operators apply a
forward fix or restore a verified native DR bundle into a fresh target before switching
authority. [The deployment guide](deployment.md) records the operational procedure.

### SQLite is local storage

SQLite WAL provides local-only operation, a durable outbox, an inbox cache, cursor state, and a cheap pending-work check. Outbox writes use `synchronous=FULL`. It is not the canonical multi-machine database.

The gateway outbox queues immutable message publication. Receipt and lease mutations still require the remote authority because replaying them after ownership or identity changes can settle the wrong work.

Long-lived gateway MCP clients own a cancellable transport loop that replays publications and refreshes the inbox cache with bounded exponential backoff. It is transport maintenance, not agent monitoring. Manual MCP and CLI sync use the same replay path. A publication timeout after the gateway may have committed remains queued under its stable idempotency key. A retry resolves to the original immutable message instead of publishing a duplicate.

Local initialization must be idempotent. Concurrent initialization and schema upgrade
use a 15-second minimum busy-retry window. Normal database operations retain the
configured timeout. The minimum supported SQLite build must include the WAL-reset
corruption fix. Node 22.23.1 on the current development machine embeds SQLite 3.51.3,
which includes that fix.

### Portable archives cross storage engines without copying runtime state

A portable archive is a canonical NDJSON snapshot of one workspace's immutable
messages and read receipts. Export takes a consistent store snapshot. Verification
checks strict framing, canonical JSON, record order, counts, and the SHA-256 digest.
Import opens one private, regular archive file without following links. It performs a
format pass, a message pass, and a receipt pass through the same descriptor. Each pass
recomputes framing, order, counts, and the client-computed digest. Message and receipt
batches have row limits and a 4 MiB byte budget. Import runs as a rollback-backed dry
run unless the operator passes `--apply`; `--dry-run` and `--apply` are mutually
exclusive. Replaying identical records is idempotent. Conflicting message or receipt
content fails the import.

The portable format excludes deliveries, delivery events, presence, credentials,
owner-control state, security events, migration records, and edge synchronization
state. Those records have different authority and recovery semantics. The digest
detects changed bytes. It provides neither encryption nor authentication, so operators
must protect the archive as message data and use a separate trusted transfer channel.

Archive administration stays outside MCP, HTTPS, and the canonical operation registry.
Local commands open only a canonical local Agent Bridge database. PostgreSQL commands
use a separate restricted archive login supplied only through
`AGENT_BRIDGE_ARCHIVE_DATABASE_URL`. Export holds one store snapshot while it streams
canonical records and an incremental digest to a private temporary file. It fsyncs the
file, publishes without replacement unless `--force` is explicit, verifies the private
path, and fsyncs the directory. Only then does it complete the database audit. A
publication failure abandons the operation with a bounded code. The footer digest is
client-verified and caller-attested. It is not independent server proof.

Every export has a caller-visible request ID. The canonical header stores it as
`exportRequestId`, and the digest binds that header to the archive. Verification and
import return the same provenance. The request ID for an import operation remains a
separate destination-side identifier. An exact completed export retry verifies the
private file against the terminal export request ID, workspace, digest, and counts. A
retry of a started export never streams a new snapshot or force-replaces the file. It
verifies the retained file and uses the separate reconciliation operation, or leaves
the request started when the file is missing or mismatched. Temporary and backup paths
are deterministic same-directory names derived from `exportRequestId`. Force
replacement first makes a durable private hard-link backup. A pre-durable failure
restores and fsyncs the original before abandonment. An unproved restore, retained
artifact, or lost audit response returns its path and state without claiming a clean
failure. Reconciliation proves durability through the file descriptor that performed
verification and checks pathname identity around file and directory synchronization.

Portable v1 carries only records that satisfy the current message domain. New API
writes use lowercase UUIDs. Archive UUIDs must be lowercase, and archive timestamps
use UTC with six fractional digits. The archive path does not trim, deduplicate,
default, or rewrite message content. A legacy or direct database row outside this
domain fails export and requires native database recovery.

### Native DR preserves one storage authority

Native disaster recovery is separate from portable workspace archives. A native DR
bundle preserves one full local SQLite authority or the shared PostgreSQL authority in
its native schema. It does not translate between providers. Gateway edge SQLite files
are excluded because they contain a replayable outbox and cache, not the shared source
of truth.

The common framed format has a canonical manifest, provider-specific entries, and
per-entry SHA-256 hashes. Commands calculate and return a separate whole-bundle hash.
Readers validate strict framing, size bounds, entry order, provider kind, and exact
schema metadata. The hashes detect changed bytes but do not authenticate or encrypt
the backup. Paths must pass the private-path
policy. Publication uses an exclusive adjacent file, file synchronization, a no-replace
hard link, post-publication verification, and directory synchronization where the
platform supports it. Deterministic stage names include the operation UUID. Existing
stages fail closed and are returned as recovery paths. Node cannot prove parent-directory
entry synchronization on Windows. Successful Windows results report that directory
durability as unavailable while still requiring file-content synchronization and
post-publication verification.

Local backup accepts only a current or upgradeable local-authority SQLite database. It
uses the online backup API in a worker with a hard deadline, then verifies health and
the exact schema contract before framing the snapshot. Restore extracts through one
exclusive descriptor, verifies the contract, and publishes only to a new target. Edge
cache and legacy edge files are rejected. Worker termination that cannot be proved is
reported with the possible residue instead of being treated as a clean timeout.

PostgreSQL backup takes a repeatable-read exported snapshot while holding the native DR
advisory fence. `pg_dump` captures only the `agent_bridge` schema. A separate canonical
role inventory records the bounded role shells, membership options, and global or
schema-scoped default ACLs that a schema-only dump omits. The dump excludes data for
agent instances, rate-limit buckets, request authorities, endpoint-migration challenge
rows, and archive transaction authorizations. The manifest binds migration
inventory, table counts, claimed-delivery count, tool major, role inventory, and the
security, row-isolation, owner-control, and portable-archive readiness definitions.

The immutable gateway authority UUID is ordinary PostgreSQL data, so native backup and
restore preserve it. The UUID proves that a restored target represents the same logical
authority. It does not fence a live clone. Operators must still keep the source and
restored target from serving traffic at the same time.

PostgreSQL restore requires a dedicated fresh database, the same database name and
server major, an exact-major `pg_restore`, and superuser authority. It restores role
shells as `NOLOGIN`, then schema objects, memberships, and default privileges. Claimed
deliveries become retrying deliveries with cleared leases. The restore checks migrations,
counts, role inventory, and every readiness attestation before success. External
principals remain `NOLOGIN`. A failure after target mutation begins disables new target
connections. If that offlining step fails, the command reports the target as unsafe and
lists residual role shells.

PostgreSQL source and target URLs come only from
`AGENT_BRIDGE_DR_SOURCE_DATABASE_URL` and
`AGENT_BRIDGE_DR_TARGET_DATABASE_URL`. Restore requires explicit acceptance that a
trusted PostgreSQL dump contains executable SQL. Source and restored target must never
run concurrently as authorities. Native DR supports PostgreSQL 15 through 18
and rejects a tool or server major mismatch.

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

A publisher stores an immutable `deliveryPolicy` with each message. Untargeted messages default to mailbox mode. Targeted messages default to leased mode with `maxAttempts: 5`, `retryBaseDelayMs: 1000`, `retryMaxDelayMs: 60000`, and `retryJitterRatio: 0.2`. Leased policy may also set `notBefore`. Mailbox messages create no deliveries, and legacy mode rejects leased policy.

A leased delivery records executable work for a recipient. Its state is one of `pending`, `claimed`, `acked`, `retrying`, `dead`, or `cancelled`. `attempt` is lifetime-monotonic, while `cycleAttempt` resets on publisher requeue and `requeueCount` increments. Stored policy owns retry and exhaustion. Claims order due work by urgent, high, then info priority, followed by availability, message creation time, and the stable delivery ID tie-break.

Consumer-side `maxAttempts` on claim and `retryPolicy` on nack are compatibility inputs for one release. The service validates them and ignores them. This keeps older clients working without letting a consumer change immutable publisher intent.

Migration 010 uses `nack_retry` as a conservative compatibility mapping for a legacy `claimed` to `retrying` event. In v0.2 the same stored transition could come from an explicit nack or lease-expiry recovery, so the migrated action describes the retry transition and does not prove which cause produced it. When a legacy settlement event has no lease owner, migration recovers its actor from the preceding claim for the same delivery attempt.

A receipt does not change delivery state. A claim or settlement does not create a receipt. Lease renewal proves only that the current owner retained its claim. External task completion belongs to A2A or the application layer and must be recorded separately when a workflow needs both task state and delivery settlement.

Each delivery transition also appends an audit event. Instance presence uses a separate leased record keyed by workspace, principal, and caller-supplied instance key. Presence requires that key and can carry a host or harness type and declared capabilities. Supported installers generate and persist a stable key for each installed client. Direct clients that use presence must provide a stable key for each intended consumer. Processes that share a key also share its presence row. The gateway does not bind the key to an installer registration, and the row does not identify a unique live process or PID. Expired rows are pruned during normal presence operations. Each principal is limited to 128 active instance keys, and each workspace is limited to 4,096.

The system promises at-least-once delivery. It does not promise exactly-once execution. Idempotency keys prevent duplicate insertion, and consumers must make side effects idempotent.

Project participates in the idempotency fingerprint. Reads without a project filter span labeled and unlabeled messages inside the credential-bound workspace. An exact filter narrows that same cursor authority. Migration 008 adds the PostgreSQL column and index. Existing local and edge SQLite databases add their project columns during initialization. Migration 006 is not rewritten. A schema-owner command dry-runs or reconciles its rows into workspace `agent-bridge` in one transaction. It preserves IDs, timestamps, receipts, and row counts, and it verifies that no delivery exists before or after the change.

The legacy Supabase schema has no tenant workspace column. Its adapter reports workspace `*` and uses the legacy `project` column only as a message label. It rejects per-command workspace overrides because assigning a caller-selected workspace to global rows would create a false isolation boundary.

The delivery API supports:

- Atomic claim with row locking.
- Publisher-only cancel and dead/cancelled requeue, both fencing prior leases. Publisher and recipient can page deliveries and audit events; unrelated callers learn no existence information.
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
- Host adapter and harness type.
- Consumer instance key.
- Live process identity, which the released protocol does not represent separately.
- Session or thread context.
- Optional role.
- Authentication subject and credential.

Remote credentials bind the workspace and principal. Each installed client gets a separate owner-only backend file containing only its bound token and backend settings. The shared config does not hold a gateway token. A client cannot claim another source label. Local mode binds identity through its process configuration. `AGENT_BRIDGE_AGENT` remains the compatibility field for MCP and CLI clients.

`AGENT_BRIDGE_INSTANCE` is an optional caller-supplied stable consumer key. Unless
`AGENT_BRIDGE_CURSOR` sets an explicit path, the instance key selects cursor storage.
The key also selects delivery lease ownership and instance presence. Supported
installers generate and persist it; direct clients may manage it themselves. When the
key and explicit cursor path are both omitted, cursor storage uses the `default` path
component. Delivery lease ownership falls back to the principal, and presence is
unavailable. The gateway does not treat the key as registered authority. It is not a
PID, conversation, or session identifier. A future per-process presence feature must
add a separate identity instead of changing the meaning of `instance` and invalidating
existing cursor or lease ownership.

### The core is provider-neutral

Protocol logic depends on a `BridgeStore` interface, not a provider SDK. The initial stores are:

- SQLite for local mode and edge state.
- PostgreSQL for a standalone shared deployment.
- Supabase legacy REST for v1 compatibility during migration.
- Agent Bridge HTTP API for normal remote clients.

Host and wakeup adapters are independent from storage. A client manifest declares identity injection, supported wake modes, config locations, health checks, and install actions for Codex, Claude Code, Claude Desktop, OpenClaw, or a generic MCP client. The v1 manifest key named `runtime` identifies an installation target for compatibility. It does not identify a unique running process. The `codex` adapter configures the profile shared by the Codex CLI and the Codex surface in the ChatGPT desktop app. Scripts, CI jobs, daemons, and application services may instead call the CLI or HTTPS API or embed the Node library without pretending to be a harness adapter.

Client lifecycle ownership is separate from registration existence. Local inspection
classifies a requested Codex, Claude Code, or Claude Desktop contract as absent,
unmanaged, managed, or drifted by comparing the exact identity, stable instance key,
backend path, scope, launch contract, and nonsecret registration locator. Desktop
locators name the normalized host config, Codex locators name the active profile
config, and Claude Code local or project locators include the invocation directory
because the native CLI exposes no stronger target. Adoption is plan-first and writes
only owner-private, credential-free metadata when `--apply` is explicit and the
unmanaged registration is exact. Backend files and their immediate parents must pass
the owner-only no-link policy. Codex JSON comparisons ignore diagnostic/status fields
and property order but require exactly the three Agent Bridge environment keys;
Claude Code connectivity status is not registration state. Claude Desktop inspection
shares the installer's validated absolute launch resolver. Applied adoption
re-inspects its postcondition. It does not read backend values or mutate the
registration.
Enrollment-based first-time provisioning retains strict registration and backend-file
collision refusal. See
[ADR 0004](decisions/0004-client-lifecycle-and-endpoint-migration.md).

Managed-client repair, update, and uninstall use a local crash-safe substrate. Strict
owner-private metadata is the mutation authority. Runtime plus stable instance locate
the metadata, and identity must match both the record and the immutable repair or
update request. Uninstall also binds the identity. Repair restores its launch contract. Update validates a new launch
before it creates the journal and stores only the identity, normalized command,
arguments, scope, and fixed Agent Bridge environment key names.
Caller backend, scope, and host-config flags are rejected. Owner-private revisioned
manifests live under
`~/.agent-bridge/operations/<uuid>` with private snapshots and an exclusive lock keyed
by runtime plus stable instance. Manifest publication fsyncs files, atomically renames,
verifies private paths, and fsyncs directories where supported. Snapshot publication
uses atomic no-replace links, so residue from an interrupted manifest update cannot be
overwritten. Sensitive file access pins its immediate directory. Operation-root and
target identities remain pinned throughout creation and destructive cleanup. The root
and locks identities remain pinned throughout stale recovery, and the artifact-directory
identity remains pinned across enumeration and every read. A typed credential-agnostic
request and immutable plan record non-sensitive locators, unique no-replace before and
after artifacts, and expected digests. Backend artifacts contain only a role, file
identity, and private or repairable policy state. They never contain backend bytes,
credentials, URLs, or workspace values. Begin is lock-covered and refuses another
unfinished operation; any blocked journal fences new mutation, including resume. Resume
is same-host only. The journal advances through prepared,
snapshotted, in-progress, applied, cleaning, and committed. Inspection separately
reports resumable, classification-required, blocked, or complete.

Repair and uninstall journals use operation format version 3. New update and reverse
rollback journals use v4. A v4 update request and terminal completion retain a bounded
credential-free inverse contract: prior managed metadata, prior exact registration
contract, and forward metadata and registration digests. Version 2 manifests retain
their released request interpretation and remain inspectable. A non-terminal version 2
record is blocked because it cannot prove the identity-bound request needed for these
public mutations.

Before a mutation, repair, update, and uninstall compare the full strict metadata record after
acquiring the lock. Each non-metadata step repeats that authority check. Registration
proofs include a bounded observation of the Agent Bridge entry and its full target
contract. Unknown environment keys, malformed values, unsafe arguments, an unexpected
scope, or an opaque registration shape stop before a journal is created.

Native repair and update remove the managed entry, prove absence, add the exact target,
and change metadata last when the launch changes. A native update command is one
executable contract. Bare commands cannot contain argument separators, while absolute
paths must resolve to executable files before an update is journaled. Codex runs get,
remove, and add with the recorded profile home over the supplied environment. Claude
Code uses its recorded scope, working directory, and supplied environment. Claude
Desktop reads its recorded config without following links or link ancestors, replaces
only `mcpServers.agent-bridge`, writes through an operation-scoped private temporary
file, and verifies the published entry. Node cannot make that update atomic with an
uncooperative same-user Desktop writer. The code pins and rechecks the file and parent
identities immediately before rename, but this is an advisory race boundary, not an OS
transaction guarantee. Windows accepts an already owner-private backend path and
refuses a non-private backend instead of claiming a safe permission tightening.

Uninstall removes a managed registration, proves its absence, deletes the private
backend file, then deletes the management metadata. It does not tighten an unsafe
backend before deletion. A backend that is not already private stops the plan before
it removes the registration. Uninstall never rolls a completed step back. Desktop
deletes only `mcpServers.agent-bridge` and preserves unrelated JSON. Before a backend
or metadata unlink, the code checks the private parent and file identities. POSIX
syncs that parent after deletion. Windows reports verified deletion with unavailable
directory durability. Node pathname deletion cannot make this atomic against an
uncooperative same-user writer, so that race remains advisory.

Rollback is an explicit update-only operation. `clients rollback` locates authority
only from a committed same-host v4 update record and requires the recorded identity as
an assertion. It rejects a changed forward registration or metadata state before it
creates a new reverse journal. Native rollback removes the forward registration,
proves absence, adds the prior registration, proves it, and writes prior metadata last.
Desktop replaces only `mcpServers.agent-bridge` and writes prior metadata last. The
reverse journal retains its source operation UUID and inverse contract so generic
resume needs no caller-provided backend, scope, command, runtime, or instance. A
failed forward update is never compensated automatically. Repair has no rollback, and
uninstall recovery requires re-enrollment.

Native Windows ACL checks start uncached for each acquired or resumed mutation lock.
While that lock remains held, later directory checks may reuse the result only for the
same directory path, device, and inode. File checks always use the native policy.
Passive inspection starts without a cache, and POSIX mode checks run on every access.
A same-user process can still change an ACL on an unchanged directory or replace it
with a directory that reuses the same filesystem identity. Local mode already treats
that OS user as trusted. Agent Bridge does not delete a cached directory during a
successful managed-client mutation.

Cleanup durably records per-artifact intent, verifies and unlinks the pinned artifact,
then records POSIX directory sync or explicit Windows unavailability. An absent file
is resumable only when intent predates the cleanup attempt. Inspection also recognizes
one verified after artifact left by an interrupted manifest publication. Other missing
or extra files block. Committed means verified writes and removed artifacts. Its
manifest drops requests, steps, locators, digests, and artifact metadata. A v4 update
completion retains only its inverse contract. Other terminal completions retain the
operation kind, step count, completion time, and cleanup durability for audit. Endpoint
migration remains unavailable. Uninstall adds no rolled-back state. Physical
erasure remains outside the filesystem contract.

`clients resume <operation-id>` accepts stored v3 repair, update, and uninstall
operations plus supported v4 update and rollback operations, with optional same-host
stale-lock recovery. It derives authority from the immutable request. It rejects v2
records and cannot take replacement caller authority. Generic resume finishes an
uninstall interrupted after metadata deletion and a reverse rollback interrupted after
any recorded boundary.

### Gateway client migration staging prepares a later cutover

`clients migrate stage <runtime>` creates a private successor backend and a
credential-free stage record. It leaves the managed registration, active backend, and
source edge gate state unchanged after initializing the gate schema. It requires a
rotation enrollment that keeps the predecessor valid through a future grace cutoff.
The stage record binds the managed
identity, source and target endpoint digests, both credential IDs, the source edge
database path and scope key, and the grace cutoff. It does not store either token or a
raw gateway URL.

The source backend must bind an absolute, normalized edge database file. Relative and
in-memory paths cannot identify the same durable outbox across harness working
directories, so staging rejects them.

An applied stage probes the active and staged bearer credentials, records the
enrollment credential IDs, initializes the recorded source edge database, and requires
its migration gate to be active. SQLite rejects a new outbox insert as soon as that
gate begins draining, including inserts from a client that had already opened the
database. These checks prepare a later drain and cutover. They do not authorize either
action.

The stage does not prove that source and target reach the same database authority. A
later endpoint cutover may use alternate URLs only after it dynamically attests one
logical authority. The authority identifier must survive clone and restore. Moving to
an independent database requires a separate owner-mediated fence and is outside this
staging command. A copied authority identifier does not prove that a live clone is
fenced.

### v1 compatibility is additive

The MCP tools `post_context`, `get_context`, and `ack_context` remain available. Existing CLI verbs and flags remain accepted. Text responses remain present while v2 adds structured result data.

Legacy Supabase rows remain readable as broadcast messages. A migration command checks schema state, backfills v2 records, and verifies counts before activation. Secure shared mode cannot silently inherit the old permissive RLS policies.

## Security boundary

Shared mode uses a token-authenticated API. The service stores only token hashes. Credentials bind a workspace and principal, carry canonical operation scopes, can expire, and can be revoked. Capabilities requires an active credential but no named scope. Local and legacy providers do not claim gateway scope enforcement.

Migration 011 grants every pre-migration credential the full compatibility scope set, including expired and revoked rows, without rewriting lifecycle metadata. Migration 014 preserves those rows but changes new raw inserts to empty scopes. Owner provisioning selects an immutable named scope set. Database constraints reject unknown, duplicated, or unsorted scopes.

A successor holds an immutable link to one predecessor in the same workspace and principal. Revocation and ordinary expiry always win. A grace cutoff applies only after a successor exists and can only shorten the predecessor's remaining lifetime. Narrow owner functions commit replacement or revocation with their security event. Expected replacement failures that identify a predecessor also produce a fixed failure event.

Schema migration and provisioning use a database-owner connection. The running gateway uses a different login that inherits a database-specific runtime role. The role name includes a digest of the database name so permission does not bleed between Agent Bridge databases on one PostgreSQL cluster. That role can read runtime state, insert immutable messages and receipts, transition deliveries, append delivery events, and maintain leased presence. It cannot change workspaces, agents, credentials, message content, schema objects, or migration records. Gateway startup does not run migrations.

Migration 014 adds a separate offline owner control plane. Database-specific no-login control-owner, operator, and auditor roles have no superuser or RLS bypass powers. The control owner owns append-only request, event, membership, and catalog-attestation records. It can select only the non-secret credential columns used by its security-definer functions. Operators can provision several principals in a name-compatible workspace, rotate credentials, revoke credentials, and read safe inventory. Auditors can only read inventory.

The owner CLI connects only through `AGENT_BRIDGE_OPERATOR_DATABASE_URL` and remains
outside MCP, HTTP, and the versioned operation registry. Provision and rotation write
a revisioned enrollment file with exact gateway, workspace, principal, runtime, and
instance inputs before any database call. The file moves through `pending`, `ready`,
`consuming`, and `consumed` states under one exclusive per-file operation lock. Every
transition compares the current disk revision, state, request, operation, and token
before durable atomic replacement. Stale lock recovery is explicit and requires
same-host ownership, a minimum age, and proof that the recorded process has stopped.
Only the local process computes the token hash. PostgreSQL never receives the raw
token. The installer registers a provisioned client once. Provision stores nonsecret
credential, principal, and instance metadata in the client backend. Rotation requires
that metadata plus an exact live host registration before it replaces the token. An
opaque inventory cursor includes its workspace authority so it cannot be reused under
another filter.

Enrollment deletion and lock release report durability separately. A failure before
unlink leaves a retained consumed file. A failure after unlink reports unknown directory
durability and never reports a retained path. On Windows, enrollment roots, every path
component, enrollment files, temporary files, locks, and credential backends must be
owned by the current account SID or the active token's default owner SID before the
process applies policy. The process rejects every other owner, sets the account SID as
owner, and verifies one protected account-SID FullControl rule. Verification-only paths
must already satisfy that final policy. Node identity and file-type checks run before
and after the native policy check. Native reparse attributes
reject symlinks, junctions, and other reparse objects before and after DACL work.

The schema owner is the trusted offline role administrator. It holds all three control roles with the admin option and registers eligible login roles through `register_control_member`; `revoke_control_member` removes them. Those functions are not available through HTTP or MCP. Each call is idempotent by request UUID and appends the database session actor to the membership ledger. Runtime readiness compares the active registry with the full `pg_has_role` closure and the direct `pg_auth_members` edges. It rejects unregistered operator or auditor holders, every external owner holder, missing registered grants, unsafe login attributes, extra roles inherited by a registered member, and roles that inherit a registered member. Direct edges must retain their expected grantor, admin, inherit, and set options. Only the schema owner is exempt from the broad closure check because a PostgreSQL superuser reports membership across roles. A direct `GRANT` is never a valid deployment shortcut.

Every protected operation first locks a member-global key for `session_user`, followed by capability keys in operator-before-auditor order. It then checks the active registry, direct membership edge, safe login attributes, and complete upstream and downstream role closure. Inventory accepts either registered capability. Registration and revocation use the same global-first lock hierarchy. Opposite operator and auditor changes for one member therefore cannot deadlock. A revocation waits for an operation that already passed authorization, while every operation begun after revocation observes the new state. A session that remains in a revoked role through `SET ROLE` cannot use that stale authorization.

Every mutation then locks its request UUID before reading the request ledger or lifecycle rows. The ledger stores a SHA-256 fingerprint of the canonical request. Timestamp inputs use epoch microseconds in that fingerprint, so session time zones cannot change replay identity. Identical concurrent calls return the first committed result, including a provisioning replay after its requested expiry. Changed content under the same UUID fails. Rotation accepts credentials without an expiry. A null grace cutoff invalidates the predecessor as soon as the successor exists. Audit actors come from `session_user`; results, audit rows, and sanitized constraint errors exclude credential digest material. Text fields at the control boundary reject surrounding whitespace, control characters, and values over 128 characters.

Rotation includes the expected workspace and principal in its request fingerprint. The
function checks both against the predecessor while holding its row lock. Its initial
and replay results return the canonical workspace and principal from the stored
request result. The owner CLI uses that result directly instead of performing a
bounded inventory lookup after rotation.

Inventory orders credentials by millisecond-normalized creation time and credential ID. Callers may filter by workspace, continue after a `(created_at, credential_id)` cursor, and request up to 1,000 rows. The default page contains 100 rows. Fixed-origin `date_bin` expression indexes cover both global and workspace ordering. The millisecond normalization matches the timestamp precision preserved by common PostgreSQL JavaScript clients.

Before recording an attestation, the migration restores the canonical row-isolation helper functions and verifies the existing row-isolation attestation. An independent credential-security catalog checks exact relation, column, constraint, index, trigger, and function definitions against a separately certified digest for PostgreSQL 15, 16, 17, and 18. An unknown future major has no expected digest and fails closed. Runtime readiness repeats the explicit major-version gate on every call. An already-migrated database therefore becomes unavailable after an upgrade to an uncertified PostgreSQL major. The migration also checks relation ownership, RLS state, protected ACLs, default privileges, and control-role ownership. It refuses to establish a healthy baseline over dependency drift, privilege paths to untrusted roles, or objects unexpectedly owned by a control role.

The stored definition is scoped to the control plane and its dependencies. It includes the live credential-security prerequisite catalog, protected function bodies and owners, trigger and index definitions, column types and defaults, RLS and persistence flags, role attributes, relevant default privileges, and the allowed schema, relation, column, sequence, and function grants. Runtime readiness compares the live definition with that record and checks registered membership separately. It fails when a protected function body or same-name constraint changes, a ledger trigger is disabled, a credential default drifts, a control role inherits a data role, or an untrusted role receives schema access, data access, function execution, or a future-object default grant. An unrelated owner-only table remains outside the definition and does not cause a false readiness failure.

Migration 012 removes direct runtime reads of credential digest material and establishes transaction-bound request authority. Node computes the credential hash, so PostgreSQL never receives the raw bearer credential. Request authority, security accounting, and domain work use one checked-out PostgreSQL client and one explicit transaction. A security-definer opener matches the credential ID and hash against current revocation, expiry, successor-grace, agent, and workspace state in one locked statement, then records the database-derived credential, workspace, principal, and scopes for that backend and transaction. Instance remains validated same-principal attribution and never establishes authority. Claim, cancel, and requeue reuse the outer transaction without nested `BEGIN`.

Migration 017 adds an immutable singleton authority UUID and a separate bound opener.
The released opener retains its original result shape. The bound opener returns the
same credential, workspace, principal, and scopes with the authority UUID in the same
request transaction. Runtime readiness checks the singleton row, mutation trigger,
function catalog, and direct table and column privileges. The UUID is returned only by
authenticated gateway status. It is not a capability field, log field, or readiness
field.

Migration 018 adds issue and consume operations for a gateway-only HTTP 2.1
endpoint-migration challenge. The issuer provides a lowercase 64-character hexadecimal
challenge, expected authority UUID, and direct active successor credential. The
successor consumes the same commitment with its active transaction-bound authority.
PostgreSQL hashes the challenge with a domain separator before persistence and retains
no raw challenge in records, events, or replies. Challenges expire within 60 seconds,
can be consumed once, and do not establish database authority or permit endpoint
cutover. The migration extends the credential-security catalog and records endpoint
and owner-control v5 attestations before readiness succeeds.

The domain savepoint separates expected rejected domain work from security effects: expected scope and rate accounting can commit while failed domain mutations are rolled back. An abort before commit rolls the whole request back. Once commit dispatch begins, the gateway never retries and reports `mutation_outcome_unknown` if the outcome is ambiguous. A failed rollback discards the pooled connection.

Migration 013 enables and forces RLS on the five domain tables: messages, receipts, deliveries, delivery events, and agent instances. A database-specific no-login role owns those tables. Two more no-login roles isolate request-context reads and delivery-event writes. The gateway login inherits only the runtime role, which has `NOBYPASSRLS` and cannot inherit any of the owner roles. Zero-argument stable context functions read the workspace and principal from the authority row bound to the current backend, transaction ID, and session user. Policies call those functions through scalar subqueries so PostgreSQL evaluates them as InitPlans rather than once per row.

Message policies allow the source, broadcast readers, and named targets. Receipt rows belong to one principal. Delivery and event visibility is limited to the publisher or recipient. Presence is visible across one workspace, while writes belong to the active principal. A delivery actor trigger blocks publishers from claim or settlement actions and blocks recipients from cancel or requeue. It does not validate every lifecycle transition or lease token. Those checks remain in the service. Target-to-delivery membership also remains application-enforced; the database proves the delivery's message and publisher, not that its recipient appears in the target array.

The migration stores the server's own deparsed catalog definition after creating the protected objects. Runtime readiness compares current policies, constraints, trigger bindings, and security functions with that baseline. This avoids a PostgreSQL-version-specific source hash. The runtime can read the attestation but cannot change it. Owner-approved schema changes must replace the baseline in the same migration. The gateway coalesces readiness probes, caches their result for one second, and runs them through a separate one-connection pool. A capabilities request therefore never waits for a pool slot that its request-authority transaction already holds. Capabilities report row isolation only when request authority exists and every readiness check passes. Superusers and `BYPASSRLS` roles bypass PostgreSQL RLS by design and are forbidden for the gateway login.

The database denies direct message updates. Constrained operations handle insertion, receipts, claims, renewals, acknowledgments, and negative acknowledgments. Every query includes workspace scope, and recipient visibility is enforced in storage rather than by client-side filtering.

Limits apply to content bytes, payload bytes, metadata depth, target count, batch size, lease duration, and page size. Network calls have connect and total deadlines. Every authenticated operation consumes a database-timed credential-wide bucket and a separate operation bucket. Numeric bucket state, deterministic row locking, and atomic denial events keep concurrent decisions consistent. Missing or disabled policy state fails closed. Errors have stable codes and do not return secrets or raw database messages.

## Operations and observability

The CLI provides `init`, `doctor`, `status`, `demo`, `send`, `inbox`, `history`, `claim`, `ack`, `nack`, `watch`, `sync`, portable archive, and migration commands. Existing `post` and `get` aliases remain available.

`/readyz` reports storage and schema readiness. Authenticated HTTP status reports the bound principal, provider schema, delivery counts, and the oldest due delivery. When production request authority is active, it also returns additive `gatewayAuthorityId` and `credentialId` fields. They are optional in HTTP 2.1. CLI `doctor` and `status` use a separate client-status contract that also reports local edge state and remote gateway reachability.

Gateway responses carry a request ID, including stable error envelopes. Scope failures return required scopes under `error.details`. Rate failures return a rounded retry delay in both the HTTP header and error details. Authenticated Prometheus output counts requests, errors, timeouts, and authentication failures. Responses, metrics, and append-only security events exclude bearer tokens, hashes, database URLs, payload bodies, arbitrary metadata, and credential material.

## Packaging and release

The unscoped npm name `agent-bridge` belongs to another project. This repository uses `@creatornader/agent-bridge`. Tagged builds always produce a package artifact. Publishing stays gated by the protected `npm` environment, npm's OIDC trusted-publisher binding to `release.yml`, and the `NPM_PUBLISH_ENABLED` repository variable.

The package must contain built runtime files, migrations, client manifests, maintained
public documentation, the license, README, roadmap, security policy, and changelog. It
exports the portable archive API from `@creatornader/agent-bridge/archive`. A clean
tarball install runs archive and CLI smoke checks in CI. Releases use one version
source, a tag-to-version check, and npm provenance. The npm environment does not
currently require a human reviewer, so the release process must not claim a manual
approval gate.

GitHub immutable releases are enabled, and GitHub reports release `v0.3.1` as
immutable. A tag ruleset also blocks update and deletion of `v*` tags with no bypass
actor. Recovery dispatches must run the workflow at the release tag ref so the
provenance workflow identity and checked-out source commit do not diverge. Release
packaging also waits for the exact commit to pass the full `test.yml` matrix on `main`.

## Acceptance checks

The TypeBox 1.x registry validates closed requests before domain semantics. Response schemas require known fields and accept additive properties. MCP and HTTP 2.1 claim and delivery-control results use object envelopes with nullable `delivery` fields. HTTP 2.0 and the unversioned CLI keep their released direct or null shapes.

Compatibility is asymmetric. An upgraded gateway serves released headerless and explicit 2.0 clients. A new 2.1 client probes before mutation and accepts the gateway only when complete, consistent response headers select 2.1 and advertise 2.1 support. A headerless response, selected 2.0 response, or partial negotiation means the gateway must be upgraded. The client rejects mutation instead of using the d8184fe 2.0 contract. Deploy the gateway before 2.1 clients.

The OpenAPI paths describe protocol 2.1. Embedded 2.0 vendor extensions carry only the frozen compatibility schemas and metadata needed to document released clients; they do not form a second OpenAPI description. `npm run contracts:check` proves that JSON Schema 2020-12, OpenAPI 3.1.2, MCP manifest, and capability artifacts match the registry. All schema references are local. Protocol, npm package, MCP implementation, and migration versions are independent. Gateway scope enforcement comes from the registry. Provider-neutral artifacts report enforcement separately for gateway, local, and legacy modes.

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
