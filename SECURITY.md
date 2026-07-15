# Security policy

## Supported versions

| Version | Security updates |
| --- | --- |
| 0.2.x | Supported until its successor is released |
| 0.1.x | Not supported |
| Unreleased development code | No public support guarantee |

Upgrade to the latest published package before reporting a defect that may already be
fixed. The npm package and GitHub release page are the public version authorities.

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

### Gateway mode

Gateway credentials bind one workspace and principal. The gateway derives remote
identity from the credential, applies operation scopes and rate policy, and uses
transaction-bound PostgreSQL request authority. Production runtime roles must not be
superusers or hold `BYPASSRLS`. Put every non-loopback gateway behind TLS.

Keep the schema-owner, runtime, operator, archive, backup, and restore database
authorities separate. Do not copy one client's token or backend file into another
client's configuration.

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

### Optional integrations

Agent Bridge does not require atrib or another provenance system. A signed wrapper is a
separate security and availability boundary. Keep a direct Agent Bridge path available
when wrapper health is uncertain.

## Secret handling

- Pass gateway tokens through private enrollment or backend files, not shell arguments.
- Keep database URLs in the documented environment variables. Do not put them in CLI
  arguments, logs, issues, or examples.
- Treat client backend files, enrollment files, archives, and DR bundles as secrets.
- Sanitize `doctor` output and logs before sharing them publicly.
