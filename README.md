# Agent Bridge

Shared context MCP server for heterogeneous AI agent coordination. Enables Sido (OpenClaw always-on assistant) and Claude Code (interactive dev sessions) to share context without manual relay.

## Architecture

Both agents talk to Supabase via HTTPS REST API. No shared filesystem needed — works from Mac, Pi 3B+, or Hetzner VPS.

```
Supabase (shared_context table)
       |              |
   HTTPS REST     HTTPS REST
       |              |
  MCP Server      CLI (bash+curl)
  (TypeScript)    agent-bridge
       |              |
  Claude Code      Sido (OpenClaw)
```

## Setup

### 1. Install dependencies
```bash
npm install && npm run build
```

### 2. Create config
```bash
mkdir -p ~/.agent-bridge
cat > ~/.agent-bridge/config <<EOF
AGENT_BRIDGE_URL=https://your-project.supabase.co
AGENT_BRIDGE_KEY=your-anon-key
EOF
```

### 3. Claude Code (MCP server)
Added to `~/.claude.json` mcpServers. Restart Claude Code to pick it up.

### 4. OpenClaw (CLI)
CLI at `~/.openclaw/scripts/agent-bridge`, added to safeBins in `openclaw.json`.

## Usage

### From Claude Code (MCP tools)
```
post_context(source: "claude-code", category: "config-change", content: "Updated bird-read wrapper", project: "openclaw-setup")
get_context(unacked_by: "claude-code")
ack_context(ids: [1, 2], agent: "claude-code")
```

### From CLI (Sido / terminal)
```bash
agent-bridge post --source sido --category operational "Morning briefing delivered"
agent-bridge get --unacked-by sido --limit 10
agent-bridge ack --ids 1,2,3 --agent sido
agent-bridge status
```

### Categories
- `operational` — runtime status, health, delivery confirmations
- `config-change` — settings or wrapper modifications
- `goal-update` — goal progress, new goals, completion
- `flag` — urgent alerts, blockers, warnings
- `bridge-meta` — suggested improvements to the Agent Bridge itself

### Priorities
- `info` (default) — normal context sharing
- `high` — should be read soon
- `urgent` — needs immediate attention

## Development

```bash
npm run dev    # watch mode
npm run build  # production build
npm start      # run server
```
