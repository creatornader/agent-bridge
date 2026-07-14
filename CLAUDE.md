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

- PostgreSQL is the canonical shared store. Supabase is an optional PostgreSQL host and a named legacy adapter.
- SQLite is the local authority in local mode. In gateway mode it stores the durable outbox, cache, and cursor state.
- Shared config contains backend settings only. `AGENT_BRIDGE_AGENT` is accepted only from the active process or an explicit CLI identity argument.
- Client installers write separate owner-only backend files. Gateway tokens are bound to one principal and never stored in the shared config.
- Gateway credentials bind workspace and principal. Client source and workspace fields are not trusted.
- Migrations use the schema-owner `AGENT_BRIDGE_DATABASE_URL`. The gateway requires a restricted `AGENT_BRIDGE_RUNTIME_DATABASE_URL` and never runs migrations at startup.
- Message content and routing are immutable. Receipts, deliveries, delivery events, and presence use separate records.
- Cursor pulls are authoritative. Notifications may wake a client but never replace replay.
- Delivery is at least once through claim, lease, ack, nack, retry, and dead-letter state.
- Exact idempotent replay deduplicates. Changed content under an existing idempotency key fails.
- Direct fetch remains in the legacy adapter. The normal remote path uses the authenticated gateway.
- Local and edge SQLite files use WAL, bounded busy waits, and owner-only modes where supported.
- Runtime manifests and installers inject identity per client. They do not write one identity into shared config.
- URL-encoded braces in PostgREST array contains filter (`%7B`/`%7D` instead of `{`/`}`): curl strips unencoded braces
- Permissive RLS belongs only to the legacy schema. The private v2 schema denies Supabase Data API roles.
- `ack_context` uses a Postgres RPC function (`security definer`, `set search_path`) for atomic `array_append`: avoids race conditions and reduces network calls from 2 to 1
- `bridge-meta` category enables agents to suggest improvements to the bridge itself
- `agent-bridge-atrib` is an optional signed HTTP wrapper, not the canonical implementation; clients should keep a direct source-repo MCP path available when wrapper liveness is uncertain

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
