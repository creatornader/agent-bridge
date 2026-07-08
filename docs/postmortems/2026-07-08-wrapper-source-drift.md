# 2026-07-08 Agent Bridge Wrapper Source Drift

## Status

Resolved for basic Codex, Claude Code, and Claude Desktop availability.

Codex, Claude Code, and Claude Desktop now launch the source repo MCP server
directly from `/Users/naderhelmy/repos/agent-bridge/dist/index.js` with
`/opt/homebrew/bin/node`. The direct server reads credentials from
`~/.agent-bridge/config`, so client configs no longer need to duplicate the
Supabase URL or anon key.

The broken Codex, Claude Code, and Claude Desktop `agent-bridge-atrib` launchd
jobs were removed after their labels stayed loaded while `/mcp/health` refused
connections. The wrapper code still exists as an optional signed attribution
layer.

## Impact

Codex, Claude Code, and Claude Desktop could not use Agent Bridge through MCP
while their client configs pointed at the `agent-bridge-atrib` HTTP wrapper
ports:

- Codex: `http://127.0.0.1:8794/mcp`
- Claude Code: `http://127.0.0.1:8793/mcp`
- Claude Desktop: `http://127.0.0.1:8791/mcp`

The source repo CLI and Supabase connection stayed healthy. The outage was in
the local wrapper path and client wiring, not in the shared context database.

## Root Cause

The live client configs made the wrapper the only MCP path. That turned an
optional signing layer into the availability boundary for Agent Bridge.

The wrapper launchd jobs also treated process supervision as enough. A label
could be loaded while the HTTP health route was unavailable. Nothing moved the
clients back to the source MCP server when `/mcp/health` failed.

The source MCP server made the fallback harder than it should have been because
it required `AGENT_BRIDGE_URL` and `AGENT_BRIDGE_KEY` in process env. The CLI
already read `~/.agent-bridge/config`, so the two source-repo entrypoints had
drifted.

During recovery, the wrapper installer also selected `node` from ambient
`PATH`. That allowed restarts to drift to a local Node shim instead of the
Homebrew Node binary that had previously run the service.

## Fixes

- `src/server.ts` now reads `~/.agent-bridge/config` when env credentials are
  absent. Env values still take precedence.
- `test/server_factory.test.ts` covers config-file fallback, env precedence,
  quoted config values, explicit config paths, and missing credentials.
- Local Codex, Claude Code, and Claude Desktop configs now launch the source
  MCP server directly with `/opt/homebrew/bin/node` and only set
  `AGENT_BRIDGE_AGENT`.
- The dead Codex, Claude Code, and Claude Desktop wrapper launchd jobs were
  uninstalled.
- `atrib-internal/tools/install-agent-bridge-http-host.sh` now prefers
  `/opt/homebrew/bin/node` by default while still honoring `NODE_BIN`.

## Wrapper Policy

Keep `agent-bridge-atrib` for signed atrib receipts and local-substrate metadata.
Do not make it the only Agent Bridge path for Codex, Claude Code, or Claude
Desktop.

Only reinstall those wrapper jobs as active client targets after the wrapper has
health-based supervision. A loaded launchd label is not proof that Agent Bridge
MCP is available. The proof is a successful `/mcp/health` probe and a real MCP
tool call.

## Verification

- `npm test`: 24 tests passed.
- `npm run build`: passed.
- Direct stdio MCP smoke: listed `post_context`, `get_context`, and
  `ack_context`, then read live context.
- CLI status: returned `{"status":"ok","message":"Agent Bridge is connected to Supabase"}`.
- Claude Desktop launch proof: fresh Desktop log showed `initialize` and
  `tools/list` succeeding against `/opt/homebrew/bin/node
  /Users/naderhelmy/repos/agent-bridge/dist/index.js`.
- Wrapper cleanup: Codex, Claude Code, and Claude Desktop wrapper labels are
  absent, and their launchd plist files are absent.
