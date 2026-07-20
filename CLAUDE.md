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
- `src/archive.ts`: Portable archive package surface
- `src/archive-cli.ts`: Offline portable archive CLI boundary
- `src/portable-archive-format.ts`: Canonical portable archive framing and validation
- `src/dr.ts`: Native DR package surface
- `src/dr-cli.ts`: Offline native DR CLI boundary
- `src/native-dr-bundle.ts`: Framed SQLite and PostgreSQL backup format
- `src/sqlite-native-dr.ts`: Local-authority SQLite backup and restore
- `src/postgres-native-dr.ts`: PostgreSQL backup, role inventory, and restore
- `bin/agent-bridge`: Cross-platform Node CLI launcher
- `clients/*.json`: v1 host-adapter manifests and installation contracts
- `sql/migrations/`: Ordered gateway schema migrations
- `sql/setup.sql`: Legacy Supabase v1 schema
- `Dockerfile`: Pinned, non-root gateway image
- `compose.yaml`: Loopback-only PostgreSQL and gateway development stack
- `deploy/bootstrap-runtime.sql`: Idempotent restricted runtime-login bootstrap
- `scripts/compose-smoke.sh`: Disposable authenticated gateway and persistence proof
- `scripts/postgres-preflight.mjs`: Disposable local PostgreSQL 15-18 contract runner
- `docs/postmortems/2026-07-08-wrapper-source-drift.md`: Incident note for wrapper/source drift
- `docs/decisions/0001-protocol-layers-and-acknowledgment-semantics.md`: Protocol boundary and acknowledgment semantics
- `docs/decisions/0002-canonical-operation-contract-registry.md`: Canonical v2 contracts and version negotiation
- `docs/decisions/0003-host-adapters-and-consumer-instance-keys.md`: Host integration layers and consumer instance-key semantics
- `docs/decisions/0004-client-lifecycle-and-endpoint-migration.md`: Managed client ownership, exact adoption, and endpoint-migration boundary
- `docs/architecture-v2.md`: Accepted v2 protocol, storage, security, delivery, and migration design
- `docs/ecosystem.md`: Public product boundary and interoperability position
- `docs/troubleshooting.md`: Public MCP and client recovery guide
- `docs/deployment.md`: Development Compose setup and production deployment constraints
- `ROADMAP.md`: Released, implemented, and remaining product work
- `SECURITY.md`: Supported versions, vulnerability reporting, and security boundaries
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
- `docs/ecosystem.md` explains how Agent Bridge fits with adjacent protocols, brokers, runtimes, and client interfaces.
- `docs/troubleshooting.md` records public recovery procedures for MCP and supported clients.
- `docs/deployment.md` records development deployment, production constraints, upgrade order, backup, and rollback.
- `ROADMAP.md` separates released behavior, implementation awaiting release, and remaining work.
- `SECURITY.md` records supported versions, private reporting, and public security boundaries.
- `CHANGELOG.md` records released and pending behavior.
- `SKILL.md` records the public agent operating contract.
- `llms.txt` provides a compact index and must match the public commands and identity model.
- Postmortems under `docs/postmortems/` record incidents and corrective policy.

Sync triggers:

| Event | Docs to update |
| --- | --- |
| Public command, tool, or config changes | `README.md`, `CHANGELOG.md` |
| Agent operating contract changes | `SKILL.md`, `llms.txt`, `README.md` |
| Protocol, storage, identity, or delivery decision changes | `docs/architecture-v2.md`, `CLAUDE.md`, `README.md` |
| Product boundary or interoperability changes | `docs/ecosystem.md`, matching ADR, `README.md`, `CLAUDE.md` |
| Client startup or recovery behavior changes | `docs/troubleshooting.md`, `README.md`, `SKILL.md`, `llms.txt` |
| Gateway image, deployment, migration order, or network behavior changes | `docs/deployment.md`, `SECURITY.md`, `README.md`, `CHANGELOG.md` |
| Roadmap item changes state | `ROADMAP.md`, `CHANGELOG.md` when released |
| Security support or threat boundary changes | `SECURITY.md`, `README.md`, `docs/architecture-v2.md` when architectural |
| Release version changes | `package.json`, `CHANGELOG.md`, `README.md` when compatibility changes |
| Incident changes operating policy | Matching postmortem, `CLAUDE.md`, and any affected public setup docs |
| New maintained document | `README.md`, `CLAUDE.md`, and related docs that should link to it |

### Architecture decisions

- Agent Bridge is the durable, pull-first mailbox and work-delivery control plane. A2A and application task semantics sit above it.
- MCP, CLI, HTTPS, and the Node library are access surfaces. Harnesses, host applications, host adapters, and access surfaces are separate layers. Optional transports may sit below the core but cannot replace authoritative cursor replay.
- Read receipts, delivery claims, lease extensions, delivery settlement, and external task completion are separate semantics.
- agmsg is a reference for adapters, interoperability, and client experience, not the protocol authority.
- PostgreSQL is the canonical shared store. Supabase is an optional PostgreSQL host and a named legacy adapter.
- SQLite is the local authority in local mode. In gateway mode it stores the durable outbox, cache, and cursor state.
- Shared config contains backend settings only. `AGENT_BRIDGE_AGENT` is accepted only from the active process or an explicit CLI identity argument.
- Client installers write separate owner-only backend files. Gateway tokens are bound to one principal and never stored in the shared config.
- Client lifecycle inspection is read-only and classifies absent, unmanaged, managed, and drifted registrations independently of connectivity health. Backend files and their immediate parents must pass the owner-only no-link policy. Adoption is plan-first, requires `--apply`, writes only owner-private credential-free management metadata after exact identity, instance, backend-path, scope, launch, and registration-locator verification, and re-inspects the registration before success. Desktop locators name the normalized config, Codex locators name the active profile config, and Claude Code local or project locators include the invocation directory because its native CLI exposes no stronger target. It does not weaken enrollment-based provision collision refusal. Repair, update, and uninstall locate strict metadata only by runtime plus instance. Identity is an assertion. They reject caller backend, scope, and config-path authority flags. Repair restores the recorded launch. Update validates a replacement launch before journaling it. Uninstall removes the proven registration, an already private backend, and metadata in that order without rollback. It refuses a backend that needs privacy repair. `clients rollback <source-operation-id> --identity <name>` accepts only a committed same-host v4 update source. It creates a separate reverse journal only with `--apply`, after verifying the retained inverse contract and exact current forward state. Repair remains monotonic. Uninstall recovery is re-enrollment. Native adapters use the recorded Codex home or Claude Code scope and cwd. Desktop changes only its stored `mcpServers.agent-bridge` entry. Desktop config writes preserve unrelated JSON but cannot create a transaction with an uncooperative concurrent Desktop writer.
- Managed-client operations use owner-private revisioned manifests under `~/.agent-bridge/operations/<uuid>`, typed credential-agnostic requests, no-replace before/after artifacts, and locks keyed by runtime plus stable instance. Begin holds the lock while refusing another unfinished operation, and any blocked journal fences new mutation and resume. Resume is same-host only. Sensitive file access pins its immediate directory; creation, stale-lock recovery, and cleanup pin the relevant directory identities. A held Windows mutation lock may reuse a successful private-path check for the same directory identity. File checks, a new or resumed lock, and every passive inspection recheck the native ACL; POSIX checks are never cached. Durable pre-write intent and verified after artifacts drive exact restart classification. Journal states are prepared, snapshotted, in-progress, applied, cleaning, and committed; inspection separately reports resumable, classification-required, blocked, or complete. Cleanup durably records per-artifact intent, verifies the pinned artifact, unlinks it, and records POSIX directory durability or explicit Windows unavailability. An absent artifact is resumable only when intent predates the attempt. Committed means verified writes plus removed artifacts. Terminal records remove requests, steps, digests, locators, and artifact metadata. A v4 update completion retains only a bounded credential-free inverse contract with prior metadata, an exact prior registration contract, and forward-state digests. Repair and uninstall use v3. Update and reverse rollback use v4. Gateway migration staging uses v5. Its credential-free request binds source and target endpoint digests, enrollment credential IDs, source edge path and scope, and a predecessor grace cutoff. It creates a private successor backend while leaving the active registration and backend unchanged. It does not prove source and target database authority or authorize a drain or cutover. Full metadata and bounded registration proofs prevent changed state from advancing a journal. Backend proofs retain only file identity and private or repairable policy state. Windows repair accepts only already private backend paths, and uninstall does the same before deletion. Backend and metadata deletion verify their parent and file identities, then sync the parent on POSIX or record Windows unavailable durability. Desktop publication and deletion have an advisory same-user race boundary. `clients resume <operation-id>` derives all mutation authority from recorded v3, supported v4, v5 migration-stage, or v6 endpoint-migration requests, rejects version 2 resumption, and completes an uninstall interrupted after metadata deletion. A v6 cutover retains the complete credential-free v5 stage contract, the normalized source gateway URL without a token, exact source and target metadata and registration contracts, their digests, and both edge paths. Initial preflight uses a direct predecessor-to-successor route proof. After journal creation, every mutation uses a fresh same-successor proof from the retained source URL and drains the source edge through the target gateway. Finalization retires the source after predecessor grace. Returning to a previous endpoint requires a new owner rotation and forward cutover. Every phase requires a fresh `--exclusive-edge` assertion because unmanaged publishers cannot be enumerated. A failed forward update never compensates automatically.
- Gateway migration staging requires an absolute, normalized, durable source edge database path and rejects `:memory:`. Once all v5 steps are durably observed, resume performs journal cleanup without requiring the consumed enrollment, live gateway probes, or an unexpired predecessor grace window.
- Gateway credentials bind workspace and principal. Client source and workspace fields are not trusted.
- Migrations use the schema-owner `AGENT_BRIDGE_DATABASE_URL`. The gateway requires a restricted `AGENT_BRIDGE_RUNTIME_DATABASE_URL` and never runs migrations at startup.
- The checked-in Compose stack is a loopback-only development reference. Production gateways require TLS, private PostgreSQL networking, platform-managed secrets, verified native DR backups, and a one-shot migration gate before gateway rollout.
- Message content and routing are immutable. Receipts, deliveries, delivery events, and presence use separate records.
- History defaults to caller-relative inbox visibility. Sent is source-equal-to-caller, all is their union, and receipt state is caller-bound and inbox-only. Cursors bind identity, visibility, and normalized filters.
- Project is an optional immutable message label. Workspace remains the tenant and credential boundary; omitted project reads all labels.
- The legacy Supabase schema is global and has no tenant workspace. Legacy clients report workspace `*` and use project only as a message label.
- Migration 008 adds project storage. Migration 006 remains unchanged and its imported rows are corrected only by the schema-owner reconciliation command.
- Cursor pulls are authoritative. Notifications may wake a client but never replace replay.
- Delivery is at least once through claim, lease, ack, nack, retry, and dead-letter state.
- Claim normally selects the next due delivery. HTTP 2.1, MCP, and CLI may optionally
  identify one message, which scopes selection and claim-time delivery maintenance to
  that eligible recipient delivery. HTTP 2.0 rejects the additive field.
- Immutable publisher delivery policy owns delivery mode, retry limits, and backoff. Cancel and requeue are publisher-only. Requeue resets cycle attempt but not lifetime attempt. Consumer `maxAttempts` and `retryPolicy` inputs are validated and ignored for one compatibility release.
- Exact idempotent replay deduplicates. Changed content under an existing idempotency key fails.
- Direct fetch remains in the legacy adapter. The normal remote path uses the authenticated gateway.
- Local and edge SQLite files use WAL, owner-only modes where supported, and bounded busy waits. Initialization and schema upgrade use a 15-second minimum retry window; normal operations retain the configured timeout. Windows verifies the private parent and main database before open, then applies explicit sidecar ACLs after WAL setup and the serialized schema transaction. Replacement during one ACL check still fails.
- Host-adapter manifests and installers inject identity per installed client. The v1 manifest field named `runtime` is a compatibility key for the installation target. It does not mean a live process. Installers do not write one identity into shared config.
- The `codex` adapter configures the profile shared by the Codex CLI and the Codex surface in the ChatGPT desktop app. Claude Code and Claude Desktop use separate adapters and registrations.
- `AGENT_BRIDGE_INSTANCE` is an optional caller-supplied stable consumer key. Supported installers generate and persist it; direct clients may manage it themselves. The gateway does not bind it to an installer registration. Unless `AGENT_BRIDGE_CURSOR` is explicit, the key selects cursor storage. It also selects leases and instance presence. Without a key or explicit cursor path, cursor storage uses `default`. Lease ownership falls back to the principal, and presence is unavailable. It is not a PID or session. Per-process presence must be additive.
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
- Migration 017 adds one immutable PostgreSQL authority UUID. The released request-authority opener remains available with its original return shape. Production requests use a bound opener and authenticated status adds optional `gatewayAuthorityId` and `credentialId` fields without changing HTTP protocol 2.1. Runtime readiness verifies the singleton row, immutable trigger coverage and catalog, and runtime or public table and column privileges. Native DR preserves the UUID as logical authority continuity only. It does not fence a live clone. Drain old gateways before this migration because a running old process can still serve normal traffic after its readiness probe fails.
- Migration 018 adds two gateway-only HTTP 2.1 endpoint-migration challenge operations. Both use active bound request authority, the canonical credential and operation rate buckets, and a direct active issuer-to-successor credential link. PostgreSQL stores only a domain-separated challenge commitment for at most 60 seconds. Runtime access is limited to the two challenge functions. Migration 019 preserves that boundary while also allowing the same active successor credential at both endpoints for post-journal recovery. It records endpoint v2 and owner-control v6 attestations. Authenticated HTTP 2.1 capabilities expose the bound credential's granted scopes. A consumed challenge does not authorize endpoint cutover.
- Credential replacement links are immutable and principal-bound. Revocation and ordinary expiry always win; a successor grace cutoff may only shorten predecessor access.
- Migration 014 is the offline PostgreSQL owner control plane. Database-specific control owner, operator, and auditor roles expose exactly replayable provisioning and credential lifecycle functions. The schema owner registers operator and auditor logins through protected SQL functions; direct control-role grants fail readiness. Registered members cannot inherit unrelated roles, and no role may inherit a registered member. Protected operations recheck `session_user` against the live registry and direct membership. Operation, registration, and revocation paths take a member-global transaction lock before operator and auditor capability locks. The gateway and MCP server have no membership administration route. A request UUID serializes each mutation before database work begins. Rotation fingerprints the expected workspace and principal, checks them while locking the predecessor, and returns the canonical identity. Inventory uses an optional workspace filter and a `(created_at, credential_id)` keyset cursor, with 100 rows by default and a limit of 1,000. Fixed-origin expression indexes serve global and workspace ordering. The control owner cannot select credential hashes. The migration refuses critical dependency or privilege drift before recording a scoped catalog attestation. Runtime readiness checks prerequisite definitions, default privileges, the running server major, and the exact registered membership graph while permitting unrelated additive schema objects. Credential-security prerequisite digests are certified separately for PostgreSQL 15, 16, 17, and 18; unknown future majors fail closed before and after migration. New raw credentials default to no scopes.
- `agent-bridge owner` is the offline CLI for migration 014. It accepts database authority only from `AGENT_BRIDGE_OPERATOR_DATABASE_URL`; it stays outside MCP, HTTP, and the operation registry. Provision and rotation create revisioned private enrollment files before database work. An exclusive file lock covers database and installer side effects, and every transition compares current disk state before replacement. Provision registers the host once. Rotation requires predecessor credential, principal, instance, gateway, workspace, and live registration matches before replacing the backend. Before the code applies a Windows DACL, enrollment and credential paths must be owned by the current account SID or the active token's default owner SID. The final owner and sole protected FullControl rule must use the current account SID. Verification-only paths must already satisfy that final policy. Node identity checks and native reparse attributes reject symlinks, junctions, other reparse objects, and path replacement around DACL work. Deletion and lock-release results distinguish retained objects from completed operations whose directory durability could not be proved.
- Portable archives carry one workspace's immutable messages and eligible read receipts across canonical local SQLite and PostgreSQL stores. They exclude delivery, event, presence, credential, owner-control, and security state. Import verifies format, message, and receipt passes through one private file descriptor with a 4 MiB batch budget. Export completes its audit only after durable publication. Import is dry-run-first, and `--dry-run` cannot be combined with `--apply`. The caller-attested digest detects changed bytes but is neither encryption nor authentication. PostgreSQL archive commands accept authority only from `AGENT_BRIDGE_ARCHIVE_DATABASE_URL` and stay outside MCP, HTTP, and the operation registry.
- Native DR preserves one complete local SQLite authority or PostgreSQL authority in a private framed bundle. It does not translate between providers, and it rejects gateway edge SQLite files. PostgreSQL backups combine a schema-only custom dump with canonical role, membership, and default-ACL state. Restore requires the same database name and major, a dedicated fresh target, superuser authority, exact-major tools, and explicit acceptance of source SQL risk. Claimed deliveries become retryable work. Partial restore failure disables target connections and reports residue. PostgreSQL source and target URLs come only from `AGENT_BRIDGE_DR_SOURCE_DATABASE_URL` and `AGENT_BRIDGE_DR_TARGET_DATABASE_URL`.
- PostgreSQL control and archive readiness ignore the implicit membership reported for unrelated superusers. The schema-owner superuser remains the expected administrator. Registered principals must still be non-superuser logins with the exact direct membership graph.
- Client `status` is passive and reports unknown remote reachability without claiming a connection. `doctor` performs explicit checks. It exits 0, 2, or 1 for ok, degraded, or failed. Diagnostics preserve blocked edge-outbox evidence across later successful synchronization and distinguish due, scheduled, and leased work.
- GitHub immutable releases are enabled, and GitHub reports release `v0.3.1` as immutable. The active `Protect release tags` ruleset also blocks update and deletion of `v*` tags without bypass actors. Recovery dispatches must use the release tag as the workflow ref so provenance identifies the checked-out source commit. Release packaging also requires a successful `test.yml` run from `main` for the exact package commit.

### Providers

- Local: `AGENT_BRIDGE_PROVIDER=local`
- Gateway: shared URL and workspace plus a separate principal-bound token in each installed client's backend file
- Legacy: `AGENT_BRIDGE_PROVIDER=legacy-supabase`, Supabase URL and key

### Integration points

- Any MCP-compatible client: register `agent-bridge-mcp` and inject its own `AGENT_BRIDGE_AGENT`.
- Codex CLI and the Codex surface in the ChatGPT desktop app: use the shared Codex profile installed by the `codex` adapter.
- Claude Code and Claude Desktop: use their separate automated host adapters.
- OpenClaw and generic MCP hosts: use the included operator-managed manifests.
- Scripts, CI jobs, daemons, and services: invoke the CLI, call the HTTPS API, or embed the Node library.
- Offline archive operators: invoke `agent-bridge archive` with a canonical local database or a restricted `AGENT_BRIDGE_ARCHIVE_DATABASE_URL`.
- Offline recovery operators: invoke `agent-bridge dr` with a local authority path or the environment-only PostgreSQL source or target authority.
- Shared config: `~/.agent-bridge/config` for backend location and workspace, never client identity or gateway tokens.
- Optional signed wrapper: `agent-bridge-atrib` lives outside this repo and must prove `/mcp/health`, not only a running launchd process

### Dev commands

```bash
npm run build  # production build
npm run dev    # watch mode
npm start      # run MCP server
```
