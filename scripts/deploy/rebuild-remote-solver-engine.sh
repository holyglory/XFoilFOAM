#!/usr/bin/env bash
# Guarded OpenCFD 2406 -> 2606 cutover for dedicated remote solver hz-solver2.
# This workflow never calls the production hub's campaign-successor API and
# never accepts or copies GCS credentials. It preserves the database, named
# volumes, old images, and complete local tar.zst evidence.
set -Eeuo pipefail

ACTION="${1:-}"
if [[ -z "$ACTION" ]]; then
  echo "Usage: $0 <BUILD_ID> | --rollback" >&2
  exit 2
fi
if [[ "$ACTION" != "--rollback" && ! "$ACTION" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "BUILD_ID may contain only letters, digits, dot, underscore, and hyphen." >&2
  exit 2
fi

DEPLOY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.deploy.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
COMPOSE_OVERRIDE_FILE="${COMPOSE_OVERRIDE_FILE:-}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"
DEPLOYMENT_MANIFEST_FILE="${DEPLOYMENT_MANIFEST_FILE:-$APP_DIR/.deployment-source.json}"
DEPLOY_SOURCE_REVISION="${DEPLOY_SOURCE_REVISION:-}"
DEPLOY_SOURCE_TREE_SHA256="${DEPLOY_SOURCE_TREE_SHA256:-}"
RECEIPT_FILE="$AIRFOILS_PRO_STATE_DIR/remote-solver-2606-canary-receipt.json"
ATTESTATION_FILE="$AIRFOILS_PRO_STATE_DIR/remote-solver-2606-attestation.json"
BACKUP_MANIFEST_FILE="$AIRFOILS_PRO_STATE_DIR/remote-solver-2606-backup-manifest.json"
ROLLBACK_RECEIPT_FILE="$AIRFOILS_PRO_STATE_DIR/remote-solver-2606-rollback.json"
ROLLBACK_COMPOSE_FILE="$AIRFOILS_PRO_STATE_DIR/docker-compose.remote-solver-2406-rollback.yml"
BACKUP_DIR="$AIRFOILS_PRO_STATE_DIR/db-backups"
OPENCFD_2406_POOL_ID="3f8bc764-09ae-4ff3-8fd2-240600000001"
OPENCFD_2606_POOL_ID="3f8bc764-09ae-4ff3-8fd2-260600000001"
OPENCFD_2606_IMPLEMENTATION_ID="2f8bc764-09ae-4ff3-8fd2-260600000001"
FAIL_SAFE_ARMED=false
FAIL_SAFE_CONTEXT="cutover"
MAINTENANCE_QUIESCE_ARMED=false
MAINTENANCE_TRANSFER_PAUSE_WAS=""
PREPARE_RESTORE_WRITERS=false
PREPARE_SWEEPER_WAS_RUNNING=0
PREPARE_MEDIA_WAS_RUNNING=0
CANARY_TEMP_FILE=""
REMOTE_TRANSFER_QUIESCE_TIMEOUT_SECONDS="${REMOTE_TRANSFER_QUIESCE_TIMEOUT_SECONDS:-21900}"

cd "$APP_DIR"
python3 "$DEPLOY_SCRIPT_DIR/deployment-env-preflight.py" \
  --app-dir "$APP_DIR" --state-dir "$AIRFOILS_PRO_STATE_DIR" --env-file "$ENV_FILE" \
  >/dev/null || exit 2
# shellcheck source=scripts/deploy/deployment-compose-profile.sh
source "$DEPLOY_SCRIPT_DIR/deployment-compose-profile.sh"
configure_deployment_compose_profile || exit $?
if [[ "$DEPLOYMENT_ROLE" != "remote-solver" ]]; then
  echo "This workflow requires AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver." >&2
  exit 2
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi
compose() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" "${COMPOSE_FILE_ARGS[@]}" "$@"
}

rollback_compose() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" \
    "${COMPOSE_FILE_ARGS[@]}" -f "$ROLLBACK_COMPOSE_FILE" "$@"
}

read_env_var() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

file_sha256() {
  sha256sum "$1" | awk '{print $1}'
}

verify_deployment_source() {
  local fields file_count
  fields="$(python3 "$DEPLOY_SCRIPT_DIR/deployment-source-manifest.py" \
    --verify --root "$APP_DIR" --manifest "$DEPLOYMENT_MANIFEST_FILE")" || return 2
  IFS=$'\t' read -r DEPLOY_SOURCE_REVISION DEPLOY_SOURCE_TREE_SHA256 file_count <<<"$fields"
  echo "Verified remote-solver source: revision=$DEPLOY_SOURCE_REVISION sha256=$DEPLOY_SOURCE_TREE_SHA256 files=$file_count"
}

validate_compose_profile() {
  local temporary
  temporary="$(mktemp)"
  chmod 600 "$temporary"
  if ! compose config --format json >"$temporary"; then
    rm -f "$temporary"
    return 2
  fi
  if ! python3 "$DEPLOY_SCRIPT_DIR/validate-remote-solver-compose.py" <"$temporary"; then
    rm -f "$temporary"
    return 2
  fi
  rm -f "$temporary"
  echo "Merged Compose profile preserves the 40-CPU volume-backed hz-solver2 contract."
}

set_env_vars_atomic() {
  python3 - "$ENV_FILE" "$@" <<'PY'
import os
from pathlib import Path
import stat
import sys
import tempfile

path = Path(sys.argv[1])
updates = dict(item.split("=", 1) for item in sys.argv[2:])
if any(not key or "\n" in key or "\n" in value or "\r" in value for key, value in updates.items()):
    raise SystemExit("invalid deployment env update")
lines = path.read_text(encoding="utf-8").splitlines()
seen = set()
output = []
for line in lines:
    key = line.split("=", 1)[0] if "=" in line else ""
    if key in updates:
        if key not in seen:
            output.append(f"{key}={updates[key]}")
            seen.add(key)
    else:
        output.append(line)
for key, value in updates.items():
    if key not in seen:
        output.append(f"{key}={value}")
fd, name = tempfile.mkstemp(prefix=f".{path.name}.remote-cutover-", dir=path.parent)
try:
    os.fchmod(fd, stat.S_IMODE(path.stat().st_mode))
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write("\n".join(output) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(name, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
except BaseException:
    try:
        os.unlink(name)
    except FileNotFoundError:
        pass
    raise
PY
}

writer_state() {
  local service="$1" running
  running="$(compose ps --status running -q "$service")" || return 12
  [[ -n "$running" ]] && printf '1\n' || printf '0\n'
}

stop_writers() {
  compose stop sweeper media-repair
}

restore_writers() {
  local sweeper="$1" media="$2"
  if [[ "$sweeper" == "1" ]]; then
    compose up -d --no-deps sweeper
  else
    compose up --no-start --no-deps --force-recreate sweeper
  fi
  if [[ "$media" == "1" ]]; then
    compose up -d --no-deps media-repair
  else
    compose up --no-start --no-deps --force-recreate media-repair
  fi
}

openfoam_processes() {
  local running
  running="$(compose ps --status running -q worker)" || return 12
  [[ -n "$running" ]] || return 0
  compose exec -T worker sh -lc \
    'pgrep -af "[s]impleFoam|[p]impleFoam|[p]otentialFoam|[s]nappyHexMesh|[s]urfaceFeatureExtract|[b]lockMesh|[c]heckMesh|[d]ecomposePar|[r]econstructPar|[r]enumberMesh|[m]apFields|[p]ostProcess|[f]oamToVTK|[f]oamRun|[f]oamJob" || true'
}

queue_activity() {
  curl -fsS --max-time 15 http://127.0.0.1:8000/queue | python3 -c '
import json, sys
queue = json.load(sys.stdin)
modern = "worker_queues_error" in queue
if modern:
    for key in ("worker_queues_error", "worker_runtime_error"):
        if queue.get(key) is not None:
            raise SystemExit(f"{key}={queue.get(key)!r}")
    errors = queue.get("inspection_errors")
    if not isinstance(errors, dict) or errors:
        raise SystemExit(f"inspection_errors={errors!r}")
counts = {key: queue.get(key) for key in ("queue_depth", "active_count", "reserved_count", "scheduled_count")}
if any(type(value) is not int for value in counts.values()):
    raise SystemExit(f"incomplete queue counters: {counts!r}")
if not modern:
    for name in ("active", "reserved", "scheduled"):
        rows = queue.get(name)
        if not isinstance(rows, list) or len(rows) != counts[f"{name}_count"]:
            raise SystemExit(f"legacy queue {name} snapshot is incomplete")
if any(counts.values()):
    print(json.dumps(counts, sort_keys=True))
'
}

database_activity() {
  compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c "
WITH activity AS (
  SELECT
    (SELECT count(*) FROM sim_jobs WHERE status IN ('pending','submitted','running','ingesting'))::int AS live_jobs,
    (SELECT count(*) FROM sync_sweep_promises WHERE status = 'active')::int AS active_promises,
    (SELECT count(*) FROM sync_remote_result_deliveries WHERE state NOT IN ('delivered','superseded'))::int AS unsettled_deliveries,
    (SELECT count(*) FROM sync_remote_promise_cancellations WHERE state <> 'delivered')::int AS unsettled_cancellations,
    (SELECT count(*) FROM result_media_repairs WHERE state = 'running')::int AS running_media_repairs
)
SELECT row_to_json(activity)::text FROM activity;" | python3 -c '
import json, sys
row = json.loads(sys.stdin.read())
if any(type(value) is not int for value in row.values()):
    raise SystemExit(f"invalid database idle snapshot: {row!r}")
if any(row.values()):
    print(json.dumps(row, sort_keys=True))
'
}

maintenance_database_activity() {
  # An active remote promise is a durable scheduling lease, not executable
  # work. Once both writers are stopped it remains inert and must survive an
  # ordinary engine maintenance window unchanged. Live jobs, retryable or
  # claimed deliveries, unsettled cancellations, and active media repair still
  # fail closed. A blocked delivery is already terminal in the remote writer
  # state machine; its reviewable hub conflict ids remain durable and inert.
  compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c "
WITH activity AS (
  SELECT
    (SELECT count(*) FROM sim_jobs WHERE status IN ('pending','submitted','running','ingesting'))::int AS live_jobs,
    (SELECT count(*) FROM sync_remote_result_deliveries WHERE state NOT IN ('delivered','superseded','blocked'))::int AS unsettled_deliveries,
    (SELECT count(*) FROM sync_remote_promise_cancellations WHERE state <> 'delivered')::int AS unsettled_cancellations,
    (SELECT count(*) FROM result_media_repairs WHERE state = 'running')::int AS running_media_repairs
)
SELECT row_to_json(activity)::text FROM activity;" | python3 -c '
import json, sys
row = json.loads(sys.stdin.read())
if any(type(value) is not int for value in row.values()):
    raise SystemExit(f"invalid maintenance database idle snapshot: {row!r}")
if any(row.values()):
    print(json.dumps(row, sort_keys=True))
'
}

remote_transfer_paused() {
  compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c "
SELECT remote_solver_transfer_paused::text
FROM sync_api_settings
WHERE id = 1;" | python3 -c '
import sys
value = sys.stdin.read().strip()
if value not in {"true", "false"}:
    raise SystemExit(f"invalid remote transfer pause state: {value!r}")
print(value)
'
}

set_remote_transfer_paused() {
  local value="$1" observed
  [[ "$value" == "true" || "$value" == "false" ]] || {
    echo "Invalid remote transfer pause value: $value" >&2
    return 12
  }
  observed="$(compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c "
UPDATE sync_api_settings
SET remote_solver_transfer_paused = $value,
    \"updatedAt\" = now()
WHERE id = 1
RETURNING remote_solver_transfer_paused::text;")" || return 12
  [[ "$observed" == "$value" ]] || {
    echo "Remote transfer pause update did not persist the requested state." >&2
    return 12
  }
}

remote_transfer_activity() {
  compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c "
WITH activity AS (
  SELECT
    (SELECT count(*) FROM sync_remote_result_deliveries
      WHERE state NOT IN ('delivered','superseded','blocked'))::int AS unsettled_deliveries,
    (SELECT count(*) FROM sync_remote_promise_cancellations
      WHERE state <> 'delivered')::int AS unsettled_cancellations
)
SELECT row_to_json(activity)::text FROM activity;" | python3 -c '
import json, sys
row = json.loads(sys.stdin.read())
if any(type(value) is not int for value in row.values()):
    raise SystemExit(f"invalid remote transfer snapshot: {row!r}")
if any(row.values()):
    print(json.dumps(row, sort_keys=True))
'
}

wait_remote_transfer_quiescence() {
  local stage="$1" started now activity
  started="$(date +%s)"
  while true; do
    if ! activity="$(remote_transfer_activity 2>&1)"; then
      echo "Remote transfer probe failed closed at $stage: $activity" >&2
      return 12
    fi
    if [[ -z "$activity" ]]; then
      echo "Remote transfer outboxes are quiescent ($stage)."
      return 0
    fi
    now="$(date +%s)"
    if (( now - started >= REMOTE_TRANSFER_QUIESCE_TIMEOUT_SECONDS )); then
      echo "Remote transfer quiescence timed out at $stage: $activity" >&2
      return 12
    fi
    echo "Waiting for the already-claimed remote transfer to settle: $activity"
    sleep 2
  done
}

require_idle() {
  local stage processes queue db
  stage="$1"
  if ! processes="$(openfoam_processes 2>&1)"; then
    echo "OpenFOAM process probe failed at $stage: $processes" >&2
    return 12
  fi
  if [[ -n "$processes" ]]; then
    echo "Refusing remote-solver cutover at $stage; OpenFOAM processes are active:" >&2
    echo "$processes" >&2
    return 12
  fi
  if ! queue="$(queue_activity 2>&1)"; then
    echo "Queue probe failed closed at $stage: $queue" >&2
    return 12
  fi
  if [[ -n "$queue" ]]; then
    echo "Refusing remote-solver cutover at $stage; engine work exists: $queue" >&2
    return 12
  fi
  if ! db="$(database_activity 2>&1)"; then
    echo "Database activity probe failed closed at $stage: $db" >&2
    return 12
  fi
  if [[ -n "$db" ]]; then
    echo "Refusing remote-solver cutover at $stage; promises/deliveries/jobs are not drained: $db" >&2
    return 12
  fi
  echo "Remote-solver idle gate passed ($stage)."
}

redis_queue_activity() {
  local queue depth
  for queue in celery openfoam-opencfd-2406 openfoam-opencfd-2606; do
    depth="$(compose exec -T redis redis-cli --raw LLEN "$queue")" || return 12
    [[ "$depth" =~ ^[0-9]+$ ]] || {
      echo "invalid Redis depth for $queue: $depth" >&2
      return 12
    }
    if ((depth > 0)); then
      printf '%s=%s\n' "$queue" "$depth"
    fi
  done
}

require_recreate_safe() {
  local stage="$1" processes db redis_depths sweeper_state media_state
  sweeper_state="$(writer_state sweeper)" || return 12
  media_state="$(writer_state media-repair)" || return 12
  if [[ "$sweeper_state" != "0" || "$media_state" != "0" ]]; then
    echo "Refusing runtime recreate at $stage; control-plane writers are not stopped." >&2
    return 12
  fi
  if ! processes="$(openfoam_processes 2>&1)"; then
    echo "OpenFOAM process probe failed at $stage: $processes" >&2
    return 12
  fi
  if [[ -n "$processes" ]]; then
    echo "Refusing runtime recreate at $stage; OpenFOAM processes are active:" >&2
    echo "$processes" >&2
    return 12
  fi
  if ! db="$(database_activity 2>&1)"; then
    echo "Database activity probe failed closed at $stage: $db" >&2
    return 12
  fi
  if [[ -n "$db" ]]; then
    echo "Refusing runtime recreate at $stage; database work is active: $db" >&2
    return 12
  fi
  if ! redis_depths="$(redis_queue_activity 2>&1)"; then
    echo "Redis queue probe failed closed at $stage: $redis_depths" >&2
    return 12
  fi
  if [[ -n "$redis_depths" ]]; then
    echo "Refusing runtime recreate at $stage; engine queues are not empty:" >&2
    echo "$redis_depths" >&2
    return 12
  fi
  echo "Remote-solver recovery recreate gate passed ($stage)."
}

require_maintenance_safe() {
  local stage="$1" processes queue db redis_depths sweeper_state media_state
  sweeper_state="$(writer_state sweeper)" || return 12
  media_state="$(writer_state media-repair)" || return 12
  if [[ "$sweeper_state" != "0" || "$media_state" != "0" ]]; then
    echo "Refusing remote engine maintenance at $stage; control-plane writers are not stopped." >&2
    return 12
  fi
  if ! processes="$(openfoam_processes 2>&1)"; then
    echo "OpenFOAM process probe failed at $stage: $processes" >&2
    return 12
  fi
  if [[ -n "$processes" ]]; then
    echo "Refusing remote engine maintenance at $stage; OpenFOAM processes are active:" >&2
    echo "$processes" >&2
    return 12
  fi
  if ! queue="$(queue_activity 2>&1)"; then
    echo "Queue probe failed closed at $stage: $queue" >&2
    return 12
  fi
  if [[ -n "$queue" ]]; then
    echo "Refusing remote engine maintenance at $stage; engine work exists: $queue" >&2
    return 12
  fi
  if ! db="$(maintenance_database_activity 2>&1)"; then
    echo "Maintenance database probe failed closed at $stage: $db" >&2
    return 12
  fi
  if [[ -n "$db" ]]; then
    echo "Refusing remote engine maintenance at $stage; executable database work exists: $db" >&2
    return 12
  fi
  if ! redis_depths="$(redis_queue_activity 2>&1)"; then
    echo "Redis queue probe failed closed at $stage: $redis_depths" >&2
    return 12
  fi
  if [[ -n "$redis_depths" ]]; then
    echo "Refusing remote engine maintenance at $stage; engine queues are not empty:" >&2
    echo "$redis_depths" >&2
    return 12
  fi
  echo "Remote-solver ordinary engine maintenance gate passed ($stage)."
}

wait_http() {
  local label="$1" url="$2" attempts="${3:-90}" i
  for ((i=1; i<=attempts; i++)); do
    if curl -fsS --max-time 10 "$url" >/dev/null; then
      echo "$label is healthy"
      return 0
    fi
    sleep 2
  done
  echo "$label did not become healthy: $url" >&2
  return 13
}

current_engine_version() {
  local health version capabilities legacy_worker
  health="$(curl -fsS --max-time 10 http://127.0.0.1:8000/health)" || return 1
  version="$(printf '%s' "$health" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
engine = payload.get("default_engine") or {}
print(engine.get("version") or "")
')" || return 1
  if [[ "$version" == "2606" ]]; then printf '2606\n'; return 0; fi
  if [[ -n "$version" && "$version" != "2406" ]]; then
    echo "Unsupported default engine identity: $version" >&2; return 1
  fi
  capabilities="$(curl -fsS --max-time 10 http://127.0.0.1:8000/capabilities)" || return 1
  if [[ "$(printf '%s' "$capabilities" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("openfoam_image") or "")')" != "opencfd/openfoam-default:2406" ]]; then
    echo "Legacy gateway does not identify the exact OpenCFD 2406 image." >&2; return 1
  fi
  legacy_worker="$(compose exec -T worker sh -lc 'test -r /usr/lib/openfoam/openfoam2406/etc/bashrc && test ! -r /usr/lib/openfoam/openfoam2606/etc/bashrc && printf 2406')" || return 1
  [[ "$legacy_worker" == "2406" ]] || return 1
  printf '2406\n'
}

disable_all_opencfd_pools() {
  compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c \
    "UPDATE solver_execution_pools SET enabled=false, \"updatedAt\"=now() WHERE id IN ('$OPENCFD_2406_POOL_ID','$OPENCFD_2606_POOL_ID');" >/dev/null
}

enable_pool() {
  local pool="$1"
  compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c \
    "UPDATE solver_execution_pools SET enabled=(id='$pool'), \"updatedAt\"=now() WHERE id IN ('$OPENCFD_2406_POOL_ID','$OPENCFD_2606_POOL_ID');" >/dev/null
}

create_verified_backup() {
  local timestamp dump_temp dump_file env_copy scratch container_before container_after
  local original_counts restored_counts dump_sha env_sha list_sha manifest_temp
  if [[ -e "$BACKUP_MANIFEST_FILE" || -L "$BACKUP_MANIFEST_FILE" ]]; then
    [[ -f "$BACKUP_MANIFEST_FILE" && ! -L "$BACKUP_MANIFEST_FILE" ]] || {
      echo "Unsafe orphaned backup manifest blocks a fresh cutover." >&2
      return 11
    }
    install -d -m 700 "$BACKUP_DIR"
    mv -T "$BACKUP_MANIFEST_FILE" \
      "$BACKUP_DIR/orphaned-remote-solver-2606-backup-manifest-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  fi
  install -d -m 700 "$BACKUP_DIR"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dump_file="$BACKUP_DIR/aerodb-pre-opencfd2606-$timestamp.dump"
  dump_temp="$(mktemp "$BACKUP_DIR/.aerodb-$timestamp.XXXXXX")"
  env_copy="$BACKUP_DIR/env-pre-opencfd2606-$timestamp"
  scratch="remote2606_verify_${$}_$(date +%s)"
  container_before="$(compose ps -q postgres)"
  [[ -n "$container_before" ]] || { echo "Postgres container is unavailable." >&2; return 11; }
  compose exec -T postgres pg_dump -Fc -U aerodb -d aerodb >"$dump_temp"
  chmod 600 "$dump_temp"
  compose exec -T postgres pg_restore --list <"$dump_temp" >/dev/null
  list_sha="$(compose exec -T postgres pg_restore --list <"$dump_temp" | sha256sum | awk '{print $1}')"
  original_counts="$(compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c \
    "SELECT json_build_object('tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='public'),'jobs',(SELECT count(*) FROM sim_jobs),'promises',(SELECT count(*) FROM sync_sweep_promises),'results',(SELECT count(*) FROM results))::text;")"
  compose exec -T postgres createdb -U aerodb "$scratch"
  if ! compose exec -T postgres pg_restore --exit-on-error --no-owner -U aerodb -d "$scratch" <"$dump_temp"; then
    compose exec -T postgres dropdb -U aerodb --if-exists "$scratch" >/dev/null 2>&1 || true
    return 11
  fi
  if ! restored_counts="$(compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d "$scratch" -c \
    "SELECT json_build_object('tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='public'),'jobs',(SELECT count(*) FROM sim_jobs),'promises',(SELECT count(*) FROM sync_sweep_promises),'results',(SELECT count(*) FROM results))::text;")"; then
    compose exec -T postgres dropdb -U aerodb --if-exists "$scratch" >/dev/null 2>&1 || true
    return 11
  fi
  if [[ "$original_counts" != "$restored_counts" ]]; then
    compose exec -T postgres dropdb -U aerodb --if-exists "$scratch" >/dev/null 2>&1 || true
    echo "Scratch restore row-count proof differs from source." >&2
    return 11
  fi
  compose exec -T postgres dropdb -U aerodb --if-exists "$scratch" >/dev/null
  container_after="$(compose ps -q postgres)"
  [[ "$container_before" == "$container_after" ]] || { echo "Postgres container changed during backup." >&2; return 11; }
  mv -T "$dump_temp" "$dump_file"
  install -m 600 "$ENV_FILE" "$env_copy"
  dump_sha="$(file_sha256 "$dump_file")"
  env_sha="$(file_sha256 "$env_copy")"
  manifest_temp="$(mktemp "$AIRFOILS_PRO_STATE_DIR/.remote-backup-manifest.XXXXXX")"
  chmod 600 "$manifest_temp"
  python3 - "$manifest_temp" "$dump_file" "$dump_sha" "$env_copy" "$env_sha" "$list_sha" "$container_before" "$original_counts" "$DEPLOY_SOURCE_REVISION" "$DEPLOY_SOURCE_TREE_SHA256" <<'PY'
import json, os, sys
from datetime import datetime, timezone
from pathlib import Path
path = Path(sys.argv[1])
payload = {
    "schemaVersion": 1,
    "purpose": "hz-solver2-pre-opencfd2606-cutover",
    "databaseDump": {"path": sys.argv[2], "sha256": sys.argv[3], "format": "postgres-custom"},
    "environmentBackup": {"path": sys.argv[4], "sha256": sys.argv[5]},
    "pgRestoreListSha256": sys.argv[6],
    "postgresContainerId": sys.argv[7],
    "scratchRestoreCounts": json.loads(sys.argv[8]),
    "sourceRevision": sys.argv[9],
    "sourceTreeSha256": sys.argv[10],
    "verifiedAt": datetime.now(timezone.utc).isoformat(),
}
with path.open("w", encoding="utf-8") as stream:
    json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
    stream.write("\n")
    stream.flush()
    os.fsync(stream.fileno())
PY
  mv -T "$manifest_temp" "$BACKUP_MANIFEST_FILE"
  chmod 600 "$BACKUP_MANIFEST_FILE"
  file_sha256 "$BACKUP_MANIFEST_FILE"
}

validate_existing_backup() {
  local fields dump_file expected_list_sha actual_list_sha
  fields="$(python3 - "$BACKUP_MANIFEST_FILE" "$BACKUP_DIR" "$DEPLOY_SOURCE_REVISION" "$DEPLOY_SOURCE_TREE_SHA256" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

manifest_path = Path(sys.argv[1])
backup_root = Path(sys.argv[2]).resolve(strict=True)
source_revision = sys.argv[3]
source_tree = sys.argv[4]

def private_file(path: Path, label: str) -> None:
    metadata = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(f"{label} is not a safe regular file")
    if stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_uid != os.geteuid():
        raise SystemExit(f"{label} is not owner-owned mode 0600")
    return None

private_file(manifest_path, "backup manifest")
payload = json.loads(manifest_path.read_bytes())
if (
    not isinstance(payload, dict)
    or payload.get("schemaVersion") != 1
    or payload.get("purpose") != "hz-solver2-pre-opencfd2606-cutover"
    or payload.get("sourceRevision") != source_revision
    or payload.get("sourceTreeSha256") != source_tree
    or not isinstance(payload.get("databaseDump"), dict)
    or not isinstance(payload.get("environmentBackup"), dict)
):
    raise SystemExit("backup manifest identity differs from this cutover")
dump = Path(payload["databaseDump"].get("path", ""))
env = Path(payload["environmentBackup"].get("path", ""))
for path, key, label in (
    (dump, "databaseDump", "database dump"),
    (env, "environmentBackup", "environment backup"),
):
    try:
        if path.resolve(strict=True).parent != backup_root:
            raise SystemExit(f"{label} escapes the dedicated backup directory")
    except OSError as exc:
        raise SystemExit(f"{label} is unavailable: {exc}") from exc
    private_file(path, label)
    expected = payload[key].get("sha256")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise SystemExit(f"{label} digest differs from the backup manifest")
if payload["databaseDump"].get("format") != "postgres-custom":
    raise SystemExit("database dump format is not postgres-custom")
list_sha = payload.get("pgRestoreListSha256")
if not isinstance(list_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", list_sha):
    raise SystemExit("backup manifest pg_restore listing digest is invalid")
print(f"{dump}\t{list_sha}")
PY
)" || return 11
  IFS=$'\t' read -r dump_file expected_list_sha <<<"$fields"
  actual_list_sha="$(compose exec -T postgres pg_restore --list <"$dump_file" | sha256sum | awk '{print $1}')" || return 11
  if [[ "$actual_list_sha" != "$expected_list_sha" ]]; then
    echo "Retained database dump no longer has its verified pg_restore listing." >&2
    return 11
  fi
  file_sha256 "$BACKUP_MANIFEST_FILE"
}

create_rollback_receipt() {
  local api_container worker_container api_image worker_image api_ref worker_ref
  local previous_build previous_expected previous_keys pool_state receipt_temp rollback_compose_sha
  if [[ -e "$ROLLBACK_RECEIPT_FILE" || -L "$ROLLBACK_RECEIPT_FILE" ]]; then
    [[ -f "$ROLLBACK_RECEIPT_FILE" && ! -L "$ROLLBACK_RECEIPT_FILE" ]] || {
      echo "Unsafe orphaned rollback receipt blocks a fresh cutover." >&2
      return 11
    }
    install -d -m 700 "$BACKUP_DIR"
    mv -T "$ROLLBACK_RECEIPT_FILE" \
      "$BACKUP_DIR/orphaned-remote-solver-2606-rollback-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
    if [[ -e "$ROLLBACK_COMPOSE_FILE" || -L "$ROLLBACK_COMPOSE_FILE" ]]; then
      [[ -f "$ROLLBACK_COMPOSE_FILE" && ! -L "$ROLLBACK_COMPOSE_FILE" ]] || {
        echo "Unsafe orphaned rollback Compose file blocks a fresh cutover." >&2
        return 11
      }
      mv -T "$ROLLBACK_COMPOSE_FILE" \
        "$BACKUP_DIR/orphaned-remote-solver-2406-rollback-compose-$(date -u +%Y%m%dT%H%M%SZ)-$$.yml"
    fi
  fi
  api_container="$(compose ps -q api)"; worker_container="$(compose ps -q worker)"
  [[ -n "$api_container" && -n "$worker_container" ]] || { echo "API/worker containers are unavailable for rollback capture." >&2; return 11; }
  api_image="$(docker inspect -f '{{.Image}}' "$api_container")"
  worker_image="$(docker inspect -f '{{.Image}}' "$worker_container")"
  api_ref="$(docker inspect -f '{{.Config.Image}}' "$api_container")"
  worker_ref="$(docker inspect -f '{{.Config.Image}}' "$worker_container")"
  [[ "$api_image" =~ ^sha256:[0-9a-f]{64}$ && "$worker_image" =~ ^sha256:[0-9a-f]{64}$ ]] || return 11
  [[ "$api_ref" == "hz-solver2-api" || "$api_ref" == "hz-solver2-api:latest" ]] || {
    echo "API container does not use the expected hz-solver2-api image reference." >&2
    return 11
  }
  [[ "$worker_ref" == "hz-solver2-worker" || "$worker_ref" == "hz-solver2-worker:latest" ]] || {
    echo "Worker container does not use the expected hz-solver2-worker image reference." >&2
    return 11
  }
  docker image tag "$api_image" "$COMPOSE_PROJECT_NAME-api:rollback-2406"
  docker image tag "$worker_image" "$COMPOSE_PROJECT_NAME-worker:rollback-2406"
  python3 - "$ROLLBACK_COMPOSE_FILE" <<'PY'
import os
from pathlib import Path
import sys
import tempfile

path = Path(sys.argv[1])
payload = """services:
  api:
    image: hz-solver2-api:rollback-2406
    pull_policy: never
  worker:
    image: hz-solver2-worker:rollback-2406
    pull_policy: never
    environment:
      AIRFOILFOAM_ENGINE_FAMILY: openfoam
      AIRFOILFOAM_ENGINE_DISTRIBUTION: opencfd
      AIRFOILFOAM_ENGINE_VERSION: \"2406\"
      AIRFOILFOAM_ENGINE_NUMERICS_REVISION: \"1\"
      AIRFOILFOAM_ENGINE_ADAPTER_CONTRACT_VERSION: \"1\"
      AIRFOILFOAM_CELERY_QUEUE: celery
      AIRFOILFOAM_OPENFOAM_BASHRC: /usr/lib/openfoam/openfoam2406/etc/bashrc
"""
fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PY
  rollback_compose_sha="$(file_sha256 "$ROLLBACK_COMPOSE_FILE")"
  previous_build="$(read_env_var AIRFOILFOAM_BUILD_ID)"
  previous_expected="$(read_env_var ENGINE_EXPECTED_BUILD_ID)"
  previous_keys="$(read_env_var AIRFOILFOAM_ENABLED_ENGINE_KEYS)"
  pool_state="$(compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c \
    "SELECT COALESCE(json_object_agg(id::text,enabled), '{}'::json)::text FROM solver_execution_pools WHERE id IN ('$OPENCFD_2406_POOL_ID','$OPENCFD_2606_POOL_ID');")"
  receipt_temp="$(mktemp "$AIRFOILS_PRO_STATE_DIR/.remote-rollback.XXXXXX")"; chmod 600 "$receipt_temp"
  python3 - "$receipt_temp" "$api_image" "$worker_image" "$api_ref" "$worker_ref" "$previous_build" "$previous_expected" "$previous_keys" "$pool_state" "$DEPLOY_SOURCE_REVISION" "$DEPLOY_SOURCE_TREE_SHA256" "$rollback_compose_sha" <<'PY'
import json, os, sys
from datetime import datetime, timezone
from pathlib import Path
payload = {
    "schemaVersion": 1,
    "purpose": "hz-solver2-opencfd2406-runtime-rollback",
    "deployed": False,
    "apiImageId": sys.argv[2], "workerImageId": sys.argv[3],
    "apiImageReference": sys.argv[4], "workerImageReference": sys.argv[5],
    "apiRollbackTag": "hz-solver2-api:rollback-2406",
    "workerRollbackTag": "hz-solver2-worker:rollback-2406",
    "previousBuildId": sys.argv[6], "previousExpectedBuildId": sys.argv[7],
    "previousEnabledEngineKeys": sys.argv[8], "poolState": json.loads(sys.argv[9]),
    "sourceRevision": sys.argv[10], "sourceTreeSha256": sys.argv[11],
    "rollbackComposeSha256": sys.argv[12],
    "createdAt": datetime.now(timezone.utc).isoformat(),
}
path = Path(sys.argv[1])
with path.open("w", encoding="utf-8") as stream:
    json.dump(payload, stream, sort_keys=True, separators=(",", ":")); stream.write("\n")
    stream.flush(); os.fsync(stream.fileno())
PY
  mv -T "$receipt_temp" "$ROLLBACK_RECEIPT_FILE"; chmod 600 "$ROLLBACK_RECEIPT_FILE"
  file_sha256 "$ROLLBACK_RECEIPT_FILE"
}

validate_existing_rollback_receipt() {
  local fields api_image worker_image api_tag worker_tag
  fields="$(python3 - "$ROLLBACK_RECEIPT_FILE" "$DEPLOY_SOURCE_REVISION" "$DEPLOY_SOURCE_TREE_SHA256" "$OPENCFD_2406_POOL_ID" "$OPENCFD_2606_POOL_ID" "$ROLLBACK_COMPOSE_FILE" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

path = Path(sys.argv[1])
metadata = path.lstat()
if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
    raise SystemExit("rollback receipt is not a safe regular file")
if stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_uid != os.geteuid():
    raise SystemExit("rollback receipt is not owner-owned mode 0600")
payload = json.loads(path.read_bytes())
compose_path = Path(sys.argv[6])
compose_metadata = compose_path.lstat()
if (
    compose_path.is_symlink()
    or not stat.S_ISREG(compose_metadata.st_mode)
    or stat.S_IMODE(compose_metadata.st_mode) != 0o600
    or compose_metadata.st_uid != os.geteuid()
):
    raise SystemExit("rollback Compose override is not owner-owned mode 0600")
compose_sha = hashlib.sha256(compose_path.read_bytes()).hexdigest()
image_id = re.compile(r"^sha256:[0-9a-f]{64}$")
if (
    not isinstance(payload, dict)
    or payload.get("schemaVersion") != 1
    or payload.get("purpose") != "hz-solver2-opencfd2406-runtime-rollback"
    or payload.get("deployed") is not False
    or payload.get("sourceRevision") != sys.argv[2]
    or payload.get("sourceTreeSha256") != sys.argv[3]
    or not image_id.fullmatch(str(payload.get("apiImageId", "")))
    or not image_id.fullmatch(str(payload.get("workerImageId", "")))
    or payload.get("apiRollbackTag") != "hz-solver2-api:rollback-2406"
    or payload.get("workerRollbackTag") != "hz-solver2-worker:rollback-2406"
    or payload.get("rollbackComposeSha256") != compose_sha
    or payload.get("apiImageReference") not in {"hz-solver2-api", "hz-solver2-api:latest"}
    or payload.get("workerImageReference") not in {"hz-solver2-worker", "hz-solver2-worker:latest"}
    or not isinstance(payload.get("previousBuildId"), str)
    or not payload["previousBuildId"]
    or not isinstance(payload.get("previousExpectedBuildId"), str)
    or not isinstance(payload.get("previousEnabledEngineKeys"), str)
):
    raise SystemExit("rollback receipt identity differs from this cutover")
pool_state = payload.get("poolState")
if (
    not isinstance(pool_state, dict)
    or set(pool_state) != {sys.argv[4], sys.argv[5]}
    or any(not isinstance(value, bool) for value in pool_state.values())
):
    raise SystemExit("rollback receipt has an invalid execution-pool snapshot")
print("\t".join(str(payload[key]) for key in ("apiImageId", "workerImageId", "apiRollbackTag", "workerRollbackTag")))
PY
)" || return 11
  IFS=$'\t' read -r api_image worker_image api_tag worker_tag <<<"$fields"
  docker image inspect "$api_image" "$worker_image" >/dev/null || return 11
  [[ "$(docker image inspect -f '{{.Id}}' "$api_tag")" == "$api_image" ]] || return 11
  [[ "$(docker image inspect -f '{{.Id}}' "$worker_tag")" == "$worker_image" ]] || return 11
  rollback_compose config --format json | python3 -c '
import json, sys
services = json.load(sys.stdin)["services"]
api = services["api"]
worker = services["worker"]
env = worker.get("environment") or {}
expected = {
    "AIRFOILFOAM_ENGINE_FAMILY": "openfoam",
    "AIRFOILFOAM_ENGINE_DISTRIBUTION": "opencfd",
    "AIRFOILFOAM_ENGINE_VERSION": "2406",
    "AIRFOILFOAM_ENGINE_NUMERICS_REVISION": "1",
    "AIRFOILFOAM_ENGINE_ADAPTER_CONTRACT_VERSION": "1",
    "AIRFOILFOAM_CELERY_QUEUE": "celery",
    "AIRFOILFOAM_OPENFOAM_BASHRC": "/usr/lib/openfoam/openfoam2406/etc/bashrc",
}
if api.get("image") != "hz-solver2-api:rollback-2406":
    raise SystemExit("rollback API image changed")
if worker.get("image") != "hz-solver2-worker:rollback-2406":
    raise SystemExit("rollback worker image changed")
if any(str(env.get(key)) != value for key, value in expected.items()):
    raise SystemExit("rollback worker identity environment changed")
' || return 11
  file_sha256 "$ROLLBACK_RECEIPT_FILE"
}

persist_pending_state() {
  local sweeper="$1" media="$2" previous_build="$3" backup_sha="$4" rollback_sha="$5" target_build="$6"
  set_env_vars_atomic \
    "REMOTE_SOLVER2606_CUTOVER_PENDING=1" \
    "REMOTE_SOLVER2606_CUTOVER_COMPLETE=0" \
    "REMOTE_SOLVER2606_SWEEPER_WAS_RUNNING=$sweeper" \
    "REMOTE_SOLVER2606_MEDIA_REPAIR_WAS_RUNNING=$media" \
    "REMOTE_SOLVER2606_CUTOVER_PHASE=prepared" \
    "REMOTE_SOLVER2606_TARGET_BUILD_ID=$target_build" \
    "REMOTE_SOLVER2606_CUTOVER_SOURCE_REVISION=$DEPLOY_SOURCE_REVISION" \
    "REMOTE_SOLVER2606_CUTOVER_SOURCE_TREE_SHA256=$DEPLOY_SOURCE_TREE_SHA256" \
    "REMOTE_SOLVER2606_PREVIOUS_BUILD_ID=$previous_build" \
    "REMOTE_SOLVER2606_BACKUP_MANIFEST_SHA256=$backup_sha" \
    "REMOTE_SOLVER2606_ROLLBACK_RECEIPT_SHA256=$rollback_sha" \
    "REMOTE_SOLVER2606_CANARY_RECEIPT_SHA256=" \
    "REMOTE_SOLVER2606_ATTESTATION_SHA256="
}

validate_live_2606_volume_runtime() {
  local expected_build="$1"
  curl -fsS --max-time 15 http://127.0.0.1:8000/health | python3 -c '
import json, sys
payload = json.load(sys.stdin)
expected_build = sys.argv[1]
engine = payload.get("default_engine") or {}
expected_storage = {"backend":"volume","bucket":None,"object_prefix":"solver-evidence/v1","archive_format":"tar+zstd","compression":"zstd","zstd_level":10,"remote_only":False}
if engine.get("family") != "openfoam" or engine.get("distribution") != "opencfd" or engine.get("version") != "2606":
    raise SystemExit(f"live engine is not OpenCFD 2606: {engine!r}")
if payload.get("build_id") != expected_build:
    raise SystemExit(f"live build differs: {payload.get('"'"'build_id'"'"')!r}")
if payload.get("evidence_storage") != expected_storage:
    raise SystemExit(f"live volume evidence contract differs: {payload.get('"'"'evidence_storage'"'"')!r}")
' "$expected_build"
}

fail_safe() {
  local rc=$?
  if [[ -n "$CANARY_TEMP_FILE" ]]; then
    rm -f "$CANARY_TEMP_FILE" || true
    CANARY_TEMP_FILE=""
  fi
  if [[ "$PREPARE_RESTORE_WRITERS" == "true" && $rc -ne 0 ]]; then
    trap - EXIT
    echo "Remote-solver cutover preparation failed before its durable pending marker; restoring the prior writer state." >&2
    restore_writers "$PREPARE_SWEEPER_WAS_RUNNING" "$PREPARE_MEDIA_WAS_RUNNING" || true
    exit "$rc"
  fi
  if [[ "$MAINTENANCE_QUIESCE_ARMED" == "true" && $rc -ne 0 ]]; then
    trap - EXIT
    echo "Remote transfer quiescence failed before writer stop; restoring the prior transfer-pause state." >&2
    set_remote_transfer_paused "$MAINTENANCE_TRANSFER_PAUSE_WAS" || true
    exit "$rc"
  fi
  if [[ "$FAIL_SAFE_ARMED" != "true" || $rc -eq 0 ]]; then return; fi
  trap - EXIT
  if [[ "$FAIL_SAFE_CONTEXT" == "maintenance" ]]; then
    echo "Remote-solver engine maintenance stopped before live verification; keeping writers stopped and OpenCFD admission disabled." >&2
  else
    echo "Remote-solver cutover stopped before attestation; keeping writers stopped and OpenCFD 2606 admission disabled." >&2
  fi
  compose stop sweeper media-repair >/dev/null 2>&1 || true
  disable_all_opencfd_pools >/dev/null 2>&1 || true
  exit "$rc"
}
trap fail_safe EXIT

perform_rollback() {
  local state live2606 api_image worker_image api_ref worker_ref old_build old_expected old_keys old_2406_enabled old_2606_enabled
  local -a receipt_values
  state="$(python3 "$DEPLOY_SCRIPT_DIR/remote-solver2606-cutover-state.py" \
    --env-file "$ENV_FILE" --receipt-file "$RECEIPT_FILE" --attestation-file "$ATTESTATION_FILE" \
    --current-source-revision "$DEPLOY_SOURCE_REVISION" --current-source-tree-sha256 "$DEPLOY_SOURCE_TREE_SHA256" \
    --require-state pending)" || exit $?
  echo "Validated explicit rollback from durable state: $state"
  [[ "$(validate_existing_backup)" == "$(read_env_var REMOTE_SOLVER2606_BACKUP_MANIFEST_SHA256)" ]] || {
    echo "Rollback refused: verified database backup differs from its marker." >&2
    exit 14
  }
  [[ "$(validate_existing_rollback_receipt)" == "$(read_env_var REMOTE_SOLVER2606_ROLLBACK_RECEIPT_SHA256)" ]] || {
    echo "Rollback refused: runtime rollback receipt differs from its marker." >&2
    exit 14
  }
  if [[ -e "$RECEIPT_FILE" || -e "$ATTESTATION_FILE" ]]; then
    echo "Rollback is refused after a volume canary receipt exists; replay and finish that exact attestation so real 2606 evidence is not abandoned." >&2
    exit 14
  fi
  live2606="$(compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c \
    "SELECT count(*) FROM sim_jobs WHERE solver_implementation_id='$OPENCFD_2606_IMPLEMENTATION_ID';")"
  [[ "$live2606" == "0" ]] || { echo "Rollback refused: local OpenCFD 2606 jobs/evidence already exist." >&2; exit 14; }
  FAIL_SAFE_ARMED=true
  stop_writers
  disable_all_opencfd_pools
  require_recreate_safe "before explicit rollback"
  mapfile -t receipt_values < <(python3 - "$ROLLBACK_RECEIPT_FILE" <<'PY'
import json, sys
p=json.load(open(sys.argv[1], encoding="utf-8"))
pool=p["poolState"]
for value in (
    p["apiImageId"], p["workerImageId"], p["apiImageReference"],
    p["workerImageReference"], p["previousBuildId"],
    p["previousExpectedBuildId"], p["previousEnabledEngineKeys"],
    str(pool["3f8bc764-09ae-4ff3-8fd2-240600000001"]).lower(),
    str(pool["3f8bc764-09ae-4ff3-8fd2-260600000001"]).lower(),
):
    print(value)
PY
  )
  [[ "${#receipt_values[@]}" == "9" ]] || {
    echo "Rollback receipt did not yield the exact nine runtime fields." >&2
    exit 14
  }
  api_image="${receipt_values[0]}"; worker_image="${receipt_values[1]}"
  api_ref="${receipt_values[2]}"; worker_ref="${receipt_values[3]}"
  old_build="${receipt_values[4]}"; old_expected="${receipt_values[5]}"
  old_keys="${receipt_values[6]}"; old_2406_enabled="${receipt_values[7]}"
  old_2606_enabled="${receipt_values[8]}"
  docker image inspect "$api_image" "$worker_image" >/dev/null
  docker image tag "$api_image" "$api_ref"; docker image tag "$worker_image" "$worker_ref"
  set_env_vars_atomic "AIRFOILFOAM_BUILD_ID=$old_build" "ENGINE_EXPECTED_BUILD_ID=$old_expected" "AIRFOILFOAM_ENABLED_ENGINE_KEYS=$old_keys"
  rollback_compose up -d --no-build --no-deps --force-recreate api worker node-api
  wait_http "rolled-back engine" http://127.0.0.1:8000/health
  [[ "$(current_engine_version)" == "2406" ]] || { echo "Rollback image did not restore OpenCFD 2406." >&2; exit 13; }
  # The private override is only a recovery bootstrap. Leaving containers
  # permanently named against the rollback tags makes the next fresh cutover
  # unable to prove that the normal Compose references own those exact 2406
  # images. The receipt already retagged both immutable IDs to their original
  # references, so recreate once through the normal profile while the writers
  # and execution pools remain stopped, then re-prove 2406 health.
  require_recreate_safe "before normalized 2406 rollback reference recreate"
  compose up -d --no-build --no-deps --force-recreate api worker node-api
  wait_http "normalized rolled-back engine" http://127.0.0.1:8000/health
  [[ "$(current_engine_version)" == "2406" ]] || {
    echo "Normalized rollback references did not retain OpenCFD 2406." >&2
    exit 13
  }
  compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c \
    "UPDATE solver_execution_pools SET enabled=CASE id WHEN '$OPENCFD_2406_POOL_ID' THEN $old_2406_enabled WHEN '$OPENCFD_2606_POOL_ID' THEN $old_2606_enabled ELSE enabled END, \"updatedAt\"=now() WHERE id IN ('$OPENCFD_2406_POOL_ID','$OPENCFD_2606_POOL_ID');" >/dev/null
  restore_writers "$(read_env_var REMOTE_SOLVER2606_SWEEPER_WAS_RUNNING)" "$(read_env_var REMOTE_SOLVER2606_MEDIA_REPAIR_WAS_RUNNING)"
  set_env_vars_atomic \
    "REMOTE_SOLVER2606_CUTOVER_PENDING=0" "REMOTE_SOLVER2606_CUTOVER_COMPLETE=0" \
    "REMOTE_SOLVER2606_SWEEPER_WAS_RUNNING=" "REMOTE_SOLVER2606_MEDIA_REPAIR_WAS_RUNNING=" \
    "REMOTE_SOLVER2606_CUTOVER_PHASE=" "REMOTE_SOLVER2606_TARGET_BUILD_ID=" \
    "REMOTE_SOLVER2606_CUTOVER_SOURCE_REVISION=" "REMOTE_SOLVER2606_CUTOVER_SOURCE_TREE_SHA256=" \
    "REMOTE_SOLVER2606_PREVIOUS_BUILD_ID=" "REMOTE_SOLVER2606_BACKUP_MANIFEST_SHA256=" \
    "REMOTE_SOLVER2606_ROLLBACK_RECEIPT_SHA256=" "REMOTE_SOLVER2606_CANARY_RECEIPT_SHA256=" \
    "REMOTE_SOLVER2606_ATTESTATION_SHA256="
  FAIL_SAFE_ARMED=false
  echo "Explicit pre-evidence rollback restored the retained OpenCFD 2406 runtime; database and volumes were not reverted or deleted."
}

perform_complete_runtime_maintenance() {
  local sweeper_was_running media_was_running old_build old_expected pool_state
  local transfer_pause_was
  local old_2406_enabled old_2606_enabled worker_container

  [[ "$(current_engine_version)" == "2606" ]] || {
    echo "Ordinary remote maintenance requires the already-attested OpenCFD 2606 runtime." >&2
    return 13
  }
  old_build="$(read_env_var AIRFOILFOAM_BUILD_ID)"
  old_expected="$(read_env_var ENGINE_EXPECTED_BUILD_ID)"
  if [[ -z "$old_build" || "$old_expected" != "$old_build" ]]; then
    echo "Remote runtime build-id expectations are inconsistent before maintenance." >&2
    return 13
  fi
  validate_live_2606_volume_runtime "$old_build"
  pool_state="$(compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c "
SELECT concat_ws('|',
  coalesce((SELECT enabled::text FROM solver_execution_pools WHERE id='$OPENCFD_2406_POOL_ID'),'missing'),
  coalesce((SELECT enabled::text FROM solver_execution_pools WHERE id='$OPENCFD_2606_POOL_ID'),'missing')
);")"
  IFS='|' read -r old_2406_enabled old_2606_enabled <<<"$pool_state"
  if [[ ! "$old_2406_enabled" =~ ^(true|false)$ || ! "$old_2606_enabled" =~ ^(true|false)$ ]]; then
    echo "Could not capture the exact OpenCFD execution-pool state before maintenance." >&2
    return 13
  fi
  sweeper_was_running="$(writer_state sweeper)"
  media_was_running="$(writer_state media-repair)"
  echo "Remote writer state before engine maintenance: sweeper=$sweeper_was_running media-repair=$media_was_running"

  # Raise a durable transfer fence while the writer is still alive. The one
  # single-flight pass that already owns a delivery may finish normally; every
  # later pass observes the fence and declines to claim another row. Only then
  # stop the process. This closes the claim-after-probe race that otherwise
  # strands a valid GCS upload behind a fresh 30-minute lease on every rebuild.
  transfer_pause_was="$(remote_transfer_paused)"
  MAINTENANCE_TRANSFER_PAUSE_WAS="$transfer_pause_was"
  MAINTENANCE_QUIESCE_ARMED=true
  set_remote_transfer_paused "true"
  if ! wait_remote_transfer_quiescence "before writer stop"; then
    set_remote_transfer_paused "$transfer_pause_was" || true
    MAINTENANCE_QUIESCE_ARMED=false
    return 12
  fi
  MAINTENANCE_QUIESCE_ARMED=false

  # From this point any refusal leaves admission disabled and writers stopped.
  # The old running containers and env remain untouched until both post-build
  # idle samples pass.
  FAIL_SAFE_CONTEXT="maintenance"
  FAIL_SAFE_ARMED=true
  stop_writers
  disable_all_opencfd_pools
  require_maintenance_safe "before image build"

  AIRFOILFOAM_BUILD_ID="$ACTION" compose build api worker node-api sweeper media-repair
  require_maintenance_safe "after image build"
  sleep 2
  require_maintenance_safe "stabilized before service recreate"

  set_env_vars_atomic \
    "AIRFOILFOAM_BUILD_ID=$ACTION" \
    "ENGINE_EXPECTED_BUILD_ID=$ACTION"
  compose up -d --no-build --no-deps --force-recreate api worker node-api
  wait_http "maintained engine API" http://127.0.0.1:8000/health
  wait_http "maintained node API" http://127.0.0.1:4000/health
  validate_live_2606_volume_runtime "$ACTION"

  worker_container="$(compose ps -q worker)"
  [[ -n "$worker_container" ]] || {
    echo "Maintained worker container is missing." >&2
    return 13
  }
  docker inspect "$worker_container" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
limits = {
    row.get("Name"): (row.get("Soft"), row.get("Hard"))
    for row in payload[0].get("HostConfig", {}).get("Ulimits", [])
    if isinstance(row, dict)
}
if limits.get("nofile") != (65536, 524288):
    raise SystemExit(f"live worker nofile limit differs: {limits.get('"'"'nofile'"'"')!r}")
'

  compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c \
    "UPDATE solver_execution_pools SET enabled=CASE id WHEN '$OPENCFD_2406_POOL_ID' THEN $old_2406_enabled WHEN '$OPENCFD_2606_POOL_ID' THEN $old_2606_enabled ELSE enabled END, \"updatedAt\"=now() WHERE id IN ('$OPENCFD_2406_POOL_ID','$OPENCFD_2606_POOL_ID');" >/dev/null
  restore_writers "$sweeper_was_running" "$media_was_running"
  set_remote_transfer_paused "$transfer_pause_was"
  FAIL_SAFE_ARMED=false
  echo "hz-solver2 ordinary engine maintenance installed build $ACTION without consuming or cancelling active promise leases."
  compose ps
}

main() {
  exec 9>"$LOCK_FILE"; flock -n 9 || { echo "Another deployment is running." >&2; exit 9; }
  verify_deployment_source
  validate_compose_profile
  if [[ "$ACTION" == "--rollback" ]]; then perform_rollback; return; fi

  local state version phase target_build sweeper_was_running media_was_running previous_build backup_sha rollback_sha
  state="$(python3 "$DEPLOY_SCRIPT_DIR/remote-solver2606-cutover-state.py" \
    --env-file "$ENV_FILE" --receipt-file "$RECEIPT_FILE" --attestation-file "$ATTESTATION_FILE" \
    --current-source-revision "$DEPLOY_SOURCE_REVISION" --current-source-tree-sha256 "$DEPLOY_SOURCE_TREE_SHA256" \
    --require-state any)" || exit $?
  if [[ "$state" == "complete" ]]; then
    perform_complete_runtime_maintenance
    return
  fi
  if [[ "$state" == "pristine" ]]; then
    version="$(current_engine_version)"
    [[ "$version" == "2406" ]] || { echo "Pristine cutover requires the corroborated OpenCFD 2406 runtime." >&2; exit 13; }
    require_idle "before writer quiescence"
    sweeper_was_running="$(writer_state sweeper)"; media_was_running="$(writer_state media-repair)"
    PREPARE_SWEEPER_WAS_RUNNING="$sweeper_was_running"
    PREPARE_MEDIA_WAS_RUNNING="$media_was_running"
    PREPARE_RESTORE_WRITERS=true
    stop_writers
    require_idle "after writer quiescence"
    backup_sha="$(create_verified_backup)"
    rollback_sha="$(create_rollback_receipt)"
    previous_build="$(read_env_var AIRFOILFOAM_BUILD_ID)"
    persist_pending_state "$sweeper_was_running" "$media_was_running" "$previous_build" "$backup_sha" "$rollback_sha" "$ACTION"
    PREPARE_RESTORE_WRITERS=false
    FAIL_SAFE_ARMED=true
  else
    target_build="$(read_env_var REMOTE_SOLVER2606_TARGET_BUILD_ID)"
    if [[ "$target_build" != "$ACTION" ]]; then
      echo "Pending cutover is bound to build $target_build; refusing substitution with $ACTION." >&2
      exit 14
    fi
    FAIL_SAFE_ARMED=true
    stop_writers
    backup_sha="$(validate_existing_backup)"
    rollback_sha="$(validate_existing_rollback_receipt)"
    if [[ "$backup_sha" != "$(read_env_var REMOTE_SOLVER2606_BACKUP_MANIFEST_SHA256)" \
      || "$rollback_sha" != "$(read_env_var REMOTE_SOLVER2606_ROLLBACK_RECEIPT_SHA256)" ]]; then
      echo "Pending cutover recovery artifacts differ from their durable markers." >&2
      exit 14
    fi
  fi

  target_build="$(read_env_var REMOTE_SOLVER2606_TARGET_BUILD_ID)"
  [[ "$target_build" == "$ACTION" ]] || { echo "Durable target build binding changed." >&2; exit 14; }
  phase="$(read_env_var REMOTE_SOLVER2606_CUTOVER_PHASE)"

  if [[ "$phase" == "prepared" ]]; then
    disable_all_opencfd_pools
    AIRFOILFOAM_BUILD_ID="$ACTION" compose build api worker node-api sweeper media-repair
    require_idle "after image build"
    sleep 2
    require_idle "stabilized before service recreate"
    set_env_vars_atomic \
      "AIRFOILFOAM_BUILD_ID=$ACTION" "ENGINE_EXPECTED_BUILD_ID=$ACTION" \
      "AIRFOILFOAM_ENABLED_ENGINE_KEYS=openfoam:opencfd:2606:numerics-1:adapter-1" \
      "REMOTE_SOLVER2606_CUTOVER_PHASE=runtime-recreate-ready"
    phase="runtime-recreate-ready"
  fi

  if [[ "$phase" == "runtime-recreate-ready" ]]; then
    disable_all_opencfd_pools
    stop_writers
    require_recreate_safe "before OpenCFD 2606 service recreate"
    compose up -d --no-build --no-deps --force-recreate api worker node-api
    compose up --no-start --no-deps --force-recreate sweeper media-repair
    wait_http "engine API" http://127.0.0.1:8000/health
    wait_http "node API" http://127.0.0.1:4000/health
    validate_live_2606_volume_runtime "$ACTION"
    disable_all_opencfd_pools
    set_env_vars_atomic "REMOTE_SOLVER2606_CUTOVER_PHASE=runtime-installed"
    phase="runtime-installed"
  fi

  [[ "$phase" == "runtime-installed" ]] || { echo "Unsupported durable cutover phase: $phase" >&2; exit 14; }
  validate_live_2606_volume_runtime "$ACTION"
  require_idle "before volume canary or retained-receipt reproof"
  enable_pool "$OPENCFD_2606_POOL_ID"

  local receipt_temp receipt_sha attestation_sha
  if [[ -f "$RECEIPT_FILE" ]]; then
    echo "Re-proving retained volume canary receipt against the live archive-only render path."
    python3 "$DEPLOY_SCRIPT_DIR/openfoam_2606_volume_canary.py" \
      --gateway-url http://127.0.0.1:8000 --expected-build-id "$ACTION" \
      --verify-receipt "$RECEIPT_FILE" >/dev/null
  else
    receipt_temp="$(mktemp "$AIRFOILS_PRO_STATE_DIR/.remote-volume-canary.XXXXXX")"; chmod 600 "$receipt_temp"
    CANARY_TEMP_FILE="$receipt_temp"
    python3 "$DEPLOY_SCRIPT_DIR/openfoam_2606_volume_canary.py" \
      --gateway-url http://127.0.0.1:8000 --expected-build-id "$ACTION" >"$receipt_temp"
    python3 "$DEPLOY_SCRIPT_DIR/persist-json-receipt.py" \
      --profile opencfd2606-volume-canary --source "$receipt_temp" --destination "$RECEIPT_FILE"
    receipt_temp=""
    CANARY_TEMP_FILE=""
  fi
  receipt_sha="$(file_sha256 "$RECEIPT_FILE")"
  set_env_vars_atomic "REMOTE_SOLVER2606_CANARY_RECEIPT_SHA256=$receipt_sha"

  if [[ ! -f "$ATTESTATION_FILE" ]]; then
    attestation_sha="$(python3 "$DEPLOY_SCRIPT_DIR/attest-remote-solver2606-volume.py" \
      --receipt "$RECEIPT_FILE" --destination "$ATTESTATION_FILE" \
      --source-revision "$DEPLOY_SOURCE_REVISION" --source-tree-sha256 "$DEPLOY_SOURCE_TREE_SHA256" \
      --backup-manifest-sha256 "$(read_env_var REMOTE_SOLVER2606_BACKUP_MANIFEST_SHA256)" \
      --rollback-receipt-sha256 "$(read_env_var REMOTE_SOLVER2606_ROLLBACK_RECEIPT_SHA256)")"
  else
    attestation_sha="$(file_sha256 "$ATTESTATION_FILE")"
  fi
  set_env_vars_atomic "REMOTE_SOLVER2606_ATTESTATION_SHA256=$attestation_sha"
  python3 "$DEPLOY_SCRIPT_DIR/remote-solver2606-cutover-state.py" \
    --env-file "$ENV_FILE" --receipt-file "$RECEIPT_FILE" --attestation-file "$ATTESTATION_FILE" \
    --current-source-revision "$DEPLOY_SOURCE_REVISION" --current-source-tree-sha256 "$DEPLOY_SOURCE_TREE_SHA256" \
    --require-state pending >/dev/null

  sweeper_was_running="$(read_env_var REMOTE_SOLVER2606_SWEEPER_WAS_RUNNING)"
  media_was_running="$(read_env_var REMOTE_SOLVER2606_MEDIA_REPAIR_WAS_RUNNING)"
  restore_writers "$sweeper_was_running" "$media_was_running"
  set_env_vars_atomic \
    "REMOTE_SOLVER2606_CUTOVER_PENDING=0" "REMOTE_SOLVER2606_CUTOVER_COMPLETE=1" \
    "REMOTE_SOLVER2606_SWEEPER_WAS_RUNNING=" "REMOTE_SOLVER2606_MEDIA_REPAIR_WAS_RUNNING=" \
    "REMOTE_SOLVER2606_CUTOVER_PHASE=" "REMOTE_SOLVER2606_TARGET_BUILD_ID=" \
    "REMOTE_SOLVER2606_CUTOVER_SOURCE_REVISION=" "REMOTE_SOLVER2606_CUTOVER_SOURCE_TREE_SHA256=" \
    "REMOTE_SOLVER2606_PREVIOUS_BUILD_ID="
  python3 "$DEPLOY_SCRIPT_DIR/remote-solver2606-cutover-state.py" \
    --env-file "$ENV_FILE" --receipt-file "$RECEIPT_FILE" --attestation-file "$ATTESTATION_FILE" \
    --current-source-revision "$DEPLOY_SOURCE_REVISION" --current-source-tree-sha256 "$DEPLOY_SOURCE_TREE_SHA256" \
    --require-state non-pending >/dev/null
  FAIL_SAFE_ARMED=false
  echo "hz-solver2 now runs attested OpenCFD 2606 with 40 CPU slots and retained volume tar.zst evidence."
  compose ps
}

main
