# Deploy Agent Bridge

The repository includes a Compose stack for local development and a production image
definition. The Compose file is intentionally bound to loopback. It is useful for
evaluation, integration work, and the repository acceptance test. It is not a public
TLS deployment.

## Development stack

Requirements:

- Docker Engine or Docker Desktop with Compose v2.
- Node.js 22.23.1 or newer to generate private development secrets and run operator
  commands from the source checkout.
- Free loopback ports 8787 and 54329, or explicit replacement values.

Create two independent passwords. Keep the files out of version control.

```bash
mkdir -m 700 .secrets
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > .secrets/postgres_password
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > .secrets/runtime_password
chmod 600 .secrets/*
```

Build and start the stack:

```bash
docker compose build --pull gateway
docker compose up --wait gateway
curl --fail http://127.0.0.1:8787/readyz
```

The services start in this order:

1. PostgreSQL becomes healthy.
2. `migrate` applies the ordered schema with the schema-owner login and exits.
3. `bootstrap-runtime` creates or updates `agent_bridge_gateway`, grants the
   database-derived runtime role, and exits.
4. `gateway` starts with the restricted login and must pass `/readyz`.

The stack stores PostgreSQL data in the `postgres_data` named volume. `docker compose
down` removes containers and keeps the volume. `docker compose down --volumes` deletes
the development database. Inspect the project name and volume before using the second
command.

The default bindings are `127.0.0.1:8787` for the gateway and `127.0.0.1:54329` for
PostgreSQL. Override them without editing the file:

```bash
AGENT_BRIDGE_PORT=18787 \
AGENT_BRIDGE_POSTGRES_PORT=15432 \
docker compose up --wait gateway
```

Use the [owner enrollment workflow](../README.md#gateway-setup) to
create principal-bound credentials. Do not put a gateway token in the shared backend
config. Each installed client receives its own private backend file.

Run the same disposable proof as CI after building the TypeScript artifacts:

```bash
npm ci
npm run build
./scripts/compose-smoke.sh
```

The script creates a unique Compose project name that callers cannot override. It also
creates temporary database passwords, a temporary operator, and two principal
credentials. It proves source and workspace binding, targeted delivery, lease
settlement, short-password rejection, denied runtime access to credential hashes, and
message persistence through a full stack restart with a fresh edge cache. Its exit trap
removes the project volume, image tag, credentials, and temporary files.

## Production requirements

Use the image stages and service boundaries as inputs to the deployment platform. Do
not expose the checked-in Compose stack unchanged.

### Network and TLS

- Keep PostgreSQL on a private network. Do not publish port 5432 to the internet.
- Put every non-loopback gateway behind a TLS terminator. Forward only from the trusted
  proxy or ingress layer to the gateway's HTTP port.
- Restrict administrative database access to migration, owner-control, archive,
  backup, and restore jobs. Clients use the HTTPS gateway, not PostgreSQL.
- Apply request size, connection, and upstream timeouts at the proxy without retrying
  ambiguous mutations. Agent Bridge uses idempotency keys for safe publication replay.

### Images and process policy

- Build from the pinned Node base image and deploy an immutable image digest.
- Run the gateway with a read-only root filesystem, a small writable temporary
  filesystem, and `no-new-privileges`. The final gateway process must run as the
  non-root image user with no effective Linux capabilities.
- Compose file secrets retain host ownership on native Linux. The migration and gateway
  services therefore start a small Node entrypoint as root with `DAC_OVERRIDE`,
  `SETUID`, and `SETGID`. It reads the one granted secret, drops supplementary groups
  and UID/GID to 1000, then imports the requested module. The final process has no
  effective capabilities. The one-shot runtime bootstrap keeps `DAC_OVERRIDE`,
  `SETUID`, and `SETGID` while it reads the two secret files, then `gosu` runs its fixed
  SQL script as the PostgreSQL account. A production
  secret injector may mount the secret directly for the runtime UID and omit this
  handoff.
- Allow at least 30 seconds for graceful shutdown. Stop accepting traffic before
  terminating the process.
- Gate traffic on `/readyz`. Liveness alone does not prove migration, row-isolation,
  role, or protected-catalog readiness.

### Secrets and database roles

Keep these authorities separate:

| Authority | Purpose | Long-lived gateway access |
| --- | --- | --- |
| Schema owner | Ordered migrations and trusted role registration | Never |
| Runtime login | Gateway requests and readiness | Required |
| Control operator | Credential provision, inventory, rotation, and revocation | Never |
| Archive operator | Portable PostgreSQL archive operations | Never |
| Backup and restore | Native DR backup or restore | Never |

Use the platform's secret manager or private mounted secret files. Do not put raw
passwords, tokens, or complete database URLs in image layers, source control, command
arguments, deployment logs, or shared client config. Rotate each authority on its own
schedule and after any suspected exposure.

The runtime database password must contain at least 32 characters. The bootstrap job
fails before role creation or alteration when the mounted value is shorter.

## Fly.io reference hosting

[`deploy/fly.toml`](../deploy/fly.toml) is the maintained Fly gateway contract. It has
no app name, region, or release command. The operator chooses the account, app, region,
PostgreSQL service, and public hostname. Fly terminates HTTPS and forwards to port
8787. The service keeps at least one `shared-cpu-1x` machine with 512 MB running, checks
`GET /readyz`, and gives the Node process 30 seconds after SIGTERM to close listeners
and database pools.

Run the repository check before any Fly action:

```bash
npm run preflight:fly -- --json
```

The local check verifies Node, the Dockerfile, and the static Fly contract. If the app
already exists, add its name:

```bash
npm run preflight:fly -- --app <app> --json
```

With `--app`, the command invokes only read-only Fly commands. It observes the active
account, app status, effective config, machines, and secret names. Its JSON includes
names and check results but never environment-variable values. A passing local check
does not prove that an external resource exists or that deployment is safe.

The long-running Fly machine may receive only the restricted
`AGENT_BRIDGE_RUNTIME_DATABASE_URL` database authority. Do not give it
`AGENT_BRIDGE_DATABASE_URL`, `AGENT_BRIDGE_OPERATOR_DATABASE_URL`,
`AGENT_BRIDGE_RUNTIME_PASSWORD`, a client bearer token, or a Supabase client key. The
preflight rejects those names. Keep schema-owner, control-operator, archive, and DR
authority in separate operator jobs.

### Operator order and gates

The following actions change external state and require an operator gate. The
repository does not perform them:

1. Create or select the Fly app and PostgreSQL authority. Keep PostgreSQL private.
2. Run the read-only production database preflight before any backup or migration:

   ```bash
   AGENT_BRIDGE_DATABASE_URL="..." npm run preflight:postgres:production -- --json --require-ssl
   ```

   The command opens a read-only transaction and reports only nonsecret capability
   and schema facts. It checks supported server majors, migration-role authority,
   migration-ledger drift, derived-role collisions, and the legacy import shape.
   `--require-ssl` is required for a public database endpoint. The preflight cannot
   prove that later DDL will succeed.
3. Take and verify a native DR backup when upgrading an existing authority.
4. Run `agent-bridge migrate` once in an isolated job with
   `AGENT_BRIDGE_DATABASE_URL`. Drain old gateways first when the migration notes
   require it.
5. Run [`deploy/bootstrap-runtime.sql`](../deploy/bootstrap-runtime.sql) through a
   separate trusted PostgreSQL session. Supply the schema-owner connection and the
   runtime password to that job only.
6. Construct the restricted runtime URL, set only
   `AGENT_BRIDGE_RUNTIME_DATABASE_URL` on the Fly app, and run the app-aware read-only
   preflight.
7. Deploy the immutable image with `fly deploy --config deploy/fly.toml --app <app>`.
   Require `/readyz` before routing clients.
8. Run authenticated capability and status probes, then publish, pull, claim, and
   settle a disposable targeted delivery.
9. Move clients only after the gateway proof passes. Preserve every source edge store
   until its outbox is empty.

App creation, database provisioning, secret writes, migration, bootstrap, deployment,
traffic changes, and client cutover are all gated external actions. The preflight is
read-only and cannot authorize any of them.

### Fly rollback boundary

Before migration, stop a failed deployment and keep the prior image and authority. A
failed image rollout after a compatible migration can return traffic to the prior
image only if that image accepts the current schema. Never assume that an older image
can run against newer migrations.

After clients publish through the new gateway, preserve both authorities and every
edge database. Stop the cutover, drain queued outboxes, and reconcile authoritative
messages before choosing one authority. If schema or data recovery is required,
restore the verified native DR bundle into a fresh target and switch authority once.
Do not run the source and restored database as active authorities at the same time.

The manual `gateway production proof` GitHub Actions workflow runs this acceptance
proof against an existing HTTPS gateway. GitHub restricts it to `main`, and every job
uses the approval-protected `agent-bridge-production-proof` environment. Configure
`PROOF_SENDER_TOKEN`, `PROOF_RECEIVER_TOKEN`, `PROOF_HOST_SALT`, and `FLY_API_TOKEN` as
environment secrets. The sender and receiver credentials must bind the requested
workspace to the dedicated `proof-sender` and `proof-receiver` principals. The
sender credential needs `messages:write` and `messages:read`. The receiver needs
`messages:read`, `deliveries:claim`, `deliveries:settle`, and `deliveries:read`.

Run the workflow only when the Fly app has exactly one gateway machine. The cycle job
restarts that machine and queries the Fly Machines API before and after. It fails
unless the machine ID stays fixed, the runtime `instance_id` changes, the machine
returns to `started`, and `/readyz` succeeds. This changes production compute and
requires environment approval. It does not migrate the database or change secrets.

The sender first uses an unreachable loopback origin to force a leased publication
into its private SQLite outbox. It then synchronizes that row to the supplied gateway
and repeats the publication with the same idempotency key. A separate host finds the
exact message through `proof-receiver`, claims its delivery, and acknowledges it.
After the Fly machine cycle, the verifier uses a fresh instance key, edge database,
and cursor. It reads the immutable message and confirms that the prior delivery is
still `acked`.

Each phase writes an `agent-bridge-production-proof-v1` receipt. The runner rejects
unknown fields at the phase boundary and checks every receipt before use. Receipts may
record IDs, timestamps, principal and workspace labels, the gateway origin, boolean
checks, and salted SHA-256 host evidence. They never record bearer values, database
URLs, environment values, message content, lease tokens, cursor files, or edge
databases. Download all four workflow artifacts for the operator record. A passing
repository test still does not replace a completed external workflow run.

### Persistent data and backup

A database volume or managed PostgreSQL disk keeps runtime state. It does not protect
against operator error, catalog drift, account loss, or regional failure.

- Schedule native PostgreSQL DR backups with the exact PostgreSQL major tools.
- Store verified bundles on a separate failure domain.
- Record retention and deletion policy separately from message immutability.
- Run restore drills into a fresh database with the same name and PostgreSQL major.
- Never activate the source and restored target as authorities at the same time.

Portable archives complement native DR when an operator needs one workspace's messages
and eligible read receipts. They do not contain credentials, delivery state,
owner-control state, or security events.

## Upgrade procedure

1. Confirm the target image supports the deployed PostgreSQL major and current protocol
   clients.
2. Drain or preserve each gateway client's SQLite outbox. Do not discard an edge store
   with queued publications.
3. Drain old gateway instances or remove them from traffic before migration 017, then
   keep them out of traffic before migration 018. An old process can serve ordinary
   requests until it exits even though its `/readyz` probe
   fails after the newer migration is applied.
4. Create and verify a native DR backup.
5. Stop schema-changing jobs other than the selected migration job.
6. Run the new image's migration command once with schema-owner authority.
7. Run the runtime bootstrap with separate runtime-login credentials.
8. Start the new gateway and require `/readyz`, an authenticated capability probe, and
   an authenticated status probe.
9. Send, read, claim, and settle a disposable targeted delivery.
10. Roll clients forward only after the gateway proof passes.
11. Keep the previous authority available but inactive until the observation window
    closes.

Run one migration job at a time. The migration ledger makes ordered application
idempotent, but it does not make concurrent deployment orchestration desirable.

## Rollback boundaries

| Failure point | Safe response |
| --- | --- |
| Before schema migration | Stop the new gateway and return to the prior image and configuration. |
| After migration, before client rollout | Keep clients on the old authority. Apply a forward fix, or restore the verified backup into a fresh target. |
| After clients have published through the new gateway | Stop further cutover. Preserve every edge database and credential until queued outboxes are zero. Reconcile authoritative messages before switching back. |
| Database corruption or unrecoverable catalog drift | Restore native DR into a fresh target, verify readiness, then switch authority once. |

An older gateway may refuse a database with a newer migration plan. Starting the old
image is therefore not a general schema rollback. A volume snapshot is also not enough
unless its consistency and restore procedure have been proved for the database setup.
Migration 017 makes this readiness failure explicit for an old compiled migration
plan. It does not terminate an already-running old gateway. Drain it before applying
the migration.

## Operational checks

- `/healthz` proves the HTTP process is alive.
- `/readyz` proves the gateway can use the restricted database and that required
  security attestations still match.
- `agent-bridge doctor --json` probes a configured client's remote path.
- `agent-bridge status` is passive and reports remote reachability as unknown until a
  probe occurs.
- Gateway metrics require a credential with `gateway:metrics`.

Alert on readiness failure, repeated authorization denial, rate-limit pressure,
database connection exhaustion, due or blocked outbox rows, dead-letter growth, backup
failure, and restore-test failure. Keep tokens, database URLs, message content, and DR
bundle paths out of telemetry.

Related references:

- [Architecture](architecture-v2.md)
- [Security policy](../SECURITY.md)
- [Troubleshooting](troubleshooting.md)
- [Portable archives and native DR](../README.md#portable-archives)
