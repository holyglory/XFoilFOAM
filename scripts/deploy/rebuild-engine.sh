#!/usr/bin/env bash
# Safe engine gateway/worker rebuild for airfoils.pro.
#
# Why this script exists (incident 2026-07-05): a manual
# `docker compose up -d --force-recreate api worker ...` after editing only
# AIRFOILFOAM_BUILD_ID left node-api running with a STALE env-baked
# ENGINE_EXPECTED_BUILD_ID (truthful-but-misleading "Engine build mismatch"
# banner for ~2.5 h), and killed 4 in-flight celery tasks whose persisted
# engine status kept answering state=running (zombie jobs the sweeper polled
# for ~2.3 h). Manual engine rebuilds MUST go through this script: it updates
# BOTH build-id vars in .env.deploy first, then force-recreates the gateway,
# every worker selected by the active Compose profiles, and every service
# that reads them, verifies the engine actually serves the new build, and
# kicks the stale-job recovery. It refuses the maintenance action when an
# OpenFOAM process is active in any registered engine worker, checking both
# before the image build and again immediately before service recreation.
#
# Usage:
#   scripts/deploy/rebuild-engine.sh <BUILD_ID>
#   scripts/deploy/rebuild-engine.sh --certify-opencfd-2606-continuation
#
# Optional environment:
#   APP_DIR (default /opt/airfoils-pro/app), ENV_FILE, COMPOSE_FILE,
#   COMPOSE_PROJECT_DIRECTORY (default APP_DIR), COMPOSE_PROJECT_NAME and
#   COMPOSE_OVERRIDE_FILE (validated against the authoritative deployment
#   profile), COMPOSE_PROFILES (for optional workers),
#   ADMIN_COOKIE — a full Cookie header
#   value ("aero_admin=<token>"). It is mandatory for the one-time OpenCFD
#   v2406 -> v2606 cutover because the script pauses/drains/migrates/resumes
#   campaigns through authenticated Node API maintenance endpoints.
#   CUTOVER_DRAIN_TIMEOUT_SECONDS (default 7200).
#   OPENCFD2606_POST_NODE_HEALTH_VERIFIER is an optional absolute executable
#   hook. Incident recovery uses a hash-pinned staged verifier to prove the
#   additive canary database-ACK migration after Node health and before the
#   first execution-pool activation request.
#   OPENCFD2606_MEDIA_REPAIR_RESTORE_STATE is empty for ordinary maintenance.
#   Incident recovery may set it to running or stopped only after it has
#   journalled and quiesced media-repair under the inherited deployment lock.
#   DEPLOY_LOCK_HELD=1 only when descriptor 9 is inherited from a parent that
#   already opened the configured deployment lock. The script verifies and
#   retains that lock for the complete maintenance transaction.
set -Eeuo pipefail

ACTION="${1:-}"
DEPLOY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTIFY_CONTINUATION_ONLY=false
if [[ "$ACTION" == "--certify-opencfd-2606-continuation" ]]; then
  CERTIFY_CONTINUATION_ONLY=true
  BUILD_ID=""
else
  BUILD_ID="$ACTION"
fi
if [[ -z "$BUILD_ID" && "$CERTIFY_CONTINUATION_ONLY" != "true" ]]; then
  echo "Usage: $0 <BUILD_ID> | --certify-opencfd-2606-continuation" >&2
  exit 2
fi
if [[ -n "$BUILD_ID" && ! "$BUILD_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "BUILD_ID may contain only letters, digits, dot, underscore, and hyphen." >&2
  exit 2
fi

APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.deploy.yml}"
COMPOSE_PROJECT_DIRECTORY="${COMPOSE_PROJECT_DIRECTORY:-$APP_DIR}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
COMPOSE_OVERRIDE_FILE="${COMPOSE_OVERRIDE_FILE:-}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"
DEPLOY_LOCK_HELD="${DEPLOY_LOCK_HELD:-0}"
DEPLOYMENT_MANIFEST_FILE="${DEPLOYMENT_MANIFEST_FILE:-$APP_DIR/.deployment-source.json}"
DEPLOY_SOURCE_REVISION="${DEPLOY_SOURCE_REVISION:-}"
DEPLOY_SOURCE_TREE_SHA256="${DEPLOY_SOURCE_TREE_SHA256:-}"
ADMIN_COOKIE="${ADMIN_COOKIE:-}"
CUTOVER_DRAIN_TIMEOUT_SECONDS="${CUTOVER_DRAIN_TIMEOUT_SECONDS:-7200}"
CUTOVER_CONTINUATION_TIMEOUT_SECONDS="${CUTOVER_CONTINUATION_TIMEOUT_SECONDS:-3600}"
# The authoritative queue snapshot includes bounded Celery worker inspection.
# Production can legitimately return just after five seconds; the client race
# cap must exceed that server-side window while remaining a strict deployment
# bound. This is intentionally not operator-configurable.
ENGINE_QUEUE_PROBE_TIMEOUT_SECONDS=15
OPENCFD2606_CANARY_RECEIPT_FILE="${OPENCFD2606_CANARY_RECEIPT_FILE:-$AIRFOILS_PRO_STATE_DIR/openfoam-2606-canary-receipt.pending.json}"
OPENCFD2606_POST_NODE_HEALTH_VERIFIER="${OPENCFD2606_POST_NODE_HEALTH_VERIFIER:-}"
OPENCFD2606_MEDIA_REPAIR_RESTORE_STATE="${OPENCFD2606_MEDIA_REPAIR_RESTORE_STATE:-}"
OPENCFD_2606_POOL_ID="3f8bc764-09ae-4ff3-8fd2-260600000001"
CUTOVER_API_BASE="http://127.0.0.1:4000/api/admin/solver-engine-cutovers/opencfd-2606"
CUTOVER_ATTESTATION_ID=""
OPENCFD2606_FAIL_SAFE_ARMED=false
OPENCFD2606_POOL_FAIL_SAFE_DISABLED=false
# The pre-identity OpenCFD 2406 gateway exposes a smaller /queue contract than
# the 2606 gateway. This switch is deliberately not configurable: main() arms
# it only after current_default_engine_version has independently corroborated
# the exact legacy image and worker runtime.
LEGACY_2406_QUEUE_COMPATIBILITY=false
OPENCFD2606_RETAINED_RECEIPT_REPROVED=false

cd "$APP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing deployment env file: $ENV_FILE" >&2
  exit 2
fi
python3 "$DEPLOY_SCRIPT_DIR/deployment-env-preflight.py" \
  --app-dir "$APP_DIR" --state-dir "$AIRFOILS_PRO_STATE_DIR" --env-file "$ENV_FILE" \
  >/dev/null || exit 2
# shellcheck source=scripts/deploy/deployment-compose-profile.sh
source "$DEPLOY_SCRIPT_DIR/deployment-compose-profile.sh"
configure_deployment_compose_profile || exit $?

if [[ "$DEPLOYMENT_ROLE" != "hub" ]]; then
  echo "The canonical production-hub engine workflow cannot run for AIRFOILFOAM_DEPLOYMENT_ROLE=$DEPLOYMENT_ROLE." >&2
  echo "Use scripts/deploy/rebuild-remote-solver-engine.sh for the volume-backed hz-solver2 cutover." >&2
  exit 2
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi

compose() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" \
    --project-directory "$COMPOSE_PROJECT_DIRECTORY" "${COMPOSE_FILE_ARGS[@]}" "$@"
}

acquire_deploy_lock() {
  if [[ "$DEPLOY_LOCK_HELD" == "1" ]]; then
    local inherited_target expected_target
    inherited_target="$(readlink -f "/proc/$$/fd/9" 2>/dev/null || true)"
    expected_target="$(readlink -f "$LOCK_FILE" 2>/dev/null || true)"
    if [[ -z "$inherited_target" || -z "$expected_target" || "$inherited_target" != "$expected_target" ]]; then
      echo "DEPLOY_LOCK_HELD=1 requires inherited descriptor 9 for the configured deployment lock." >&2
      return 9
    fi
    flock -n 9 || {
      echo "The inherited deployment lock is not held by this maintenance transaction." >&2
      return 9
    }
    return 0
  fi
  if [[ "$DEPLOY_LOCK_HELD" != "0" ]]; then
    echo "DEPLOY_LOCK_HELD must be either 0 or the inherited-lock value 1." >&2
    return 9
  fi
  exec 9>"$LOCK_FILE"
  flock -n 9 || {
    echo "Another Airfoils.Pro deploy is already running." >&2
    return 9
  }
}

verify_deployment_source() {
  local tool fields revision tree_sha file_count
  tool="$DEPLOY_SCRIPT_DIR/deployment-source-manifest.py"
  if [[ ! -f "$tool" || ! -f "$DEPLOYMENT_MANIFEST_FILE" ]]; then
    echo "Deployment source manifest or verifier is missing; refusing engine maintenance from unreviewed source." >&2
    return 2
  fi
  fields="$(python3 "$tool" --verify --root "$APP_DIR" --manifest "$DEPLOYMENT_MANIFEST_FILE")" || return 2
  IFS=$'\t' read -r revision tree_sha file_count <<<"$fields"
  if [[ -n "$DEPLOY_SOURCE_REVISION" && "$revision" != "$DEPLOY_SOURCE_REVISION" ]]; then
    echo "Promoted source revision changed before engine maintenance: expected $DEPLOY_SOURCE_REVISION, found $revision" >&2
    return 2
  fi
  if [[ -n "$DEPLOY_SOURCE_TREE_SHA256" && "$tree_sha" != "$DEPLOY_SOURCE_TREE_SHA256" ]]; then
    echo "Promoted source hash changed before engine maintenance: expected $DEPLOY_SOURCE_TREE_SHA256, found $tree_sha" >&2
    return 2
  fi
  DEPLOY_SOURCE_REVISION="$revision"
  DEPLOY_SOURCE_TREE_SHA256="$tree_sha"
  echo "Verified deployment source for engine maintenance: revision=$revision sha256=$tree_sha files=$file_count"
}

validate_recovery_state_paths() {
  python3 - "$APP_DIR" "$AIRFOILS_PRO_STATE_DIR" "$OPENCFD2606_CANARY_RECEIPT_FILE" <<'PY'
from __future__ import annotations

from pathlib import Path
import stat
import sys


def fail(message: str) -> None:
    raise SystemExit(f"unsafe OpenCFD v2606 recovery path: {message}")


app = Path(sys.argv[1])
state = Path(sys.argv[2])
receipt = Path(sys.argv[3])
for label, path in (("AIRFOILS_PRO_STATE_DIR", state), ("OPENCFD2606_CANARY_RECEIPT_FILE", receipt)):
    if not path.is_absolute():
        fail(f"{label} must be absolute")
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode):
            fail(f"{label} contains symlink component {current}")

app_resolved = app.resolve(strict=True)
state_resolved = state.resolve(strict=False)
receipt_resolved = receipt.resolve(strict=False)


def inside(candidate: Path, parent: Path) -> bool:
    try:
        candidate.relative_to(parent)
    except ValueError:
        return False
    return True


if inside(state_resolved, app_resolved):
    fail("AIRFOILS_PRO_STATE_DIR resolves inside the replaceable application tree")
if inside(receipt_resolved, app_resolved):
    fail("OPENCFD2606_CANARY_RECEIPT_FILE resolves inside the replaceable application tree")
PY
}

validate_opencfd_2606_cutover_state() {
  local required_state="${1:-any}"
  python3 "$DEPLOY_SCRIPT_DIR/opencfd2606_cutover_state.py" \
    --env-file "$ENV_FILE" \
    --receipt-file "$OPENCFD2606_CANARY_RECEIPT_FILE" \
    --current-source-revision "$DEPLOY_SOURCE_REVISION" \
    --current-source-tree-sha256 "$DEPLOY_SOURCE_TREE_SHA256" \
    --require-state "$required_state" \
    >/dev/null
}

remove_file_durably() {
  local path="$1"
  python3 - "$path" <<'PY'
from pathlib import Path
import os
import sys

path = Path(sys.argv[1])
if os.path.lexists(path):
    if path.is_symlink() or not path.is_file():
        raise SystemExit(f"refusing to remove unsafe recovery artifact: {path}")
    path.unlink()
    directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
PY
}

capture_sweeper_state() {
  local running_ids
  if ! running_ids="$(compose ps --status running -q sweeper)"; then
    echo "Could not determine whether the sweeper is running; refusing engine rebuild." >&2
    return 12
  fi
  if [[ -n "$running_ids" ]]; then
    printf 'running\n'
  else
    printf 'stopped\n'
  fi
}

restore_sweeper_after_refusal() {
  local initial_state="$1"
  if [[ "$initial_state" == "running" ]]; then
    compose up -d --no-deps sweeper || true
  else
    compose stop sweeper || true
  fi
}

restore_sweeper_after_rebuild() {
  local initial_state="$1"
  if [[ "$initial_state" == "running" ]]; then
    echo "Restoring the previously running sweeper..."
    compose up -d --no-deps --force-recreate sweeper
  else
    echo "Preserving the intentionally stopped sweeper..."
    # Bake the new build-id environment into a replacement container, but do
    # not start it. A later intentional `compose up -d sweeper` then uses the
    # same verified engine generation without a stale-id transition.
    compose up --no-start --no-deps --force-recreate sweeper
  fi
}

restore_media_repair_after_rebuild() {
  local initial_state="$OPENCFD2606_MEDIA_REPAIR_RESTORE_STATE"
  if [[ -z "$initial_state" ]]; then
    return 0
  fi
  if [[ "$initial_state" == "running" ]]; then
    echo "Restoring the previously running media-repair service..."
    compose up -d --no-deps --force-recreate media-repair
  elif [[ "$initial_state" == "stopped" ]]; then
    echo "Preserving the intentionally stopped media-repair service..."
    compose up --no-start --no-deps --force-recreate media-repair
  else
    echo "OPENCFD2606_MEDIA_REPAIR_RESTORE_STATE must be running, stopped, or empty." >&2
    return 14
  fi
}

configured_engine_worker_services() {
  # Compose excludes profiled services unless their profile is active. This is
  # therefore the exact set maintenance is authorised to build/recreate.
  compose config --services | awk '$0 == "worker" || $0 ~ /^worker-/'
}

known_engine_worker_services() {
  # Process safety is wider than the active profile set. An optional worker may
  # still be running after an operator removes COMPOSE_PROFILES from the env;
  # `--profile *` keeps that orphan visible to the idle guard.
  compose --profile '*' config --services | awk '$0 == "worker" || $0 ~ /^worker-/'
}

unconfigured_running_engine_workers() {
  local configured known service running
  configured="$(configured_engine_worker_services)" || return 12
  known="$(known_engine_worker_services)" || return 12
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    running="$(compose --profile '*' ps --status running -q "$service")" || return 12
    if [[ -n "$running" ]] && ! grep -Fxq "$service" <<<"$configured"; then
      printf '%s\n' "$service"
    fi
  done <<<"$known"
}

openfoam_processes() {
  local services service running output
  services="$(known_engine_worker_services)" || return 12
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    running="$(compose --profile '*' ps --status running -q "$service")" || return 12
    [[ -n "$running" ]] || continue
    output="$(compose --profile '*' exec -T "$service" sh -lc \
      'pgrep -af "[s]impleFoam|[p]impleFoam|[p]otentialFoam|[s]nappyHexMesh|[s]urfaceFeatureExtract|[b]lockMesh|[c]heckMesh|[d]ecomposePar|[r]econstructPar|[r]enumberMesh|[m]apFields|[p]ostProcess|[f]oamToVTK|[f]oamRun|[f]oamJob" || true')" || return 12
    if [[ -n "$output" ]]; then
      while IFS= read -r line; do
        printf '%s: %s\n' "$service" "$line"
      done <<<"$output"
    fi
  done <<<"$services"
}

legacy_celery_inspector_activity() {
  local expected_worker_count="$1"
  local snapshot
  # Do not trust the legacy gateway's flattened task summaries alone: old
  # Celery inspect timeouts were represented as empty arrays. Query the broker
  # afresh from the still-running API container and require every inspector
  # method to cover the exact same worker population.
  snapshot="$(compose exec -T api python3 -c '
# AIRFOILS_PRO_LEGACY_CELERY_IDLE_PROBE
import json
from airfoilfoam.celery_app import celery_app

inspect = celery_app.control.inspect(timeout=3.0)
print(json.dumps({
    "active": inspect.active(),
    "reserved": inspect.reserved(),
    "scheduled": inspect.scheduled(),
    "active_queues": inspect.active_queues(),
}, separators=(",", ":")))
')" || return 1
  printf '%s' "$snapshot" | python3 -c '
import json
import sys

snapshot = json.load(sys.stdin)
expected_worker_count = int(sys.argv[1])
if expected_worker_count <= 0:
    raise SystemExit("no running legacy worker container is available to inspect")

names = ("active", "reserved", "scheduled", "active_queues")
worker_sets = {}
for name in names:
    replies = snapshot.get(name)
    if not isinstance(replies, dict):
        raise SystemExit(f"legacy Celery inspector lacks a complete {name} snapshot")
    if any(not isinstance(worker, str) or not worker for worker in replies):
        raise SystemExit(f"legacy Celery inspector returned an invalid {name} worker name")
    worker_sets[name] = set(replies)

expected_workers = worker_sets["active_queues"]
if len(expected_workers) != expected_worker_count:
    raise SystemExit(
        "legacy Celery inspector does not cover running worker containers: "
        f"containers={expected_worker_count}, inspected={len(expected_workers)}"
    )
for name in names[:-1]:
    if worker_sets[name] != expected_workers:
        raise SystemExit(
            f"legacy Celery inspector worker coverage is incomplete for {name}: "
            f"expected={sorted(expected_workers)}, observed={sorted(worker_sets[name])}"
        )

counts = {}
for name in names[:-1]:
    replies = snapshot[name]
    for worker, tasks in replies.items():
        if not isinstance(tasks, list) or any(not isinstance(task, dict) for task in tasks):
            raise SystemExit(
                f"legacy Celery inspector returned an invalid {name} snapshot for {worker}"
            )
    counts[name] = sum(len(tasks) for tasks in replies.values())

for worker, queues in snapshot["active_queues"].items():
    if (
        not isinstance(queues, list)
        or not queues
        or any(
            not isinstance(queue, dict)
            or not isinstance(queue.get("name"), str)
            or not queue["name"]
            for queue in queues
        )
    ):
        raise SystemExit(
            f"legacy Celery inspector returned invalid active_queues for {worker}"
        )

if any(counts.values()):
    print(
        "legacy direct Celery inspection reports work: "
        f"counts={counts} workers={sorted(expected_workers)}"
    )
' "$expected_worker_count"
}

engine_queue_activity() {
  local payload services service running expected_worker_count=0
  services="$(known_engine_worker_services)" || return 1
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    running="$(compose --profile '*' ps --status running -q "$service")" || return 1
    if [[ -n "$running" ]]; then
      expected_worker_count=$((expected_worker_count + $(wc -l <<<"$running")))
    fi
  done <<<"$services"
  payload="$(curl -fsS --max-time "$ENGINE_QUEUE_PROBE_TIMEOUT_SECONDS" http://127.0.0.1:8000/queue)" || return 1
  if [[ "$LEGACY_2406_QUEUE_COMPATIBILITY" == "true" ]]; then
    local legacy_activity
    if ! legacy_activity="$(printf '%s' "$payload" | python3 -c '
import json
import sys

queue = json.load(sys.stdin)
names = ("active", "reserved", "scheduled")
depth = queue.get("queue_depth")
if type(depth) is not int:
    raise SystemExit("legacy engine queue depth is unavailable")
counts = {}
for name in names:
    tasks = queue.get(name)
    count = queue.get(f"{name}_count")
    if (
        not isinstance(tasks, list)
        or any(not isinstance(task, dict) for task in tasks)
        or type(count) is not int
        or count != len(tasks)
    ):
        raise SystemExit(f"legacy engine queue {name} snapshot is incomplete")
    counts[name] = count
job_ids = queue.get("job_ids")
if not isinstance(job_ids, list) or any(not isinstance(job_id, str) for job_id in job_ids):
    raise SystemExit("legacy engine queue job_ids snapshot is incomplete")
if depth or any(counts.values()):
    print(f"legacy queue_depth={depth} counts={counts} job_ids={job_ids}")
')"; then
      return 1
    fi
    if [[ -n "$legacy_activity" ]]; then
      printf '%s\n' "$legacy_activity"
      return 0
    fi
    legacy_celery_inspector_activity "$expected_worker_count"
    return $?
  fi

  printf '%s' "$payload" | python3 -c '
import json
import sys

queue = json.load(sys.stdin)
expected_worker_count = int(sys.argv[1])
keys = ("active_count", "reserved_count", "scheduled_count")
counts = {key: queue.get(key) for key in keys}
depth = queue.get("queue_depth")
if any(type(value) is not int for value in counts.values()) or type(depth) is not int:
    raise SystemExit("engine queue observability is incomplete")
for error_key in ("worker_queues_error", "worker_runtime_error"):
    if error_key not in queue or queue[error_key] is not None:
        raise SystemExit(
            f"engine worker inspection failed: {error_key}={queue.get(error_key)!r}"
        )
inspection_errors = queue.get("inspection_errors")
if not isinstance(inspection_errors, dict) or inspection_errors:
    raise SystemExit(f"engine task inspection failed: {inspection_errors}")
depths = queue.get("queue_depths")
if not isinstance(depths, dict) or not depths or any(
    type(value) is not int for value in depths.values()
):
    raise SystemExit("registered engine queue depths are incomplete")
registered_depth = sum(depths.values())
if registered_depth != depth:
    raise SystemExit(
        f"aggregate queue_depth={depth} disagrees with registered queues={depths}"
    )
enabled = queue.get("queue_enabled")
if (
    not isinstance(enabled, dict)
    or set(enabled) != set(depths)
    or any(type(value) is not bool for value in enabled.values())
):
    raise SystemExit("registered engine queue enablement is incomplete")
worker_queues = queue.get("worker_queues")
if not isinstance(worker_queues, list):
    raise SystemExit("live engine worker inventory is unavailable")
worker_names = []
for binding in worker_queues:
    if (
        not isinstance(binding, dict)
        or not isinstance(binding.get("worker"), str)
        or not binding["worker"]
        or not isinstance(binding.get("queues"), list)
        or any(not isinstance(route, str) or not route for route in binding["queues"])
    ):
        raise SystemExit("live engine worker inventory is invalid")
    worker_names.append(binding["worker"])
if len(set(worker_names)) != len(worker_names):
    raise SystemExit("live engine worker inventory contains duplicate workers")
if len(worker_names) != expected_worker_count:
    raise SystemExit(
        "live engine worker inventory does not cover running worker containers: "
        f"containers={expected_worker_count}, inspected={len(worker_names)}"
    )
inspection_workers = queue.get("inspection_workers")
if not isinstance(inspection_workers, dict):
    raise SystemExit("engine task worker coverage is unavailable")
expected_workers = set(worker_names)
for kind in keys:
    kind_name = kind.removesuffix("_count")
    observed = inspection_workers.get(kind_name)
    if (
        not isinstance(observed, list)
        or any(not isinstance(worker, str) or not worker for worker in observed)
        or set(observed) != expected_workers
    ):
        raise SystemExit(
            f"engine task worker coverage is incomplete for {kind_name}: "
            f"expected={sorted(expected_workers)}, observed={observed!r}"
        )
if depth or any(counts.values()):
    job_ids = queue.get("job_ids") or []
    print(
        f"queue_depth={depth} queue_depths={depths} "
        f"counts={counts} job_ids={job_ids}"
    )
' "$expected_worker_count"
}

require_idle_worker() {
  local stage="$1"
  local active queue_activity
  if ! active="$(openfoam_processes 2>&1)"; then
    echo "Refusing engine rebuild at $stage because the worker process probe failed:" >&2
    echo "$active" >&2
    return 12
  fi
  if [[ -n "$active" ]]; then
    echo "Refusing engine rebuild at $stage because OpenFOAM processes are active:" >&2
    echo "$active" >&2
    return 12
  fi
  if ! queue_activity="$(engine_queue_activity 2>&1)"; then
    echo "Refusing engine rebuild at $stage because the engine queue probe failed:" >&2
    echo "$queue_activity" >&2
    return 12
  fi
  if [[ -n "$queue_activity" ]]; then
    echo "Refusing engine rebuild at $stage because queued/reserved/active engine work exists:" >&2
    echo "$queue_activity" >&2
    return 12
  fi
  echo "Worker idle check passed ($stage)."
}

# Cutover recovery is one state machine, so its recovery fields must
# never be exposed as a partially-written tuple. Write and fsync a sibling
# file, then atomically rename it over the deployment env file.
set_env_vars_atomic() {
  python3 - "$ENV_FILE" "$@" <<'PY'
import os
import pathlib
import stat
import sys
import tempfile

path = pathlib.Path(sys.argv[1])
updates: dict[str, str] = {}
for item in sys.argv[2:]:
    if "=" not in item:
        raise SystemExit(f"invalid env update without '=': {item!r}")
    key, value = item.split("=", 1)
    if not key or "\n" in key or "\n" in value or "\r" in key or "\r" in value:
        raise SystemExit("invalid env update")
    updates[key] = value

lines = path.read_text(encoding="utf-8").splitlines()
written: set[str] = set()
output: list[str] = []
for line in lines:
    key = line.split("=", 1)[0] if "=" in line else ""
    if key in updates:
        if key not in written:
            output.append(f"{key}={updates[key]}")
            written.add(key)
        continue
    output.append(line)
for key, value in updates.items():
    if key not in written:
        output.append(f"{key}={value}")

fd, temporary_name = tempfile.mkstemp(
    prefix=f".{path.name}.cutover-", dir=path.parent
)
try:
    os.fchmod(fd, stat.S_IMODE(path.stat().st_mode))
    with os.fdopen(fd, "w", encoding="utf-8") as temporary:
        temporary.write("\n".join(output) + "\n")
        temporary.flush()
        os.fsync(temporary.fileno())
    os.replace(temporary_name, path)
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
except BaseException:
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.unlink(temporary_name)
    except FileNotFoundError:
        pass
    raise
PY
}

set_opencfd_2606_cutover_state() {
  local pending="$1"
  local sweeper_was_running="$2"
  local attestation_id="$3"
  local complete="$4"
  local receipt_expected="${5:-0}"
  local evidence_contract_sha256 source_revision="" source_tree_sha256=""
  evidence_contract_sha256="$(read_env_var OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256 || true)"
  if [[ -n "$attestation_id" ]]; then
    if ! evidence_contract_sha256="$(current_evidence_contract_sha256 2>&1)"; then
      echo "Could not bind the OpenCFD v2606 attestation to the exact evidence-storage contract:" >&2
      echo "$evidence_contract_sha256" >&2
      return 14
    fi
  elif [[ "$pending" == "1" ]]; then
    # A pending pre-attestation tuple has not certified the current evidence
    # destination.  Never carry a prior terminal contract into this state.
    evidence_contract_sha256=""
  fi
  if [[ "$pending" == "1" ]]; then
    if [[ ! "$DEPLOY_SOURCE_REVISION" =~ ^[0-9a-f]{40}$ || ! "$DEPLOY_SOURCE_TREE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
      echo "The pending OpenCFD v2606 cutover cannot be bound to a verified deployment source; refusing the recovery-state write." >&2
      return 14
    fi
    source_revision="$DEPLOY_SOURCE_REVISION"
    source_tree_sha256="$DEPLOY_SOURCE_TREE_SHA256"
  fi
  set_env_vars_atomic \
    "OPENCFD2606_CUTOVER_PENDING=$pending" \
    "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING=$sweeper_was_running" \
    "OPENCFD2606_CANARY_ATTESTATION_ID=$attestation_id" \
    "OPENCFD2606_CUTOVER_COMPLETE=$complete" \
    "OPENCFD2606_CANARY_RECEIPT_EXPECTED=$receipt_expected" \
    "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256=$evidence_contract_sha256" \
    "OPENCFD2606_CUTOVER_SOURCE_REVISION=$source_revision" \
    "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256=$source_tree_sha256"
}

read_env_var() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

current_evidence_contract_sha256() {
  python3 "$DEPLOY_SCRIPT_DIR/evidence-contract.py" --env-file "$ENV_FILE"
}

validate_certified_evidence_contract() {
  local marker_required="${1:-false}"
  local certified current
  certified="$(read_env_var OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256 || true)"
  if [[ -z "$certified" ]]; then
    if [[ "$marker_required" == "true" ]]; then
      echo "The certified OpenCFD v2606 evidence-contract marker is missing; refusing deployment or certification replay." >&2
      return 14
    fi
    echo "No certified OpenCFD v2606 evidence contract exists yet (initial pre-cutover state)."
    return 0
  fi
  if [[ ! "$certified" =~ ^[0-9a-f]{64}$ ]]; then
    echo "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256 is malformed; refusing deployment." >&2
    return 14
  fi
  if ! current="$(current_evidence_contract_sha256 2>&1)"; then
    echo "Could not derive the current evidence-storage contract:" >&2
    echo "$current" >&2
    return 14
  fi
  if [[ "$current" != "$certified" ]]; then
    echo "The current bucket/prefix/Zstandard/remote-only evidence contract differs from the OpenCFD v2606 certified contract; refusing deployment." >&2
    echo "certified=$certified current=$current" >&2
    return 14
  fi
  echo "Certified OpenCFD v2606 evidence contract matches: $certified"
}

admin_json_request() {
  local method="$1"
  local url="$2"
  local body='{}'
  if (($# >= 3)); then
    body="$3"
  fi
  if [[ -z "$ADMIN_COOKIE" ]]; then
    echo "ADMIN_COOKIE is required for authenticated solver cutover maintenance." >&2
    return 14
  fi
  if [[ "$ADMIN_COOKIE" == *$'\n'* || "$ADMIN_COOKIE" == *$'\r'* || "$ADMIN_COOKIE" == *'"'* ]]; then
    echo "ADMIN_COOKIE contains characters that cannot be passed safely to curl." >&2
    return 14
  fi
  # Read the secret header from stdin curl config so the signed admin session
  # never appears in the process argv visible to other host users.
  printf 'header = "Cookie: %s"\n' "$ADMIN_COOKIE" | curl --config - \
    --fail-with-body -sS --max-time 30 -X "$method" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "$url"
}

admin_json_file_request() {
  local method="$1"
  local url="$2"
  local body_file="$3"
  if [[ -z "$ADMIN_COOKIE" || ! -r "$body_file" ]]; then
    echo "Authenticated JSON file request is missing its cookie or body." >&2
    return 14
  fi
  if [[ "$ADMIN_COOKIE" == *$'\n'* || "$ADMIN_COOKIE" == *$'\r'* || "$ADMIN_COOKIE" == *'"'* ]]; then
    echo "ADMIN_COOKIE contains characters that cannot be passed safely to curl." >&2
    return 14
  fi
  printf 'header = "Cookie: %s"\n' "$ADMIN_COOKIE" | curl --config - \
    --fail-with-body -sS --max-time 90 -X "$method" \
    -H "Content-Type: application/json" \
    --data-binary "@$body_file" \
    "$url"
}

ACTIVATION_RESPONSE=""
ACTIVATION_HTTP_STATUS=""

activate_opencfd_2606_pool_once() {
  local response_file curl_rc=0
  response_file="$(mktemp)"
  chmod 600 "$response_file"
  ACTIVATION_HTTP_STATUS="$(
    printf 'header = "Cookie: %s"\n' "$ADMIN_COOKIE" | curl --config - \
      -sS --max-time 30 -o "$response_file" -w '%{http_code}' -X PATCH \
      -H "Content-Type: application/json" \
      -d '{"enabled":true}' \
      "http://127.0.0.1:4000/api/admin/solver-execution-pools/$OPENCFD_2606_POOL_ID"
  )" || curl_rc=$?
  ACTIVATION_RESPONSE="$(<"$response_file")"
  rm -f "$response_file"
  if ((curl_rc != 0)); then
    ACTIVATION_RESPONSE="${ACTIVATION_RESPONSE:-curl transport error $curl_rc}"
    return 75
  fi
  case "$ACTIVATION_HTTP_STATUS" in
    2??) return 0 ;;
    000|409|502|503|504) return 75 ;;
    *) return 14 ;;
  esac
}

disable_opencfd_2606_pool_after_canary_failure() {
  admin_json_request PATCH \
    "http://127.0.0.1:4000/api/admin/solver-execution-pools/$OPENCFD_2606_POOL_ID" \
    '{"enabled":false}' >/dev/null
}

disable_opencfd_2606_pool_fail_safe() {
  local reason="$1"
  if disable_opencfd_2606_pool_after_canary_failure; then
    OPENCFD2606_POOL_FAIL_SAFE_DISABLED=true
    echo "Disabled the OpenCFD v2606 execution pool after $reason." >&2
  else
    OPENCFD2606_POOL_FAIL_SAFE_DISABLED=false
    echo "WARNING: could not disable the OpenCFD v2606 pool after $reason; keep the sweeper stopped and disable the pool from Admin before investigation." >&2
  fi
}

arm_opencfd_2606_exit_fail_safe() {
  OPENCFD2606_FAIL_SAFE_ARMED=true
}

disarm_opencfd_2606_exit_fail_safe() {
  OPENCFD2606_FAIL_SAFE_ARMED=false
}

opencfd_2606_exit_fail_safe() {
  local exit_status=$?
  if [[ "$OPENCFD2606_FAIL_SAFE_ARMED" != "true" ]] || ((exit_status == 0)); then
    return
  fi
  # Avoid recursive EXIT handling if either cleanup operation itself fails.
  trap - EXIT
  echo "OpenCFD v2606 cutover exited before terminal continuation proof; enforcing the scheduler/pool fail-safe." >&2
  if ! compose stop sweeper; then
    echo "WARNING: could not stop the sweeper during OpenCFD v2606 fail-safe cleanup; stop it manually before investigation." >&2
  fi
  if [[ "$OPENCFD2606_POOL_FAIL_SAFE_DISABLED" != "true" ]]; then
    disable_opencfd_2606_pool_fail_safe "an unacknowledged cutover exit"
  fi
  exit "$exit_status"
}

trap opencfd_2606_exit_fail_safe EXIT

run_opencfd_2606_production_canaries() {
  local receipt_file="$1"
  local image_digest evidence_bucket evidence_prefix evidence_zstd_level
  local -a command=(
    python3 "$DEPLOY_SCRIPT_DIR/openfoam_2606_canary.py"
    --gateway-url http://127.0.0.1:8000
    --expected-build-id "$BUILD_ID"
  )
  image_digest="$(read_env_var OPENCFD2606_IMAGE_DIGEST || true)"
  evidence_bucket="$(read_env_var AIRFOILFOAM_EVIDENCE_BUCKET || true)"
  evidence_prefix="$(read_env_var AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX || true)"
  evidence_zstd_level="$(read_env_var AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL || true)"
  if [[ -z "$evidence_bucket" || -z "$evidence_prefix" || -z "$evidence_zstd_level" ]]; then
    echo "The bucket, object prefix, and Zstandard level are required for the OpenCFD v2606 production canary." >&2
    return 14
  fi
  command+=(
    --expected-evidence-bucket "$evidence_bucket"
    --expected-evidence-object-prefix "$evidence_prefix"
    --expected-evidence-zstd-level "$evidence_zstd_level"
  )
  if [[ -n "$image_digest" ]]; then
    command+=(--expected-image-digest "$image_digest")
  fi
  # stdout is one machine-readable receipt. Persist it to a restricted file
  # before any API mutation; progress remains on stderr.
  "${command[@]}" >"$receipt_file"
  python3 - "$receipt_file" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
receipt = json.loads(path.read_text(encoding="utf-8"))
if receipt.get("schema_version") != 1 or receipt.get("status") != "ok":
    raise SystemExit("canary did not emit a successful schema-v1 receipt")
if len(receipt.get("jobs") or []) != 3:
    raise SystemExit("canary receipt does not contain all three jobs")
PY
}

verify_retained_opencfd_2606_receipt() {
  local receipt_file="$1"
  local build_id image_digest evidence_bucket evidence_prefix evidence_zstd_level
  local -a command=(
    python3 "$DEPLOY_SCRIPT_DIR/openfoam_2606_canary.py"
    --gateway-url http://127.0.0.1:8000
    --verify-receipt "$receipt_file"
  )
  build_id="$(read_env_var AIRFOILFOAM_BUILD_ID || true)"
  image_digest="$(read_env_var OPENCFD2606_IMAGE_DIGEST || true)"
  evidence_bucket="$(read_env_var AIRFOILFOAM_EVIDENCE_BUCKET || true)"
  evidence_prefix="$(read_env_var AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX || true)"
  evidence_zstd_level="$(read_env_var AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL || true)"
  if [[ -z "$build_id" || -z "$evidence_bucket" || -z "$evidence_prefix" || -z "$evidence_zstd_level" ]]; then
    echo "The live build and complete remote-evidence configuration are required to re-prove a retained canary receipt." >&2
    return 14
  fi
  command+=(
    --expected-build-id "$build_id"
    --expected-evidence-bucket "$evidence_bucket"
    --expected-evidence-object-prefix "$evidence_prefix"
    --expected-evidence-zstd-level "$evidence_zstd_level"
  )
  if [[ -n "$image_digest" ]]; then
    command+=(--expected-image-digest "$image_digest")
  fi
  # The verifier makes no solver submissions. It re-downloads each exact
  # bucket/key/generation-bound archive and renders from the already stripped
  # evidence through the current gateway configuration.
  "${command[@]}" >/dev/null
}

validate_remote_evidence_configuration() {
  local bucket prefix zstd_level remote_only
  bucket="$(read_env_var AIRFOILFOAM_EVIDENCE_BUCKET || true)"
  prefix="$(read_env_var AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX || true)"
  zstd_level="$(read_env_var AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL || true)"
  remote_only="$(read_env_var AIRFOILFOAM_EVIDENCE_REMOTE_ONLY || true)"
  if [[ -z "$bucket" || ! "$bucket" =~ ^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$ ]]; then
    echo "AIRFOILFOAM_EVIDENCE_BUCKET must name the configured GCS bucket." >&2
    return 14
  fi
  if [[ -z "$prefix" || "$prefix" == /* || "$prefix" == *".."* ]]; then
    echo "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX must be a safe nonempty relative prefix." >&2
    return 14
  fi
  if [[ ! "$zstd_level" =~ ^[0-9]+$ ]] || ((zstd_level < 1 || zstd_level > 22)); then
    echo "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL must be an integer from 1 through 22." >&2
    return 14
  fi
  if [[ "${remote_only,,}" != "true" ]]; then
    echo "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=true is required before engine maintenance." >&2
    return 14
  fi
  echo "Remote evidence configuration is fail-closed: gs://$bucket/$prefix (tar+zstd level $zstd_level, remote-only)."
}

attest_opencfd_2606_receipt() {
  local receipt_file="$1"
  local request_file response attestation_id
  request_file="$(mktemp)"
  chmod 600 "$request_file"
  python3 - "$receipt_file" "$request_file" <<'PY'
import json
import pathlib
import sys

receipt = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
pathlib.Path(sys.argv[2]).write_text(
    json.dumps({"receipt": receipt}, separators=(",", ":")),
    encoding="utf-8",
)
PY
  if ! response="$(admin_json_file_request POST "$CUTOVER_API_BASE/attest" "$request_file")"; then
    rm -f "$request_file"
    return 14
  fi
  rm -f "$request_file"
  attestation_id="$(printf '%s' "$response" | python3 -c '
import json
import re
import sys

payload = json.load(sys.stdin)
value = payload.get("canaryAttestationId")
if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", value):
    raise SystemExit("attestation response lacks a UUID")
print(value)
')" || return 14
  printf '%s\n' "$attestation_id"
}

compute_migrated_opencfd_enabled_engine_keys() {
  local configured migrated
  configured="$(read_env_var AIRFOILFOAM_ENABLED_ENGINE_KEYS || true)"
  migrated="$(CONFIGURED_ENGINE_KEYS="$configured" python3 -c '
import os

old = "openfoam:opencfd:2406:numerics-1:adapter-1"
new = "openfoam:opencfd:2606:numerics-1:adapter-1"
keys = [item.strip() for item in os.environ.get("CONFIGURED_ENGINE_KEYS", "").split(",") if item.strip()]
result = []
for key in keys:
    candidate = new if key == old else key
    if candidate not in result:
        result.append(candidate)
if new not in result:
    result.insert(0, new)
print(",".join(result))
')"
  printf '%s\n' "$migrated"
}

corroborate_legacy_opencfd_2406_runtime() {
  local capabilities legacy_image legacy_worker
  capabilities="$(curl -fsS --max-time 5 http://127.0.0.1:8000/capabilities)" || return 1
  legacy_image="$(printf '%s' "$capabilities" | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
print(payload.get("openfoam_image") or "")
')" || return 1
  if [[ "$legacy_image" != "opencfd/openfoam-default:2406" ]]; then
    echo "engine /capabilities does not corroborate the exact legacy OpenCFD 2406 image" >&2
    return 1
  fi
  legacy_worker="$(compose exec -T worker sh -lc \
    'test -r /usr/lib/openfoam/openfoam2406/etc/bashrc && test ! -r /usr/lib/openfoam/openfoam2606/etc/bashrc && printf 2406')" || return 1
  if [[ "$legacy_worker" != "2406" ]]; then
    echo "legacy OpenCFD 2406 gateway identity is not corroborated by the worker runtime" >&2
    return 1
  fi
}

current_default_engine_version() {
  local health version
  health="$(curl -fsS --max-time 5 http://127.0.0.1:8000/health)" || return 1
  version="$(printf '%s' "$health" | python3 -c '
import json
import sys

health = json.load(sys.stdin)
engine = health.get("default_engine")
if isinstance(engine, dict) and isinstance(engine.get("version"), str):
    print(engine["version"])
')" || return 1
  if [[ -n "$version" ]]; then
    # Even a structured 2406 claim must match the two independent legacy
    # signals before the smaller queue compatibility contract can be armed.
    if [[ "$version" == "2406" ]]; then
      corroborate_legacy_opencfd_2406_runtime || return 1
    fi
    printf '%s\n' "$version"
    return 0
  fi

  # The deployed pre-identity 2406 gateway predates default_engine in
  # /health. Identify that legacy shape only with two independent exact
  # signals: its advertised OpenCFD image and the installed worker runtime.
  # A merely missing health field is never guessed to mean 2406.
  corroborate_legacy_opencfd_2406_runtime || return 1
  printf '2406\n'
}

probe_opencfd_2606_cutover_control_plane() {
  local response
  if ! response="$(admin_json_request POST "$CUTOVER_API_BASE/readiness" '{}' 2>&1)"; then
    echo "The OpenCFD v2606 cutover API/schema is unavailable." >&2
    echo "Deploy the new control plane first with scripts/deploy/vps-redeploy.sh, then rerun engine maintenance." >&2
    echo "$response" >&2
    return 14
  fi
  if ! printf '%s' "$response" | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
if not isinstance(payload.get("ready"), bool):
    raise SystemExit("cutover readiness response lacks boolean ready")
'; then
    echo "The OpenCFD v2606 cutover API returned an incompatible readiness contract; refusing maintenance." >&2
    return 14
  fi
  echo "OpenCFD v2606 control-plane cutover contract is available."
}

prepare_opencfd_2606_cutover() {
  local sweeper_restore_state="$1"
  local durable_sweeper_state
  echo "Preparing the audited OpenCFD v2406 -> v2606 campaign cutover..."
  if [[ "$(read_env_var OPENCFD2606_CUTOVER_PENDING || true)" != "1" ]]; then
    durable_sweeper_state="$([[ "$sweeper_restore_state" == "running" ]] && printf 1 || printf 0)"
  else
    durable_sweeper_state="$(read_env_var OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING || true)"
  fi
  # Persist the original scheduler intent before the first mutating API call.
  # If this local atomic write fails, the guard remains unarmed and neither
  # the scheduler nor database has been touched. A lost prepare response can
  # then stop fail-safe without losing the state needed by the exact retry.
  set_opencfd_2606_cutover_state 1 "$durable_sweeper_state" "" 0
  arm_opencfd_2606_exit_fail_safe
  admin_json_request POST "$CUTOVER_API_BASE/prepare" \
    '{"reason":"scripts/deploy/rebuild-engine.sh guarded OpenCFD v2606 cutover"}' >/dev/null
  # The DB preparation transaction closes both the retired source route and
  # the target route, including on an idempotent retry.
  OPENCFD2606_POOL_FAIL_SAFE_DISABLED=true
}

wait_for_opencfd_2606_cutover_drain() {
  local started now elapsed response ready summary attempts=0
  started="$(date +%s)"
  while true; do
    attempts=$((attempts + 1))
    response="$(admin_json_request POST "$CUTOVER_API_BASE/readiness" '{}')" || return 14
    ready="$(printf '%s' "$response" | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
ready = payload.get("ready")
if not isinstance(ready, bool):
    raise SystemExit("cutover readiness response lacks boolean ready")
print("true" if ready else "false")
')" || return 14
    if [[ "$ready" == "true" ]]; then
      echo "Database cutover drain is complete."
      return 0
    fi
    if ((attempts == 1 || attempts % 12 == 0)); then
      summary="$(printf '%s' "$response" | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
print(json.dumps(payload.get("blockers", []), separators=(",", ":")))
')"
      echo "Waiting for OpenCFD v2406 work/evidence ingestion to drain: $summary"
    fi
    now="$(date +%s)"
    elapsed=$((now - started))
    if ((elapsed >= CUTOVER_DRAIN_TIMEOUT_SECONDS)); then
      echo "Timed out after ${elapsed}s waiting for the OpenCFD v2406 cutover drain." >&2
      echo "Campaigns remain safely paused and OPENCFD2606_CUTOVER_PENDING=1; resolve the reported blockers and rerun this script." >&2
      return 14
    fi
    sleep 5
  done
}

verify_opencfd_2606_runtime() {
  local health version evidence_bucket evidence_prefix evidence_zstd_level remote_only
  health="$(curl -fsS --max-time 5 http://127.0.0.1:8000/health)" || return 13
  evidence_bucket="$(read_env_var AIRFOILFOAM_EVIDENCE_BUCKET || true)"
  evidence_prefix="$(read_env_var AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX || true)"
  evidence_zstd_level="$(read_env_var AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL || true)"
  remote_only="$(read_env_var AIRFOILFOAM_EVIDENCE_REMOTE_ONLY || true)"
  version="$(printf '%s' "$health" | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
engine = payload.get("default_engine") or {}
storage = payload.get("evidence_storage")
expected = {
    "backend": "gcs",
    "bucket": sys.argv[1],
    "object_prefix": sys.argv[2],
    "archive_format": "tar+zstd",
    "compression": "zstd",
    "zstd_level": int(sys.argv[3]),
    "remote_only": sys.argv[4].lower() == "true",
}
if storage != expected:
    raise SystemExit(
        f"live gateway evidence storage differs from deployment config: "
        f"expected={expected!r}, actual={storage!r}"
    )
print(engine.get("version") or "")
' "$evidence_bucket" "$evidence_prefix" "$evidence_zstd_level" "$remote_only")" || return 13
  if [[ "$version" != "2606" ]]; then
    echo "Engine default identity mismatch after cutover: expected OpenCFD 2606, got '$version'" >&2
    echo "Full /health payload: $health" >&2
    return 13
  fi
  echo "Engine reports OpenCFD v2606 as its default executable identity."
}

finish_opencfd_2606_cutover() {
  # From the first enable request onward, an unacknowledged response may have
  # committed. The EXIT fail-safe must therefore assume the pool is live until
  # a disabling request is itself acknowledged.
  OPENCFD2606_POOL_FAIL_SAFE_DISABLED=false
  echo "Activating the exact OpenCFD v2606 execution pool after its live worker handshake..."
  local attempt activation_error="" activated=false activation_rc=0
  for ((attempt = 1; attempt <= 60; attempt++)); do
    if activate_opencfd_2606_pool_once; then
      activated=true
      break
    else
      activation_rc=$?
    fi
    activation_error="HTTP ${ACTIVATION_HTTP_STATUS:-000}: ${ACTIVATION_RESPONSE:-no response body}"
    if ((activation_rc != 75)); then
      echo "OpenCFD v2606 pool activation was not acknowledged by an acceptable response; database state may already reflect an earlier cutover stage and the exact recorded workflow must be replayed." >&2
      echo "$activation_error" >&2
      disable_opencfd_2606_pool_fail_safe "the ambiguous/non-retryable activation failure"
      return 14
    fi
    if ((attempt == 1 || attempt % 10 == 0)); then
      echo "Waiting for the OpenCFD v2606 worker/pool handshake (attempt $attempt/60): $activation_error"
    fi
    sleep 2
  done
  if [[ "$activated" != "true" ]]; then
    echo "OpenCFD v2606 pool activation remained unacknowledged after all retries; the database may have committed a request whose response was lost, so retain the marker and replay the exact recorded workflow." >&2
    echo "$activation_error" >&2
    disable_opencfd_2606_pool_fail_safe "activation retries were exhausted"
    return 14
  fi

  local saved_attestation receipt_file receipt_temp_file retained_receipt=false
  saved_attestation="$(read_env_var OPENCFD2606_CANARY_ATTESTATION_ID || true)"
  if [[ "$saved_attestation" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    CUTOVER_ATTESTATION_ID="$saved_attestation"
    echo "Reusing the durable OpenCFD v2606 canary attestation from the interrupted cutover."
  else
    receipt_file="$OPENCFD2606_CANARY_RECEIPT_FILE"
    if [[ -s "$receipt_file" ]]; then
      retained_receipt=true
      echo "Replaying the retained exact OpenCFD v2606 canary receipt from $receipt_file instead of rerunning canaries."
    else
      install -d -m 700 "$(dirname "$receipt_file")"
      receipt_temp_file="$(mktemp "${receipt_file}.tmp.XXXXXX")"
      chmod 600 "$receipt_temp_file"
      echo "Running mandatory OpenCFD v2606 multi-angle RANS, two-rank MPI RANS, and forced-URANS production canaries..."
      if ! run_opencfd_2606_production_canaries "$receipt_temp_file"; then
        rm -f "$receipt_temp_file"
        echo "OpenCFD v2606 production canaries failed; no attestation or successor generation was created and campaigns remain paused." >&2
        disable_opencfd_2606_pool_fail_safe "the failed production canary"
        return 14
      fi
      if ! python3 "$DEPLOY_SCRIPT_DIR/persist-json-receipt.py" \
        --profile opencfd2606-canary \
        --source "$receipt_temp_file" \
        --destination "$receipt_file"; then
        rm -f "$receipt_temp_file"
        echo "The validated OpenCFD v2606 canary receipt was not durably persisted; refusing attestation before any successor generation is created." >&2
        disable_opencfd_2606_pool_fail_safe "the failed durable canary-receipt persistence"
        return 14
      fi
    fi
    # From this point until the attestation id is atomically installed, the
    # exact external receipt is mandatory recovery state. A source promotion
    # or operator mistake must not silently turn its loss into fresh canaries.
    set_env_vars_atomic "OPENCFD2606_CANARY_RECEIPT_EXPECTED=1"
    # A prior persistence call may have atomically published the destination
    # hard link but lost its directory-fsync acknowledgement. Revalidate and
    # fsync both the installed file and its parent on every path, including
    # fresh persistence, before the control plane may attest the receipt.
    if ! python3 "$DEPLOY_SCRIPT_DIR/persist-json-receipt.py" \
      --profile opencfd2606-canary \
      --destination "$receipt_file" \
      --verify-existing; then
      echo "The installed OpenCFD v2606 canary receipt could not be revalidated and durably re-synced; refusing attestation." >&2
      disable_opencfd_2606_pool_fail_safe "the failed retained canary-receipt verification"
      return 14
    fi
    if [[ "$retained_receipt" == "true" && "$OPENCFD2606_RETAINED_RECEIPT_REPROVED" != "true" ]]; then
      echo "Re-proving the retained receipt against the current GCS configuration and exact object generations..."
      if ! verify_retained_opencfd_2606_receipt "$receipt_file"; then
        echo "The retained receipt no longer hydrates and renders from its exact current bucket/key/generation bindings; refusing replay." >&2
        disable_opencfd_2606_pool_fail_safe "the failed retained canary evidence reproof"
        return 14
      fi
      OPENCFD2606_RETAINED_RECEIPT_REPROVED=true
    fi
    echo "OpenCFD v2606 production canaries passed; independently validating and persisting their receipt..."
    if ! CUTOVER_ATTESTATION_ID="$(attest_opencfd_2606_receipt "$receipt_file")"; then
      echo "The canary attestation request was not acknowledged; the database may have committed it. The exact receipt is retained at $receipt_file and must be replayed before rerunning canaries." >&2
      disable_opencfd_2606_pool_fail_safe "the rejected canary attestation"
      return 14
    fi
    set_opencfd_2606_cutover_state 1 \
      "$(read_env_var OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING)" \
      "$CUTOVER_ATTESTATION_ID" 0
    remove_file_durably "$receipt_file"
    echo "OpenCFD v2606 canary attestation is durable: $CUTOVER_ATTESTATION_ID"
  fi

  echo "Creating full-grid OpenCFD v2606 successor campaign generations..."
  if ! admin_json_request POST "$CUTOVER_API_BASE/finalize" \
    "{\"canaryAttestationId\":\"$CUTOVER_ATTESTATION_ID\"}" >/dev/null; then
    echo "Successor finalization was not acknowledged; the database may have committed it. Keep the durable marker and replay this exact attestation idempotently." >&2
    disable_opencfd_2606_pool_fail_safe "the rejected finalization replay"
    return 14
  fi

  echo "Completing the cutover and restoring campaigns that were previously runnable..."
  if ! admin_json_request POST "$CUTOVER_API_BASE/complete" \
    "{\"canaryAttestationId\":\"$CUTOVER_ATTESTATION_ID\"}" >/dev/null; then
    echo "Cutover completion was not acknowledged; the database may have committed campaign resumption. Keep the scheduler quiesced, retain the durable marker, and replay this exact attestation idempotently." >&2
    disable_opencfd_2606_pool_fail_safe "the rejected completion replay"
    return 14
  fi
}

CONTINUATION_TERMINAL_STATUS=""
wait_for_opencfd_2606_continuation_evidence() {
  local attestation_id="$1"
  local single_probe="${2:-false}"
  local started now elapsed response parsed status error
  started="$(date +%s)"
  while true; do
    response="$(admin_json_request POST "$CUTOVER_API_BASE/continuation" \
      "{\"canaryAttestationId\":\"$attestation_id\"}")" || return 15
    parsed="$(printf '%s' "$response" | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
status = payload.get("status")
if status not in {"pending", "routed", "evidence", "not_required"}:
    raise SystemExit("continuation response has an invalid status")
error = payload.get("lastError")
if error is not None and not isinstance(error, str):
    raise SystemExit("continuation response has an invalid lastError")
required = payload.get("requiredCampaigns")
campaigns = payload.get("campaigns")
if not isinstance(required, int) or required < 0 or not isinstance(campaigns, list):
    raise SystemExit("continuation response lacks aggregate campaign proof")
if status == "not_required" and (required != 0 or campaigns):
    raise SystemExit("not-required continuation contains runnable campaigns")
if status != "not_required" and len(campaigns) != required:
    raise SystemExit("continuation campaign proof count is inconsistent")
print(status)
print(error or "")
')" || return 15
    status="$(sed -n '1p' <<<"$parsed")"
    CONTINUATION_TERMINAL_STATUS=""
    error="$(sed -n '2p' <<<"$parsed")"
    if [[ -n "$error" ]]; then
      echo "OpenCFD v2606 successor continuation failed closed: $error" >&2
      return 15
    fi
    if [[ "$status" == "evidence" || "$status" == "not_required" ]]; then
      CONTINUATION_TERMINAL_STATUS="$status"
      if [[ "$status" == "not_required" ]]; then
        echo "No previously runnable campaign requires successor-generation evidence."
        return 0
      fi
      echo "A successor-generation job routed through the exact OpenCFD v2606 pool and published attested runtime evidence."
      return 0
    fi
    if [[ "$single_probe" == "true" ]]; then
      echo "Successor continuation is not yet terminal (durable status: $status)."
      return 16
    fi
    now="$(date +%s)"
    elapsed=$((now - started))
    if ((elapsed >= CUTOVER_CONTINUATION_TIMEOUT_SECONDS)); then
      echo "Timed out after ${elapsed}s waiting for OpenCFD v2606 successor evidence (durable status: $status)." >&2
      return 15
    fi
    if ((elapsed == 0 || elapsed % 30 < 5)); then
      echo "Waiting for successor-generation OpenCFD v2606 evidence (status: $status)..."
    fi
    sleep 5
  done
}

certify_opencfd_2606_continuation() {
  acquire_deploy_lock || exit $?
  verify_deployment_source || exit $?
  validate_recovery_state_paths || exit $?
  validate_opencfd_2606_cutover_state pending-certifiable || exit $?
  if [[ -z "$ADMIN_COOKIE" ]]; then
    echo "ADMIN_COOKIE is required for continuation certification." >&2
    exit 14
  fi
  # Certification-only recovery is still a remote-evidence operation. Refuse
  # bucket/prefix/Zstandard/local-disposition drift before disabling a pool or
  # replaying any retained receipt.
  validate_remote_evidence_configuration
  local pending attestation_id complete_marker current_state receipt_recovery=false
  local durable_sweeper_state entry_sweeper_state finish_rc=0
  pending="$(read_env_var OPENCFD2606_CUTOVER_PENDING || true)"
  attestation_id="$(read_env_var OPENCFD2606_CANARY_ATTESTATION_ID || true)"
  complete_marker="$(read_env_var OPENCFD2606_CUTOVER_COMPLETE || true)"
  # A power loss may occur after the atomic attestation tuple is durable but
  # before its now-redundant receipt is unlinked.  Reprove that exact retained
  # receipt against current object generations, then remove it durably while
  # the deployment lock is held.  This is recovery cleanup, not a new canary.
  if [[ -n "$attestation_id" && -e "$OPENCFD2606_CANARY_RECEIPT_FILE" ]]; then
    if ! python3 "$DEPLOY_SCRIPT_DIR/persist-json-receipt.py" \
      --profile opencfd2606-canary \
      --destination "$OPENCFD2606_CANARY_RECEIPT_FILE" \
      --verify-existing; then
      echo "The redundant post-attestation canary receipt is not a durable valid receipt; refusing certification replay." >&2
      exit 14
    fi
    echo "Re-proving the redundant post-attestation receipt before durable cleanup..."
    if ! verify_retained_opencfd_2606_receipt "$OPENCFD2606_CANARY_RECEIPT_FILE"; then
      echo "The redundant post-attestation receipt no longer matches its exact object generations; refusing certification replay." >&2
      exit 14
    fi
    OPENCFD2606_RETAINED_RECEIPT_REPROVED=true
    remove_file_durably "$OPENCFD2606_CANARY_RECEIPT_FILE"
    echo "Removed the re-proven redundant post-attestation receipt."
  fi
  if [[ -z "$attestation_id" && -s "$OPENCFD2606_CANARY_RECEIPT_FILE" ]]; then
    receipt_recovery=true
  fi
  if [[ "$pending" != "1" || "$complete_marker" != "0" ]] || \
    { [[ ! "$attestation_id" =~ ^[0-9a-fA-F-]{36}$ ]] && [[ "$receipt_recovery" != "true" ]]; }; then
    echo "No consistent pending OpenCFD v2606 continuation attestation tuple is recorded; refusing to guess recovery state." >&2
    exit 14
  fi
  if [[ "$attestation_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    validate_certified_evidence_contract true
  else
    # Before the initial attestation has been acknowledged, the retained exact
    # receipt remains the authority. A marker is optional on this one recovery
    # path; if present, it must still match.
    validate_certified_evidence_contract false
  fi
  case "$(read_env_var OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING || true)" in
    1) durable_sweeper_state="running" ;;
    0) durable_sweeper_state="stopped" ;;
    *)
      echo "Pending continuation lacks its durable pre-maintenance sweeper state; refusing to guess." >&2
      exit 14
      ;;
  esac
  # Compare the exact live gateway storage identity to .env.deploy before the
  # scheduler or execution-pool state is touched. A syntactically valid but
  # drifted bucket/prefix/codec must fail as early as an unsafe value.
  verify_opencfd_2606_runtime
  arm_opencfd_2606_exit_fail_safe
  entry_sweeper_state="$(capture_sweeper_state)"
  echo "Quiescing the scheduler and closing the OpenCFD v2606 admission fence before replaying certification..."
  if [[ "$entry_sweeper_state" == "running" ]]; then
    compose stop sweeper
  fi
  disable_opencfd_2606_pool_fail_safe "entering continuation certification"
  if [[ "$OPENCFD2606_POOL_FAIL_SAFE_DISABLED" != "true" ]]; then
    echo "Continuation certification cannot proceed until the OpenCFD v2606 pool is confirmed disabled." >&2
    exit 14
  fi
  local engine_version
  if ! engine_version="$(current_default_engine_version 2>&1)" || [[ "$engine_version" != "2606" ]]; then
    echo "Continuation certification requires the already-attested OpenCFD v2606 engine; refusing an engine rebuild or runtime substitution." >&2
    echo "$engine_version" >&2
    exit 14
  fi
  CUTOVER_ATTESTATION_ID="$attestation_id"
  if [[ "$receipt_recovery" == "true" ]]; then
    if ! python3 "$DEPLOY_SCRIPT_DIR/persist-json-receipt.py" \
      --profile opencfd2606-canary \
      --destination "$OPENCFD2606_CANARY_RECEIPT_FILE" \
      --verify-existing; then
      echo "The retained receipt is not a durable regular receipt file; refusing recovery replay." >&2
      exit 14
    fi
    echo "Re-proving the retained receipt before any execution-pool activation or attestation replay..."
    if ! verify_retained_opencfd_2606_receipt "$OPENCFD2606_CANARY_RECEIPT_FILE"; then
      echo "The retained receipt no longer hydrates and renders from its exact current bucket/key/generation bindings; refusing replay." >&2
      exit 14
    fi
    OPENCFD2606_RETAINED_RECEIPT_REPROVED=true
  fi
  # Idempotently replay the live-attestation gates and finish any interrupted
  # finalize/complete stage before checking successor continuation. This path
  # deliberately does not rebuild or accept a new BUILD_ID.
  if finish_opencfd_2606_cutover; then
    :
  else
    finish_rc=$?
    echo "Certification replay was not acknowledged; the database may have committed the requested stage. The scheduler remains quiesced, the durable marker is retained, and this exact attestation must be replayed." >&2
    exit "$finish_rc"
  fi
  attestation_id="$CUTOVER_ATTESTATION_ID"
  if [[ ! "$attestation_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    echo "Certification finished without a durable OpenCFD v2606 attestation id; refusing continuation." >&2
    exit 14
  fi
  # A valid atomic attestation tuple supersedes any retained receipt copy.
  # Remove it while the fail-safe is still armed so a filesystem failure does
  # not silently leave a future normal rebuild blocked by stale recovery data.
  remove_file_durably "$OPENCFD2606_CANARY_RECEIPT_FILE"
  current_state="stopped"
  if [[ "$durable_sweeper_state" == "running" ]]; then
    echo "Restoring the scheduler after all live attestation/finalization gates succeeded..."
    compose up -d --no-deps sweeper
    current_state="running"
  fi
  if [[ "$current_state" != "running" ]]; then
    local stopped_probe_rc=0
    if wait_for_opencfd_2606_continuation_evidence "$attestation_id" true; then
      :
    else
      stopped_probe_rc=$?
    fi
    if [[ "$CONTINUATION_TERMINAL_STATUS" == "evidence" || "$CONTINUATION_TERMINAL_STATUS" == "not_required" ]]; then
      :
    else
      if ((stopped_probe_rc != 0 && stopped_probe_rc != 16)); then
        disable_opencfd_2606_pool_fail_safe "the stopped-scheduler continuation certification probe failed"
        echo "Continuation certification failed while probing the stopped scheduler; the durable marker remains pending." >&2
        exit 15
      fi
      echo "The sweeper was recorded as intentionally stopped and runnable continuation is not yet proven. Run it separately until successor evidence is durable, stop it again, then rerun --certify-opencfd-2606-continuation." >&2
      exit 14
    fi
  elif ! wait_for_opencfd_2606_continuation_evidence "$attestation_id"; then
    compose stop sweeper || true
    disable_opencfd_2606_pool_fail_safe "successor continuation certification failed"
    echo "Continuation certification failed; the scheduler was stopped fail-safe and the durable marker remains pending." >&2
    exit 15
  fi
  set_opencfd_2606_cutover_state 0 "" "" 1
  disarm_opencfd_2606_exit_fail_safe
  echo "OpenCFD v2606 successor continuation is certified; the maintenance marker is cleared."
}

wait_http() {
  local label="$1"
  local url="$2"
  local attempts="${3:-60}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS --max-time 5 "$url" >/dev/null; then
      echo "$label is healthy"
      return 0
    fi
    sleep 2
  done
  echo "$label did not become healthy at $url" >&2
  return 1
}

run_post_node_health_verifier() {
  local verifier="$OPENCFD2606_POST_NODE_HEALTH_VERIFIER"
  if [[ -z "$verifier" ]]; then
    return 0
  fi
  if [[ "$verifier" != /* || ! -f "$verifier" || -L "$verifier" || ! -x "$verifier" ]]; then
    echo "OPENCFD2606_POST_NODE_HEALTH_VERIFIER must be an absolute executable regular file." >&2
    return 14
  fi
  echo "Verifying the staged OpenCFD v2606 canary database-ACK migration before pool activation..."
  APP_DIR="$APP_DIR" AIRFOILS_PRO_STATE_DIR="$AIRFOILS_PRO_STATE_DIR" \
    ENV_FILE="$ENV_FILE" COMPOSE_FILE="$COMPOSE_FILE" \
    COMPOSE_PROJECT_DIRECTORY="$COMPOSE_PROJECT_DIRECTORY" \
    COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" DEPLOY_SCRIPT_DIR="$DEPLOY_SCRIPT_DIR" \
    "$verifier"
  echo "Staged OpenCFD v2606 canary database-ACK migration is verified."
}

validate_normal_rebuild_cutover_markers() {
  local pending restore_state attestation complete receipt_expected
  pending="$(read_env_var OPENCFD2606_CUTOVER_PENDING || true)"
  restore_state="$(read_env_var OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING || true)"
  attestation="$(read_env_var OPENCFD2606_CANARY_ATTESTATION_ID || true)"
  complete="$(read_env_var OPENCFD2606_CUTOVER_COMPLETE || true)"
  receipt_expected="$(read_env_var OPENCFD2606_CANARY_RECEIPT_EXPECTED || true)"

  if [[ "$receipt_expected" == "1" && ! -s "$OPENCFD2606_CANARY_RECEIPT_FILE" ]]; then
    echo "The pending OpenCFD v2606 cutover expects an exact retained canary receipt, but $OPENCFD2606_CANARY_RECEIPT_FILE is missing; refusing to rebuild or rerun canaries automatically." >&2
    return 14
  fi
  if [[ ! "$receipt_expected" =~ ^(|0|1)$ ]]; then
    echo "OPENCFD2606_CANARY_RECEIPT_EXPECTED has an invalid value; refusing a normal engine rebuild." >&2
    return 14
  fi

  # Any attestation value, including a malformed/partially-written value, is
  # recovery state. A normal rebuild must never substitute a new runtime for
  # it; only the exact certification path may replay a valid tuple.
  if [[ -n "$attestation" ]]; then
    if [[ "$pending" == "1" && "$restore_state" =~ ^[01]$ && "$complete" == "0" && "$attestation" =~ ^[0-9a-fA-F-]{36}$ ]]; then
      echo "A durable OpenCFD v2606 attestation is already pending; refusing a normal engine rebuild." >&2
      echo "Replay the exact live attestation and unfinished stages with: $0 --certify-opencfd-2606-continuation" >&2
    else
      echo "The OpenCFD v2606 recovery markers are inconsistent (including a nonempty attestation); refusing a normal engine rebuild or runtime substitution." >&2
      echo "Restore the atomic marker tuple from the deployment backup before attempting exact certification." >&2
    fi
    return 14
  fi

  if [[ -s "$OPENCFD2606_CANARY_RECEIPT_FILE" ]]; then
    if [[ "$pending" == "1" && "$restore_state" =~ ^[01]$ && "$complete" == "0" ]]; then
      echo "An exact OpenCFD v2606 canary receipt is retained without its acknowledged attestation id; refusing a normal rebuild or runtime substitution." >&2
      echo "Replay it against the current runtime with: $0 --certify-opencfd-2606-continuation" >&2
    else
      echo "A retained OpenCFD v2606 canary receipt conflicts with the recovery marker tuple; refusing a normal rebuild." >&2
    fi
    return 14
  fi

  case "$pending" in
    1)
      if [[ ! "$restore_state" =~ ^[01]$ || "$complete" != "0" ]]; then
        echo "The pending OpenCFD v2606 recovery marker tuple is inconsistent; refusing to guess scheduler or completion state." >&2
        return 14
      fi
      ;;
    0)
      # `complete=0` is the pristine already-2606 bootstrap shipped by
      # .env.example; `complete=1` is the terminal certified state. Both must
      # have no saved scheduler state. Certification distinguishes them with
      # the contract marker below.
      if [[ -n "$restore_state" || ! "$complete" =~ ^[01]$ ]]; then
        echo "The non-pending OpenCFD v2606 recovery marker tuple is inconsistent; refusing a normal engine rebuild." >&2
        return 14
      fi
      if [[ "$complete" == "0" && "$receipt_expected" != "0" ]]; then
        echo "The pristine OpenCFD v2606 activation tuple lacks its explicit no-receipt marker; refusing a normal engine rebuild." >&2
        return 14
      fi
      ;;
    "")
      # Backward compatibility is limited to the wholly absent legacy tuple.
      # A missing pending marker paired with any other recovery field is a
      # partial write and must fail closed.
      if [[ -n "$restore_state" || -n "$complete" || -n "$receipt_expected" ]]; then
        echo "The OpenCFD v2606 recovery marker tuple is inconsistent; refusing a normal engine rebuild." >&2
        return 14
      fi
      ;;
    *)
      echo "OPENCFD2606_CUTOVER_PENDING has an invalid value; refusing a normal engine rebuild." >&2
      return 14
      ;;
  esac
}

main() {
  acquire_deploy_lock || exit $?
  verify_deployment_source || exit $?
  validate_recovery_state_paths || exit $?
  validate_opencfd_2606_cutover_state any || exit $?
  case "$OPENCFD2606_MEDIA_REPAIR_RESTORE_STATE" in
    ""|running|stopped) ;;
    *)
      echo "OPENCFD2606_MEDIA_REPAIR_RESTORE_STATE must be running, stopped, or empty." >&2
      exit 14
      ;;
  esac

  echo "Engine rebuild starting: BUILD_ID=$BUILD_ID"

  # The production canary is intentionally incapable of certifying a volume-
  # only result. Refuse before an expensive image build if the worker/API
  # environment cannot publish immutable tar+zstd evidence and remove its
  # packaged local copy after verification.
  validate_remote_evidence_configuration

  local sweeper_initial_state sweeper_restore_state
  sweeper_initial_state="$(capture_sweeper_state)"
  sweeper_restore_state="$sweeper_initial_state"
  echo "Sweeper state before engine rebuild: $sweeper_initial_state"

  # Never leave a still-running optional worker on an older build merely
  # because its profile was removed from .env.deploy. Restore the profile (or
  # stop the idle service during a separately guarded retirement action) before
  # this coordinated build-id cutover.
  local unconfigured_workers
  if ! unconfigured_workers="$(unconfigured_running_engine_workers 2>&1)"; then
    echo "Could not reconcile configured and running engine workers; refusing rebuild:" >&2
    echo "$unconfigured_workers" >&2
    exit 12
  fi
  if [[ -n "$unconfigured_workers" ]]; then
    echo "Refusing engine rebuild because engine workers are running outside the active Compose profiles:" >&2
    echo "$unconfigured_workers" >&2
    echo "Restore their COMPOSE_PROFILES entry and retry so they participate in the guarded rebuild." >&2
    exit 12
  fi

  local running_engine_version cutover_pending cutover_complete cutover_attestation
  local cutover_active=false certified_contract_required=false
  if ! running_engine_version="$(current_default_engine_version 2>&1)"; then
    echo "Could not establish the current executable solver identity; refusing engine maintenance:" >&2
    echo "$running_engine_version" >&2
    exit 13
  fi
  cutover_pending="$(read_env_var OPENCFD2606_CUTOVER_PENDING || true)"
  cutover_complete="$(read_env_var OPENCFD2606_CUTOVER_COMPLETE || true)"
  cutover_attestation="$(read_env_var OPENCFD2606_CANARY_ATTESTATION_ID || true)"
  if [[ "$cutover_complete" == "1" || -n "$cutover_attestation" ]]; then
    certified_contract_required=true
  fi
  # Verify an attested storage contract before interpreting or refusing the
  # recovery tuple. This makes even a normal-rebuild attempt against pending
  # attestation state detect bucket/prefix/codec drift first.
  validate_certified_evidence_contract "$certified_contract_required"
  validate_normal_rebuild_cutover_markers
  if [[ "$cutover_pending" == "1" ]]; then
    case "$(read_env_var OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING || true)" in
      1) sweeper_restore_state="running" ;;
      0) sweeper_restore_state="stopped" ;;
      *)
        echo "Cutover is pending but its original sweeper state is missing; refusing to guess whether campaign execution should resume." >&2
        exit 14
        ;;
    esac
  fi
  case "$running_engine_version" in
    2406)
      # current_default_engine_version returns 2406 only after the independent
      # image and worker-runtime corroboration above. There is intentionally no
      # environment override that can weaken the normal 2606 queue contract.
      LEGACY_2406_QUEUE_COMPATIBILITY=true
      cutover_active=true
      ;;
    2606)
      if [[ "$cutover_pending" == "1" || "$cutover_complete" != "1" ]]; then
        cutover_active=true
      fi
      ;;
    *)
      echo "Unsupported default executable engine version '$running_engine_version'; refusing maintenance." >&2
      exit 13
      ;;
  esac

  if [[ "$cutover_active" == "true" ]]; then
    if [[ -z "$ADMIN_COOKIE" ]]; then
      echo "ADMIN_COOKIE is mandatory for the OpenCFD v2406 -> v2606 campaign cutover." >&2
      exit 14
    fi
    probe_opencfd_2606_cutover_control_plane
    prepare_opencfd_2606_cutover "$sweeper_restore_state"
    wait_for_opencfd_2606_cutover_drain
  fi

  # 1. Refuse maintenance while a solve is active. The check is repeated
  #    after the potentially long image build so a solve that started during
  #    that window cannot be terminated by the recreate below.
  require_idle_worker "before image build"

  # 2. Build with the requested id supplied as a process-level Compose
  #    override. Do not edit the persistent env file yet: if the second idle
  #    check refuses the recreate, the running control plane must continue to
  #    expect the currently served engine build.
  local configured_workers
  if ! configured_workers="$(configured_engine_worker_services)"; then
    echo "Could not resolve configured engine worker services; refusing rebuild." >&2
    exit 12
  fi
  local -a worker_services
  mapfile -t worker_services <<<"$configured_workers"
  if ((${#worker_services[@]} == 0)) || [[ -z "${worker_services[0]}" ]]; then
    echo "No configured engine worker services found; refusing rebuild." >&2
    exit 12
  fi
  # Build every image that will be recreated before mutating the persistent
  # identity tuple.  This is especially important when COMPOSE_FILE and its
  # project directory point at an incident-reviewed staging tree while APP_DIR
  # remains bound to the pending cutover source.
  local -a control_plane_build_services=(node-api sweeper)
  if [[ -n "$OPENCFD2606_MEDIA_REPAIR_RESTORE_STATE" ]]; then
    control_plane_build_services+=(media-repair)
  fi
  AIRFOILFOAM_BUILD_ID="$BUILD_ID" ENGINE_EXPECTED_BUILD_ID="$BUILD_ID" \
    compose build api "${worker_services[@]}" "${control_plane_build_services[@]}"

  # Freeze scheduling before the final idle proof. Leaving the old sweeper
  # live between that proof and force-recreate would let it submit a new solve
  # which the worker recreate then kills. A refused maintenance action occurs
  # before either build-id setting changes, so it is safe to restore the old
  # sweeper's prior running/stopped state in that one path.
  compose stop sweeper
  if [[ -n "$OPENCFD2606_MEDIA_REPAIR_RESTORE_STATE" ]]; then
    # The incident wrapper has already stopped this service before taking the
    # strong database backup. Reassert the stop immediately before migration;
    # a restart policy or operator must not reopen the writer window.
    compose stop media-repair
  fi
  if ! require_idle_worker "before service recreate"; then
    restore_sweeper_after_refusal "$sweeper_restore_state"
    exit 12
  fi
  # A submit HTTP request sent just before the sweeper stopped can finish in
  # the engine after the first sample. Require a stable second empty sample
  # before mutating env or recreating either engine service.
  sleep 2
  if ! require_idle_worker "stabilized before service recreate"; then
    restore_sweeper_after_refusal "$sweeper_restore_state"
    exit 12
  fi

  # 3. Both build-id expectations move together, immediately BEFORE the
  #    recreate. A recreate that precedes the env edit bakes the old value
  #    into a container (root cause of the 2026-07-05 stale-banner incident).
  local -a engine_identity_updates=(
    "AIRFOILFOAM_BUILD_ID=$BUILD_ID"
    "ENGINE_EXPECTED_BUILD_ID=$BUILD_ID"
  )
  if [[ "$cutover_active" == "true" ]]; then
    local migrated_enabled_engine_keys
    if ! migrated_enabled_engine_keys="$(compute_migrated_opencfd_enabled_engine_keys)"; then
      echo "Could not derive the OpenCFD v2606 gateway engine allow-list; refusing the identity cutover." >&2
      restore_sweeper_after_refusal "$sweeper_restore_state"
      exit 14
    fi
    engine_identity_updates+=(
      "AIRFOILFOAM_ENABLED_ENGINE_KEYS=$migrated_enabled_engine_keys"
    )
  fi
  set_env_vars_atomic "${engine_identity_updates[@]}"
  echo "Updated AIRFOILFOAM_BUILD_ID and ENGINE_EXPECTED_BUILD_ID in $ENV_FILE"
  if [[ "$cutover_active" == "true" ]]; then
    echo "Updated gateway engine allow-list for OpenCFD v2606 (other engine keys preserved) in the same atomic identity transaction."
  fi

  # 4. Force-recreate every service that reads a build-id env var
  #    (docker-compose.deploy.yml):
  #      api, engine workers -> AIRFOILFOAM_BUILD_ID (build arg + env)
  #      node-api     -> ENGINE_EXPECTED_BUILD_ID (env)
  #      sweeper      -> AIRFOILFOAM_BUILD_ID (env)
  #    web reads neither var and is intentionally left alone.
  #    The two idle guards above make an in-flight solver termination a refused
  #    maintenance action. Recovery below is still required for stale rows
  #    left by an earlier crash or interrupted deployment.
  # node-api may apply a pending schema migration as it starts. The old
  # sweeper is already quiescent from the final idle proof above, so no
  # pre-migration writer can publish evidence during that cutover.
  compose up -d --no-deps --force-recreate api "${worker_services[@]}" node-api

  # 5. Verify the engine actually serves the new build.
  wait_http "engine API" "http://127.0.0.1:8000/health" 60
  local health served_build
  health="$(curl -fsS --max-time 5 http://127.0.0.1:8000/health)"
  served_build="$(printf '%s' "$health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("build_id") or "")')"
  if [[ "$served_build" != "$BUILD_ID" ]]; then
    echo "Engine /health build_id mismatch: expected $BUILD_ID, got '$served_build'" >&2
    echo "Full /health payload: $health" >&2
    exit 13
  fi
  echo "Engine serves build_id=$BUILD_ID"

  if [[ "$cutover_active" == "true" ]]; then
    verify_opencfd_2606_runtime
  fi

  wait_http "node-api" "http://127.0.0.1:4000/health" 90
  run_post_node_health_verifier
  if [[ "$cutover_active" == "true" ]]; then
    finish_opencfd_2606_cutover
  fi
  restore_sweeper_after_rebuild "$sweeper_restore_state"
  if [[ "$cutover_active" == "true" ]]; then
    if [[ "$sweeper_restore_state" == "running" ]]; then
      if ! wait_for_opencfd_2606_continuation_evidence "$CUTOVER_ATTESTATION_ID"; then
        compose stop sweeper || true
        disable_opencfd_2606_pool_fail_safe "successor continuation failed"
        echo "The sweeper has been stopped fail-safe. OPENCFD2606_CUTOVER_PENDING=1 and the durable continuation record remain for an idempotent retry." >&2
        exit 15
      fi
      # Clear the recovery marker only after the original running scheduler
      # has both been restored and published exact successor evidence.
      set_opencfd_2606_cutover_state 0 "" "" 1
      disarm_opencfd_2606_exit_fail_safe
    else
      # Do not start solver work merely to satisfy maintenance. The database
      # may still prove that no previously runnable campaigns exist. Probe
      # exactly once: only the aggregate not_required state may clear the
      # marker while the scheduler remains stopped.
      local stopped_probe_rc=0
      if wait_for_opencfd_2606_continuation_evidence "$CUTOVER_ATTESTATION_ID" true; then
        :
      else
        stopped_probe_rc=$?
      fi
      if [[ "$CONTINUATION_TERMINAL_STATUS" == "not_required" ]]; then
        set_opencfd_2606_cutover_state 0 "" "" 1
        disarm_opencfd_2606_exit_fail_safe
        echo "The sweeper remains intentionally stopped; no runnable campaign required successor continuation."
      elif ((stopped_probe_rc != 0 && stopped_probe_rc != 16)); then
        disable_opencfd_2606_pool_fail_safe "the stopped-scheduler continuation probe failed"
        echo "The stopped-scheduler continuation probe failed closed; the durable cutover marker remains pending." >&2
        exit 15
      else
        echo "The sweeper was intentionally stopped before maintenance; preserving that state with successor continuation awaiting a scheduler. The cutover marker remains pending and is not reported as proven."
      fi
    fi
  fi

  # Keep presentation-evidence writers stopped throughout canary registration,
  # cleanup proof, attestation, successor finalization, and continuation gates.
  # Only the terminal successful path restores/recreates the service according
  # to the exact state journalled before backup.
  restore_media_repair_after_rebuild

  # 6. Requeue jobs orphaned by the worker restart. Requires an admin session
  #    cookie (aero_admin=<token>) in ADMIN_COOKIE. Manual fallback: log into
  #    /admin and press "Recover stale jobs", or run
  #    curl -X POST -H 'Content-Type: application/json' \
  #      -H "Cookie: aero_admin=<token>" \
  #      -d '{"olderThanMinutes":30}' https://airfoils.pro/api/admin/jobs/recover-stale
  if [[ -n "$ADMIN_COOKIE" ]]; then
    echo "Triggering stale-job recovery..."
    admin_json_request POST \
      "http://127.0.0.1:4000/api/admin/jobs/recover-stale" \
      '{"olderThanMinutes":30}' || {
      echo "recover-stale call failed — run it manually from /admin" >&2
    }
    echo
  else
    echo "ADMIN_COOKIE not set — run stale-job recovery manually from /admin (or the curl in this script's comments)."
  fi

  echo "Container status:"
  compose ps
  echo "Engine rebuild finished."
}

if [[ "$CERTIFY_CONTINUATION_ONLY" == "true" ]]; then
  certify_opencfd_2606_continuation
else
  main
fi
