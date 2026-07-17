#!/usr/bin/env bash
# Incident-specific replay for the 2026-07-17 OpenCFD v2606 cutover.
#
# The sealed 6338577 release already runs the intended 2606 engine, and the
# first staged repair installed the reviewed Node API 15-second pool-handshake
# timeout. A first replay then exposed the matching five-second engine /queue
# probe; the exact r2 retry fixed that probe, rebuilt the engine, and stopped at
# the canary/Node attestation contract without advancing the cutover. This
# wrapper admits exactly the reviewed queue, canary, and attestation repairs,
# installs the required second Node image transactionally, and keeps every
# engine build input bound to sealed 6338577.
set -Eeuo pipefail

STAGING_DIR="${STAGING_DIR:?STAGING_DIR is required}"
EXPECTED_TARGET_SOURCE_REVISION="${EXPECTED_TARGET_SOURCE_REVISION:?EXPECTED_TARGET_SOURCE_REVISION is required}"

# Exact production incident identity. This is deliberately not reusable for a
# later release, receipt, build, or cutover.
EXPECTED_BOUND_SOURCE_REVISION="63385777be7323777906fde44bdb9fa9b5cc0d6d"
EXPECTED_BOUND_SOURCE_TREE_SHA256="52c8bd3aa6d5a05dcd70a90d8896fb771f7fc36d129e698be0c935680e3fff36"
EXPECTED_BOUND_SOURCE_FILE_COUNT="2198"
EXPECTED_APP_LINK="/opt/airfoils-pro/app"
EXPECTED_BOUND_APP_REAL="/opt/airfoils-pro/releases/63385777be7323777906fde44bdb9fa9b5cc0d6d-52c8bd3aa6d5a05d"
EXPECTED_STATE_DIR="/opt/airfoils-pro/state"
EXPECTED_ENV_FILE="/opt/airfoils-pro/state/.env.deploy"
EXPECTED_CANONICAL_LOCK_FILE="/tmp/airfoils-pro-deploy.lock"
EXPECTED_COMPOSE_PROJECT_NAME="app"
EXPECTED_BUILD_ID="prod-20260717-63385777be73-r2"
EXPECTED_NODE_REPAIR_RECEIPT_SHA256="1f57f0e664682c22812de55de3be2ff58e205dd11a9eb6a1bd2c1a08545e0c92"
EXPECTED_NODE_REPAIR_SOURCE_REVISION="26b19c9a6f229d76359095958a3a6d8edac0801f"
EXPECTED_NODE_REPAIR_SOURCE_TREE_SHA256="3f1631f275119fa1d316ecae8d9fe340b91b6f64f27b907780ea7ea1445632dd"
EXPECTED_NODE_REPAIR_CHANGE_SHA256="1d0f14d1f7d6795ebf108b6c61ebb9e6bde814a0bc37c6850693853b5d4400d3"
EXPECTED_FIRST_NODE_REPAIR_ENV_SHA256="6891290db1f293b1e4bfca62eacf588b1ad8c110d238ffdcfcd6a952d35eda8c"
EXPECTED_DEPLOY_ENV_SHA256="c4ff073a4ee698a02cdc70f535f930c93898b69e5f382bf6ac05f965b840acad"
EXPECTED_NODE_IMAGE="sha256:64ee90e0045a36eace3c57aeb5b3467c1e1f46c5eafb2466b98f8b754cbade32"
EXPECTED_API_IMAGE="sha256:bc8e23648e9e76424ea36a584f8a825d65fe82a23aa4e4ad89b019197dcc735c"
EXPECTED_WORKER_IMAGE="sha256:42120ef817af19510830d18f99be2b0f8d8739a4b9b235d2ee294e558f64229a"
EXPECTED_FAILED_RESUME_JOURNAL_SHA256="4c3c1476f19ae1d6352d5130bd91e8870db41869805cabde52eaf0cfe34d1a9d"
EXPECTED_FAILED_RESUME_REBUILD_SHA256="515e81d52d59d2e4e798daf1bdaf2ff5e51e45cc5c3708d41af20130c2364021"
EXPECTED_FAILED_RESUME_RUNNER_REVISION="dfecaca2d35ac655aa647367b4a8b06744a63284"
EXPECTED_FAILED_RESUME_RUNNER_TREE_SHA256="080fecf211c1e8e623860647bca2cc19e3daaeb8a869f958fc7b7132ca6f7a03"
EXPECTED_NODE_API_SHA256="e3e1782f0517ea29e451fd89661a1a54f982673cd62ad5502e5d45eaaa6a94f4"
EXPECTED_NODE_API_TEST_SHA256="bbc75aa6c6f0d4cca18f051fd1d06d89750c951d625ccd57031fd1a0b3c00e29"
# Updated when the reviewed all-members restore-verification attestation patch
# is sealed.  The replay image must expose both exact source files at runtime.
EXPECTED_NODE_ATTESTATION_SHA256="6f10619510378451e47e8aaa6579e663b879e47ce0af98097680c2b4462ddc62"
EXPECTED_NODE_ATTESTATION_TEST_SHA256="6046af2febe268060afcf7eff386a99ab5c6d0930e5eea2d70f10a715805b65b"
EXPECTED_CANARY_SHA256="df6f7558e3d53e1f7fd6158c171d02a1d62fe74ce721eb6cdb0132e6efff8f48"
EXPECTED_CANARY_TEST_SHA256="9324e40c112e662fa78cbcd7b1bb782b23f439150f59618f1119faf26d50034a"
EXPECTED_NODE_REPAIR_SCRIPT_SHA256="46507dc7a3dbb7e8496eed41be0fac1a493d34d27fb28a22e420f21979dfabd8"
EXPECTED_NODE_REPAIR_TEST_SHA256="75fa17d3062d397f890e75fde1a1396d445570f8ef6202dd951e5f6187a8f623"
EXPECTED_BOUND_REBUILD_SHA256="21ebcec16a0bdcc0f525bc8a82f2cf953497aa7332ce0e2091679826437ebc80"
EXPECTED_REPLAY_REBUILD_SHA256="008b8d8e92493b33eb7888b3dd6651696c512eddba377ee342b03dca6f51441f"
EXPECTED_REBUILD_TEST_SHA256="a586e62b2a406659b396c47968c09c8fc9e6974b56c035090c06dd4a7ae41f23"
EXPECTED_REPLAY_TEST_SHA256="4f3655a1e5f6974b720ba9668eaac003ed93cd965500ea2d06da6e3275a20973"
EXPECTED_DATABASE_SHA256="8421c15692afc6e36a834e481734411db61ecf18a95ce4db3a46ec9c7f7ad96c"
OPENCFD_2606_POOL_ID="3f8bc764-09ae-4ff3-8fd2-260600000001"
OPENCFD_2606_ROUTE="openfoam-opencfd-2606"
MAINTENANCE_COOKIE_TTL_MS="14400000"

# These paths are part of the authorized incident contract, not normal
# operator inputs. Reject overrides instead of silently validating one path
# and executing against another.
if [[ "${APP_DIR:-$EXPECTED_APP_LINK}" != "$EXPECTED_APP_LINK" || \
      "${AIRFOILS_PRO_STATE_DIR:-$EXPECTED_STATE_DIR}" != "$EXPECTED_STATE_DIR" || \
      "${ENV_FILE:-$EXPECTED_ENV_FILE}" != "$EXPECTED_ENV_FILE" || \
      "${LOCK_FILE:-$EXPECTED_CANONICAL_LOCK_FILE}" != "$EXPECTED_CANONICAL_LOCK_FILE" || \
      "${COMPOSE_PROJECT_NAME:-$EXPECTED_COMPOSE_PROJECT_NAME}" != "$EXPECTED_COMPOSE_PROJECT_NAME" ]]; then
  echo "Pending 2606 rebuild replay refuses caller overrides of bound application, state, lock, or Compose paths." >&2
  exit 2
fi
APP_DIR="$EXPECTED_APP_LINK"
AIRFOILS_PRO_STATE_DIR="$EXPECTED_STATE_DIR"
ENV_FILE="$EXPECTED_ENV_FILE"
CANONICAL_LOCK_FILE="$EXPECTED_CANONICAL_LOCK_FILE"
COMPOSE_PROJECT_NAME="$EXPECTED_COMPOSE_PROJECT_NAME"
NODE_REPAIR_RECEIPT_FILE="$AIRFOILS_PRO_STATE_DIR/pending-cutover-node-api-repair.json"
FAILED_RESUME_JOURNAL_FILE="$AIRFOILS_PRO_STATE_DIR/pending-cutover-queue-probe-resume.json"
OPENCFD2606_CANARY_RECEIPT_FILE="$AIRFOILS_PRO_STATE_DIR/openfoam-2606-canary-receipt.pending.json"
REPLAY_JOURNAL_FILE="$AIRFOILS_PRO_STATE_DIR/pending-opencfd2606-rebuild-replay.json"

runtime_dir=""
ROLLBACK_ARMED=false
FAILURE_JOURNAL_ARMED=false
rollback_old_image=""
rollback_new_image=""
node_image_ref="${COMPOSE_PROJECT_NAME}-node-api"
cleanup() {
  local rc=$?
  trap - EXIT
  if ((rc != 0)) && [[ "$ROLLBACK_ARMED" == "true" ]]; then
    set +e
    echo "Pending 2606 rebuild replay failed before the replacement Node API was certified; restoring the exact prior Node image." >&2
    if rollback_node_api; then
      persist_replay_journal rolled_back "" || \
        echo "WARNING: prior Node API was restored, but the replay journal could not be marked rolled_back." >&2
    else
      echo "WARNING: prior Node API could not be health-verified after rollback; the prepared replay journal remains authoritative." >&2
    fi
    set -e
  elif ((rc != 0)) && [[ "$FAILURE_JOURNAL_ARMED" == "true" ]]; then
    set +e
    persist_replay_journal failed "" "$rc" || \
      echo "WARNING: replacement Node API remains applied, but the replay journal could not record the child failure." >&2
    set -e
  fi
  if [[ -n "$runtime_dir" && -d "$runtime_dir" && ! -L "$runtime_dir" ]]; then
    rm -rf -- "$runtime_dir"
  fi
  exit "$rc"
}
trap cleanup EXIT
umask 077

fail() {
  echo "$1" >&2
  return "${2:-12}"
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

read_env_var() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

persist_replay_journal() {
  local status="$1" state_kind="${2:-}" exit_code="${3:-}"
  local current_env_sha current_api_image current_worker_image current_database_sha current_receipt_sha current_state_kind
  current_env_sha="$(sha256_file "$ENV_FILE" 2>/dev/null || true)"
  current_api_image="$(service_image_if_running api 2>/dev/null || true)"
  current_worker_image="$(service_image_if_running worker 2>/dev/null || true)"
  current_database_sha="$(database_snapshot_sha 2>/dev/null || true)"
  if [[ -f "$OPENCFD2606_CANARY_RECEIPT_FILE" && ! -L "$OPENCFD2606_CANARY_RECEIPT_FILE" ]]; then
    current_receipt_sha="$(sha256_file "$OPENCFD2606_CANARY_RECEIPT_FILE" 2>/dev/null || true)"
  else
    current_receipt_sha="absent"
  fi
  current_state_kind="$(cutover_state_kind 2>/dev/null || true)"
  if [[ ! "$current_env_sha" =~ ^[0-9a-f]{64}$ || \
        ! "$current_api_image" =~ ^sha256:[0-9a-f]{64}$ || \
        ! "$current_worker_image" =~ ^sha256:[0-9a-f]{64}$ || \
        ! "$current_database_sha" =~ ^[0-9a-f]{64}$ || \
        ! "$current_state_kind" =~ ^(pending-pristine|pending-receipt|pending-unmarked-receipt|pending-attested|pending-attested-retained-receipt|terminal)$ || \
        ! "$current_receipt_sha" =~ ^(absent|[0-9a-f]{64})$ ]]; then
    fail "Cannot persist replay lifecycle without a complete exact runtime/state binding." 14
    return $?
  fi
  if [[ "$current_state_kind" =~ receipt$ && "$current_receipt_sha" == "absent" ]] || \
     [[ ! "$current_state_kind" =~ receipt$ && "$current_receipt_sha" != "absent" ]]; then
    fail "Cannot persist replay lifecycle with a receipt/state binding mismatch." 14
    return $?
  fi
  REPLAY_STATUS="$status" REPLAY_STATE_KIND="$state_kind" \
  REPLAY_EXIT_CODE="$exit_code" REPLAY_CURRENT_ENV_SHA="$current_env_sha" \
  REPLAY_CURRENT_API_IMAGE="$current_api_image" REPLAY_CURRENT_WORKER_IMAGE="$current_worker_image" \
  REPLAY_CURRENT_DATABASE_SHA="$current_database_sha" \
  REPLAY_CURRENT_RECEIPT_SHA="$current_receipt_sha" REPLAY_CURRENT_STATE_KIND="$current_state_kind" \
  REPLAY_JOURNAL_FILE="$REPLAY_JOURNAL_FILE" \
  REPLAY_BOUND_REVISION="$EXPECTED_BOUND_SOURCE_REVISION" \
  REPLAY_BOUND_TREE="$EXPECTED_BOUND_SOURCE_TREE_SHA256" \
  REPLAY_TARGET_REVISION="$target_revision" REPLAY_TARGET_TREE="$target_tree" \
  REPLAY_BUILD_ID="$EXPECTED_BUILD_ID" REPLAY_RECEIPT_SHA="$EXPECTED_NODE_REPAIR_RECEIPT_SHA256" \
  REPLAY_NODE_IMAGE_BEFORE="$node_image_before" REPLAY_NODE_IMAGE_AFTER="$node_image_after" \
  REPLAY_NODE_CONTAINER_BEFORE="$node_container_before" \
  REPLAY_NODE_CONTAINER_AFTER="${node_container_after:-}" \
  REPLAY_NODE_REPAIR_TAG="$replay_node_image_tag" REPLAY_NODE_ROLLBACK_TAG="$rollback_node_image_tag" \
  REPLAY_NODE_API_SHA="$EXPECTED_NODE_API_SHA256" \
  REPLAY_NODE_ATTESTATION_SHA="$EXPECTED_NODE_ATTESTATION_SHA256" \
  REPLAY_ENV_SHA="$EXPECTED_DEPLOY_ENV_SHA256" \
  EXPECTED_ENV_FILE_FOR_JOURNAL="$ENV_FILE" \
  python3 - <<'PY'
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile

path = Path(os.environ["REPLAY_JOURNAL_FILE"])
status = os.environ["REPLAY_STATUS"]
now = datetime.now(timezone.utc).isoformat()
if status == "prepared":
    if os.path.lexists(path):
        raise SystemExit("refusing to overwrite an existing rebuild replay journal")
    payload = {
        "schemaVersion": 1,
        "purpose": "pending-opencfd2606-same-build-replay",
        "status": "prepared",
        "preparedAt": now,
        "completedAt": None,
        "boundSourceRevision": os.environ["REPLAY_BOUND_REVISION"],
        "boundSourceTreeSha256": os.environ["REPLAY_BOUND_TREE"],
        "replaySourceRevision": os.environ["REPLAY_TARGET_REVISION"],
        "replaySourceTreeSha256": os.environ["REPLAY_TARGET_TREE"],
        "buildId": os.environ["REPLAY_BUILD_ID"],
        "nodeRepairReceiptSha256": os.environ["REPLAY_RECEIPT_SHA"],
        "nodeApiContainerBefore": os.environ["REPLAY_NODE_CONTAINER_BEFORE"],
        "nodeApiContainerAfter": None,
        "nodeApiImageBefore": os.environ["REPLAY_NODE_IMAGE_BEFORE"],
        "nodeApiImageAfter": os.environ["REPLAY_NODE_IMAGE_AFTER"],
        "nodeApiRepairTag": os.environ["REPLAY_NODE_REPAIR_TAG"],
        "nodeApiRollbackTag": os.environ["REPLAY_NODE_ROLLBACK_TAG"],
        "nodeApiAdminRoutesSha256": os.environ["REPLAY_NODE_API_SHA"],
        "nodeApiAttestationSha256": os.environ["REPLAY_NODE_ATTESTATION_SHA"],
        "deploymentEnvironmentBeforeSha256": os.environ["REPLAY_ENV_SHA"],
        "deploymentEnvironmentAfterSha256": None,
        "cutoverStateKind": None,
        "currentDeploymentEnvironmentSha256": os.environ["REPLAY_CURRENT_ENV_SHA"],
        "currentApiImage": os.environ["REPLAY_CURRENT_API_IMAGE"],
        "currentWorkerImage": os.environ["REPLAY_CURRENT_WORKER_IMAGE"],
        "currentDatabaseSnapshotSha256": os.environ["REPLAY_CURRENT_DATABASE_SHA"],
        "currentCanaryReceiptSha256": os.environ["REPLAY_CURRENT_RECEIPT_SHA"],
        "currentCutoverStateKind": os.environ["REPLAY_CURRENT_STATE_KIND"],
        "failureCount": 0,
        "lastExitCode": None,
    }
elif status == "node_applied":
    if not path.is_file() or path.is_symlink():
        raise SystemExit("prepared rebuild replay journal disappeared before Node commit")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("status") not in {"prepared", "rolled_back", "node_applied", "failed"}:
        raise SystemExit("rebuild replay journal cannot accept the Node repair stage")
    payload["status"] = "node_applied"
    payload["nodeAppliedAt"] = payload.get("nodeAppliedAt") or now
    payload["nodeApiContainerAfter"] = os.environ["REPLAY_NODE_CONTAINER_AFTER"]
    payload["currentDeploymentEnvironmentSha256"] = os.environ["REPLAY_CURRENT_ENV_SHA"]
    payload["currentApiImage"] = os.environ["REPLAY_CURRENT_API_IMAGE"]
    payload["currentWorkerImage"] = os.environ["REPLAY_CURRENT_WORKER_IMAGE"]
    payload["currentDatabaseSnapshotSha256"] = os.environ["REPLAY_CURRENT_DATABASE_SHA"]
    payload["currentCanaryReceiptSha256"] = os.environ["REPLAY_CURRENT_RECEIPT_SHA"]
    payload["currentCutoverStateKind"] = os.environ["REPLAY_CURRENT_STATE_KIND"]
elif status == "completed":
    if not path.is_file() or path.is_symlink():
        raise SystemExit("prepared rebuild replay journal disappeared")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("status") not in {"node_applied", "failed"} or payload.get("buildId") != os.environ["REPLAY_BUILD_ID"]:
        raise SystemExit("prepared rebuild replay journal changed before completion")
    payload["status"] = "completed"
    payload["completedAt"] = now
    payload["nodeApiContainerAfter"] = os.environ["REPLAY_NODE_CONTAINER_AFTER"]
    payload["deploymentEnvironmentAfterSha256"] = __import__("hashlib").sha256(
        Path(os.environ["EXPECTED_ENV_FILE_FOR_JOURNAL"]).read_bytes()
    ).hexdigest()
    payload["cutoverStateKind"] = os.environ["REPLAY_STATE_KIND"]
    payload["currentDeploymentEnvironmentSha256"] = os.environ["REPLAY_CURRENT_ENV_SHA"]
    payload["currentApiImage"] = os.environ["REPLAY_CURRENT_API_IMAGE"]
    payload["currentWorkerImage"] = os.environ["REPLAY_CURRENT_WORKER_IMAGE"]
    payload["currentDatabaseSnapshotSha256"] = os.environ["REPLAY_CURRENT_DATABASE_SHA"]
    payload["currentCanaryReceiptSha256"] = os.environ["REPLAY_CURRENT_RECEIPT_SHA"]
    payload["currentCutoverStateKind"] = os.environ["REPLAY_CURRENT_STATE_KIND"]
elif status == "failed":
    if not path.is_file() or path.is_symlink():
        raise SystemExit("rebuild replay journal disappeared before failure capture")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("status") not in {"node_applied", "failed"}:
        raise SystemExit("rebuild replay failure occurred before the Node repair was committed")
    payload["status"] = "failed"
    payload["failedAt"] = now
    payload["failureCount"] = int(payload.get("failureCount") or 0) + 1
    payload["lastExitCode"] = int(os.environ["REPLAY_EXIT_CODE"])
    payload["nodeApiContainerAfter"] = os.environ["REPLAY_NODE_CONTAINER_AFTER"]
    payload["currentDeploymentEnvironmentSha256"] = os.environ["REPLAY_CURRENT_ENV_SHA"]
    payload["currentApiImage"] = os.environ["REPLAY_CURRENT_API_IMAGE"]
    payload["currentWorkerImage"] = os.environ["REPLAY_CURRENT_WORKER_IMAGE"]
    payload["currentDatabaseSnapshotSha256"] = os.environ["REPLAY_CURRENT_DATABASE_SHA"]
    payload["currentCanaryReceiptSha256"] = os.environ["REPLAY_CURRENT_RECEIPT_SHA"]
    payload["currentCutoverStateKind"] = os.environ["REPLAY_CURRENT_STATE_KIND"]
elif status == "rolled_back":
    if not path.is_file() or path.is_symlink():
        raise SystemExit("prepared rebuild replay journal disappeared before rollback")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if (
        payload.get("status") not in {"prepared", "node_applied"}
        or payload.get("nodeApiImageBefore") != os.environ["REPLAY_NODE_IMAGE_BEFORE"]
        or payload.get("nodeApiImageAfter") != os.environ["REPLAY_NODE_IMAGE_AFTER"]
    ):
        raise SystemExit("prepared rebuild replay journal changed before rollback")
    payload["status"] = "rolled_back"
    payload["rolledBackAt"] = now
    payload["nodeApiContainerAfter"] = os.environ["REPLAY_NODE_CONTAINER_AFTER"] or None
    payload["currentDeploymentEnvironmentSha256"] = os.environ["REPLAY_CURRENT_ENV_SHA"]
    payload["currentApiImage"] = os.environ["REPLAY_CURRENT_API_IMAGE"]
    payload["currentWorkerImage"] = os.environ["REPLAY_CURRENT_WORKER_IMAGE"]
    payload["currentDatabaseSnapshotSha256"] = os.environ["REPLAY_CURRENT_DATABASE_SHA"]
    payload["currentCanaryReceiptSha256"] = os.environ["REPLAY_CURRENT_RECEIPT_SHA"]
    payload["currentCutoverStateKind"] = os.environ["REPLAY_CURRENT_STATE_KIND"]
else:
    raise SystemExit(f"unsupported replay journal status: {status}")

fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PY
}

require_regular_owned_mode() {
  local path="$1" mode="$2" label="$3"
  if [[ ! -f "$path" || -L "$path" || "$(stat -c '%a' "$path")" != "$mode" || "$(stat -c '%u' "$path")" != "$(id -u)" ]]; then
    fail "$label must be a same-owner, mode-$mode regular file: $path" 14
    return $?
  fi
}

if [[ ! "$EXPECTED_TARGET_SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Pending 2606 rebuild replay requires an exact lowercase target commit SHA." 2
  exit $?
fi
if [[ ! -d "$STAGING_DIR" || -L "$STAGING_DIR" || ! -L "$APP_DIR" ]]; then
  fail "Pending 2606 rebuild replay requires a real staging directory and the versioned APP_DIR symlink." 2
  exit $?
fi
staging_real="$(realpath "$STAGING_DIR")"
app_real="$(readlink -f "$APP_DIR")"
if [[ ! -d "$app_real" || -L "$app_real" || "$app_real" != "$EXPECTED_BOUND_APP_REAL" || "$staging_real" == "$app_real" ]]; then
  fail "Pending 2606 rebuild replay is not attached to the exact sealed production release." 14
  exit $?
fi
if [[ ! -d "$AIRFOILS_PRO_STATE_DIR" || -L "$AIRFOILS_PRO_STATE_DIR" || ! -d /dev/shm || -L /dev/shm ]]; then
  fail "Pending 2606 rebuild replay requires safe state and in-memory runtime directories." 2
  exit $?
fi

# Hold the canonical exclusion lock throughout validation, cookie generation,
# and the synchronous child rebuild. The child uses a private lock file, so it
# can retain rebuild-engine.sh's own lock contract without self-deadlocking.
exec 8>"$CANONICAL_LOCK_FILE"
flock -n 8 || {
  echo "Another Airfoils.Pro deploy or engine maintenance action is running." >&2
  exit 9
}

manifest_tool="$app_real/scripts/deploy/deployment-source-manifest.py"
state_tool="$app_real/scripts/deploy/opencfd2606_cutover_state.py"
preflight_tool="$app_real/scripts/deploy/deployment-env-preflight.py"
bound_compose="$app_real/docker-compose.deploy.yml"
for required in "$manifest_tool" "$state_tool" "$preflight_tool" "$bound_compose" "$app_real/.deployment-source.json" "$staging_real/.deployment-source.json"; do
  if [[ ! -f "$required" || -L "$required" ]]; then
    fail "Pending 2606 rebuild replay lacks a required sealed regular file: $required" 2
    exit $?
  fi
done
require_regular_owned_mode "$ENV_FILE" 600 "Deployment environment"
require_regular_owned_mode "$NODE_REPAIR_RECEIPT_FILE" 600 "Applied Node repair receipt"
require_regular_owned_mode "$FAILED_RESUME_JOURNAL_FILE" 600 "Failed queue-probe replay journal"
if [[ "$(sha256_file "$FAILED_RESUME_JOURNAL_FILE")" != "$EXPECTED_FAILED_RESUME_JOURNAL_SHA256" ]]; then
  fail "The prior failed queue-probe replay journal is not the exact incident record authorized for this recovery." 14
  exit $?
fi
python3 - "$FAILED_RESUME_JOURNAL_FILE" \
  "$EXPECTED_BOUND_SOURCE_REVISION" "$EXPECTED_BUILD_ID" \
  "$EXPECTED_FAILED_RESUME_REBUILD_SHA256" "$EXPECTED_FAILED_RESUME_RUNNER_REVISION" \
  "$EXPECTED_FAILED_RESUME_RUNNER_TREE_SHA256" <<'PY'
import json
from pathlib import Path
import sys

p = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
expected = {
    "schemaVersion": 1,
    "purpose": "pending-opencfd2606-queue-probe-resume",
    "status": "failed",
    "exitCode": 14,
    "boundSourceRevision": sys.argv[2],
    "buildId": sys.argv[3],
    "rebuildScriptSha256": sys.argv[4],
    "runnerSourceRevision": sys.argv[5],
    "runnerSourceTreeSha256": sys.argv[6],
}
for key, value in expected.items():
    if p.get(key) != value:
        raise SystemExit(f"failed queue-probe replay journal mismatch: {key}")
allowed = set(expected) | {"updatedAt"}
if set(p) != allowed or not isinstance(p.get("updatedAt"), str):
    raise SystemExit("failed queue-probe replay journal has unexpected fields")
PY
existing_replay_status=""
if [[ -e "$REPLAY_JOURNAL_FILE" || -L "$REPLAY_JOURNAL_FILE" ]]; then
  require_regular_owned_mode "$REPLAY_JOURNAL_FILE" 600 "Pending 2606 rebuild replay journal"
  existing_replay_status="$(python3 - "$REPLAY_JOURNAL_FILE" <<'PY'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
if p.get("schemaVersion") != 1 or p.get("purpose") != "pending-opencfd2606-same-build-replay" or p.get("status") not in {"prepared", "node_applied", "failed", "completed", "rolled_back"}:
    raise SystemExit("existing replay journal has an invalid contract")
print(p["status"])
PY
)" || exit $?
fi

python3 "$preflight_tool" \
  --app-dir "$APP_DIR" \
  --state-dir "$AIRFOILS_PRO_STATE_DIR" \
  --env-file "$ENV_FILE" \
  >/dev/null

IFS=$'\t' read -r bound_revision bound_tree bound_count < <(
  python3 "$manifest_tool" --verify --root "$app_real" --manifest "$app_real/.deployment-source.json"
)
IFS=$'\t' read -r target_revision target_tree target_count < <(
  python3 "$manifest_tool" --verify --root "$staging_real" --manifest "$staging_real/.deployment-source.json"
)
if [[ "$bound_revision" != "$EXPECTED_BOUND_SOURCE_REVISION" || \
      "$bound_tree" != "$EXPECTED_BOUND_SOURCE_TREE_SHA256" || \
      "$bound_count" != "$EXPECTED_BOUND_SOURCE_FILE_COUNT" ]]; then
  fail "Pending 2606 rebuild replay found an unexpected bound release." 14
  exit $?
fi
if [[ "$target_revision" != "$EXPECTED_TARGET_SOURCE_REVISION" || \
      "$target_revision" == "$bound_revision" || \
      "$target_revision" == "$EXPECTED_NODE_REPAIR_SOURCE_REVISION" ]]; then
  fail "Pending 2606 rebuild replay target does not match the explicit new dispatch revision." 14
  exit $?
fi
replay_node_image_tag="airfoils-pro/node-api-cutover-replay:${target_revision:0:12}"
rollback_node_image_tag="airfoils-pro/node-api-cutover-replay-rollback:${target_revision:0:12}"
expected_current_env_sha="$EXPECTED_DEPLOY_ENV_SHA256"
expected_current_api_image="$EXPECTED_API_IMAGE"
expected_current_worker_image="$EXPECTED_WORKER_IMAGE"
expected_current_database_sha="$EXPECTED_DATABASE_SHA256"
expected_current_receipt_sha="absent"
expected_current_state_kind="pending-pristine"
node_image_before="$EXPECTED_NODE_IMAGE"
node_image_after=""
node_container_before=""
node_container_after=""

if [[ -n "$existing_replay_status" ]]; then
  replay_binding="$(python3 - "$REPLAY_JOURNAL_FILE" \
    "$EXPECTED_BOUND_SOURCE_REVISION" "$EXPECTED_BOUND_SOURCE_TREE_SHA256" \
    "$target_revision" "$target_tree" "$EXPECTED_BUILD_ID" \
    "$EXPECTED_NODE_REPAIR_RECEIPT_SHA256" "$EXPECTED_NODE_IMAGE" \
    "$replay_node_image_tag" "$rollback_node_image_tag" \
    "$EXPECTED_NODE_API_SHA256" "$EXPECTED_NODE_ATTESTATION_SHA256" \
    "$EXPECTED_DEPLOY_ENV_SHA256" <<'PY'
import json
from pathlib import Path
import re
import sys

p = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
expected = {
    "schemaVersion": 1,
    "purpose": "pending-opencfd2606-same-build-replay",
    "boundSourceRevision": sys.argv[2],
    "boundSourceTreeSha256": sys.argv[3],
    "replaySourceRevision": sys.argv[4],
    "replaySourceTreeSha256": sys.argv[5],
    "buildId": sys.argv[6],
    "nodeRepairReceiptSha256": sys.argv[7],
    "nodeApiImageBefore": sys.argv[8],
    "nodeApiRepairTag": sys.argv[9],
    "nodeApiRollbackTag": sys.argv[10],
    "nodeApiAdminRoutesSha256": sys.argv[11],
    "nodeApiAttestationSha256": sys.argv[12],
    "deploymentEnvironmentBeforeSha256": sys.argv[13],
}
for key, value in expected.items():
    if p.get(key) != value:
        raise SystemExit(f"rebuild replay journal mismatch: {key}")
if p.get("status") not in {"prepared", "node_applied", "failed", "completed", "rolled_back"}:
    raise SystemExit("rebuild replay journal has an invalid status")
sha = re.compile(r"sha256:[0-9a-f]{64}")
hex64 = re.compile(r"[0-9a-f]{64}")
if not sha.fullmatch(p.get("nodeApiImageAfter") or ""):
    raise SystemExit("rebuild replay journal has an invalid replacement Node image")
for key in ("currentDeploymentEnvironmentSha256", "currentDatabaseSnapshotSha256"):
    if not hex64.fullmatch(p.get(key) or ""):
        raise SystemExit(f"rebuild replay journal has an invalid {key}")
for key in ("currentApiImage", "currentWorkerImage"):
    if not sha.fullmatch(p.get(key) or ""):
        raise SystemExit(f"rebuild replay journal has an invalid {key}")
receipt = p.get("currentCanaryReceiptSha256")
if receipt != "absent" and not hex64.fullmatch(receipt or ""):
    raise SystemExit("rebuild replay journal has an invalid receipt binding")
state = p.get("currentCutoverStateKind")
if state not in {"pending-pristine", "pending-receipt", "pending-unmarked-receipt", "pending-attested", "pending-attested-retained-receipt", "terminal"}:
    raise SystemExit("rebuild replay journal has an invalid cutover-state binding")
values = [
    p["status"], p["nodeApiImageAfter"], p.get("nodeApiContainerBefore") or "",
    p.get("nodeApiContainerAfter") or "", p["currentDeploymentEnvironmentSha256"],
    p["currentApiImage"], p["currentWorkerImage"], p["currentDatabaseSnapshotSha256"], receipt, state,
]
print("\n".join(values))
PY
  )" || exit $?
  mapfile -t replay_fields <<<"$replay_binding"
  existing_replay_status="${replay_fields[0]}"
  node_image_after="${replay_fields[1]}"
  node_container_before="${replay_fields[2]}"
  node_container_after="${replay_fields[3]}"
  expected_current_env_sha="${replay_fields[4]}"
  expected_current_api_image="${replay_fields[5]}"
  expected_current_worker_image="${replay_fields[6]}"
  expected_current_database_sha="${replay_fields[7]}"
  expected_current_receipt_sha="${replay_fields[8]}"
  expected_current_state_kind="${replay_fields[9]}"
fi

python3 - "$manifest_tool" "$app_real" "$staging_real" <<'PY'
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
    raise SystemExit("cannot load the bound deployment source verifier")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

expected = {
    "apps/api/src/admin-routes.ts",
    "apps/api/src/openfoam-2606-attestation.ts",
    "apps/api/test/openfoam-2606-attestation.test.ts",
    "apps/api/test/solver-execution-pool-admission.test.ts",
    "scripts/deploy/rebuild-engine.sh",
    "scripts/deploy/openfoam_2606_canary.py",
    "scripts/deploy/repair-pending-node-api.sh",
    "scripts/deploy/replay-pending-opencfd2606-rebuild.sh",
    "tests/test_deploy_sweeper_state.py",
    "tests/test_pending_cutover_engine_rebuild_replay.py",
    "tests/test_pending_cutover_node_api_repair.py",
    "tests/test_openfoam_2606_canary.py",
}

def entries(root: Path) -> dict[str, tuple[str, bool, str]]:
    result = {}
    for path in module._source_entries(root):
        relative = path.relative_to(root).as_posix()
        metadata = path.lstat()
        executable = bool(metadata.st_mode & 0o111)
        if stat.S_ISREG(metadata.st_mode):
            kind, payload = "file", path.read_bytes()
        elif stat.S_ISLNK(metadata.st_mode):
            kind, payload = "symlink", os.readlink(path).encode()
        else:
            raise SystemExit(f"unsupported source entry: {relative}")
        result[relative] = (kind, executable, hashlib.sha256(payload).hexdigest())
    return result

bound = entries(bound_root)
target = entries(target_root)
changed = {path for path in set(bound) | set(target) if bound.get(path) != target.get(path)}
if changed != expected:
    print("rebuild replay source is not the exact reviewed incident scope", file=sys.stderr)
    for path in sorted(changed):
        print(f"  {path}", file=sys.stderr)
    raise SystemExit(14)
PY

declare -A exact_target_hashes=(
  ["apps/api/src/admin-routes.ts"]="$EXPECTED_NODE_API_SHA256"
  ["apps/api/test/solver-execution-pool-admission.test.ts"]="$EXPECTED_NODE_API_TEST_SHA256"
  ["apps/api/src/openfoam-2606-attestation.ts"]="$EXPECTED_NODE_ATTESTATION_SHA256"
  ["apps/api/test/openfoam-2606-attestation.test.ts"]="$EXPECTED_NODE_ATTESTATION_TEST_SHA256"
  ["scripts/deploy/repair-pending-node-api.sh"]="$EXPECTED_NODE_REPAIR_SCRIPT_SHA256"
  ["tests/test_pending_cutover_node_api_repair.py"]="$EXPECTED_NODE_REPAIR_TEST_SHA256"
  ["scripts/deploy/rebuild-engine.sh"]="$EXPECTED_REPLAY_REBUILD_SHA256"
  ["scripts/deploy/openfoam_2606_canary.py"]="$EXPECTED_CANARY_SHA256"
  ["tests/test_deploy_sweeper_state.py"]="$EXPECTED_REBUILD_TEST_SHA256"
  ["tests/test_pending_cutover_engine_rebuild_replay.py"]="$EXPECTED_REPLAY_TEST_SHA256"
  ["tests/test_openfoam_2606_canary.py"]="$EXPECTED_CANARY_TEST_SHA256"
)
for relative in "${!exact_target_hashes[@]}"; do
  if [[ "$(sha256_file "$staging_real/$relative")" != "${exact_target_hashes[$relative]}" ]]; then
    fail "Pending 2606 rebuild replay target has unreviewed bytes in $relative." 14
    exit $?
  fi
done
if [[ "$(sha256_file "$app_real/scripts/deploy/rebuild-engine.sh")" != "$EXPECTED_BOUND_REBUILD_SHA256" ]]; then
  fail "The sealed release rebuild script no longer matches its exact prior bytes." 14
  exit $?
fi

if [[ "$(sha256_file "$NODE_REPAIR_RECEIPT_FILE")" != "$EXPECTED_NODE_REPAIR_RECEIPT_SHA256" ]]; then
  fail "The applied Node repair receipt is not the exact production receipt authorized for this replay." 14
  exit $?
fi
python3 - "$NODE_REPAIR_RECEIPT_FILE" \
  "$EXPECTED_BOUND_SOURCE_REVISION" "$EXPECTED_BOUND_SOURCE_TREE_SHA256" \
  "$EXPECTED_NODE_REPAIR_SOURCE_REVISION" "$EXPECTED_NODE_REPAIR_SOURCE_TREE_SHA256" \
  "$EXPECTED_NODE_REPAIR_CHANGE_SHA256" "$EXPECTED_FIRST_NODE_REPAIR_ENV_SHA256" "$EXPECTED_NODE_IMAGE" <<'PY'
import json
from pathlib import Path
import sys

p = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
expected = {
    "schemaVersion": 1,
    "purpose": "pending-opencfd2606-node-api-timeout-repair",
    "status": "applied",
    "boundSourceRevision": sys.argv[2],
    "boundSourceTreeSha256": sys.argv[3],
    "repairSourceRevision": sys.argv[4],
    "repairSourceTreeSha256": sys.argv[5],
    "sourceChangeSha256": sys.argv[6],
    "deploymentEnvironmentSha256": sys.argv[7],
    "nodeApiImageAfter": sys.argv[8],
}
for key, value in expected.items():
    if p.get(key) != value:
        raise SystemExit(f"applied Node repair receipt mismatch: {key}")
if p.get("sourceChangePaths") != [
    "apps/api/src/admin-routes.ts",
    "apps/api/test/solver-execution-pool-admission.test.ts",
    "scripts/deploy/repair-pending-node-api.sh",
    "tests/test_pending_cutover_node_api_repair.py",
]:
    raise SystemExit("applied Node repair receipt has an unexpected source scope")
PY
if [[ "$(sha256_file "$ENV_FILE")" != "$expected_current_env_sha" || \
      "$(read_env_var AIRFOILFOAM_BUILD_ID)" != "$EXPECTED_BUILD_ID" || \
      "$(read_env_var ENGINE_EXPECTED_BUILD_ID)" != "$EXPECTED_BUILD_ID" ]]; then
  fail "Deployment environment is not the exact same-build pending replay state." 14
  exit $?
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi
compose_bound() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$bound_compose" "$@"
}

cutover_state_json() {
  python3 "$state_tool" \
    --env-file "$ENV_FILE" \
    --receipt-file "$OPENCFD2606_CANARY_RECEIPT_FILE" \
    --current-source-revision "$bound_revision" \
    --current-source-tree-sha256 "$bound_tree" \
    --require-state any \
    --print-json
}

cutover_state_kind() {
  cutover_state_json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state_kind") or "")'
}

validate_replay_cutover_state() {
  local state_json
  state_json="$(cutover_state_json)" || return $?
  python3 -c '
import json, sys
p = json.load(sys.stdin)
kind = p.get("state_kind")
allowed = {"pending-pristine", "pending-receipt", "pending-unmarked-receipt", "pending-attested", "pending-attested-retained-receipt", "terminal"}
if kind not in allowed or p.get("OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING") != "0":
    raise SystemExit("replay requires a canonical stopped-scheduler cutover recovery state")
print(kind)
' <<<"$state_json" >/dev/null || return $?
  local kind
  kind="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["state_kind"])' <<<"$state_json")"
  if [[ "$kind" == "pending-pristine" || "$kind" == "pending-attested" || "$kind" == "terminal" ]]; then
    if [[ -e "$OPENCFD2606_CANARY_RECEIPT_FILE" || -L "$OPENCFD2606_CANARY_RECEIPT_FILE" ]]; then
      fail "$kind replay state must not retain a canary receipt." 14
      return $?
    fi
  else
    require_regular_owned_mode "$OPENCFD2606_CANARY_RECEIPT_FILE" 600 "Retained OpenCFD 2606 canary receipt" || return $?
  fi
}

assert_recorded_recovery_binding() {
  local actual_state actual_receipt actual_database
  actual_state="$(cutover_state_kind)" || return $?
  [[ "$actual_state" == "$expected_current_state_kind" ]] || {
    fail "Cutover recovery state differs from the durable replay journal: $actual_state" 14
    return $?
  }
  if [[ -f "$OPENCFD2606_CANARY_RECEIPT_FILE" && ! -L "$OPENCFD2606_CANARY_RECEIPT_FILE" ]]; then
    actual_receipt="$(sha256_file "$OPENCFD2606_CANARY_RECEIPT_FILE")"
  else
    actual_receipt="absent"
  fi
  [[ "$actual_receipt" == "$expected_current_receipt_sha" ]] || {
    fail "Canary receipt differs from the durable replay journal." 14
    return $?
  }
  actual_database="$(database_snapshot_sha)" || return $?
  [[ "$actual_database" == "$expected_current_database_sha" ]] || {
    fail "Cutover database snapshot differs from the durable replay journal." 14
    return $?
  }
}

assert_app_source_env() {
  [[ -L "$APP_DIR" && "$(readlink -f "$APP_DIR")" == "$EXPECTED_BOUND_APP_REAL" ]] || {
    fail "APP_DIR moved during rebuild replay validation." 14
    return $?
  }
  [[ "$(sha256_file "$ENV_FILE")" == "$expected_current_env_sha" ]] || {
    fail "Deployment environment changed during rebuild replay validation." 14
    return $?
  }
  local fields
  fields="$(python3 "$manifest_tool" --verify --root "$app_real" --manifest "$app_real/.deployment-source.json")" || return $?
  [[ "$fields" == "$bound_revision"$'\t'"$bound_tree"$'\t'"$bound_count" ]] || {
    fail "Sealed release source changed during rebuild replay validation." 14
    return $?
  }
  validate_replay_cutover_state
}

assert_scheduler_and_workers() {
  if [[ -n "$(compose_bound ps --status running -q sweeper)" ]]; then
    fail "Rebuild replay requires the scheduler to remain stopped." 12
    return $?
  fi
  local service running hidden
  while IFS= read -r service; do
    [[ -n "$service" && "$service" != "worker" ]] || continue
    running="$(compose_bound --profile '*' ps --status running -q "$service")"
    if [[ -n "$running" ]]; then
      fail "Rebuild replay refuses running optional engine worker $service." 12
      return $?
    fi
  done < <(compose_bound --profile '*' config --services | awk '/^worker-/')
  hidden="$(docker ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --format '{{.Label "com.docker.compose.service"}}' | awk '$0 ~ /^worker-/')"
  if [[ -n "$hidden" ]]; then
    fail "Rebuild replay refuses hidden running optional workers: $hidden" 12
    return $?
  fi
}

running_container() {
  local service="$1" id
  id="$(compose_bound ps --status running -q "$service")"
  if [[ -z "$id" || "$(wc -l <<<"$id")" -ne 1 ]]; then
    fail "Rebuild replay requires exactly one running $service container." 12
    return $?
  fi
  printf '%s' "$id"
}

service_image_if_running() {
  local id
  id="$(running_container "$1")" || return $?
  docker inspect --format '{{.Image}}' "$id"
}

assert_container_image() {
  local service="$1" expected="$2" id image
  id="$(running_container "$service")" || return $?
  image="$(docker inspect --format '{{.Image}}' "$id")" || return 12
  [[ "$image" == "$expected" ]] || {
    fail "Rebuild replay found an unexpected $service image: $image" 12
    return $?
  }
}

assert_container_matches_compose_tag() {
  local service="$1" image_ref="${COMPOSE_PROJECT_NAME}-$1" id image tag_image
  id="$(running_container "$service")" || return $?
  image="$(docker inspect --format '{{.Image}}' "$id")" || return 12
  tag_image="$(docker image inspect --format '{{.Id}}' "$image_ref")" || return 12
  if [[ ! "$image" =~ ^sha256:[0-9a-f]{64}$ || "$image" != "$tag_image" ]]; then
    fail "Post-replay $service container does not match its Compose image tag." 14
    return $?
  fi
}

assert_no_openfoam_processes() {
  local output
  output="$(compose_bound exec -T worker sh -lc \
    'pgrep -af "[s]impleFoam|[p]impleFoam|[p]otentialFoam|[s]nappyHexMesh|[s]urfaceFeatureExtract|[b]lockMesh|[c]heckMesh|[d]ecomposePar|[r]econstructPar|[r]enumberMesh|[m]apFields|[p]ostProcess|[f]oamToVTK|[f]oamRun|[f]oamJob" || true')" || return 12
  if [[ -n "$output" ]]; then
    fail "Rebuild replay refuses active OpenFOAM work: $output" 12
    return $?
  fi
}

assert_engine_health() {
  curl -fsS --max-time 15 http://127.0.0.1:8000/health | python3 -c '
import json, sys
p = json.load(sys.stdin)
expected_engine = {"family":"openfoam","distribution":"opencfd","version":"2606","numerics_revision":"1","adapter_contract_version":1}
expected_storage = {"backend":"gcs","bucket":"airfoils-pro-storage-bucket","object_prefix":"solver-evidence/v1","archive_format":"tar+zstd","compression":"zstd","zstd_level":10,"remote_only":True}
engine = p.get("default_engine") or {}
if p.get("build_id") != sys.argv[1] or {k: engine.get(k) for k in expected_engine} != expected_engine:
    raise SystemExit("live engine build/identity differs from the authorized replay")
if p.get("evidence_storage") != expected_storage:
    raise SystemExit("live evidence-storage contract differs from the authorized replay")
' "$EXPECTED_BUILD_ID"
}

assert_engine_queue_idle() {
  curl -fsS --max-time 15 http://127.0.0.1:8000/queue | python3 -c '
import json, sys
p = json.load(sys.stdin)
for field in ("active_count", "reserved_count", "scheduled_count", "queue_depth"):
    if p.get(field) != 0:
        raise SystemExit(f"engine queue is not idle: {field}={p.get(field)!r}")
if p.get("job_ids") not in ([], None) or p.get("inspection_errors") not in ({}, None):
    raise SystemExit("engine queue inspection reports work or errors")
if p.get("worker_queues_error") is not None or p.get("worker_runtime_error") is not None:
    raise SystemExit("engine worker observability is unavailable")
bindings = p.get("worker_queues")
if not isinstance(bindings, list) or len(bindings) != 1:
    raise SystemExit("expected exactly one live OpenCFD worker binding")
b = bindings[0]
expected = {"family":"openfoam","distribution":"opencfd","version":"2606","numerics_revision":"1","adapter_contract_version":1}
engine = b.get("engine") or {}
if b.get("queues") != [sys.argv[1]] or b.get("execution_pool") != sys.argv[1] or {k: engine.get(k) for k in expected} != expected:
    raise SystemExit("live worker route/runtime differs from the authorized replay")
' "$OPENCFD_2606_ROUTE"
}

database_snapshot_payload() {
  compose_bound exec -T postgres psql -U aerodb -d aerodb -X -v ON_ERROR_STOP=1 -Atc "
WITH target_impl AS (
  SELECT solver_implementation_id AS id FROM solver_execution_pools WHERE id = '$OPENCFD_2606_POOL_ID'
), target_cutovers AS (
  SELECT COALESCE(json_agg(json_build_object(
    'id', c.id, 'status', c.status, 'canaryAttestationId', c.canary_attestation_id,
    'targetPlanRevisionId', c.target_plan_revision_id, 'finalizedAt', c.finalized_at,
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
" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True, separators=(",", ":")))'
}

database_snapshot() {
  database_snapshot_payload | python3 -c '
import hashlib, json, sys
p = json.load(sys.stdin)
rows = p.get("cutovers")
if p.get("poolRows") != 1 or p.get("poolEnabled") is not False or p.get("attestationCount") != 0:
    raise SystemExit("target pool/attestation state is not the exact disabled pre-canary state")
if not isinstance(rows, list) or len(rows) != 1 or rows[0].get("status") != "prepared":
    raise SystemExit("expected exactly one prepared target cutover")
if any(rows[0].get(k) is not None for k in ("canaryAttestationId","targetPlanRevisionId","finalizedAt","completedAt")):
    raise SystemExit("target cutover advanced beyond prepared")
value = json.dumps(p, sort_keys=True, separators=(",", ":"))
print(hashlib.sha256(value.encode()).hexdigest())
'
}

database_snapshot_sha() {
  local payload
  payload="$(database_snapshot_payload)" || return $?
  printf '%s' "$payload" | sha256sum | awk '{print $1}'
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

assert_initial_node_repair_runtime() {
  local id image source_sha tag_image
  id="$(running_container node-api)" || return $?
  image="$(docker inspect --format '{{.Image}}' "$id")" || return 12
  tag_image="$(docker image inspect --format '{{.Id}}' "${COMPOSE_PROJECT_NAME}-node-api")" || return 12
  source_sha="$(docker exec "$id" sha256sum /app/apps/api/src/admin-routes.ts | awk '{print $1}')" || return 12
  if [[ "$image" != "$EXPECTED_NODE_IMAGE" || "$tag_image" != "$EXPECTED_NODE_IMAGE" || "$source_sha" != "$EXPECTED_NODE_API_SHA256" ]]; then
    fail "Live Node API is not the exact applied timeout repair required by this replay." 14
    return $?
  fi
  printf '%s' "$id"
}

assert_replay_node_runtime() {
  local id image tag_image repair_tag_image api_sha attestation_sha
  id="$(running_container node-api)" || return $?
  image="$(docker inspect --format '{{.Image}}' "$id")" || return 12
  tag_image="$(docker image inspect --format '{{.Id}}' "$node_image_ref")" || return 12
  repair_tag_image="$(docker image inspect --format '{{.Id}}' "$replay_node_image_tag")" || return 12
  api_sha="$(docker exec "$id" sha256sum /app/apps/api/src/admin-routes.ts | awk '{print $1}')" || return 12
  attestation_sha="$(docker exec "$id" sha256sum /app/apps/api/src/openfoam-2606-attestation.ts | awk '{print $1}')" || return 12
  if [[ "$image" != "$node_image_after" || "$tag_image" != "$node_image_after" || \
        "$repair_tag_image" != "$node_image_after" || "$api_sha" != "$EXPECTED_NODE_API_SHA256" || \
        "$attestation_sha" != "$EXPECTED_NODE_ATTESTATION_SHA256" ]]; then
    fail "Live Node API is not the exact replay repair image and source contract." 14
    return $?
  fi
  printf '%s' "$id"
}

rollback_node_api() {
  local current
  docker image inspect "$rollback_old_image" >/dev/null || return 12
  docker image tag "$rollback_old_image" "$node_image_ref" || return 12
  current="$(current_node_image)" || return 12
  if [[ "$current" != "$rollback_old_image" ]]; then
    compose_bound up -d --no-deps --force-recreate node-api || return 12
  fi
  wait_node_health || return 12
  node_container_after="$(running_container node-api)" || return $?
  [[ "$(docker inspect --format '{{.Image}}' "$node_container_after")" == "$rollback_old_image" ]] || return 12
  [[ "$(docker image inspect --format '{{.Id}}' "$node_image_ref")" == "$rollback_old_image" ]] || return 12
}

assert_common_runtime_invariants() {
  assert_app_source_env || return $?
  assert_scheduler_and_workers || return $?
  assert_container_image api "$expected_current_api_image" || return $?
  assert_container_image worker "$expected_current_worker_image" || return $?
  assert_no_openfoam_processes || return $?
  assert_engine_health || return $?
  assert_engine_queue_idle || return $?
  assert_recorded_recovery_binding || return $?
}

assert_runtime_invariants() {
  local node_id
  assert_common_runtime_invariants || return $?
  node_id="$(assert_initial_node_repair_runtime)" || return $?
  printf '%s' "$node_id"
}

assert_replay_runtime_invariants() {
  local node_id
  assert_common_runtime_invariants || return $?
  node_id="$(assert_replay_node_runtime)" || return $?
  printf '%s' "$node_id"
}

assert_post_replay_invariants() {
  local fields state_json state_kind
  [[ -L "$APP_DIR" && "$(readlink -f "$APP_DIR")" == "$EXPECTED_BOUND_APP_REAL" ]] || {
    fail "APP_DIR no longer resolves to sealed 6338577 after the rebuild replay." 14
    return $?
  }
  fields="$(python3 "$manifest_tool" --verify --root "$app_real" --manifest "$app_real/.deployment-source.json")" || return $?
  [[ "$fields" == "$bound_revision"$'\t'"$bound_tree"$'\t'"$bound_count" ]] || {
    fail "Sealed 6338577 source changed during the rebuild replay." 14
    return $?
  }
  require_regular_owned_mode "$ENV_FILE" 600 "Post-replay deployment environment" || return $?
  if [[ "$(read_env_var AIRFOILFOAM_BUILD_ID)" != "$EXPECTED_BUILD_ID" || \
        "$(read_env_var ENGINE_EXPECTED_BUILD_ID)" != "$EXPECTED_BUILD_ID" ]]; then
    fail "Post-replay build identity is not the exact authorized same build." 14
    return $?
  fi
  assert_scheduler_and_workers || return $?
  assert_container_matches_compose_tag api || return $?
  assert_container_matches_compose_tag worker || return $?
  assert_no_openfoam_processes || return $?
  assert_engine_health || return $?
  assert_replay_node_runtime >/dev/null || return $?
  state_json="$(python3 "$state_tool" \
    --env-file "$ENV_FILE" \
    --receipt-file "$OPENCFD2606_CANARY_RECEIPT_FILE" \
    --current-source-revision "$bound_revision" \
    --current-source-tree-sha256 "$bound_tree" \
    --require-state any \
    --print-json)" || return $?
  state_kind="$(python3 -c '
import json, sys
p = json.load(sys.stdin)
kind = p.get("state_kind")
if kind not in {"terminal", "pending-attested", "pending-attested-retained-receipt"}:
    raise SystemExit(f"rebuild returned without terminal certification or a durable attested recovery state: {kind!r}")
print(kind)
' <<<"$state_json")" || return $?
  printf '%s' "$state_kind"
}

build_node_image=false
swap_node_image=false
live_node_image="$(current_node_image)"
case "$existing_replay_status" in
  "")
    node_container_before="$(assert_runtime_invariants)"
    node_image_before="$(docker inspect --format '{{.Image}}' "$node_container_before")"
    build_node_image=true
    swap_node_image=true
    ;;
  prepared)
    if [[ "$live_node_image" == "$node_image_before" ]]; then
      node_container_before="$(assert_runtime_invariants)"
      swap_node_image=true
    elif [[ "$live_node_image" == "$node_image_after" ]]; then
      node_container_after="$(assert_replay_runtime_invariants)"
    else
      fail "Prepared replay journal does not match the running Node API image." 14
      exit $?
    fi
    ;;
  rolled_back)
    if [[ "$live_node_image" != "$node_image_before" ]]; then
      fail "Rolled-back replay journal does not match the restored Node API image." 14
      exit $?
    fi
    node_container_before="$(assert_runtime_invariants)"
    swap_node_image=true
    ;;
  node_applied|failed|completed)
    node_container_after="$(assert_replay_runtime_invariants)"
    ;;
  *)
    fail "Unsupported rebuild replay journal status: $existing_replay_status" 14
    exit $?
    ;;
esac

if [[ "$existing_replay_status" == "completed" ]]; then
  post_state_kind="$(assert_post_replay_invariants)"
  echo "The exact pending OpenCFD 2606 same-build replay is already completed ($post_state_kind)."
  exit 0
fi

# Seal only the reviewed maintenance script plus byte-identical helpers into a
# private tmpfs directory. The child therefore cannot observe later staging
# mutations, while its APP_DIR/Compose/manifest remain the sealed bound tree.
runtime_dir="$(mktemp -d /dev/shm/airfoils-opencfd2606-replay.XXXXXX)"
chmod 700 "$runtime_dir"
if [[ -L "$runtime_dir" || "$(stat -c '%a' "$runtime_dir")" != "700" || "$(stat -c '%u' "$runtime_dir")" != "$(id -u)" ]]; then
  fail "Could not create a private same-owner mode-0700 replay runtime." 14
  exit $?
fi
bundle="$runtime_dir/scripts/deploy"
install -d -m 700 "$bundle"
install -d -m 700 "$runtime_dir/examples"
helper_names=(
  deployment-env-preflight.py
  opencfd2606_cutover_state.py
  evidence-contract.py
  persist-json-receipt.py
)
for helper in "${helper_names[@]}"; do
  staged="$staging_real/scripts/deploy/$helper"
  bound="$app_real/scripts/deploy/$helper"
  if [[ ! -f "$staged" || -L "$staged" || ! -f "$bound" || -L "$bound" ]] || ! cmp -s "$staged" "$bound"; then
    fail "Staged helper $helper is not byte-identical to sealed 6338577." 14
    exit $?
  fi
  install -m 600 "$staged" "$bundle/$helper"
  cmp -s "$bundle/$helper" "$bound" || { fail "Sealed helper copy changed: $helper" 14; exit $?; }
done
install -m 700 "$staging_real/scripts/deploy/rebuild-engine.sh" "$bundle/rebuild-engine.sh"
[[ "$(sha256_file "$bundle/rebuild-engine.sh")" == "$EXPECTED_REPLAY_REBUILD_SHA256" ]] || {
  fail "Sealed replay rebuild script changed during private copy." 14
  exit $?
}
install -m 600 "$staging_real/scripts/deploy/openfoam_2606_canary.py" "$bundle/openfoam_2606_canary.py"
[[ "$(sha256_file "$bundle/openfoam_2606_canary.py")" == "$EXPECTED_CANARY_SHA256" ]] || {
  fail "Sealed replay canary changed during private copy." 14
  exit $?
}
if [[ ! -f "$staging_real/examples/naca0012.dat" || -L "$staging_real/examples/naca0012.dat" || \
      ! -f "$app_real/examples/naca0012.dat" || -L "$app_real/examples/naca0012.dat" ]] || \
   ! cmp -s "$staging_real/examples/naca0012.dat" "$app_real/examples/naca0012.dat"; then
  fail "Staged OpenCFD canary geometry is not byte-identical to sealed 6338577." 14
  exit $?
fi
install -m 600 "$staging_real/examples/naca0012.dat" "$runtime_dir/examples/naca0012.dat"
cmp -s "$runtime_dir/examples/naca0012.dat" "$app_real/examples/naca0012.dat" || {
  fail "Sealed OpenCFD canary geometry changed during private copy." 14
  exit $?
}
private_lock="$runtime_dir/rebuild-engine.lock"
: >"$private_lock"
chmod 600 "$private_lock"
require_regular_owned_mode "$private_lock" 600 "Private child rebuild lock"

# Build the exact staged Node control-plane patch under a unique incident tag.
# The live Compose tag and container still point at the first applied repair;
# no runtime mutation occurs until the prepared journal is durably fsynced.
compose_bound config >/dev/null
if [[ "$build_node_image" == "true" ]]; then
  if docker image inspect "$replay_node_image_tag" >/dev/null 2>&1 || \
     docker image inspect "$rollback_node_image_tag" >/dev/null 2>&1; then
    fail "A new replay refuses pre-existing incident Node image tags." 18
    exit $?
  fi
  echo "Building the reviewed replay Node API image..."
  docker build \
    --file "$staging_real/docker/Dockerfile.node" \
    --tag "$replay_node_image_tag" \
    "$staging_real"
  node_image_after="$(docker image inspect --format '{{.Id}}' "$replay_node_image_tag")"
  if [[ ! "$node_image_before" =~ ^sha256:[0-9a-f]{64}$ || \
        ! "$node_image_after" =~ ^sha256:[0-9a-f]{64}$ || \
        "$node_image_after" == "$node_image_before" ]]; then
    fail "Replay Node build did not produce distinct, valid image identities." 12
    exit $?
  fi
  node_id_after_build="$(assert_runtime_invariants)"
  [[ "$node_id_after_build" == "$node_container_before" ]] || {
    fail "Node API container changed while the replay image was built." 14
    exit $?
  }
  persist_replay_journal prepared
  existing_replay_status="prepared"
else
  replay_tag_image="$(docker image inspect --format '{{.Id}}' "$replay_node_image_tag")" || {
    fail "Journaled replay Node image tag is missing." 14
    exit $?
  }
  [[ "$replay_tag_image" == "$node_image_after" ]] || {
    fail "Journaled replay Node image tag changed." 14
    exit $?
  }
  if docker image inspect "$rollback_node_image_tag" >/dev/null 2>&1; then
    [[ "$(docker image inspect --format '{{.Id}}' "$rollback_node_image_tag")" == "$node_image_before" ]] || {
      fail "Journaled rollback Node image tag changed." 14
      exit $?
    }
  elif [[ "$existing_replay_status" == "node_applied" || "$existing_replay_status" == "failed" || "$existing_replay_status" == "completed" ]]; then
    fail "Applied replay journal lost its exact rollback Node image tag." 14
    exit $?
  fi
fi

if [[ "$swap_node_image" == "true" ]]; then
  rollback_old_image="$node_image_before"
  rollback_new_image="$node_image_after"
  ROLLBACK_ARMED=true
  docker image tag "$node_image_before" "$rollback_node_image_tag"
  docker image tag "$node_image_after" "$node_image_ref"
  compose_bound up -d --no-deps --force-recreate node-api
  wait_node_health
  node_container_after="$(assert_replay_node_runtime)"
elif [[ "$existing_replay_status" == "prepared" ]]; then
  # A prior process crossed the container swap but not the durable Node stage.
  # Keep rollback armed until health, source, and live auth all pass below.
  rollback_old_image="$node_image_before"
  rollback_new_image="$node_image_after"
  ROLLBACK_ARMED=true
fi

cookie_file="$runtime_dir/admin-cookie"
: >"$cookie_file"
chmod 600 "$cookie_file"
require_regular_owned_mode "$cookie_file" 600 "Ephemeral admin cookie"
docker exec -e "MAINTENANCE_COOKIE_TTL_MS=$MAINTENANCE_COOKIE_TTL_MS" -w /app "$node_container_after" pnpm exec tsx -e \
  'import { signSession } from "./apps/api/src/admin-auth.ts"; process.stdout.write("aero_admin=" + signSession("cutover-replay@airfoils.pro", Number(process.env.MAINTENANCE_COOKIE_TTL_MS), "password"));' \
  >"$cookie_file"
python3 - "$cookie_file" <<'PY'
from pathlib import Path
import re
import sys

value = Path(sys.argv[1]).read_text(encoding="utf-8")
if re.fullmatch(r"aero_admin=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", value) is None:
    raise SystemExit("live Node container did not create a valid maintenance cookie")
PY

# Validate the short-lived credential through the live API without exposing it
# in argv or output. Curl reads the secret header through its stdin config.
{
  printf 'header = "Cookie: '
  cat "$cookie_file"
  printf '"\n'
} | curl --config - --fail-with-body -sS --max-time 15 \
  http://127.0.0.1:4000/api/admin/me | python3 -c '
import json, sys
p = json.load(sys.stdin)
if p.get("authed") is not True or p.get("email") != "cutover-replay@airfoils.pro":
    raise SystemExit("ephemeral maintenance cookie was not accepted by the live Node API")
'

# Recheck every precondition against the new exact Node image after cookie
# creation. Keep fd8 open while the synchronous child takes only its private
# fd9 lock; no normal deploy can enter until the rebuild exits.
node_id_after_cookie="$(assert_replay_runtime_invariants)"
[[ "$node_id_after_cookie" == "$node_container_after" ]] || {
  fail "Replacement Node API container changed during replay validation." 14
  exit $?
}

# The replacement Node API is now health/auth/source verified. From this point
# onward, a child cutover failure must preserve that exact image and the
# prepared journal for diagnosis rather than rolling the required patch back.
if [[ "$existing_replay_status" == "prepared" || "$existing_replay_status" == "rolled_back" ]]; then
  persist_replay_journal node_applied
  existing_replay_status="node_applied"
fi
ROLLBACK_ARMED=false
FAILURE_JOURNAL_ARMED=true

# A previous attempt may have completed the canonical cutover after recording
# its local failure. Verify and close the journal without ever rerunning the
# canary path.
if [[ "$(cutover_state_kind)" == "terminal" ]]; then
  post_state_kind="$(assert_post_replay_invariants)"
  persist_replay_journal completed "$post_state_kind"
  FAILURE_JOURNAL_ARMED=false
  echo "The exact pending OpenCFD 2606 same-build replay was already terminal and is now durably completed ($post_state_kind)."
  exit 0
fi

ADMIN_COOKIE="$(<"$cookie_file")" \
APP_DIR="$app_real" \
AIRFOILS_PRO_STATE_DIR="$AIRFOILS_PRO_STATE_DIR" \
ENV_FILE="$ENV_FILE" \
COMPOSE_FILE="$bound_compose" \
COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
LOCK_FILE="$private_lock" \
DEPLOYMENT_MANIFEST_FILE="$app_real/.deployment-source.json" \
DEPLOY_SOURCE_REVISION="$EXPECTED_BOUND_SOURCE_REVISION" \
DEPLOY_SOURCE_TREE_SHA256="$EXPECTED_BOUND_SOURCE_TREE_SHA256" \
OPENCFD2606_CANARY_RECEIPT_FILE="$OPENCFD2606_CANARY_RECEIPT_FILE" \
"$bundle/rebuild-engine.sh" "$EXPECTED_BUILD_ID"

post_state_kind="$(assert_post_replay_invariants)"
persist_replay_journal completed "$post_state_kind"
FAILURE_JOURNAL_ARMED=false
echo "The exact pending OpenCFD 2606 same-build replay completed through the sealed maintenance path ($post_state_kind)."
