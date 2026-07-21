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

## Legacy Supabase provider was removed

Agent Bridge 0.6.0 rejects `legacy`, `supabase`, `legacy-supabase`, and key-only
configurations. These names selected the direct PostgREST adapter in older releases.
Choose local mode for one machine or create a principal-bound gateway backend:

```bash
agent-bridge init --provider local
```

Do not point new clients at `public.shared_context`. If the old table still contains
data that has not been migrated, preserve it and follow the historical import and
reconciliation steps in the
[README](../README.md#upgrading-historical-supabase-deployments).

## Migration gate reported by status or doctor

`clients migrate stage` does not begin a drain. `clients migrate cutover
<stage-operation-id> --exclusive-edge --apply` changes the source edge to `draining`
after it verifies both live gateways and their route challenge. In that state, normal
publication is blocked while the recorded lease worker completes existing outbox work.
`doctor` reports `draining` as degraded. A `retired` scope rejects new publication and
`doctor` reports it as failed.

Do not delete the edge database, alter the gate tables, or reopen a retired scope by
hand. Inspect the operation ID reported by status. Resume the matching v6 operation
with `clients resume <operation-id> [--recover-lock]`. A new worker cannot take an
unexpired drain lease. It must wait for the lease to expire. Reverse before the
predecessor grace cutoff is not supported. To return to the earlier endpoint, first
rotate a new owner credential for that endpoint, then run an ordinary forward cutover
with it as the successor. Finalization after grace retires the source. If no matching
operation exists, preserve the database and stop rather than changing the gate
manually.

A dry migration plan refuses an edge with live `-wal` or `-shm` sidecars. Stop the
writer and let SQLite checkpoint its state, then retry the plan. The plan never opens
the edge in write mode to inspect it.

## Report a defect

Include the client name, operating system, package version, sanitized `doctor --json`
output, and whether the executable path is absolute. Remove tokens, database URLs,
message content, and private backend contents before posting an issue. Report possible
security defects through the private process in [SECURITY.md](../SECURITY.md).
