# Agent Bridge roadmap

Agent Bridge is working toward one specific role: durable messaging and work delivery
between agent runtimes that do not share a process, vendor, session, or machine.

This roadmap separates released behavior from code that has not reached a public
release. A merged implementation is not considered shipped until the package is
published and the supported clients pass a fresh end-to-end check.

## Status

### Released by 0.3.1

- Local SQLite and shared PostgreSQL storage behind provider-neutral interfaces.
- An authenticated HTTPS gateway and a named legacy Supabase adapter.
- Immutable messages, caller receipts, delivery leases, retries, dead letters, and
  presence.
- Durable SQLite edge outbox and inbox cache for gateway clients.
- CLI, MCP, HTTPS, and Node library access surfaces.
- Installed-package version reporting through `agent-bridge --version` and `-V`.
- Automated host adapters for Codex, Claude Code, and Claude Desktop. The Codex
  adapter configures the profile shared by the Codex CLI and the Codex surface in the
  ChatGPT desktop app.
- Caller-bound inbox, sent, and combined history with scope-bound cursors.
- Publisher-owned delivery policy, priority claims, cancel, requeue, and delivery event
  inspection.
- Canonical TypeBox operation definitions that generate JSON Schema, OpenAPI, MCP, and
  capability artifacts.
- Credential scopes, rate policy, transaction-bound PostgreSQL request authority, and
  forced row isolation.
- Offline owner commands for credential provisioning, inventory, rotation, and
  revocation.
- Claude Desktop registration with absolute launcher paths that do not depend on the
  application's inherited shell `PATH`.
- Portable workspace archives across canonical SQLite and PostgreSQL stores.
- Native SQLite and PostgreSQL backup, verification, and restore.

### 0.4.0 package contents

The published npm version is the authority for whether this package line has shipped.

- Read-only lifecycle inspection and explicit, plan-first adoption for the Codex,
  Claude Code, and Claude Desktop adapters, backed by owner-only credential-free
  managed metadata, private backend-path verification, health-neutral exact
  registration comparison, immutable nonsecret host locators, and a re-inspected
  adoption postcondition.

- Plan-first managed-client repair, update, and forward-only uninstall for Codex, Claude Code, and Claude
  Desktop. Mutation authority comes only from strict private metadata selected by
  runtime and instance, then bound to the exact managed identity. Applied work uses
  the crash-safe journal, fixed-key credential-free update requests, full metadata and
  bounded registration proofs, exact restart classification, monotonic POSIX backend
  privacy repair, and metadata-last launch updates. Windows accepts only an already
  private backend path. Uninstall removes the registration, backend, and metadata in
  that order without rollback. It refuses a backend that still needs privacy repair.
  Desktop publication and deletion have a documented same-user advisory race.
  New updates use v4 journals and retain a bounded credential-free inverse contract.
  `clients rollback <update-operation-id> --identity <name>` is plan-first and, with
  `--apply`, creates a separate reverse journal after it proves the recorded forward
  state. Generic `clients resume` derives authority from recorded v3, supported v4,
  v5 migration-stage, and v6 endpoint-migration requests. Repair remains monotonic
  and uninstall recovery is re-enrollment.

- Gateway-client migration staging, cutover, and finalization for managed
  clients. A v5 stage creates a private successor backend without changing the active
  host registration. A v6 cutover verifies one live gateway authority and a route
  challenge, drains the source SQLite edge under a lease, changes the host registration
  and metadata, and preserves credential-free contracts for restart classification.
  After journal creation, cutover proves both routes with the successor credential and
  drains the source edge through the target gateway. Finalize retires the retained
  source after the predecessor grace cutoff. Return to an earlier endpoint requires a
  new owner rotation and a new forward cutover. Each phase requires a fresh
  `--exclusive-edge` assertion because unmanaged publishers cannot be enumerated.

- Gateway-only HTTP 2.1 endpoint-migration challenge operations. An active issuer and
  direct active successor use a 64-character challenge bound to the immutable gateway
  authority UUID. PostgreSQL stores only a domain-separated commitment for at most 60
  seconds. A consumed cross-route challenge proves that both live routes share its
  short-lived database state. It does not authorize endpoint cutover or prove a
  historical database move.

- A pinned, non-root gateway image and a Compose development stack with ordered
  migration, restricted runtime-role bootstrap, health checks, private secret files,
  and a persistent PostgreSQL volume.
- A Linux Compose acceptance test that provisions two temporary principals and proves
  authority binding, delivery settlement, denied runtime access to credential hashes,
  idempotent restart, and PostgreSQL volume persistence.
- A production deployment guide covering TLS, network exposure, secret separation,
  backups, upgrade order, and schema rollback limits.

### 0.5.0 package contents

- Read-only PostgreSQL and Fly production preflights. The database preflight reports
  migration authority separately from native DR authority. The Fly preflight checks
  the maintained deployment contract and existing app state without exposing secret
  values.
- A maintained Fly.io reference config. The repository contract keeps schema-owner
  and operator authority out of the gateway, but creating an app, provisioning
  PostgreSQL, setting secrets, migrating, and deploying still require an operator
  gate.
- A manual, approval-protected production proof harness for an existing Fly gateway.
  It separates sender, receiver, machine restart, and fresh-edge verification,
  and publishes versioned receipts that exclude credentials and message content.
- Managed PostgreSQL schema-owner and native-backup compatibility across PostgreSQL 15
  through 18. Migrations accept either a true superuser or a non-superuser with the
  required role-administration authority. Native DR separately requires the schema
  owner to be a true superuser or hold `BYPASSRLS`. A restore target superuser can
  validate the intentionally suspended restored schema-owner shell. PostgreSQL 16 and
  newer split grants are normalized to one effective membership for readiness and native DR. A
  dedicated read-only role lets the schema owner back up protected tables without
  granting that access to the gateway or control principals. Exact released migration
  checksums remain accepted during upgrade, while unrelated checksum drift still fails
  closed.
- Optional exact-message delivery claims in HTTP 2.1, MCP, and the CLI. HTTP 2.0 keeps
  the released claim-next contract.

### Post-release validation and adoption

- Move the project's own normal traffic to the authenticated gateway while retaining a
  tested legacy rollback path.
- Prove cross-machine claim, settlement, offline replay, and restart behavior against
  the published package and a deployed v2 gateway. The historical 0.3.0 live release
  check covered startup, private mailbox sends, caller-scoped history, receipts, and
  client restart through the legacy compatibility backend. It did not prove
  gateway-only behavior.
- Run the manual Fly proof against an operator-owned app and retain its sender,
  receiver, machine-cycle, and verifier receipts. The repository harness is ready,
  but the external proof remains incomplete until an approved workflow run succeeds.
- Replace remaining direct legacy table pollers with the v2 cursor protocol.
- Confirm the README, npm metadata, GitHub metadata, release notes, and package contents
  match the released artifact.

## Near-term work

### Installation and operations

- Publish a maintained client compatibility matrix.

### Storage lifecycle and observability

- Define retention separately from logical message immutability.
- Add audited archive and purge operations for expired data.
- Bound edge caches and resolve abandoned outbox state.
- Add workspace quotas, principal limits, queue-depth diagnostics, and capacity alerts.
- Maintain credential use and administrative audit records without logging secrets.

### Presence and wakeups

- Separate the stable consumer instance key from a live process identity. Supported
  installers generate one key per installed client, while direct clients may supply
  their own. Processes that share a key also share presence in 0.3.
- Add per-process presence and session correlation only through an additive protocol
  change with migration and conformance coverage.
- Maintain heartbeat and expiry automatically for supported long-lived clients.
- Add wake adapters only where they reduce latency. Lost wakeups must never lose data.
- Keep cursored pull as the authoritative recovery path.

### Failure and performance evidence

- Measure install-to-first-message time and local and gateway latency.
- Test concurrent claims, SQLite lock contention, queue growth, duplicate suppression,
  lease expiry, and crash recovery.
- Exercise gateway restarts, database outages, network partitions, clock skew, cache
  corruption, and interrupted migrations.
- Publish the test setup and results instead of making unsupported throughput claims.

## Ecosystem work

- Build an agmsg adapter for send, inbox, history, claim, and settlement operations.
- Carry A2A envelopes without implementing a competing task state machine.
- Publish conformance fixtures and an adapter template.
- Add client libraries where real integrations need them.
- Rename the compatibility `runtime` manifest key to an explicit host-adapter key in a
  versioned manifest contract.
- Expand host installers after each product has a stable configuration contract.
  Hermes, Pi, and similar harnesses can use a generic access surface when their host
  supports one, but they do not have a dedicated adapter or conformance claim.

See [docs/ecosystem.md](docs/ecosystem.md) for the product boundary.

## Project and community work

- Add contribution and support policies, issue templates, and a reviewable governance
  path.
- Publish a local two-agent demo and a cross-machine recovery demo.
- Track completed cross-runtime deliveries and successful second-principal activation.
  Any product telemetry must be opt-in.
- Review compatibility on every release and revisit interoperability choices each
  quarter.

## Deferred

JetStream or another required broker, a large dashboard, Kubernetes packaging, and
end-to-end payload encryption remain deferred until measurements or users justify the
extra operational and security work.
