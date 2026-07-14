#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.deploy}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.deploy.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-app}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://airfoils.pro}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"

cd "$APP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing deployment env file: $ENV_FILE" >&2
  exit 2
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi

compose() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
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

openfoam_processes() {
  compose exec -T worker sh -lc 'pgrep -af "[s]impleFoam|[p]impleFoam|[s]nappyHexMesh|[b]lockMesh|[d]ecomposePar|[r]econstructPar|[f]oamRun|[f]oamJob" || true' 2>/dev/null || true
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

main() {
  exec 9>"$LOCK_FILE"
  flock -n 9 || {
    echo "Another Airfoils.Pro deploy is already running." >&2
    exit 9
  }

  echo "Airfoils.Pro deploy starting in $APP_DIR"
  echo "Compose project: $COMPOSE_PROJECT_NAME"

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
    echo "OpenFOAM solver processes are active in the worker container:"
    echo "$before_openfoam"
    echo "Default deploy will not restart api/worker, so these processes are left alone."
  else
    echo "No active OpenFOAM solver processes detected in the worker container."
  fi

  compose config >/tmp/airfoils-pro-compose-config.yml

  echo "Building control-plane images..."
  compose build node-api web sweeper media-repair

  # The node-api runs database migrations during startup.  Stop the old
  # scheduler and media-repair writers before that cutover so an older writer
  # cannot ingest evidence into a newly migrated schema between the migration
  # commit and restoring control-plane services. This stops only Node control
  # plane scheduling/derived media work; api, worker, and live OpenFOAM child
  # processes remain untouched.
  echo "Quiescing old control-plane writers before database migration..."
  compose stop sweeper
  # The service is introduced after the first deployment of this change; its
  # absence on an older stack is expected, but never hide a sweeper stop error.
  compose stop media-repair || true

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

  echo "Skipping api/worker redeploy. Engine maintenance is available only through scripts/deploy/rebuild-engine.sh."

  echo "Container status:"
  compose ps

  echo "Public checks:"
  curl -fsS --max-time 10 "$PUBLIC_ORIGIN/api/admin/me" >/dev/null
  curl -fsS --max-time 10 "$PUBLIC_ORIGIN/" >/dev/null
  echo "Public web/API checks passed."

  echo "Airfoils.Pro deploy finished."
}

main "$@"
