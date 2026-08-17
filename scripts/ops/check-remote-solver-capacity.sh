#!/usr/bin/env bash
# Read-only remote-solver capacity monitor.
#
# The monitor never changes solver, promise, database, or engine state. Its
# only write is an atomically replaced monitor report under deployment state.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.deploy.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
COMPOSE_OVERRIDE_FILE="${COMPOSE_OVERRIDE_FILE:-}"
OUTPUT_DIR="${OUTPUT_DIR:-$AIRFOILS_PRO_STATE_DIR/monitor}"
OUTPUT_FILE="${OUTPUT_FILE:-$OUTPUT_DIR/remote-solver-capacity-latest.json}"
ENGINE_URL="${ENGINE_URL:-http://127.0.0.1:8000}"
ENGINE_QUEUE_PROBE_TIMEOUT_SECONDS="${ENGINE_QUEUE_PROBE_TIMEOUT_SECONDS:-20}"

cd "$APP_DIR"
python3 "$APP_DIR/scripts/deploy/deployment-env-preflight.py" \
  --app-dir "$APP_DIR" \
  --state-dir "$AIRFOILS_PRO_STATE_DIR" \
  --env-file "$ENV_FILE" \
  >/dev/null
# shellcheck source=scripts/deploy/deployment-compose-profile.sh
source "$APP_DIR/scripts/deploy/deployment-compose-profile.sh"
configure_deployment_compose_profile
if [[ "$DEPLOYMENT_ROLE" != "remote-solver" ]]; then
  echo "remote capacity monitor requires AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver" >&2
  exit 2
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi
compose() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" \
    "${COMPOSE_FILE_ARGS[@]}" "$@"
}

# This is intentionally one SELECT: it must never update a heartbeat, claim a
# promise, clear a fence, or otherwise become a control-plane writer.
db_snapshot="$(
  compose exec -T postgres sh -lc \
    'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT json_build_object(
  'enabled', settings.remote_solver_enabled,
  'transferPaused', settings.remote_solver_transfer_paused,
  'cpuCap', settings.remote_solver_cpu_budget,
  'lastStatus', settings.remote_solver_last_status,
  'lastError', settings.remote_solver_last_error,
  'lastSyncAt', settings.remote_solver_last_sync_at,
  'lastPromiseAt', settings.remote_solver_last_promise_at,
  'lastPushAt', settings.remote_solver_last_push_at,
  'sweeperHeartbeatAt', sweeper."heartbeatAt",
  'diskAdmissionBlocked', sweeper.disk_admission_blocked,
  'diskAdmissionReason', sweeper.disk_admission_reason,
  'diskUsedPct', sweeper.disk_used_pct,
  'diskFreeBytes', sweeper.disk_free_bytes,
  'diskRequiredFreeBytes', sweeper.disk_required_free_bytes,
  'activePromises', (
    SELECT count(*)::integer FROM sync_sweep_promises WHERE status = 'active'
  ),
  'liveRemoteJobs', (
    SELECT count(*)::integer FROM sim_jobs
    WHERE status IN ('pending', 'submitted', 'running', 'ingesting')
      AND request_payload ->> 'remoteSolver' = 'true'
  ),
  'reservedCpuSlots', (
    SELECT coalesce(sum(greatest(admission_cpu_slots, 1)), 0)::integer
    FROM sim_jobs
    WHERE (
        status IN ('submitted', 'running')
        OR (status = 'ingesting' AND engine_state = 'running')
        OR (status = 'pending' AND engine_state = 'submitting')
        OR (status = 'cancelled' AND engine_state IN ('cancelling', 'cancel_pending'))
      ) AND request_payload ->> 'remoteSolver' = 'true'
  ),
  'engineJobIds', coalesce((
    SELECT json_agg(engine_job_id ORDER BY "submittedAt", id)
    FROM sim_jobs
    WHERE status IN ('pending', 'submitted', 'running', 'ingesting')
      AND request_payload ->> 'remoteSolver' = 'true'
      AND engine_job_id IS NOT NULL
  ), '[]'::json),
  'liveJobProgress', (
    SELECT json_build_object(
      'jobs', count(*)::integer,
      'totalCases', coalesce(sum(total_cases), 0)::integer,
      'completedCases', coalesce(sum(completed_cases), 0)::integer,
      'awaitingEngineId', coalesce(sum(awaiting_engine_id), 0)::integer,
      'lastObservedAt', max(coalesce(polled_at, submitted_at, updated_at)),
      'states', coalesce(json_object_agg(status, state_count), '{}'::json)
    )
    FROM (
      SELECT status, count(*)::integer AS state_count,
             sum(total_cases)::integer AS total_cases,
             sum(completed_cases)::integer AS completed_cases,
             count(*) FILTER (WHERE engine_job_id IS NULL)::integer AS awaiting_engine_id,
             max("polledAt") AS polled_at, max("submittedAt") AS submitted_at,
             max("updatedAt") AS updated_at
      FROM sim_jobs
      WHERE status IN ('pending', 'submitted', 'running', 'ingesting')
        AND request_payload ->> 'remoteSolver' = 'true'
      GROUP BY status
    ) progress_by_state
  ),
  'unsettledDeliveries', (
    SELECT count(*)::integer FROM sync_remote_result_deliveries
    WHERE state NOT IN ('delivered', 'superseded', 'blocked')
  )
)
FROM sync_api_settings settings CROSS JOIN sweeper_state sweeper
WHERE settings.id = 1 AND sweeper.id = 1;
SQL
)"

runtime_request="$(python3 - "$db_snapshot" <<'PY'
import json
import sys
snapshot = json.loads(sys.argv[1])
job_ids = snapshot.get("engineJobIds")
if not isinstance(job_ids, list) or any(not isinstance(item, str) or not item for item in job_ids):
    raise SystemExit("database snapshot has invalid engineJobIds")
print(json.dumps({"job_ids": job_ids}, separators=(",", ":")))
PY
)"
engine_snapshot="$(curl -fsS --max-time "$ENGINE_QUEUE_PROBE_TIMEOUT_SECONDS" "$ENGINE_URL/queue")"
runtime_snapshot="$(curl -fsS --max-time "$ENGINE_QUEUE_PROBE_TIMEOUT_SECONDS" \
  -H 'content-type: application/json' -X POST --data-binary "$runtime_request" \
  "$ENGINE_URL/jobs/runtime")"
host_openfoam_solver_processes="$(ps -eo comm= | awk '
  $1 == "simpleFoam" || $1 == "pimpleFoam" || $1 == "potentialFoam" { count += 1 }
  END { print count + 0 }
')"

install -d -m 700 "$OUTPUT_DIR"
temporary="$(mktemp "$OUTPUT_DIR/.remote-capacity.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
set +e
python3 "$APP_DIR/scripts/ops/remote_solver_capacity_report.py" \
  --database "$db_snapshot" \
  --engine-queue "$engine_snapshot" \
  --engine-runtime "$runtime_snapshot" \
  --host-openfoam-solver-processes "$host_openfoam_solver_processes" \
  --output "$temporary"
status=$?
set -e
mv -f "$temporary" "$OUTPUT_FILE"
trap - EXIT
exit "$status"
