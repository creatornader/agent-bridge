# ADR-0001: Define protocol layers and acknowledgment semantics

## Status

Accepted

## Date

2026-07-14

## Context

Agent Bridge overlaps with agent protocols, client interfaces, message transports, and task systems. Without a firm boundary, an access adapter can become the protocol, transport state can be mistaken for task state, and different acknowledgments can acquire conflicting meanings.

Agent Bridge needs to serve agents across clients, sessions, processes, and machines without owning every protocol above or transport below it.

## Decision

Agent Bridge is the durable, pull-first mailbox and work-delivery control plane for intermittently connected agent runtimes.

Its protocol owns:

- Immutable messages and cursored history.
- Read receipts.
- Targeted work deliveries.
- Claims, leases, retries, settlement, and dead-letter state.
- Principal-bound identity and workspace isolation.
- Durable replay after disconnection.

The surrounding layers have separate responsibilities:

- A2A and application protocols sit above Agent Bridge. They own task, conversation, artifact, and domain lifecycle semantics.
- MCP, CLI, HTTPS, and the Node library are access surfaces. They expose Agent Bridge operations without defining its stored protocol.
- Optional transports such as SLIM or NATS may sit below the core as wakeup or transport adapters. They must not replace authoritative cursor replay or durable delivery state.
- agmsg is a reference for adapters, interoperability, and client experience. Its patterns may inform clients, but it does not define Agent Bridge identity, persistence, or delivery semantics.

A2A task IDs or application status may travel through Agent Bridge fields and payloads. Agent Bridge does not infer a task lifecycle from message or delivery state.

## Acknowledgment semantics

| Operation | Meaning | State changed | It does not mean |
| --- | --- | --- | --- |
| Read receipt | A principal records that it has read or handled a message. | Receipt record | Work ownership, delivery settlement, or task completion |
| Delivery claim | One principal and instance own a delivery until its lease expires. | Delivery state and lease | The message was read or the work succeeded |
| Lease extension | The active owner renews its claim. | Lease expiry | Progress, success, or task completion |
| Delivery acknowledgment | The worker finished processing the delivery and Agent Bridge may stop redelivery. | Delivery becomes `acked` | A read receipt or an external task status |
| Delivery negative acknowledgment | The worker releases the delivery for retry or marks it dead. | Delivery becomes `retrying` or `dead` | An A2A task failure, cancellation, or rejection |
| External task completion | An application or A2A task reaches a domain-defined terminal state. | State owned above Agent Bridge | Any automatic receipt or delivery transition |

The interfaces use overlapping names, so documentation must identify the surface:

- MCP `ack_context` and CLI `acknowledge` write read receipts.
- MCP `acknowledge` and CLI `ack` settle claimed deliveries.
- MCP `negative_acknowledge` and CLI `nack` negatively settle claimed deliveries.
- MCP `extend` and CLI `extend` renew a lease.

Read receipts and delivery settlement remain independent in both directions. Recording a receipt does not consume or settle work. Settling a delivery does not create a receipt.

## Consequences

Agent Bridge can carry A2A messages without implementing the A2A task state machine. A client that needs both task completion and delivery settlement must record both operations explicitly.

MCP remains replaceable by another access surface. A host or transport integration must preserve cursors, idempotency, identity binding, and delivery leases.

Push notifications and future brokers can reduce wakeup latency. Pull and replay remain the recovery path.

Adapters inspired by agmsg must map into Agent Bridge semantics rather than creating a second receipt, identity, or delivery model.

## Alternatives considered

### Make MCP the Agent Bridge protocol

Rejected because MCP is one client interface. CLI, HTTPS, and future clients need the same stored semantics.

### Own the full task lifecycle

Rejected because A2A and applications define richer task and artifact state. Duplicating that state would create conflicting authorities.

### Require a broker as the shared authority

Rejected for the current architecture. PostgreSQL already provides durable shared state, while cursored pull supports intermittent clients without another required service.

### Adopt agmsg semantics as the core

Rejected because Agent Bridge must persist messages across machines, bind principals to credentials, replay from cursors, and manage leased deliveries. agmsg remains useful as an adapter and interface reference.
