## Project: Agent Bridge

MCP server + CLI for shared context between AI agents (Sido and Claude Code) via Supabase.

### Key files
- `src/server.ts` — MCP server with 3 tools: post_context, get_context, ack_context
- `src/index.ts` — Entry point
- `bin/agent-bridge` — Bash CLI using curl to Supabase REST API
- `sql/setup.sql` — Supabase schema (shared_context table + RLS)

### Architecture decisions
- Direct fetch to Supabase REST API (no @supabase/supabase-js) — keeps both MCP server and CLI using the same lightweight approach
- URL-encoded braces in PostgREST array contains filter (`%7B`/`%7D` instead of `{`/`}`) — curl strips unencoded braces
- Permissive RLS (read all, insert all, update all) — the anon key is the access control, not row-level policies
- `acked_by` uses fetch-then-update pattern since PostgREST doesn't support `array_append()` directly
- `bridge-meta` category enables agents to suggest improvements to the bridge itself

### Supabase project
- Project ID: cmngzsojiyyboickvehr
- Table: shared_context (public schema)

### Integration points
- Claude Code: MCP server in `~/.claude.json` mcpServers
- OpenClaw: CLI at `~/.openclaw/scripts/agent-bridge`, in safeBins
- Config: `~/.agent-bridge/config` (AGENT_BRIDGE_URL, AGENT_BRIDGE_KEY)
