#!/usr/bin/env bash
# Safe engine (api/worker) rebuild for airfoils.pro.
#
# Why this script exists (incident 2026-07-05): a manual
# `docker compose up -d --force-recreate api worker` after editing only
# AIRFOILFOAM_BUILD_ID left node-api running with a STALE env-baked
# ENGINE_EXPECTED_BUILD_ID (truthful-but-misleading "Engine build mismatch"
# banner for ~2.5 h), and killed 4 in-flight celery tasks whose persisted
# engine status kept answering state=running (zombie jobs the sweeper polled
# for ~2.3 h). Manual engine rebuilds MUST go through this script: it updates
# BOTH build-id vars in .env.deploy first, then force-recreates every service
# that reads them, verifies the engine actually serves the new build, and
# kicks the stale-job recovery.
#
# Usage:
#   scripts/deploy/rebuild-engine.sh <BUILD_ID>
#
# Optional environment:
#   APP_DIR (default /opt/airfoils-pro/app), ENV_FILE, COMPOSE_FILE,
#   COMPOSE_PROJECT_NAME (default app), ADMIN_COOKIE — a full Cookie header
#   value ("aero_admin=<token>") for POST /api/admin/jobs/recover-stale.
set -Eeuo pipefail

BUILD_ID="${1:-}"
if [[ -z "$BUILD_ID" ]]; then
  echo "Usage: $0 <BUILD_ID>" >&2
  exit 2
fi

APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.deploy}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.deploy.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-app}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"
ADMIN_COOKIE="${ADMIN_COOKIE:-}"

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

set_env_var() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
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

  echo "Engine rebuild starting: BUILD_ID=$BUILD_ID"

  # 1. Both build-id expectations move together, BEFORE any recreate — a
  #    recreate that precedes the env edit bakes the old value into the
  #    container (root cause of the 2026-07-05 stale-banner incident).
  set_env_var AIRFOILFOAM_BUILD_ID "$BUILD_ID"
  set_env_var ENGINE_EXPECTED_BUILD_ID "$BUILD_ID"
  echo "Updated AIRFOILFOAM_BUILD_ID and ENGINE_EXPECTED_BUILD_ID in $ENV_FILE"

  # 2. Rebuild the engine images.
  compose build api worker

  # 3. Force-recreate every service that reads a build-id env var
  #    (docker-compose.deploy.yml):
  #      api, worker  -> AIRFOILFOAM_BUILD_ID (build arg + env)
  #      node-api     -> ENGINE_EXPECTED_BUILD_ID (env)
  #      sweeper      -> AIRFOILFOAM_BUILD_ID (env)
  #    web reads neither var and is intentionally left alone.
  #    NOTE: this kills in-flight solves; the sweeper's lost-job reconciler
  #    (G3) plus the recover-stale call below requeue them safely.
  compose up -d --no-deps --force-recreate api worker node-api sweeper

  # 4. Verify the engine actually serves the new build.
  wait_http "engine API" "http://127.0.0.1:8000/health" 60
  local health served_build
  health="$(curl -fsS --max-time 5 http://127.0.0.1:8000/health)"
  served_build="$(printf '%s' "$health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("build_id") or "")')"
  if [[ "$served_build" != "$BUILD_ID" ]]; then
    echo "Engine /health build_id mismatch: expected $BUILD_ID, got '$served_build'" >&2
    echo "Full /health payload: $health" >&2
    exit 13
  fi
  echo "Engine serves build_id=$BUILD_ID"

  wait_http "node-api" "http://127.0.0.1:4000/health" 90

  # 5. Requeue jobs orphaned by the worker restart. Requires an admin session
  #    cookie (aero_admin=<token>) in ADMIN_COOKIE. Manual fallback: log into
  #    /admin and press "Recover stale jobs", or run
  #    curl -X POST -H 'Content-Type: application/json' \
  #      -H "Cookie: aero_admin=<token>" \
  #      -d '{"olderThanMinutes":30}' https://airfoils.pro/api/admin/jobs/recover-stale
  if [[ -n "$ADMIN_COOKIE" ]]; then
    echo "Triggering stale-job recovery..."
    curl -fsS --max-time 30 -X POST \
      -H "Content-Type: application/json" \
      -H "Cookie: $ADMIN_COOKIE" \
      -d '{"olderThanMinutes":30}' \
      "http://127.0.0.1:4000/api/admin/jobs/recover-stale" || {
      echo "recover-stale call failed — run it manually from /admin" >&2
    }
    echo
  else
    echo "ADMIN_COOKIE not set — run stale-job recovery manually from /admin (or the curl in this script's comments)."
  fi

  echo "Container status:"
  compose ps
  echo "Engine rebuild finished."
}

main "$@"
