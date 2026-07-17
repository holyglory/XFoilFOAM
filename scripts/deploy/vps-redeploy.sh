#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.deploy.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
COMPOSE_OVERRIDE_FILE="${COMPOSE_OVERRIDE_FILE:-}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://airfoils.pro}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"
DEPLOY_LOCK_HELD="${DEPLOY_LOCK_HELD:-0}"
DEPLOYMENT_MANIFEST_FILE="${DEPLOYMENT_MANIFEST_FILE:-$APP_DIR/.deployment-source.json}"
DEPLOY_SOURCE_REVISION="${DEPLOY_SOURCE_REVISION:-}"
DEPLOY_SOURCE_TREE_SHA256="${DEPLOY_SOURCE_TREE_SHA256:-}"
OPENCFD2606_CANARY_RECEIPT_FILE="${OPENCFD2606_CANARY_RECEIPT_FILE:-$AIRFOILS_PRO_STATE_DIR/openfoam-2606-canary-receipt.pending.json}"

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

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi

compose() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" "${COMPOSE_FILE_ARGS[@]}" "$@"
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
      echo "The inherited deployment lock is not held by this promotion transaction." >&2
      return 9
    }
    return 0
  fi
  if [[ "$DEPLOY_LOCK_HELD" != "0" ]]; then
    echo "DEPLOY_LOCK_HELD must be either 0 or the promotion-only value 1." >&2
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
  tool="$APP_DIR/scripts/deploy/deployment-source-manifest.py"
  if [[ ! -f "$tool" || ! -f "$DEPLOYMENT_MANIFEST_FILE" ]]; then
    echo "Deployment source manifest or verifier is missing; refusing to trust stale repository metadata." >&2
    return 2
  fi
  fields="$(python3 "$tool" --verify --root "$APP_DIR" --manifest "$DEPLOYMENT_MANIFEST_FILE")" || return 2
  IFS=$'\t' read -r revision tree_sha file_count <<<"$fields"
  if [[ -n "$DEPLOY_SOURCE_REVISION" && "$revision" != "$DEPLOY_SOURCE_REVISION" ]]; then
    echo "Promoted source revision changed before deploy: expected $DEPLOY_SOURCE_REVISION, found $revision" >&2
    return 2
  fi
  if [[ -n "$DEPLOY_SOURCE_TREE_SHA256" && "$tree_sha" != "$DEPLOY_SOURCE_TREE_SHA256" ]]; then
    echo "Promoted source hash changed before deploy: expected $DEPLOY_SOURCE_TREE_SHA256, found $tree_sha" >&2
    return 2
  fi
  DEPLOY_SOURCE_REVISION="$revision"
  DEPLOY_SOURCE_TREE_SHA256="$tree_sha"
  echo "Verified deployment source: revision=$revision sha256=$tree_sha files=$file_count"
}

read_deploy_env_var() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

validate_no_pending_engine_cutover() {
  if [[ "$DEPLOYMENT_ROLE" == "remote-solver" ]]; then
    python3 "$DEPLOY_SCRIPT_DIR/remote-solver2606-cutover-state.py" \
      --env-file "$ENV_FILE" \
      --receipt-file "$AIRFOILS_PRO_STATE_DIR/remote-solver-2606-canary-receipt.json" \
      --attestation-file "$AIRFOILS_PRO_STATE_DIR/remote-solver-2606-attestation.json" \
      --current-source-revision "$DEPLOY_SOURCE_REVISION" \
      --current-source-tree-sha256 "$DEPLOY_SOURCE_TREE_SHA256" \
      --require-state non-pending \
      >/dev/null
    return
  fi
  python3 "$DEPLOY_SCRIPT_DIR/opencfd2606_cutover_state.py" \
    --env-file "$ENV_FILE" \
    --receipt-file "$OPENCFD2606_CANARY_RECEIPT_FILE" \
    --current-source-revision "$DEPLOY_SOURCE_REVISION" \
    --current-source-tree-sha256 "$DEPLOY_SOURCE_TREE_SHA256" \
    --require-state non-pending \
    >/dev/null
}

validate_certified_evidence_contract() {
  if [[ "$DEPLOYMENT_ROLE" == "remote-solver" ]]; then
    echo "Remote-solver role uses its separate volume-retention attestation; canonical hub GCS certification is not consulted."
    return 0
  fi
  local marker complete attestation current marker_required=false
  marker="$(read_deploy_env_var OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256 || true)"
  complete="$(read_deploy_env_var OPENCFD2606_CUTOVER_COMPLETE || true)"
  attestation="$(read_deploy_env_var OPENCFD2606_CANARY_ATTESTATION_ID || true)"
  if [[ "$complete" == "1" || -n "$attestation" ]]; then
    marker_required=true
  fi
  if [[ -z "$marker" ]]; then
    if [[ "$marker_required" == "true" ]]; then
      echo "The certified OpenCFD v2606 evidence-contract marker is missing; refusing the control-plane deploy." >&2
      return 14
    fi
    echo "No certified OpenCFD v2606 evidence contract exists yet (initial pre-cutover state)."
    return 0
  fi
  if [[ ! "$marker" =~ ^[0-9a-f]{64}$ ]]; then
    echo "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256 is malformed; refusing the control-plane deploy." >&2
    return 14
  fi
  if ! current="$(python3 "$DEPLOY_SCRIPT_DIR/evidence-contract.py" --env-file "$ENV_FILE" 2>&1)"; then
    echo "Could not derive the current evidence-storage contract:" >&2
    echo "$current" >&2
    return 14
  fi
  if [[ "$current" != "$marker" ]]; then
    echo "The current bucket/prefix/Zstandard/remote-only evidence contract differs from the OpenCFD v2606 certified contract; refusing the control-plane deploy." >&2
    echo "certified=$marker current=$current" >&2
    return 14
  fi
  echo "Certified OpenCFD v2606 evidence contract matches: $marker"
}

capture_sweeper_state() {
  local running_ids
  if ! running_ids="$(compose ps --status running -q sweeper)"; then
    echo "Could not determine whether the sweeper is running; refusing deploy." >&2
    return 12
  fi
  if [[ -n "$running_ids" ]]; then
    printf 'running\n'
  else
    printf 'stopped\n'
  fi
}

restore_sweeper_state() {
  local initial_state="$1"
  if [[ "$initial_state" == "running" ]]; then
    echo "Restoring the previously running sweeper..."
    compose up -d --no-deps sweeper
  else
    echo "Preserving the intentionally stopped sweeper..."
    # Recreate the stopped container so its image/config are current without
    # opening even a brief scheduling or reconciliation window.
    compose up --no-start --no-deps --force-recreate sweeper
  fi
}

known_engine_worker_services() {
  compose --profile '*' config --services | awk '$0 == "worker" || $0 ~ /^worker-/'
}

openfoam_processes() {
  local services service running output
  services="$(known_engine_worker_services 2>/dev/null || true)"
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    running="$(compose --profile '*' ps --status running -q "$service" 2>/dev/null || true)"
    [[ -n "$running" ]] || continue
    output="$(compose --profile '*' exec -T "$service" sh -lc 'pgrep -af "[s]impleFoam|[p]impleFoam|[p]otentialFoam|[s]nappyHexMesh|[s]urfaceFeatureExtract|[b]lockMesh|[c]heckMesh|[d]ecomposePar|[r]econstructPar|[r]enumberMesh|[m]apFields|[p]ostProcess|[f]oamToVTK|[f]oamRun|[f]oamJob" || true' 2>/dev/null || true)"
    if [[ -n "$output" ]]; then
      while IFS= read -r line; do
        printf '%s: %s\n' "$service" "$line"
      done <<<"$output"
    fi
  done <<<"$services"
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

wait_for_stable_background_service() {
  local service="$1"
  local label="$2"
  local attempts="${3:-15}"
  local required_stable_checks="${4:-3}"
  local i running_ids previous_ids="" stable_checks=0
  for ((i = 1; i <= attempts; i++)); do
    if ! running_ids="$(compose ps --status running -q "$service")"; then
      echo "Could not inspect $label while verifying the deployed background services." >&2
      return 1
    fi
    if [[ -n "$running_ids" && "$running_ids" == "$previous_ids" ]]; then
      stable_checks=$((stable_checks + 1))
    elif [[ -n "$running_ids" ]]; then
      previous_ids="$running_ids"
      stable_checks=1
    else
      previous_ids=""
      stable_checks=0
    fi
    if ((stable_checks >= required_stable_checks)); then
      echo "$label remained running after deployment."
      return 0
    fi
    sleep 2
  done
  echo "$label did not remain running after deployment; refusing to report success." >&2
  compose ps "$service" >&2 || true
  return 1
}

main() {
  acquire_deploy_lock || exit $?
  verify_deployment_source || exit $?
  validate_no_pending_engine_cutover || exit $?
  # This precedes scheduler inspection, image builds, migrations, and service
  # restarts. The initial pre-2606 deploy may be markerless; a completed or
  # attested cutover may never drift from the certified storage destination.
  validate_certified_evidence_contract || exit $?

  echo "Airfoils.Pro deploy starting in $APP_DIR"
  echo "Deployment role: $DEPLOYMENT_ROLE"
  echo "Compose project: $COMPOSE_PROJECT_NAME"
  if [[ -n "$COMPOSE_OVERRIDE_FILE" ]]; then
    echo "Compose override: $COMPOSE_OVERRIDE_FILE"
  fi

  local sweeper_initial_state
  sweeper_initial_state="$(capture_sweeper_state)"
  echo "Sweeper state before deploy: $sweeper_initial_state"

  if [[ "${DEPLOY_OPENFOAM_SERVICES:-0}" == "1" ]]; then
    echo "Refusing DEPLOY_OPENFOAM_SERVICES=1 in the control-plane deploy." >&2
    echo "Use scripts/deploy/rebuild-engine.sh <build-id>; it owns the queue/process idle guards and coordinated build-id cutover." >&2
    exit 12
  fi

  local before_openfoam
  before_openfoam="$(openfoam_processes)"
  if [[ -n "$before_openfoam" ]]; then
    echo "OpenFOAM solver processes are active in an engine worker container:"
    echo "$before_openfoam"
    echo "Default deploy will not restart the engine gateway or workers, so these processes are left alone."
  else
    echo "No active OpenFOAM solver processes detected in configured engine workers."
  fi

  # Compose interpolation validates the deployment config. Never persist this
  # expanded output: it contains database and session secrets from ENV_FILE.
  compose config >/dev/null

  echo "Building control-plane images..."
  compose build node-api web sweeper media-repair

  # The node-api runs database migrations during startup.  Stop the old
  # scheduler and media-repair writers before that cutover so an older writer
  # cannot ingest evidence into a newly migrated schema between the migration
  # commit and restoring control-plane services. This stops only Node control
  # plane scheduling/derived media work; the engine gateway, all engine workers,
  # and live OpenFOAM child processes remain untouched.
  echo "Quiescing old control-plane writers before database migration..."
  compose stop sweeper
  # A missing service name is possible only while first introducing this
  # worker. Distinguish that harmless absence from a real stop failure: an old
  # media writer must never remain live across the node-api schema migration.
  if compose config --services | grep -Fxq media-repair; then
    compose stop media-repair
  else
    echo "media-repair is not configured in this deployment source; no writer to stop."
  fi

  # `node-api` mounts `results` read-only and `sync_imports` at a nested
  # path. Fresh result volumes therefore need the nested mountpoint created
  # before Docker can attach the writable volume there.
  echo "Initializing the nested sync-imports mountpoint..."
  compose up --no-deps storage-init

  echo "Restarting node-api only..."
  compose up -d --no-deps node-api
  wait_http "node-api" "http://127.0.0.1:4000/health" 90

  echo "Restarting web..."
  compose up -d --no-deps web
  restore_sweeper_state "$sweeper_initial_state"
  echo "Starting durable media repair worker..."
  compose up -d --no-deps media-repair
  wait_http "web" "http://127.0.0.1:3100/health" 90
  if [[ "$sweeper_initial_state" == "running" ]]; then
    wait_for_stable_background_service sweeper "sweeper"
  fi
  wait_for_stable_background_service media-repair "media-repair"

  echo "Skipping engine gateway/worker redeploy. Engine maintenance is available only through scripts/deploy/rebuild-engine.sh."

  echo "Container status:"
  compose ps

  if [[ "$DEPLOYMENT_ROLE" == "hub" ]]; then
    echo "Public checks:"
    curl -fsS --max-time 10 "$PUBLIC_ORIGIN/api/admin/me" >/dev/null
    curl -fsS --max-time 10 "$PUBLIC_ORIGIN/" >/dev/null
    echo "Public web/API checks passed."
  else
    echo "Remote-solver local control-plane checks passed; no hub URL was mutated or used as a deployment health proxy."
  fi

  echo "Airfoils.Pro deploy finished."
}

main "$@"
