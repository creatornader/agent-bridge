# Changelog

All notable changes to agent-bridge are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Caller-bound `inbox`, `sent`, and `all` mailbox history plus `any`, `unread`, and `read` receipt state across MCP, CLI, HTTP, PostgreSQL, SQLite, legacy, and offline gateway mode.
- Scope-bound v2 cursors with temporary v1 cursor compatibility and authoritative edge-cache backfill after the visibility contract upgrade.
- Deprecated arbitrary-principal receipt filters. The CLI checks compatibility assertions before opening storage or contacting a gateway, and server surfaces reject mismatches before querying message storage.
- Optional immutable project labels across local, gateway, legacy, CLI, and MCP message paths, with exact project reads and unfiltered cross-project reads.
- Additive PostgreSQL migration 008, safe local and edge SQLite upgrades, and an owner-only dry-run-first legacy project reconciliation command.

- Offline inbox and pending fallback now label degraded cache data and unknown acknowledgement state; long-lived MCP clients replay with cancellable bounded backoff and expose manual `sync`.
- CLI health separates local edge health from remote gateway reachability, and unknown publication outcomes retry idempotently.

## [0.2.0] - 2026-07-14

### Added

- Provider-neutral stores for local SQLite, PostgreSQL, the authenticated HTTP gateway, and legacy Supabase.
- Immutable v2 messages, opaque cursors, receipts, delivery leases, retries, dead letters, transition history, and leased presence.
- SQLite gateway outbox, inbox cache, restart-safe synchronization, and explicit stale-cache results.
- Cross-platform Node CLI with init, health, delivery, sync, presence, watch, migration, and client installation commands.
- Cheap `pending` process gate for unread context or due delivery work.
- Runtime manifests and native installers for Codex, Claude Code, and Claude Desktop.
- Runtime-neutral `SKILL.md` guidance and an `llms.txt` package map.
- PostgreSQL migrations with checksum validation and runtime schema readiness checks.
- Restricted PostgreSQL runtime grants separated from schema migration credentials.
- Linux, macOS, and Windows test matrices, live PostgreSQL tests, and clean tarball installation smoke tests.

### Changed

- Package identity is `@creatornader/agent-bridge` at version `0.2.0`. Tagged package builds are automatic; npm publication remains gated until scope access is confirmed.
- Agent identity is process-scoped. Shared config no longer supplies `AGENT_BRIDGE_AGENT`.
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
[Unreleased]: https://github.com/creatornader/agent-bridge/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/creatornader/agent-bridge/compare/v0.1.0...v0.2.0
