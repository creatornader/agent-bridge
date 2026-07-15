# Troubleshooting Agent Bridge

Start with the command line even when the failure appears inside an MCP client:

```bash
agent-bridge doctor --json
```

`doctor` checks the configured backend and reports named failures. It exits 0 when the
client is ready, 2 when it is degraded, and 1 when a required check fails. `status` is
passive and does not test remote reachability.

## MCP server disconnected or could not attach

An MCP client must be able to start the server in its own process environment. Desktop
applications do not always inherit the `PATH` from an interactive shell, so the normal
Claude Desktop installer records an absolute Node executable and an absolute server
entry point.

1. Reinstall the Claude Desktop registration:

   ```bash
   agent-bridge clients install claude-desktop --identity claude-desktop
   ```

2. Restart Claude Desktop completely. Closing only its window may leave the old process
   running.

3. Run `agent-bridge doctor --json` again from a shell.

Use `--command` only when an operator intentionally maintains a separate executable.
Pass an absolute path:

```bash
agent-bridge clients install claude-desktop \
  --identity claude-desktop \
  --command "$(command -v agent-bridge-mcp)"
```

Claude Desktop stores its Agent Bridge registration under `mcpServers.agent-bridge` in:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%/Claude/claude_desktop_config.json`

The registered environment must contain distinct `AGENT_BRIDGE_AGENT`,
`AGENT_BRIDGE_INSTANCE`, and `AGENT_BRIDGE_CONFIG` values for that client. Do not copy
another client's identity or backend file into the entry.

## The executable is missing

Install the published package globally, then repeat the normal client installation:

```bash
npm install --global @creatornader/agent-bridge
agent-bridge clients install claude-desktop --identity claude-desktop
```

The normal Claude Desktop registration does not depend on the application's inherited
`PATH`. If an explicit `--command` override is necessary, locate that executable and
pass its absolute path.

## Identity mismatch

The active runtime owns its identity. Shared backend config must not contain
`AGENT_BRIDGE_AGENT`, and one client must not claim another client's source label.

Check the client registration and its private backend file. Reinstall that client with
its intended principal if the values differ. Do not work around the error by adding a
literal `--source` for normal MCP traffic.

## Gateway failures

Use the doctor output to distinguish local edge health from remote reachability.

- `unknown` means no active probe established remote state.
- `degraded` can mean cached inbox data or queued outbox messages remain usable while
  the gateway is unavailable.
- `failed` means a required local or remote check did not pass.

Queued sends retain their idempotency keys. Long-lived MCP clients retry them, and
`agent-bridge sync` triggers the same bounded replay manually. Claims, lease changes,
delivery settlement, presence, and read-receipt writes still require the gateway.

## Report a defect

Include the client name, operating system, package version, sanitized `doctor --json`
output, and whether the executable path is absolute. Remove tokens, database URLs,
message content, and private backend contents before posting an issue. Report possible
security defects through the private process in [SECURITY.md](../SECURITY.md).
