#!/usr/bin/env bash
# Start and reconcile the production sweeper using only the deployment-owned
# Compose identity. This is the supported recovery surface for a stopped or
# mis-started scheduler; it never starts, stops, rebuilds, or recreates an
# engine service.
set -Eeuo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.deploy.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
COMPOSE_OVERRIDE_FILE="${COMPOSE_OVERRIDE_FILE:-}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"
TICK_TIMEOUT_SECONDS="${TICK_TIMEOUT_SECONDS:-240}"
TICK_POLL_SECONDS="${TICK_POLL_SECONDS:-2}"

die() {
  local code="$1"
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

require_absolute_directory() {
  local label="$1" path="$2"
  [[ "$path" == /* && -d "$path" ]] ||
    die 2 "$label must be an existing absolute directory: $path"
}

require_regular_file() {
  local label="$1" path="$2"
  [[ "$path" == /* && -f "$path" && -r "$path" && ! -L "$path" ]] ||
    die 2 "$label must be an absolute, readable, regular non-symlink file: $path"
}

require_bounded_positive_integer() {
  local label="$1" value="$2" maximum="$3"
  [[ "$value" =~ ^[1-9][0-9]*$ && "$value" -le "$maximum" ]] ||
    die 2 "$label must be a positive integer no greater than $maximum."
}

require_bounded_positive_integer TICK_TIMEOUT_SECONDS "$TICK_TIMEOUT_SECONDS" 600
require_bounded_positive_integer TICK_POLL_SECONDS "$TICK_POLL_SECONDS" 10

require_absolute_directory APP_DIR "$APP_DIR"
require_absolute_directory AIRFOILS_PRO_STATE_DIR "$AIRFOILS_PRO_STATE_DIR"
APP_DIR_REAL="$(cd -P -- "$APP_DIR" && pwd)"
STATE_DIR_REAL="$(cd -P -- "$AIRFOILS_PRO_STATE_DIR" && pwd)"
EXPECTED_ENV_FILE="$STATE_DIR_REAL/.env.deploy"
EXPECTED_COMPOSE_FILE="$APP_DIR_REAL/docker-compose.deploy.yml"
DEPLOY_SCRIPT_DIR="$APP_DIR_REAL/scripts/deploy"
SCRIPT_PATH="$(cd -P -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$SCRIPT_NAME"

[[ "$SCRIPT_PATH" == "$DEPLOY_SCRIPT_DIR/$SCRIPT_NAME" ]] ||
  die 2 "Scheduler recovery must run from the verified APP_DIR deployment source."
require_regular_file "authoritative deployment env" "$ENV_FILE"
require_regular_file "deployment Compose file" "$COMPOSE_FILE"
require_regular_file "deployment environment preflight" "$DEPLOY_SCRIPT_DIR/deployment-env-preflight.py"
require_regular_file "deployment Compose profile" "$DEPLOY_SCRIPT_DIR/deployment-compose-profile.sh"

ENV_FILE_REAL="$(readlink -f -- "$ENV_FILE")"
COMPOSE_FILE_REAL="$(readlink -f -- "$COMPOSE_FILE")"
[[ "$ENV_FILE_REAL" == "$EXPECTED_ENV_FILE" ]] ||
  die 2 "Scheduler recovery requires the authoritative state deployment env: $EXPECTED_ENV_FILE"
[[ "$COMPOSE_FILE_REAL" == "$EXPECTED_COMPOSE_FILE" ]] ||
  die 2 "Scheduler recovery requires the deployment Compose file from APP_DIR."

[[ "$LOCK_FILE" == /* && "$LOCK_FILE" != *$'\n'* && "$LOCK_FILE" != *$'\r'* ]] ||
  die 2 "LOCK_FILE must be a safe absolute path."
[[ ! -L "$LOCK_FILE" ]] || die 2 "LOCK_FILE must not be a symlink."
[[ -d "$(dirname -- "$LOCK_FILE")" ]] ||
  die 2 "LOCK_FILE parent directory does not exist."

# Acquire the same lock as deployment/engine maintenance before the first
# Docker probe. A recovery must not race a role/profile change or deployment.
umask 077
exec 9>"$LOCK_FILE"
flock -n 9 || die 9 "Another Airfoils.Pro deploy or maintenance action is running."

cd -P -- "$APP_DIR_REAL"
python3 "$DEPLOY_SCRIPT_DIR/deployment-env-preflight.py" \
  --app-dir "$APP_DIR" --state-dir "$AIRFOILS_PRO_STATE_DIR" --env-file "$ENV_FILE" \
  >/dev/null || die 2 "The authoritative deployment environment failed preflight."

# This helper deliberately fixes the base file to the release's deployment
# Compose file. deployment-compose-profile.sh adds the required role-specific
# override and rejects process project/override drift against the env file.
COMPOSE_FILE="$EXPECTED_COMPOSE_FILE"
# shellcheck source=scripts/deploy/deployment-compose-profile.sh
source "$DEPLOY_SCRIPT_DIR/deployment-compose-profile.sh"
configure_deployment_compose_profile || die 2 "Could not configure the deployment Compose profile."

case "$DEPLOYMENT_ROLE" in
  hub)
    [[ "$COMPOSE_PROJECT_NAME" == "app" && -z "$COMPOSE_OVERRIDE_FILE" ]] ||
      die 2 "The hub scheduler recovery Compose profile is not authoritative."
    [[ ${#COMPOSE_FILE_ARGS[@]} -eq 2 && "${COMPOSE_FILE_ARGS[0]}" == "-f" &&
       "$(readlink -f -- "${COMPOSE_FILE_ARGS[1]}")" == "$EXPECTED_COMPOSE_FILE" ]] ||
      die 2 "The hub scheduler recovery Compose files are not authoritative."
    ;;
  remote-solver)
    EXPECTED_REMOTE_OVERRIDE="$STATE_DIR_REAL/docker-compose.remote-solver.yml"
    require_regular_file "remote-solver Compose override" "$COMPOSE_OVERRIDE_FILE"
    [[ "$COMPOSE_PROJECT_NAME" == "hz-solver2" &&
       "$(readlink -f -- "$COMPOSE_OVERRIDE_FILE")" == "$EXPECTED_REMOTE_OVERRIDE" ]] ||
      die 2 "The remote-solver scheduler recovery Compose profile is not authoritative."
    [[ ${#COMPOSE_FILE_ARGS[@]} -eq 4 && "${COMPOSE_FILE_ARGS[0]}" == "-f" &&
       "$(readlink -f -- "${COMPOSE_FILE_ARGS[1]}")" == "$EXPECTED_COMPOSE_FILE" &&
       "${COMPOSE_FILE_ARGS[2]}" == "-f" &&
       "$(readlink -f -- "${COMPOSE_FILE_ARGS[3]}")" == "$EXPECTED_REMOTE_OVERRIDE" ]] ||
      die 2 "The remote-solver scheduler recovery Compose files are not authoritative."
    ;;
  *)
    die 2 "Unsupported deployment role after Compose profile setup: $DEPLOYMENT_ROLE"
    ;;
esac

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die 2 "Docker Compose is unavailable."
fi

compose() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" \
    "${COMPOSE_FILE_ARGS[@]}" "$@"
}

require_configured_service() {
  local service="$1"
  grep -Fxq "$service" <<<"$CONFIGURED_SERVICES" ||
    die 2 "The role-pinned deployment Compose profile lacks required service: $service"
}

require_one_running_container() {
  local service="$1" output
  local -a ids=()
  if ! output="$(compose ps --status running -q "$service")"; then
    printf 'Could not inspect the running %s container.\n' "$service" >&2
    return 1
  fi
  while IFS= read -r line; do
    [[ -z "$line" ]] || ids+=("$line")
  done <<<"$output"
  if ((${#ids[@]} != 1)) || [[ ! "${ids[0]}" =~ ^[0-9a-fA-F]{12,64}$ ]]; then
    printf '%s must have exactly one running Compose container.\n' "$service" >&2
    return 1
  fi
  CAPTURED_CONTAINER_ID="${ids[0]}"
}

database_endpoint_fingerprint_from_running_service() {
  local service="$1"
  compose exec -T "$service" node -e '
const { createHash } = require("node:crypto");
const raw = process.env.DATABASE_URL;
if (!raw) process.exit(2);
let url;
try { url = new URL(raw); } catch { process.exit(2); }
if (!url.protocol || !url.hostname || !url.pathname) process.exit(2);
const port = url.port || (["postgres:", "postgresql:"].includes(url.protocol) ? "5432" : "");
const endpoint = `${url.protocol}//${url.username}@${url.hostname.toLowerCase()}:${port}${url.pathname}`;
process.stdout.write(createHash("sha256").update(endpoint).digest("hex"));
'
}

database_endpoint_fingerprint_from_sweeper_profile() {
  # `run` resolves exactly the role-pinned sweeper service environment but
  # does not require a pre-existing container. The temporary process exits
  # after printing only a digest; --no-deps prevents any dependency startup.
  compose run --rm --no-deps -T sweeper node -e '
const { createHash } = require("node:crypto");
const raw = process.env.DATABASE_URL;
if (!raw) process.exit(2);
let url;
try { url = new URL(raw); } catch { process.exit(2); }
if (!url.protocol || !url.hostname || !url.pathname) process.exit(2);
const port = url.port || (["postgres:", "postgresql:"].includes(url.protocol) ? "5432" : "");
const endpoint = `${url.protocol}//${url.username}@${url.hostname.toLowerCase()}:${port}${url.pathname}`;
process.stdout.write(createHash("sha256").update(endpoint).digest("hex"));
'
}

read_completed_tick_epoch_ms() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U aerodb -d aerodb -Atq \
    -c 'SELECT COALESCE((EXTRACT(EPOCH FROM "lastTickCompletedAt") * 1000)::bigint::text, $$NULL$$) FROM "sweeper_state" WHERE "id" = 1;'
}

validate_tick_epoch_ms() {
  local value="$1"
  [[ "$value" == "NULL" || "$value" =~ ^[0-9]{1,16}$ ]]
}

CONFIGURED_SERVICES="$(compose config --services)" ||
  die 2 "Could not resolve the role-pinned deployment Compose profile."
for service in api worker node-api postgres sweeper; do
  require_configured_service "$service"
done
compose config --quiet >/dev/null ||
  die 2 "The role-pinned deployment Compose profile is invalid."

require_one_running_container api || die 14 "The engine API must be running before scheduler recovery."
ENGINE_API_ID="$CAPTURED_CONTAINER_ID"
require_one_running_container worker || die 14 "The engine worker must be running before scheduler recovery."
ENGINE_WORKER_ID="$CAPTURED_CONTAINER_ID"
require_one_running_container node-api || die 14 "The Node API must be running before scheduler recovery."
require_one_running_container postgres || die 14 "The deployment database must be running before scheduler recovery."

if ! API_DATABASE_FINGERPRINT="$(database_endpoint_fingerprint_from_running_service node-api)" ||
   ! SWEEPER_DATABASE_FINGERPRINT="$(database_endpoint_fingerprint_from_sweeper_profile)"; then
  die 14 "Could not derive non-secret database endpoint fingerprints from the scheduler and API."
fi
[[ "$API_DATABASE_FINGERPRINT" =~ ^[0-9a-f]{64}$ &&
   "$SWEEPER_DATABASE_FINGERPRINT" =~ ^[0-9a-f]{64}$ ]] ||
  die 14 "Scheduler/API database endpoint fingerprints are malformed."
[[ "$API_DATABASE_FINGERPRINT" == "$SWEEPER_DATABASE_FINGERPRINT" ]] ||
  die 14 "Scheduler and API database endpoints differ; refusing scheduler recovery."

if ! PRE_RECOVERY_TICK="$(read_completed_tick_epoch_ms)" ||
   ! validate_tick_epoch_ms "$PRE_RECOVERY_TICK"; then
  die 14 "Could not read the scheduler tick-progress state before recovery."
fi

echo "Starting the role-pinned sweeper runtime; engine services remain untouched."
compose up -d --no-deps --force-recreate sweeper ||
  die 14 "Could not start the sweeper runtime."
require_one_running_container sweeper ||
  die 14 "Sweeper did not remain running after the role-pinned recovery start."

deadline=$((SECONDS + TICK_TIMEOUT_SECONDS))
POST_RECOVERY_TICK=""
while (( SECONDS <= deadline )); do
  require_one_running_container sweeper ||
    die 14 "Sweeper exited before completing a reconciliation tick."
  if POST_RECOVERY_TICK="$(read_completed_tick_epoch_ms 2>/dev/null)" &&
     validate_tick_epoch_ms "$POST_RECOVERY_TICK" &&
     [[ "$POST_RECOVERY_TICK" != "NULL" && "$POST_RECOVERY_TICK" != "$PRE_RECOVERY_TICK" ]]; then
    break
  fi
  POST_RECOVERY_TICK=""
  sleep "$TICK_POLL_SECONDS"
done
[[ -n "$POST_RECOVERY_TICK" ]] ||
  die 14 "Sweeper did not complete a reconciliation tick within ${TICK_TIMEOUT_SECONDS}s."

require_one_running_container api || die 18 "Engine API is not running after scheduler recovery."
[[ "$CAPTURED_CONTAINER_ID" == "$ENGINE_API_ID" ]] ||
  die 18 "CRITICAL: engine API container identity changed during scheduler recovery."
require_one_running_container worker || die 18 "Engine worker is not running after scheduler recovery."
[[ "$CAPTURED_CONTAINER_ID" == "$ENGINE_WORKER_ID" ]] ||
  die 18 "CRITICAL: engine worker container identity changed during scheduler recovery."

echo "Sweeper completed a reconciliation tick with the authoritative deployment profile."
