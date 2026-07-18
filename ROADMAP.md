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

### Post-release validation and adoption

- Move the project's own normal traffic to the authenticated gateway while retaining a
  tested legacy rollback path.
- Prove cross-machine claim, settlement, offline replay, and restart behavior against
  the published package and a deployed v2 gateway. The historical 0.3.0 live release
  check covered startup, private mailbox sends, caller-scoped history, receipts, and
  client restart through the legacy compatibility backend. It did not prove
  gateway-only behavior.
- Replace remaining direct legacy table pollers with the v2 cursor protocol.
- Confirm the README, npm metadata, GitHub metadata, release notes, and package contents
  match the released artifact.

## Near-term work

### Installation and operations

- Add client repair, update, uninstall, and registration diagnostics.
- Provide a Compose-based development deployment and a production deployment guide.
- Add endpoint migration tooling that does not strand an existing SQLite outbox.
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
