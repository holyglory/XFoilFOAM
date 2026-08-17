#!/usr/bin/env bash
# Restore a wedged production engine *gateway* only after a receipt-bound,
# physically-idle proof.  This is intentionally not a general engine rebuild:
# it never builds, restarts, or recreates a worker and it never changes
# scheduler admission or starts a writer.
#
# A synchronous FastAPI gateway can exhaust its request pool while the Celery
# worker itself is idle.  Normal `rebuild-engine.sh` correctly refuses that
# state because its `/queue` proof is unavailable.  This tool is the narrowly
# reviewed recovery path for that one condition.  It obtains a direct Celery +
# Redis proof from the existing API container, binds every active database row
# to the immutable maintenance receipt, preserves the gateway logs, replaces
# only `api`, and then requires the normal fresh `/queue` contract.
#
# Usage:
#   scripts/deploy/recover-production-engine-gateway-liveness.sh \
#     --expected-build-id <build-id> \
#     --expected-source-revision <40-lowercase-hex> \
#     --expected-source-tree-sha256 <64-lowercase-hex> \
#     --maintenance-token <canonical-uuid> \
#     --expected-receipt-sha256 <64-lowercase-hex> \
#     --expected-candidate-digest <64-lowercase-hex>
#
# The maintenance token and stopped writers remain unchanged on success.  A
# separate receipt reconciliation owns settling the preserved jobs and opening
# scheduler admission afterwards.
set -Eeuo pipefail

readonly SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
readonly OPENFOAM_PROCESS_RE='[s]impleFoam|[p]impleFoam|[p]otentialFoam|[s]nappyHexMesh|[s]urfaceFeatureExtract|[b]lockMesh|[c]heckMesh|[d]ecomposePar|[r]econstructPar|[r]enumberMesh|[m]apFields|[p]ostProcess|[f]oamToVTK|[f]oamRun|[f]oamJob'
readonly SAMPLE_DELAY_SECONDS=3
readonly DIRECT_PROBE_TIMEOUT_SECONDS=20

APP_DIR_INPUT="${APP_DIR:-/opt/airfoils-pro/app}"
ACTIVE_APP_LINK="${ACTIVE_APP_LINK:-}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-}"
COMPOSE_FILE="${COMPOSE_FILE:-}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
COMPOSE_OVERRIDE_FILE="${COMPOSE_OVERRIDE_FILE:-}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"
DEPLOYMENT_MANIFEST_FILE="${DEPLOYMENT_MANIFEST_FILE:-}"
PRODUCTION_MAINTENANCE_RECEIPT_FILE="${PRODUCTION_MAINTENANCE_RECEIPT_FILE:-$AIRFOILS_PRO_STATE_DIR/production-legacy-gateway-reconciliation.json}"
GATEWAY_LOG_DIR="${GATEWAY_LOG_DIR:-$AIRFOILS_PRO_STATE_DIR/gateway-liveness-recovery-logs}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

EXPECTED_BUILD_ID=""
EXPECTED_SOURCE_REVISION=""
EXPECTED_SOURCE_TREE_SHA256=""
MAINTENANCE_TOKEN=""
EXPECTED_RECEIPT_SHA256=""
EXPECTED_CANDIDATE_DIGEST=""
COMPOSE_READY=false

usage() {
  sed -n '1,28p' "${BASH_SOURCE[0]}" >&2
}

die() {
  printf '%s: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 12
}

while (($#)); do
  case "$1" in
    --expected-build-id) EXPECTED_BUILD_ID="${2:-}"; shift 2 ;;
    --expected-source-revision) EXPECTED_SOURCE_REVISION="${2:-}"; shift 2 ;;
    --expected-source-tree-sha256) EXPECTED_SOURCE_TREE_SHA256="${2:-}"; shift 2 ;;
    --maintenance-token) MAINTENANCE_TOKEN="${2:-}"; shift 2 ;;
    --expected-receipt-sha256) EXPECTED_RECEIPT_SHA256="${2:-}"; shift 2 ;;
    --expected-candidate-digest) EXPECTED_CANDIDATE_DIGEST="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done

[[ "$EXPECTED_BUILD_ID" =~ ^[A-Za-z0-9._-]+$ ]] || die "--expected-build-id is invalid"
[[ "$EXPECTED_SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || die "--expected-source-revision is invalid"
[[ "$EXPECTED_SOURCE_TREE_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "--expected-source-tree-sha256 is invalid"
[[ "$MAINTENANCE_TOKEN" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || die "--maintenance-token is invalid"
[[ "$EXPECTED_RECEIPT_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "--expected-receipt-sha256 is invalid"
[[ "$EXPECTED_CANDIDATE_DIGEST" =~ ^[0-9a-f]{64}$ ]] || die "--expected-candidate-digest is invalid"

[[ -d "$APP_DIR_INPUT" ]] || die "APP_DIR must be an existing application directory"
if [[ -z "$ACTIVE_APP_LINK" && -L "$APP_DIR_INPUT" ]]; then
  ACTIVE_APP_LINK="$APP_DIR_INPUT"
fi
APP_DIR="$(cd "$APP_DIR_INPUT" && pwd -P)"
[[ -n "$ENV_FILE" ]] || ENV_FILE="$AIRFOILS_PRO_STATE_DIR/.env.deploy"
[[ -n "$COMPOSE_FILE" ]] || COMPOSE_FILE="$APP_DIR/docker-compose.deploy.yml"
[[ -n "$DEPLOYMENT_MANIFEST_FILE" ]] || DEPLOYMENT_MANIFEST_FILE="$APP_DIR/.deployment-source.json"
DEPLOY_SCRIPT_DIR="$APP_DIR/scripts/deploy"
[[ -d "$DEPLOY_SCRIPT_DIR" ]] || die "deployment script directory is missing"
[[ -f "$DEPLOY_SCRIPT_DIR/deployment-source-manifest.py" ]] || die "source manifest verifier is missing"
[[ -f "$DEPLOY_SCRIPT_DIR/deployment-env-preflight.py" ]] || die "deployment environment verifier is missing"
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || die "deployment env file is missing or unsafe"
[[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] || die "compose file is missing or unsafe"
[[ -f "$DEPLOYMENT_MANIFEST_FILE" && ! -L "$DEPLOYMENT_MANIFEST_FILE" ]] || die "deployment source manifest is missing or unsafe"
[[ -f "$PRODUCTION_MAINTENANCE_RECEIPT_FILE" && ! -L "$PRODUCTION_MAINTENANCE_RECEIPT_FILE" ]] || die "production maintenance receipt is missing or unsafe"
[[ "$(readlink -f "$COMPOSE_FILE")" == "$APP_DIR/docker-compose.deploy.yml" ]] || die "compose file must belong to the pinned application release"
[[ "$(readlink -f "$DEPLOYMENT_MANIFEST_FILE")" == "$APP_DIR/.deployment-source.json" ]] || die "deployment manifest must belong to the pinned application release"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$SCRIPT_NAME"
[[ "$SCRIPT_PATH" == "$DEPLOY_SCRIPT_DIR/$SCRIPT_NAME" ]] || die "gateway recovery script must run from the verified APP_DIR source tree"

verify_active_release() {
  local active_release
  [[ -n "$ACTIVE_APP_LINK" ]] || return 0
  active_release="$(cd "$ACTIVE_APP_LINK" && pwd -P)" || die "active application link is unavailable"
  [[ "$active_release" == "$APP_DIR" ]] || die "active application release changed during gateway recovery"
}

verify_active_release
"$PYTHON_BIN" "$DEPLOY_SCRIPT_DIR/deployment-env-preflight.py" \
  --app-dir "$APP_DIR" --state-dir "$AIRFOILS_PRO_STATE_DIR" --env-file "$ENV_FILE" \
  >/dev/null || die "deployment environment is not eligible for gateway recovery"
# shellcheck source=scripts/deploy/deployment-compose-profile.sh
source "$DEPLOY_SCRIPT_DIR/deployment-compose-profile.sh"
configure_deployment_compose_profile || die "could not configure the deployment compose profile"
[[ "$DEPLOYMENT_ROLE" == "hub" ]] || die "gateway recovery is production-hub only"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi
compose() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" "${COMPOSE_FILE_ARGS[@]}" "$@"
}
compose_with_timeout() {
  local timeout_seconds="$1"
  shift
  timeout --signal=TERM "$timeout_seconds" "${COMPOSE[@]}" \
    --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" "${COMPOSE_FILE_ARGS[@]}" "$@"
}
COMPOSE_READY=true

read_env_var() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

verify_source() {
  local fields revision tree_sha file_count
  fields="$("$PYTHON_BIN" "$DEPLOY_SCRIPT_DIR/deployment-source-manifest.py" --verify --root "$APP_DIR" --manifest "$DEPLOYMENT_MANIFEST_FILE")" || return 1
  IFS=$'\t' read -r revision tree_sha file_count <<<"$fields"
  [[ "$revision" == "$EXPECTED_SOURCE_REVISION" ]] || return 1
  [[ "$tree_sha" == "$EXPECTED_SOURCE_TREE_SHA256" ]] || return 1
  printf 'Verified gateway recovery source: revision=%s sha256=%s files=%s\n' "$revision" "$tree_sha" "$file_count"
}

verify_receipt_binding() {
  "$PYTHON_BIN" - "$PRODUCTION_MAINTENANCE_RECEIPT_FILE" "$MAINTENANCE_TOKEN" \
    "$EXPECTED_RECEIPT_SHA256" "$EXPECTED_CANDIDATE_DIGEST" <<'PY'
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import stat
import sys
import uuid

path = Path(sys.argv[1])
token, expected_sha, expected_digest = sys.argv[2:]
metadata = path.lstat()
if not stat.S_ISREG(metadata.st_mode) or path.is_symlink() or stat.S_IMODE(metadata.st_mode) != 0o600:
    raise SystemExit("maintenance receipt is not a regular mode-0600 file")
raw = path.read_bytes()
if hashlib.sha256(raw).hexdigest() != expected_sha:
    raise SystemExit("maintenance receipt SHA-256 changed")
value = json.loads(raw)
required = {
    "schemaVersion", "maintenanceToken", "affectedRuntime", "authoritativeObservedAt",
    "candidates", "candidateDigest",
}
if not isinstance(value, dict) or set(value) != required or value.get("schemaVersion") != 1:
    raise SystemExit("maintenance receipt schema is invalid")
if value.get("maintenanceToken") != token or value.get("candidateDigest") != expected_digest:
    raise SystemExit("maintenance receipt is not bound to this exact recovery")
expected_runtime = {
    "build_id": "b7d9213f59f2c1c19b8890b1500b81cf168d83aa",
    "engine_version": "2606",
    "urans_recovery_version": 12,
    "archive_reduction_version": 4,
    "queue_observation_version": 1,
}
runtime = value.get("affectedRuntime")
if (
    not isinstance(runtime, dict)
    or set(runtime) != set(expected_runtime)
    or any(
        type(runtime[field]) is not type(expected) or runtime[field] != expected
        for field, expected in expected_runtime.items()
    )
):
    raise SystemExit("maintenance receipt is not bound to the exact affected gateway runtime")
candidates = value.get("candidates")
if not isinstance(candidates, list) or not candidates or len(candidates) > 100:
    raise SystemExit("maintenance receipt candidate scope is invalid")
candidate_keys = {
    "jobId", "engineJobId", "databaseStatus", "engineStatus", "engineMessage",
    "settlementAction", "statusSha256", "resultSha256",
}
ids, engine_ids = set(), set()
for candidate in candidates:
    if not isinstance(candidate, dict) or set(candidate) != candidate_keys:
        raise SystemExit("maintenance receipt candidate schema is invalid")
    job_id = candidate["jobId"]
    engine_id = candidate["engineJobId"]
    try:
        canonical_job_id = str(uuid.UUID(job_id))
    except (ValueError, TypeError, AttributeError):
        raise SystemExit("maintenance receipt candidate database identity is invalid")
    if job_id != canonical_job_id or not isinstance(engine_id, str) or not re.fullmatch(r"[0-9a-f]{32}", engine_id):
        raise SystemExit("maintenance receipt candidate identity is invalid")
    if job_id in ids or engine_id in engine_ids:
        raise SystemExit("maintenance receipt candidate identities are duplicated")
    ids.add(job_id); engine_ids.add(engine_id)
    if candidate["databaseStatus"] not in {"running", "ingesting"}:
        raise SystemExit("maintenance receipt candidate database status is invalid")
    if candidate["engineStatus"] not in {"completed", "failed", "cancelled"}:
        raise SystemExit("maintenance receipt candidate engine status is invalid")
    if candidate["settlementAction"] not in {"ingest", "release_cancelled", "release_worker_restart_orphan"}:
        raise SystemExit("maintenance receipt candidate settlement action is invalid")
    if ((candidate["settlementAction"] == "release_cancelled" and candidate["engineStatus"] != "cancelled")
        or (candidate["settlementAction"] == "release_worker_restart_orphan" and candidate["engineStatus"] != "failed")
        or (candidate["settlementAction"] == "ingest" and candidate["engineStatus"] not in {"completed", "failed"})):
        raise SystemExit("maintenance receipt settlement action disagrees with terminal evidence")
    if any(not isinstance(candidate[name], str) or not re.fullmatch(r"[0-9a-f]{64}", candidate[name]) for name in ("statusSha256", "resultSha256")):
        raise SystemExit("maintenance receipt candidate evidence digest is invalid")
print(json.dumps(value, sort_keys=True, separators=(",", ":")))
PY
}

verify_writers_stopped_and_drain_owned() {
  local service running postgres_id state
  for service in sweeper media-repair; do
    running="$(compose ps --status running -q "$service")" || die "could not inspect $service"
    [[ -z "$running" ]] || die "$service is still running; gateway-only recovery refuses to change writer state"
  done
  postgres_id="$(compose ps --status running -q postgres)"
  [[ -n "$postgres_id" && "$(wc -l <<<"$postgres_id")" -eq 1 ]] || die "postgres is not uniquely running"
  state="$(docker exec "$postgres_id" psql -U aerodb -d aerodb -X -A -t -v ON_ERROR_STOP=1 -c "
SELECT json_build_object(
  'enabled', enabled,
  'admission_fence_active', admission_fence_active,
  'maintenance_drain_token', maintenance_drain_token::text,
  'maintenance_drain_started_at', maintenance_drain_started_at
)::text FROM sweeper_state WHERE id = 1;")" || die "could not inspect production maintenance drain"
  printf '%s' "$state" | "$PYTHON_BIN" -c '
import json, sys
value = json.load(sys.stdin)
token = sys.argv[1]
if (not isinstance(value, dict) or value.get("enabled") is not False
    or value.get("admission_fence_active") is not False
    or value.get("maintenance_drain_token") != token
    or not isinstance(value.get("maintenance_drain_started_at"), str)):
    raise SystemExit("maintenance drain ownership is not exact")
' "$MAINTENANCE_TOKEN" || die "maintenance drain ownership is not exact"
}

container_env() {
  local container_id="$1" prefix="$2"
  docker inspect "$container_id" --format '{{json .Config.Env}}' | "$PYTHON_BIN" -c '
import json, sys
values = json.load(sys.stdin)
prefix = sys.argv[1]
found = [value.split("=", 1)[1] for value in values if value.startswith(prefix + "=")]
if len(found) != 1:
    raise SystemExit(f"container environment {prefix} is missing or ambiguous")
print(found[0])
' "$prefix"
}

running_worker_services() {
  local service ids
  compose --profile '*' config --services | awk '$0 == "worker" || $0 ~ /^worker-/' | while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    ids="$(compose --profile '*' ps --status running -q "$service")" || exit 12
    [[ -z "$ids" ]] || printf '%s\n' "$service"
  done
}

build_identity_probe() {
  local configured configured_node_expected api_id node_api_id worker_services worker_service worker_id served_build node_expected api_build worker_build health_payload
  configured="$(read_env_var AIRFOILFOAM_BUILD_ID || true)"
  [[ "$configured" == "$EXPECTED_BUILD_ID" ]] || { echo "deployment AIRFOILFOAM_BUILD_ID does not match expected build" >&2; return 12; }
  configured_node_expected="$(read_env_var ENGINE_EXPECTED_BUILD_ID || true)"
  [[ "$configured_node_expected" == "$EXPECTED_BUILD_ID" ]] || { echo "deployment ENGINE_EXPECTED_BUILD_ID does not match expected build" >&2; return 12; }
  api_id="$(compose ps --status running -q api)" || { echo "could not inspect engine api during startup" >&2; return 75; }
  [[ -n "$api_id" && "$(wc -l <<<"$api_id")" -eq 1 ]] || { echo "engine api is not yet uniquely running" >&2; return 75; }
  node_api_id="$(compose ps --status running -q node-api)" || { echo "could not inspect node-api" >&2; return 12; }
  [[ -n "$node_api_id" && "$(wc -l <<<"$node_api_id")" -eq 1 ]] || { echo "node-api is not uniquely running" >&2; return 12; }
  api_build="$(container_env "$api_id" AIRFOILFOAM_BUILD_ID)" || { echo "could not read api build identity during startup" >&2; return 75; }
  node_expected="$(container_env "$node_api_id" ENGINE_EXPECTED_BUILD_ID)" || { echo "could not read node-api engine expectation" >&2; return 12; }
  [[ "$api_build" == "$EXPECTED_BUILD_ID" && "$node_expected" == "$EXPECTED_BUILD_ID" ]] || { echo "served control-plane container build expectations differ" >&2; return 12; }
  worker_services="$(running_worker_services)" || { echo "could not enumerate engine workers" >&2; return 12; }
  [[ -n "$worker_services" ]] || { echo "no engine worker container is running" >&2; return 12; }
  while IFS= read -r worker_service; do
    [[ -n "$worker_service" ]] || continue
    worker_id="$(compose --profile '*' ps --status running -q "$worker_service")" || { echo "could not inspect engine worker $worker_service" >&2; return 12; }
    [[ -n "$worker_id" && "$(wc -l <<<"$worker_id")" -eq 1 ]] || { echo "engine worker $worker_service is not uniquely running" >&2; return 12; }
    worker_build="$(container_env "$worker_id" AIRFOILFOAM_BUILD_ID)" || { echo "could not read worker build identity" >&2; return 12; }
    [[ "$worker_build" == "$EXPECTED_BUILD_ID" ]] || { echo "engine worker $worker_service serves a different build" >&2; return 12; }
  done <<<"$worker_services"
  health_payload="$(curl -fsS --max-time 8 http://127.0.0.1:8000/health)" || { echo "engine health is temporarily unavailable" >&2; return 75; }
  served_build="$(printf '%s' "$health_payload" | "$PYTHON_BIN" -c '
import json, sys
value = json.load(sys.stdin)
build = value.get("build_id")
engine = value.get("default_engine")
if not isinstance(build, str) or not build or not isinstance(engine, dict) or engine.get("version") != "2606":
    raise SystemExit("engine health has incomplete modern runtime identity")
print(build)
')" || { echo "engine health is malformed" >&2; return 12; }
  [[ "$served_build" == "$EXPECTED_BUILD_ID" ]] || { echo "engine health serves a different build" >&2; return 12; }
  curl -fsS --max-time 8 http://127.0.0.1:4000/health >/dev/null || { echo "node-api health is unavailable" >&2; return 12; }
}

verify_build_identity() {
  build_identity_probe || die "engine/node build identity is not exact"
}

active_database_snapshot() {
  local postgres_id
  postgres_id="$(compose ps --status running -q postgres)"
  [[ -n "$postgres_id" && "$(wc -l <<<"$postgres_id")" -eq 1 ]] || die "postgres is not uniquely running"
  docker exec "$postgres_id" psql -U aerodb -d aerodb -X -A -t -v ON_ERROR_STOP=1 -c "
SELECT COALESCE(json_agg(json_build_object(
  'id', job.id,
  'status', job.status,
  'engine_state', job.engine_state,
  'engine_job_id', job.engine_job_id,
  'ingested_at', job.\"ingestedAt\",
  'ingest_lease_live', (
    job.status = 'ingesting' AND (
      job.ingest_lease_expires_at > now() OR
      (job.ingest_lease_expires_at IS NULL AND job.\"updatedAt\" > now() - (600000 * interval '1 millisecond'))
    )
  )
) ORDER BY job.id), '[]'::json)::text
FROM sim_jobs AS job
WHERE job.status IN ('pending', 'submitted', 'running', 'ingesting');"
}

receipt_evidence_snapshot() {
  local receipt_json="$1"
  printf '%s' "$receipt_json" | compose_with_timeout "$DIRECT_PROBE_TIMEOUT_SECONDS" exec -T api python3 -c '
# AIRFOILS_PRO_GATEWAY_LIVENESS_RECEIPT_EVIDENCE_PROBE
import hashlib
import json
from pathlib import Path
import stat
import sys
from airfoilfoam.storage import JobStore

receipt = json.load(sys.stdin)
candidates = receipt.get("candidates")
if not isinstance(candidates, list):
    raise SystemExit("invalid receipt candidate transport")
store = JobStore()
out = {}
for candidate in candidates:
    engine_id = candidate.get("engineJobId") if isinstance(candidate, dict) else None
    if not isinstance(engine_id, str) or engine_id in out:
        raise SystemExit("invalid receipt engine identity")
    base = store.job_dir(engine_id)
    result = {}
    for name in ("status.json", "result.json"):
        path = base / name
        metadata = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
            raise SystemExit(f"unsafe or missing {name} for {engine_id}")
        digest = hashlib.sha256()
        raw = bytearray()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
                if name == "status.json":
                    raw.extend(block)
        result[name] = digest.hexdigest()
        if name == "status.json":
            status = json.loads(raw.decode("utf-8"))
    out[engine_id] = {
        "statusSha256": result["status.json"],
        "resultSha256": result["result.json"],
        "statusJobId": status.get("job_id") if isinstance(status, dict) else None,
        "statusState": status.get("state") if isinstance(status, dict) else None,
        "statusPhase": status.get("phase") if isinstance(status, dict) else None,
        "statusCpuHeld": status.get("cpu_tokens_held") if isinstance(status, dict) else None,
        "statusCpuWaiting": status.get("cpu_tokens_waiting") if isinstance(status, dict) else None,
    }
print(json.dumps(out, sort_keys=True, separators=(",", ":")))
'
}

verify_receipt_bound_active_rows() {
  local receipt_json="$1" db_json evidence_json
  db_json="$(active_database_snapshot)" || die "could not obtain active database snapshot"
  evidence_json="$(receipt_evidence_snapshot "$receipt_json")" || die "could not obtain exact receipt evidence snapshot"
  "$PYTHON_BIN" - "$receipt_json" "$db_json" "$evidence_json" <<'PY'
from __future__ import annotations

import json
import sys

receipt, rows, evidence = (json.loads(value) for value in sys.argv[1:])
if not isinstance(rows, list) or not isinstance(evidence, dict):
    raise SystemExit("active database/evidence snapshot is malformed")
candidates = receipt["candidates"]
by_id = {candidate["jobId"]: candidate for candidate in candidates}
if len(by_id) != len(candidates):
    raise SystemExit("receipt candidate IDs are not unique")
expected_keys = {"id", "status", "engine_state", "engine_job_id", "ingested_at", "ingest_lease_live"}
for row in rows:
    if not isinstance(row, dict) or set(row) != expected_keys:
        raise SystemExit("active database row is malformed")
    candidate = by_id.get(row["id"])
    if candidate is None:
        raise SystemExit("active database job is outside the immutable receipt")
    if row["engine_job_id"] != candidate["engineJobId"]:
        raise SystemExit("receipt-bound database engine identity drifted")
    proof = evidence.get(candidate["engineJobId"])
    if not isinstance(proof, dict):
        raise SystemExit("receipt-bound engine evidence is missing")
    if proof.get("statusSha256") != candidate["statusSha256"] or proof.get("resultSha256") != candidate["resultSha256"]:
        raise SystemExit("receipt-bound engine evidence digest drifted")
    if (proof.get("statusJobId") != candidate["engineJobId"]
        or proof.get("statusState") != candidate["engineStatus"]
        or proof.get("statusPhase") != candidate["engineStatus"]
        or proof.get("statusCpuHeld") != 0
        or proof.get("statusCpuWaiting") != 0):
        raise SystemExit("receipt-bound engine status is not terminal and exact")
    # The only tolerated changed database shape is the known failed
    # receipt-retry rollback: an expired ingest lease was returned to running
    # without ever publishing an ingest receipt.  It is still the same exact
    # terminal engine evidence and cannot admit a new job or broaden scope.
    rollback = (
        candidate["databaseStatus"] == "ingesting"
        and candidate["settlementAction"] == "ingest"
        and row["status"] == "running"
        and row["engine_state"] == "completed"
        and row["ingested_at"] is None
        and row["ingest_lease_live"] is False
    )
    original = (
        row["status"] == candidate["databaseStatus"]
        and row["status"] in {"running", "ingesting"}
        and row["ingest_lease_live"] is False
    )
    if not (original or rollback):
        raise SystemExit("receipt-bound database row is not the exact original or known retry rollback shape")
print("All active database jobs are receipt-bound terminal evidence (including only the known retry rollback shape).")
PY
}

direct_celery_redis_snapshot() {
  compose_with_timeout "$DIRECT_PROBE_TIMEOUT_SECONDS" exec -T api python3 -c '
# AIRFOILS_PRO_GATEWAY_LIVENESS_DIRECT_CELERY_REDIS_PROBE
import json
import signal
from redis import Redis
from airfoilfoam.celery_app import celery_app
from airfoilfoam.config import get_settings
from airfoilfoam.openfoam.dialects import get_openfoam_dialect, supported_openfoam_identities

def deadline(_signum, _frame):
    raise TimeoutError("direct gateway liveness Celery/Redis probe exceeded 15 seconds")

signal.signal(signal.SIGALRM, deadline)
signal.alarm(15)
settings = get_settings()
inspect = celery_app.control.inspect(timeout=3.0)
snapshot = {
    "active": inspect.active(),
    "reserved": inspect.reserved(),
    "scheduled": inspect.scheduled(),
    "active_queues": inspect.active_queues(),
}
redis = Redis.from_url(settings.broker_url, socket_connect_timeout=2.0, socket_timeout=2.0, retry_on_timeout=False)
queue_names = sorted({get_openfoam_dialect(identity).queue_name for identity in supported_openfoam_identities()})
snapshot["queue_depths"] = {name: int(redis.llen(name)) for name in queue_names}
transport = {}
for name in ("unacked", "unacked_index"):
    kind = redis.type(name)
    if isinstance(kind, bytes):
        kind = kind.decode("ascii", "strict")
    if kind == "none": transport[name] = 0
    elif kind == "hash": transport[name] = int(redis.hlen(name))
    elif kind == "zset": transport[name] = int(redis.zcard(name))
    elif kind == "list": transport[name] = int(redis.llen(name))
    else: raise RuntimeError(f"unexpected Celery transport key type for {name}: {kind!r}")
snapshot["transport_unacked_counts"] = transport
print(json.dumps(snapshot, sort_keys=True, separators=(",", ":")))
'
}

direct_idle_proof() {
  local services service worker_ids worker_id hostnames snapshot processes
  services="$(running_worker_services)" || die "could not enumerate engine workers"
  [[ -n "$services" ]] || die "no engine worker container is running"
  hostnames=()
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    worker_ids="$(compose --profile '*' ps --status running -q "$service")" || die "could not inspect engine worker $service"
    [[ -n "$worker_ids" && "$(wc -l <<<"$worker_ids")" -eq 1 ]] || die "engine worker $service is not uniquely running"
    worker_id="$worker_ids"
    hostnames+=("$(docker exec "$worker_id" hostname)")
    processes="$(compose --profile '*' exec -T "$service" sh -lc "pgrep -af '$OPENFOAM_PROCESS_RE' || true")" || die "could not inspect OpenFOAM processes in $service"
    [[ -z "$processes" ]] || die "OpenFOAM or meshing process remains active in $service"
  done <<<"$services"
  snapshot="$(direct_celery_redis_snapshot)" || die "direct Celery/Redis proof is unavailable"
  "$PYTHON_BIN" - "$snapshot" "${hostnames[@]}" <<'PY'
from __future__ import annotations

import json
import sys

snapshot = json.loads(sys.argv[1])
expected = {f"celery@{name}" for name in sys.argv[2:]}
if not expected or len(expected) != len(sys.argv[2:]):
    raise SystemExit("worker container hostnames are empty or duplicate")
names = ("active", "reserved", "scheduled", "active_queues")
sets = {}
for name in names:
    value = snapshot.get(name)
    if not isinstance(value, dict) or any(not isinstance(worker, str) or not worker for worker in value):
        raise SystemExit(f"direct Celery proof lacks valid {name} coverage")
    sets[name] = set(value)
if any(sets[name] != expected for name in names):
    raise SystemExit(f"direct Celery proof does not exactly cover live workers: expected={sorted(expected)} observed={ {name: sorted(value) for name, value in sets.items()} }")
for name in names[:3]:
    for worker, tasks in snapshot[name].items():
        if not isinstance(tasks, list) or any(not isinstance(task, dict) for task in tasks):
            raise SystemExit(f"direct Celery proof has malformed {name} tasks for {worker}")
        if tasks:
            raise SystemExit(f"direct Celery proof reports {name} work for {worker}")
queue_depths = snapshot.get("queue_depths")
if (not isinstance(queue_depths, dict) or not queue_depths
    or any(not isinstance(name, str) or not name or type(count) is not int or count != 0 for name, count in queue_depths.items())):
    raise SystemExit("direct Celery proof has non-empty or incomplete registered Redis queues")
for worker, queues in snapshot["active_queues"].items():
    if (not isinstance(queues, list) or not queues
        or any(not isinstance(queue, dict) or not isinstance(queue.get("name"), str) or queue["name"] not in queue_depths for queue in queues)):
        raise SystemExit(f"direct Celery proof has invalid queues for {worker}")
transport = snapshot.get("transport_unacked_counts")
if (not isinstance(transport, dict) or set(transport) != {"unacked", "unacked_index"}
    or any(type(count) is not int or count != 0 for count in transport.values())):
    raise SystemExit("direct Celery proof has non-empty or incomplete unacked transport state")
print("Direct Celery/Redis proof is complete and empty.")
PY
}

archive_gateway_logs() {
  local timestamp temporary final
  umask 077
  [[ ! -e "$GATEWAY_LOG_DIR" || -d "$GATEWAY_LOG_DIR" ]] || die "gateway log path is unsafe"
  mkdir -p -m 0700 "$GATEWAY_LOG_DIR" || die "could not create private gateway log directory"
  [[ ! -L "$GATEWAY_LOG_DIR" ]] || die "gateway log directory is a symlink"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  temporary="$GATEWAY_LOG_DIR/.api-${timestamp}-$$.log.tmp"
  final="$GATEWAY_LOG_DIR/api-${timestamp}-${EXPECTED_BUILD_ID}.log"
  compose logs --no-color --timestamps --tail 2000 api >"$temporary" || { rm -f "$temporary"; die "could not preserve gateway logs before restart"; }
  "$PYTHON_BIN" - "$temporary" "$final" <<'PY'
import os
from pathlib import Path
import stat
import sys

temporary, final = (Path(value) for value in sys.argv[1:])
metadata = temporary.lstat()
if not stat.S_ISREG(metadata.st_mode) or temporary.is_symlink():
    raise SystemExit("gateway log capture is unsafe")
with temporary.open("rb") as stream:
    while stream.read(1024 * 1024):
        pass
    os.fsync(stream.fileno())
os.replace(temporary, final)
directory = os.open(final.parent, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
  chmod 0600 "$final" || die "could not protect preserved gateway logs"
  printf 'Preserved pre-restart gateway logs: %s\n' "$final"
}

validate_fresh_empty_queue() {
  "$PYTHON_BIN" - "$@" <<'PY'
from __future__ import annotations

import json
import sys

value = json.loads(sys.argv[1])
expected = {f"celery@{name}" for name in sys.argv[2:]}
if value.get("queue_observation_state") == "stale" and value.get("queue_observation_error") is None:
    # The bounded in-process refresh exposes the last cache state truthfully.
    # This is retryable but never a successful proof; every other predicate is
    # still validated only after the endpoint returns a fresh snapshot.
    raise SystemExit(75)
if value.get("queue_observation_state") != "fresh" or not isinstance(value.get("queue_observed_at"), str) or not value["queue_observed_at"] or value.get("queue_observation_error") is not None:
    raise SystemExit("gateway queue observation is not fresh")
for name in ("active_count", "reserved_count", "scheduled_count", "queue_depth"):
    if value.get(name) != 0:
        raise SystemExit(f"gateway queue reports {name}={value.get(name)!r}")
if value.get("worker_queues_error") is not None or value.get("worker_runtime_error") is not None:
    raise SystemExit("gateway worker observation has an error")
if not isinstance(value.get("inspection_errors"), dict) or value["inspection_errors"]:
    raise SystemExit("gateway task inspection has an error")
depths = value.get("queue_depths")
if not isinstance(depths, dict) or not depths or any(type(count) is not int or count != 0 for count in depths.values()):
    raise SystemExit("gateway queue depths are incomplete or non-empty")
if sum(depths.values()) != value["queue_depth"]:
    raise SystemExit("gateway aggregate queue depth disagrees with routes")
workers = value.get("worker_queues")
if not isinstance(workers, list):
    raise SystemExit("gateway worker queue inventory is unavailable")
observed = set()
for worker in workers:
    if (not isinstance(worker, dict) or not isinstance(worker.get("worker"), str)
        or not isinstance(worker.get("queues"), list) or not worker["queues"]
        or any(not isinstance(queue, str) or queue not in depths for queue in worker["queues"])):
        raise SystemExit("gateway worker queue inventory is invalid")
    observed.add(worker["worker"])
if observed != expected or len(workers) != len(expected):
    raise SystemExit("gateway worker queue inventory does not cover live workers")
inspection = value.get("inspection_workers")
if not isinstance(inspection, dict):
    raise SystemExit("gateway task worker coverage is unavailable")
for name in ("active", "reserved", "scheduled"):
    if set(inspection.get(name, ())) != expected:
        raise SystemExit(f"gateway task worker coverage is incomplete for {name}")
print("Fresh engine /queue proof is complete and empty.")
PY
}

require_fresh_empty_queue() {
  local payload expected_hostnames=() services service worker_id attempt=0 status last_error=""
  services="$(running_worker_services)" || die "could not enumerate workers after gateway restart"
  [[ -n "$services" ]] || die "no engine worker container is running after gateway restart"
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    worker_id="$(compose --profile '*' ps --status running -q "$service")"
    [[ -n "$worker_id" && "$(wc -l <<<"$worker_id")" -eq 1 ]] || die "engine worker $service changed during gateway restart"
    expected_hostnames+=("$(docker exec "$worker_id" hostname)")
  done <<<"$services"
  while ((attempt < 30)); do
    if payload="$(curl -fsS --max-time 8 http://127.0.0.1:8000/queue 2>&1)"; then
      if validate_fresh_empty_queue "$payload" "${expected_hostnames[@]}"; then
        return 0
      else
        status=$?
      fi
      if ((status != 75)); then
        die "gateway /queue returned malformed, non-empty, or incomplete data after restart"
      fi
      last_error="gateway /queue cache is still refreshing"
    else
      # A cold cache intentionally returns an unavailable response before its
      # single-flight observation finishes.  This is retryable only within the
      # fixed post-restart wait budget.
      last_error="gateway /queue is temporarily unavailable: $payload"
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  die "gateway /queue did not become fresh, complete, and empty after restart: $last_error"
}

wait_for_engine_health() {
  local attempt=0 status last_error=""
  while ((attempt < 30)); do
    if last_error="$(build_identity_probe 2>&1)"; then
      return 0
    else
      status=$?
    fi
    if ((status != 75)); then
      die "engine/node build identity is malformed or differs from the expected build: $last_error"
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  die "api did not return with the same expected health/build identity before the bounded readiness wait expired: $last_error"
}

exec 9>"$LOCK_FILE"
flock -n 9 || die "another Airfoils.Pro deploy or maintenance action is running"

verify_source || die "source manifest did not match the pinned gateway recovery release"
receipt_json="$(verify_receipt_binding)" || die "immutable receipt binding failed"
verify_writers_stopped_and_drain_owned
verify_build_identity

for sample in 1 2; do
  verify_source || die "source manifest changed before direct sample $sample"
  receipt_json="$(verify_receipt_binding)" || die "immutable receipt changed before direct sample $sample"
  verify_writers_stopped_and_drain_owned
  verify_receipt_bound_active_rows "$receipt_json"
  direct_idle_proof
  ((sample == 2)) || sleep "$SAMPLE_DELAY_SECONDS"
done

verify_source || die "source manifest changed before gateway restart"
receipt_json="$(verify_receipt_binding)" || die "immutable receipt changed before gateway restart"
verify_writers_stopped_and_drain_owned
archive_gateway_logs

# Intentionally the only service mutation in this script.  Never add worker,
# node-api, sweeper, or media-repair to this command: their lifecycle is owned
# by their separate guarded workflows and exact maintenance token.
compose up -d --no-deps --force-recreate api || die "could not recreate only the synchronous engine gateway"
wait_for_engine_health
verify_source || die "source manifest changed after gateway restart"
receipt_json="$(verify_receipt_binding)" || die "immutable receipt changed after gateway restart"
verify_writers_stopped_and_drain_owned
verify_receipt_bound_active_rows "$receipt_json"
direct_idle_proof
require_fresh_empty_queue

printf 'Gateway liveness recovery complete: only api was recreated; workers, writers, admission, and exact maintenance token are unchanged.\n'
