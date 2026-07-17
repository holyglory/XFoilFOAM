#!/usr/bin/env bash
# Incident-specific continuation for the 2026-07-17 OpenCFD v2606 retained
# receipt whose immutable artifact members were emitted in a different order.
#
# The exact three-scenario production canary completed and its immutable,
# generation-pinned GCS receipt remains retained.  The 4 MiB Node route repair
# is already live and proved that the request reached authoritative validation.
# Validation then rejected an order-only mismatch between the Python producer
# and the live Node read model.  This wrapper admits only the reviewed
# order-independent inventory comparison, swaps only node-api, and replays the
# unchanged retained receipt through the unchanged certification-only script.
# It never rebuilds/recreates api or worker, never reruns a canary, never starts
# scheduling, and cannot claim terminal source promotion.
set -Eeuo pipefail

STAGING_DIR="${STAGING_DIR:?STAGING_DIR is required}"
EXPECTED_TARGET_SOURCE_REVISION="${EXPECTED_TARGET_SOURCE_REVISION:?EXPECTED_TARGET_SOURCE_REVISION is required}"
EXPECTED_TARGET_GIT_INVENTORY_SHA256="${EXPECTED_TARGET_GIT_INVENTORY_SHA256:?EXPECTED_TARGET_GIT_INVENTORY_SHA256 is required}"

# Exact incident identity.  A later incident must receive a different reviewed
# wrapper rather than weakening these bindings.
EXPECTED_BASE_SOURCE_REVISION="54ecd8f7fa21e6fb90b20ab06769aa7362224be0"
EXPECTED_BASE_SOURCE_TREE_SHA256="8cfa881e332c9f332f8cc8a229082a3465debfd3758912cb3afb8463140f0340"
EXPECTED_BASE_SOURCE_FILE_COUNT="2210"
EXPECTED_BASE_GIT_INVENTORY_SHA256="16fbe786c7c6346667c683deb790a5feaff773bbf0e1e2d7de88a0ceb1aff76c"
EXPECTED_BOUND_SOURCE_REVISION="63385777be7323777906fde44bdb9fa9b5cc0d6d"
EXPECTED_BOUND_SOURCE_TREE_SHA256="52c8bd3aa6d5a05dcd70a90d8896fb771f7fc36d129e698be0c935680e3fff36"
EXPECTED_BOUND_SOURCE_FILE_COUNT="2198"
EXPECTED_BOUND_APP_REAL="/opt/airfoils-pro/releases/63385777be7323777906fde44bdb9fa9b5cc0d6d-52c8bd3aa6d5a05d"
EXPECTED_BUILD_ID="prod-20260717-7a13801aa5b3-r5"
EXPECTED_ENGINE_APPLICATION_SOURCE_SHA256="661f7061ecd12932305c5a3c479e8d1680d1bcc3ab7e8cd020ab66f5a57075db"
EXPECTED_ENV_BEFORE_SHA256="4ddb1ed4c99b8349340209a76a754e7fd6ae202ef11df3d06012e8a3f6f97d42"
EXPECTED_DATABASE_BEFORE_SHA256="8421c15692afc6e36a834e481734411db61ecf18a95ce4db3a46ec9c7f7ad96c"
EXPECTED_FAILED_JOURNAL_SHA256="6af5dffab919158713f7eecb9a04d23bdb06165b90e5ba9231ba3946c81a594e"
EXPECTED_RECEIPT_SHA256="505819f2c745425071cc7900967abaead0911f30ab6af1636a8af92baf7276e8"
EXPECTED_RECEIPT_BYTE_SIZE="2313736"
EXPECTED_NODE_IMAGE="sha256:4ee79b1da45fdb5e9cfea63c2cd25380e9ba0bf858cebfc23a1c74ec68f8f964"
EXPECTED_API_IMAGE="sha256:0671d20962896f3d1413b83d3f384a4ba06ca2bdaedcf187822f19994cc7a3c1"
EXPECTED_WORKER_IMAGE="sha256:9f9a957e3e51d78701eeebd9ead90d5d26c234b9e91ae80f6e81316d017f35a6"
EXPECTED_NODE_CONTAINER="5f82ec56d030f54b4dfbe168f93d47a9bdc8e2c2bd1ad38faa31fbc08865425d"
EXPECTED_API_CONTAINER="44dfc912a91e92ab42faa8c5078041cfbecf3452c37765aa838b0fc4872531ef"
EXPECTED_WORKER_CONTAINER="7f43b1b65edf4dc758f34a5fc2555e2fae401010ae6ea34ff39fae846b4081f8"
EXPECTED_ROUTE_SHA256="806243c45225487036f98bf144f6bc362e0d54324f640ac59a440f5a5700d15d"
EXPECTED_ROUTE_TEST_SHA256="ea1d72664200d4c29f140b0ca543e34c2bdb5e35c58e61081aa7a5cfd8afd6bd"
EXPECTED_BASE_ATTESTATION_SHA256="928986cd328e7af647cefe7c241ed1a5ce9a6446907061055a28f28392c0944e"
EXPECTED_BASE_ATTESTATION_TEST_SHA256="25452e17a7714911151cb13c5f88e2b91485a126387baf3514080e9f3ac1bb44"
EXPECTED_TARGET_ATTESTATION_SHA256="6f10619510378451e47e8aaa6579e663b879e47ce0af98097680c2b4462ddc62"
EXPECTED_TARGET_ATTESTATION_TEST_SHA256="6046af2febe268060afcf7eff386a99ab5c6d0930e5eea2d70f10a715805b65b"
EXPECTED_NODE_ADMIN_ROUTES_SHA256="e3e1782f0517ea29e451fd89661a1a54f982673cd62ad5502e5d45eaaa6a94f4"
EXPECTED_REBUILD_SHA256="008b8d8e92493b33eb7888b3dd6651696c512eddba377ee342b03dca6f51441f"
EXPECTED_CANARY_SHA256="df6f7558e3d53e1f7fd6158c171d02a1d62fe74ce721eb6cdb0132e6efff8f48"
EXPECTED_APP_LINK="/opt/airfoils-pro/app"
EXPECTED_STATE_DIR="/opt/airfoils-pro/state"
EXPECTED_ENV_FILE="/opt/airfoils-pro/state/.env.deploy"
EXPECTED_LOCK_FILE="/tmp/airfoils-pro-deploy.lock"
EXPECTED_COMPOSE_PROJECT_NAME="app"
OPENCFD_2606_POOL_ID="3f8bc764-09ae-4ff3-8fd2-001400000001"
OPENCFD_2406_POOL_ID="3f8bc764-09ae-4ff3-8fd2-240600000001"
OPENCFD_2606_TARGET_POOL_ID="3f8bc764-09ae-4ff3-8fd2-260600000001"
OPENCFD_2606_ROUTE="openfoam-opencfd-2606"
CAMPAIGN_ID="c24047fa-743f-4ae5-bcd6-f3071ff79fb4"
CUTOVER_ID="b1d018a0-e0cc-4ffa-af5c-dcfd1c0ff7ee"
MAINTENANCE_COOKIE_TTL_MS="14400000"

if [[ "${APP_DIR:-$EXPECTED_APP_LINK}" != "$EXPECTED_APP_LINK" || \
      "${AIRFOILS_PRO_STATE_DIR:-$EXPECTED_STATE_DIR}" != "$EXPECTED_STATE_DIR" || \
      "${ENV_FILE:-$EXPECTED_ENV_FILE}" != "$EXPECTED_ENV_FILE" || \
      "${LOCK_FILE:-$EXPECTED_LOCK_FILE}" != "$EXPECTED_LOCK_FILE" || \
      "${COMPOSE_PROJECT_NAME:-$EXPECTED_COMPOSE_PROJECT_NAME}" != "$EXPECTED_COMPOSE_PROJECT_NAME" ]]; then
  echo "Attestation recovery refuses caller overrides of application, state, lock, or Compose paths." >&2
  exit 2
fi

APP_DIR="$EXPECTED_APP_LINK"
AIRFOILS_PRO_STATE_DIR="$EXPECTED_STATE_DIR"
ENV_FILE="$EXPECTED_ENV_FILE"
CANONICAL_LOCK_FILE="$EXPECTED_LOCK_FILE"
COMPOSE_PROJECT_NAME="$EXPECTED_COMPOSE_PROJECT_NAME"
FAILED_JOURNAL_FILE="$AIRFOILS_PRO_STATE_DIR/pending-opencfd2606-attestation-413-recovery.json"
RECOVERY_JOURNAL_FILE="$AIRFOILS_PRO_STATE_DIR/pending-opencfd2606-artifact-order-attestation-recovery.json"
OPENCFD2606_CANARY_RECEIPT_FILE="$AIRFOILS_PRO_STATE_DIR/openfoam-2606-canary-receipt.pending.json"
BASE_INVENTORY_RELATIVE=".codex-artifacts/opencfd2606-artifact-order-base-ls-tree.txt"
TARGET_INVENTORY_RELATIVE=".codex-artifacts/opencfd2606-artifact-order-target-ls-tree.txt"
NODE_IMAGE_REF="${COMPOSE_PROJECT_NAME}-node-api"
NODE_REPAIR_TAG="airfoils-pro/node-api-artifact-order:${EXPECTED_TARGET_SOURCE_REVISION:0:12}"
NODE_ROLLBACK_TAG="airfoils-pro/node-api-artifact-order-rollback:${EXPECTED_BASE_SOURCE_REVISION:0:12}"

umask 077
runtime_dir=""
snapshot=""
target_revision=""
target_tree=""
target_count=""
source_bound_env_sha=""
node_image_after=""
node_container_after=""
journal_phase=""
failure_journal_recorded=false

fail() {
  echo "$1" >&2
  return "${2:-14}"
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

require_regular_owned_mode() {
  local path="$1" mode="$2" label="$3"
  if [[ ! -f "$path" || -L "$path" || "$(stat -c '%a' "$path")" != "$mode" || \
        "$(stat -c '%u' "$path")" != "$(id -u)" ]]; then
    fail "$label must be a same-owner mode-$mode regular file: $path" 14
    return $?
  fi
}

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
    -f "$snapshot/docker-compose.deploy.yml" "$@"
}

running_container() {
  local service="$1" ids
  ids="$(compose_bound ps --status running -q "$service")" || return 12
  [[ -n "$ids" && "$(wc -l <<<"$ids")" -eq 1 ]] || {
    fail "Attestation recovery requires exactly one running $service container." 12
    return $?
  }
  printf '%s' "$ids"
}

service_image() {
  local id
  id="$(running_container "$1")" || return $?
  docker inspect --format '{{.Image}}' "$id"
}

tag_image() {
  docker image inspect --format '{{.Id}}' "$1"
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

cutover_state_json() {
  local source_revision source_tree
  source_revision="$(read_env_var OPENCFD2606_CUTOVER_SOURCE_REVISION)"
  source_tree="$(read_env_var OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256)"
  if [[ -z "$source_revision" && -z "$source_tree" ]]; then
    source_revision="${target_revision:-$EXPECTED_BASE_SOURCE_REVISION}"
    source_tree="${target_tree:-$EXPECTED_BASE_SOURCE_TREE_SHA256}"
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

database_snapshot_payload() {
  compose_bound exec -T postgres psql -U aerodb -d aerodb -X -v ON_ERROR_STOP=1 -Atc "
WITH target_impl AS (
  SELECT solver_implementation_id AS id
  FROM solver_execution_pools
  WHERE id = '$OPENCFD_2606_TARGET_POOL_ID'
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
  'poolRows', (SELECT count(*) FROM solver_execution_pools WHERE id = '$OPENCFD_2606_TARGET_POOL_ID'),
  'poolEnabled', (SELECT enabled FROM solver_execution_pools WHERE id = '$OPENCFD_2606_TARGET_POOL_ID'),
  'cutovers', (SELECT rows FROM target_cutovers),
  'attestationCount', (SELECT count(*) FROM solver_engine_canary_attestations)
)::text;
" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(",",":")))'
}

database_snapshot_sha() {
  local payload
  payload="$(database_snapshot_payload)" || return $?
  sha256_text "$payload"
}

assert_initial_database() {
  database_snapshot_payload | python3 -c '
import json,sys
p=json.load(sys.stdin); rows=p.get("cutovers")
if p.get("poolRows") != 1 or p.get("poolEnabled") is not False:
    raise SystemExit("OpenCFD 2606 target pool is not uniquely disabled")
if p.get("attestationCount") != 0 or not isinstance(rows,list) or len(rows)!=1:
    raise SystemExit("pre-attestation state must have no attestation and one cutover")
row=rows[0]
expected={"id":sys.argv[1],"status":"prepared","canaryAttestationId":None,
          "targetPlanRevisionId":None,"finalizedAt":None,"completedAt":None}
if any(row.get(k)!=v for k,v in expected.items()):
    raise SystemExit("prepared cutover row differs from the exact failed incident")
' "$CUTOVER_ID"
}

assert_progressed_database() {
  local state_kind="$1" attestation
  attestation="$(read_env_var OPENCFD2606_CANARY_ATTESTATION_ID)"
  database_snapshot_payload | python3 -c '
import json,re,sys
p=json.load(sys.stdin); kind=sys.argv[1]; expected_id=sys.argv[2]; env_attestation=sys.argv[3]
rows=p.get("cutovers")
if p.get("poolRows") != 1 or not isinstance(p.get("poolEnabled"),bool):
    raise SystemExit("target execution pool shape is invalid")
if p.get("attestationCount") != 1 or not isinstance(rows,list) or len(rows)!=1:
    raise SystemExit("expected exactly one attestation and one cutover")
row=rows[0]
if row.get("id") != expected_id: raise SystemExit("unexpected cutover identity")
canary=row.get("canaryAttestationId")
if not isinstance(canary,str) or re.fullmatch(r"[0-9a-f-]{36}",canary) is None:
    raise SystemExit("cutover lacks an exact canary attestation")
if row.get("targetPlanRevisionId") is None or row.get("finalizedAt") is None:
    raise SystemExit("cutover lacks finalized target-plan evidence")
if kind in {"pending-attested","pending-attested-retained-receipt"}:
    if row.get("status")!="finalized" or row.get("completedAt") is not None or canary!=env_attestation:
        raise SystemExit("pending-attested database state is invalid")
elif kind=="terminal":
    if row.get("status")!="completed" or row.get("completedAt") is None:
        raise SystemExit("terminal database state is invalid")
else:
    raise SystemExit("unsupported progressed cutover state")
' "$state_kind" "$CUTOVER_ID" "$attestation"
}

assert_all_pools_disabled_and_campaign_paused() {
  compose_bound exec -T postgres psql -U aerodb -d aerodb -X -v ON_ERROR_STOP=1 -Atc "
SELECT json_build_object(
  'pools', COALESCE((
    SELECT json_agg(json_build_object('id', id, 'enabled', enabled) ORDER BY id)
    FROM solver_execution_pools
  ), '[]'::json),
  'campaignStatus', (SELECT status FROM sim_campaigns WHERE id = '$CAMPAIGN_ID')
)::text;
" | python3 -c '
import json,sys
p=json.load(sys.stdin); pools=p.get("pools")
expected={sys.argv[1],sys.argv[2],sys.argv[3]}
if not isinstance(pools,list) or {row.get("id") for row in pools}!=expected or any(row.get("enabled") is not False for row in pools):
    raise SystemExit("all three production execution pools must remain disabled")
if p.get("campaignStatus")!="paused": raise SystemExit("campaign must remain paused")
' "$OPENCFD_2606_POOL_ID" "$OPENCFD_2406_POOL_ID" "$OPENCFD_2606_TARGET_POOL_ID"
}

assert_successor_awaiting_scheduler() {
  compose_bound exec -T postgres psql -U aerodb -d aerodb -X -v ON_ERROR_STOP=1 -Atc "
SELECT json_build_object(
  'campaignStatus', (SELECT status FROM sim_campaigns WHERE id = '$CAMPAIGN_ID'),
  'liveCampaignJobs', (
    SELECT count(*) FROM sim_jobs
    WHERE campaign_id = '$CAMPAIGN_ID'
      AND status IN ('pending','submitted','running','ingesting')
  ),
  'checks', COALESCE((
    SELECT json_agg(json_build_object(
      'status', status, 'simJobId', sim_job_id, 'evidenceResultId', evidence_result_id
    ) ORDER BY id)
    FROM solver_cutover_continuation_checks
    WHERE canary_attestation_id = (
      SELECT canary_attestation_id FROM sim_campaign_solver_cutovers WHERE id = '$CUTOVER_ID'
    )
  ), '[]'::json)
)::text;
" | python3 -c '
import json,sys
p=json.load(sys.stdin); checks=p.get("checks")
if p.get("campaignStatus")!="paused" or p.get("liveCampaignJobs")!=0:
    raise SystemExit("paused successor must have no admitted campaign jobs")
if not isinstance(checks,list) or len(checks)!=1:
    raise SystemExit("expected exactly one successor continuation check")
row=checks[0]
if row.get("status")!="pending" or row.get("simJobId") is not None or row.get("evidenceResultId") is not None:
    raise SystemExit("successor continuation is not in the exact stopped-scheduler awaiting state")
'
}

assert_scheduler_stopped_and_idle() {
  if [[ -n "$(compose_bound ps --status running -q sweeper)" ]]; then
    fail "Attestation recovery requires the scheduler to remain stopped." 12
    return $?
  fi
  local output hidden
  hidden="$(docker ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --format '{{.Label "com.docker.compose.service"}}' | awk '$0 ~ /^worker-/')"
  [[ -z "$hidden" ]] || { fail "Attestation recovery refuses hidden optional workers: $hidden" 12; return $?; }
  output="$(compose_bound exec -T worker sh -lc \
    'pgrep -af "[s]impleFoam|[p]impleFoam|[p]otentialFoam|[s]nappyHexMesh|[s]urfaceFeatureExtract|[b]lockMesh|[c]heckMesh|[d]ecomposePar|[r]econstructPar|[r]enumberMesh|[m]apFields|[p]ostProcess|[f]oamToVTK|[f]oamRun|[f]oamJob" || true')" || return 12
  [[ -z "$output" ]] || { fail "Attestation recovery refuses active OpenFOAM work: $output" 12; return $?; }
  curl -fsS --max-time 15 http://127.0.0.1:8000/queue | python3 -c '
import json,sys
p=json.load(sys.stdin)
for field in ("active_count","reserved_count","scheduled_count","queue_depth"):
    if p.get(field)!=0: raise SystemExit(f"engine queue is not idle: {field}")
if p.get("job_ids") not in ([],None) or p.get("inspection_errors") not in ({},None):
    raise SystemExit("engine queue reports work or inspection errors")
if p.get("worker_queues_error") is not None or p.get("worker_runtime_error") is not None:
    raise SystemExit("engine worker observability is unavailable")
bindings=p.get("worker_queues")
if not isinstance(bindings,list) or len(bindings)!=1: raise SystemExit("expected one worker binding")
b=bindings[0]; engine=b.get("engine") or {}
expected={"family":"openfoam","distribution":"opencfd","version":"2606",
          "numerics_revision":"1","adapter_contract_version":1}
if b.get("queues")!=[sys.argv[1]] or b.get("execution_pool")!=sys.argv[1] or \
   {k:engine.get(k) for k in expected}!=expected:
    raise SystemExit("worker route/runtime differs from the attested engine")
' "$OPENCFD_2606_ROUTE"
}

assert_engine_health() {
  curl -fsS --max-time 15 http://127.0.0.1:8000/health | python3 -c '
import json,sys
p=json.load(sys.stdin); engine=p.get("default_engine") or {}
expected_engine={"family":"openfoam","distribution":"opencfd","version":"2606",
                 "numerics_revision":"1","adapter_contract_version":1}
expected_storage={"backend":"gcs","bucket":"airfoils-pro-storage-bucket",
 "object_prefix":"solver-evidence/v1","archive_format":"tar+zstd",
 "compression":"zstd","zstd_level":10,"remote_only":True}
if p.get("build_id")!=sys.argv[1] or {k:engine.get(k) for k in expected_engine}!=expected_engine:
    raise SystemExit("engine build/runtime identity changed")
if p.get("evidence_storage")!=expected_storage:
    raise SystemExit("engine evidence-storage identity changed")
' "$EXPECTED_BUILD_ID"
}

assert_engine_containers() {
  local api_id worker_id
  api_id="$(running_container api)" || return $?
  worker_id="$(running_container worker)" || return $?
  [[ "$api_id" == "$EXPECTED_API_CONTAINER" && "$worker_id" == "$EXPECTED_WORKER_CONTAINER" ]] || {
    fail "api/worker container identity changed; refusing Node-only recovery." 12
    return $?
  }
  [[ "$(docker inspect --format '{{.Image}}' "$api_id")" == "$EXPECTED_API_IMAGE" && \
     "$(docker inspect --format '{{.Image}}' "$worker_id")" == "$EXPECTED_WORKER_IMAGE" ]] || {
    fail "api/worker image identity changed; refusing Node-only recovery." 12
    return $?
  }
  [[ "$(tag_image "${COMPOSE_PROJECT_NAME}-api")" == "$EXPECTED_API_IMAGE" && \
     "$(tag_image "${COMPOSE_PROJECT_NAME}-worker")" == "$EXPECTED_WORKER_IMAGE" ]] || {
    fail "api/worker project image tags changed; refusing Node-only recovery." 12
    return $?
  }
  for service in api worker; do
    [[ "$(docker exec "$(running_container "$service")" \
      cat /etc/airfoilfoam-application-source-sha256 | tr -d '\r\n')" \
      == "$EXPECTED_ENGINE_APPLICATION_SOURCE_SHA256" ]] || {
      fail "$service application-source identity changed." 12
      return $?
    }
  done
}

node_source_hashes() {
  local id
  id="$(running_container node-api)" || return $?
  docker exec "$id" sh -ec \
    'sha256sum /app/apps/api/src/openfoam-2606-attestation.ts /app/apps/api/test/openfoam-2606-attestation.test.ts' \
    | awk '{print $1}'
}

assert_node_source() {
  local expected_attestation="$1" expected_test="$2" hashes id admin_sha route_sha route_test_sha baked_build
  id="$(running_container node-api)" || return $?
  hashes="$(node_source_hashes)" || return $?
  [[ "$hashes" == "$expected_attestation"$'\n'"$expected_test" ]] || {
    fail "Live Node API does not contain the exact reviewed attestation and regression bytes." 12
    return $?
  }
  curl -fsS --max-time 10 http://127.0.0.1:4000/health | python3 -c '
import json,sys
p=json.load(sys.stdin)
if p != {"ok":True,"service":"aerodb-api"}: raise SystemExit("Node API health payload is invalid")
  '
  admin_sha="$(docker exec "$id" sha256sum /app/apps/api/src/admin-routes.ts | awk '{print $1}')" || return 12
  route_sha="$(docker exec "$id" sha256sum /app/apps/api/src/engine-cutover-routes.ts | awk '{print $1}')" || return 12
  route_test_sha="$(docker exec "$id" sha256sum /app/apps/api/test/engine-cutover-routes.test.ts | awk '{print $1}')" || return 12
  baked_build="$(docker exec "$id" printenv ENGINE_EXPECTED_BUILD_ID)" || return 12
  [[ "$admin_sha" == "$EXPECTED_NODE_ADMIN_ROUTES_SHA256" && \
     "$route_sha" == "$EXPECTED_ROUTE_SHA256" && \
     "$route_test_sha" == "$EXPECTED_ROUTE_TEST_SHA256" && \
     "$baked_build" == "$EXPECTED_BUILD_ID" && \
     "$(read_env_var ENGINE_EXPECTED_BUILD_ID)" == "$EXPECTED_BUILD_ID" ]] || {
    fail "Node expected engine build id drifted." 12
    return $?
  }
}

assert_initial_receipt() {
  require_regular_owned_mode "$OPENCFD2606_CANARY_RECEIPT_FILE" 600 "Retained canary receipt"
  [[ "$(stat -c '%s' "$OPENCFD2606_CANARY_RECEIPT_FILE")" == "$EXPECTED_RECEIPT_BYTE_SIZE" && \
     "$(sha256_file "$OPENCFD2606_CANARY_RECEIPT_FILE")" == "$EXPECTED_RECEIPT_SHA256" ]] || {
    fail "Retained canary receipt differs from the exact 2.31 MiB production receipt." 14
    return $?
  }
}

assert_failed_journal() {
  require_regular_owned_mode "$FAILED_JOURNAL_FILE" 600 "Failed parser-limit attestation recovery journal"
  [[ "$(sha256_file "$FAILED_JOURNAL_FILE")" == "$EXPECTED_FAILED_JOURNAL_SHA256" ]] || {
    fail "Failed recovery journal differs from the exact artifact-order incident." 14
    return $?
  }
  python3 - "$FAILED_JOURNAL_FILE" <<'PY'
import json,sys
p=json.load(open(sys.argv[1],encoding="utf-8"))
expected={"schemaVersion":1,"purpose":"pending-opencfd2606-attestation-413-recovery",
          "status":"failed","failureCount":1,"lastExitCode":14,
          "repairSourceRevision":"54ecd8f7fa21e6fb90b20ab06769aa7362224be0",
          "repairSourceTreeSha256":"8cfa881e332c9f332f8cc8a229082a3465debfd3758912cb3afb8463140f0340",
          "repairSourceFileCount":2210,
          "currentDeploymentEnvironmentSha256":"4ddb1ed4c99b8349340209a76a754e7fd6ae202ef11df3d06012e8a3f6f97d42",
          "currentDatabaseSnapshotSha256":"8421c15692afc6e36a834e481734411db61ecf18a95ce4db3a46ec9c7f7ad96c",
          "currentCanaryReceiptSha256":"505819f2c745425071cc7900967abaead0911f30ab6af1636a8af92baf7276e8",
          "currentCutoverStateKind":"pending-receipt","promotionEligible":False,
          "nodeApiImageAfter":"sha256:4ee79b1da45fdb5e9cfea63c2cd25380e9ba0bf858cebfc23a1c74ec68f8f964",
          "nodeApiContainerAfter":"5f82ec56d030f54b4dfbe168f93d47a9bdc8e2c2bd1ad38faa31fbc08865425d",
          "apiImage":"sha256:0671d20962896f3d1413b83d3f384a4ba06ca2bdaedcf187822f19994cc7a3c1",
          "apiContainer":"44dfc912a91e92ab42faa8c5078041cfbecf3452c37765aa838b0fc4872531ef",
          "workerImage":"sha256:9f9a957e3e51d78701eeebd9ead90d5d26c234b9e91ae80f6e81316d017f35a6",
          "workerContainer":"7f43b1b65edf4dc758f34a5fc2555e2fae401010ae6ea34ff39fae846b4081f8",
          "action":"node_only_then_certify_retained_receipt"}
for key,value in expected.items():
    if p.get(key)!=value: raise SystemExit(f"failed incident journal mismatch: {key}")
PY
}

persist_journal() {
  local status="$1" last_exit="${2:-}" eligible="${3:-false}" completed="${4:-}"
  local temp current_env current_receipt current_state current_db
  current_env="$(sha256_file "$ENV_FILE")"
  current_receipt="$(receipt_sha)"
  current_state="$(cutover_state_kind)"
  current_db="$(database_snapshot_sha)"
  temp="$(mktemp "$AIRFOILS_PRO_STATE_DIR/.pending-opencfd2606-artifact-order.XXXXXX")"
  chmod 600 "$temp"
  RECOVERY_STATUS="$status" RECOVERY_LAST_EXIT="$last_exit" RECOVERY_ELIGIBLE="$eligible" \
  RECOVERY_COMPLETED="$completed" RECOVERY_DEST="$RECOVERY_JOURNAL_FILE" \
  RECOVERY_TARGET_REVISION="$target_revision" RECOVERY_TARGET_TREE="$target_tree" \
  RECOVERY_TARGET_COUNT="$target_count" RECOVERY_SOURCE_BOUND_ENV="$source_bound_env_sha" \
  RECOVERY_NODE_IMAGE_AFTER="$node_image_after" RECOVERY_NODE_CONTAINER_AFTER="$node_container_after" \
  RECOVERY_CURRENT_ENV="$current_env" RECOVERY_CURRENT_RECEIPT="$current_receipt" \
  RECOVERY_CURRENT_STATE="$current_state" RECOVERY_CURRENT_DB="$current_db" \
  python3 - "$temp" <<'PY'
from datetime import datetime,timezone
import json,os
from pathlib import Path
now=datetime.now(timezone.utc).isoformat()
destination=Path(os.environ["RECOVERY_DEST"])
prepared=now; failures=0
if destination.exists():
    old=json.loads(destination.read_text(encoding="utf-8"))
    prepared=old.get("preparedAt",now)
    failures=int(old.get("failureCount",0))
if os.environ["RECOVERY_STATUS"]=="failed": failures+=1
last=os.environ["RECOVERY_LAST_EXIT"]
p={
 "schemaVersion":1,"purpose":"pending-opencfd2606-artifact-order-attestation-recovery",
 "status":os.environ["RECOVERY_STATUS"],"preparedAt":prepared,"updatedAt":now,
 "completedAt":os.environ["RECOVERY_COMPLETED"] or None,
 "failureCount":failures,"lastExitCode":int(last) if last else None,
 "baseSourceRevision":"54ecd8f7fa21e6fb90b20ab06769aa7362224be0",
 "baseSourceTreeSha256":"8cfa881e332c9f332f8cc8a229082a3465debfd3758912cb3afb8463140f0340",
 "repairSourceRevision":os.environ["RECOVERY_TARGET_REVISION"],
 "repairSourceTreeSha256":os.environ["RECOVERY_TARGET_TREE"],
 "repairSourceFileCount":int(os.environ["RECOVERY_TARGET_COUNT"]),
 "attestationSha256":"6f10619510378451e47e8aaa6579e663b879e47ce0af98097680c2b4462ddc62",
 "attestationTestSha256":"6046af2febe268060afcf7eff386a99ab5c6d0930e5eea2d70f10a715805b65b",
 "priorRecoveryJournalSha256":"6af5dffab919158713f7eecb9a04d23bdb06165b90e5ba9231ba3946c81a594e",
 "retainedReceiptSha256":"505819f2c745425071cc7900967abaead0911f30ab6af1636a8af92baf7276e8",
 "retainedReceiptByteSize":2313736,
 "buildId":"prod-20260717-7a13801aa5b3-r5",
 "engineApplicationSourceSha256":"661f7061ecd12932305c5a3c479e8d1680d1bcc3ab7e8cd020ab66f5a57075db",
 "deploymentEnvironmentBeforeSha256":"4ddb1ed4c99b8349340209a76a754e7fd6ae202ef11df3d06012e8a3f6f97d42",
 "sourceBoundDeploymentEnvironmentSha256":os.environ["RECOVERY_SOURCE_BOUND_ENV"],
 "databaseBeforeSha256":"8421c15692afc6e36a834e481734411db61ecf18a95ce4db3a46ec9c7f7ad96c",
 "nodeApiImageBefore":"sha256:4ee79b1da45fdb5e9cfea63c2cd25380e9ba0bf858cebfc23a1c74ec68f8f964",
 "nodeApiContainerBefore":"5f82ec56d030f54b4dfbe168f93d47a9bdc8e2c2bd1ad38faa31fbc08865425d",
 "nodeApiImageAfter":os.environ["RECOVERY_NODE_IMAGE_AFTER"] or None,
 "nodeApiContainerAfter":os.environ["RECOVERY_NODE_CONTAINER_AFTER"] or None,
 "apiImage":"sha256:0671d20962896f3d1413b83d3f384a4ba06ca2bdaedcf187822f19994cc7a3c1",
 "apiContainer":"44dfc912a91e92ab42faa8c5078041cfbecf3452c37765aa838b0fc4872531ef",
 "workerImage":"sha256:9f9a957e3e51d78701eeebd9ead90d5d26c234b9e91ae80f6e81316d017f35a6",
 "workerContainer":"7f43b1b65edf4dc758f34a5fc2555e2fae401010ae6ea34ff39fae846b4081f8",
 "currentDeploymentEnvironmentSha256":os.environ["RECOVERY_CURRENT_ENV"],
 "currentDatabaseSnapshotSha256":os.environ["RECOVERY_CURRENT_DB"],
 "currentCanaryReceiptSha256":os.environ["RECOVERY_CURRENT_RECEIPT"],
 "currentCutoverStateKind":os.environ["RECOVERY_CURRENT_STATE"],
 "action":"node_only_then_certify_order_independent_receipt",
 "promotionEligible":os.environ["RECOVERY_ELIGIBLE"]=="true",
}
Path(os.environ["RECOVERY_DEST"]).parent.mkdir(parents=True,exist_ok=True)
with open(os.sys.argv[1],"w",encoding="utf-8") as stream:
    stream.write(json.dumps(p,sort_keys=True,separators=(",",":"))+"\n")
    stream.flush()
    os.fsync(stream.fileno())
PY
  mv -f "$temp" "$RECOVERY_JOURNAL_FILE"
  python3 - "$AIRFOILS_PRO_STATE_DIR" <<'PY'
import os,sys
fd=os.open(sys.argv[1],os.O_RDONLY|getattr(os,"O_DIRECTORY",0))
try: os.fsync(fd)
finally: os.close(fd)
PY
}

load_journal() {
  require_regular_owned_mode "$RECOVERY_JOURNAL_FILE" 600 "Attestation recovery journal"
  local fields
  fields="$(python3 - "$RECOVERY_JOURNAL_FILE" "$target_revision" "$target_tree" "$target_count" <<'PY'
import json,re,sys
p=json.load(open(sys.argv[1],encoding="utf-8"))
expected={
 "schemaVersion":1,"purpose":"pending-opencfd2606-artifact-order-attestation-recovery",
 "baseSourceRevision":"54ecd8f7fa21e6fb90b20ab06769aa7362224be0",
 "baseSourceTreeSha256":"8cfa881e332c9f332f8cc8a229082a3465debfd3758912cb3afb8463140f0340",
 "repairSourceRevision":sys.argv[2],"repairSourceTreeSha256":sys.argv[3],
 "repairSourceFileCount":int(sys.argv[4]),
 "attestationSha256":"6f10619510378451e47e8aaa6579e663b879e47ce0af98097680c2b4462ddc62",
 "attestationTestSha256":"6046af2febe268060afcf7eff386a99ab5c6d0930e5eea2d70f10a715805b65b",
 "priorRecoveryJournalSha256":"6af5dffab919158713f7eecb9a04d23bdb06165b90e5ba9231ba3946c81a594e",
 "retainedReceiptSha256":"505819f2c745425071cc7900967abaead0911f30ab6af1636a8af92baf7276e8",
 "retainedReceiptByteSize":2313736,"buildId":"prod-20260717-7a13801aa5b3-r5",
 "engineApplicationSourceSha256":"661f7061ecd12932305c5a3c479e8d1680d1bcc3ab7e8cd020ab66f5a57075db",
 "deploymentEnvironmentBeforeSha256":"4ddb1ed4c99b8349340209a76a754e7fd6ae202ef11df3d06012e8a3f6f97d42",
 "databaseBeforeSha256":"8421c15692afc6e36a834e481734411db61ecf18a95ce4db3a46ec9c7f7ad96c",
 "nodeApiImageBefore":"sha256:4ee79b1da45fdb5e9cfea63c2cd25380e9ba0bf858cebfc23a1c74ec68f8f964",
 "nodeApiContainerBefore":"5f82ec56d030f54b4dfbe168f93d47a9bdc8e2c2bd1ad38faa31fbc08865425d",
 "apiImage":"sha256:0671d20962896f3d1413b83d3f384a4ba06ca2bdaedcf187822f19994cc7a3c1",
 "apiContainer":"44dfc912a91e92ab42faa8c5078041cfbecf3452c37765aa838b0fc4872531ef",
 "workerImage":"sha256:9f9a957e3e51d78701eeebd9ead90d5d26c234b9e91ae80f6e81316d017f35a6",
 "workerContainer":"7f43b1b65edf4dc758f34a5fc2555e2fae401010ae6ea34ff39fae846b4081f8",
 "action":"node_only_then_certify_order_independent_receipt"}
for k,v in expected.items():
    if p.get(k)!=v: raise SystemExit(f"attestation recovery journal mismatch: {k}")
if p.get("status") not in {"prepared","node_applied","source_bound",
                           "attested_awaiting_continuation","failed"}:
    raise SystemExit("invalid recovery status")
for key in ("sourceBoundDeploymentEnvironmentSha256","currentDeploymentEnvironmentSha256",
            "currentDatabaseSnapshotSha256"):
    if re.fullmatch(r"[0-9a-f]{64}",p.get(key) or "") is None:
        raise SystemExit(f"invalid {key}")
for key in ("nodeApiImageAfter",):
    if p.get(key) is not None and re.fullmatch(r"sha256:[0-9a-f]{64}",p[key]) is None:
        raise SystemExit(f"invalid {key}")
print(p["status"])
print(p.get("nodeApiImageAfter") or "")
print(p.get("nodeApiContainerAfter") or "")
allowed=set(expected)|{"status","preparedAt","updatedAt","completedAt","failureCount","lastExitCode",
 "sourceBoundDeploymentEnvironmentSha256","nodeApiImageAfter","nodeApiContainerAfter",
 "currentDeploymentEnvironmentSha256","currentDatabaseSnapshotSha256","currentCanaryReceiptSha256",
 "currentCutoverStateKind","promotionEligible"}
if set(p)!=allowed: raise SystemExit("attestation recovery journal has unexpected fields")
if p.get("promotionEligible") is not False or p.get("completedAt") is not None:
    raise SystemExit("artifact-order recovery journal must remain nonterminal and promotion-ineligible")
print(p["sourceBoundDeploymentEnvironmentSha256"])
PY
)" || return $?
  mapfile -t journal_fields <<<"$fields"
  journal_phase="${journal_fields[0]}"
  node_image_after="${journal_fields[1]}"
  node_container_after="${journal_fields[2]}"
  source_bound_env_sha="${journal_fields[3]}"
}

atomic_bind_target_source() {
  TARGET_REVISION="$target_revision" TARGET_TREE="$target_tree" python3 - "$ENV_FILE" <<'PY'
import os,stat,sys,tempfile
from pathlib import Path
path=Path(sys.argv[1])
updates={"OPENCFD2606_CUTOVER_SOURCE_REVISION":os.environ["TARGET_REVISION"],
         "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256":os.environ["TARGET_TREE"]}
lines=[]; seen={key:0 for key in updates}
for line in path.read_text(encoding="utf-8").splitlines():
    key=line.split("=",1)[0]
    if key in updates: seen[key]+=1; line=f"{key}={updates[key]}"
    lines.append(line)
if any(v!=1 for v in seen.values()): raise SystemExit("source tuple is missing or duplicated")
fd,name=tempfile.mkstemp(prefix=f".{path.name}.artifact-order-",dir=path.parent)
try:
    os.fchmod(fd,stat.S_IMODE(path.stat().st_mode))
    with os.fdopen(fd,"w",encoding="utf-8") as f:
        f.write("\n".join(lines)+"\n"); f.flush(); os.fsync(f.fileno())
    os.replace(name,path)
    dfd=os.open(path.parent,os.O_RDONLY|getattr(os,"O_DIRECTORY",0))
    try: os.fsync(dfd)
    finally: os.close(dfd)
except BaseException:
    try: os.unlink(name)
    except FileNotFoundError: pass
    raise
PY
}

wait_node() {
  local i
  for ((i=1;i<=60;i++)); do
    if curl -fsS --max-time 5 http://127.0.0.1:4000/health >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

rollback_node() {
  echo "Rolling back the uncommitted Node-only artifact-order repair..."
  docker tag "$EXPECTED_NODE_IMAGE" "$NODE_IMAGE_REF"
  compose_bound up -d --no-deps --force-recreate node-api
  wait_node
  [[ "$(service_image node-api)" == "$EXPECTED_NODE_IMAGE" ]] || return 12
  assert_node_source "$EXPECTED_BASE_ATTESTATION_SHA256" "$EXPECTED_BASE_ATTESTATION_TEST_SHA256"
}

cleanup() {
  local rc=$?
  trap - EXIT
  if ((rc != 0)) && [[ "$failure_journal_recorded" != "true" ]] && \
     [[ "$journal_phase" =~ ^(node_applied|source_bound)$ ]]; then
    set +e
    persist_journal failed "$rc" false || \
      echo "WARNING: post-commit 413 recovery failure could not advance its journal." >&2
    set -e
  fi
  if [[ -n "$runtime_dir" && -d "$runtime_dir" ]]; then
    chmod -R u+w "$runtime_dir" 2>/dev/null || true
    rm -rf -- "$runtime_dir"
  fi
  exit "$rc"
}
trap cleanup EXIT

if [[ ! "$EXPECTED_TARGET_SOURCE_REVISION" =~ ^[0-9a-f]{40}$ || \
      ! "$EXPECTED_TARGET_GIT_INVENTORY_SHA256" =~ ^[0-9a-f]{64}$ || \
      "$EXPECTED_TARGET_SOURCE_REVISION" == "$EXPECTED_BASE_SOURCE_REVISION" ]]; then
  fail "Artifact-order recovery requires an explicit distinct target commit and inventory." 2
  exit $?
fi
if [[ ! -d "$STAGING_DIR" || -L "$STAGING_DIR" || ! -L "$APP_DIR" ]]; then
  fail "Artifact-order recovery requires a real staging directory and versioned APP_DIR symlink." 2
  exit $?
fi
staging_real="$(realpath "$STAGING_DIR")"
app_real="$(readlink -f "$APP_DIR")"
if [[ "$app_real" != "$EXPECTED_BOUND_APP_REAL" || ! -d "$app_real" || -L "$app_real" || "$staging_real" == "$app_real" ]]; then
  fail "Artifact-order recovery is not attached to the exact sealed production release." 14
  exit $?
fi
if [[ ! -d "$AIRFOILS_PRO_STATE_DIR" || -L "$AIRFOILS_PRO_STATE_DIR" || ! -d /dev/shm || -L /dev/shm ]]; then
  fail "Artifact-order recovery requires safe state and in-memory runtime directories." 2
  exit $?
fi

exec 8>"$CANONICAL_LOCK_FILE"
flock -n 8 || { echo "Another deploy or engine maintenance action is running." >&2; exit 9; }

manifest_tool="$app_real/scripts/deploy/deployment-source-manifest.py"
state_tool="$app_real/scripts/deploy/opencfd2606_cutover_state.py"
preflight_tool="$app_real/scripts/deploy/deployment-env-preflight.py"
base_inventory="$staging_real/$BASE_INVENTORY_RELATIVE"
target_inventory="$staging_real/$TARGET_INVENTORY_RELATIVE"
for required in "$manifest_tool" "$state_tool" "$preflight_tool" \
  "$app_real/.deployment-source.json" "$staging_real/.deployment-source.json" \
  "$base_inventory" "$target_inventory"; do
  [[ -f "$required" && ! -L "$required" ]] || {
    fail "Artifact-order recovery lacks required safe source evidence: $required" 2
    exit $?
  }
done
require_regular_owned_mode "$ENV_FILE" 600 "Deployment environment"
require_regular_owned_mode "$base_inventory" 600 "Authenticated base inventory"
require_regular_owned_mode "$target_inventory" 600 "Authenticated target inventory"
assert_failed_journal
python3 "$preflight_tool" --app-dir "$APP_DIR" --state-dir "$AIRFOILS_PRO_STATE_DIR" --env-file "$ENV_FILE" >/dev/null

IFS=$'\t' read -r bound_revision bound_tree bound_count < <(
  python3 "$manifest_tool" --verify --root "$app_real" --manifest "$app_real/.deployment-source.json"
)
IFS=$'\t' read -r target_revision target_tree target_count < <(
  python3 "$manifest_tool" --verify --root "$staging_real" --manifest "$staging_real/.deployment-source.json"
)
[[ "$bound_revision" == "$EXPECTED_BOUND_SOURCE_REVISION" && \
   "$bound_tree" == "$EXPECTED_BOUND_SOURCE_TREE_SHA256" && \
   "$bound_count" == "$EXPECTED_BOUND_SOURCE_FILE_COUNT" ]] || {
  fail "Bound release source identity changed." 14; exit $?
}
[[ "$target_revision" == "$EXPECTED_TARGET_SOURCE_REVISION" ]] || {
  fail "Target manifest revision differs from the dispatched commit." 14; exit $?
}
[[ "$(sha256_file "$base_inventory")" == "$EXPECTED_BASE_GIT_INVENTORY_SHA256" && \
   "$(sha256_file "$target_inventory")" == "$EXPECTED_TARGET_GIT_INVENTORY_SHA256" ]] || {
  fail "Authenticated source inventory hash mismatch." 14; exit $?
}

python3 - "$manifest_tool" "$base_inventory" "$target_inventory" "$staging_real" <<'PY'
import hashlib,importlib.util,os,re,stat,sys
from pathlib import Path
tool,base_path,target_path,target_root=map(Path,sys.argv[1:])
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location("sealed_manifest",tool)
if spec is None or spec.loader is None: raise SystemExit("cannot load bound source model")
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
line_re=re.compile(r"^(100644|100755|120000) blob ([0-9a-f]{40})\t(.+)$")
def inventory(path,label):
    result={}
    for raw in path.read_text(encoding="utf-8").splitlines():
        m=line_re.fullmatch(raw)
        if m is None: raise SystemExit(f"{label} inventory entry is invalid")
        mode,blob,name=m.groups(); rel=Path(name)
        if rel.is_absolute() or ".." in rel.parts or name in result:
            raise SystemExit(f"{label} inventory path is unsafe")
        if not module._excluded(rel): result[name]=(mode,blob)
    return result
base=inventory(base_path,"base"); target=inventory(target_path,"target")
staged={}
for path in module._source_entries(target_root):
    rel=path.relative_to(target_root).as_posix(); meta=path.lstat()
    if stat.S_ISREG(meta.st_mode):
        payload=path.read_bytes(); mode="100755" if meta.st_mode&0o111 else "100644"
    elif stat.S_ISLNK(meta.st_mode): payload=os.readlink(path).encode(); mode="120000"
    else: raise SystemExit(f"unsupported staged entry: {rel}")
    staged[rel]=(mode,hashlib.sha1(b"blob "+str(len(payload)).encode()+b"\0"+payload).hexdigest())
if staged!=target: raise SystemExit("staged payload differs from authenticated target inventory")
changed={p for p in set(base)|set(target) if base.get(p)!=target.get(p)}
scaffolding={"scripts/deploy/recover-pending-opencfd2606-artifact-order-attestation.sh",
             "tests/test_pending_cutover_artifact_order_attestation_recovery.py"}
expected={"apps/api/src/openfoam-2606-attestation.ts",
          "apps/api/test/openfoam-2606-attestation.test.ts"}|scaffolding
if changed!=expected: raise SystemExit("target is not the exact reviewed artifact-order recovery delta")
if any(p in base or p not in target for p in scaffolding):
    raise SystemExit("artifact-order recovery scaffolding is not additive")
critical={"scripts/deploy/rebuild-engine.sh","scripts/deploy/openfoam_2606_canary.py",
          "src/airfoilfoam/pipeline.py","src/airfoilfoam/retention.py",
          "apps/api/src/engine-cutover-routes.ts",
          "apps/api/test/engine-cutover-routes.test.ts",
          "apps/api/src/admin-routes.ts"}
for p in critical:
    if base.get(p) is None or target.get(p)!=base[p]:
        raise SystemExit(f"critical source changed: {p}")
PY

[[ "$(sha256_file "$staging_real/apps/api/src/openfoam-2606-attestation.ts")" == "$EXPECTED_TARGET_ATTESTATION_SHA256" && \
   "$(sha256_file "$staging_real/apps/api/test/openfoam-2606-attestation.test.ts")" == "$EXPECTED_TARGET_ATTESTATION_TEST_SHA256" && \
   "$(sha256_file "$staging_real/apps/api/src/engine-cutover-routes.ts")" == "$EXPECTED_ROUTE_SHA256" && \
   "$(sha256_file "$staging_real/apps/api/test/engine-cutover-routes.test.ts")" == "$EXPECTED_ROUTE_TEST_SHA256" && \
   "$(sha256_file "$staging_real/apps/api/src/admin-routes.ts")" == "$EXPECTED_NODE_ADMIN_ROUTES_SHA256" && \
   "$(sha256_file "$staging_real/scripts/deploy/rebuild-engine.sh")" == "$EXPECTED_REBUILD_SHA256" && \
   "$(sha256_file "$staging_real/scripts/deploy/openfoam_2606_canary.py")" == "$EXPECTED_CANARY_SHA256" ]] || {
  fail "Target has changed reviewed attestation or immutable certification bytes." 14; exit $?
}

runtime_dir="$(mktemp -d /dev/shm/airfoils-artifact-order.XXXXXX)"
chmod 700 "$runtime_dir"
snapshot="$runtime_dir/source"
install -d -m 700 "$snapshot"
cp -a "$staging_real/." "$snapshot/"
rm -rf -- "$snapshot/.codex-artifacts"
fields="$(python3 "$snapshot/scripts/deploy/deployment-source-manifest.py" \
  --verify --root "$snapshot" --manifest "$snapshot/.deployment-source.json")"
[[ "$fields" == "$target_revision"$'\t'"$target_tree"$'\t'"$target_count" ]] || {
  fail "Private target snapshot differs from the staged source." 14; exit $?
}
target_app_source="$(PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$snapshot/src" python3 - "$snapshot" <<'PY'
from pathlib import Path
import sys
from airfoilfoam.provenance import application_source_sha256
print(application_source_sha256(Path(sys.argv[1])))
PY
)"
[[ "$target_app_source" == "$EXPECTED_ENGINE_APPLICATION_SOURCE_SHA256" ]] || {
  fail "Node-only target unexpectedly changes engine application source." 14; exit $?
}
find "$snapshot" -type d -exec chmod a-w {} +
find "$snapshot" -type f -exec chmod a-w {} +

computed_source_bound_env_sha="$(TARGET_REVISION="$target_revision" TARGET_TREE="$target_tree" python3 - "$ENV_FILE" <<'PY'
import hashlib,os,sys
path=sys.argv[1]; updates={"OPENCFD2606_CUTOVER_SOURCE_REVISION":os.environ["TARGET_REVISION"],
                          "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256":os.environ["TARGET_TREE"]}
seen={k:0 for k in updates}; out=[]
for line in open(path,encoding="utf-8").read().splitlines():
    key=line.split("=",1)[0]
    if key in updates: seen[key]+=1; line=f"{key}={updates[key]}"
    out.append(line)
if any(v!=1 for v in seen.values()): raise SystemExit("source tuple missing or duplicated")
print(hashlib.sha256(("\n".join(out)+"\n").encode()).hexdigest())
PY
)"
source_bound_env_sha="$computed_source_bound_env_sha"

journal_phase=""
if [[ -e "$RECOVERY_JOURNAL_FILE" || -L "$RECOVERY_JOURNAL_FILE" ]]; then
  load_journal
fi

assert_engine_containers
assert_engine_health
assert_scheduler_stopped_and_idle

current_env_sha="$(sha256_file "$ENV_FILE")"
current_state="$(cutover_state_kind)"
current_receipt="$(receipt_sha)"
if [[ "$current_state" == "pending-receipt" && \
      "$current_env_sha" =~ ^($EXPECTED_ENV_BEFORE_SHA256|$source_bound_env_sha)$ && \
      "$computed_source_bound_env_sha" != "$source_bound_env_sha" ]]; then
  fail "Recovery journal source-bound environment differs from the exact pending receipt state." 14
  exit $?
fi
if [[ -z "$journal_phase" ]]; then
  [[ "$current_env_sha" == "$EXPECTED_ENV_BEFORE_SHA256" && \
     "$current_state" == "pending-receipt" && \
     "$current_receipt" == "$EXPECTED_RECEIPT_SHA256" && \
     "$(database_snapshot_sha)" == "$EXPECTED_DATABASE_BEFORE_SHA256" ]] || {
    fail "Initial live state differs from the exact failed attestation incident." 14; exit $?
  }
  assert_initial_database
  assert_all_pools_disabled_and_campaign_paused
  assert_initial_receipt
  [[ "$(read_env_var AIRFOILFOAM_BUILD_ID)" == "$EXPECTED_BUILD_ID" && \
     "$(read_env_var ENGINE_EXPECTED_BUILD_ID)" == "$EXPECTED_BUILD_ID" && \
     "$(read_env_var OPENCFD2606_CUTOVER_SOURCE_REVISION)" == "$EXPECTED_BASE_SOURCE_REVISION" && \
     "$(read_env_var OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256)" == "$EXPECTED_BASE_SOURCE_TREE_SHA256" ]] || {
    fail "Build/source marker tuple differs from the exact failed run." 14; exit $?
  }
  node_before="$(running_container node-api)"
  [[ "$node_before" == "$EXPECTED_NODE_CONTAINER" && "$(service_image node-api)" == "$EXPECTED_NODE_IMAGE" && \
     "$(tag_image "$NODE_IMAGE_REF")" == "$EXPECTED_NODE_IMAGE" ]] || {
    fail "Initial Node container/image differs from the exact failed run." 14; exit $?
  }
  assert_node_source "$EXPECTED_BASE_ATTESTATION_SHA256" "$EXPECTED_BASE_ATTESTATION_TEST_SHA256"
  persist_journal prepared "" false
  journal_phase="prepared"
fi

if ! current_node_hashes="$(node_source_hashes)"; then
  if [[ "$journal_phase" == "prepared" || "$journal_phase" == "failed" ]]; then
    rollback_node || {
      fail "Node was unavailable in the pre-commit crash window and rollback failed." 12
      exit $?
    }
    current_node_hashes="$(node_source_hashes)"
  else
    fail "Node is unavailable after the repair was durably committed." 12
    exit $?
  fi
fi
if [[ "$current_node_hashes" == "$EXPECTED_TARGET_ATTESTATION_SHA256"$'\n'"$EXPECTED_TARGET_ATTESTATION_TEST_SHA256" ]]; then
  node_image_after="$(service_image node-api)"
  node_container_after="$(running_container node-api)"
  assert_node_source "$EXPECTED_TARGET_ATTESTATION_SHA256" "$EXPECTED_TARGET_ATTESTATION_TEST_SHA256"
  if [[ "$journal_phase" == "prepared" || "$journal_phase" == "failed" ]]; then
    persist_journal node_applied "" false
    journal_phase="node_applied"
  fi
elif [[ "$current_node_hashes" == "$EXPECTED_BASE_ATTESTATION_SHA256"$'\n'"$EXPECTED_BASE_ATTESTATION_TEST_SHA256" ]]; then
  [[ "$journal_phase" == "prepared" || "$journal_phase" == "failed" ]] || {
    fail "Recovery journal advanced but the live Node repair is absent." 14; exit $?
  }
  [[ "$(sha256_file "$ENV_FILE")" == "$EXPECTED_ENV_BEFORE_SHA256" && \
     "$(receipt_sha)" == "$EXPECTED_RECEIPT_SHA256" && \
     "$(database_snapshot_sha)" == "$EXPECTED_DATABASE_BEFORE_SHA256" ]] || {
    fail "State changed before the Node-only repair could be applied." 14; exit $?
  }
  docker tag "$EXPECTED_NODE_IMAGE" "$NODE_ROLLBACK_TAG"
  docker build --pull=false -f "$snapshot/docker/Dockerfile.node" -t "$NODE_REPAIR_TAG" "$snapshot"
  node_image_after="$(tag_image "$NODE_REPAIR_TAG")"
  [[ "$node_image_after" =~ ^sha256:[0-9a-f]{64}$ && "$node_image_after" != "$EXPECTED_NODE_IMAGE" ]] || {
    fail "Node repair build did not produce a distinct content-addressed image." 12; exit $?
  }
  docker tag "$NODE_REPAIR_TAG" "$NODE_IMAGE_REF"
  if ! compose_target up -d --no-deps --force-recreate node-api || ! wait_node; then
    rollback_node || true
    persist_journal failed 12 false
    exit 12
  fi
  node_container_after="$(running_container node-api)"
  if ! assert_node_source "$EXPECTED_TARGET_ATTESTATION_SHA256" "$EXPECTED_TARGET_ATTESTATION_TEST_SHA256" || \
     ! assert_engine_containers || ! assert_engine_health || \
     [[ "$(sha256_file "$ENV_FILE")" != "$EXPECTED_ENV_BEFORE_SHA256" ]] || \
     [[ "$(receipt_sha)" != "$EXPECTED_RECEIPT_SHA256" ]] || \
     [[ "$(database_snapshot_sha)" != "$EXPECTED_DATABASE_BEFORE_SHA256" ]]; then
    rollback_node || true
    persist_journal failed 12 false
    exit 12
  fi
  persist_journal node_applied "" false
  journal_phase="node_applied"
else
  fail "Live Node source is neither the exact old nor reviewed repaired build." 14
  exit $?
fi

assert_engine_containers
assert_engine_health
assert_scheduler_stopped_and_idle
assert_node_source "$EXPECTED_TARGET_ATTESTATION_SHA256" "$EXPECTED_TARGET_ATTESTATION_TEST_SHA256"

current_state="$(cutover_state_kind)"
if [[ "$current_state" == "pending-receipt" ]]; then
  assert_initial_receipt
  [[ "$(database_snapshot_sha)" == "$EXPECTED_DATABASE_BEFORE_SHA256" ]] || {
    fail "Database changed before exact receipt certification." 14; exit $?
  }
  if [[ "$(sha256_file "$ENV_FILE")" == "$EXPECTED_ENV_BEFORE_SHA256" ]]; then
    atomic_bind_target_source
  fi
  [[ "$(sha256_file "$ENV_FILE")" == "$source_bound_env_sha" ]] || {
    fail "Atomic target source binding did not reach its precomputed hash." 14; exit $?
  }
  persist_journal source_bound "" false
  journal_phase="source_bound"
elif [[ "$current_state" =~ ^pending-attested ]]; then
  [[ "$(sha256_file "$ENV_FILE")" != "$EXPECTED_ENV_BEFORE_SHA256" ]] || {
    fail "Attested state retained the pre-repair source tuple." 14; exit $?
  }
  assert_progressed_database "$current_state"
  assert_all_pools_disabled_and_campaign_paused
  assert_successor_awaiting_scheduler
  [[ "$(receipt_sha)" == "absent" ]] || {
    fail "Attested successor-awaiting state retained a redundant receipt." 14; exit $?
  }
  if [[ "$journal_phase" != "attested_awaiting_continuation" ]]; then
    persist_journal attested_awaiting_continuation 14 false
  fi
  echo "Attestation recovery is already durably awaiting the intentionally stopped scheduler; no replay was performed."
  exit 0
elif [[ "$current_state" == "terminal" ]]; then
  echo "This incident-specific recovery does not authorize terminal promotion." >&2
  exit 14
else
  fail "Unsupported cutover state for exact attestation recovery: $current_state" 14
  exit $?
fi

cookie_file="$runtime_dir/admin-cookie"
: >"$cookie_file"; chmod 600 "$cookie_file"
node_live="$(running_container node-api)"
docker exec -e "MAINTENANCE_COOKIE_TTL_MS=$MAINTENANCE_COOKIE_TTL_MS" -w /app "$node_live" \
  pnpm exec tsx -e \
  'import { signSession } from "./apps/api/src/admin-auth.ts"; process.stdout.write("aero_admin=" + signSession("cutover-artifact-order@airfoils.pro", Number(process.env.MAINTENANCE_COOKIE_TTL_MS), "password"));' \
  >"$cookie_file"
python3 - "$cookie_file" <<'PY'
from pathlib import Path
import re,sys
if re.fullmatch(r"aero_admin=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",Path(sys.argv[1]).read_text()) is None:
    raise SystemExit("live Node did not issue a valid maintenance cookie")
PY
{ printf 'header = "Cookie: '; cat "$cookie_file"; printf '"\n'; } | \
  curl --config - --fail-with-body -sS --max-time 15 \
  http://127.0.0.1:4000/api/admin/me | python3 -c '
import json,sys
p=json.load(sys.stdin)
if p.get("authed") is not True or p.get("email")!="cutover-artifact-order@airfoils.pro":
    raise SystemExit("ephemeral maintenance cookie was not accepted")
'

# Prove the repaired live parser boundary before consuming the only retained
# production receipt.  This exact-size body is deliberately invalid, so 422
# proves it reached authoritative schema validation; 413 would reproduce the
# incident and any other response is fail-closed.
parser_probe_body="$runtime_dir/attestation-parser-probe.json"
parser_probe_response="$runtime_dir/attestation-parser-probe-response.json"
python3 - "$parser_probe_body" "$EXPECTED_RECEIPT_BYTE_SIZE" <<'PY'
from pathlib import Path
import sys
path=Path(sys.argv[1]); target=int(sys.argv[2])
prefix=b'{"receipt":{"padding":"'; suffix=b'"}}'
payload=prefix+b"x"*(target-len(prefix)-len(suffix))+suffix
if len(payload)!=target: raise SystemExit("parser probe size mismatch")
with path.open("wb") as stream:
    stream.write(payload); stream.flush()
PY
parser_probe_status="$(
  { printf 'header = "Cookie: '; cat "$cookie_file"; printf '"\n'; } | \
    curl --config - -sS --max-time 30 \
      -H 'Origin: https://airfoils.pro' \
      -H 'Sec-Fetch-Site: same-origin' \
      -H 'Content-Type: application/json' \
      --data-binary "@$parser_probe_body" \
      --output "$parser_probe_response" \
      --write-out '%{http_code}' \
      http://127.0.0.1:4000/api/admin/solver-engine-cutovers/opencfd-2606/attest
)"
[[ "$parser_probe_status" == "422" ]] || {
  fail "Live attestation parser probe returned HTTP $parser_probe_status instead of authoritative validation 422." 14
  exit $?
}
python3 - "$parser_probe_response" <<'PY'
import json,sys
p=json.load(open(sys.argv[1],encoding="utf-8"))
if p.get("code")!="validation" or p.get("error")!="invalid OpenCFD v2606 cutover request":
    raise SystemExit("parser probe did not reach the authoritative receipt schema")
PY

private_lock="$runtime_dir/rebuild-engine.lock"
: >"$private_lock"; chmod 600 "$private_lock"
set +e
ADMIN_COOKIE="$(<"$cookie_file")" \
APP_DIR="$snapshot" AIRFOILS_PRO_STATE_DIR="$AIRFOILS_PRO_STATE_DIR" ENV_FILE="$ENV_FILE" \
COMPOSE_FILE="$snapshot/docker-compose.deploy.yml" COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
LOCK_FILE="$private_lock" DEPLOYMENT_MANIFEST_FILE="$snapshot/.deployment-source.json" \
DEPLOY_SOURCE_REVISION="$target_revision" DEPLOY_SOURCE_TREE_SHA256="$target_tree" \
OPENCFD2606_CANARY_RECEIPT_FILE="$OPENCFD2606_CANARY_RECEIPT_FILE" \
"$snapshot/scripts/deploy/rebuild-engine.sh" --certify-opencfd-2606-continuation
child_rc=$?
set -e

[[ -L "$APP_DIR" && "$(readlink -f "$APP_DIR")" == "$EXPECTED_BOUND_APP_REAL" ]] || {
  fail "APP_DIR moved during attestation recovery." 14; exit $?
}
assert_engine_containers
assert_engine_health
assert_scheduler_stopped_and_idle
assert_node_source "$EXPECTED_TARGET_ATTESTATION_SHA256" "$EXPECTED_TARGET_ATTESTATION_TEST_SHA256"

post_state="$(cutover_state_kind)"
case "$child_rc:$post_state" in
  14:pending-attested|14:pending-attested-retained-receipt)
    assert_progressed_database "$post_state"
    assert_all_pools_disabled_and_campaign_paused
    assert_successor_awaiting_scheduler
    [[ "$(receipt_sha)" == "absent" ]] || {
      fail "Expected nonterminal attestation retained a redundant receipt." 14; exit $?
    }
    persist_journal attested_awaiting_continuation 14 false
    echo "Retained canary receipt is durably attested. The intentionally stopped scheduler still requires one separately observed successor generation; source promotion is NOT eligible."
    ;;
  *)
    persist_journal failed "$child_rc" false
    failure_journal_recorded=true
    fail "Certification returned rc=$child_rc with unexpected cutover state $post_state; recovery remains fail-safe." 14
    exit $?
    ;;
esac
