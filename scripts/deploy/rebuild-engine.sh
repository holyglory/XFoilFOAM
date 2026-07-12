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
# kicks the stale-job recovery. It refuses the maintenance action when an
# OpenFOAM process is active, checking both before the image build and again
# immediately before service recreation.
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
if [[ ! "$BUILD_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "BUILD_ID may contain only letters, digits, dot, underscore, and hyphen." >&2
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

capture_sweeper_state() {
  local running_ids
  if ! running_ids="$(compose ps --status running -q sweeper)"; then
    echo "Could not determine whether the sweeper is running; refusing engine rebuild." >&2
    return 12
  fi
  if [[ -n "$running_ids" ]]; then
    printf 'running\n'
  else
    printf 'stopped\n'
  fi
}

restore_sweeper_after_refusal() {
  local initial_state="$1"
  if [[ "$initial_state" == "running" ]]; then
    compose up -d --no-deps sweeper || true
  else
    compose stop sweeper || true
  fi
}

restore_sweeper_after_rebuild() {
  local initial_state="$1"
  if [[ "$initial_state" == "running" ]]; then
    echo "Restoring the previously running sweeper..."
    compose up -d --no-deps --force-recreate sweeper
  else
    echo "Preserving the intentionally stopped sweeper..."
    # Bake the new build-id environment into a replacement container, but do
    # not start it. A later intentional `compose up -d sweeper` then uses the
    # same verified engine generation without a stale-id transition.
    compose up --no-start --no-deps --force-recreate sweeper
  fi
}

openfoam_processes() {
  compose exec -T worker sh -lc \
    'pgrep -af "[s]impleFoam|[p]impleFoam|[p]otentialFoam|[s]nappyHexMesh|[s]urfaceFeatureExtract|[b]lockMesh|[c]heckMesh|[d]ecomposePar|[r]econstructPar|[r]enumberMesh|[m]apFields|[p]ostProcess|[f]oamToVTK|[f]oamRun|[f]oamJob" || true'
}

engine_queue_activity() {
  local payload
  payload="$(curl -fsS --max-time 5 http://127.0.0.1:8000/queue)" || return 1
  printf '%s' "$payload" | python3 -c '
import json
import sys

queue = json.load(sys.stdin)
keys = ("active_count", "reserved_count", "scheduled_count")
counts = {key: queue.get(key) for key in keys}
depth = queue.get("queue_depth")
if any(type(value) is not int for value in counts.values()) or type(depth) is not int:
    raise SystemExit("engine queue observability is incomplete")
if depth or any(counts.values()):
    job_ids = queue.get("job_ids") or []
    print(f"queue_depth={depth} counts={counts} job_ids={job_ids}")
'
}

require_idle_worker() {
  local stage="$1"
  local active queue_activity
  if ! active="$(openfoam_processes 2>&1)"; then
    echo "Refusing engine rebuild at $stage because the worker process probe failed:" >&2
    echo "$active" >&2
    return 12
  fi
  if [[ -n "$active" ]]; then
    echo "Refusing engine rebuild at $stage because OpenFOAM processes are active:" >&2
    echo "$active" >&2
    return 12
  fi
  if ! queue_activity="$(engine_queue_activity 2>&1)"; then
    echo "Refusing engine rebuild at $stage because the engine queue probe failed:" >&2
    echo "$queue_activity" >&2
    return 12
  fi
  if [[ -n "$queue_activity" ]]; then
    echo "Refusing engine rebuild at $stage because queued/reserved/active engine work exists:" >&2
    echo "$queue_activity" >&2
    return 12
  fi
  echo "Worker idle check passed ($stage)."
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

  local sweeper_initial_state
  sweeper_initial_state="$(capture_sweeper_state)"
  echo "Sweeper state before engine rebuild: $sweeper_initial_state"

  # 1. Refuse maintenance while a solve is active. The check is repeated
  #    after the potentially long image build so a solve that started during
  #    that window cannot be terminated by the recreate below.
  require_idle_worker "before image build"

  # 2. Build with the requested id supplied as a process-level Compose
  #    override. Do not edit the persistent env file yet: if the second idle
  #    check refuses the recreate, the running control plane must continue to
  #    expect the currently served engine build.
  AIRFOILFOAM_BUILD_ID="$BUILD_ID" compose build api worker

  # Freeze scheduling before the final idle proof. Leaving the old sweeper
  # live between that proof and force-recreate would let it submit a new solve
  # which the worker recreate then kills. A refused maintenance action occurs
  # before either build-id setting changes, so it is safe to restore the old
  # sweeper's prior running/stopped state in that one path.
  compose stop sweeper
  if ! require_idle_worker "before service recreate"; then
    restore_sweeper_after_refusal "$sweeper_initial_state"
    exit 12
  fi
  # A submit HTTP request sent just before the sweeper stopped can finish in
  # the engine after the first sample. Require a stable second empty sample
  # before mutating env or recreating either engine service.
  sleep 2
  if ! require_idle_worker "stabilized before service recreate"; then
    restore_sweeper_after_refusal "$sweeper_initial_state"
    exit 12
  fi

  # 3. Both build-id expectations move together, immediately BEFORE the
  #    recreate. A recreate that precedes the env edit bakes the old value
  #    into a container (root cause of the 2026-07-05 stale-banner incident).
  set_env_var AIRFOILFOAM_BUILD_ID "$BUILD_ID"
  set_env_var ENGINE_EXPECTED_BUILD_ID "$BUILD_ID"
  echo "Updated AIRFOILFOAM_BUILD_ID and ENGINE_EXPECTED_BUILD_ID in $ENV_FILE"

  # 4. Force-recreate every service that reads a build-id env var
  #    (docker-compose.deploy.yml):
  #      api, worker  -> AIRFOILFOAM_BUILD_ID (build arg + env)
  #      node-api     -> ENGINE_EXPECTED_BUILD_ID (env)
  #      sweeper      -> AIRFOILFOAM_BUILD_ID (env)
  #    web reads neither var and is intentionally left alone.
  #    The two idle guards above make an in-flight solver termination a refused
  #    maintenance action. Recovery below is still required for stale rows
  #    left by an earlier crash or interrupted deployment.
  # node-api may apply a pending schema migration as it starts. The old
  # sweeper is already quiescent from the final idle proof above, so no
  # pre-migration writer can publish evidence during that cutover.
  compose up -d --no-deps --force-recreate api worker node-api

  # 5. Verify the engine actually serves the new build.
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
  restore_sweeper_after_rebuild "$sweeper_initial_state"

  # 6. Requeue jobs orphaned by the worker restart. Requires an admin session
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
