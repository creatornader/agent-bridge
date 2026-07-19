# Security policy

## Supported versions

| Version | Security updates |
| --- | --- |
| 0.3.x | Supported |
| 0.2.x | Not supported |
| 0.1.x | Not supported |
| Unreleased development code | No public support guarantee |

Upgrade to the latest published package before reporting a defect that may already be
fixed. The npm package and GitHub release page are the public version authorities.

## Release integrity

GitHub immutable releases are enabled, and GitHub reports release `v0.3.1` as
immutable. A repository ruleset also blocks updates and deletion for every `v*` tag
without a bypass actor. The `v0.3.1` tag is unsigned.

npm publication uses a protected GitHub environment, an OIDC trusted-publisher
binding, and provenance for the package artifact. Verify the package digest and
attestation before treating provenance as source identity. The
[`v0.3.1` release run](https://github.com/creatornader/agent-bridge/actions/runs/29465467036)
used package commit `d17ba544d31beaa33b4955e41c3b3d4e3f141900`.

The historical `v0.3.0`
[recovery run](https://github.com/creatornader/agent-bridge/actions/runs/29461308262)
checked out package commit `95eb861`, while its attestation names recovery commit
`c23d9df` as the workflow identity. GitHub Actions logs expire, so the
[release notes](https://github.com/creatornader/agent-bridge/releases/tag/v0.3.0)
also record this boundary. Recovery dispatches must run at the release tag. The
workflow also requires a successful `test.yml` run from `main` for the exact package
commit before packaging.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/creatornader/agent-bridge/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

Include the affected version, provider mode, operating system, reproduction steps, and
the security boundary that failed. Remove bearer tokens, raw credential files, database
URLs, message content, archive data, and disaster-recovery bundles. The maintainer will
coordinate disclosure and remediation through the private advisory.

## Security boundaries

### Local mode

Local mode relies on operating-system account isolation and private file permissions.
Anyone who can act as the same operating-system user can generally read or replace that
user's Agent Bridge state. Local mode is not a hostile multi-user boundary.

Managed-client mutations may cache a successful native Windows ACL check while one
operation lock remains held. The cache is bound to the verified directory identity and is
discarded with the lock. New locks, resumed operations, and passive inspection check
the ACL again. POSIX permission checks are not cached. A same-user process can still
change an ACL on an unchanged object or replace a directory with one that reuses the
same filesystem identity. Both actions are within the local-mode trust boundary.

### Gateway mode

Gateway credentials bind one workspace and principal. The gateway derives remote
identity from the credential, applies operation scopes and rate policy, and uses
transaction-bound PostgreSQL request authority. Production runtime roles must not be
superusers or hold `BYPASSRLS`. Put every non-loopback gateway behind TLS.

Do not publish PostgreSQL on a public interface. Put it on a private network reachable
only by the migration, runtime bootstrap, gateway, backup, and recovery jobs that need
it. The checked-in Compose file binds both published ports to loopback and serves plain
HTTP for local development. It is not a public deployment template.

Keep the schema-owner, runtime, operator, archive, backup, and restore database
authorities separate. Do not copy one client's token or backend file into another
client's configuration.

Run migrations as a one-shot schema-owner job before starting a new gateway image.
Take and verify a native DR backup first. Gateway readiness checks the exact migration
plan and protected catalog state. Once a migration changes the database, starting an
older image is not a safe rollback. Apply a forward fix or restore the backup into a
fresh target and switch authority only after verification.

Drain old gateway instances before migration 017. An old image reports `/readyz` as
not ready after the new migration is visible, but a process that was already running
can still serve ordinary requests until traffic is removed or it exits. Start the new
gateway only after the migration and runtime bootstrap finish.

### Legacy Supabase mode

The legacy adapter keeps existing v1 deployments working, but its publishable key can
call the underlying PostgREST table and receipt RPC directly. Adapter checks therefore
provide cooperative behavior, not the same workspace and principal isolation as the
authenticated gateway. Do not use legacy mode as a hostile multi-tenant boundary.

### Archives and disaster recovery

Portable archives and native DR bundles may contain message content, routing metadata,
credentials, or database state. Their hashes detect changed bytes. They do not encrypt
the files or authenticate their source. Store them as private data and transfer them
through a separately trusted channel.

PostgreSQL restore executes SQL from the source dump. Use
`--accept-source-sql-risk` only for a bundle from a trusted source. Never activate the
source and restored target as authorities at the same time.
The restored gateway authority UUID identifies the same logical authority. It does not
prevent an operator from activating a live clone, so the deployment cutover remains an
operator-controlled safety boundary.

### Optional integrations

Agent Bridge does not require atrib or another provenance system. A signed wrapper is a
separate security and availability boundary. Keep a direct Agent Bridge path available
when wrapper health is uncertain.

## Secret handling

- Pass gateway tokens through private enrollment or backend files, not shell arguments.
- Keep database URLs in the documented environment variables. Do not put them in CLI
  arguments, logs, issues, or examples.
- Store Compose password files outside version control with owner-only permissions.
  Use the deployment platform's secret manager in production. Do not bake passwords or
  tokens into images, Compose environment blocks, or image layers.
- File-backed Compose secrets retain host ownership on native Linux. The development
  stack starts a small Node entrypoint as root with `DAC_OVERRIDE`, `SETUID`, and
  `SETGID`, reads one granted secret, then drops supplementary groups and UID/GID to
  1000 before it imports the gateway. The final process has no effective capabilities
  and cannot regain them under `no-new-privileges`. The fixed runtime-bootstrap job
  keeps `DAC_OVERRIDE`, `SETUID`, and `SETGID` while it reads its two secrets, then runs
  `psql` as the PostgreSQL account. It rejects runtime passwords shorter than 32
  characters.
- Treat client backend files, enrollment files, archives, and DR bundles as secrets.
- Sanitize `doctor` output and logs before sharing them publicly.

A Docker volume provides persistence, not backup. Keep verified native DR bundles on a
separate failure domain with retention and restore drills appropriate to the deployment.
