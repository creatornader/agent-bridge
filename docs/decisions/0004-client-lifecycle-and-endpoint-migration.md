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
cannot weaken first-install collision protection.

`clients repair`, `clients update`, and `clients uninstall` operate only on a strict
managed metadata record.
The runtime and stable instance locate that record. `--identity` must match the record
and the immutable request, but never locates it. These commands reject
backend path, scope, and config-path flags.
They plan without writing by default. A no-op exact registration creates no operation.

Repair restores the recorded launch. Update resolves a replacement launch before it
creates a journal. The update request records the identity, command, arguments, scope,
and fixed three Agent Bridge environment key names. It does not record their values.
Native launch arguments are empty. A native command is one executable contract. Bare
commands reject argument separators and URL-like surfaces. Absolute paths must resolve
to executable files before an update is journaled. Claude Desktop uses the installer's
absolute launch resolver. An action-specific resume uses that recorded request and
rejects another action, runtime, instance, identity, or replacement command.

Before a mutation starts, metadata load verifies the private management root, clients
directory, and metadata file. It rejects links, replacement, oversized files, unknown
keys, incorrect schema versions, malformed locators, and non-absolute backend paths.
The file is opened without following links and checked against its path identity before
the loader accepts it. The full record is loaded again after the client lock is acquired
and before every non-metadata mutation. Any difference blocks the operation.

Repair can tighten backend privacy only when that change removes access. Its journal
proofs contain the role, file identity, and private or repairable policy state. They
never contain backend bytes, credentials, URLs, workspace, or configuration values.
Links, disappearance, owner changes, replacement, and a permission change that would
grant new owner access fail closed. Windows accepts an already private backend path and
refuses a non-private one because the repair path cannot prove a monotonic ACL change.

Registration proofing records a bounded Agent Bridge observation and its full target
contract. Unknown environment keys, malformed values, unexpected scope, opaque fields,
or arguments outside the stored current or target launch stop before journal creation.
For Codex, get, remove, and add run with the recorded `CODEX_HOME` over the supplied
environment. Claude Code uses the recorded scope, invocation directory, and supplied
environment. Native changes remove, verify absence, add, verify the target, and write
changed metadata last. Claude Desktop reads the recorded JSON config without following
links or link ancestors, changes only `mcpServers.agent-bridge`, and publishes through
a private operation-scoped temporary file. It pins and rechecks the original file and
parent identities before rename, then verifies the final entry. Claude Desktop has no
cooperative transaction protocol. Node cannot guarantee a transaction against an
independent same-user writer.

The operation substrate remains internal with read-only inspection. Revisioned
manifests contain typed credential-agnostic requests, non-sensitive locators, and
unique no-replace before/after artifacts. Begin holds the runtime-plus-instance lock
while refusing another unfinished operation; a blocked journal fences new mutations and
resume. Resume is same-host only. Journal states
are prepared, snapshotted, in-progress, applied, cleaning, and committed. Inspection
separately reports resumable, classification-required, blocked, or complete.

Repair and uninstall journals use operation format version 3. New update journals use
v4 and carry a bounded credential-free inverse contract. Gateway migration staging
uses v5 and binds a managed identity, source and target endpoint digests, enrollment
credential IDs, a source edge database path and scope key, and a predecessor grace
cutoff. It contains no raw gateway URL or token. A version 2 journal keeps its released
request shape and remains inspectable. A non-terminal version 2 journal cannot resume
because it lacks an identity-bound request.

Creation pins the operation root before it publishes state. Cleanup pins that root,
the operation directory, and the snapshots directory before it records intent or
unlinks anything. Cleanup records durable intent per artifact, verifies and unlinks the pinned file, and
records POSIX directory sync or explicit Windows unavailability. An absent artifact is
safe only when intent predates the cleanup attempt. Inspection recognizes a verified
after artifact for the current intent-recorded step, but rejects other missing or extra
files. Committed means verified writes and removed artifacts. It drops requests, steps,
locators, digests, and artifact metadata while retaining a bounded credential-free
completion record for audit. Public repair, update, and uninstall use this substrate.

Uninstall is forward-only. It removes the managed registration and proves absence,
deletes the already private backend file, then deletes metadata. It refuses a backend
that still needs privacy repair, so it cannot loosen that policy as a side effect of
deletion. A later failure does not restore a registration, backend, or metadata file.
The uninstall plan never stores backend bytes. File deletion confirms the file and
private parent identities before unlink. POSIX syncs the parent directory after a
verified absence. Windows records unavailable directory durability. Node's pathname
unlink cannot provide a transaction against a same-user writer, so this is an advisory
race boundary. Desktop removes only `mcpServers.agent-bridge`.

`clients rollback <source-operation-id> --identity <name>` is plan-first and accepts
only a committed same-host v4 update source. `--apply` creates a new v4 `rollback`
operation. It verifies the asserted identity, prior nonsecret metadata and exact
registration contract, and the current forward metadata and registration digests.
Native rollback removes the forward registration, proves absence, adds the prior
registration, proves it, then writes prior metadata. Desktop replaces only
`mcpServers.agent-bridge` and writes prior metadata last. The source journal remains
unchanged. Reverse resume derives authority from its recorded source UUID and inverse
contract. A changed current state, v2 or v3 source, repair, uninstall, unsafe inverse
fields, or a different host fails closed. A failed forward update never rolls back
automatically. Repair remains monotonic. Uninstall recovery is re-enrollment.

`clients migrate stage <runtime> --identity <name> --instance <key>
--enrollment-file <path>` is plan-first. With `--apply`, it creates a private staged
successor backend and a credential-free v5 record without changing the managed
registration or active backend. It initializes the source edge gate and leaves its
state active. It probes active and staged bearer credentials and requires a
non-immediate predecessor grace cutoff. It neither drains the outbox nor authorizes a
cutover. It requires an absolute, normalized source edge database path and rejects
in-memory edge state. The stage does not prove that source and target URLs reach the
same database authority.

`clients resume <operation-id> [--recover-lock]` resumes v3 repair, update, and
uninstall requests, supported v4 update and rollback requests, and v5 migration-stage
requests. It derives action, runtime, instance, identity, launch, and reverse source
from the record and accepts no replacement client authority. It cannot resume a version
2 operation. It also completes an uninstall interrupted after metadata deletion and a
rollback interrupted after any ordered step. A later endpoint cutover is limited to
alternate URLs and must dynamically attest one logical database authority. Physical
erasure is outside the contract.

## Consequences

Managed repair, update, and uninstall have a narrow authority boundary and can fail
closed on drift, metadata corruption, ambiguous crash state, and unsafe backend policy
changes. Existing exact registrations still require intentional, reviewable adoption.
Migration staging preserves active state while it prepares later work. Endpoint cutover
remains deferred until it can preserve gateway edge outbox state and dynamically attest
the same logical database authority.
