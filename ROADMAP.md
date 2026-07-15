# Agent Bridge roadmap

Agent Bridge is working toward one specific role: durable messaging and work delivery
between agent runtimes that do not share a process, vendor, session, or machine.

This roadmap separates released behavior from code that has not reached a public
release. A merged implementation is not considered shipped until the package is
published and the supported clients pass a fresh end-to-end check.

## Status

### Released in 0.2.0

- Local SQLite and shared PostgreSQL storage behind provider-neutral interfaces.
- An authenticated HTTPS gateway and a named legacy Supabase adapter.
- Immutable messages, caller receipts, delivery leases, retries, dead letters, and
  presence.
- Durable SQLite edge outbox and inbox cache for gateway clients.
- CLI, MCP, Codex, Claude Code, and Claude Desktop integration paths.

### Implemented for the next release

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

### Required before the next release is complete

- Merge the development branch through the protected-main checks.
- Publish the package through the configured npm OIDC workflow.
- Prove Codex, Claude Code, and Claude Desktop startup, send, receive, receipt, claim,
  settlement, offline replay, and restart behavior against the released package.
- Move the project's own normal traffic to v2 while retaining a tested v1 rollback path.
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
- Expand runtime installers after each host has a stable configuration contract.

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
