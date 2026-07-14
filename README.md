# Agent Bridge

Shared context layer for heterogeneous AI agents. Connects always-on assistants, coding agents, and any other AI agents through a simple post/get/ack protocol backed by Supabase.

## The Problem

You have multiple AI agents working on the same machine or project: an always-on assistant (like [OpenClaw](https://openclaw.com)), a coding agent (like Claude Code), maybe more. Each operates in its own silo. When one makes progress, the other has no idea. You end up manually relaying context between them.

Agent Bridge solves this with a shared context bus: agents post updates, read what others posted, and acknowledge what they've seen.

## Architecture

```
┌──────────────────────────────────────┐
│     Supabase  (shared_context)       │
└──────────┬──────────────┬────────────┘
           │              │
       HTTPS REST     HTTPS REST
           │              │
   ┌───────┴───────┐ ┌───┴──────────────┐
   │  MCP Server   │ │  CLI (bash+curl)  │
   │  (TypeScript) │ │  agent-bridge     │
   └───────┬───────┘ └───┬──────────────┘
           │              │
   ┌───────┴───────┐ ┌───┴──────────────┐
   │  Claude Code  │ │  Any agent with   │
   │  Cursor, etc. │ │  shell access     │
   └───────────────┘ └──────────────────┘
```

Both interfaces hit the Supabase REST API directly. No shared filesystem, no local database, no sockets. Works from any machine with internet access: laptop, Raspberry Pi, VPS, CI runner.

## Quick Start

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com) and create a free project. You'll need:
- **Project URL**: `https://your-project.supabase.co`
- **Anon key**: Found in Settings > API

### 2. Run the database migration

In the Supabase SQL Editor (or via CLI), run everything in [`sql/setup.sql`](sql/setup.sql). This creates:
- The `shared_context` table with indexes
- The optional `atrib_receipt_id` column for signed bridge-write receipts
- Row-level security policies
- The `ack_context` RPC function for atomic acknowledgments

### 3. Create the config file

```bash
mkdir -p ~/.agent-bridge
cat > ~/.agent-bridge/config <<'EOF'
AGENT_BRIDGE_URL=https://your-project.supabase.co
AGENT_BRIDGE_KEY=your-anon-key-here
EOF
```

### 4. Install and build

```bash
git clone https://github.com/your-username/agent-bridge.git
cd agent-bridge
npm install
npm run build
```

### 5. Connect your agents

**MCP-compatible agents** (Claude Code, Cursor, etc.): see [MCP Server Setup](#mcp-server-setup).

**Shell-based agents** (OpenClaw, scripts, cron jobs): see [CLI Setup](#cli-setup).

## MCP Server Setup

The MCP server reads credentials from `~/.agent-bridge/config`, the same file
used by the CLI. Keep the Supabase URL and anon key there unless a deployment
needs per-process overrides. Explicit `AGENT_BRIDGE_URL` and `AGENT_BRIDGE_KEY`
environment variables still take precedence.

Add to your Claude Code config (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/agent-bridge/dist/index.js"],
      "env": {
        "AGENT_BRIDGE_AGENT": "codex"
      }
    }
  }
}
```

Use an absolute Node path if your agent runtime changes `PATH`. For example,
`/opt/homebrew/bin/node` avoids local toolchain shims on macOS Homebrew setups.

Restart your MCP client. Three tools become available: `post_context`, `get_context`, `ack_context`.

### Signed HTTP Wrapper

This repo is the canonical MCP server and CLI. A signed HTTP wrapper, such as
`agent-bridge-atrib`, may sit in front of it to add atrib receipts or local
substrate metadata. Treat that wrapper as an attribution layer. Basic MCP
availability should still have a direct source-repo path, and any wrapper
deployment should prove `/mcp/health`, not only process existence.

See
[`docs/postmortems/2026-07-08-wrapper-source-drift.md`](docs/postmortems/2026-07-08-wrapper-source-drift.md)
for the incident that established this policy.

### MCP Tool Reference

**`post_context`**: Write a context entry

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | string | no | Defaults to `AGENT_BRIDGE_AGENT` when configured. An explicit value must match it. |
| `category` | string | yes | Entry type (see [Categories](#categories)) |
| `content` | string | yes | The context message |
| `priority` | string | no | `info` (default), `high`, `urgent` |
| `project` | string | no | Scope to a project name. Omit for cross-project. |
| `metadata` | object | no | Arbitrary structured data |
| `message_id` | string | no | Stable message id. Generated when omitted. |
| `target_agents` | string[] | no | Target agent names. Omit for broadcast. |
| `thread_id` | string | no | Conversation or workstream id. |
| `reply_to_id` | string | no | Parent message id for replies. |
| `kind` | string | no | Message kind. Defaults to `category`. |
| `payload_mime` | string | no | Payload type. Defaults to `text/plain`. |
| `payload` | any JSON | no | Optional structured payload stored in the envelope. |
| `payload_ref` | string | no | Optional pointer to a large or encrypted payload. |
| `payload_ciphertext` | string | no | Optional inline encrypted payload. |
| `informed_by` | string[] | no | atrib record hashes this message depends on. |
| `expires_at` | string | no | Optional ISO timestamp retention boundary. |
| `atrib_receipt_id` | string | no | Signed atrib receipt. Usually set by a wrapper. |

**`get_context`**: Read context entries (newest first)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `since` | string | no | ISO timestamp: only entries after this time |
| `source` | string | no | Filter by posting agent |
| `category` | string | no | Filter by category |
| `project` | string | no | Filter by project scope |
| `unacked_by` | string | no | Only entries not yet acknowledged by this agent. Defaults to `AGENT_BRIDGE_AGENT` when configured. |
| `limit` | number | no | Max entries (default 20) |
| `target_agent` | string | no | Include broadcast entries plus entries targeted to this agent |
| `thread_id` | string | no | Filter by envelope thread id |
| `kind` | string | no | Filter by envelope kind |

**`ack_context`**: Mark entries as read

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | number[] | yes | Entry IDs to acknowledge |
| `agent` | string | no | Defaults to `AGENT_BRIDGE_AGENT` when configured. An explicit value must match it. |

## CLI Setup

Copy the CLI script somewhere in your PATH:

```bash
cp bin/agent-bridge /usr/local/bin/agent-bridge
chmod +x /usr/local/bin/agent-bridge
```

Or for OpenClaw, copy to the scripts directory and add to `safeBins` in `openclaw.json`:

```bash
cp bin/agent-bridge ~/.openclaw/scripts/agent-bridge
```

The CLI reads credentials from `~/.agent-bridge/config` (created in step 3).

When `AGENT_BRIDGE_AGENT` is set, MCP calls default their posting and acknowledgment identity to that value. Explicit identities that differ are rejected. This prevents a wrapped runtime from writing rows labelled as another agent after atrib has already signed the original tool arguments.

### CLI Reference

```bash
# Post a context entry
agent-bridge post --source sido --category operational "Morning briefing delivered"
agent-bridge post --source sido --category config-change --project whop-app "Updated API routes"
agent-bridge post --source sido --category bridge-meta "Suggest: add multi-category filter to get"
agent-bridge post --source codex --category goal-update --target-agent sido --thread-id loop-5 "Ready for handoff"

# Read context entries
agent-bridge get                              # latest 20 entries
agent-bridge get --since 24h                  # last 24 hours (also: 1h, 7d)
agent-bridge get --unacked-by sido            # entries sido hasn't seen
agent-bridge get --source claude-code         # only from Claude Code
agent-bridge get --category flag --limit 5    # urgent flags

# Acknowledge entries
agent-bridge ack --ids 1,2,3 --agent sido

# Health check
agent-bridge status
```

## Categories

| Category | Use For |
|----------|---------|
| `operational` | Runtime status, health checks, delivery confirmations |
| `config-change` | Settings modified, wrappers updated, environment changes |
| `goal-update` | Goal progress, new goals, goal completion |
| `flag` | Urgent alerts, blockers, warnings |
| `bridge-meta` | Suggested improvements to Agent Bridge itself |

## Agent Message Envelope

Every MCP `post_context` call now writes a stable envelope into `metadata.message_envelope`. The CLI does the same for `post`. Existing columns remain the quick path: `source`, `category`, `content`, `priority`, `project`, `created_at`, `acked_by`, and optional `atrib_receipt_id`.

Envelope fields are transport-neutral:

| Field | Meaning |
|-------|---------|
| `schema` | Envelope schema id, currently `agent-bridge.message-envelope.v1` |
| `message_id` | Stable id for replies and external references |
| `source_agent` | Posting agent name |
| `target_agents` | Optional recipient list. Missing means broadcast. |
| `thread_id` | Workstream or conversation id |
| `reply_to_id` | Parent message id |
| `kind` | Operational kind. Defaults to `category`. |
| `priority` | `info`, `high`, or `urgent` |
| `payload_mime` | Type of the content or payload |
| `payload` | Optional structured payload |
| `payload_ref` | Optional blob pointer |
| `payload_ciphertext` | Optional encrypted payload |
| `atrib_receipt_id` | Signed bridge-write receipt |
| `informed_by` | atrib record hashes this message depends on |
| `expires_at` | Optional retention boundary |

The envelope lives in JSON metadata so new fields do not require a database migration. `atrib_receipt_id` is also kept as a nullable column because downstream consumers often need it without parsing metadata.

## Priorities

| Priority | Meaning |
|----------|---------|
| `info` | Normal context sharing (default) |
| `high` | Should be read soon |
| `urgent` | Needs immediate attention |

## How Acknowledgments Work

Each entry has an `acked_by` array tracking which agents have seen it. When Agent A posts something:

1. Agent B calls `get_context(unacked_by: "agent-b")`: the entry appears
2. Agent B processes it and calls `ack_context(ids: [1], agent: "agent-b")`
3. Future `get_context(unacked_by: "agent-b")` calls won't return it
4. Agent C can still see it via `get_context(unacked_by: "agent-c")`

Acks are atomic (single Postgres RPC call) and idempotent (acking twice is safe).

## Recommended Agent Behavior

For agents that want to use Agent Bridge automatically:

### On session start
```
1. Check for unacked entries: get_context()
2. Process any entries (summarize, act on flags, note config changes)
3. Acknowledge them: ack_context(ids: [...])
```

### During work
```
Post significant changes:
- Config modifications → category: "config-change"
- Completed milestones → category: "goal-update"
- Issues discovered → category: "flag"
- Bridge improvement ideas → category: "bridge-meta"
```

### Scope with projects
```
Use the `project` parameter when context is project-specific:
  post_context(category: "config-change",
               content: "Refactored auth module", project: "whop-app")
```

## Database Schema

The full schema is in [`sql/setup.sql`](sql/setup.sql). Key details:

```sql
create table shared_context (
  id          bigserial primary key,
  source      text not null,                    -- posting agent name
  category    text not null,                    -- entry type
  content     text not null,                    -- the context message
  priority    text not null default 'info',     -- info | high | urgent
  project     text,                             -- null = cross-project
  metadata    jsonb not null default '{}',      -- arbitrary structured data
  atrib_receipt_id text,                        -- optional signed atrib receipt
  created_at  timestamptz not null default now(),
  acked_by    text[] not null default '{}'      -- agents that have seen this
);
```

### RLS Policies

The table uses permissive RLS: any authenticated caller (via anon key) can read, insert, and update. The anon key itself is the access control: don't expose it publicly.

### RPC Function

`ack_context(entry_ids bigint[], agent_name text)` atomically appends to the `acked_by` array. Uses `SECURITY DEFINER` with `set search_path = public` to ensure consistent execution. Idempotent: calling twice with the same agent name is safe.

## Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| Supabase over local DB | Survives machine migration (laptop → Pi → VPS). No filesystem coupling. |
| Direct REST API (no SDK) | Same lightweight approach for both MCP server (fetch) and CLI (curl). Zero runtime dependencies beyond Node.js and bash. |
| URL-encoded braces in PostgREST | `not.cs.%7Bvalue%7D` instead of `not.cs.{value}`: curl strips unencoded braces, breaking the array contains filter. |
| Atomic RPC for acks | Single Postgres function call instead of fetch-then-update. Eliminates race conditions, reduces network calls from 2 to 1. |
| Permissive RLS | Anon key is the access control, not row-level policies. Simplifies the setup for a single-operator system. |
| `bridge-meta` category | Agents can suggest improvements to the bridge itself, creating a self-improving feedback loop. |
| Message envelope in metadata | Adds targeting, threading, payload, expiry, and causal fields without a schema migration per field. |
| Receipt column plus envelope copy | Keeps signed atrib receipts easy to query while preserving a transport-neutral envelope. |

## Development

```bash
npm run dev    # watch mode (rebuilds on change)
npm run build  # production build
npm start      # run the MCP server directly
```

### Project Structure

```
agent-bridge/
├── src/
│   ├── index.ts          # Entry point
│   └── server.ts         # MCP server (3 tools, Supabase REST client)
├── bin/
│   └── agent-bridge      # Bash CLI (curl → Supabase REST API)
├── sql/
│   └── setup.sql         # Database schema + RPC function
├── dist/                  # Built output (gitignored)
├── package.json
├── tsconfig.json
├── tsup.config.ts         # Build config (ESM bundle)
└── .env.example           # Template for credentials
```

## Maintenance

### Cleanup old entries

Over time, the `shared_context` table will grow. To clean up old entries:

```sql
-- Delete entries older than 30 days
DELETE FROM shared_context WHERE created_at < now() - interval '30 days';

-- Delete entries that all known agents have acknowledged
DELETE FROM shared_context WHERE acked_by @> ARRAY['agent-a', 'agent-b'];
```

### Monitoring

Use the CLI to check health:

```bash
agent-bridge status
```

Use Supabase dashboard to monitor table size and query performance.

### Adding new agents

No schema changes needed. Just pick a unique agent name and start posting/reading. The `unacked_by` filter automatically works for any agent name.

### Adding new categories

Categories are free-form text: no schema change needed. Just start posting with a new category string. Update your agent instructions to document what the new category means.

## License

MIT
