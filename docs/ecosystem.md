# Agent Bridge in the agent ecosystem

Agent Bridge lets agents exchange messages and hand off work across tools, sessions,
and machines. It preserves each inbox through disconnections and restarts. It stores
immutable messages, read receipts, delivery claims, leases, retries, and replay state.
It does not own the full agent stack.

## System boundaries

| Layer | Examples | Relationship to Agent Bridge |
| --- | --- | --- |
| Tool and context access | MCP, CLI, HTTPS, Node library | These surfaces expose Agent Bridge operations. They do not define its stored message or delivery protocol. |
| Agent task semantics | A2A and application protocols | These systems own tasks, artifacts, status, and domain completion. Agent Bridge can carry their identifiers and payloads. |
| Durable mailbox | Agent Bridge | Agent Bridge owns cursored history, receipts, work claims, leases, retry state, and offline replay. |
| Live transport and brokers | SLIM, NATS, RabbitMQ, Kafka | A future adapter may use one of these systems for transport or wakeups. Cursored pull remains the recovery path. |
| Agent execution | Codex, Claude Code, OpenClaw, Hermes, Pi, LangGraph, AutoGen, agent-loop | These harnesses decide what runs and how workflows advance. Agent Bridge can carry messages when their host implements a supported access surface. |
| Local operator experience | agmsg and similar tools | These tools may provide terminal placement, agent spawning, roles, and local coordination. They can use Agent Bridge when they need its durable cross-machine state. |

[ADR-0001](decisions/0001-protocol-layers-and-acknowledgment-semantics.md)
defines the protocol boundary and the separate meanings of read receipts, delivery
settlement, and external task completion.
[ADR-0003](decisions/0003-host-adapters-and-consumer-instance-keys.md) defines
the host layers and consumer instance-key contract.
[ADR-0005](decisions/0005-retire-direct-supabase-runtime.md) keeps Supabase as a
PostgreSQL hosting option while removing its direct runtime adapter.

## Harnesses, hosts, adapters, and access

Agent Bridge keeps four integration concepts separate:

- A harness runs an agent loop, such as Codex, Claude Code, OpenClaw, Hermes, or Pi.
- A host is the CLI, desktop application, daemon, CI job, or service that contains the
  harness or invokes Agent Bridge.
- A host adapter configures that host to use Agent Bridge.
- An access surface is MCP over stdio, the CLI, the HTTPS API, or the Node library.

This distinction matters when one profile serves more than one host surface. The
`codex` adapter configures the profile shared by the Codex CLI and the Codex surface
in the ChatGPT desktop app. It does not create two independent Agent Bridge
registrations. Claude Code and Claude Desktop have separate adapters and registrations.

| Adapter or integration | Host coverage | Access | Support level |
| --- | --- | --- | --- |
| `codex` | Codex CLI and Codex in the ChatGPT desktop app | MCP stdio | Automated install |
| `claude-code` | Claude Code CLI | MCP stdio | Automated install |
| `claude-desktop` | Claude Desktop | MCP stdio | Automated install |
| `openclaw` | OpenClaw daemon or host | MCP stdio | Manifest included; operator-managed |
| `generic-mcp` | Any compatible MCP host | MCP stdio | Manifest included; operator-managed |
| Direct integration | Scripts, CI, daemons, and services | CLI, HTTPS, or Node library | No host adapter required |
| Generic harness integration | Hermes, Pi, and other harnesses | Any access surface their host supports | No dedicated adapter or conformance claim yet |

Scripts are orthogonal to harnesses. A script may start a harness, invoke the CLI,
call the HTTPS API, or embed the Node library. It is not a separate agent category.
The MCP server currently uses stdio. The gateway exposes the Agent Bridge HTTPS
protocol, not MCP over HTTP.

## Relationship to agmsg

Agent Bridge does not claim to replace agmsg's operator interface, process management,
terminal integration, or community. It treats agmsg as a useful client and adapter
reference.

The two projects meet at the storage and delivery boundary. An agmsg adapter could map
send, inbox, history, claim, and settlement operations onto Agent Bridge while keeping
agmsg's local interaction model. Agent Bridge would then provide durable history,
principal-bound identity, and cross-machine replay. The adapter must preserve Agent
Bridge receipt and lease semantics instead of creating a second state model.

## What Agent Bridge does not do

Agent Bridge is not:

- A workflow engine or scheduler.
- A memory or retrieval system.
- A terminal multiplexer or agent process manager.
- A replacement for A2A task semantics.
- An encrypted global network.
- A general-purpose event streaming platform.

These boundaries keep the protocol small enough to support clients from different
vendors without forcing every participant into the same runtime or deployment stack.

## Interoperability direction

The next interoperability work is tracked in [ROADMAP.md](../ROADMAP.md). Planned
surfaces include an agmsg adapter, a thin A2A envelope mapping, host-adapter conformance
fixtures, and client libraries. Each integration must retain caller-bound identity,
idempotent publication, cursored replay, and at-least-once delivery semantics.
