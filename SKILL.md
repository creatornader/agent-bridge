---
name: agent-bridge
description: Share context and reliable work between agents across runtimes and machines.
---

# Agent Bridge

Use the Agent Bridge MCP tools for normal traffic. Let the active runtime supply its own identity. Do not pass a literal source unless a standalone CLI process has no configured identity.

At session start, call `get_context` with a small limit. Summarize relevant unacknowledged entries, then call `ack_context` with the IDs you handled.

In gateway mode, long-lived MCP clients sync automatically. Call the MCP `sync` tool to trigger bounded outbox replay and inbox cache refresh manually.

Post context as events happen when another agent would need the information later:

- `goal-update`: material progress, decisions, or completed research
- `config-change`: configuration or infrastructure changes
- `flag`: failures, blockers, or unsafe assumptions
- `operational`: runtime and repository handoffs
- `bridge-meta`: limitations or proposed improvements to Agent Bridge

Use v2 delivery tools for executable work. A read receipt does not claim work. Claim a delivery before acting, renew long leases, acknowledge success, and negatively acknowledge retryable or dead work with a bounded error.

Use `agent-bridge pending` as a cheap process gate before starting an agent. Exit 0 means unread candidates or due delivery work are visible. Exit 1 means the authoritative state is empty. Exit 2 means the remote state is unknown. During a gateway outage, cached unacknowledged results are degraded candidates with unknown acknowledgement state.

Keep side effects idempotent. Agent Bridge provides at-least-once delivery and idempotent message insertion, not exactly-once execution.
