# ADR-0002: Canonical operation contract registry

## Status

Accepted

## Date

2026-07-14

## Context

Agent Bridge v2 exposed the same operations through MCP, HTTPS, and the CLI, but schemas and surface metadata were maintained separately. That allowed request shapes, capability descriptions, and generated documentation to drift. Package, MCP implementation, protocol, and database migration versions also have different compatibility lifecycles.

## Decision

`src/contracts/registry.ts` is the canonical v2 operation registry. Each operation owns its request and response schemas, reserved authorization scope metadata, provider availability, and surface metadata. The generator writes checked-in JSON Schema 2020-12, OpenAPI 3.1.2, MCP manifest, and capability documents from that registry.

External requests pass closed structural schema validation before domain validation. Responses require their known fields and accept additive unknown properties. MCP and HTTP 2.1 claim responses use `{ delivery, leaseToken? }`, and delivery controls use `{ delivery }`. HTTP 2.0 and the unversioned CLI retain direct or null delivery results. Public send requests may supply an immutable message `id`, but never a workspace. An optional `source` is an identity assertion and must match the active principal.

Authenticated HTTP operations negotiate with `X-Agent-Bridge-Protocol-Version`. Version 2.1 is current. A missing request header selects 2.0, and the gateway accepts exactly 2.0 and 2.1. Other versions return 426 with `unsupported_protocol_version`. An upgraded gateway returns the selected version in `X-Agent-Bridge-Protocol-Version` and its supported versions in `X-Agent-Bridge-Supported-Protocol-Versions`. Gateway errors use one envelope with a stable code and request ID.

The HTTP 2.1 client performs and caches a read-only status probe before its first mutation. Negotiation succeeds only when `X-Agent-Bridge-Protocol-Version` equals `2.1` and `X-Agent-Bridge-Supported-Protocol-Versions` includes `2.1`. A headerless response is classified as a released d8184fe 2.0 gateway. A selected 2.0 response, either missing response header, or contradictory values cause the client to reject mutation with a gateway-upgrade error. The client does not downgrade to the 2.0 wire contract.

Compatibility runs in the other direction. An upgraded gateway continues to serve released headerless and explicit 2.0 clients with their original message, delivery, and direct or null response shapes. This makes gateway-first deployment mandatory: deploy the upgraded gateway, verify 2.0 clients, and only then install or start 2.1 clients. Capability output reports current, selected, and supported versions separately.

The OpenAPI paths require protocol 2.1. The `x-agent-bridge-protocol-2.0` and `x-agent-bridge-schemas-2.0` vendor extensions provide limited metadata and frozen schemas for the released compatibility contract. They do not define a second set of paths or a separate OpenAPI description.

Capability documents are filtered by surface and provider. HTTP capability discovery
requires a valid credential but no named scope. Gateway operations enforce the scopes
declared by the registry, while local mode uses process identity and reports scope
enforcement as false. [ADR-0005](0005-retire-direct-supabase-runtime.md) removed the
legacy runtime provider from this contract.

Package version, MCP implementation version, Agent Bridge protocol version, and migration version remain independent. The MCP server reports the explicit `MCP_IMPLEMENTATION_VERSION` constant instead of the npm package version.

## Consequences

- `npm run contracts:generate` updates artifacts and `npm run contracts:check` rejects drift.
- The npm package includes the generated schema and OpenAPI directories.
- New v2 operations must be added to the registry before surface wiring.
- Legacy `post_context`, `get_context`, and `ack_context` remain separate frozen compatibility contracts.
- Protocol 2.1 deployments upgrade and verify the gateway before upgrading clients.
- This decision adds no task semantics and requires no database migration.

## Related

- [ADR-0001](0001-protocol-layers-and-acknowledgment-semantics.md) defines the protocol layers and acknowledgment meanings.
- [ADR-0005](0005-retire-direct-supabase-runtime.md) removes the direct Supabase runtime provider.
- [Architecture v2](../architecture-v2.md) describes the system that follows these decisions.
- The [README](../../README.md) documents public setup and upgrade behavior.
