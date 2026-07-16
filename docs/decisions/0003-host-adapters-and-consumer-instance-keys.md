# ADR-0003: Separate host adapters from consumer instance keys

## Status

Accepted

## Date

2026-07-15

## Context

Agent products often combine an agent harness with a host application. Codex runs in
the Codex CLI and in the Codex surface of the ChatGPT desktop app. Claude Code and
Claude Desktop are separate hosts. OpenClaw, Hermes, Pi, scripts, CI jobs, and services
have different host and access options.

The released protocol also uses `AGENT_BRIDGE_INSTANCE` in several places. Supported
installers generate one value for each installed client, but the gateway accepts the
value from the caller. Calling it a registered process identity would promise an
authority check that the server does not perform.

## Decision

The integration model separates these concepts:

- A harness runs an agent loop.
- A host is a CLI, desktop application, daemon, job, or service that contains a
  harness or calls Agent Bridge.
- A host adapter configures a host to use Agent Bridge.
- MCP over stdio, the CLI, the HTTPS API, and the Node library are access surfaces.
- Scripts, CI jobs, and services may use an access surface directly without becoming
  agent harnesses.

The `codex` adapter configures the profile shared by the Codex CLI and the Codex
surface in the ChatGPT desktop app. Claude Code and Claude Desktop have separate
adapters. Their supported installation flows create separate host registrations and
instance keys. OpenClaw and generic MCP manifests are operator-managed. Hermes, Pi,
and other harnesses have no dedicated compatibility or conformance claim until an
adapter is tested.

`AGENT_BRIDGE_INSTANCE` is an optional caller-supplied stable consumer key. Supported
installers generate and persist one for each installed client. Direct clients should
generate and persist a value when they need separate consumer state or presence. The
gateway does not bind the value to an installer registration.

Unless `AGENT_BRIDGE_CURSOR` sets an explicit path, a present instance key selects
cursor storage. The key also selects delivery lease ownership and presence. Processes
that share one key also share those resources. When the key and explicit cursor path
are both absent, cursor storage uses the `default` path component. Delivery ownership
falls back to the principal, and presence is unavailable. The key is not a PID,
live-process identity, session, or conversation. Per-process presence requires a
separate additive identity.

The v1 client manifest key named `runtime` remains a compatibility field for the host
installation target. A future manifest version may rename it without changing the
meaning of `AGENT_BRIDGE_INSTANCE`.

## Consequences

The architecture diagram and compatibility matrix can list desktop apps, CLIs,
daemons, and direct callers without presenting them as one category.

Installer-generated keys work without a new protocol field. Direct client authors who
use a key are responsible for stable storage and uniqueness within a principal. Reusing
a key intentionally creates one shared delivery consumer and presence identity.

The current gateway does not prevent two callers from choosing the same key. Clients
must not treat an instance value as proof of process identity or server registration.

## Alternatives considered

### Treat the adapter name as the harness identity

Rejected because one adapter may configure more than one host surface. The `codex`
adapter is the current example.

### Treat every live process as an instance

Rejected because the released instance key already selects cursor paths, lease
ownership, and presence. Changing it on every process start would alter consumer
ownership and strand existing state.

### Bind instance keys to server-side registrations now

Deferred. Binding could prevent accidental key collisions, but it needs a migration,
credential rules, and direct-client enrollment semantics. The current gateway accepts
the caller-supplied key and must be documented honestly.
