---
name: agent-bridge
description: Share context and reliable work between agents across runtimes and machines.
---

# Agent Bridge

Use the Agent Bridge MCP tools for normal traffic. Let the active runtime supply its own identity. Do not pass a literal source unless a standalone CLI process has no configured identity.

At session start, call `get_context` with a small limit. Summarize relevant unacknowledged entries, then call `ack_context` with the IDs you handled.

Post context as events happen when another agent would need the information later:

- `goal-update`: material progress, decisions, or completed research
- `config-change`: configuration or infrastructure changes
- `flag`: failures, blockers, or unsafe assumptions
- `operational`: runtime and repository handoffs
- `bridge-meta`: limitations or proposed improvements to Agent Bridge

Use v2 delivery tools for executable work. A read receipt does not claim work. Claim a delivery before acting, renew long leases, acknowledge success, and negatively acknowledge retryable or dead work with a bounded error.

Use `agent-bridge pending` as a cheap process gate before starting an agent. Exit 0 means unread context or due delivery work exists. Exit 1 means neither exists. Treat network errors as unknown state, not as an empty queue.

Keep side effects idempotent. Agent Bridge provides at-least-once delivery and idempotent message insertion, not exactly-once execution.
