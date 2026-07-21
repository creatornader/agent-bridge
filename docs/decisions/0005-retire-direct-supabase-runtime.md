# ADR-0005: Retire the direct Supabase runtime

Status: accepted

Date: 2026-07-21

## Context

Early Agent Bridge releases could read and write `public.shared_context` through
Supabase PostgREST with a publishable key. That adapter kept the first deployment
working while the canonical protocol and gateway were built.

The adapter could not provide the gateway's security or delivery model. Its shared key
did not bind a principal or workspace. Its schema had no delivery leases, offline
outbox, presence, scoped credentials, or transaction-bound request authority. Keeping
it as a runtime provider also made every public contract describe a weaker third mode.

Supabase remains a useful managed PostgreSQL host. The problem is the direct client API,
not the database service.

## Decision

Agent Bridge 0.6.0 supports two runtime providers:

- `local`, backed by SQLite.
- `gateway`, backed by an authenticated Agent Bridge gateway with PostgreSQL authority
  and a local SQLite edge store.

The package no longer exports or constructs the direct Supabase store. It rejects
`legacy`, `supabase`, `legacy-supabase`, and key-only configurations with an upgrade
message.

Historical migration support remains:

- `sql/setup.sql` records the v1 schema shape.
- Migration 006 imports `public.shared_context` rows and receipts.
- `reconcile-legacy-projects` repairs the imported workspace and project mapping.
- Released HTTP 2.0 and MCP compatibility tools remain independent protocol contracts.

## Consequences

Remote clients now use one authenticated boundary and one capability model. Supabase
deployments can continue to host the canonical PostgreSQL database without exposing
PostgREST to Agent Bridge clients.

Operators upgrading an old direct deployment must preserve the source, run the
historical import, provision principal-bound gateway credentials, and change client
configuration before installing 0.6.0. A running direct client cannot upgrade in place
without that provider change.

The removed adapter is not a promise to delete historical migration code. Migration
fixtures remain until the project adopts an explicit migration-support window.
