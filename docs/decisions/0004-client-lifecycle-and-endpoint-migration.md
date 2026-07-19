# ADR 0004: Client lifecycle ownership and endpoint migration

Status: accepted

Date: 2026-07-18

## Context

Agent Bridge can install Codex, Claude Code, and Claude Desktop registrations, but an
existing registration may have been created by an older package or by an operator.
Repair, update, uninstall, and endpoint migration must not silently take ownership of
such state. In particular, host configuration and per-client backend files may contain
credential-bearing references and queued gateway edge state.

Lifecycle unit 1 needs a safe ownership boundary before later mutating operations are
added. It must distinguish missing state, exact but unowned state, owned state, and
drift without probing a gateway or exposing backend configuration values.

## Decision

The CLI provides two local lifecycle operations for the three automated adapters:

- `clients inspect` is read-only. The operator supplies the expected runtime,
  identity, stable instance key, backend file path, launch command, and Claude Code
  scope when applicable. Inspection reads only the host registration, backend path
  existence, and managed metadata. It does not read backend values, contact the
  gateway, interpret connectivity health, rewrite a host config, or create metadata.
- `clients adopt` uses the same exact contract. Without `--apply` it returns a plan.
  With `--apply` it may create managed metadata only when inspection reports an exact
  unmanaged registration. Adoption never rewrites the registration or backend file.

Inspection returns one of four states:

- `absent`: the requested registration, backend file, and managed metadata are all absent.
- `unmanaged`: the host registration, identity, instance, backend path, scope, and
  launch contract are exact, the backend path and its immediate parent pass the
  no-link owner-only private-path policy, and metadata is absent.
- `managed`: the exact registration and backend file are accompanied by exact managed
  metadata.
- `drifted`: any other combination, including malformed or inexact registration,
  missing, insecure, or linked backend residue without a registration, stale metadata,
  or metadata that structurally differs from the requested contract.

Managed metadata uses schema `agent-bridge.client-management`, version 1, under the
owner-only `~/.agent-bridge/clients/` directory. It records only runtime, identity,
instance, absolute backend path, launch command and arguments, scope, and a nonsecret
registration locator. Claude Desktop records the normalized configuration path.
Codex records the active profile configuration path. Claude Code records scope and,
for local or project scope, the normalized invocation directory. Its native CLI does
not expose a stronger configuration locator. User scope has no directory context. A
later inspection from a different locator reports drift instead of guessing which
registration to mutate. Metadata never copies a token, backend setting, credential
identifier, URL, workspace, or backend file contents. Publication uses a private
same-directory temporary file, file fsync, atomic rename, private-path verification,
and directory fsync where supported.

Codex inspection compares the semantic registration fields in its real JSON MCP
description and ignores status, timeout, and transport diagnostic fields. JSON object
property order is not significant, while the environment must contain exactly the
three Agent Bridge keys. Claude Code inspection uses its native MCP description and
exact scope/removal contract but excludes connectivity status from registration
exactness. Claude Desktop inspection reads only the `agent-bridge` entry in its JSON
configuration and uses the installer's canonical resolver: an explicit executable is
validated, while the default is absolute Node plus the absolute server entry.

Identity, instance, backend, and command inputs are normalized before comparison and
metadata publication. Desktop configuration and Codex profile paths are normalized
before they become locators. Claude Code local and project adoption must run from the
directory that later lifecycle operations should use. After publication, adoption
re-inspects the live registration and fails if it changed. Inspection and plan-only
adoption preserve backend bytes, inode, and modification time. Applied adoption
writes only the management metadata described above; registration state and client
health remain separate authorities.

First-time `clients install` and enrollment behavior remains unchanged. A provision
enrollment still refuses an existing backend file or MCP registration, so adoption
cannot weaken first-install collision protection. This unit does not add repair,
update, uninstall, credential rotation, or endpoint mutation.

The next lifecycle unit adds only the crash-safe operation substrate and read-only
inspection. Revisioned manifests live below the owner-private
`~/.agent-bridge/operations/<uuid>` tree, snapshot contents remain private, and locks
serialize by runtime and stable instance. Stale recovery requires same-host PID-death
proof, with operation-root and locks identities pinned throughout recovery. Sensitive
file access pins its immediate directory, and snapshot enumeration and reads pin the
snapshots directory. The manifest contains an immutable ordered plan whose steps record
target kind, non-sensitive locator, unique snapshot artifact, expected before/after
digests, durable pre-write intent, and durable post-verification observed-applied state.
Snapshot publication is atomic and no-replace. Every bounded before-state snapshot must
match its step before mutation can start. Restart names the exact pending step: matching
before-state is retryable, matching after-state advances only after durable intent, and
every other state blocks as ambiguous. Linked, replaced, corrupt, oversized,
contradictory, or ambiguous state fails closed without changing external files, while
`clients operations [<operation-id>]` returns only safe summaries.

Public repair, update, uninstall, and endpoint-migration mutations remain deferred and
cannot ship before terminal snapshot cleanup. Active or ambiguous operations retain
their artifacts. After a terminal manifest is durable, cleanup must verify and unlink
each artifact, sync the directory where supported, and report uncertain durability.
Rollback status remains unavailable until reverse steps record durable intent and
verify restored bytes. Physical erasure is outside the filesystem contract. Future
commands must minimize credential-bearing snapshots and rotate credentials when
retained copies contained them.

## Consequences

Later lifecycle operations have an explicit local ownership record and can fail closed
on drift. Existing exact registrations require an intentional, reviewable adoption
step. Operators must retain the identity, stable instance key, backend path, and launch
contract needed to prove exactness. Endpoint migration remains deferred until it can
also preserve and prove gateway edge outbox state.
