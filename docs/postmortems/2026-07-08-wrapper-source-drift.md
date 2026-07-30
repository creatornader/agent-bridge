# 2026-07-08 Agent Bridge Wrapper Source Drift

## Status

Resolved for Codex, Claude Code, and Claude Desktop availability.

The public package now owns the local MCP path. Each client has a public
`agent-bridge-loopback-host` launchd service that binds only its assigned
loopback port and serves `/mcp/health` plus Streamable HTTP MCP. Claude Desktop
uses the public `agent-bridge-stdio-http-proxy` to reach its local host. The
client services read owner-private backend files, so registrations do not need
to duplicate gateway credentials.

The broken Codex, Claude Code, and Claude Desktop signed-wrapper launchd jobs
were removed after their labels stayed loaded while `/mcp/health` refused
connections. The wrapper remains an optional signed attribution layer outside
the public Agent Bridge runtime.

## Impact

Codex, Claude Code, and Claude Desktop could not use Agent Bridge through MCP
while their client configs pointed at signed HTTP wrapper ports:

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

The first public-host release also exposed a package-distribution defect. npm
executes package bins through a symlink, while the host and proxy used a source
file entrypoint check that compared the unresolved `argv[1]` path. Their
install commands therefore returned success without starting a service.

The release workflow published valid npm versions but did not create matching
GitHub Release objects. This made the release page incomplete and left older
titles inconsistent.

During recovery, the wrapper installer also selected `node` from ambient
`PATH`. That allowed restarts to drift to a local Node shim instead of the
Homebrew Node binary that had previously run the service.

## Fixes

- The public package provides a long-lived loopback host, health endpoint, and
  Claude Desktop stdio proxy. It installs launchd services only after health
  proves the socket is listening, and uninstalls them only after the socket
  closes.
- The host and proxy resolve the invoked file before deciding whether to run as
  a CLI. Their global npm bins now work through npm's symlink layout.
- Package-install smoke invokes both public binaries. This catches a silent
  entrypoint failure before publication.
- Local Codex, Claude Code, and Claude Desktop registrations now point to the
  public client-owned loopback services. The dead private wrapper jobs were
  uninstalled.
- Tagged releases now create one immutable GitHub Release after the gateway and
  npm gates pass. New release pages use `Agent Bridge v<version>`. A tag-based
  recovery verifies the immutable package already in npm before continuing.

## Wrapper Policy

Agent Bridge must run fully from its public package. Keep the signed wrapper
for attribution receipts and local-substrate metadata only. Do not make it an
availability boundary for Codex, Claude Code, Claude Desktop, or another MCP
client.

An active launchd label is not proof that Agent Bridge MCP is available. The
proof is a successful public `/mcp/health` probe and a real MCP tool call. New
versions use an immutable `v<version>` tag and the GitHub Release title `Agent
Bridge v<version>`.

## Verification

- A global-package launchd install bound a disposable loopback port, passed
  `/mcp/health`, then unbound the port after uninstall.
- Each production Codex, Claude Code, and Claude Desktop public host passed
  `/mcp/health`, completed an MCP handshake, listed 17 tools, and accepted a
  `post_context` write.
- Each client registration and its identity, instance, and private backend file
  passed managed-client inspection.
- The three private wrapper labels are absent. The three public launchd labels
  are running and own ports 8794, 8793, and 8791.
