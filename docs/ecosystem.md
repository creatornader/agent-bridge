# Agent Bridge in the agent ecosystem

Agent Bridge is a durable mailbox and work-delivery control plane for agent runtimes
that may disconnect, restart, or move between machines. It stores immutable messages,
read receipts, delivery claims, leases, retries, and replay state. It does not own the
full agent stack.

## System boundaries

| Layer | Examples | Relationship to Agent Bridge |
| --- | --- | --- |
| Tool and context access | MCP | Agent Bridge exposes MCP tools. MCP does not define Agent Bridge's stored message or delivery protocol. |
| Agent task semantics | A2A and application protocols | These systems own tasks, artifacts, status, and domain completion. Agent Bridge can carry their identifiers and payloads. |
| Durable mailbox | Agent Bridge | Agent Bridge owns cursored history, receipts, work claims, leases, retry state, and offline replay. |
| Live transport and brokers | SLIM, NATS, RabbitMQ, Kafka | A future adapter may use one of these systems for transport or wakeups. Cursored pull remains the recovery path. |
| Agent execution | LangGraph, AutoGen, agent-loop, hosted agent platforms | These systems decide what runs and how workflows advance. Agent Bridge carries messages between them. |
| Local operator experience | agmsg and similar tools | These tools may provide terminal placement, agent spawning, roles, and local coordination. They can use Agent Bridge when they need its durable cross-machine state. |

[ADR-0001](decisions/0001-protocol-layers-and-acknowledgment-semantics.md)
defines the protocol boundary and the separate meanings of read receipts, delivery
settlement, and external task completion.

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
surfaces include an agmsg adapter, a thin A2A envelope mapping, runtime conformance
fixtures, and client libraries. Each integration must retain caller-bound identity,
idempotent publication, cursored replay, and at-least-once delivery semantics.
