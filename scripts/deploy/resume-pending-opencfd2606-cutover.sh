#!/usr/bin/env bash
# Incident-specific launcher for the second 2026-07-17 OpenCFD 2606 cutover
# recovery. The bound 6338577 release must remain immutable while its own
# queue probe has a 5-second client race against a ~5.03-second authoritative
# worker snapshot. This launcher accepts only the reviewed 15-second probe
# patch, verifies the already-applied Node admission repair, journals the
# temporary staged runner, and delegates every live idle/canary/cutover gate to
# rebuild-engine.sh.
set -Eeuo pipefail

STAGING_DIR="${STAGING_DIR:?STAGING_DIR is required}"
EXPECTED_TARGET_SOURCE_REVISION="${EXPECTED_TARGET_SOURCE_REVISION:?EXPECTED_TARGET_SOURCE_REVISION is required}"
BUILD_ID="${BUILD_ID:?BUILD_ID is required}"
APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-app}"
LOCK_FILE="/tmp/airfoils-pro-deploy.lock"
REPAIR_JOURNAL="$AIRFOILS_PRO_STATE_DIR/pending-cutover-node-api-repair.json"
RESUME_JOURNAL="$AIRFOILS_PRO_STATE_DIR/pending-cutover-queue-probe-resume.json"
CANARY_RECEIPT="$AIRFOILS_PRO_STATE_DIR/openfoam-2606-canary-receipt.pending.json"

EXPECTED_BOUND_REVISION="63385777be7323777906fde44bdb9fa9b5cc0d6d"
EXPECTED_BOUND_TREE="52c8bd3aa6d5a05dcd70a90d8896fb771f7fc36d129e698be0c935680e3fff36"
EXPECTED_BOUND_COUNT="2198"
EXPECTED_NODE_REPAIR_REVISION="26b19c9a6f229d76359095958a3a6d8edac0801f"
EXPECTED_NODE_REPAIR_TREE="3f1631f275119fa1d316ecae8d9fe340b91b6f64f27b907780ea7ea1445632dd"
EXPECTED_REBUILD_SHA256="e9008a8d6ba6f80c809d2e952d730600ed1876c0a61fa22b6e3019d1ef448372"

fail() {
  echo "$1" >&2
  exit "${2:-14}"
}

read_env_var() {
  local key="$1"
  awk -F= -v key="$key" '
    $1 == key { sub(/^[^=]*=/, ""); print; count += 1 }
    END { if (count != 1) exit 14 }
  ' "$ENV_FILE"
}

[[ "$EXPECTED_TARGET_SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || fail "Target revision must be an exact lowercase commit SHA." 2
[[ "$BUILD_ID" =~ ^[A-Za-z0-9._-]+$ ]] || fail "BUILD_ID contains unsupported characters." 2
exec 9>"$LOCK_FILE"
flock -n 9 || fail "Another Airfoils.Pro deploy is already running." 9
[[ -L "$APP_DIR" ]] || fail "APP_DIR must remain the bound release symlink." 2
[[ -d "$STAGING_DIR" && ! -L "$STAGING_DIR" ]] || fail "Staging source is missing or unsafe." 2
[[ -d "$AIRFOILS_PRO_STATE_DIR" && ! -L "$AIRFOILS_PRO_STATE_DIR" ]] || fail "State directory is missing or unsafe." 2
[[ "$(stat -c '%a' "$AIRFOILS_PRO_STATE_DIR")" == "700" ]] || fail "State directory must be mode 0700." 2
[[ "$(stat -c '%u' "$AIRFOILS_PRO_STATE_DIR")" == "$(id -u)" ]] || fail "State directory ownership mismatch." 2
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" && "$(stat -c '%a' "$ENV_FILE")" == "600" ]] || fail "Deployment environment is unsafe." 2
[[ -f "$REPAIR_JOURNAL" && ! -L "$REPAIR_JOURNAL" && "$(stat -c '%a' "$REPAIR_JOURNAL")" == "600" ]] || fail "Applied Node repair journal is missing or unsafe." 14
[[ ! -e "$CANARY_RECEIPT" && ! -L "$CANARY_RECEIPT" ]] || fail "A canary receipt now exists; use the canonical certification recovery instead." 14

staging_real="$(realpath "$STAGING_DIR")"
app_real="$(readlink -f "$APP_DIR")"
[[ "$staging_real" != "$app_real" ]] || fail "Staging and bound release must be distinct." 2
manifest_tool="$app_real/scripts/deploy/deployment-source-manifest.py"
[[ -f "$manifest_tool" && ! -L "$manifest_tool" ]] || fail "Bound manifest verifier is unavailable." 2

IFS=$'\t' read -r bound_revision bound_tree bound_count < <(
  python3 "$manifest_tool" --verify --root "$app_real" --manifest "$app_real/.deployment-source.json"
)
[[ "$bound_revision" == "$EXPECTED_BOUND_REVISION" && "$bound_tree" == "$EXPECTED_BOUND_TREE" && "$bound_count" == "$EXPECTED_BOUND_COUNT" ]] || fail "Bound production source differs from the incident release." 14

IFS=$'\t' read -r target_revision target_tree target_count < <(
  python3 "$manifest_tool" --verify --root "$staging_real" --manifest "$staging_real/.deployment-source.json"
)
[[ "$target_revision" == "$EXPECTED_TARGET_SOURCE_REVISION" ]] || fail "Staged source revision mismatch." 14
[[ "$(sha256sum "$staging_real/scripts/deploy/rebuild-engine.sh" | awk '{print $1}')" == "$EXPECTED_REBUILD_SHA256" ]] || fail "Staged rebuild runner bytes differ from the reviewed queue-probe patch." 14

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
    raise SystemExit("cannot load the bound deployment source model")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

expected = {
    "CompletionLedger.md",
    "apps/api/src/admin-routes.ts",
    "apps/api/test/solver-execution-pool-admission.test.ts",
    "scripts/deploy/rebuild-engine.sh",
    "scripts/deploy/repair-pending-node-api.sh",
    "scripts/deploy/resume-pending-opencfd2606-cutover.sh",
    "tests/test_deploy_sweeper_state.py",
    "tests/test_pending_cutover_node_api_repair.py",
    "tests/test_pending_cutover_queue_probe_resume.py",
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
changed = {path for path in set(bound) | set(target) if bound.get(path) != target.get(path)}
if changed != expected:
    print("staged resume source is not the exact reviewed incident scope", file=sys.stderr)
    for path in sorted(changed):
        print(f"  {path}", file=sys.stderr)
    raise SystemExit(14)
PY

node_after="$(python3 - "$REPAIR_JOURNAL" "$EXPECTED_BOUND_REVISION" "$EXPECTED_BOUND_TREE" "$EXPECTED_NODE_REPAIR_REVISION" "$EXPECTED_NODE_REPAIR_TREE" <<'PY'
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
payload = json.loads(path.read_text())
expected = {
    "schemaVersion": 1,
    "status": "applied",
    "purpose": "pending-opencfd2606-node-api-timeout-repair",
    "boundSourceRevision": sys.argv[2],
    "boundSourceTreeSha256": sys.argv[3],
    "repairSourceRevision": sys.argv[4],
    "repairSourceTreeSha256": sys.argv[5],
}
for key, value in expected.items():
    if payload.get(key) != value:
        raise SystemExit(f"applied Node repair journal mismatch: {key}")
node = payload.get("nodeApiContainerAfter")
if not isinstance(node, str) or len(node) != 64:
    raise SystemExit("applied Node repair journal lacks its exact container")
print(node)
PY
)"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi
current_node="$("${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$app_real/docker-compose.deploy.yml" ps --status running -q node-api)"
[[ "$current_node" == "$node_after" ]] || fail "Live Node API no longer matches the applied repair journal." 14
docker exec "$current_node" grep -Fq 'const ENGINE_POOL_ADMISSION_TIMEOUT_MS = 15_000;' /app/apps/api/src/admin-routes.ts || fail "Live Node API lacks the reviewed admission timeout." 14

[[ "$(read_env_var OPENCFD2606_CUTOVER_PENDING)" == "1" ]] || fail "Cutover is no longer pending." 14
[[ "$(read_env_var OPENCFD2606_CUTOVER_COMPLETE)" == "0" ]] || fail "Cutover is already complete." 14
[[ "$(read_env_var OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING)" == "0" ]] || fail "Recorded scheduler state changed." 14
[[ -z "$(read_env_var OPENCFD2606_CANARY_ATTESTATION_ID)" ]] || fail "A canary attestation now exists; use canonical certification recovery." 14

persist_resume_journal() {
  local status="$1" exit_code="$2"
  RESUME_STATUS="$status" RESUME_EXIT_CODE="$exit_code" RESUME_DESTINATION="$RESUME_JOURNAL" \
  RESUME_BOUND_REVISION="$bound_revision" RESUME_TARGET_REVISION="$target_revision" \
  RESUME_TARGET_TREE="$target_tree" RESUME_BUILD_ID="$BUILD_ID" \
  RESUME_REBUILD_SHA256="$EXPECTED_REBUILD_SHA256" python3 - <<'PY'
import json
import os
from pathlib import Path
import tempfile
from datetime import datetime, timezone

destination = Path(os.environ["RESUME_DESTINATION"])
payload = {
    "schemaVersion": 1,
    "purpose": "pending-opencfd2606-queue-probe-resume",
    "status": os.environ["RESUME_STATUS"],
    "exitCode": int(os.environ["RESUME_EXIT_CODE"]),
    "boundSourceRevision": os.environ["RESUME_BOUND_REVISION"],
    "runnerSourceRevision": os.environ["RESUME_TARGET_REVISION"],
    "runnerSourceTreeSha256": os.environ["RESUME_TARGET_TREE"],
    "rebuildScriptSha256": os.environ["RESUME_REBUILD_SHA256"],
    "buildId": os.environ["RESUME_BUILD_ID"],
    "updatedAt": datetime.now(timezone.utc).isoformat(),
}
if destination.exists():
    existing = json.loads(destination.read_text())
    for key in ("schemaVersion", "purpose", "boundSourceRevision", "runnerSourceRevision", "runnerSourceTreeSha256", "rebuildScriptSha256", "buildId"):
        if existing.get(key) != payload[key]:
            raise SystemExit(f"resume journal mismatch: {key}")
fd, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
try:
    with os.fdopen(fd, "w") as stream:
        json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary_name, 0o600)
    os.replace(temporary_name, destination)
    directory_fd = os.open(destination.parent, os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    try:
        os.unlink(temporary_name)
    except FileNotFoundError:
        pass
PY
}

persist_resume_journal prepared 0
set +e
APP_DIR="$APP_DIR" AIRFOILS_PRO_STATE_DIR="$AIRFOILS_PRO_STATE_DIR" ENV_FILE="$ENV_FILE" \
  COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" LOCK_FILE="$LOCK_FILE" DEPLOY_LOCK_HELD=1 \
  "$staging_real/scripts/deploy/rebuild-engine.sh" "$BUILD_ID"
resume_rc=$?
set -e
if ((resume_rc == 0)); then
  persist_resume_journal completed 0
else
  persist_resume_journal failed "$resume_rc"
fi
exit "$resume_rc"
