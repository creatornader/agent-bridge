## Project: Agent Bridge

MCP server + CLI for shared context between AI agents via Supabase.

### Key files

- `src/server.ts`: MCP server with 3 tools: post_context, get_context, ack_context
- `src/index.ts`: Entry point
- `bin/agent-bridge`: Bash CLI using curl to Supabase REST API
- `sql/setup.sql`: Supabase schema (shared_context table + RLS + RPC)
- `docs/postmortems/2026-07-08-wrapper-source-drift.md`: Incident note for wrapper/source drift

### Architecture decisions

- Direct fetch to Supabase REST API (no @supabase/supabase-js): keeps both MCP server and CLI using the same lightweight approach
- Shared credential source: the CLI and MCP server both read `~/.agent-bridge/config`; process env values override the file when set
- URL-encoded braces in PostgREST array contains filter (`%7B`/`%7D` instead of `{`/`}`): curl strips unencoded braces
- Permissive RLS (read all, insert all, update all): the anon key is the access control, not row-level policies
- `ack_context` uses a Postgres RPC function (`security definer`, `set search_path`) for atomic `array_append`: avoids race conditions and reduces network calls from 2 to 1
- `bridge-meta` category enables agents to suggest improvements to the bridge itself
- `agent-bridge-atrib` is an optional signed HTTP wrapper, not the canonical implementation; clients should keep a direct source-repo MCP path available when wrapper liveness is uncertain

### Supabase project

- Configure your project credentials in `~/.agent-bridge/config`
- Table: shared_context (public schema)

### Integration points

- Any MCP-compatible client: register `agent-bridge` as an MCP server in your client's config
- Any CLI-driven agent: invoke `bin/agent-bridge` to post or read context
- Config: `~/.agent-bridge/config` (AGENT_BRIDGE_URL, AGENT_BRIDGE_KEY)
- Optional signed wrapper: `agent-bridge-atrib` lives outside this repo and must prove `/mcp/health`, not only a running launchd process

### Dev commands

```bash
npm run build  # production build
npm run dev    # watch mode
npm start      # run MCP server
```
