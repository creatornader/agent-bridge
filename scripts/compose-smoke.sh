#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f dist/cli.js ]]; then
  printf '%s\n' "dist/cli.js is missing. Run npm run build first." >&2
  exit 1
fi

for command in docker node jq curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf '%s\n' "$command is required for the Compose smoke test." >&2
    exit 1
  fi
done

docker compose version >/dev/null

umask 077
temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
proof_dir="$(mktemp -d "${temp_root%/}/agent-bridge-compose-smoke.XXXXXX")"
proof_dir="$(cd "$proof_dir" && pwd -P)"
secret_dir="$proof_dir/secrets"
enrollment_dir="$proof_dir/enrollments"
mkdir -m 700 "$secret_dir" "$enrollment_dir"

random_suffix="$(node -e "process.stdout.write(require('node:crypto').randomBytes(8).toString('hex'))")"
suffix="$(date +%s)-$$-$random_suffix"
project="agent-bridge-smoke-$suffix"
operator_login="ab_smoke_$(printf '%s' "$suffix" | tr -cd '0-9')"
workspace="compose-smoke-$suffix"
gateway_port="${AGENT_BRIDGE_PORT:-8787}"
postgres_port="${AGENT_BRIDGE_POSTGRES_PORT:-54329}"
gateway_url="http://127.0.0.1:$gateway_port"
image_tag="smoke-$suffix"

node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" >"$secret_dir/postgres_password"
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" >"$secret_dir/runtime_password"
operator_password="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
membership_request="$(node -e "process.stdout.write(require('node:crypto').randomUUID())")"
request_a="$(node -e "process.stdout.write(require('node:crypto').randomUUID())")"
request_b="$(node -e "process.stdout.write(require('node:crypto').randomUUID())")"

export AGENT_BRIDGE_IMAGE_TAG="$image_tag"
export AGENT_BRIDGE_PORT="$gateway_port"
export AGENT_BRIDGE_POSTGRES_PORT="$postgres_port"
export AGENT_BRIDGE_POSTGRES_PASSWORD_FILE="$secret_dir/postgres_password"
export AGENT_BRIDGE_RUNTIME_PASSWORD_FILE="$secret_dir/runtime_password"

compose=(docker compose -p "$project")

assert_gateway_process() {
  "${compose[@]}" exec -T --user node gateway sh -ec '
    found=0
    for process in /proc/[0-9]*; do
      command_name="$(cat "$process/comm" 2>/dev/null)" || continue
      case "$command_name" in node | MainThread) ;; *) continue ;; esac
      command_line="$(tr "\000" " " <"$process/cmdline" 2>/dev/null)" || continue
      case "$command_line" in
        *"dist/gateway-main.js"*)
          uid="$(grep "^Uid:" "$process/status" | cut -f2)"
          effective="$(grep "^CapEff:" "$process/status" | cut -f2)"
          if [ "$uid" = "1000" ] && [ "$effective" = "0000000000000000" ]; then
            found=1
          else
            printf "%s\n" "gateway process policy mismatch: uid=$uid CapEff=$effective" >&2
          fi
          ;;
      esac
    done
    if [ "$found" != "1" ]; then
      printf "%s\n" "gateway process with dropped privileges was not found" >&2
      for process in /proc/[0-9]*; do
        command_name="$(cat "$process/comm" 2>/dev/null)" || continue
        command_line="$(tr "\000" " " <"$process/cmdline" 2>/dev/null)" || continue
        printf "%s\n" "$command_name: $command_line" >&2
      done
      exit 1
    fi
  '
}

cleanup() {
  local exit_status=$?
  set +e
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1
  docker image rm "agent-bridge-gateway:$image_tag" >/dev/null 2>&1
  if [[ -d "$proof_dir" ]]; then
    find "$proof_dir" -depth -delete
  fi
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${compose[@]}" build --pull gateway
"${compose[@]}" up -d --wait gateway
assert_gateway_process
gateway_container="$("${compose[@]}" ps -q gateway)"
container_environment="$(docker inspect "$gateway_container" --format '{{json .Config.Env}}')"
postgres_password="$(tr -d '\r\n' <"$secret_dir/postgres_password")"
runtime_password="$(tr -d '\r\n' <"$secret_dir/runtime_password")"
if [[ "$container_environment" == *"$postgres_password"* \
  || "$container_environment" == *"$runtime_password"* ]]; then
  printf '%s\n' "A database password leaked into the container environment." >&2
  exit 1
fi

printf '%s' "too-short" >"$secret_dir/runtime_password"
set +e
short_password_result="$("${compose[@]}" run --rm --no-deps bootstrap-runtime 2>&1)"
short_password_status=$?
set -e
printf '%s' "$runtime_password" >"$secret_dir/runtime_password"
if [[ $short_password_status -eq 0 || "$short_password_result" != *"division by zero"* ]]; then
  printf '%s\n' "The runtime bootstrap accepted a password shorter than 32 characters." >&2
  exit 1
fi

"${compose[@]}" run --rm --no-deps bootstrap-runtime >/dev/null

derived_owner="$("${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -Atc \
  "SELECT 'agent_bridge_data_owner_' || substr(md5(current_database()), 1, 16)")"
derived_owner_before="$("${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -Atc \
  "SELECT rolcanlogin::text || ':' || (rolpassword IS NULL)::text FROM pg_authid WHERE rolname='$derived_owner'")"
set +e
derived_owner_result="$("${compose[@]}" run --rm --no-deps \
  -e AGENT_BRIDGE_RUNTIME_LOGIN="$derived_owner" bootstrap-runtime 2>&1)"
derived_owner_status=$?
set -e
derived_owner_after="$("${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -Atc \
  "SELECT rolcanlogin::text || ':' || (rolpassword IS NULL)::text FROM pg_authid WHERE rolname='$derived_owner'")"
if [[ $derived_owner_status -eq 0 || "$derived_owner_result" != *"division by zero"* \
  || "$derived_owner_before" != "false:true" || "$derived_owner_after" != "$derived_owner_before" ]]; then
  printf '%s\n' \
    "The runtime bootstrap mutated or accepted a derived authority role: status=$derived_owner_status before=$derived_owner_before after=$derived_owner_after." >&2
  exit 1
fi

foreign_derived_role="agent_bridge_runtime_0123456789abcdef"
"${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE \"$foreign_derived_role\" NOLOGIN INHERIT" >/dev/null
foreign_derived_before="$("${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -Atc \
  "SELECT rolcanlogin::text || ':' || (rolpassword IS NULL)::text FROM pg_authid WHERE rolname='$foreign_derived_role'")"
set +e
foreign_derived_result="$("${compose[@]}" run --rm --no-deps \
  -e AGENT_BRIDGE_RUNTIME_LOGIN="$foreign_derived_role" bootstrap-runtime 2>&1)"
foreign_derived_status=$?
set -e
foreign_derived_after="$("${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -Atc \
  "SELECT rolcanlogin::text || ':' || (rolpassword IS NULL)::text FROM pg_authid WHERE rolname='$foreign_derived_role'")"
"${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -v ON_ERROR_STOP=1 \
  -c "DROP ROLE \"$foreign_derived_role\"" >/dev/null
if [[ $foreign_derived_status -eq 0 || "$foreign_derived_result" != *"division by zero"* \
  || "$foreign_derived_before" != "false:true" || "$foreign_derived_after" != "$foreign_derived_before" ]]; then
  printf '%s\n' "The runtime bootstrap mutated or accepted a foreign derived authority role." >&2
  exit 1
fi

runtime_group="$("${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -Atc \
  "SELECT 'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16)")"
reverse_login="ab_bootstrap_reverse_$(printf '%s' "$suffix" | tr -cd '0-9')"
reverse_member="ab_bootstrap_member_$(printf '%s' "$suffix" | tr -cd '0-9')"
"${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE \"$reverse_login\" LOGIN INHERIT PASSWORD '$operator_password'" \
  -c "CREATE ROLE \"$reverse_member\" NOLOGIN INHERIT" \
  -c "GRANT \"$runtime_group\" TO \"$reverse_login\"" \
  -c "GRANT \"$reverse_login\" TO \"$reverse_member\"" >/dev/null
reverse_password_before="$("${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -Atc \
  "SELECT rolpassword FROM pg_authid WHERE rolname='$reverse_login'")"
set +e
reverse_result="$("${compose[@]}" run --rm --no-deps \
  -e AGENT_BRIDGE_RUNTIME_LOGIN="$reverse_login" bootstrap-runtime 2>&1)"
reverse_status=$?
set -e
reverse_password_after="$("${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -Atc \
  "SELECT rolpassword FROM pg_authid WHERE rolname='$reverse_login'")"
"${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -v ON_ERROR_STOP=1 \
  -c "DROP ROLE \"$reverse_member\"" -c "DROP ROLE \"$reverse_login\"" >/dev/null
if [[ $reverse_status -eq 0 || "$reverse_result" != *"division by zero"* \
  || -z "$reverse_password_before" || "$reverse_password_after" != "$reverse_password_before" ]]; then
  printf '%s\n' "The runtime bootstrap mutated or accepted a login with a reverse membership edge." >&2
  exit 1
fi

cross_owner_database="ab_bootstrap_owned_$(printf '%s' "$suffix" | tr -cd '0-9')"
cross_owner_login="ab_bootstrap_cross_$(printf '%s' "$suffix" | tr -cd '0-9')"
"${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE \"$cross_owner_login\" LOGIN INHERIT PASSWORD '$operator_password'" \
  -c "GRANT \"$runtime_group\" TO \"$cross_owner_login\"" >/dev/null
"${compose[@]}" exec -T postgres createdb -U postgres "$cross_owner_database"
"${compose[@]}" exec -T postgres psql -U postgres -d "$cross_owner_database" \
  -v ON_ERROR_STOP=1 -c "CREATE SCHEMA bootstrap_owned AUTHORIZATION \"$cross_owner_login\"" >/dev/null
cross_owner_password_before="$("${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -Atc \
  "SELECT rolpassword FROM pg_authid WHERE rolname='$cross_owner_login'")"
set +e
cross_owner_result="$("${compose[@]}" run --rm --no-deps \
  -e AGENT_BRIDGE_RUNTIME_LOGIN="$cross_owner_login" bootstrap-runtime 2>&1)"
cross_owner_status=$?
set -e
cross_owner_password_after="$("${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -Atc \
  "SELECT rolpassword FROM pg_authid WHERE rolname='$cross_owner_login'")"
"${compose[@]}" exec -T postgres dropdb -U postgres "$cross_owner_database"
"${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -v ON_ERROR_STOP=1 \
  -c "DROP ROLE \"$cross_owner_login\"" >/dev/null
if [[ $cross_owner_status -eq 0 || "$cross_owner_result" != *"division by zero"* \
  || -z "$cross_owner_password_before" || "$cross_owner_password_after" != "$cross_owner_password_before" ]]; then
  printf '%s\n' "The runtime bootstrap mutated or accepted a login that owns an object in another database." >&2
  exit 1
fi

managed_database="ab_bootstrap_managed_$(printf '%s' "$suffix" | tr -cd '0-9')"
managed_owner="ab_bootstrap_owner_$(printf '%s' "$suffix" | tr -cd '0-9')"
managed_login="ab_bootstrap_runtime_$(printf '%s' "$suffix" | tr -cd '0-9')"
"${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE \"$managed_owner\" LOGIN INHERIT NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS" \
  -c "CREATE DATABASE \"$managed_database\" OWNER \"$managed_owner\"" >/dev/null
managed_runtime_group="$("${compose[@]}" exec -T postgres psql -U postgres -d "$managed_database" -Atc \
  "SELECT 'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16)")"
"${compose[@]}" exec -T postgres psql -U "$managed_owner" -d "$managed_database" -v ON_ERROR_STOP=1 \
  -c "CREATE SCHEMA agent_bridge AUTHORIZATION \"$managed_owner\"" \
  -c "CREATE ROLE \"$managed_runtime_group\" NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS" >/dev/null
for _ in 1 2; do
  "${compose[@]}" exec -T \
    -e AGENT_BRIDGE_RUNTIME_LOGIN="$managed_login" \
    -e AGENT_BRIDGE_RUNTIME_PASSWORD="$operator_password" \
    postgres psql -U "$managed_owner" -d "$managed_database" -v ON_ERROR_STOP=1 -f - \
    < deploy/bootstrap-runtime.sql >/dev/null
done
managed_edge_proof="$("${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -Atc "
  WITH edges AS (
    SELECT granted.rolname AS granted, member.rolname AS member,
           membership.grantor, membership.admin_option,
           (to_jsonb(membership)->>'inherit_option')::boolean AS inherit_option,
           (to_jsonb(membership)->>'set_option')::boolean AS set_option
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid=membership.roleid
    JOIN pg_roles member ON member.oid=membership.member
    WHERE (granted.rolname='$managed_runtime_group' AND member.rolname='$managed_login')
       OR granted.rolname='$managed_login'
  )
  SELECT
    count(*) FILTER (WHERE granted='$managed_runtime_group' AND member='$managed_login'
      AND NOT admin_option AND inherit_option AND set_option),
    count(*) FILTER (WHERE granted='$managed_login' AND member='$managed_owner'
      AND grantor=10 AND admin_option AND NOT inherit_option AND NOT set_option),
    count(*)
  FROM edges")"
"${compose[@]}" exec -T postgres dropdb -U postgres "$managed_database"
"${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -v ON_ERROR_STOP=1 \
  -c "DROP ROLE \"$managed_login\"" \
  -c "DROP ROLE \"$managed_runtime_group\"" \
  -c "DROP ROLE \"$managed_owner\"" >/dev/null
if [[ "$managed_edge_proof" != "1|1|2" ]]; then
  printf '%s\n' "The runtime bootstrap did not preserve the expected PostgreSQL 16 managed membership edges." >&2
  exit 1
fi

rollback_database="ab_bootstrap_rollback_$(printf '%s' "$suffix" | tr -cd '0-9')"
rollback_login="ab_bootstrap_login_$(printf '%s' "$suffix" | tr -cd '0-9')"
"${compose[@]}" exec -T postgres createdb -U postgres "$rollback_database"
"${compose[@]}" exec -T postgres psql -U postgres -d "$rollback_database" \
  -v ON_ERROR_STOP=1 -c "CREATE SCHEMA agent_bridge AUTHORIZATION postgres" >/dev/null
set +e
rollback_result="$("${compose[@]}" run --rm --no-deps \
  -e PGDATABASE="$rollback_database" \
  -e AGENT_BRIDGE_RUNTIME_LOGIN="$rollback_login" bootstrap-runtime 2>&1)"
rollback_status=$?
set -e
rollback_role_count="$("${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge -Atc \
  "SELECT count(*) FROM pg_roles WHERE rolname='$rollback_login'")"
"${compose[@]}" exec -T postgres dropdb -U postgres "$rollback_database"
if [[ $rollback_status -eq 0 || "$rollback_result" != *"does not exist"* \
  || "$rollback_role_count" != "0" ]]; then
  printf '%s\n' "The runtime bootstrap did not roll back a role after later validation failed." >&2
  exit 1
fi

curl --fail --silent --show-error "$gateway_url/readyz" >"$proof_dir/ready.json"
jq -e '.status == "ready"' "$proof_dir/ready.json" >/dev/null

"${compose[@]}" exec -T postgres createuser -U postgres \
  --login --no-superuser --no-createdb --no-createrole --no-bypassrls \
  "$operator_login"
"${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge \
  -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE \"$operator_login\" PASSWORD '$operator_password'" >/dev/null
"${compose[@]}" exec -T postgres psql -U postgres -d agent_bridge \
  -v ON_ERROR_STOP=1 \
  -c "SELECT * FROM agent_bridge.register_control_member('$membership_request'::uuid,'$operator_login'::name,'operator')" \
  >/dev/null

operator_url="postgresql://$operator_login:$operator_password@127.0.0.1:$postgres_port/agent_bridge"
AGENT_BRIDGE_OPERATOR_DATABASE_URL="$operator_url" \
AGENT_BRIDGE_ENROLLMENT_DIR="$enrollment_dir" \
AGENT_BRIDGE_URL="$gateway_url" \
node dist/cli.js owner provision \
  --request-id "$request_a" \
  --workspace "$workspace" \
  --workspace-name "Compose smoke" \
  --identity smoke-a \
  --runtime codex \
  --instance smoke-a-instance \
  --scope-set release-a-full >"$proof_dir/provision-a.json"
AGENT_BRIDGE_OPERATOR_DATABASE_URL="$operator_url" \
AGENT_BRIDGE_ENROLLMENT_DIR="$enrollment_dir" \
AGENT_BRIDGE_URL="$gateway_url" \
node dist/cli.js owner provision \
  --request-id "$request_b" \
  --workspace "$workspace" \
  --workspace-name "Compose smoke" \
  --identity smoke-b \
  --runtime claude-code \
  --instance smoke-b-instance \
  --scope-set release-a-full >"$proof_dir/provision-b.json"

enrollment_a="$(jq -r '.enrollmentFile' "$proof_dir/provision-a.json")"
enrollment_b="$(jq -r '.enrollmentFile' "$proof_dir/provision-b.json")"
token_a="$(jq -r '.token' "$enrollment_a")"
token_b="$(jq -r '.token' "$enrollment_b")"

set +e
forged_result="$(env -i \
  HOME="$proof_dir" PATH="$PATH" TMPDIR="$proof_dir" \
  AGENT_BRIDGE_PROVIDER=gateway \
  AGENT_BRIDGE_URL="$gateway_url" \
  AGENT_BRIDGE_TOKEN="$token_a" \
  AGENT_BRIDGE_WORKSPACE="$workspace" \
  AGENT_BRIDGE_AGENT=forged \
  AGENT_BRIDGE_INSTANCE=smoke-a-instance \
  AGENT_BRIDGE_EDGE_DB="$proof_dir/edge-forged.sqlite3" \
  node dist/cli.js send "forged source" 2>&1)"
forged_status=$?
set -e
if [[ $forged_status -eq 0 || "$forged_result" != *"principal_mismatch"* ]]; then
  printf '%s\n' "The gateway accepted a principal mismatch." >&2
  exit 1
fi

set +e
wrong_workspace_result="$(env -i \
  HOME="$proof_dir" PATH="$PATH" TMPDIR="$proof_dir" \
  AGENT_BRIDGE_PROVIDER=gateway \
  AGENT_BRIDGE_URL="$gateway_url" \
  AGENT_BRIDGE_TOKEN="$token_a" \
  AGENT_BRIDGE_WORKSPACE="$workspace-wrong" \
  AGENT_BRIDGE_AGENT=smoke-a \
  AGENT_BRIDGE_INSTANCE=smoke-a-instance \
  AGENT_BRIDGE_EDGE_DB="$proof_dir/edge-wrong-workspace.sqlite3" \
  node dist/cli.js send "wrong workspace" 2>&1)"
wrong_workspace_status=$?
set -e
if [[ $wrong_workspace_status -eq 0 || "$wrong_workspace_result" != *"principal_mismatch"* ]]; then
  printf '%s\n' "The gateway accepted a workspace mismatch." >&2
  exit 1
fi

client_a=(env -i
  HOME="$proof_dir" PATH="$PATH" TMPDIR="$proof_dir"
  AGENT_BRIDGE_PROVIDER=gateway
  AGENT_BRIDGE_URL="$gateway_url"
  AGENT_BRIDGE_TOKEN="$token_a"
  AGENT_BRIDGE_WORKSPACE="$workspace"
  AGENT_BRIDGE_AGENT=smoke-a
  AGENT_BRIDGE_INSTANCE=smoke-a-instance
  AGENT_BRIDGE_EDGE_DB="$proof_dir/edge-a.sqlite3")
client_b=(env -i
  HOME="$proof_dir" PATH="$PATH" TMPDIR="$proof_dir"
  AGENT_BRIDGE_PROVIDER=gateway
  AGENT_BRIDGE_URL="$gateway_url"
  AGENT_BRIDGE_TOKEN="$token_b"
  AGENT_BRIDGE_WORKSPACE="$workspace"
  AGENT_BRIDGE_AGENT=smoke-b
  AGENT_BRIDGE_INSTANCE=smoke-b-instance
  AGENT_BRIDGE_EDGE_DB="$proof_dir/edge-b.sqlite3")

"${client_a[@]}" node dist/cli.js send \
  --target smoke-b \
  --delivery-mode leased \
  --idempotency-key compose-smoke-proof \
  "persistent compose message" >"$proof_dir/send.json"
message_id="$(jq -r '.message.id' "$proof_dir/send.json")"

"${client_b[@]}" node dist/cli.js inbox --limit 10 >"$proof_dir/inbox.json"
jq -e --arg id "$message_id" \
  '.messages | any(.id == $id and .source == "smoke-a")' \
  "$proof_dir/inbox.json" >/dev/null

"${client_b[@]}" node dist/cli.js claim --lease-ms 30000 >"$proof_dir/claim.json"
delivery_id="$(jq -r '.delivery.id' "$proof_dir/claim.json")"
lease_token="$(jq -r '.leaseToken' "$proof_dir/claim.json")"
[[ "$(jq -r '.delivery.messageId' "$proof_dir/claim.json")" == "$message_id" ]]
"${client_b[@]}" node dist/cli.js ack \
  --delivery-id "$delivery_id" \
  --lease-token "$lease_token" >"$proof_dir/ack.json"
[[ "$(jq -r '.state' "$proof_dir/ack.json")" == "acked" ]]

set +e
runtime_read="$("${compose[@]}" exec -T \
  -e PGPASSWORD="$runtime_password" \
  postgres psql -U agent_bridge_gateway -d agent_bridge \
  -v ON_ERROR_STOP=1 -Atc \
  "select token_hash from agent_bridge.credentials limit 1" 2>&1)"
runtime_status=$?
set -e
if [[ $runtime_status -eq 0 || "$runtime_read" != *"permission denied"* ]]; then
  printf '%s\n' "The runtime login could read credential hashes." >&2
  exit 1
fi

"${compose[@]}" down
"${compose[@]}" up -d --wait gateway
assert_gateway_process
curl --fail --silent --show-error "$gateway_url/readyz" >"$proof_dir/ready-after-restart.json"

env -i \
  HOME="$proof_dir" PATH="$PATH" TMPDIR="$proof_dir" \
  AGENT_BRIDGE_PROVIDER=gateway \
  AGENT_BRIDGE_URL="$gateway_url" \
  AGENT_BRIDGE_TOKEN="$token_b" \
  AGENT_BRIDGE_WORKSPACE="$workspace" \
  AGENT_BRIDGE_AGENT=smoke-b \
  AGENT_BRIDGE_INSTANCE=smoke-b-restart \
  AGENT_BRIDGE_EDGE_DB="$proof_dir/edge-b-after-restart.sqlite3" \
  node dist/cli.js inbox --limit 10 >"$proof_dir/inbox-after-restart.json"
jq -e --arg id "$message_id" \
  '.messages | any(.id == $id and .source == "smoke-a")' \
  "$proof_dir/inbox-after-restart.json" >/dev/null

printf '%s\n' \
  "Compose gateway smoke passed." \
  "Principal and workspace binding, delivery settlement, denied credential-hash reads, and volume persistence are verified."
