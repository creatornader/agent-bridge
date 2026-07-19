# Changelog

All notable changes to agent-bridge are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Give local and edge SQLite initialization a 15-second minimum busy-retry window
  for concurrent first-start schema work. Normal database operations retain their
  configured timeout. Concurrency tests also terminate hung child processes before
  temporary-directory cleanup.

- Add the crash-safe managed-client operation substrate and read-only `clients
  operations [<operation-id>]` inspection. Owner-private revisioned manifests,
  immutable ordered step plans, snapshot artifacts, pinned directory identities,
  per-client locks, and same-host stale-lock proof keep private contents out of JSON
  and errors. Restart classification distinguishes exact before-state retries,
  verified after-state advancement, and blocked ambiguity. Snapshot publication never
  replaces residue, every step requires a verified before-state snapshot, and bounded
  manifests reject contradictory state. Typed credential-agnostic requests,
  no-replace before/after artifacts, lock-covered begin, and same-host resume now feed
  distinct resumable, classification-required, blocked, and complete inspection.
  Crash-restartable per-artifact cleanup advances `applied` through `cleaning` to a
  `committed` manifest after verified unlink and POSIX directory sync, or an explicit
  Windows unavailable-durability result. Exact after-publication and post-intent unlink
  residue can resume; every other missing or extra artifact blocks. Terminal manifests
  retain a bounded credential-free completion record. Windows mutations reuse native
  ACL results only within one held lock and for the same verified directory path
  identity. File checks, new or resumed locks, and passive inspection recheck the
  policy. POSIX checks remain per-access. Public mutators remain unavailable.

- Add read-only `clients inspect` and plan-first `clients adopt` for Codex, Claude
  Code, and Claude Desktop. Exact unmanaged registrations can be adopted only with
  `--apply`, which writes owner-only credential-free management metadata. Inspection
  reports absent, unmanaged, managed, or drifted state without reading backend values
  or contacting a gateway. Registration comparison is structural and health-neutral,
  backend paths enforce the owner-only no-link policy, Desktop inspection shares the
  installer launch resolver, and apply re-inspects its postcondition. Enrollment-based
  provision collision behavior is unchanged. Managed metadata also binds Desktop to
  its normalized config path, Codex to its active profile config, and Claude Code
  local or project scope to its invocation directory so later operations cannot guess
  at a registration target.

- Add a pinned, non-root gateway image and a loopback-only Compose development stack.
  The stack runs migrations separately, creates a restricted runtime login, reads
  database passwords from private secret files, and retains PostgreSQL data in a named
  volume.
- Add a Linux Compose acceptance test for credential-bound identity, targeted delivery,
  lease settlement, denied runtime access to credential hashes, and PostgreSQL
  persistence across a full stack restart.
- Add a deployment guide for production TLS, network isolation, secret handling,
  backup, upgrade order, and rollback.

### Fixed

- Treat a Windows SQLite sidecar that disappears during ACL validation as an expected
  race only when the path remains absent. A replacement or reparse object still fails
  validation.
- Handle `-h` and `--help` before command parsing and dispatch so help never opens a
  backend or performs a command side effect.

### Changed

- Require the exact release commit to pass the full `test.yml` matrix on `main` before
  release packaging begins. Pin GitHub Actions and reusable workflows to verified
  commit SHAs.
- Keep Dependabot's grouped npm updates to patch and minor versions. Major updates now
  require separate review.

## [0.3.1] - 2026-07-15

### Added

- Add `agent-bridge --version` and `agent-bridge -V` commands that print the
  installed package version without loading backend configuration.

### Changed

- Clarify the boundary between agent harnesses, host applications, host adapters, and
  MCP, CLI, HTTPS, and Node library access. Define `AGENT_BRIDGE_INSTANCE` as the
  stable consumer key used for cursor paths, leases, and presence. Supported installers
  generate this key, while direct clients may supply it. Document the released
  no-instance fallbacks and the fact that the key is not a unique live process or
  session.
- Require manual release recovery to run the workflow at the tag it publishes so npm
  provenance identifies the checked-out release source.

## [0.3.0] - 2026-07-15

### Control, portability, and recovery

#### Added

- Additive PostgreSQL migration 014 with database-specific owner, operator, and auditor roles. Protected SQL functions register operator and auditor logins in an append-only membership ledger. Owner functions provision more than one principal per workspace, rotate or revoke credentials with exact concurrent replay, and expose bounded keyset inventory without credential hashes. Rotation checks its requested workspace and principal under the predecessor row lock and returns the canonical identity. Fixed-origin expression indexes serve global and workspace inventory. The migration refuses critical dependency or privilege drift before recording a scoped catalog attestation. PostgreSQL 15, 16, 17, and 18 use separately certified prerequisite digests; unknown future majors fail closed.
- Offline `agent-bridge owner` commands for provisioning, inventory, rotation, and revocation through a dedicated operator database URL. Provision and rotation use private, revisioned enrollment files with an exclusive operation lock and compare-and-swap transitions. The client installer consumes those files without putting raw credentials in command arguments. Rotation requires exact predecessor metadata and live host registration before replacing one backend file.
- Canonical portable workspace archives for local SQLite and shared PostgreSQL stores. `agent-bridge archive export`, `verify`, and dry-run-first `import` move immutable messages and read receipts without copying delivery, presence, credential, control, or security state. The package exports the provider-neutral archive API from `@creatornader/agent-bridge/archive`.
- Native SQLite and PostgreSQL disaster recovery through `agent-bridge dr backup`, `verify`, and `restore`. The common private bundle records provider-specific schema metadata and hashes. Local backup uses SQLite's online backup API and rejects gateway edge stores. PostgreSQL backup captures the schema, bounded role inventory, memberships, default privileges, readiness attestations, and recoverable data across PostgreSQL 15 through 18. The package exports the DR API from `@creatornader/agent-bridge/dr`.

#### Security

- Enrollment files use exclusive creation, owner-only directories and files, confined paths, component and directory identity checks, symlink refusal, durable atomic state transitions, and a current-user Windows ACL. Before applying that ACL, Windows paths must be owned by the current account SID or the active token's default owner SID. The code then sets and verifies the account SID as owner with one protected FullControl rule. Verification-only paths must already satisfy the final policy. Node identity checks and native reparse attributes reject symlinks, junctions, other reparse objects, and path replacement around DACL validation. Stale lock recovery is explicit and requires same-host metadata, a minimum age, and proof that the recorded process has stopped. Deletion results distinguish a retained file, a missing file, a durable unlink, and an unlink whose directory durability could not be proved. PostgreSQL receives only the locally computed token hash. Owner JSON and errors exclude the raw token, token hash, SQL text, and operator connection URL.
- New raw credential inserts default to no scopes. Owner mutations derive actors from the database session and never return, audit, or expose credential digest material in any PostgreSQL error property. External control fields reject null required values, surrounding whitespace, control characters, and values over 128 characters. Runtime readiness rejects uncertified PostgreSQL majors, unregistered control-role holders, registered members with unrelated inherited authority, downstream role delegation, protected-object grants to untrusted roles, unsafe future-object defaults, and exact prerequisite drift. Protected operations, registration, and revocation use a member-global lock before capability locks, so opposite capability changes do not deadlock and stale `SET ROLE` sessions cannot continue after revocation. Issued credential identity, scopes, labels, expiry, and replacement lineage are immutable. Migration 014 preserves lifecycle operations for credentials created under migration 013.
- Portable export files use owner-only creation, atomic no-replace publication by default, and durable file and directory synchronization. Export audits complete after publication; failures use bounded abandonment codes. Import verifies three passes through one descriptor and limits batches by count and 4 MiB of canonical data. The caller-attested SHA-256 digest detects byte changes but provides neither encryption nor authentication. PostgreSQL archive commands accept authority only from `AGENT_BRIDGE_ARCHIVE_DATABASE_URL`.
- Portable v1 accepts only current domain records. New API writes use lowercase UUIDs. Archives require lowercase UUIDs and six-digit UTC timestamps without trimming, deduplicating, defaulting, or rewriting message content. Legacy or direct rows outside the domain require native database recovery.
- Export request IDs are caller-visible, embedded as `exportRequestId` in the digest-bound header, and returned by verification and import. Import request IDs remain independent destination operation identifiers. Completed retries verify terminal metadata, while started retries reconcile only a matching retained file through the verified descriptor. Deterministic adjacent recovery artifacts derive from the export ID. Force replacement uses a durable private backup and reports restored, retained, publication-unknown, durability-unknown, and audit-unknown outcomes without hiding recovery paths.
- Native DR uses owner-only paths, exclusive staging files, no-replace publication, same-descriptor extraction, and deterministic recovery names. PostgreSQL URLs are environment-only. Restore requires a fresh same-name, same-major target and explicit acceptance of executable source SQL. It recreates external principals as `NOLOGIN`, validates counts and readiness attestations, normalizes claimed leases, and disables the target after a partial failure. The bundle hash detects changed bytes but provides neither encryption nor source authentication. Windows success results state that parent-directory durability is unavailable instead of claiming a flush the platform cannot prove through Node.

### Protocol and delivery

#### Added

- Canonical TypeBox-backed v2 operation registry with deterministic JSON Schema 2020-12, OpenAPI 3.1.2, MCP manifest, and capability artifacts.
- Surface-aware capability discovery over authenticated HTTP, MCP, and CLI. HTTP 2.1 is current, while upgraded gateways preserve the released headerless and explicit 2.0 response shapes.
- Closed structural request validation before domain semantics, additive response parsing, artifact drift checks, and exact legacy MCP schema fixtures.
- Object response envelopes for MCP and HTTP 2.1 delivery claims and controls. HTTP 2.0 and the unversioned CLI retain their released direct or null delivery results.
- Optional client-generated message IDs across CLI, MCP, and HTTP, including exact idempotent replay.
- Canonical gateway credential scopes, compatibility-safe migration 011, immutable replacement lineage, revocation helpers, and provider-specific capability truth.
- Database-timed credential-wide and operation rate buckets with append-only scope, rate, replacement, and revocation security events.
- Transaction-bound PostgreSQL request authority (migration 012). Node hashes credentials, PostgreSQL derives identity and scopes, and one client and transaction carry security accounting and request-local store operations. Domain savepoints preserve expected security effects when mutations fail. Ambiguous commits are never retried. Production gateway capabilities report request authority without claiming row isolation.
- Forced PostgreSQL row isolation on the five domain tables (migration 013), with database-specific no-login owner roles, transaction-bound context policies, publisher and recipient lifecycle separation, immutable publisher bindings, and a protected catalog attestation. Gateway capabilities report row isolation only after live readiness checks pass.

- Immutable publisher-owned delivery policies with mailbox and leased modes. Leased delivery adds priority claims, monotonic cycle counters, publisher cancel and requeue controls, and authorized audit pagination. PostgreSQL migration 010 and the SQLite initializer upgrade existing stores. Legacy mode rejects leased policy.

- Caller-bound `inbox`, `sent`, and `all` mailbox history plus `any`, `unread`, and `read` receipt state across MCP, CLI, HTTP, PostgreSQL, SQLite, legacy, and offline gateway mode.
- Scope-bound v2 cursors with temporary v1 cursor compatibility and authoritative edge-cache backfill after the visibility contract upgrade.
- Deprecated arbitrary-principal receipt filters. The CLI checks compatibility assertions before opening storage or contacting a gateway, and server surfaces reject mismatches before querying message storage.
- Optional immutable project labels across local, gateway, legacy, CLI, and MCP message paths, with exact project reads and unfiltered cross-project reads.
- Additive PostgreSQL migration 008, safe local and edge SQLite upgrades, and an owner-only dry-run-first legacy project reconciliation command.

- Offline inbox and pending fallback now label degraded cache data and unknown acknowledgement state; long-lived MCP clients replay with cancellable bounded backoff and expose manual `sync`.
- CLI health separates local edge health from remote gateway reachability, and unknown publication outcomes retry idempotently.
- Passive `status` no longer starts synchronization or probes remote providers. `doctor` now reports named checks and exits 0, 2, or 1 for ok, degraded, or failed. Queue diagnostics distinguish due, scheduled, and leased work. They retain blocked outbox evidence after later successful synchronization.

#### Changed

- The pre-1.0 client status contract now has four states: `ok`, `unknown`, `degraded`, and `failed`. Named checks are required. Scripts that assumed only `ok` or `degraded` must handle the two new states. Passive status still exits 0.

- New 2.1 clients require complete 2.1 negotiation before mutation and reject headerless or selected 2.0 gateways instead of downgrading. Gateways must be upgraded before 2.1 clients.
- Capability output distinguishes current, selected, and supported protocol versions. Primary OpenAPI operations require 2.1. Embedded 2.0 vendor extensions contain limited compatibility schema metadata, not a second OpenAPI description.
- Consumer-side `maxAttempts` on claim and `retryPolicy` on nack are validated but ignored for one compatibility release. Stored publisher policy now controls retry and exhaustion.
- Gateway authorization now checks scopes and rate policy before reading request bodies. Scope and rate errors use structured details, and missing security state fails closed.

#### Security

- Existing credentials retain full compatibility access without lifecycle metadata changes. New direct SQL inserts default to no scopes; owner provisioning assigns an immutable named scope set.
- Credential grace can only shorten a predecessor after replacement. Ordinary expiry and revocation cannot be extended or bypassed.
- Database policies isolate workspaces and principals. Lease transitions and target-to-delivery membership remain service-enforced. Gateway logins must not be superusers or hold `BYPASSRLS`.

## [0.2.0] - 2026-07-14

### Added

- Provider-neutral stores for local SQLite, PostgreSQL, the authenticated HTTP gateway, and legacy Supabase.
- Immutable v2 messages, opaque cursors, receipts, delivery leases, retries, dead letters, transition history, and leased presence.
- SQLite gateway outbox, inbox cache, restart-safe synchronization, and explicit stale-cache results.
- Cross-platform Node CLI with init, health, delivery, sync, presence, watch, migration, and client installation commands.
- Cheap `pending` process gate for unread context or due delivery work.
- Host-adapter manifests and native installers for Codex, Claude Code, and Claude Desktop.
- Runtime-neutral `SKILL.md` guidance and an `llms.txt` package map.
- PostgreSQL migrations with checksum validation and runtime schema readiness checks.
- Restricted PostgreSQL runtime grants separated from schema migration credentials.
- Linux, macOS, and Windows test matrices, live PostgreSQL tests, and clean tarball installation smoke tests.

### Changed

- Package identity is `@creatornader/agent-bridge` at version `0.2.0`. The first npm publication was performed manually. OIDC trusted publishing was configured afterward for later releases.
- Agent principal is injected through the client process. Shared config no longer
  supplies `AGENT_BRIDGE_AGENT`.
- Exact idempotent replays deduplicate. Reusing a key for changed content returns a conflict.
- Gateway clients authenticate through separate principal-bound credentials stored in owner-only client backend files.
- Package-root imports expose the provider-neutral API without starting the MCP server.
- `watch` runs until interrupted and retries transient gateway or legacy provider failures.

### Security

- The v2 PostgreSQL schema is private from Supabase Data API roles.
- Remote providers require HTTPS except on loopback.
- Gateway startup validates migration checksums, required objects, credential status, and principal binding.
- Gateway startup requires a restricted runtime database URL and cannot run schema migrations.
- Local config and SQLite state use owner-only permissions where the platform supports POSIX modes.

## [0.1.0] - 2026-05-17

First tagged release. Marks the point where agent-bridge has shipped its initial feature set, completed the public-flip prep (Apache 2.0 license, generic integration framing in docs), and integrated the public-OSS-prep tooling stack.

### Added

- MCP server with three tools: `post_context`, `get_context`, `ack_context`. Direct fetch to Supabase REST API (no `@supabase/supabase-js`) so the MCP server and the bash CLI share the same lightweight approach.
- Bash CLI at `bin/agent-bridge` for shell-based agent integrations.
- SQL schema (`sql/setup.sql`) with the `shared_context` table, permissive RLS (anon key is the access control), and the `ack_context_atomic` RPC for race-free acknowledgement via `array_append`.
- Optional `atrib_receipt_id` column for callers that wrap writes behind an atrib signing layer. The column is format-validated and optional; agent-bridge does not require atrib integration.
- Integration with the public-OSS-prep stack: textleaks pre-commit hook, oss-twin structural mirror gate, oss-security-scan reusable CI workflow.

### Security

- gitleaks + trufflehog + osv-scanner via the reusable workflow at `creatornader/oss-security-scan@v0.1.0`.
- Narrative-leak detection in CI + on commit via `creatornader/textleaks@v0.2.0` (renamed from leakguard).

[0.1.0]: https://github.com/creatornader/agent-bridge/releases/tag/v0.1.0
[Unreleased]: https://github.com/creatornader/agent-bridge/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/creatornader/agent-bridge/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/creatornader/agent-bridge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/creatornader/agent-bridge/compare/v0.1.0...v0.2.0
