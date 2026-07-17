#!/usr/bin/env bash
# Incident-specific r4 recovery after the failed 2026-07-17 retention retry.
# APP_DIR remains the sealed 6338577 production symlink, CURRENT_SOURCE_DIR is
# the exact cd0967 r3 release that owns the live marker/runtime, and STAGING_DIR
# is the reviewed r4 successor supplying Compose build context and runners.
set -Eeuo pipefail
umask 077

STAGING_DIR="${STAGING_DIR:?STAGING_DIR is required}"
CURRENT_SOURCE_DIR="${CURRENT_SOURCE_DIR:?CURRENT_SOURCE_DIR is required}"
BUILD_ID="${BUILD_ID:?BUILD_ID is required}"
APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"
COMPOSE_PROJECT_NAME="app"

# The target tuple and every executable/schema boundary are operator-supplied,
# exact reviewed values.  There are deliberately no generated placeholders or
# defaults: the target commit does not exist at this runner's authoring time.
EXPECTED_TARGET_SOURCE_REVISION="${EXPECTED_TARGET_SOURCE_REVISION:?EXPECTED_TARGET_SOURCE_REVISION is required}"
EXPECTED_TARGET_SOURCE_TREE_SHA256="${EXPECTED_TARGET_SOURCE_TREE_SHA256:?EXPECTED_TARGET_SOURCE_TREE_SHA256 is required}"
EXPECTED_TARGET_SOURCE_FILE_COUNT="${EXPECTED_TARGET_SOURCE_FILE_COUNT:?EXPECTED_TARGET_SOURCE_FILE_COUNT is required}"
EXPECTED_TARGET_CHANGESET_SHA256="${EXPECTED_TARGET_CHANGESET_SHA256:?EXPECTED_TARGET_CHANGESET_SHA256 is required}"
EXPECTED_TARGET_REBUILD_SHA256="${EXPECTED_TARGET_REBUILD_SHA256:?EXPECTED_TARGET_REBUILD_SHA256 is required}"
EXPECTED_TARGET_CANARY_SHA256="${EXPECTED_TARGET_CANARY_SHA256:?EXPECTED_TARGET_CANARY_SHA256 is required}"
EXPECTED_TARGET_MIGRATION_SHA256="${EXPECTED_TARGET_MIGRATION_SHA256:?EXPECTED_TARGET_MIGRATION_SHA256 is required}"
EXPECTED_TARGET_MIGRATION_VERIFIER_SHA256="${EXPECTED_TARGET_MIGRATION_VERIFIER_SHA256:?EXPECTED_TARGET_MIGRATION_VERIFIER_SHA256 is required}"
EXPECTED_TARGET_CONTRACT_HELPER_SHA256="${EXPECTED_TARGET_CONTRACT_HELPER_SHA256:?EXPECTED_TARGET_CONTRACT_HELPER_SHA256 is required}"
EXPECTED_TARGET_RECOVERY_RUNNER_SHA256="${EXPECTED_TARGET_RECOVERY_RUNNER_SHA256:?EXPECTED_TARGET_RECOVERY_RUNNER_SHA256 is required}"
EXPECTED_TARGET_BACKUP_HOOK_SHA256="${EXPECTED_TARGET_BACKUP_HOOK_SHA256:?EXPECTED_TARGET_BACKUP_HOOK_SHA256 is required}"
EXPECTED_TARGET_COMPOSE_SHA256="${EXPECTED_TARGET_COMPOSE_SHA256:?EXPECTED_TARGET_COMPOSE_SHA256 is required}"

DATABASE_BACKUP_FILE="${DATABASE_BACKUP_FILE:?DATABASE_BACKUP_FILE is required}"
DATABASE_BACKUP_MANIFEST="${DATABASE_BACKUP_MANIFEST:?DATABASE_BACKUP_MANIFEST is required}"
DATABASE_BACKUP_OFF_VPS_RECEIPT="${DATABASE_BACKUP_OFF_VPS_RECEIPT:?DATABASE_BACKUP_OFF_VPS_RECEIPT is required}"
POSTGRES_BACKUP_TOOL="${POSTGRES_BACKUP_TOOL:?POSTGRES_BACKUP_TOOL is required}"
EXPECTED_POSTGRES_BACKUP_TOOL_SHA256="${EXPECTED_POSTGRES_BACKUP_TOOL_SHA256:?EXPECTED_POSTGRES_BACKUP_TOOL_SHA256 is required}"
EXPECTED_SAME_BUILD_REPLAY_JOURNAL_SHA256="${EXPECTED_SAME_BUILD_REPLAY_JOURNAL_SHA256:?EXPECTED_SAME_BUILD_REPLAY_JOURNAL_SHA256 is required}"

EXPECTED_CURRENT_API_CONTAINER_ID="${EXPECTED_CURRENT_API_CONTAINER_ID:?EXPECTED_CURRENT_API_CONTAINER_ID is required}"
EXPECTED_CURRENT_API_IMAGE_ID="${EXPECTED_CURRENT_API_IMAGE_ID:?EXPECTED_CURRENT_API_IMAGE_ID is required}"
EXPECTED_CURRENT_WORKER_CONTAINER_ID="${EXPECTED_CURRENT_WORKER_CONTAINER_ID:?EXPECTED_CURRENT_WORKER_CONTAINER_ID is required}"
EXPECTED_CURRENT_WORKER_IMAGE_ID="${EXPECTED_CURRENT_WORKER_IMAGE_ID:?EXPECTED_CURRENT_WORKER_IMAGE_ID is required}"
EXPECTED_CURRENT_NODE_API_CONTAINER_ID="${EXPECTED_CURRENT_NODE_API_CONTAINER_ID:?EXPECTED_CURRENT_NODE_API_CONTAINER_ID is required}"
EXPECTED_CURRENT_NODE_API_IMAGE_ID="${EXPECTED_CURRENT_NODE_API_IMAGE_ID:?EXPECTED_CURRENT_NODE_API_IMAGE_ID is required}"
EXPECTED_CURRENT_SWEEPER_CONTAINER_ID="${EXPECTED_CURRENT_SWEEPER_CONTAINER_ID:?EXPECTED_CURRENT_SWEEPER_CONTAINER_ID is required}"
EXPECTED_CURRENT_SWEEPER_IMAGE_ID="${EXPECTED_CURRENT_SWEEPER_IMAGE_ID:?EXPECTED_CURRENT_SWEEPER_IMAGE_ID is required}"
EXPECTED_CURRENT_MEDIA_REPAIR_CONTAINER_ID="${EXPECTED_CURRENT_MEDIA_REPAIR_CONTAINER_ID:?EXPECTED_CURRENT_MEDIA_REPAIR_CONTAINER_ID is required}"
EXPECTED_CURRENT_MEDIA_REPAIR_IMAGE_ID="${EXPECTED_CURRENT_MEDIA_REPAIR_IMAGE_ID:?EXPECTED_CURRENT_MEDIA_REPAIR_IMAGE_ID is required}"
EXPECTED_CURRENT_POSTGRES_CONTAINER_ID="${EXPECTED_CURRENT_POSTGRES_CONTAINER_ID:?EXPECTED_CURRENT_POSTGRES_CONTAINER_ID is required}"
EXPECTED_CURRENT_POSTGRES_IMAGE_ID="${EXPECTED_CURRENT_POSTGRES_IMAGE_ID:?EXPECTED_CURRENT_POSTGRES_IMAGE_ID is required}"
EXPECTED_RESULTS_VOLUME_IDENTITY_SHA256="${EXPECTED_RESULTS_VOLUME_IDENTITY_SHA256:?EXPECTED_RESULTS_VOLUME_IDENTITY_SHA256 is required}"
ADMIN_COOKIE="${ADMIN_COOKIE:?ADMIN_COOKIE is required}"
DEPLOY_LOCK_HELD="${DEPLOY_LOCK_HELD:-0}"

BOUND_REVISION="63385777be7323777906fde44bdb9fa9b5cc0d6d"
BOUND_TREE="52c8bd3aa6d5a05dcd70a90d8896fb771f7fc36d129e698be0c935680e3fff36"
BOUND_COUNT="2198"
CURRENT_REVISION="cd0967a1ba4ef82113d6b1eae9e38f0a7baec3a2"
CURRENT_TREE="1a7cadf8a0981c3894ced26458cdf373a428e28592070fc7f81cc873b2a9af1f"
CURRENT_COUNT="2204"
CURRENT_BUILD_ID="prod-20260717-cd0967a1ba4e-r3"
CURRENT_API_CONTAINER_ID="8c09f2cf019c568b459fcdb7af595a5e13ad8c59f0ed55ff58f34bb506b848a5"
CURRENT_WORKER_CONTAINER_ID="41ae0007b8c19f0d29616d7304b86a38f23346b3940a5178f565dfe2b9ff931f"
CURRENT_NODE_CONTAINER_ID="23f5f7b9ed07eea74f7eca57247fd9cf03ebf9c179620f3fc3e628be806b2016"
CURRENT_SWEEPER_CONTAINER_ID="3826d16a6b7f40aea3518bee6b1e36ee8721ec48c3cf284e7269f30e44fcdd7e"
CURRENT_MEDIA_CONTAINER_ID="5c3fb047e7e67fddbeb79163576035c6b53821f69e7950df7ee2511130eedb42"
CURRENT_POSTGRES_CONTAINER_ID="11bdf1c7443dbe16f5c974be430d8c9624a6819b7e322103f75230944aba1f1d"
CURRENT_API_IMAGE_ID="sha256:236cb522879087a412103b3dceb1ef83fa7964e5c628497dbeb251c60d5cca98"
CURRENT_WORKER_IMAGE_ID="sha256:2705edcca4d60c0fc81f7cab0635d582e14cdc08a8ce97e7d78a89857451dccc"
CURRENT_NODE_IMAGE_ID="sha256:89069188e2e57cad231dcf3527eaba2e5151b0886921eac4f720d589d09e66af"
POOL_ID="3f8bc764-09ae-4ff3-8fd2-260600000001"
NODE_REPAIR_JOURNAL="$AIRFOILS_PRO_STATE_DIR/pending-cutover-node-api-repair.json"
QUEUE_REPAIR_JOURNAL="$AIRFOILS_PRO_STATE_DIR/pending-cutover-queue-probe-resume.json"
SAME_BUILD_REPLAY_JOURNAL="$AIRFOILS_PRO_STATE_DIR/pending-opencfd2606-rebuild-replay.json"
RETENTION_RETRY_JOURNAL="$AIRFOILS_PRO_STATE_DIR/pending-opencfd2606-retention-retry.json"
RECOVERY_JOURNAL="$AIRFOILS_PRO_STATE_DIR/pending-cutover-canary-db-ack-r4-recovery.json"
MEDIA_QUIESCE_JOURNAL="$AIRFOILS_PRO_STATE_DIR/pending-cutover-canary-db-ack-r4-media-quiesce.json"
CANARY_RECEIPT="$AIRFOILS_PRO_STATE_DIR/openfoam-2606-canary-receipt.pending.json"

fail() {
  echo "$1" >&2
  exit "${2:-14}"
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

for value in \
  "$EXPECTED_TARGET_SOURCE_TREE_SHA256" "$EXPECTED_TARGET_CHANGESET_SHA256" \
  "$EXPECTED_TARGET_REBUILD_SHA256" "$EXPECTED_TARGET_CANARY_SHA256" \
  "$EXPECTED_TARGET_MIGRATION_SHA256" "$EXPECTED_TARGET_MIGRATION_VERIFIER_SHA256" \
  "$EXPECTED_TARGET_CONTRACT_HELPER_SHA256" "$EXPECTED_TARGET_RECOVERY_RUNNER_SHA256" \
  "$EXPECTED_TARGET_BACKUP_HOOK_SHA256" "$EXPECTED_TARGET_COMPOSE_SHA256" \
  "$EXPECTED_POSTGRES_BACKUP_TOOL_SHA256" \
  "$EXPECTED_SAME_BUILD_REPLAY_JOURNAL_SHA256" \
  "$EXPECTED_RESULTS_VOLUME_IDENTITY_SHA256"; do
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || fail "Every reviewed SHA-256 input must be exact lowercase hexadecimal." 2
done
[[ "$EXPECTED_TARGET_SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || fail "Target revision must be an exact lowercase commit SHA." 2
[[ "$EXPECTED_TARGET_SOURCE_FILE_COUNT" =~ ^[1-9][0-9]*$ ]] || fail "Target source file count must be a positive integer." 2
[[ "$BUILD_ID" == "prod-20260717-${EXPECTED_TARGET_SOURCE_REVISION:0:12}-r4" ]] || fail "BUILD_ID must be the exact target-bound r4 identifier." 2
for value in \
  "$EXPECTED_CURRENT_API_CONTAINER_ID" "$EXPECTED_CURRENT_WORKER_CONTAINER_ID" \
  "$EXPECTED_CURRENT_NODE_API_CONTAINER_ID" "$EXPECTED_CURRENT_SWEEPER_CONTAINER_ID" \
  "$EXPECTED_CURRENT_MEDIA_REPAIR_CONTAINER_ID" \
  "$EXPECTED_CURRENT_POSTGRES_CONTAINER_ID"; do
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || fail "Current container identities must be full 64-character IDs." 2
done
[[ "$EXPECTED_CURRENT_API_CONTAINER_ID" == "$CURRENT_API_CONTAINER_ID" \
  && "$EXPECTED_CURRENT_WORKER_CONTAINER_ID" == "$CURRENT_WORKER_CONTAINER_ID" \
  && "$EXPECTED_CURRENT_NODE_API_CONTAINER_ID" == "$CURRENT_NODE_CONTAINER_ID" \
  && "$EXPECTED_CURRENT_SWEEPER_CONTAINER_ID" == "$CURRENT_SWEEPER_CONTAINER_ID" \
  && "$EXPECTED_CURRENT_MEDIA_REPAIR_CONTAINER_ID" == "$CURRENT_MEDIA_CONTAINER_ID" \
  && "$EXPECTED_CURRENT_POSTGRES_CONTAINER_ID" == "$CURRENT_POSTGRES_CONTAINER_ID" ]] \
  || fail "Current container identities differ from the failed r3 retention journal inventory."
[[ "$EXPECTED_CURRENT_API_IMAGE_ID" == "$CURRENT_API_IMAGE_ID" \
  && "$EXPECTED_CURRENT_WORKER_IMAGE_ID" == "$CURRENT_WORKER_IMAGE_ID" \
  && "$EXPECTED_CURRENT_NODE_API_IMAGE_ID" == "$CURRENT_NODE_IMAGE_ID" ]] \
  || fail "Current API/worker/Node images differ from the failed r3 retention runtime."
for value in \
  "$EXPECTED_CURRENT_API_IMAGE_ID" "$EXPECTED_CURRENT_WORKER_IMAGE_ID" \
  "$EXPECTED_CURRENT_NODE_API_IMAGE_ID" "$EXPECTED_CURRENT_SWEEPER_IMAGE_ID" \
  "$EXPECTED_CURRENT_MEDIA_REPAIR_IMAGE_ID" \
  "$EXPECTED_CURRENT_POSTGRES_IMAGE_ID"; do
  [[ "$value" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "Current image identities must be exact sha256 IDs." 2
done
if [[ "$ADMIN_COOKIE" == *$'\n'* || "$ADMIN_COOKIE" == *$'\r'* || "$ADMIN_COOKIE" == *'"'* ]]; then
  fail "ADMIN_COOKIE contains characters unsafe for the fail-safe request." 2
fi

# Lock before reading any mutable source, journal, container, database, or
# marker state.  An outer operator transaction may acquire descriptor 9 before
# invoking this wrapper; otherwise the wrapper acquires it itself. The same
# descriptor remains held while media-repair stops, the fresh backup hook runs,
# every proof is fsynced, and rebuild-engine.sh performs all recreates.
if [[ "$DEPLOY_LOCK_HELD" == "1" ]]; then
  inherited_target="$(readlink -f "/proc/$$/fd/9" 2>/dev/null || true)"
  expected_target="$(readlink -f "$LOCK_FILE" 2>/dev/null || true)"
  [[ -n "$inherited_target" && "$inherited_target" == "$expected_target" ]] || fail "DEPLOY_LOCK_HELD=1 requires inherited descriptor 9 for the canonical lock." 9
  flock -n 9 || fail "Inherited descriptor 9 is not held by this recovery transaction." 9
elif [[ "$DEPLOY_LOCK_HELD" == "0" ]]; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "Another Airfoils.Pro deploy is already running." 9
else
  fail "DEPLOY_LOCK_HELD must be 0 or 1." 2
fi

[[ -L "$APP_DIR" ]] || fail "APP_DIR must remain the bound production release symlink." 2
[[ -d "$AIRFOILS_PRO_STATE_DIR" && ! -L "$AIRFOILS_PRO_STATE_DIR" ]] || fail "Protected state directory is missing or unsafe." 2
[[ "$(stat -c '%a' "$AIRFOILS_PRO_STATE_DIR")" == "700" && "$(stat -c '%u' "$AIRFOILS_PRO_STATE_DIR")" == "$(id -u)" ]] || fail "Protected state directory must be owner-controlled mode 0700." 2
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" && "$(stat -c '%a' "$ENV_FILE")" == "600" && "$(stat -c '%u' "$ENV_FILE")" == "$(id -u)" ]] || fail "Deployment environment must be an owner-controlled mode-0600 regular file." 2
[[ -d "$CURRENT_SOURCE_DIR" && ! -L "$CURRENT_SOURCE_DIR" ]] || fail "Current r3 source is missing or unsafe." 2
[[ -d "$STAGING_DIR" && ! -L "$STAGING_DIR" ]] || fail "Staging source is missing or unsafe." 2

app_real="$(readlink -f "$APP_DIR")"
current_real="$(realpath "$CURRENT_SOURCE_DIR")"
staging_real="$(realpath "$STAGING_DIR")"
[[ -d "$app_real" && ! -L "$app_real" ]] || fail "Bound source is missing or unsafe." 2
[[ "$app_real" != "$current_real" && "$app_real" != "$staging_real" && "$current_real" != "$staging_real" ]] || fail "Bound, current, and target source directories must be distinct." 2

manifest_tool="$app_real/scripts/deploy/deployment-source-manifest.py"
contract_helper="$staging_real/scripts/deploy/pending-cutover-canary-db-ack-recovery.py"
rebuild_script="$staging_real/scripts/deploy/rebuild-engine.sh"
canary_script="$staging_real/scripts/deploy/openfoam_2606_canary.py"
migration_file="$staging_real/packages/db/migrations/0072_canary_evidence_database_ack.sql"
migration_verifier="$staging_real/scripts/deploy/verify-opencfd2606-canary-migration.sh"
recovery_runner="$staging_real/scripts/deploy/recover-pending-opencfd2606-canary-db-ack.sh"
backup_and_copy_hook="$staging_real/scripts/deploy/create-verified-canary-postgres-backup.sh"
compose_file="$staging_real/docker-compose.deploy.yml"

for required in "$manifest_tool" "$contract_helper" "$rebuild_script" "$canary_script" \
  "$migration_file" "$migration_verifier" "$recovery_runner" "$compose_file" \
  "$backup_and_copy_hook" "$POSTGRES_BACKUP_TOOL" \
  "$app_real/.deployment-source.json" "$current_real/.deployment-source.json" \
  "$current_real/docker-compose.deploy.yml"; do
  [[ -f "$required" && ! -L "$required" ]] || fail "Required bound/staged source file is missing or unsafe: $required" 2
done
[[ -x "$contract_helper" && -x "$rebuild_script" && -x "$migration_verifier" && -x "$recovery_runner" && -x "$backup_and_copy_hook" ]] || fail "Reviewed recovery executables lost their executable mode." 2
[[ "$POSTGRES_BACKUP_TOOL" == /* ]] || fail "Reviewed Postgres backup tool must use an absolute path." 2

[[ "$(sha256_file "$contract_helper")" == "$EXPECTED_TARGET_CONTRACT_HELPER_SHA256" ]] || fail "Recovery contract helper differs from its reviewed digest."
[[ "$(sha256_file "$rebuild_script")" == "$EXPECTED_TARGET_REBUILD_SHA256" ]] || fail "Rebuild runner differs from its reviewed digest."
[[ "$(sha256_file "$canary_script")" == "$EXPECTED_TARGET_CANARY_SHA256" ]] || fail "Canary differs from its reviewed digest."
[[ "$(sha256_file "$migration_file")" == "$EXPECTED_TARGET_MIGRATION_SHA256" ]] || fail "Migration 0072 differs from its reviewed digest."
[[ "$(sha256_file "$migration_verifier")" == "$EXPECTED_TARGET_MIGRATION_VERIFIER_SHA256" ]] || fail "Migration verifier differs from its reviewed digest."
[[ "$(sha256_file "$recovery_runner")" == "$EXPECTED_TARGET_RECOVERY_RUNNER_SHA256" ]] || fail "Recovery runner differs from its reviewed digest."
[[ "$(sha256_file "$backup_and_copy_hook")" == "$EXPECTED_TARGET_BACKUP_HOOK_SHA256" ]] || fail "Canonical backup/copy hook differs from its reviewed digest."
[[ "$(sha256_file "$compose_file")" == "$EXPECTED_TARGET_COMPOSE_SHA256" ]] || fail "Staged Compose definition differs from its reviewed digest."
[[ "$(sha256_file "$POSTGRES_BACKUP_TOOL")" == "$EXPECTED_POSTGRES_BACKUP_TOOL_SHA256" ]] || fail "Postgres backup tool differs from its reviewed digest."

python3 - "$app_real" "$current_real" "$staging_real" "$AIRFOILS_PRO_STATE_DIR" "$DATABASE_BACKUP_FILE" \
  "$DATABASE_BACKUP_MANIFEST" "$DATABASE_BACKUP_OFF_VPS_RECEIPT" <<'PY'
from pathlib import Path
import os
import stat
import sys

sources = [Path(value).resolve(strict=True) for value in sys.argv[1:4]]
state = Path(sys.argv[4]).resolve(strict=True)
paths = [Path(value) for value in sys.argv[5:]]
for path in paths:
    if not path.is_absolute():
        raise SystemExit("backup and receipt destinations must be absolute")
    resolved_parent = path.parent.resolve(strict=True)
    for source in sources:
        try:
            resolved_parent.relative_to(source)
        except ValueError:
            continue
        raise SystemExit("backup and receipt destinations cannot live in a source tree")
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        if os.path.lexists(current) and current.is_symlink():
            raise SystemExit(f"backup destination has a symlink component: {current}")
    if path != paths[-1]:
        try:
            resolved_parent.relative_to(state)
        except ValueError:
            raise SystemExit("database backup and manifest must live under protected state")
PY

work_dir="$(mktemp -d "$AIRFOILS_PRO_STATE_DIR/.canary-db-ack-recovery.XXXXXX")"
chmod 700 "$work_dir"
cleanup_work_dir() {
  python3 - "$work_dir" <<'PY'
from pathlib import Path
import shutil
import sys

path = Path(sys.argv[1])
if path.is_symlink() or path.parent.is_symlink():
    raise SystemExit("refusing unsafe recovery temporary cleanup")
shutil.rmtree(path, ignore_errors=False)
PY
}
trap cleanup_work_dir EXIT

source_contract="$work_dir/source.json"
"$contract_helper" source \
  --manifest-tool "$manifest_tool" \
  --bound-root "$app_real" --bound-manifest "$app_real/.deployment-source.json" \
  --current-root "$current_real" --current-manifest "$current_real/.deployment-source.json" \
  --target-root "$staging_real" --target-manifest "$staging_real/.deployment-source.json" \
  --expected-target-revision "$EXPECTED_TARGET_SOURCE_REVISION" \
  --expected-target-tree "$EXPECTED_TARGET_SOURCE_TREE_SHA256" \
  --expected-target-count "$EXPECTED_TARGET_SOURCE_FILE_COUNT" \
  --expected-changeset-sha256 "$EXPECTED_TARGET_CHANGESET_SHA256" \
  --expected-file-hash "scripts/deploy/rebuild-engine.sh=$EXPECTED_TARGET_REBUILD_SHA256" \
  --expected-file-hash "scripts/deploy/openfoam_2606_canary.py=$EXPECTED_TARGET_CANARY_SHA256" \
  --expected-file-hash "packages/db/migrations/0072_canary_evidence_database_ack.sql=$EXPECTED_TARGET_MIGRATION_SHA256" \
  --expected-file-hash "scripts/deploy/verify-opencfd2606-canary-migration.sh=$EXPECTED_TARGET_MIGRATION_VERIFIER_SHA256" \
  --expected-file-hash "scripts/deploy/pending-cutover-canary-db-ack-recovery.py=$EXPECTED_TARGET_CONTRACT_HELPER_SHA256" \
  --expected-file-hash "scripts/deploy/recover-pending-opencfd2606-canary-db-ack.sh=$EXPECTED_TARGET_RECOVERY_RUNNER_SHA256" \
  --expected-file-hash "scripts/deploy/create-verified-canary-postgres-backup.sh=$EXPECTED_TARGET_BACKUP_HOOK_SHA256" \
  --expected-file-hash "docker-compose.deploy.yml=$EXPECTED_TARGET_COMPOSE_SHA256" \
  >"$source_contract"

predecessors="$work_dir/predecessors.json"
"$contract_helper" predecessors \
  --node-journal "$NODE_REPAIR_JOURNAL" \
  --queue-journal "$QUEUE_REPAIR_JOURNAL" \
  --same-build-journal "$SAME_BUILD_REPLAY_JOURNAL" \
  --retention-journal "$RETENTION_RETRY_JOURNAL" \
  --expected-same-build-journal-sha256 "$EXPECTED_SAME_BUILD_REPLAY_JOURNAL_SHA256" \
  >"$predecessors"

read_state() {
  python3 - "$ENV_FILE" <<'PY'
import json
from pathlib import Path
import sys

keys = {
    "OPENCFD2606_CUTOVER_PENDING",
    "OPENCFD2606_CUTOVER_COMPLETE",
    "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING",
    "OPENCFD2606_CANARY_ATTESTATION_ID",
    "OPENCFD2606_CANARY_RECEIPT_EXPECTED",
    "OPENCFD2606_CUTOVER_SOURCE_REVISION",
    "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256",
    "AIRFOILFOAM_BUILD_ID",
    "ENGINE_EXPECTED_BUILD_ID",
}
values = {}
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    if "=" not in line:
        continue
    key, value = line.split("=", 1)
    if key not in keys:
        continue
    if key in values:
        raise SystemExit(f"duplicate recovery environment key: {key}")
    values[key] = value
print(json.dumps(values, sort_keys=True, separators=(",", ":")))
PY
}

initial_state="$work_dir/state-initial.json"
read_state >"$initial_state"
python3 - "$initial_state" "$CURRENT_REVISION" "$CURRENT_TREE" "$CURRENT_BUILD_ID" <<'PY'
import json
from pathlib import Path
import sys

state = json.loads(Path(sys.argv[1]).read_text())
expected = {
    "OPENCFD2606_CUTOVER_PENDING": "1",
    "OPENCFD2606_CUTOVER_COMPLETE": "0",
    "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING": "0",
    "OPENCFD2606_CANARY_ATTESTATION_ID": "",
    "OPENCFD2606_CANARY_RECEIPT_EXPECTED": "0",
    "OPENCFD2606_CUTOVER_SOURCE_REVISION": sys.argv[2],
    "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256": sys.argv[3],
    "AIRFOILFOAM_BUILD_ID": sys.argv[4],
    "ENGINE_EXPECTED_BUILD_ID": sys.argv[4],
}
if state != expected:
    raise SystemExit("recovery requires the exact failed-r3 pending-pristine marker tuple")
PY
[[ ! -e "$CANARY_RECEIPT" && ! -L "$CANARY_RECEIPT" ]] || fail "A canary receipt exists; this pristine incident runner cannot select its replay semantics."

service_args=(
  --expected-service "api=$EXPECTED_CURRENT_API_CONTAINER_ID,$EXPECTED_CURRENT_API_IMAGE_ID"
  --expected-service "worker=$EXPECTED_CURRENT_WORKER_CONTAINER_ID,$EXPECTED_CURRENT_WORKER_IMAGE_ID"
  --expected-service "node-api=$EXPECTED_CURRENT_NODE_API_CONTAINER_ID,$EXPECTED_CURRENT_NODE_API_IMAGE_ID"
  --expected-service "sweeper=$EXPECTED_CURRENT_SWEEPER_CONTAINER_ID,$EXPECTED_CURRENT_SWEEPER_IMAGE_ID"
  --expected-service "media-repair=$EXPECTED_CURRENT_MEDIA_REPAIR_CONTAINER_ID,$EXPECTED_CURRENT_MEDIA_REPAIR_IMAGE_ID"
  --expected-service "postgres=$EXPECTED_CURRENT_POSTGRES_CONTAINER_ID,$EXPECTED_CURRENT_POSTGRES_IMAGE_ID"
)

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi
compose_current() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" \
    --project-directory "$current_real" -f "$current_real/docker-compose.deploy.yml" "$@"
}
compose_target() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" \
    --project-directory "$staging_real" -f "$compose_file" "$@"
}

capture_runtime() {
  local destination="$1" stage="$2" media_running="$3"
  "$contract_helper" runtime \
    --env-file "$ENV_FILE" --compose-file "$current_real/docker-compose.deploy.yml" \
    --project-directory "$current_real" --stage "$stage" \
    "${service_args[@]}" --expected-running "media-repair=$media_running" \
    --expected-volume-sha256 "$EXPECTED_RESULTS_VOLUME_IDENTITY_SHA256" \
    >"$destination"
}

media_identity="$work_dir/media-identity.json"
python3 - "$source_contract" "$predecessors" \
  "$EXPECTED_CURRENT_MEDIA_REPAIR_CONTAINER_ID" "$EXPECTED_CURRENT_MEDIA_REPAIR_IMAGE_ID" \
  "$EXPECTED_RESULTS_VOLUME_IDENTITY_SHA256" "$EXPECTED_TARGET_BACKUP_HOOK_SHA256" \
  "$EXPECTED_POSTGRES_BACKUP_TOOL_SHA256" <<'PY' >"$media_identity"
import json
from pathlib import Path
import sys

source = json.loads(Path(sys.argv[1]).read_text())
predecessors = json.loads(Path(sys.argv[2]).read_text())
payload = {
    "targetSourceRevision": source["targetSourceRevision"],
    "targetSourceTreeSha256": source["targetSourceTreeSha256"],
    "sourceChangeSha256": source["sourceChangeSha256"],
    "predecessorJournalSha256s": {
        key: value for key, value in predecessors.items() if key.endswith("JournalSha256")
    },
    "initialMediaRepairState": "running",
    "mediaRepairContainerId": sys.argv[3],
    "mediaRepairImageId": sys.argv[4],
    "resultsVolumeIdentitySha256": sys.argv[5],
    "backupAndCopyHookSha256": sys.argv[6],
    "postgresBackupToolSha256": sys.argv[7],
}
print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
PY

media_status=""
if [[ -e "$MEDIA_QUIESCE_JOURNAL" || -L "$MEDIA_QUIESCE_JOURNAL" ]]; then
  media_status="$(python3 - "$MEDIA_QUIESCE_JOURNAL" "$media_identity" <<'PY'
import json
from pathlib import Path
import stat
import sys

path = Path(sys.argv[1])
metadata = path.lstat()
if path.is_symlink() or not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600:
    raise SystemExit("media-quiesce journal is unsafe")
payload = json.loads(path.read_text())
identity = json.loads(Path(sys.argv[2]).read_text())
if payload.get("schemaVersion") != 1 or payload.get("purpose") != "pending-opencfd2606-canary-db-ack-r4-media-quiesce" or payload.get("identity") != identity:
    raise SystemExit("media-quiesce journal identity changed")
status = payload.get("status")
if status not in {"prepared", "stopped-for-backup", "backup-verified"}:
    raise SystemExit("media-quiesce journal is not replayable")
print(status)
PY
)"
else
  runtime_before_media_stop="$work_dir/runtime-before-media-stop.json"
  capture_runtime "$runtime_before_media_stop" before-media-quiesce true
  runtime_before_media_stop_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["snapshotSha256"])' "$runtime_before_media_stop")"
  "$contract_helper" media-quiesce --path "$MEDIA_QUIESCE_JOURNAL" \
    --identity-json "$media_identity" --status prepared \
    --runtime-snapshot-sha256 "$runtime_before_media_stop_sha" >/dev/null
  media_status="prepared"
fi

runtime_one="$work_dir/runtime-one.json"
if [[ "$media_status" == "prepared" ]]; then
  compose_current stop media-repair
  capture_runtime "$runtime_one" media-stopped-before-backup false
  runtime_one_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["snapshotSha256"])' "$runtime_one")"
  "$contract_helper" media-quiesce --path "$MEDIA_QUIESCE_JOURNAL" \
    --identity-json "$media_identity" --status stopped-for-backup \
    --runtime-snapshot-sha256 "$runtime_one_sha" >/dev/null
  media_status="stopped-for-backup"
else
  capture_runtime "$runtime_one" media-remains-stopped-before-backup false
  runtime_one_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["snapshotSha256"])' "$runtime_one")"
fi

python3 - "$predecessors" "$runtime_one" <<'PY'
import json
from pathlib import Path
import sys

predecessors = json.loads(Path(sys.argv[1]).read_text())
runtime = json.loads(Path(sys.argv[2]).read_text())
expected = {
    "node-api": (
        predecessors["retentionRetryNodeContainerAfter"],
        predecessors["retentionRetryNodeImage"],
    ),
    "api": (runtime["services"]["api"]["containerId"], predecessors["retentionRetryApiImage"]),
    "worker": (
        runtime["services"]["worker"]["containerId"],
        predecessors["retentionRetryWorkerImage"],
    ),
}
for service, (container_id, image_id) in expected.items():
    actual = runtime["services"][service]
    if actual["containerId"] != container_id or actual["imageId"] != image_id:
        raise SystemExit(f"live {service} does not match the failed retention-retry journal")
PY

backup_not_before="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["stoppedAt"])' "$MEDIA_QUIESCE_JOURNAL")"
if [[ "$media_status" == "stopped-for-backup" ]]; then
  ENV_FILE="$ENV_FILE" COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
    COMPOSE_FILE="$current_real/docker-compose.deploy.yml" COMPOSE_PROJECT_DIRECTORY="$current_real" \
    DATABASE_BACKUP_FILE="$DATABASE_BACKUP_FILE" \
    DATABASE_BACKUP_MANIFEST="$DATABASE_BACKUP_MANIFEST" \
    DATABASE_BACKUP_OFF_VPS_RECEIPT="$DATABASE_BACKUP_OFF_VPS_RECEIPT" \
    EXPECTED_POSTGRES_CONTAINER_ID="$EXPECTED_CURRENT_POSTGRES_CONTAINER_ID" \
    EXPECTED_POSTGRES_IMAGE_ID="$EXPECTED_CURRENT_POSTGRES_IMAGE_ID" \
    POSTGRES_BACKUP_TOOL="$POSTGRES_BACKUP_TOOL" \
    EXPECTED_POSTGRES_BACKUP_TOOL_SHA256="$EXPECTED_POSTGRES_BACKUP_TOOL_SHA256" \
    MEDIA_QUIESCE_JOURNAL="$MEDIA_QUIESCE_JOURNAL" DEPLOY_LOCK_HELD=1 \
    "$backup_and_copy_hook"
elif [[ "$media_status" != "backup-verified" ]]; then
  fail "Media quiesce state cannot authorize backup creation."
fi

for path in "$DATABASE_BACKUP_FILE" "$DATABASE_BACKUP_MANIFEST" "$DATABASE_BACKUP_OFF_VPS_RECEIPT"; do
  [[ -f "$path" && ! -L "$path" ]] || fail "Backup/copy hook did not publish its required regular artifact: $path"
done
actual_backup_sha="$(sha256_file "$DATABASE_BACKUP_FILE")"
actual_backup_manifest_sha="$(sha256_file "$DATABASE_BACKUP_MANIFEST")"
actual_backup_receipt_sha="$(sha256_file "$DATABASE_BACKUP_OFF_VPS_RECEIPT")"
backup_proof="$work_dir/backup.json"
"$contract_helper" backup \
  --backup "$DATABASE_BACKUP_FILE" --manifest "$DATABASE_BACKUP_MANIFEST" \
  --off-vps-receipt "$DATABASE_BACKUP_OFF_VPS_RECEIPT" \
  --expected-backup-sha256 "$actual_backup_sha" \
  --expected-manifest-sha256 "$actual_backup_manifest_sha" \
  --expected-receipt-sha256 "$actual_backup_receipt_sha" \
  --expected-postgres-container-id "$EXPECTED_CURRENT_POSTGRES_CONTAINER_ID" \
  --expected-postgres-image-id "$EXPECTED_CURRENT_POSTGRES_IMAGE_ID" \
  --not-before "$backup_not_before" >"$backup_proof"
backup_proof_sha="$(sha256_file "$backup_proof")"
if [[ "$media_status" == "stopped-for-backup" ]]; then
  "$contract_helper" media-quiesce --path "$MEDIA_QUIESCE_JOURNAL" \
    --identity-json "$media_identity" --status backup-verified \
    --runtime-snapshot-sha256 "$runtime_one_sha" \
    --backup-proof-sha256 "$backup_proof_sha" >/dev/null
else
  expected_backup_proof_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["backupProofSha256"])' "$MEDIA_QUIESCE_JOURNAL")"
  [[ "$backup_proof_sha" == "$expected_backup_proof_sha" ]] || fail "Previously verified backup proof changed during replay."
fi

# A second independent idle/container/image/volume sample closes the interval
# between backup proof and the delegated build.  Both samples must resolve to
# the exact current r3 identities bound to the fourth incident journal.
runtime_two="$work_dir/runtime-two.json"
capture_runtime "$runtime_two" immediately-before-delegation false

predecessors_second="$work_dir/predecessors-second.json"
"$contract_helper" predecessors \
  --node-journal "$NODE_REPAIR_JOURNAL" \
  --queue-journal "$QUEUE_REPAIR_JOURNAL" \
  --same-build-journal "$SAME_BUILD_REPLAY_JOURNAL" \
  --retention-journal "$RETENTION_RETRY_JOURNAL" \
  --expected-same-build-journal-sha256 "$EXPECTED_SAME_BUILD_REPLAY_JOURNAL_SHA256" \
  >"$predecessors_second"
cmp -s "$predecessors" "$predecessors_second" || fail "Predecessor journals changed during recovery preflight."

identity="$work_dir/identity.json"
python3 - "$source_contract" "$predecessors" "$backup_proof" "$runtime_one" "$runtime_two" \
  "$BUILD_ID" "$EXPECTED_TARGET_MIGRATION_SHA256" <<'PY' >"$identity"
import json
from pathlib import Path
import sys

source, predecessor, backup, runtime_one, runtime_two = [
    json.loads(Path(path).read_text()) for path in sys.argv[1:6]
]
payload = {
    "source": source,
    "predecessors": predecessor,
    "backup": backup,
    "rollbackImages": {
        service: runtime_one["services"][service]["imageId"]
        for service in ("api", "worker", "node-api", "sweeper", "media-repair")
    },
    "rollbackContainers": {
        service: runtime_one["services"][service]["containerId"]
        for service in ("api", "worker", "node-api", "sweeper", "media-repair")
    },
    "rollbackImageTags": {
        service: (
            f"airfoils-pro-rollback-{service}:r3-to-r4-"
            f"{source['targetSourceRevision'][:12]}-{source['sourceChangeSha256'][:12]}"
        )
        for service in ("api", "worker", "node-api", "sweeper", "media-repair")
    },
    "postgresContainer": runtime_one["services"]["postgres"],
    "resultsVolumeIdentitySha256": runtime_one["resultsVolumeIdentitySha256"],
    "firstRuntimeSnapshotSha256": runtime_one["snapshotSha256"],
    "secondRuntimeSnapshotSha256": runtime_two["snapshotSha256"],
    "targetBuildId": sys.argv[6],
    "migration0072Sha256": sys.argv[7],
}
print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
PY

runtime_two_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["snapshotSha256"])' "$runtime_two")"
"$contract_helper" journal --path "$RECOVERY_JOURNAL" --identity-json "$identity" \
  --status prepared --phase pre-delegation --rollback-boundary pre-receipt-rollback-eligible \
  --runtime-snapshot-sha256 "$runtime_two_sha" >/dev/null

# Preserve every image that the guarded rebuild may replace under an immutable
# incident/target-specific tag. A preexisting tag is accepted only when it
# already resolves to the exact journalled image ID; a collision never gets
# overwritten. No prune is part of this recovery transaction.
preserve_rollback_image() {
  local service="$1" image_id="$2" rollback_tag="$3" current=""
  docker image inspect "$image_id" >/dev/null
  if current="$(docker image inspect --format '{{.Id}}' "$rollback_tag" 2>/dev/null)"; then
    [[ "$current" == "$image_id" ]] || fail "Rollback tag collision for $service: $rollback_tag"
  else
    docker image tag "$image_id" "$rollback_tag"
  fi
  current="$(docker image inspect --format '{{.Id}}' "$rollback_tag")"
  [[ "$current" == "$image_id" ]] || fail "Rollback tag verification failed for $service: $rollback_tag"
}

while IFS=$'\t' read -r rollback_service rollback_image rollback_tag; do
  preserve_rollback_image "$rollback_service" "$rollback_image" "$rollback_tag"
done < <(python3 - "$identity" <<'PY'
import json
from pathlib import Path
import sys

identity = json.loads(Path(sys.argv[1]).read_text())
for service in ("api", "worker", "node-api", "sweeper", "media-repair"):
    print(
        service,
        identity["rollbackImages"][service],
        identity["rollbackImageTags"][service],
        sep="\t",
    )
PY
)

FAIL_SAFE_ARMED=true
enforce_fail_safe() {
  local rc=$?
  trap - EXIT
  if ((rc != 0)) && [[ "$FAIL_SAFE_ARMED" == "true" ]]; then
    set +e
    echo "Canary DB-ACK recovery did not complete; enforcing stopped scheduler and disabled 2606 pool." >&2
    compose_target stop sweeper >/dev/null 2>&1 || echo "WARNING: could not stop sweeper during recovery fail-safe." >&2
    compose_target stop media-repair >/dev/null 2>&1 || echo "WARNING: could not keep media-repair stopped during recovery fail-safe." >&2
    printf 'header = "Cookie: %s"\n' "$ADMIN_COOKIE" | curl --config - \
      --fail-with-body -sS --max-time 30 -X PATCH \
      -H "Content-Type: application/json" -d '{"enabled":false}' \
      "http://127.0.0.1:4000/api/admin/solver-execution-pools/$POOL_ID" \
      >/dev/null 2>&1 || echo "WARNING: could not disable the 2606 pool during recovery fail-safe." >&2
  fi
  cleanup_work_dir
  exit "$rc"
}
trap enforce_fail_safe EXIT

"$contract_helper" journal --path "$RECOVERY_JOURNAL" --identity-json "$identity" \
  --status running --phase delegated-rebuild --rollback-boundary pre-receipt-rollback-eligible \
  --runtime-snapshot-sha256 "$runtime_two_sha" >/dev/null

set +e
APP_DIR="$current_real" AIRFOILS_PRO_STATE_DIR="$AIRFOILS_PRO_STATE_DIR" ENV_FILE="$ENV_FILE" \
  COMPOSE_FILE="$compose_file" COMPOSE_PROJECT_DIRECTORY="$staging_real" \
  COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" LOCK_FILE="$LOCK_FILE" \
  DEPLOY_LOCK_HELD=1 DEPLOYMENT_MANIFEST_FILE="$current_real/.deployment-source.json" \
  DEPLOY_SOURCE_REVISION="$CURRENT_REVISION" DEPLOY_SOURCE_TREE_SHA256="$CURRENT_TREE" \
  OPENCFD2606_POST_NODE_HEALTH_VERIFIER="$migration_verifier" \
  OPENCFD2606_MEDIA_REPAIR_RESTORE_STATE=running \
  EXPECTED_OPENCFD2606_MIGRATION_SHA256="$EXPECTED_TARGET_MIGRATION_SHA256" \
  OPENCFD2606_MIGRATION_FILE="$migration_file" ADMIN_COOKIE="$ADMIN_COOKIE" \
  "$rebuild_script" "$BUILD_ID"
rebuild_rc=$?
set -e

read_state >"$work_dir/state-final.json"
marker_integrity=true
if ! "$contract_helper" marker --state-json "$work_dir/state-final.json" \
  --expected-target-revision "$EXPECTED_TARGET_SOURCE_REVISION" \
  --expected-target-tree "$EXPECTED_TARGET_SOURCE_TREE_SHA256" \
  --expected-target-build-id "$BUILD_ID" >"$work_dir/marker-final.json"; then
  marker_integrity=false
fi
receipt_exists=false
if [[ -e "$CANARY_RECEIPT" || -L "$CANARY_RECEIPT" ]]; then
  receipt_exists=true
fi
boundary_json="$("$contract_helper" boundary --state-json "$work_dir/state-final.json" --receipt-exists "$receipt_exists")"
rollback_boundary="$(printf '%s' "$boundary_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["rollbackBoundary"])')"

predecessor_integrity=true
if ! "$contract_helper" predecessors --node-journal "$NODE_REPAIR_JOURNAL" \
  --queue-journal "$QUEUE_REPAIR_JOURNAL" \
  --same-build-journal "$SAME_BUILD_REPLAY_JOURNAL" \
  --retention-journal "$RETENTION_RETRY_JOURNAL" \
  --expected-same-build-journal-sha256 "$EXPECTED_SAME_BUILD_REPLAY_JOURNAL_SHA256" \
  >"$work_dir/predecessors-final.json" || \
  ! cmp -s "$predecessors" "$work_dir/predecessors-final.json"; then
  predecessor_integrity=false
  rollback_boundary="unknown-rollback-forbidden"
fi

if ((rebuild_rc == 0)) && [[ "$predecessor_integrity" == "true" && "$marker_integrity" == "true" ]]; then
  restored_media_ids="$(compose_target ps --status running -q media-repair)"
  [[ -n "$restored_media_ids" && "$(wc -l <<<"$restored_media_ids")" == "1" ]] || fail "Successful rebuild did not restore exactly one media-repair container."
  "$contract_helper" media-quiesce --path "$MEDIA_QUIESCE_JOURNAL" \
    --identity-json "$media_identity" --status completed \
    --runtime-snapshot-sha256 "$runtime_two_sha" >/dev/null
  "$contract_helper" journal --path "$RECOVERY_JOURNAL" --identity-json "$identity" \
    --status completed --phase rebuild-finished --exit-code 0 \
    --rollback-boundary "$rollback_boundary" >/dev/null
  FAIL_SAFE_ARMED=false
  echo "OpenCFD 2606 canary DB-ACK recovery runner completed."
  exit 0
fi

failure_rc="$rebuild_rc"
if [[ "$predecessor_integrity" != "true" ]]; then
  echo "Predecessor repair journals changed during delegated recovery." >&2
  failure_rc=14
fi
if [[ "$marker_integrity" != "true" ]]; then
  echo "Cutover marker no longer obeys the cd0967-until-terminal source contract." >&2
  failure_rc=14
  rollback_boundary="unknown-rollback-forbidden"
fi
"$contract_helper" journal --path "$RECOVERY_JOURNAL" --identity-json "$identity" \
  --status failed --phase rebuild-failed --exit-code "$failure_rc" \
  --rollback-boundary "$rollback_boundary" >/dev/null
if [[ "$rollback_boundary" == "pre-receipt-rollback-eligible" ]]; then
  echo "Failure occurred before a durable canary receipt; captured r3 image IDs remain eligible for an explicit reviewed rollback. No wrapper-side recreate was attempted." >&2
else
  echo "Failure crossed or could not disprove the durable canary-receipt boundary; image rollback is forbidden and exact receipt/DB replay state is retained." >&2
fi
exit "$failure_rc"
