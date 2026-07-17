#!/usr/bin/env bash
# Admit exactly one campaign-owned OpenCFD 2606 successor job while the normal
# sweeper service is stopped. The ordinary continuation-certification script
# remains responsible for clearing the cutover marker after evidence lands.
#
# Operator sequence (this script performs only step 2):
#   1. Replay canonical certification until the cutover is completed and its
#      continuation is pristine pending; an intentionally stopped scheduler
#      returns 14 without clearing the source-bound marker.
#   2. Run this helper with the exact campaign/attestation/plan/generation.
#   3. Start the sweeper service with its durable enabled switch still false;
#      it will reconcile/ingest this job but cannot admit a second one.
#   4. After the job publishes evidence, stop the sweeper and rerun canonical
#      certification. Only that canonical path may clear the marker.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ADMISSION_TOOL_ROOT="${ADMISSION_TOOL_ROOT:-$(cd -- "$SCRIPT_DIR/../.." && pwd -P)}"
ADMISSION_CORE_FILE="${ADMISSION_CORE_FILE:-$ADMISSION_TOOL_ROOT/apps/sweeper/src/successor-continuation-once.ts}"
ADMISSION_CLI_FILE="${ADMISSION_CLI_FILE:-$ADMISSION_TOOL_ROOT/apps/sweeper/src/successor-continuation-once-cli.ts}"
# Updated only when the two reviewed, additive one-shot source files change.
# The sealed target image supplies every ordinary scheduler dependency.
EXPECTED_ADMISSION_TOOL_SHA256="3a914de8cec03d3298a8a23217858e420b0364e0e2deb835db7bed61af82f806"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.deploy.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-app}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"
DEPLOYMENT_MANIFEST_FILE="${DEPLOYMENT_MANIFEST_FILE:-$APP_DIR/.deployment-source.json}"
OPENCFD2606_CANARY_RECEIPT_FILE="${OPENCFD2606_CANARY_RECEIPT_FILE:-$AIRFOILS_PRO_STATE_DIR/openfoam-2606-canary-receipt.pending.json}"
ADMIN_COOKIE="${ADMIN_COOKIE:-}"
CAMPAIGN_ID="${CAMPAIGN_ID:?CAMPAIGN_ID is required}"
CANARY_ATTESTATION_ID="${CANARY_ATTESTATION_ID:?CANARY_ATTESTATION_ID is required}"
TARGET_PLAN_REVISION_ID="${TARGET_PLAN_REVISION_ID:?TARGET_PLAN_REVISION_ID is required}"
TARGET_GENERATION="${TARGET_GENERATION:?TARGET_GENERATION is required}"
TARGET_POOL_ID="3f8bc764-09ae-4ff3-8fd2-260600000001"
CUTOVER_API_BASE="http://127.0.0.1:4000/api/admin/solver-engine-cutovers/opencfd-2606"

uuid_re='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
for value in "$CAMPAIGN_ID" "$CANARY_ATTESTATION_ID" "$TARGET_PLAN_REVISION_ID"; do
  [[ "$value" =~ $uuid_re ]] || {
    echo "Campaign, attestation, and target-plan inputs must be exact UUIDs." >&2
    exit 2
  }
done
[[ "$TARGET_GENERATION" =~ ^[1-9][0-9]*$ ]] || {
  echo "TARGET_GENERATION must be a positive integer." >&2
  exit 2
}
if [[ -z "$ADMIN_COOKIE" || "$ADMIN_COOKIE" == *$'\n'* || \
      "$ADMIN_COOKIE" == *$'\r'* || "$ADMIN_COOKIE" == *'"'* ]]; then
  echo "ADMIN_COOKIE must be a safe full Cookie header value." >&2
  exit 14
fi
for tool_file in "$ADMISSION_CORE_FILE" "$ADMISSION_CLI_FILE"; do
  [[ -f "$tool_file" && ! -L "$tool_file" ]] || {
    echo "Missing reviewed one-shot admission source: $tool_file" >&2
    exit 2
  }
done
admission_tool_digest() {
  {
    sha256sum "$ADMISSION_CORE_FILE" | cut -d' ' -f1
    sha256sum "$ADMISSION_CLI_FILE" | cut -d' ' -f1
  } | sha256sum | cut -d' ' -f1
}
admission_tool_sha256="$(admission_tool_digest)"
[[ "$admission_tool_sha256" == "$EXPECTED_ADMISSION_TOOL_SHA256" ]] || {
  echo "The additive one-shot admission source differs from its reviewed digest." >&2
  exit 14
}

exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "Another Airfoils.Pro deploy is already running." >&2
  exit 9
}

cd "$APP_DIR"
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi
compose() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" \
    -f "$COMPOSE_FILE" "$@"
}
admin_json() {
  local method="$1" url="$2" body="$3"
  printf 'header = "Cookie: %s"\n' "$ADMIN_COOKIE" | curl --config - \
    --fail-with-body -sS --max-time 30 -X "$method" \
    -H 'Content-Type: application/json' -d "$body" "$url"
}

manifest_tool="$APP_DIR/scripts/deploy/deployment-source-manifest.py"
state_tool="$APP_DIR/scripts/deploy/opencfd2606_cutover_state.py"
env_preflight="$APP_DIR/scripts/deploy/deployment-env-preflight.py"
for required in "$manifest_tool" "$state_tool" "$env_preflight" \
  "$DEPLOYMENT_MANIFEST_FILE" "$COMPOSE_FILE"; do
  [[ -f "$required" && ! -L "$required" ]] || {
    echo "Missing safe continuation-admission input: $required" >&2
    exit 2
  }
done
manifest_fields="$(python3 "$manifest_tool" --verify --root "$APP_DIR" \
  --manifest "$DEPLOYMENT_MANIFEST_FILE")"
IFS=$'\t' read -r source_revision source_tree_sha256 source_file_count \
  <<<"$manifest_fields"
[[ "$source_revision" =~ ^[0-9a-f]{40}$ && "$source_tree_sha256" =~ ^[0-9a-f]{64}$ && \
   "$source_file_count" =~ ^[1-9][0-9]*$ ]] || {
  echo "The sealed deployment source identity is malformed." >&2
  exit 2
}

# The one-shot files are mounted additively into a disposable container. Prove
# first that every ordinary sweeper and workspace-package source file in the
# base image is byte-for-byte the sealed pending-attested target source. This
# avoids promoting or substituting a later control-plane tree while the marker
# is bound to the old target.
source_digest_body='set -eu
cd "$1"
tmp_dir="$(mktemp -d)"
trap "rm -rf -- \"$tmp_dir\"" 0 1 2 15
find apps/sweeper/src packages -type f ! -path "*/node_modules/*" -print0 >"$tmp_dir/paths.unsorted"
LC_ALL=C sort -z "$tmp_dir/paths.unsorted" >"$tmp_dir/paths"
xargs -0 -r sha256sum <"$tmp_dir/paths" >"$tmp_dir/hashes"
sha256sum package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json apps/sweeper/package.json >>"$tmp_dir/hashes"
sha256sum "$tmp_dir/hashes" >"$tmp_dir/final"
cut -d" " -f1 "$tmp_dir/final"'
sealed_source_payload_sha256="$(bash -c "$source_digest_body" _ "$APP_DIR")"
image_source_payload_sha256="$(compose run --rm --no-deps -T sweeper \
  sh -c "$source_digest_body" _ /app)"
[[ "$sealed_source_payload_sha256" =~ ^[0-9a-f]{64}$ && \
   "$image_source_payload_sha256" == "$sealed_source_payload_sha256" ]] || {
  echo "The stopped sweeper image does not contain the exact sealed pending-attested scheduler source." >&2
  exit 14
}
python3 "$env_preflight" --app-dir "$APP_DIR" \
  --state-dir "$AIRFOILS_PRO_STATE_DIR" --env-file "$ENV_FILE" >/dev/null
python3 "$state_tool" --env-file "$ENV_FILE" \
  --receipt-file "$OPENCFD2606_CANARY_RECEIPT_FILE" \
  --current-source-revision "$source_revision" \
  --current-source-tree-sha256 "$source_tree_sha256" \
  --require-state pending-certifiable >/dev/null

running_sweeper="$(compose ps --status running -q sweeper)"
[[ -z "$running_sweeper" ]] || {
  echo "The looping sweeper must be stopped before one-shot admission." >&2
  exit 14
}
running_node_api="$(compose ps --status running -q node-api)"
[[ -n "$running_node_api" ]] || {
  echo "The authenticated control plane must be running for one-shot preflight." >&2
  exit 14
}
curl -fsS --max-time 10 http://127.0.0.1:4000/health >/dev/null
curl -fsS --max-time 10 http://127.0.0.1:8000/health >/dev/null

FAIL_SAFE_ARMED=true
NODE_API_QUIESCED=false
close_admission_direct() {
  local result terminal
  if ! result="$(compose exec -T postgres \
    psql -U aerodb -d aerodb -X -qAt -v ON_ERROR_STOP=1 \
    -v "pool_id=$TARGET_POOL_ID" <<'SQL'
BEGIN;
UPDATE sweeper_state SET enabled=false WHERE id=1;
UPDATE solver_execution_pools SET enabled=false WHERE id=:'pool_id'::uuid;
SELECT
  (SELECT count(*) FROM sweeper_state WHERE id=1 AND enabled=false)::text
  || '|'
  || (SELECT count(*) FROM solver_execution_pools
       WHERE id=:'pool_id'::uuid AND enabled=false)::text;
COMMIT;
SQL
  )"; then
    return 1
  fi
  terminal="$(printf '%s\n' "$result" | sed '/^[[:space:]]*$/d' | tail -n 1)"
  [[ "$terminal" == "1|1" ]]
}
restore_node_api() {
  # The preflight requires this exact container to exist and be running before
  # quiescence. `start` restores that stopped container without allowing Compose
  # to recreate it from a drifted image/configuration during the fail-safe.
  compose start node-api >/dev/null || return 1
  local attempt
  for ((attempt = 1; attempt <= 30; attempt++)); do
    if curl -fsS --max-time 5 http://127.0.0.1:4000/health >/dev/null; then
      NODE_API_QUIESCED=false
      return 0
    fi
    sleep 2
  done
  return 1
}
close_admission() {
  local rc=$?
  trap - EXIT
  if [[ "$FAIL_SAFE_ARMED" == "true" ]]; then
    local fail_safe_failed=false
    if ! compose stop sweeper >/dev/null 2>&1; then
      fail_safe_failed=true
    fi
    if ! close_admission_direct; then
      fail_safe_failed=true
    fi
    if [[ "$NODE_API_QUIESCED" == "true" ]] && ! restore_node_api; then
      fail_safe_failed=true
    fi
    if [[ "$fail_safe_failed" == "true" ]]; then
      echo "CRITICAL: successor admission failed and both admission fences/node-api recovery could not be confirmed." >&2
      exit 18
    fi
  fi
  exit "$rc"
}
trap close_admission EXIT

# The durable switch remains closed throughout. Only the explicit one-shot CLI
# below may compose work.
admin_json PATCH http://127.0.0.1:4000/api/admin/sweeper \
  '{"enabled":false}' >/dev/null
admin_json PATCH \
  "http://127.0.0.1:4000/api/admin/solver-execution-pools/$TARGET_POOL_ID" \
  '{"enabled":true}' >/dev/null

# This is more than a generic pool handshake: the continuation endpoint binds
# the live build, storage contract, campaign count, and immutable attestation.
continuation="$({ admin_json POST "$CUTOVER_API_BASE/continuation" \
  "{\"canaryAttestationId\":\"$CANARY_ATTESTATION_ID\"}"; })"
printf '%s' "$continuation" | python3 -c '
import json,sys
p=json.load(sys.stdin); expected_campaign=sys.argv[1]
if p.get("status") != "pending" or p.get("lastError") is not None:
    raise SystemExit("successor continuation is not pristine pending")
campaigns=p.get("campaigns")
if p.get("requiredCampaigns") != 1 or not isinstance(campaigns,list) or len(campaigns)!=1:
    raise SystemExit("continuation does not have exactly one required campaign")
c=campaigns[0]
if c.get("campaignId") != expected_campaign or c.get("status") != "pending" or c.get("simJobId") is not None or c.get("evidenceResultId") is not None or c.get("lastError") is not None:
    raise SystemExit("continuation campaign proof differs from the exact allowlist")
' "$CAMPAIGN_ID"

[[ "$(admission_tool_digest)" == "$admission_tool_sha256" ]] || {
  echo "The additive one-shot admission source changed after preflight." >&2
  exit 14
}
# From here through the exact postcondition, every ordinary campaign mutation
# and physical submitter is quiesced. The disposable CLI is the only process
# allowed to compose a solver job.
NODE_API_QUIESCED=true
if ! compose stop node-api >/dev/null; then
  # `start` is idempotent for the already-running exact container, so the
  # fail-safe may safely restore after either a partial or a clean stop.
  echo "The control plane could not be stopped cleanly before one-shot admission." >&2
  exit 14
fi
[[ -z "$(compose ps --status running -q node-api)" ]] || {
  echo "The control plane did not quiesce before one-shot admission." >&2
  exit 14
}
receipt="$(compose run --rm --no-deps -T \
  -v "$ADMISSION_CORE_FILE:/app/apps/sweeper/src/successor-continuation-once.ts:ro" \
  -v "$ADMISSION_CLI_FILE:/app/apps/sweeper/src/successor-continuation-once-cli.ts:ro" \
  sweeper \
  pnpm --filter @aerodb/sweeper exec tsx \
  src/successor-continuation-once-cli.ts \
  --campaign-id "$CAMPAIGN_ID" \
  --canary-attestation-id "$CANARY_ATTESTATION_ID" \
  --target-plan-revision-id "$TARGET_PLAN_REVISION_ID" \
  --target-generation "$TARGET_GENERATION")"
printf '%s' "$receipt" | python3 -c '
import json,sys
p=json.load(sys.stdin)
if p.get("status")!="submitted" or p.get("campaignId")!=sys.argv[1] or p.get("targetPlanRevisionId")!=sys.argv[2] or p.get("targetGeneration")!=int(sys.argv[3]):
    raise SystemExit("one-shot admission returned an invalid receipt")
for field in ("jobId","engineJobId","attestedSolverRuntimeBuildId","airfoilId"):
    if not isinstance(p.get(field),str) or not p[field]:
        raise SystemExit(f"one-shot admission receipt lacks {field}")
runtime_status=p.get("runtimeAcknowledgement")
actual_runtime=p.get("solverRuntimeBuildId")
attested_runtime=p["attestedSolverRuntimeBuildId"]
if runtime_status == "pending":
    if actual_runtime is not None:
        raise SystemExit("pending runtime receipt unexpectedly names an executed runtime")
elif runtime_status == "acknowledged":
    if actual_runtime != attested_runtime:
        raise SystemExit("acknowledged runtime differs from the attested runtime")
else:
    raise SystemExit("one-shot admission receipt has an invalid runtime acknowledgement")
' "$CAMPAIGN_ID" "$TARGET_PLAN_REVISION_ID" "$TARGET_GENERATION"

# The in-container postcondition already closes both DB fences. Reassert and
# read both rows back directly while the ordinary control plane remains
# stopped, then restore that control plane before disarming the EXIT fail-safe.
close_admission_direct || {
  echo "The database did not confirm both admission fences closed." >&2
  exit 18
}
[[ -z "$(compose ps --status running -q sweeper)" ]] || {
  echo "The looping sweeper started during one-shot admission." >&2
  exit 14
}
restore_node_api || {
  echo "The control plane did not recover after one-shot admission." >&2
  exit 18
}
FAIL_SAFE_ARMED=false
trap - EXIT
printf '%s\n' "$receipt"
echo "Exactly one successor job was admitted. The sweeper remains stopped, and both admission fences are closed; start the disabled sweeper only for reconciliation, then certify after continuation status becomes evidence." >&2
