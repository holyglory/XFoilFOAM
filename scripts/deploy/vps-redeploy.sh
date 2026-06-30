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
  compose build node-api web sweeper

  echo "Restarting node-api only..."
  compose up -d --no-deps node-api
  wait_http "node-api" "http://127.0.0.1:4000/health" 90

  echo "Restarting web and sweeper only..."
  compose up -d --no-deps web sweeper
  wait_http "web" "http://127.0.0.1:3100/health" 90

  if [[ "${DEPLOY_OPENFOAM_SERVICES:-0}" == "1" ]]; then
    local active
    active="$(openfoam_processes)"
    if [[ -n "$active" ]]; then
      echo "Refusing to redeploy api/worker because OpenFOAM processes are active:" >&2
      echo "$active" >&2
      exit 12
    fi
    echo "DEPLOY_OPENFOAM_SERVICES=1 and worker is idle; rebuilding api/worker..."
    compose build api worker
    compose up -d --no-deps api worker
    wait_http "engine API" "http://127.0.0.1:8000/health" 60
  else
    echo "Skipping api/worker redeploy. Set DEPLOY_OPENFOAM_SERVICES=1 only for an idle solver window."
  fi

  echo "Container status:"
  compose ps

  echo "Public checks:"
  curl -fsS --max-time 10 "$PUBLIC_ORIGIN/api/admin/me" >/dev/null
  curl -fsS --max-time 10 "$PUBLIC_ORIGIN/" >/dev/null
  echo "Public web/API checks passed."

  echo "Airfoils.Pro deploy finished."
}

main "$@"
