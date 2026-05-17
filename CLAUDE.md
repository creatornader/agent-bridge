## Project: Agent Bridge

MCP server + CLI for shared context between AI agents via Supabase.

### Key files

- `src/server.ts` — MCP server with 3 tools: post_context, get_context, ack_context
- `src/index.ts` — Entry point
- `bin/agent-bridge` — Bash CLI using curl to Supabase REST API
- `sql/setup.sql` — Supabase schema (shared_context table + RLS + RPC)

### Architecture decisions

- Direct fetch to Supabase REST API (no @supabase/supabase-js) — keeps both MCP server and CLI using the same lightweight approach
- URL-encoded braces in PostgREST array contains filter (`%7B`/`%7D` instead of `{`/`}`) — curl strips unencoded braces
- Permissive RLS (read all, insert all, update all) — the anon key is the access control, not row-level policies
- `ack_context` uses a Postgres RPC function (`security definer`, `set search_path`) for atomic `array_append` — avoids race conditions and reduces network calls from 2 to 1
- `bridge-meta` category enables agents to suggest improvements to the bridge itself

### Supabase project

- Configure your project credentials in `~/.agent-bridge/config`
- Table: shared_context (public schema)

### Integration points

- Any MCP-compatible client: register `agent-bridge` as an MCP server in your client's config
- Any CLI-driven agent: invoke `bin/agent-bridge` to post or read context
- Config: `~/.agent-bridge/config` (AGENT_BRIDGE_URL, AGENT_BRIDGE_KEY)

### Dev commands

```bash
npm run build  # production build
npm run dev    # watch mode
npm start      # run MCP server
```
