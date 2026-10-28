#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.deploy.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
COMPOSE_OVERRIDE_FILE="${COMPOSE_OVERRIDE_FILE:-}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"
MIGRATION_FILE="${MIGRATION_FILE:-$APP_DIR/packages/db/migrations/0189_progressive_worker_report_job_order.sql}"
MIGRATION_CREATED_AT=1793187421071
INDEXES=(
  progressive_worker_reports_staging_job_order_idx
)

if [[ ! -f "$ENV_FILE" || ! -f "$MIGRATION_FILE" ]]; then
  echo "The authoritative deployment env or migration file is missing." >&2
  exit 2
fi

source "$DEPLOY_SCRIPT_DIR/deployment-compose-profile.sh"
configure_deployment_compose_profile
if [[ "$DEPLOYMENT_ROLE" != "remote-solver" ]]; then
  echo "This online repair is reserved for the dedicated remote solver." >&2
  exit 2
fi

python3 "$DEPLOY_SCRIPT_DIR/deployment-env-preflight.py" \
  --app-dir "$APP_DIR" --state-dir "$AIRFOILS_PRO_STATE_DIR" --env-file "$ENV_FILE" >/dev/null

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi

compose() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" "${COMPOSE_FILE_ARGS[@]}" "$@"
}

read_env() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

DB_USER="$(read_env POSTGRES_USER)"
DB_NAME="$(read_env POSTGRES_DB)"
DB_USER="${DB_USER:-aerodb}"
DB_NAME="${DB_NAME:-aerodb}"

psql() {
  compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"
}

MIGRATION_HASH="$(sha256sum "$MIGRATION_FILE" | awk '{print $1}')"
exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "Another deployment or online repair already holds $LOCK_FILE." >&2
  exit 9
}

migration_state="$(psql -Atc "SELECT coalesce(max(id),0)||':'||coalesce(max(hash) FILTER (WHERE id=189),'') FROM drizzle.__drizzle_migrations;")"
max_id="${migration_state%%:*}"
recorded_hash="${migration_state#*:}"
if (( max_id > 189 )); then
  echo "Migration history already advanced beyond 0189; refusing an ambiguous repair." >&2
  exit 12
fi
if [[ -n "$recorded_hash" && "$recorded_hash" != "$MIGRATION_HASH" ]]; then
  echo "Migration 0189 has a different recorded hash; refusing repair." >&2
  exit 12
fi

for index_name in "${INDEXES[@]}"; do
  index_state="$(psql -Atc "SELECT CASE WHEN indisvalid AND indisready THEN 'valid' ELSE 'invalid' END FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.relname='$index_name';")"
  if [[ "$index_state" == "invalid" ]]; then
    echo "Dropping incomplete index $index_name before rebuilding concurrently."
    psql -c "DROP INDEX CONCURRENTLY IF EXISTS $index_name;"
  fi
  if [[ "$index_state" != "valid" ]]; then
    psql -c "CREATE INDEX CONCURRENTLY $index_name ON progressive_worker_reports (sim_job_id, created_at, sequence) WHERE acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result') = 'object';"
  fi
  [[ "$(psql -Atc "SELECT CASE WHEN indisvalid AND indisready THEN 'valid' ELSE 'invalid' END FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.relname='$index_name';")" == "valid" ]] || {
    echo "Index $index_name did not become valid." >&2
    exit 13
  }
done

if [[ -z "$recorded_hash" ]]; then
  (( max_id == 188 )) || {
    echo "Expected migration 0188 to be the latest migration before recording 0189; found $max_id." >&2
    exit 12
  }
  psql -c "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('$MIGRATION_HASH', $MIGRATION_CREATED_AT);"
fi

[[ "$(psql -Atc "SELECT hash FROM drizzle.__drizzle_migrations WHERE id=189;")" == "$MIGRATION_HASH" ]] || {
  echo "Migration 0189 was not recorded with the expected hash." >&2
  exit 14
}
echo "Progressive report indexes are valid and migration 0189 is recorded; writers remained online."
