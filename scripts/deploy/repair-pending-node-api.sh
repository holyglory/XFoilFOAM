#!/usr/bin/env bash
# Incident-specific recovery for the 2026-07-17 OpenCFD v2606 cutover.
#
# The cutover is durably bound to source 6338577, but that Node API aborts the
# authoritative Celery queue handshake at 5 seconds while production needs
# about 5.03 seconds.  Normal promotion correctly refuses every source change
# while the cutover is pending.  This tool admits exactly the reviewed 15-second
# Node-only patch, journals the mixed-source runtime, and leaves APP_DIR, engine
# containers, the disabled execution pool, and the stopped scheduler untouched.
set -Eeuo pipefail

STAGING_DIR="${STAGING_DIR:?STAGING_DIR is required}"
APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-app}"
EXPECTED_TARGET_SOURCE_REVISION="${EXPECTED_TARGET_SOURCE_REVISION:?EXPECTED_TARGET_SOURCE_REVISION is required}"
REPAIR_RECEIPT_FILE="${REPAIR_RECEIPT_FILE:-$AIRFOILS_PRO_STATE_DIR/pending-cutover-node-api-repair.json}"
OPENCFD2606_CANARY_RECEIPT_FILE="${OPENCFD2606_CANARY_RECEIPT_FILE:-$AIRFOILS_PRO_STATE_DIR/openfoam-2606-canary-receipt.pending.json}"

# These constants deliberately make this an incident repair, not a generic
# pending-cutover deployment bypass.
EXPECTED_BOUND_SOURCE_REVISION="63385777be7323777906fde44bdb9fa9b5cc0d6d"
EXPECTED_BOUND_SOURCE_TREE_SHA256="52c8bd3aa6d5a05dcd70a90d8896fb771f7fc36d129e698be0c935680e3fff36"
EXPECTED_BOUND_SOURCE_FILE_COUNT="2198"
EXPECTED_BOUND_API_SHA256="fa0654f95108b8d5b75ab56e81e13c9bd4706491904f776f95f1648eefc7bdea"
EXPECTED_REPAIR_API_SHA256="e3e1782f0517ea29e451fd89661a1a54f982673cd62ad5502e5d45eaaa6a94f4"
EXPECTED_BOUND_API_TEST_SHA256="b936abf58c27f26bfec6a1c9f74fe4c1828c72d9d7faa3db5d2694e6a55a973d"
EXPECTED_REPAIR_API_TEST_SHA256="bbc75aa6c6f0d4cca18f051fd1d06d89750c951d625ccd57031fd1a0b3c00e29"
OPENCFD_2606_POOL_ID="3f8bc764-09ae-4ff3-8fd2-260600000001"
OPENCFD_2606_ROUTE="openfoam-opencfd-2606"

fail() {
  echo "$1" >&2
  return "${2:-12}"
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

sha256_text() {
  printf '%s' "$1" | sha256sum | awk '{print $1}'
}

read_env_var() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

if [[ ! "$EXPECTED_TARGET_SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Pending-cutover repair target revision must be an exact lowercase commit SHA." 2
  exit $?
fi
if [[ ! -d "$STAGING_DIR" || -L "$STAGING_DIR" ]]; then
  fail "Pending-cutover repair staging source is missing or unsafe: $STAGING_DIR" 2
  exit $?
fi
if [[ ! -L "$APP_DIR" ]]; then
  fail "Pending-cutover repair requires APP_DIR to remain the versioned release symlink." 2
  exit $?
fi
staging_real="$(realpath "$STAGING_DIR")"
app_real="$(readlink -f "$APP_DIR")"
if [[ ! -d "$app_real" || -L "$app_real" || "$staging_real" == "$app_real" ]]; then
  fail "Pending-cutover repair requires distinct, real staging and bound release directories." 2
  exit $?
fi
if [[ ! -d "$AIRFOILS_PRO_STATE_DIR" || -L "$AIRFOILS_PRO_STATE_DIR" ]]; then
  fail "Pending-cutover repair state directory is missing or unsafe." 2
  exit $?
fi
if [[ "$(realpath -m "$(dirname "$REPAIR_RECEIPT_FILE")")" != "$(realpath "$AIRFOILS_PRO_STATE_DIR")" ]]; then
  fail "Pending-cutover repair journal must live directly in the protected state directory." 2
  exit $?
fi
if [[ -L "$REPAIR_RECEIPT_FILE" ]]; then
  fail "Pending-cutover repair journal must never be a symlink." 2
  exit $?
fi

# The lock is acquired before reading any mutable recovery state.  Static
# staging validation also remains under the lock so the captured invariants
# describe the exact state against which the Node container is swapped.
exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "Another Airfoils.Pro deploy or engine maintenance action is running." >&2
  exit 9
}

manifest_tool="$app_real/scripts/deploy/deployment-source-manifest.py"
state_tool="$app_real/scripts/deploy/opencfd2606_cutover_state.py"
preflight_tool="$app_real/scripts/deploy/deployment-env-preflight.py"
compose_file="$staging_real/docker-compose.deploy.yml"
for required in "$manifest_tool" "$state_tool" "$preflight_tool" "$compose_file"; do
  if [[ ! -f "$required" || -L "$required" ]]; then
    fail "Pending-cutover repair lacks a required bound/staged regular file: $required" 2
    exit $?
  fi
done
if [[ ! -f "$ENV_FILE" || -L "$ENV_FILE" || "$(stat -c '%a' "$ENV_FILE")" != "600" ]]; then
  fail "Pending-cutover repair requires the authoritative mode-0600 deployment environment." 2
  exit $?
fi
if [[ "$(stat -c '%u' "$ENV_FILE")" != "$(id -u)" ]]; then
  fail "Pending-cutover repair requires the deployment environment to be owned by the deploying user." 2
  exit $?
fi

python3 "$preflight_tool" \
  --app-dir "$APP_DIR" \
  --state-dir "$AIRFOILS_PRO_STATE_DIR" \
  --env-file "$ENV_FILE" \
  >/dev/null

# Use the immutable bound verifier for both trees.  The repair source never
# gets to redefine the source-entry model that polices its own diff.
IFS=$'\t' read -r bound_revision bound_tree bound_count < <(
  python3 "$manifest_tool" \
    --verify --root "$app_real" --manifest "$app_real/.deployment-source.json"
)
IFS=$'\t' read -r target_revision target_tree target_count < <(
  python3 "$manifest_tool" \
    --verify --root "$staging_real" --manifest "$staging_real/.deployment-source.json"
)
if [[ "$bound_revision" != "$EXPECTED_BOUND_SOURCE_REVISION" || \
      "$bound_tree" != "$EXPECTED_BOUND_SOURCE_TREE_SHA256" || \
      "$bound_count" != "$EXPECTED_BOUND_SOURCE_FILE_COUNT" ]]; then
  fail "Pending-cutover repair is bound to an unexpected production release." 14
  exit $?
fi
if [[ "$target_revision" != "$EXPECTED_TARGET_SOURCE_REVISION" || "$target_revision" == "$bound_revision" ]]; then
  fail "Pending-cutover repair target does not match the explicitly dispatched source revision." 14
  exit $?
fi

if [[ "$(sha256_file "$app_real/apps/api/src/admin-routes.ts")" != "$EXPECTED_BOUND_API_SHA256" || \
      "$(sha256_file "$staging_real/apps/api/src/admin-routes.ts")" != "$EXPECTED_REPAIR_API_SHA256" || \
      "$(sha256_file "$app_real/apps/api/test/solver-execution-pool-admission.test.ts")" != "$EXPECTED_BOUND_API_TEST_SHA256" || \
      "$(sha256_file "$staging_real/apps/api/test/solver-execution-pool-admission.test.ts")" != "$EXPECTED_REPAIR_API_TEST_SHA256" ]]; then
  fail "Pending-cutover repair API implementation/test bytes differ from the reviewed incident patch." 14
  exit $?
fi

source_change_report="$(python3 - "$manifest_tool" "$app_real" "$staging_real" <<'PY'
import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import sys

tool, bound_root, target_root = map(Path, sys.argv[1:])
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("bound_deployment_source_manifest", tool)
if spec is None or spec.loader is None:
    raise SystemExit("cannot load the bound deployment source manifest model")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

expected = {
    "apps/api/src/admin-routes.ts",
    "apps/api/test/solver-execution-pool-admission.test.ts",
    "scripts/deploy/repair-pending-node-api.sh",
    "tests/test_pending_cutover_node_api_repair.py",
}

def entries(root: Path) -> dict[str, tuple[str, bool, str]]:
    result = {}
    for path in module._source_entries(root):
        relative = path.relative_to(root).as_posix()
        metadata = path.lstat()
        executable = bool(metadata.st_mode & 0o111)
        if stat.S_ISREG(metadata.st_mode):
            kind = "file"
            payload = path.read_bytes()
        elif stat.S_ISLNK(metadata.st_mode):
            kind = "symlink"
            payload = os.readlink(path).encode()
        else:
            raise SystemExit(f"unsupported source entry: {relative}")
        result[relative] = (kind, executable, hashlib.sha256(payload).hexdigest())
    return result

bound = entries(bound_root)
target = entries(target_root)
changed = sorted(path for path in set(bound) | set(target) if bound.get(path) != target.get(path))
if set(changed) != expected:
    print("repair source diff is not the exact reviewed incident scope", file=sys.stderr)
    for path in changed:
        print(f"  {path}", file=sys.stderr)
    raise SystemExit(14)
lines = [f"{path}\t{target[path][0]}\t{int(target[path][1])}\t{target[path][2]}" for path in changed]
digest = hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest()
print(digest)
print("\n".join(changed))
PY
)" || exit $?
source_change_digest="$(sed -n '1p' <<<"$source_change_report")"
source_change_paths_json="$(tail -n +2 <<<"$source_change_report" | python3 -c 'import json,sys; print(json.dumps([line.rstrip("\n") for line in sys.stdin if line.strip()], separators=(",", ":")))')"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi
compose_bound() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" \
    -f "$app_real/docker-compose.deploy.yml" "$@"
}
compose_target() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" \
    -f "$compose_file" "$@"
}

validate_pending_state() {
  local state_json
  state_json="$(python3 "$state_tool" \
    --env-file "$ENV_FILE" \
    --receipt-file "$OPENCFD2606_CANARY_RECEIPT_FILE" \
    --current-source-revision "$bound_revision" \
    --current-source-tree-sha256 "$bound_tree" \
    --require-state any \
    --print-json)" || return $?
  python3 -c '
import json, sys
state = json.load(sys.stdin)
if state.get("state_kind") != "pending-pristine":
    raise SystemExit("repair is allowed only in exact pending-pristine state")
if state.get("OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING") != "0":
    raise SystemExit("repair requires the durably recorded stopped scheduler")
' <<<"$state_json"
  if [[ -e "$OPENCFD2606_CANARY_RECEIPT_FILE" || -L "$OPENCFD2606_CANARY_RECEIPT_FILE" ]]; then
    fail "Pending-cutover repair refuses a canary receipt of any kind." 14
    return $?
  fi
}

assert_app_and_env() {
  local expected_env_sha="$1" expected_app_real="$2" fields
  [[ -L "$APP_DIR" && "$(readlink -f "$APP_DIR")" == "$expected_app_real" ]] || {
    fail "APP_DIR moved during the pending-cutover repair." 14
    return $?
  }
  [[ "$(sha256_file "$ENV_FILE")" == "$expected_env_sha" ]] || {
    fail "The authoritative deployment environment changed during the pending-cutover repair." 14
    return $?
  }
  fields="$(python3 "$manifest_tool" --verify --root "$app_real" --manifest "$app_real/.deployment-source.json")" || return $?
  [[ "$fields" == "$bound_revision"$'\t'"$bound_tree"$'\t'"$bound_count" ]] || {
    fail "The bound deployment source changed during the pending-cutover repair." 14
    return $?
  }
  validate_pending_state
}

assert_scheduler_stopped() {
  if [[ -n "$(compose_bound ps --status running -q sweeper)" ]]; then
    fail "Pending-cutover repair requires the sweeper to remain stopped." 12
    return $?
  fi
}

assert_no_hidden_workers() {
  local service running hidden
  while IFS= read -r service; do
    [[ -n "$service" && "$service" != "worker" ]] || continue
    running="$(compose_bound --profile '*' ps --status running -q "$service")"
    if [[ -n "$running" ]]; then
      fail "Pending-cutover repair refuses running optional engine worker $service." 12
      return $?
    fi
  done < <(compose_bound --profile '*' config --services | awk '/^worker-/')
  hidden="$(docker ps \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --format '{{.Label "com.docker.compose.service"}}' \
    | awk '$0 ~ /^worker-/')"
  if [[ -n "$hidden" ]]; then
    fail "Pending-cutover repair refuses hidden running engine workers: $hidden" 12
    return $?
  fi
}

container_fingerprint() {
  local service="$1" id
  id="$(compose_bound ps --status running -q "$service")"
  if [[ -z "$id" || "$(wc -l <<<"$id")" -ne 1 ]]; then
    fail "Pending-cutover repair requires exactly one running $service container." 12
    return $?
  fi
  docker inspect --format '{{.Id}}|{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}' "$id"
}

engine_snapshot() {
  local api worker
  api="$(container_fingerprint api)" || return $?
  worker="$(container_fingerprint worker)" || return $?
  printf 'api=%s\nworker=%s\n' "$api" "$worker"
}

assert_no_openfoam_processes() {
  local output
  output="$(compose_bound exec -T worker sh -lc \
    'pgrep -af "[s]impleFoam|[p]impleFoam|[p]otentialFoam|[s]nappyHexMesh|[s]urfaceFeatureExtract|[b]lockMesh|[c]heckMesh|[d]ecomposePar|[r]econstructPar|[r]enumberMesh|[m]apFields|[p]ostProcess|[f]oamToVTK|[f]oamRun|[f]oamJob" || true')"
  if [[ -n "$output" ]]; then
    fail "Pending-cutover repair refuses active OpenFOAM work: $output" 12
    return $?
  fi
}

engine_health_snapshot() {
  local expected_build bucket prefix zstd remote_only
  expected_build="$(read_env_var ENGINE_EXPECTED_BUILD_ID)"
  bucket="$(read_env_var AIRFOILFOAM_EVIDENCE_BUCKET)"
  prefix="$(read_env_var AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX)"
  zstd="$(read_env_var AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL)"
  remote_only="$(read_env_var AIRFOILFOAM_EVIDENCE_REMOTE_ONLY)"
  curl -fsS --max-time 10 http://127.0.0.1:8000/health | python3 -c '
import json, sys
payload = json.load(sys.stdin)
expected_build, bucket, prefix, zstd, remote_only = sys.argv[1:]
engine = payload.get("default_engine") or {}
expected_engine = {
    "family": "openfoam", "distribution": "opencfd", "version": "2606",
    "numerics_revision": "1", "adapter_contract_version": 1,
}
actual_engine = {key: engine.get(key) for key in expected_engine}
expected_storage = {
    "backend": "gcs", "bucket": bucket, "object_prefix": prefix,
    "archive_format": "tar+zstd", "compression": "zstd",
    "zstd_level": int(zstd), "remote_only": remote_only.lower() == "true",
}
if payload.get("build_id") != expected_build or actual_engine != expected_engine:
    raise SystemExit("live engine identity/build differs from the bound cutover")
if payload.get("evidence_storage") != expected_storage:
    raise SystemExit("live engine evidence-storage contract differs from deployment state")
print(json.dumps({"buildId": expected_build, "engine": actual_engine, "evidenceStorage": expected_storage}, sort_keys=True, separators=(",", ":")))
' "$expected_build" "$bucket" "$prefix" "$zstd" "$remote_only"
}

engine_queue_snapshot() {
  curl -fsS --max-time 15 http://127.0.0.1:8000/queue | python3 -c '
import json, sys
p = json.load(sys.stdin)
for field in ("active_count", "reserved_count", "scheduled_count"):
    if p.get(field) != 0:
        raise SystemExit(f"engine queue is not idle: {field}={p.get(field)!r}")
if p.get("job_ids") not in ([], None) or p.get("inspection_errors") not in ({}, None):
    raise SystemExit("engine queue inspection reports work or errors")
if p.get("worker_queues_error") is not None or p.get("worker_runtime_error") is not None:
    raise SystemExit("engine worker queue/runtime advertisement is unavailable")
bindings = p.get("worker_queues")
if not isinstance(bindings, list) or len(bindings) != 1:
    raise SystemExit("expected exactly one live OpenCFD worker binding")
b = bindings[0]
expected_engine = {
    "family": "openfoam", "distribution": "opencfd", "version": "2606",
    "numerics_revision": "1", "adapter_contract_version": 1,
}
actual_engine = {key: (b.get("engine") or {}).get(key) for key in expected_engine}
if b.get("queues") != [sys.argv[1]] or b.get("execution_pool") != sys.argv[1] or actual_engine != expected_engine:
    raise SystemExit("live worker does not acknowledge the exact OpenCFD v2606 route/runtime")
print(json.dumps({"worker": b.get("worker"), "queues": b.get("queues"), "executionPool": b.get("execution_pool"), "engine": actual_engine}, sort_keys=True, separators=(",", ":")))
' "$OPENCFD_2606_ROUTE"
}

database_snapshot() {
  compose_bound exec -T postgres psql -U aerodb -d aerodb -X -v ON_ERROR_STOP=1 -Atc "
WITH target_impl AS (
  SELECT solver_implementation_id AS id
  FROM solver_execution_pools
  WHERE id = '$OPENCFD_2606_POOL_ID'
), target_cutovers AS (
  SELECT COALESCE(json_agg(json_build_object(
    'id', c.id,
    'status', c.status,
    'canaryAttestationId', c.canary_attestation_id,
    'targetPlanRevisionId', c.target_plan_revision_id,
    'finalizedAt', c.finalized_at,
    'completedAt', c.completed_at
  ) ORDER BY c.id), '[]'::json) AS rows
  FROM sim_campaign_solver_cutovers c
  WHERE c.to_solver_implementation_id = (SELECT id FROM target_impl)
)
SELECT json_build_object(
  'poolRows', (SELECT count(*) FROM solver_execution_pools WHERE id = '$OPENCFD_2606_POOL_ID'),
  'poolEnabled', (SELECT enabled FROM solver_execution_pools WHERE id = '$OPENCFD_2606_POOL_ID'),
  'cutovers', (SELECT rows FROM target_cutovers),
  'attestationCount', (SELECT count(*) FROM solver_engine_canary_attestations)
)::text;
" | python3 -c '
import json, sys
p = json.load(sys.stdin)
rows = p.get("cutovers")
if p.get("poolRows") != 1 or p.get("poolEnabled") is not False:
    raise SystemExit("OpenCFD v2606 execution pool is not uniquely disabled")
if p.get("attestationCount") != 0:
    raise SystemExit("a canary attestation already exists")
if not isinstance(rows, list) or len(rows) != 1:
    raise SystemExit("expected exactly one prepared target cutover")
row = rows[0]
if row.get("status") != "prepared" or any(row.get(key) is not None for key in ("canaryAttestationId", "targetPlanRevisionId", "finalizedAt", "completedAt")):
    raise SystemExit("target cutover has advanced beyond the prepared stage")
print(json.dumps(p, sort_keys=True, separators=(",", ":")))
'
}

assert_runtime_invariants() {
  local expected_env_sha="$1" expected_app_real="$2" expected_db="$3"
  local expected_engine="$4" expected_health="$5" expected_queue="$6"
  local actual
  assert_app_and_env "$expected_env_sha" "$expected_app_real" || return $?
  assert_scheduler_stopped || return $?
  assert_no_hidden_workers || return $?
  actual="$(database_snapshot)" || return $?
  [[ "$actual" == "$expected_db" ]] || { fail "Cutover database state changed during Node API repair." 14; return $?; }
  actual="$(engine_snapshot)" || return $?
  [[ "$actual" == "$expected_engine" ]] || { fail "Engine container/image identity changed during Node API repair." 12; return $?; }
  actual="$(engine_health_snapshot)" || return $?
  [[ "$actual" == "$expected_health" ]] || { fail "Engine health identity changed during Node API repair." 12; return $?; }
  actual="$(engine_queue_snapshot)" || return $?
  [[ "$actual" == "$expected_queue" ]] || { fail "Engine worker/queue identity changed during Node API repair." 12; return $?; }
  assert_no_openfoam_processes
}

validate_pending_state
env_sha_before="$(sha256_file "$ENV_FILE")"
app_real_before="$app_real"
assert_scheduler_stopped
assert_no_hidden_workers
database_before="$(database_snapshot)"
engine_before="$(engine_snapshot)"
health_before="$(engine_health_snapshot)"
queue_before="$(engine_queue_snapshot)"
assert_no_openfoam_processes

node_before="$(compose_bound ps --status running -q node-api)"
if [[ -z "$node_before" ]]; then
  fail "Pending-cutover repair requires the current Node API container to be healthy and running." 12
  exit $?
fi
node_before_image="$(docker inspect --format '{{.Image}}' "$node_before")"
node_image_ref="${COMPOSE_PROJECT_NAME}-node-api"
repair_image_tag="airfoils-pro/node-api-cutover-repair:${target_revision:0:12}"
rollback_image_tag="airfoils-pro/node-api-cutover-repair-rollback:${bound_revision:0:12}"

receipt_status=""
receipt_old_image=""
receipt_new_image=""
receipt_node_after=""

load_receipt() {
  local receipt_output
  if [[ ! -f "$REPAIR_RECEIPT_FILE" || -L "$REPAIR_RECEIPT_FILE" || \
        "$(stat -c '%a' "$REPAIR_RECEIPT_FILE")" != "600" || \
        "$(stat -c '%u' "$REPAIR_RECEIPT_FILE")" != "$(id -u)" ]]; then
    fail "Existing pending-cutover Node API journal is unsafe." 14
    return $?
  fi
  receipt_output="$(python3 - "$REPAIR_RECEIPT_FILE" \
    "$bound_revision" "$bound_tree" "$target_revision" "$target_tree" \
    "$source_change_digest" "$(sha256_text "$database_before")" \
    "$(sha256_text "$engine_before")" "$(sha256_text "$health_before")" \
    "$(sha256_text "$queue_before")" "$env_sha_before" <<'PY'
import json, re, sys
(
    path, bound_revision, bound_tree, target_revision, target_tree,
    change_digest, db_sha, engine_sha, health_sha, queue_sha, env_sha,
) = sys.argv[1:]
p = json.load(open(path, encoding="utf-8"))
required = {
    "schemaVersion": 1,
    "purpose": "pending-opencfd2606-node-api-timeout-repair",
    "boundSourceRevision": bound_revision,
    "boundSourceTreeSha256": bound_tree,
    "repairSourceRevision": target_revision,
    "repairSourceTreeSha256": target_tree,
    "sourceChangeSha256": change_digest,
    "databaseSnapshotSha256": db_sha,
    "engineSnapshotSha256": engine_sha,
    "engineHealthSha256": health_sha,
    "engineQueueSha256": queue_sha,
    "deploymentEnvironmentSha256": env_sha,
}
for key, value in required.items():
    if p.get(key) != value:
        raise SystemExit(f"repair journal mismatch: {key}")
if p.get("status") not in {"prepared", "applied"}:
    raise SystemExit("repair journal has an invalid lifecycle status")
for key in ("nodeApiImageBefore", "nodeApiImageAfter"):
    if not isinstance(p.get(key), str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", p[key]):
        raise SystemExit(f"repair journal has invalid {key}")
print(p["status"])
print(p["nodeApiImageBefore"])
print(p["nodeApiImageAfter"])
print(p.get("nodeApiContainerAfter") or "")
PY
  )" || return $?
  mapfile -t receipt_fields <<<"$receipt_output"
  receipt_status="${receipt_fields[0]}"
  receipt_old_image="${receipt_fields[1]}"
  receipt_new_image="${receipt_fields[2]}"
  receipt_node_after="${receipt_fields[3]:-}"
}

persist_receipt() {
  local status="$1" old_image="$2" new_image="$3" node_after="${4:-}"
  local temp
  temp="$(mktemp "$AIRFOILS_PRO_STATE_DIR/.pending-cutover-node-api-repair.XXXXXX")"
  chmod 600 "$temp"
  REPAIR_STATUS="$status" REPAIR_OLD_IMAGE="$old_image" REPAIR_NEW_IMAGE="$new_image" \
  REPAIR_NODE_AFTER="$node_after" REPAIR_DESTINATION="$REPAIR_RECEIPT_FILE" \
  REPAIR_BOUND_REVISION="$bound_revision" REPAIR_BOUND_TREE="$bound_tree" \
  REPAIR_TARGET_REVISION="$target_revision" REPAIR_TARGET_TREE="$target_tree" \
  REPAIR_CHANGE_DIGEST="$source_change_digest" REPAIR_CHANGE_PATHS="$source_change_paths_json" \
  REPAIR_ENV_SHA="$env_sha_before" REPAIR_APP_REAL="$app_real_before" \
  REPAIR_DB="$database_before" REPAIR_ENGINE="$engine_before" \
  REPAIR_HEALTH="$health_before" REPAIR_QUEUE="$queue_before" \
  REPAIR_NODE_BEFORE="$node_before" REPAIR_REPAIR_TAG="$repair_image_tag" \
  REPAIR_ROLLBACK_TAG="$rollback_image_tag" \
  python3 - "$temp" <<'PY'
import json, os, sys
from datetime import datetime, timezone
from pathlib import Path
import hashlib

def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()

destination = Path(os.environ["REPAIR_DESTINATION"])
status = os.environ["REPAIR_STATUS"]
now = datetime.now(timezone.utc).isoformat()
if status == "prepared":
    if os.path.lexists(destination):
        raise SystemExit("refusing to overwrite an existing repair journal")
    payload = {
        "schemaVersion": 1,
        "purpose": "pending-opencfd2606-node-api-timeout-repair",
        "status": "prepared",
        "preparedAt": now,
        "appliedAt": None,
        "boundSourceRevision": os.environ["REPAIR_BOUND_REVISION"],
        "boundSourceTreeSha256": os.environ["REPAIR_BOUND_TREE"],
        "repairSourceRevision": os.environ["REPAIR_TARGET_REVISION"],
        "repairSourceTreeSha256": os.environ["REPAIR_TARGET_TREE"],
        "sourceChangeSha256": os.environ["REPAIR_CHANGE_DIGEST"],
        "sourceChangePaths": json.loads(os.environ["REPAIR_CHANGE_PATHS"]),
        "deploymentEnvironmentSha256": os.environ["REPAIR_ENV_SHA"],
        "boundApplicationDirectory": os.environ["REPAIR_APP_REAL"],
        "databaseSnapshot": json.loads(os.environ["REPAIR_DB"]),
        "databaseSnapshotSha256": digest(os.environ["REPAIR_DB"]),
        "engineSnapshot": os.environ["REPAIR_ENGINE"].splitlines(),
        "engineSnapshotSha256": digest(os.environ["REPAIR_ENGINE"]),
        "engineHealth": json.loads(os.environ["REPAIR_HEALTH"]),
        "engineHealthSha256": digest(os.environ["REPAIR_HEALTH"]),
        "engineQueue": json.loads(os.environ["REPAIR_QUEUE"]),
        "engineQueueSha256": digest(os.environ["REPAIR_QUEUE"]),
        "nodeApiContainerBefore": os.environ["REPAIR_NODE_BEFORE"],
        "nodeApiImageBefore": os.environ["REPAIR_OLD_IMAGE"],
        "nodeApiImageAfter": os.environ["REPAIR_NEW_IMAGE"],
        "nodeApiContainerAfter": None,
        "repairImageTag": os.environ["REPAIR_REPAIR_TAG"],
        "rollbackImageTag": os.environ["REPAIR_ROLLBACK_TAG"],
    }
else:
    if not destination.is_file() or destination.is_symlink():
        raise SystemExit("prepared repair journal disappeared before commit")
    payload = json.loads(destination.read_text(encoding="utf-8"))
    if payload.get("status") != "prepared" or payload.get("nodeApiImageBefore") != os.environ["REPAIR_OLD_IMAGE"] or payload.get("nodeApiImageAfter") != os.environ["REPAIR_NEW_IMAGE"]:
        raise SystemExit("prepared repair journal changed before commit")
    payload["status"] = "applied"
    payload["appliedAt"] = now
    payload["nodeApiContainerAfter"] = os.environ["REPAIR_NODE_AFTER"]
path = Path(sys.argv[1])
with path.open("w", encoding="utf-8") as stream:
    json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
    stream.write("\n")
    stream.flush()
    os.fsync(stream.fileno())
PY
  mv -T "$temp" "$REPAIR_RECEIPT_FILE"
  python3 - "$AIRFOILS_PRO_STATE_DIR" <<'PY'
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

current_node_image() {
  local id
  id="$(compose_bound ps --status running -q node-api)"
  [[ -n "$id" ]] || return 0
  docker inspect --format '{{.Image}}' "$id"
}

wait_node_health() {
  local i
  for ((i = 1; i <= 90; i++)); do
    if curl -fsS --max-time 5 http://127.0.0.1:4000/health >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 12
}

ROLLBACK_ARMED=false
rollback_old_image=""
rollback_new_image=""
rollback_on_exit() {
  local rc=$?
  trap - EXIT
  if ((rc != 0)) && [[ "$ROLLBACK_ARMED" == "true" ]]; then
    set +e
    echo "Pending-cutover repair failed; restoring the exact prior Node API image." >&2
    docker image tag "$rollback_old_image" "$node_image_ref"
    current="$(current_node_image)"
    if [[ "$current" != "$rollback_old_image" ]]; then
      compose_bound up -d --no-deps --force-recreate node-api
    fi
    wait_node_health || echo "WARNING: prior Node API image could not be health-verified after rollback." >&2
  fi
  exit "$rc"
}
trap rollback_on_exit EXIT

if [[ -e "$REPAIR_RECEIPT_FILE" || -L "$REPAIR_RECEIPT_FILE" ]]; then
  load_receipt
  rollback_old_image="$receipt_old_image"
  rollback_new_image="$receipt_new_image"
  docker image inspect "$receipt_old_image" >/dev/null
  docker image inspect "$receipt_new_image" >/dev/null
  current="$(current_node_image)"
  if [[ "$receipt_status" == "applied" ]]; then
    [[ "$current" == "$receipt_new_image" ]] || { fail "Applied repair journal does not match the running Node API image." 14; exit $?; }
    [[ "$(docker image inspect --format '{{.Id}}' "$node_image_ref")" == "$receipt_new_image" ]] || { fail "Applied repair image is no longer the Compose Node API tag." 14; exit $?; }
    assert_runtime_invariants "$env_sha_before" "$app_real_before" "$database_before" "$engine_before" "$health_before" "$queue_before"
    echo "Pending-cutover Node API repair is already applied and all invariants still hold."
    ROLLBACK_ARMED=false
    exit 0
  fi
  if [[ -n "$current" && "$current" != "$receipt_old_image" && "$current" != "$receipt_new_image" ]]; then
    fail "Prepared repair journal does not match the running Node API image." 14
    exit $?
  fi
  docker image tag "$receipt_new_image" "$node_image_ref"
  ROLLBACK_ARMED=true
  new_image_id="$receipt_new_image"
  old_image_id="$receipt_old_image"
else
  [[ "$(docker image inspect --format '{{.Id}}' "$node_image_ref")" == "$node_before_image" ]] || {
    fail "Compose Node API tag no longer matches the running bound image." 14
    exit $?
  }
  compose_target config >/dev/null
  echo "Building the reviewed pending-cutover Node API repair..."
  old_image_id="$node_before_image"
  rollback_old_image="$old_image_id"
  ROLLBACK_ARMED=true
  # Build under the immutable incident tag first.  The Compose tag continues
  # to point at the running bound image until the prepared journal is fsynced,
  # eliminating an unjournaled crash window between build and swap.
  docker build \
    --file "$staging_real/docker/Dockerfile.node" \
    --tag "$repair_image_tag" \
    "$staging_real"
  new_image_id="$(docker image inspect --format '{{.Id}}' "$repair_image_tag")"
  if [[ "$new_image_id" == "$old_image_id" || ! "$new_image_id" =~ ^sha256:[0-9a-f]{64}$ || ! "$old_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    fail "Pending-cutover repair did not produce distinct, valid Node image identities." 12
    exit $?
  fi
  docker image tag "$old_image_id" "$rollback_image_tag"
  rollback_new_image="$new_image_id"
  assert_runtime_invariants "$env_sha_before" "$app_real_before" "$database_before" "$engine_before" "$health_before" "$queue_before"
  persist_receipt prepared "$old_image_id" "$new_image_id"
  docker image tag "$new_image_id" "$node_image_ref"
fi

current="$(current_node_image)"
if [[ "$current" != "$new_image_id" ]]; then
  compose_target up -d --no-deps --force-recreate node-api
fi
wait_node_health
node_after="$(compose_target ps --status running -q node-api)"
if [[ -z "$node_after" || "$(docker inspect --format '{{.Image}}' "$node_after")" != "$new_image_id" ]]; then
  fail "Repaired Node API container does not run the journaled repair image." 12
  exit $?
fi
container_api_sha="$(docker exec "$node_after" sha256sum /app/apps/api/src/admin-routes.ts | awk '{print $1}')"
if [[ "$container_api_sha" != "$EXPECTED_REPAIR_API_SHA256" || \
      "$(docker image inspect --format '{{.Id}}' "$node_image_ref")" != "$new_image_id" || \
      "$(docker image inspect --format '{{.Id}}' "$repair_image_tag")" != "$new_image_id" ]]; then
  fail "Repaired Node API runtime/tag does not match the reviewed image contract." 12
  exit $?
fi

assert_runtime_invariants "$env_sha_before" "$app_real_before" "$database_before" "$engine_before" "$health_before" "$queue_before"
persist_receipt applied "$old_image_id" "$new_image_id" "$node_after"
ROLLBACK_ARMED=false
trap - EXIT

echo "Pending-cutover Node API repair is healthy and durably journaled."
echo "Bound release remains $bound_revision ($bound_tree; $bound_count files)."
echo "Temporary Node API repair source is $target_revision ($target_tree; $target_count files)."
echo "The scheduler remains stopped, the target pool remains disabled, and engine containers/images are unchanged."
