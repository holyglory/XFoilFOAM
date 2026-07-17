#!/usr/bin/env bash
# Incident-specific recovery for the third 2026-07-17 OpenCFD v2606 canary
# retention failure.
#
# The transient-retention retry also stopped before attestation. This additive
# wrapper authenticates that exact failed journal and live runtime, admits only
# the reviewed URANS early-stop retention correction, builds API/worker from an
# immutable snapshot of the new source, and reuses (without rebuilding or
# retagging) the already-verified Node image. APP_DIR remains on sealed 6338577
# until the cutover is terminal and a later normal source promotion is run.
set -Eeuo pipefail

STAGING_DIR="${STAGING_DIR:?STAGING_DIR is required}"
EXPECTED_TARGET_SOURCE_REVISION="${EXPECTED_TARGET_SOURCE_REVISION:?EXPECTED_TARGET_SOURCE_REVISION is required}"
EXPECTED_TARGET_GIT_INVENTORY_SHA256="${EXPECTED_TARGET_GIT_INVENTORY_SHA256:?EXPECTED_TARGET_GIT_INVENTORY_SHA256 is required}"

# Exact production incident identity.  None of these values is an operator
# option; a later incident must use another reviewed wrapper.
EXPECTED_BOUND_SOURCE_REVISION="63385777be7323777906fde44bdb9fa9b5cc0d6d"
EXPECTED_BOUND_SOURCE_TREE_SHA256="52c8bd3aa6d5a05dcd70a90d8896fb771f7fc36d129e698be0c935680e3fff36"
EXPECTED_BOUND_SOURCE_FILE_COUNT="2198"
EXPECTED_NODE_SOURCE_REVISION="1f815f89c523cbf667725c1cd681d729c06a10c9"
EXPECTED_PRIOR_ENGINE_SOURCE_REVISION="2ab861cb4ce603a14b82722a0f63cbc0fd42276c"
EXPECTED_PRIOR_ENGINE_SOURCE_TREE_SHA256="e8f5ecf9e9500d9de20da521fb9ea7edb9696be548bd3c667292019f36079c79"
EXPECTED_GRANDPARENT_ENGINE_SOURCE_REVISION="cd0967a1ba4ef82113d6b1eae9e38f0a7baec3a2"
EXPECTED_PRIOR_TRANSIENT_RETENTION_JOURNAL_SHA256="f43b6b1621a41c2aae211a20ea163c2cc131df7a47252df80463190402bd390b"
EXPECTED_PRIOR_FAILED_RETENTION_JOURNAL_SHA256="b99ca862100542593f7d8fc24dd47b9d62eb3e4d657dbc1c1590ce6c90050224"
EXPECTED_PRIOR_ENGINE_APPLICATION_SOURCE_SHA256="57bca7b4fee964f30d0a44a9a7e83967ed975357aee1f44f46d0d3865412439c"
EXPECTED_PRIOR_ENGINE_SOURCE_FILE_COUNT="2206"
EXPECTED_PRIOR_TRANSIENT_ENV_BEFORE_SHA256="a34fa01374905d4f037fb36ac0ca2981b89443c80d9ae6896bdb9f788608481a"
EXPECTED_PRIOR_TRANSIENT_NODE_BEFORE="23f5f7b9ed07eea74f7eca57247fd9cf03ebf9c179620f3fc3e628be806b2016"
EXPECTED_PRIOR_TRANSIENT_API_BEFORE="8c09f2cf019c568b459fcdb7af595a5e13ad8c59f0ed55ff58f34bb506b848a5"
EXPECTED_PRIOR_TRANSIENT_WORKER_BEFORE="41ae0007b8c19f0d29616d7304b86a38f23346b3940a5178f565dfe2b9ff931f"
EXPECTED_BASE_GIT_TREE_INVENTORY_SHA256="cfc14fb3990219b323e9349a2054734ec9ef72f638d44658f50cfc89b8f258dd"
EXPECTED_PIPELINE_SHA256="18c2d85d8e3202c7a4b3ab41bc776c9c9588a2528f016d3be7ba08323cb7c01a"
EXPECTED_RETENTION_SHA256="3e73c52ce46583d37642b21c6bb3b99c124c399b0f50289e8e583b494a7a39f1"
EXPECTED_RETENTION_TEST_SHA256="8def32a45b558c07e597d281cb6e8ed7eb51e8bbd6f91e422da16c1e20c3c8e6"
EXPECTED_REBUILD_SHA256="008b8d8e92493b33eb7888b3dd6651696c512eddba377ee342b03dca6f51441f"
EXPECTED_CANARY_SHA256="df6f7558e3d53e1f7fd6158c171d02a1d62fe74ce721eb6cdb0132e6efff8f48"
EXPECTED_PRIOR_WRAPPER_SHA256="dac5b9778de7b911fa869ead312ce4e480d7a0283d773a15b909f18874776372"
EXPECTED_NODE_ADMIN_ROUTES_SHA256="e3e1782f0517ea29e451fd89661a1a54f982673cd62ad5502e5d45eaaa6a94f4"
EXPECTED_NODE_ATTESTATION_SHA256="928986cd328e7af647cefe7c241ed1a5ce9a6446907061055a28f28392c0944e"
EXPECTED_NODE_IMAGE="sha256:89069188e2e57cad231dcf3527eaba2e5151b0886921eac4f720d589d09e66af"
EXPECTED_NODE_ROLLBACK_IMAGE="sha256:64ee90e0045a36eace3c57aeb5b3467c1e1f46c5eafb2466b98f8b754cbade32"
EXPECTED_INITIAL_NODE_CONTAINER="4f61a8f4112cecda0e9c640f9a06ef2225090a1a43e9ed466fed9fa3b97e4dfc"
EXPECTED_INITIAL_API_CONTAINER="67f4b36e01f5008fa2a4c4f11bc79d244fcbda7a6bedbe37c78cb292c38307c7"
EXPECTED_INITIAL_WORKER_CONTAINER="ff296834c225c8b978d97768139e7efbc02b15b4f48d35b925ad94655b34b3c4"
EXPECTED_INITIAL_API_IMAGE="sha256:93e2dff0d644856c80e59d6113d5046700796bf10d260ccf8d69b8a03a5fd57d"
EXPECTED_INITIAL_WORKER_IMAGE="sha256:8c2c98eba02b1f18ad8b4f2600b5d167c725e813bb313124f95fd0855d604941"
EXPECTED_INITIAL_ENV_SHA256="4caf2f7c7f40a1b3730cfddac5502a0b546db1308fa656cac95279d16bcfdb87"
EXPECTED_PRIOR_SOURCE_BOUND_ENV_SHA256="9fbf51d7ae4455d3ff92c0b49876243e356f80fc3f9789368bb4fcc4809b84f9"
EXPECTED_INITIAL_DATABASE_SHA256="8421c15692afc6e36a834e481734411db61ecf18a95ce4db3a46ec9c7f7ad96c"
EXPECTED_INITIAL_BUILD_ID="prod-20260717-2ab861cb4ce6-r4"
EXPECTED_APP_LINK="/opt/airfoils-pro/app"
EXPECTED_BOUND_APP_REAL="/opt/airfoils-pro/releases/63385777be7323777906fde44bdb9fa9b5cc0d6d-52c8bd3aa6d5a05d"
EXPECTED_STATE_DIR="/opt/airfoils-pro/state"
EXPECTED_ENV_FILE="/opt/airfoils-pro/state/.env.deploy"
EXPECTED_CANONICAL_LOCK_FILE="/tmp/airfoils-pro-deploy.lock"
EXPECTED_COMPOSE_PROJECT_NAME="app"
OPENCFD_2606_POOL_ID="3f8bc764-09ae-4ff3-8fd2-260600000001"
OPENCFD_2606_ROUTE="openfoam-opencfd-2606"
MAINTENANCE_COOKIE_TTL_MS="14400000"

if [[ "${APP_DIR:-$EXPECTED_APP_LINK}" != "$EXPECTED_APP_LINK" || \
      "${AIRFOILS_PRO_STATE_DIR:-$EXPECTED_STATE_DIR}" != "$EXPECTED_STATE_DIR" || \
      "${ENV_FILE:-$EXPECTED_ENV_FILE}" != "$EXPECTED_ENV_FILE" || \
      "${LOCK_FILE:-$EXPECTED_CANONICAL_LOCK_FILE}" != "$EXPECTED_CANONICAL_LOCK_FILE" || \
      "${COMPOSE_PROJECT_NAME:-$EXPECTED_COMPOSE_PROJECT_NAME}" != "$EXPECTED_COMPOSE_PROJECT_NAME" ]]; then
  echo "Pending early-stop-retention retry refuses caller overrides of bound application, state, lock, or Compose paths." >&2
  exit 2
fi

APP_DIR="$EXPECTED_APP_LINK"
AIRFOILS_PRO_STATE_DIR="$EXPECTED_STATE_DIR"
ENV_FILE="$EXPECTED_ENV_FILE"
CANONICAL_LOCK_FILE="$EXPECTED_CANONICAL_LOCK_FILE"
COMPOSE_PROJECT_NAME="$EXPECTED_COMPOSE_PROJECT_NAME"
PRIOR_TRANSIENT_RETENTION_JOURNAL_FILE="$AIRFOILS_PRO_STATE_DIR/pending-opencfd2606-transient-retention-retry.json"
RETRY_JOURNAL_FILE="$AIRFOILS_PRO_STATE_DIR/pending-opencfd2606-early-stop-retention-retry.json"
OPENCFD2606_CANARY_RECEIPT_FILE="$AIRFOILS_PRO_STATE_DIR/openfoam-2606-canary-receipt.pending.json"
BASE_INVENTORY_RELATIVE=".codex-artifacts/opencfd2606-early-stop-retention-base-ls-tree.txt"
TARGET_INVENTORY_RELATIVE=".codex-artifacts/opencfd2606-early-stop-retention-target-ls-tree.txt"
NODE_IMAGE_REF="${COMPOSE_PROJECT_NAME}-node-api"
NODE_REPLAY_TAG="airfoils-pro/node-api-cutover-replay:${EXPECTED_NODE_SOURCE_REVISION:0:12}"
NODE_ROLLBACK_TAG="airfoils-pro/node-api-cutover-replay-rollback:${EXPECTED_NODE_SOURCE_REVISION:0:12}"

runtime_dir=""
journal_armed=false
target_revision=""
target_tree=""
target_count=""
target_build_id=""
target_application_source_sha=""
node_container_before=""
node_container_after=""
api_container_before=""
worker_container_before=""
source_bound_env_sha=""
retry_action=""
prior_application_source_sha=""

umask 077

fail() {
  echo "$1" >&2
  return "${2:-14}"
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

read_env_var() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

require_regular_owned_mode() {
  local path="$1" mode="$2" label="$3"
  if [[ ! -f "$path" || -L "$path" || "$(stat -c '%a' "$path")" != "$mode" || \
        "$(stat -c '%u' "$path")" != "$(id -u)" ]]; then
    fail "$label must be a same-owner, mode-$mode regular file: $path" 14
    return $?
  fi
}

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi

compose_bound() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$bound_compose" "$@"
}

running_container() {
  local service="$1" id
  id="$(compose_bound ps --status running -q "$service")" || return 12
  if [[ -z "$id" || "$(wc -l <<<"$id")" -ne 1 ]]; then
    fail "Early-stop retention retry requires exactly one running $service container." 12
    return $?
  fi
  printf '%s' "$id"
}

service_image() {
  local id
  id="$(running_container "$1")" || return $?
  docker inspect --format '{{.Image}}' "$id"
}

tag_image() {
  docker image inspect --format '{{.Id}}' "$1"
}

cutover_state_json() {
  local source_revision source_tree
  source_revision="$(read_env_var OPENCFD2606_CUTOVER_SOURCE_REVISION)"
  source_tree="$(read_env_var OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256)"
  # Terminal state intentionally clears its recovery source tuple.  The
  # validator still accepts a corroborating current source pair; use the
  # exact target snapshot (or the sealed release before target verification)
  # rather than passing malformed empty command-line values.
  if [[ -z "$source_revision" && -z "$source_tree" ]]; then
    source_revision="${target_revision:-$EXPECTED_BOUND_SOURCE_REVISION}"
    source_tree="${target_tree:-$EXPECTED_BOUND_SOURCE_TREE_SHA256}"
  fi
  python3 "$state_tool" \
    --env-file "$ENV_FILE" \
    --receipt-file "$OPENCFD2606_CANARY_RECEIPT_FILE" \
    --current-source-revision "$source_revision" \
    --current-source-tree-sha256 "$source_tree" \
    --require-state any \
    --print-json
}

cutover_state_kind() {
  cutover_state_json | python3 -c 'import json,sys; print(json.load(sys.stdin)["state_kind"])'
}

receipt_sha() {
  if [[ -f "$OPENCFD2606_CANARY_RECEIPT_FILE" && ! -L "$OPENCFD2606_CANARY_RECEIPT_FILE" ]]; then
    sha256_file "$OPENCFD2606_CANARY_RECEIPT_FILE"
  elif [[ -e "$OPENCFD2606_CANARY_RECEIPT_FILE" || -L "$OPENCFD2606_CANARY_RECEIPT_FILE" ]]; then
    return 14
  else
    printf 'absent'
  fi
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
" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(",",":")))'
}

database_snapshot_sha() {
  local payload
  payload="$(database_snapshot_payload)" || return $?
  printf '%s' "$payload" | sha256sum | awk '{print $1}'
}

assert_pristine_database() {
  database_snapshot_payload | python3 -c '
import json,sys
p=json.load(sys.stdin); rows=p.get("cutovers")
if p.get("poolRows") != 1 or p.get("poolEnabled") is not False:
    raise SystemExit("OpenCFD 2606 pool is not exactly present and disabled")
if p.get("attestationCount") != 0 or not isinstance(rows,list) or len(rows)!=1:
    raise SystemExit("pending-pristine database must have no attestation and one cutover")
row=rows[0]
expected={"id":"b1d018a0-e0cc-4ffa-af5c-dcfd1c0ff7ee","status":"prepared",
          "canaryAttestationId":None,"targetPlanRevisionId":None,
          "finalizedAt":None,"completedAt":None}
if any(row.get(key)!=value for key,value in expected.items()):
    raise SystemExit("pending-pristine cutover database row is not exact")
'
}

assert_attested_or_terminal_database() {
  local state_kind="$1" attestation
  attestation="$(read_env_var OPENCFD2606_CANARY_ATTESTATION_ID)"
  database_snapshot_payload | python3 -c '
import json,re,sys
p=json.load(sys.stdin); kind=sys.argv[1]; env_attestation=sys.argv[2]
rows=p.get("cutovers")
if p.get("poolRows") != 1 or not isinstance(p.get("poolEnabled"),bool):
    raise SystemExit("target execution pool shape is invalid")
if p.get("attestationCount") != 1 or not isinstance(rows,list) or len(rows)!=1:
    raise SystemExit("expected exactly one attestation and one target cutover")
row=rows[0]
if row.get("id") != "b1d018a0-e0cc-4ffa-af5c-dcfd1c0ff7ee":
    raise SystemExit("unexpected campaign cutover identity")
canary=row.get("canaryAttestationId")
if not isinstance(canary,str) or re.fullmatch(r"[0-9a-f-]{36}",canary) is None:
    raise SystemExit("cutover lacks its exact canary attestation")
if row.get("targetPlanRevisionId") is None or row.get("finalizedAt") is None:
    raise SystemExit("cutover lacks finalized target-plan evidence")
if kind in {"pending-attested","pending-attested-retained-receipt"}:
    if row.get("status") != "finalized" or row.get("completedAt") is not None or canary != env_attestation:
        raise SystemExit("pending attested cutover database shape is invalid")
elif kind == "terminal":
    if row.get("status") != "completed" or row.get("completedAt") is None:
        raise SystemExit("terminal cutover database shape is invalid")
else:
    raise SystemExit("unsupported progressed cutover state")
' "$state_kind" "$attestation"
}

assert_scheduler_stopped_and_idle() {
  if [[ -n "$(compose_bound ps --status running -q sweeper)" ]]; then
    fail "Early-stop retention retry requires the scheduler to remain stopped." 12
    return $?
  fi
  local service running hidden output
  while IFS= read -r service; do
    [[ -n "$service" && "$service" != "worker" ]] || continue
    running="$(compose_bound --profile '*' ps --status running -q "$service")" || return 12
    [[ -z "$running" ]] || { fail "Early-stop retention retry refuses running optional engine worker $service." 12; return $?; }
  done < <(compose_bound --profile '*' config --services | awk '/^worker-/')
  hidden="$(docker ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --format '{{.Label "com.docker.compose.service"}}' | awk '$0 ~ /^worker-/')"
  [[ -z "$hidden" ]] || { fail "Early-stop retention retry refuses hidden running optional workers: $hidden" 12; return $?; }
  output="$(compose_bound exec -T worker sh -lc \
    'pgrep -af "[s]impleFoam|[p]impleFoam|[p]otentialFoam|[s]nappyHexMesh|[s]urfaceFeatureExtract|[b]lockMesh|[c]heckMesh|[d]ecomposePar|[r]econstructPar|[r]enumberMesh|[m]apFields|[p]ostProcess|[f]oamToVTK|[f]oamRun|[f]oamJob" || true')" || return 12
  [[ -z "$output" ]] || { fail "Early-stop retention retry refuses active OpenFOAM work: $output" 12; return $?; }
  curl -fsS --max-time 15 http://127.0.0.1:8000/queue | python3 -c '
import json,sys
p=json.load(sys.stdin)
for field in ("active_count","reserved_count","scheduled_count","queue_depth"):
    if p.get(field) != 0: raise SystemExit(f"engine queue is not idle: {field}={p.get(field)!r}")
if p.get("job_ids") not in ([],None) or p.get("inspection_errors") not in ({},None):
    raise SystemExit("engine queue inspection reports work or errors")
if p.get("worker_queues_error") is not None or p.get("worker_runtime_error") is not None:
    raise SystemExit("engine worker observability is unavailable")
bindings=p.get("worker_queues")
if not isinstance(bindings,list) or len(bindings)!=1: raise SystemExit("expected exactly one live OpenCFD worker binding")
b=bindings[0]; engine=b.get("engine") or {}
expected={"family":"openfoam","distribution":"opencfd","version":"2606","numerics_revision":"1","adapter_contract_version":1}
if b.get("queues") != [sys.argv[1]] or b.get("execution_pool") != sys.argv[1] or {k:engine.get(k) for k in expected} != expected:
    raise SystemExit("live worker route/runtime differs from the authorized retry")
' "$OPENCFD_2606_ROUTE"
}

assert_engine_health_for_build() {
  local expected_build="$1"
  curl -fsS --max-time 15 http://127.0.0.1:8000/health | python3 -c '
import json,sys
p=json.load(sys.stdin)
engine=p.get("default_engine") or {}
expected_engine={"family":"openfoam","distribution":"opencfd","version":"2606","numerics_revision":"1","adapter_contract_version":1}
expected_storage={"backend":"gcs","bucket":"airfoils-pro-storage-bucket","object_prefix":"solver-evidence/v1","archive_format":"tar+zstd","compression":"zstd","zstd_level":10,"remote_only":True}
if p.get("build_id") != sys.argv[1] or {k:engine.get(k) for k in expected_engine} != expected_engine:
    raise SystemExit("live engine build/identity differs from the authorized retry")
if p.get("evidence_storage") != expected_storage: raise SystemExit("live evidence-storage contract differs from the authorized retry")
' "$expected_build"
}

assert_node_runtime() {
  local expected_build="$1" id image app_tag replay_tag rollback_tag admin_sha attestation_sha baked_build
  id="$(running_container node-api)" || return $?
  image="$(docker inspect --format '{{.Image}}' "$id")" || return 12
  app_tag="$(tag_image "$NODE_IMAGE_REF")" || return 12
  replay_tag="$(tag_image "$NODE_REPLAY_TAG")" || return 12
  rollback_tag="$(tag_image "$NODE_ROLLBACK_TAG")" || return 12
  admin_sha="$(docker exec "$id" sha256sum /app/apps/api/src/admin-routes.ts | awk '{print $1}')" || return 12
  attestation_sha="$(docker exec "$id" sha256sum /app/apps/api/src/openfoam-2606-attestation.ts | awk '{print $1}')" || return 12
  baked_build="$(docker exec "$id" printenv ENGINE_EXPECTED_BUILD_ID)" || return 12
  if [[ "$image" != "$EXPECTED_NODE_IMAGE" || "$app_tag" != "$EXPECTED_NODE_IMAGE" || \
        "$replay_tag" != "$EXPECTED_NODE_IMAGE" || "$rollback_tag" != "$EXPECTED_NODE_ROLLBACK_IMAGE" || \
        "$admin_sha" != "$EXPECTED_NODE_ADMIN_ROUTES_SHA256" || \
        "$attestation_sha" != "$EXPECTED_NODE_ATTESTATION_SHA256" || "$baked_build" != "$expected_build" ]]; then
    fail "Live Node API is not the exact verified replay image/source/build contract." 14
    return $?
  fi
  curl -fsS --max-time 15 http://127.0.0.1:4000/health >/dev/null || return 12
  printf '%s' "$id"
}

assert_application_source_image() {
  local service="$1" expected_image="$2" expected_source="$3" id image tag source
  id="$(running_container "$service")" || return $?
  image="$(docker inspect --format '{{.Image}}' "$id")" || return 12
  tag="$(tag_image "${COMPOSE_PROJECT_NAME}-${service}")" || return 12
  source="$(docker exec "$id" cat /etc/airfoilfoam-application-source-sha256)" || return 12
  source="${source//$'\r'/}"; source="${source//$'\n'/}"
  if [[ "$image" != "$expected_image" || "$tag" != "$expected_image" || "$source" != "$expected_source" ]]; then
    fail "$service runtime does not match its journaled image and exact target application source." 14
    return $?
  fi
}

assert_initial_container_binding() {
  local node api worker
  node="$(running_container node-api)" || return $?
  api="$(running_container api)" || return $?
  worker="$(running_container worker)" || return $?
  if [[ "$node" != "$EXPECTED_INITIAL_NODE_CONTAINER" || \
        "$api" != "$EXPECTED_INITIAL_API_CONTAINER" || \
        "$worker" != "$EXPECTED_INITIAL_WORKER_CONTAINER" ]]; then
    fail "Live containers are not the exact third retention incident set." 14
    return $?
  fi
  node_container_before="$node"
  api_container_before="$api"
  worker_container_before="$worker"
}

assert_prior_incident_immutable() {
  [[ "$(sha256_file "$PRIOR_TRANSIENT_RETENTION_JOURNAL_FILE")" == "$EXPECTED_PRIOR_TRANSIENT_RETENTION_JOURNAL_SHA256" && \
     "$(sha256_file "$staging_real/scripts/deploy/retry-pending-opencfd2606-transient-retention.sh")" == "$EXPECTED_PRIOR_WRAPPER_SHA256" ]] || {
    fail "The transient-retention retry wrapper or journal changed during this recovery." 14
    return $?
  }
}

snapshot_runtime_binding() {
  local env_sha api_image worker_image db_sha receipt state
  env_sha="$(sha256_file "$ENV_FILE")" || return 14
  api_image="$(service_image api)" || return $?
  worker_image="$(service_image worker)" || return $?
  db_sha="$(database_snapshot_sha)" || return $?
  receipt="$(receipt_sha)" || return $?
  state="$(cutover_state_kind)" || return $?
  printf '%s\n%s\n%s\n%s\n%s\n%s\n' "$env_sha" "$api_image" "$worker_image" "$db_sha" "$receipt" "$state"
}

persist_retry_journal() {
  local status="$1" exit_code="${2:-}" promotion_eligible="${3:-false}" binding
  local current_env current_api current_worker current_db current_receipt current_state
  local current_node_image current_node_build
  binding="$(snapshot_runtime_binding)" || return $?
  mapfile -t fields <<<"$binding"
  current_env="${fields[0]}"; current_api="${fields[1]}"; current_worker="${fields[2]}"
  current_db="${fields[3]}"; current_receipt="${fields[4]}"; current_state="${fields[5]}"
  node_container_after="$(running_container node-api)" || return $?
  current_node_image="$(docker inspect --format '{{.Image}}' "$node_container_after")" || return 12
  current_node_build="$(docker exec "$node_container_after" printenv ENGINE_EXPECTED_BUILD_ID)" || return 12
  RETRY_STATUS="$status" RETRY_EXIT_CODE="$exit_code" RETRY_PROMOTION_ELIGIBLE="$promotion_eligible" \
  RETRY_JOURNAL_FILE="$RETRY_JOURNAL_FILE" RETRY_TARGET_REVISION="$target_revision" \
  RETRY_TARGET_TREE="$target_tree" RETRY_TARGET_COUNT="$target_count" RETRY_BUILD_ID="$target_build_id" \
  RETRY_APP_SOURCE_SHA="$target_application_source_sha" RETRY_SOURCE_BOUND_ENV_SHA="$source_bound_env_sha" \
  RETRY_NODE_BEFORE="$node_container_before" RETRY_NODE_AFTER="$node_container_after" \
  RETRY_API_BEFORE="$api_container_before" RETRY_WORKER_BEFORE="$worker_container_before" \
  RETRY_CURRENT_ENV="$current_env" RETRY_CURRENT_API="$current_api" RETRY_CURRENT_WORKER="$current_worker" \
  RETRY_CURRENT_DB="$current_db" RETRY_CURRENT_RECEIPT="$current_receipt" RETRY_CURRENT_STATE="$current_state" \
  RETRY_CURRENT_NODE_IMAGE="$current_node_image" RETRY_CURRENT_NODE_BUILD="$current_node_build" \
  RETRY_ACTION="$retry_action" EXPECTED_ENV_BEFORE="$EXPECTED_INITIAL_ENV_SHA256" \
  EXPECTED_PRIOR_JOURNAL_SHA="$EXPECTED_PRIOR_TRANSIENT_RETENTION_JOURNAL_SHA256" \
  EXPECTED_NODE_IMAGE_VALUE="$EXPECTED_NODE_IMAGE" EXPECTED_NODE_SOURCE_REVISION_VALUE="$EXPECTED_NODE_SOURCE_REVISION" \
  EXPECTED_PRIOR_ENGINE_REVISION_VALUE="$EXPECTED_PRIOR_ENGINE_SOURCE_REVISION" \
  EXPECTED_NODE_ADMIN_SHA="$EXPECTED_NODE_ADMIN_ROUTES_SHA256" EXPECTED_NODE_ATTEST_SHA="$EXPECTED_NODE_ATTESTATION_SHA256" \
  EXPECTED_BOUND_REVISION_VALUE="$EXPECTED_BOUND_SOURCE_REVISION" EXPECTED_BOUND_TREE_VALUE="$EXPECTED_BOUND_SOURCE_TREE_SHA256" \
  python3 - <<'PY'
from datetime import datetime, timezone
import json, os, re, tempfile
from pathlib import Path

path=Path(os.environ["RETRY_JOURNAL_FILE"]); status=os.environ["RETRY_STATUS"]
now=datetime.now(timezone.utc).isoformat()
if status == "prepared":
    if os.path.lexists(path): raise SystemExit("refusing to overwrite an existing early-stop-retention retry journal")
    payload={
      "schemaVersion":1,"purpose":"pending-opencfd2606-early-stop-retention-retry","status":"prepared",
      "preparedAt":now,"updatedAt":now,"completedAt":None,"failureCount":0,"lastExitCode":None,
      "priorFailedTransientRetentionJournalSha256":os.environ["EXPECTED_PRIOR_JOURNAL_SHA"],
      "boundReleaseSourceRevision":os.environ["EXPECTED_BOUND_REVISION_VALUE"],
      "boundReleaseSourceTreeSha256":os.environ["EXPECTED_BOUND_TREE_VALUE"],
      "priorEngineSourceRevision":os.environ["EXPECTED_PRIOR_ENGINE_REVISION_VALUE"],
      "engineSourceRevision":os.environ["RETRY_TARGET_REVISION"],
      "engineSourceTreeSha256":os.environ["RETRY_TARGET_TREE"],
      "engineSourceFileCount":int(os.environ["RETRY_TARGET_COUNT"]),
      "engineApplicationSourceSha256":os.environ["RETRY_APP_SOURCE_SHA"],
      "nodeSourceRevision":os.environ["EXPECTED_NODE_SOURCE_REVISION_VALUE"],
      "nodeApiImage":os.environ["EXPECTED_NODE_IMAGE_VALUE"],
      "nodeApiAdminRoutesSha256":os.environ["EXPECTED_NODE_ADMIN_SHA"],
      "nodeApiAttestationSha256":os.environ["EXPECTED_NODE_ATTEST_SHA"],
      "nodeApiContainerBefore":os.environ["RETRY_NODE_BEFORE"],"nodeApiContainerAfter":None,
      "apiContainerBefore":os.environ["RETRY_API_BEFORE"],
      "workerContainerBefore":os.environ["RETRY_WORKER_BEFORE"],
      "buildId":os.environ["RETRY_BUILD_ID"],"action":os.environ["RETRY_ACTION"],
      "deploymentEnvironmentBeforeSha256":os.environ["EXPECTED_ENV_BEFORE"],
      "sourceBoundDeploymentEnvironmentSha256":os.environ["RETRY_SOURCE_BOUND_ENV_SHA"],
      "promotionEligible":False,
    }
else:
    if not path.is_file() or path.is_symlink(): raise SystemExit("early-stop-retention retry journal is missing or unsafe")
    payload=json.loads(path.read_text(encoding="utf-8"))
    payload["status"]=status; payload["updatedAt"]=now
    payload["nodeApiContainerAfter"]=os.environ["RETRY_NODE_AFTER"]
    if status == "failed":
        payload["failureCount"]=int(payload.get("failureCount",0))+1
        payload["lastExitCode"]=int(os.environ["RETRY_EXIT_CODE"])
    if status == "completed": payload["completedAt"]=now
    payload["promotionEligible"]=os.environ["RETRY_PROMOTION_ELIGIBLE"] == "true"
for key, env in {
  "currentDeploymentEnvironmentSha256":"RETRY_CURRENT_ENV","currentApiImage":"RETRY_CURRENT_API",
  "currentWorkerImage":"RETRY_CURRENT_WORKER","currentDatabaseSnapshotSha256":"RETRY_CURRENT_DB",
  "currentCanaryReceiptSha256":"RETRY_CURRENT_RECEIPT","currentCutoverStateKind":"RETRY_CURRENT_STATE",
  "currentNodeApiImage":"RETRY_CURRENT_NODE_IMAGE","currentNodeExpectedBuildId":"RETRY_CURRENT_NODE_BUILD",
}.items(): payload[key]=os.environ[env]
if status == "completed" and (payload["currentCutoverStateKind"] != "terminal" or not payload["promotionEligible"]):
    raise SystemExit("only terminal cutover state may become promotion eligible")
if status == "attested_awaiting_continuation" and (payload["currentCutoverStateKind"] not in {"pending-attested","pending-attested-retained-receipt"} or payload["promotionEligible"]):
    raise SystemExit("awaiting-continuation journal state is not truthful")
temporary_fd, temporary_name=tempfile.mkstemp(prefix=f".{path.name}.",dir=path.parent)
try:
    os.fchmod(temporary_fd,0o600)
    with os.fdopen(temporary_fd,"w",encoding="utf-8") as stream:
        json.dump(payload,stream,sort_keys=True,separators=(",",":")); stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary_name,path)
    directory_fd=os.open(path.parent,os.O_RDONLY|getattr(os,"O_DIRECTORY",0))
    try: os.fsync(directory_fd)
    finally: os.close(directory_fd)
except BaseException:
    try: os.unlink(temporary_name)
    except FileNotFoundError: pass
    raise
PY
}

cleanup() {
  local rc=$?
  trap - EXIT
  if ((rc != 0)) && [[ "$journal_armed" == "true" ]]; then
    set +e
    persist_retry_journal failed "$rc" false || \
      echo "WARNING: early-stop retention retry failed and its last exact runtime binding could not be advanced; the prior journal stage remains authoritative." >&2
    set -e
  fi
  if [[ -n "$runtime_dir" && -d "$runtime_dir" && ! -L "$runtime_dir" ]]; then
    chmod -R u+w "$runtime_dir" 2>/dev/null || true
    rm -rf -- "$runtime_dir"
  fi
  exit "$rc"
}
trap cleanup EXIT

if [[ ! "$EXPECTED_TARGET_SOURCE_REVISION" =~ ^[0-9a-f]{40}$ || \
      ! "$EXPECTED_TARGET_GIT_INVENTORY_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  fail "Early-stop retention retry requires an exact target commit and Git inventory SHA." 2; exit $?
fi
if [[ "$EXPECTED_INITIAL_ENV_SHA256" == "$EXPECTED_PRIOR_SOURCE_BOUND_ENV_SHA256" ]]; then
  fail "Early-stop retention retry requires distinct failed-current and prior source-bound environment identities." 14; exit $?
fi
if [[ ! -d "$STAGING_DIR" || -L "$STAGING_DIR" || ! -L "$APP_DIR" ]]; then
  fail "Early-stop retention retry requires a real staging directory and versioned APP_DIR symlink." 2; exit $?
fi
staging_real="$(realpath "$STAGING_DIR")"
app_real="$(readlink -f "$APP_DIR")"
if [[ ! -d "$app_real" || -L "$app_real" || "$app_real" != "$EXPECTED_BOUND_APP_REAL" || "$staging_real" == "$app_real" ]]; then
  fail "Early-stop retention retry is not attached to the exact sealed production release." 14; exit $?
fi
if [[ ! -d "$AIRFOILS_PRO_STATE_DIR" || -L "$AIRFOILS_PRO_STATE_DIR" || ! -d /dev/shm || -L /dev/shm ]]; then
  fail "Early-stop retention retry requires safe state and in-memory runtime directories." 2; exit $?
fi

exec 8>"$CANONICAL_LOCK_FILE"
flock -n 8 || { echo "Another Airfoils.Pro deploy or engine maintenance action is running." >&2; exit 9; }

manifest_tool="$app_real/scripts/deploy/deployment-source-manifest.py"
state_tool="$app_real/scripts/deploy/opencfd2606_cutover_state.py"
preflight_tool="$app_real/scripts/deploy/deployment-env-preflight.py"
bound_compose="$app_real/docker-compose.deploy.yml"
base_inventory="$staging_real/$BASE_INVENTORY_RELATIVE"
target_inventory="$staging_real/$TARGET_INVENTORY_RELATIVE"
for required in "$manifest_tool" "$state_tool" "$preflight_tool" "$bound_compose" \
  "$app_real/.deployment-source.json" "$staging_real/.deployment-source.json" \
  "$base_inventory" "$target_inventory" "$PRIOR_TRANSIENT_RETENTION_JOURNAL_FILE"; do
  [[ -f "$required" && ! -L "$required" ]] || { fail "Early-stop retention retry lacks a required safe regular file: $required" 2; exit $?; }
done
require_regular_owned_mode "$ENV_FILE" 600 "Deployment environment"
require_regular_owned_mode "$PRIOR_TRANSIENT_RETENTION_JOURNAL_FILE" 600 "Failed transient-retention retry journal"
require_regular_owned_mode "$base_inventory" 600 "Authenticated base source inventory"
require_regular_owned_mode "$target_inventory" 600 "Authenticated target source inventory"

if [[ "$(sha256_file "$PRIOR_TRANSIENT_RETENTION_JOURNAL_FILE")" != "$EXPECTED_PRIOR_TRANSIENT_RETENTION_JOURNAL_SHA256" ]]; then
  fail "The transient-retention retry journal is not the exact failed incident authorized for this retry." 14; exit $?
fi
prior_application_source_sha="$(python3 - "$PRIOR_TRANSIENT_RETENTION_JOURNAL_FILE" \
  "$EXPECTED_PRIOR_ENGINE_SOURCE_REVISION" "$EXPECTED_PRIOR_ENGINE_SOURCE_TREE_SHA256" \
  "$EXPECTED_NODE_SOURCE_REVISION" "$EXPECTED_NODE_IMAGE" "$EXPECTED_INITIAL_NODE_CONTAINER" \
  "$EXPECTED_INITIAL_API_IMAGE" "$EXPECTED_INITIAL_WORKER_IMAGE" "$EXPECTED_INITIAL_ENV_SHA256" \
  "$EXPECTED_PRIOR_SOURCE_BOUND_ENV_SHA256" "$EXPECTED_INITIAL_DATABASE_SHA256" \
  "$EXPECTED_INITIAL_BUILD_ID" "$EXPECTED_BOUND_SOURCE_REVISION" \
  "$EXPECTED_BOUND_SOURCE_TREE_SHA256" "$EXPECTED_NODE_ADMIN_ROUTES_SHA256" \
  "$EXPECTED_NODE_ATTESTATION_SHA256" "$EXPECTED_GRANDPARENT_ENGINE_SOURCE_REVISION" \
  "$EXPECTED_PRIOR_FAILED_RETENTION_JOURNAL_SHA256" "$EXPECTED_PRIOR_ENGINE_APPLICATION_SOURCE_SHA256" \
  "$EXPECTED_PRIOR_ENGINE_SOURCE_FILE_COUNT" "$EXPECTED_PRIOR_TRANSIENT_ENV_BEFORE_SHA256" \
  "$EXPECTED_PRIOR_TRANSIENT_NODE_BEFORE" "$EXPECTED_PRIOR_TRANSIENT_API_BEFORE" \
  "$EXPECTED_PRIOR_TRANSIENT_WORKER_BEFORE" <<'PY'
import json,re,sys
p=json.load(open(sys.argv[1],encoding="utf-8"))
expected={"schemaVersion":1,"purpose":"pending-opencfd2606-transient-retention-retry","status":"failed",
"failureCount":1,"lastExitCode":137,"engineSourceRevision":sys.argv[2],
"engineSourceTreeSha256":sys.argv[3],"nodeSourceRevision":sys.argv[4],
"priorEngineSourceRevision":sys.argv[17],"nodeApiImage":sys.argv[5],
"currentNodeApiImage":sys.argv[5],"nodeApiContainerAfter":sys.argv[6],
"currentApiImage":sys.argv[7],"currentWorkerImage":sys.argv[8],
"currentDeploymentEnvironmentSha256":sys.argv[9],
"sourceBoundDeploymentEnvironmentSha256":sys.argv[10],
"currentDatabaseSnapshotSha256":sys.argv[11],"buildId":sys.argv[12],
"currentNodeExpectedBuildId":sys.argv[12],"boundReleaseSourceRevision":sys.argv[13],
"boundReleaseSourceTreeSha256":sys.argv[14],"nodeApiAdminRoutesSha256":sys.argv[15],
"nodeApiAttestationSha256":sys.argv[16],"currentCanaryReceiptSha256":"absent",
"currentCutoverStateKind":"pending-pristine","action":"rebuild_and_canary",
"promotionEligible":False,"completedAt":None,
"priorFailedRetentionJournalSha256":sys.argv[18],
"engineApplicationSourceSha256":sys.argv[19],"engineSourceFileCount":int(sys.argv[20]),
"deploymentEnvironmentBeforeSha256":sys.argv[21],
"nodeApiContainerBefore":sys.argv[22],"apiContainerBefore":sys.argv[23],
"workerContainerBefore":sys.argv[24]}
for key,value in expected.items():
    if p.get(key)!=value: raise SystemExit(f"failed transient-retention journal mismatch: {key}")
allowed=set(expected)|{"preparedAt","updatedAt"}
if set(p)!=allowed: raise SystemExit("failed transient-retention journal has unexpected fields")
if not all(isinstance(p.get(key),str) and p[key] for key in ("preparedAt","updatedAt")):
    raise SystemExit("failed transient-retention journal has invalid timestamps")
print(p["engineApplicationSourceSha256"])
PY
)" || exit $?

python3 "$preflight_tool" --app-dir "$APP_DIR" --state-dir "$AIRFOILS_PRO_STATE_DIR" --env-file "$ENV_FILE" >/dev/null
IFS=$'\t' read -r bound_revision bound_tree bound_count < <(
  python3 "$manifest_tool" --verify --root "$app_real" --manifest "$app_real/.deployment-source.json"
)
IFS=$'\t' read -r target_revision target_tree target_count < <(
  python3 "$manifest_tool" --verify --root "$staging_real" --manifest "$staging_real/.deployment-source.json"
)
if [[ "$bound_revision" != "$EXPECTED_BOUND_SOURCE_REVISION" || "$bound_tree" != "$EXPECTED_BOUND_SOURCE_TREE_SHA256" || "$bound_count" != "$EXPECTED_BOUND_SOURCE_FILE_COUNT" ]]; then
  fail "Early-stop retention retry found an unexpected bound release." 14; exit $?
fi
if [[ "$target_revision" != "$EXPECTED_TARGET_SOURCE_REVISION" || "$target_revision" == "$EXPECTED_PRIOR_ENGINE_SOURCE_REVISION" ]]; then
  fail "Early-stop retention retry target does not match the explicit new dispatch revision." 14; exit $?
fi
target_build_id="prod-20260717-${target_revision:0:12}-r5"

if [[ "$(sha256_file "$base_inventory")" != "$EXPECTED_BASE_GIT_TREE_INVENTORY_SHA256" ]]; then
  fail "The uploaded base Git-tree inventory is not the exact 2ab861c source inventory." 14; exit $?
fi
if [[ "$(sha256_file "$target_inventory")" != "$EXPECTED_TARGET_GIT_INVENTORY_SHA256" ]]; then
  fail "The uploaded target Git-tree inventory differs from this workflow dispatch." 14; exit $?
fi
python3 - "$manifest_tool" "$base_inventory" "$target_inventory" "$staging_real" <<'PY'
import hashlib, importlib.util, os, re, stat, sys
from pathlib import Path
tool, base_inventory_path, target_inventory_path, target_root=map(Path,sys.argv[1:])
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location("sealed_manifest",tool)
if spec is None or spec.loader is None: raise SystemExit("cannot load sealed source verifier")
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
line_re=re.compile(r"^(100644|100755|120000) blob ([0-9a-f]{40})\t(.+)$")
def inventory(path: Path, label: str):
    result={}
    for raw in path.read_text(encoding="utf-8").splitlines():
        match=line_re.fullmatch(raw)
        if match is None: raise SystemExit(f"{label} Git-tree inventory has an unsupported entry")
        mode,blob,name=match.groups(); relative=Path(name)
        if relative.is_absolute() or ".." in relative.parts or name in result:
            raise SystemExit(f"{label} Git-tree inventory has an unsafe or duplicate path")
        if not module._excluded(relative): result[name]=(mode,blob)
    return result
base=inventory(base_inventory_path,"base")
target=inventory(target_inventory_path,"target")
staged={}
for path in module._source_entries(target_root):
    relative=path.relative_to(target_root).as_posix(); metadata=path.lstat()
    if stat.S_ISREG(metadata.st_mode):
        payload=path.read_bytes(); mode="100755" if metadata.st_mode & 0o111 else "100644"
    elif stat.S_ISLNK(metadata.st_mode): payload=os.readlink(path).encode(); mode="120000"
    else: raise SystemExit(f"unsupported staged source entry: {relative}")
    blob=hashlib.sha1(b"blob "+str(len(payload)).encode()+b"\0"+payload).hexdigest()
    staged[relative]=(mode,blob)
if staged != target:
    print("staged source differs from the authenticated target Git inventory",file=sys.stderr)
    for path in sorted(set(staged)|set(target)):
        if staged.get(path)!=target.get(path): print(f"  {path}",file=sys.stderr)
    raise SystemExit(14)
changed={path for path in set(base)|set(target) if base.get(path)!=target.get(path)}
scaffolding={"scripts/deploy/retry-pending-opencfd2606-early-stop-retention.sh",
             "tests/test_pending_cutover_early_stop_retention_retry.py"}
if any(path in base or path not in target for path in scaffolding):
    raise SystemExit("early-stop-retention recovery scaffolding is not an additive target-only change")
engine_changed=changed-scaffolding
expected={"src/airfoilfoam/pipeline.py","src/airfoilfoam/retention.py","tests/test_retention.py"}
if engine_changed != expected or not scaffolding.issubset(changed):
    print("early-stop-retention retry source is not the exact reviewed engine delta",file=sys.stderr)
    for path in sorted(changed): print(f"  {path}",file=sys.stderr)
    raise SystemExit(14)
critical={"scripts/deploy/rebuild-engine.sh","scripts/deploy/openfoam_2606_canary.py",
          "scripts/deploy/retry-pending-opencfd2606-transient-retention.sh",
          "apps/api/src/admin-routes.ts","apps/api/src/openfoam-2606-attestation.ts"}
for path in critical:
    if base.get(path) is None or target.get(path)!=base[path]:
        raise SystemExit(f"critical cutover source changed: {path}")
PY

declare -A exact_hashes=(
  ["src/airfoilfoam/pipeline.py"]="$EXPECTED_PIPELINE_SHA256"
  ["src/airfoilfoam/retention.py"]="$EXPECTED_RETENTION_SHA256"
  ["tests/test_retention.py"]="$EXPECTED_RETENTION_TEST_SHA256"
  ["scripts/deploy/rebuild-engine.sh"]="$EXPECTED_REBUILD_SHA256"
  ["scripts/deploy/openfoam_2606_canary.py"]="$EXPECTED_CANARY_SHA256"
  ["scripts/deploy/retry-pending-opencfd2606-transient-retention.sh"]="$EXPECTED_PRIOR_WRAPPER_SHA256"
  ["apps/api/src/admin-routes.ts"]="$EXPECTED_NODE_ADMIN_ROUTES_SHA256"
  ["apps/api/src/openfoam-2606-attestation.ts"]="$EXPECTED_NODE_ATTESTATION_SHA256"
)
for relative in "${!exact_hashes[@]}"; do
  [[ "$(sha256_file "$staging_real/$relative")" == "${exact_hashes[$relative]}" ]] || {
    fail "Early-stop retention retry target has changed critical bytes in $relative." 14; exit $?;
  }
done
assert_prior_incident_immutable || exit $?

runtime_dir="$(mktemp -d /dev/shm/airfoils-opencfd2606-early-stop-retention.XXXXXX)"
chmod 700 "$runtime_dir"
[[ ! -L "$runtime_dir" && "$(stat -c '%a' "$runtime_dir")" == "700" && "$(stat -c '%u' "$runtime_dir")" == "$(id -u)" ]] || {
  fail "Could not create a private same-owner mode-0700 retry runtime." 14; exit $?;
}
snapshot="$runtime_dir/source"
install -d -m 700 "$snapshot"
cp -a "$staging_real/." "$snapshot/"
rm -rf -- "$snapshot/.codex-artifacts"
snapshot_fields="$(python3 "$snapshot/scripts/deploy/deployment-source-manifest.py" --verify --root "$snapshot" --manifest "$snapshot/.deployment-source.json")"
[[ "$snapshot_fields" == "$target_revision"$'\t'"$target_tree"$'\t'"$target_count" ]] || {
  fail "Private source snapshot differs from the verified staged source." 14; exit $?;
}
target_application_source_sha="$(PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$snapshot/src" python3 - "$snapshot" <<'PY'
from pathlib import Path
import sys
from airfoilfoam.provenance import application_source_sha256
print(application_source_sha256(Path(sys.argv[1])))
PY
)"
[[ "$target_application_source_sha" =~ ^[0-9a-f]{64}$ ]] || { fail "Could not derive exact target application source identity." 14; exit $?; }
find "$snapshot" -type d -exec chmod a-w {} +
find "$snapshot" -type f -exec chmod a-w {} +
snapshot_fields="$(python3 "$snapshot/scripts/deploy/deployment-source-manifest.py" --verify --root "$snapshot" --manifest "$snapshot/.deployment-source.json")"
[[ "$snapshot_fields" == "$target_revision"$'\t'"$target_tree"$'\t'"$target_count" ]] || {
  fail "Read-only source snapshot changed during sealing." 14; exit $?;
}
private_lock="$runtime_dir/rebuild-engine.lock"; : >"$private_lock"; chmod 600 "$private_lock"

existing_status=""
expected_env_sha="$EXPECTED_INITIAL_ENV_SHA256"
expected_api_image="$EXPECTED_INITIAL_API_IMAGE"
expected_worker_image="$EXPECTED_INITIAL_WORKER_IMAGE"
expected_database_sha="$EXPECTED_INITIAL_DATABASE_SHA256"
expected_receipt_sha="absent"
expected_state_kind="pending-pristine"
if [[ -e "$RETRY_JOURNAL_FILE" || -L "$RETRY_JOURNAL_FILE" ]]; then
  require_regular_owned_mode "$RETRY_JOURNAL_FILE" 600 "Early-stop retention retry journal"
  binding="$(python3 - "$RETRY_JOURNAL_FILE" "$target_revision" "$target_tree" "$target_count" "$target_build_id" \
    "$target_application_source_sha" "$EXPECTED_PRIOR_TRANSIENT_RETENTION_JOURNAL_SHA256" "$EXPECTED_NODE_IMAGE" \
    "$EXPECTED_NODE_SOURCE_REVISION" "$EXPECTED_PRIOR_ENGINE_SOURCE_REVISION" "$EXPECTED_BOUND_SOURCE_REVISION" \
    "$EXPECTED_BOUND_SOURCE_TREE_SHA256" "$EXPECTED_NODE_ADMIN_ROUTES_SHA256" \
    "$EXPECTED_NODE_ATTESTATION_SHA256" "$EXPECTED_INITIAL_ENV_SHA256" \
    "$EXPECTED_INITIAL_NODE_CONTAINER" "$EXPECTED_INITIAL_API_CONTAINER" "$EXPECTED_INITIAL_WORKER_CONTAINER" \
    "$EXPECTED_INITIAL_BUILD_ID" <<'PY'
import json,re,sys
p=json.load(open(sys.argv[1],encoding="utf-8"))
expected={"schemaVersion":1,"purpose":"pending-opencfd2606-early-stop-retention-retry","engineSourceRevision":sys.argv[2],
"engineSourceTreeSha256":sys.argv[3],"engineSourceFileCount":int(sys.argv[4]),"buildId":sys.argv[5],
"engineApplicationSourceSha256":sys.argv[6],"priorFailedTransientRetentionJournalSha256":sys.argv[7],
"nodeApiImage":sys.argv[8],"nodeSourceRevision":sys.argv[9],
"priorEngineSourceRevision":sys.argv[10],"boundReleaseSourceRevision":sys.argv[11],
"boundReleaseSourceTreeSha256":sys.argv[12],"nodeApiAdminRoutesSha256":sys.argv[13],
"nodeApiAttestationSha256":sys.argv[14],"deploymentEnvironmentBeforeSha256":sys.argv[15],
"nodeApiContainerBefore":sys.argv[16],"apiContainerBefore":sys.argv[17],
"workerContainerBefore":sys.argv[18],"action":"rebuild_and_canary"}
for key,value in expected.items():
    if p.get(key)!=value: raise SystemExit(f"early-stop retention retry journal mismatch: {key}")
if p.get("status") not in {"prepared","source_bound","failed","attested_awaiting_continuation","completed"}:
    raise SystemExit("early-stop retention retry journal has an invalid status")
allowed=set(expected)|{"status","preparedAt","updatedAt","completedAt","failureCount","lastExitCode",
"nodeApiContainerAfter","sourceBoundDeploymentEnvironmentSha256","promotionEligible",
"currentDeploymentEnvironmentSha256","currentApiImage","currentWorkerImage","currentDatabaseSnapshotSha256",
"currentCanaryReceiptSha256","currentCutoverStateKind","currentNodeApiImage","currentNodeExpectedBuildId"}
if set(p)!=allowed: raise SystemExit("early-stop retention retry journal has unexpected fields")
hex64=re.compile(r"[0-9a-f]{64}"); image=re.compile(r"sha256:[0-9a-f]{64}")
for key in ("sourceBoundDeploymentEnvironmentSha256","currentDeploymentEnvironmentSha256","currentDatabaseSnapshotSha256"):
    if hex64.fullmatch(p.get(key) or "") is None: raise SystemExit(f"early-stop retention retry journal has invalid {key}")
for key in ("currentApiImage","currentWorkerImage","currentNodeApiImage"):
    if image.fullmatch(p.get(key) or "") is None: raise SystemExit(f"early-stop retention retry journal has invalid {key}")
if p.get("currentNodeApiImage") != p.get("nodeApiImage"):
    raise SystemExit("early-stop retention retry journal records a different current Node image")
if p.get("currentNodeExpectedBuildId") not in {sys.argv[19],sys.argv[5]}:
    raise SystemExit("early-stop retention retry journal has an unexpected Node build binding")
if p.get("currentCutoverStateKind") not in {"pending-pristine","pending-receipt","pending-unmarked-receipt","pending-attested","pending-attested-retained-receipt","terminal"}:
    raise SystemExit("early-stop retention retry journal has an invalid cutover state")
receipt=p.get("currentCanaryReceiptSha256")
if receipt!="absent" and hex64.fullmatch(receipt or "") is None:
    raise SystemExit("early-stop retention retry journal has an invalid receipt binding")
if not isinstance(p.get("failureCount"),int) or p["failureCount"]<0:
    raise SystemExit("early-stop retention retry journal has an invalid failure count")
if p.get("status")=="completed" and (p.get("currentCutoverStateKind")!="terminal" or p.get("promotionEligible") is not True):
    raise SystemExit("completed early-stop retention retry is not terminal/promotion eligible")
if p.get("status")!="completed" and p.get("promotionEligible") is not False:
    raise SystemExit("nonterminal early-stop retention retry must not be promotion eligible")
values=[p["status"],p["currentDeploymentEnvironmentSha256"],p["currentApiImage"],p["currentWorkerImage"],
        p["currentDatabaseSnapshotSha256"],p["currentCanaryReceiptSha256"],p["currentCutoverStateKind"],
        p.get("nodeApiContainerBefore") or "",p.get("nodeApiContainerAfter") or "",
        p["sourceBoundDeploymentEnvironmentSha256"],p["apiContainerBefore"],p["workerContainerBefore"]]
print("\n".join(map(str,values)))
PY
)" || exit $?
  mapfile -t fields <<<"$binding"
  existing_status="${fields[0]}"; expected_env_sha="${fields[1]}"; expected_api_image="${fields[2]}"
  expected_worker_image="${fields[3]}"; expected_database_sha="${fields[4]}"; expected_receipt_sha="${fields[5]}"
  expected_state_kind="${fields[6]}"; node_container_before="${fields[7]}"; node_container_after="${fields[8]}"
  source_bound_env_sha="${fields[9]}"; api_container_before="${fields[10]}"; worker_container_before="${fields[11]}"
fi

current_build="$(read_env_var AIRFOILFOAM_BUILD_ID)"
[[ -n "$current_build" && "$current_build" == "$(read_env_var ENGINE_EXPECTED_BUILD_ID)" ]] || {
  fail "Engine and Node build-id settings are not an atomic pair." 14; exit $?;
}
if [[ -z "$existing_status" && "$current_build" != "$EXPECTED_INITIAL_BUILD_ID" ]]; then
  fail "Initial early-stop-retention retry does not have the exact failed prior build identity." 14; exit $?;
fi
if [[ -z "$existing_status" ]]; then
  assert_initial_container_binding || exit $?
fi
node_now="$(assert_node_runtime "$current_build")" || exit $?
[[ -z "$node_container_before" ]] && node_container_before="$node_now"
actual_env_sha="$(sha256_file "$ENV_FILE")"
actual_database_sha="$(database_snapshot_sha)" || exit $?
actual_receipt_sha="$(receipt_sha)" || exit $?
actual_state_kind="$(cutover_state_kind)" || exit $?
if [[ -z "$existing_status" ]]; then
  [[ "$(read_env_var OPENCFD2606_CUTOVER_SOURCE_REVISION)" == "$EXPECTED_PRIOR_ENGINE_SOURCE_REVISION" && \
     "$(read_env_var OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256)" == "$EXPECTED_PRIOR_ENGINE_SOURCE_TREE_SHA256" ]] || {
    fail "Pending cutover source is not the exact failed 2ab861c source tuple." 14; exit $?;
  }
  [[ -z "$(read_env_var OPENCFD2606_CANARY_ATTESTATION_ID)" && "$actual_receipt_sha" == "absent" && \
     "$actual_state_kind" == "pending-pristine" ]] || {
    fail "Second retention retry requires empty attestation, absent receipt, and pending-pristine state." 14; exit $?;
  }
  assert_pristine_database || exit $?
  assert_application_source_image api "$EXPECTED_INITIAL_API_IMAGE" "$prior_application_source_sha" || exit $?
  assert_application_source_image worker "$EXPECTED_INITIAL_WORKER_IMAGE" "$prior_application_source_sha" || exit $?
fi
progressed_attestation=false
if [[ "$existing_status" =~ ^(attested_awaiting_continuation|failed)$ && \
      "$expected_state_kind" =~ ^pending-attested && \
      "$actual_state_kind" =~ ^(pending-attested|pending-attested-retained-receipt|terminal)$ ]]; then
  # Between the canary stage and this exact certification replay, the operator
  # is expected to run the scheduler under observation long enough to publish
  # successor evidence, then stop it again.  That may legitimately advance
  # the pool/cutover database tuple (or an exact external certification may
  # already have reached terminal).  Accept only the finalized/completed
  # one-cutover/one-attestation shapes; all runtime/source checks still apply.
  assert_attested_or_terminal_database "$actual_state_kind" || exit $?
  progressed_attestation=true
fi
if [[ "$actual_env_sha" != "$expected_env_sha" ]]; then
  # A SIGKILL can land after the atomic source-tuple rename but before the
  # prepared journal advances.  The journal precommits that exact after-hash,
  # so this one crash window is recoverable without guessing.
  [[ "$existing_status" == "prepared" && "$actual_env_sha" == "$source_bound_env_sha" ]] || \
  [[ "$progressed_attestation" == "true" && "$actual_state_kind" == "terminal" ]] || {
    fail "Deployment environment differs from the durable retry binding." 14; exit $?;
  }
fi
[[ "$(service_image api)" == "$expected_api_image" && "$(service_image worker)" == "$expected_worker_image" ]] || {
  fail "Engine images differ from the durable retry binding." 14; exit $?;
}
[[ "$actual_database_sha" == "$expected_database_sha" || "$progressed_attestation" == "true" ]] || {
  fail "Cutover database snapshot differs from the durable retry binding." 14; exit $?;
}
[[ "$actual_receipt_sha" == "$expected_receipt_sha" && "$actual_state_kind" == "$expected_state_kind" ]] || \
[[ "$progressed_attestation" == "true" ]] || {
  fail "Canary receipt/cutover state differs from the durable retry binding." 14; exit $?;
}
assert_scheduler_stopped_and_idle || exit $?
assert_engine_health_for_build "$current_build" || exit $?

source_bound_env_sha="$(TARGET_REVISION="$target_revision" TARGET_TREE="$target_tree" python3 - "$ENV_FILE" <<'PY'
import hashlib,os,sys
path=sys.argv[1]; updates={"OPENCFD2606_CUTOVER_SOURCE_REVISION":os.environ["TARGET_REVISION"],"OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256":os.environ["TARGET_TREE"]}
seen={key:0 for key in updates}; output=[]
for line in open(path,encoding="utf-8").read().splitlines():
    key=line.split("=",1)[0]
    if key in updates: seen[key]+=1; line=f"{key}={updates[key]}"
    output.append(line)
if any(count!=1 for count in seen.values()): raise SystemExit("deployment source tuple is missing or duplicated")
print(hashlib.sha256(("\n".join(output)+"\n").encode()).hexdigest())
PY
)"

if [[ "$existing_status" == "completed" ]]; then
  [[ "$(cutover_state_kind)" == "terminal" ]] || { fail "Completed retry journal lost terminal cutover state." 14; exit $?; }
  echo "Early-stop retention retry is already terminal and eligible for a later normal source promotion."
  exit 0
fi

state_before="$(cutover_state_kind)"
case "$state_before" in
  pending-pristine) retry_action="rebuild_and_canary" ;;
  pending-receipt|pending-unmarked-receipt|pending-attested|pending-attested-retained-receipt) retry_action="certify_only" ;;
  terminal)
    retry_action="none"
    [[ -n "$existing_status" ]] || { fail "Terminal state without this incident's durable retry journal is not accepted." 14; exit $?; }
    persist_retry_journal completed "" true
    echo "Early-stop retention retry was already terminal and is now marked promotion eligible."
    exit 0
    ;;
  *) fail "Unsupported cutover state for early-stop retention retry: $state_before" 14; exit $? ;;
esac

if [[ -z "$existing_status" ]]; then
  persist_retry_journal prepared
  journal_armed=true
  existing_status="prepared"
else
  journal_armed=true
fi

current_env_sha="$(sha256_file "$ENV_FILE")"
if [[ "$current_env_sha" != "$source_bound_env_sha" ]]; then
  [[ "$current_env_sha" == "$EXPECTED_INITIAL_ENV_SHA256" && "$state_before" == "pending-pristine" ]] || {
    fail "Pending source identity is neither the exact old tuple nor the precomputed target tuple." 14; exit $?;
  }
  TARGET_REVISION="$target_revision" TARGET_TREE="$target_tree" python3 - "$ENV_FILE" <<'PY'
import os,stat,sys,tempfile
from pathlib import Path
path=Path(sys.argv[1]); updates={"OPENCFD2606_CUTOVER_SOURCE_REVISION":os.environ["TARGET_REVISION"],"OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256":os.environ["TARGET_TREE"]}
lines=[]; seen={key:0 for key in updates}
for line in path.read_text(encoding="utf-8").splitlines():
    key=line.split("=",1)[0]
    if key in updates: seen[key]+=1; line=f"{key}={updates[key]}"
    lines.append(line)
if any(count!=1 for count in seen.values()): raise SystemExit("deployment source tuple is missing or duplicated")
fd,name=tempfile.mkstemp(prefix=f".{path.name}.source-bind-",dir=path.parent)
try:
    os.fchmod(fd,stat.S_IMODE(path.stat().st_mode))
    with os.fdopen(fd,"w",encoding="utf-8") as stream:
        stream.write("\n".join(lines)+"\n"); stream.flush(); os.fsync(stream.fileno())
    os.replace(name,path); directory_fd=os.open(path.parent,os.O_RDONLY|getattr(os,"O_DIRECTORY",0))
    try: os.fsync(directory_fd)
    finally: os.close(directory_fd)
except BaseException:
    try: os.unlink(name)
    except FileNotFoundError: pass
    raise
PY
fi
[[ "$(sha256_file "$ENV_FILE")" == "$source_bound_env_sha" ]] || { fail "Atomic target source binding did not produce its precomputed environment." 14; exit $?; }
[[ "$(cutover_state_kind)" == "$state_before" ]] || { fail "Cutover semantics changed while rebinding exact source identity." 14; exit $?; }
persist_retry_journal source_bound

cookie_file="$runtime_dir/admin-cookie"; : >"$cookie_file"; chmod 600 "$cookie_file"
node_live="$(running_container node-api)"
docker exec -e "MAINTENANCE_COOKIE_TTL_MS=$MAINTENANCE_COOKIE_TTL_MS" -w /app "$node_live" pnpm exec tsx -e \
  'import { signSession } from "./apps/api/src/admin-auth.ts"; process.stdout.write("aero_admin=" + signSession("cutover-early-stop-retention@airfoils.pro", Number(process.env.MAINTENANCE_COOKIE_TTL_MS), "password"));' \
  >"$cookie_file"
python3 - "$cookie_file" <<'PY'
from pathlib import Path
import re,sys
if re.fullmatch(r"aero_admin=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",Path(sys.argv[1]).read_text()) is None:
    raise SystemExit("live Node container did not create a valid maintenance cookie")
PY
{ printf 'header = "Cookie: '; cat "$cookie_file"; printf '"\n'; } | \
  curl --config - --fail-with-body -sS --max-time 15 http://127.0.0.1:4000/api/admin/me | python3 -c '
import json,sys
p=json.load(sys.stdin)
if p.get("authed") is not True or p.get("email") != "cutover-early-stop-retention@airfoils.pro":
    raise SystemExit("ephemeral maintenance cookie was not accepted")
'

snapshot_fields="$(python3 "$snapshot/scripts/deploy/deployment-source-manifest.py" --verify --root "$snapshot" --manifest "$snapshot/.deployment-source.json")"
[[ "$snapshot_fields" == "$target_revision"$'\t'"$target_tree"$'\t'"$target_count" ]] || { fail "Private target source changed before maintenance child." 14; exit $?; }
[[ "$(tag_image "$NODE_IMAGE_REF")" == "$EXPECTED_NODE_IMAGE" && "$(tag_image "$NODE_REPLAY_TAG")" == "$EXPECTED_NODE_IMAGE" ]] || {
  fail "Verified Node image tags changed before maintenance child." 14; exit $?;
}
assert_prior_incident_immutable || exit $?

child_args=("$target_build_id")
[[ "$retry_action" == "certify_only" ]] && child_args=("--certify-opencfd-2606-continuation")
ADMIN_COOKIE="$(<"$cookie_file")" \
APP_DIR="$snapshot" AIRFOILS_PRO_STATE_DIR="$AIRFOILS_PRO_STATE_DIR" ENV_FILE="$ENV_FILE" \
COMPOSE_FILE="$snapshot/docker-compose.deploy.yml" COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
LOCK_FILE="$private_lock" DEPLOYMENT_MANIFEST_FILE="$snapshot/.deployment-source.json" \
DEPLOY_SOURCE_REVISION="$target_revision" DEPLOY_SOURCE_TREE_SHA256="$target_tree" \
OPENCFD2606_CANARY_RECEIPT_FILE="$OPENCFD2606_CANARY_RECEIPT_FILE" \
"$snapshot/scripts/deploy/rebuild-engine.sh" "${child_args[@]}"

[[ -L "$APP_DIR" && "$(readlink -f "$APP_DIR")" == "$EXPECTED_BOUND_APP_REAL" ]] || { fail "APP_DIR moved during early-stop retention retry." 14; exit $?; }
assert_prior_incident_immutable || exit $?
snapshot_fields="$(python3 "$snapshot/scripts/deploy/deployment-source-manifest.py" --verify --root "$snapshot" --manifest "$snapshot/.deployment-source.json")"
[[ "$snapshot_fields" == "$target_revision"$'\t'"$target_tree"$'\t'"$target_count" ]] || { fail "Private target source changed during maintenance child." 14; exit $?; }
[[ "$(read_env_var AIRFOILFOAM_BUILD_ID)" == "$target_build_id" && "$(read_env_var ENGINE_EXPECTED_BUILD_ID)" == "$target_build_id" ]] || {
  fail "Maintenance child returned without the exact target build-id pair." 14; exit $?;
}
node_container_after="$(assert_node_runtime "$target_build_id")" || exit $?
assert_application_source_image api "$(service_image api)" "$target_application_source_sha" || exit $?
assert_application_source_image worker "$(service_image worker)" "$target_application_source_sha" || exit $?
assert_scheduler_stopped_and_idle || exit $?
assert_engine_health_for_build "$target_build_id" || exit $?
post_state="$(cutover_state_kind)"
case "$post_state" in
  terminal)
    persist_retry_journal completed "" true
    journal_armed=false
    echo "Early-stop retention retry reached terminal cutover proof. A later normal source promotion is now eligible."
    ;;
  pending-attested|pending-attested-retained-receipt)
    persist_retry_journal attested_awaiting_continuation "" false
    journal_armed=false
    echo "Early-stop retention retry produced durable canary attestation. Successor evidence is still required; source promotion is NOT eligible."
    ;;
  *)
    fail "Maintenance child returned successfully without terminal or durable attested state: $post_state" 14
    exit $?
    ;;
esac
