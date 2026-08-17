#!/usr/bin/env bash
# Recover the one post-engine legacy-gateway receipt reconciliation boundary.
#
# This script exists for the narrow state where the guarded production engine
# rebuild has already completed, but its receipt-scoped terminal settlement
# stopped before the watcher could restore the maintenance admission drain.
# It deliberately cannot build, recreate, restart, or otherwise mutate the
# engine gateway or workers.  The immutable receipt is the only job scope it
# will reconcile; all normal writers remain stopped until that evidence-bound
# reconciliation and an idle proof succeed.
#
# Usage:
#   scripts/deploy/recover-production-legacy-gateway-reconciliation.sh \
#     --expected-build-id <build-id> \
#     --expected-source-revision <40-lowercase-hex> \
#     --expected-source-tree-sha256 <64-lowercase-hex> \
#     --maintenance-token <canonical-uuid> \
#     --expected-receipt-sha256 <64-lowercase-hex> \
#     --expected-candidate-digest <64-lowercase-hex> \
#     [--repair-known-retry-rollback]
#
# This is not a replacement for rebuild-engine.sh.  If api or worker has not
# already been recreated onto the supplied build, this recovery refuses.
set -Eeuo pipefail

readonly SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
readonly RECEIPT_CONTAINER_PATH="/run/airfoils-maintenance/receipt.json"
readonly OPENFOAM_PROCESS_RE='[s]impleFoam|[p]impleFoam|[p]otentialFoam|[s]nappyHexMesh|[s]urfaceFeatureExtract|[b]lockMesh|[c]heckMesh|[d]ecomposePar|[r]econstructPar|[r]enumberMesh|[m]apFields|[p]ostProcess|[f]oamToVTK|[f]oamRun|[f]oamJob'

APP_DIR_INPUT="${APP_DIR:-/opt/airfoils-pro/app}"
ACTIVE_APP_LINK="${ACTIVE_APP_LINK:-}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-}"
COMPOSE_FILE="${COMPOSE_FILE:-}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
COMPOSE_OVERRIDE_FILE="${COMPOSE_OVERRIDE_FILE:-}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"
DEPLOYMENT_MANIFEST_FILE="${DEPLOYMENT_MANIFEST_FILE:-}"
PRODUCTION_MAINTENANCE_RECEIPT_FILE="${PRODUCTION_MAINTENANCE_RECEIPT_FILE:-$AIRFOILS_PRO_STATE_DIR/production-legacy-gateway-reconciliation.json}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

EXPECTED_BUILD_ID=""
EXPECTED_SOURCE_REVISION=""
EXPECTED_SOURCE_TREE_SHA256=""
MAINTENANCE_TOKEN=""
EXPECTED_RECEIPT_SHA256=""
EXPECTED_CANDIDATE_DIGEST=""
REPAIR_KNOWN_RETRY_ROLLBACK=false
COMPOSE_READY=false
WRITERS_STARTED=false
ADMISSION_RELEASED=false

usage() {
  sed -n '1,27p' "${BASH_SOURCE[0]}" >&2
}

die() {
  printf '%s: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 12
}

while (($#)); do
  case "$1" in
    --expected-build-id)
      EXPECTED_BUILD_ID="${2:-}"; shift 2 ;;
    --expected-source-revision)
      EXPECTED_SOURCE_REVISION="${2:-}"; shift 2 ;;
    --expected-source-tree-sha256)
      EXPECTED_SOURCE_TREE_SHA256="${2:-}"; shift 2 ;;
    --maintenance-token)
      MAINTENANCE_TOKEN="${2:-}"; shift 2 ;;
    --expected-receipt-sha256)
      EXPECTED_RECEIPT_SHA256="${2:-}"; shift 2 ;;
    --expected-candidate-digest)
      EXPECTED_CANDIDATE_DIGEST="${2:-}"; shift 2 ;;
    --repair-known-retry-rollback)
      REPAIR_KNOWN_RETRY_ROLLBACK=true; shift ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      usage; die "unknown argument: $1" ;;
  esac
done

[[ "$EXPECTED_BUILD_ID" =~ ^[A-Za-z0-9._-]+$ ]] || die "--expected-build-id is invalid"
[[ "$EXPECTED_SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || die "--expected-source-revision is invalid"
[[ "$EXPECTED_SOURCE_TREE_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "--expected-source-tree-sha256 is invalid"
[[ "$MAINTENANCE_TOKEN" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || die "--maintenance-token is invalid"
[[ "$EXPECTED_RECEIPT_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "--expected-receipt-sha256 is invalid"
[[ "$EXPECTED_CANDIDATE_DIGEST" =~ ^[0-9a-f]{64}$ ]] || die "--expected-candidate-digest is invalid"

cleanup_on_failure() {
  local status=$?
  trap - EXIT
  if ((status != 0)) && [[ "$ADMISSION_RELEASED" != "true" ]]; then
    # The durable token remains the real safety boundary. Stop either writer
    # that we may have started only after reconciliation, too: it makes a
    # post-start failure unambiguous while retaining an exact blocked state.
    if [[ "$WRITERS_STARTED" == "true" && "$COMPOSE_READY" == "true" ]]; then
      compose stop sweeper >/dev/null 2>&1 || true
      compose stop media-repair >/dev/null 2>&1 || true
    fi
    printf '%s: recovery refused; exact maintenance token remains paused and admission was not restored.\n' "$SCRIPT_NAME" >&2
  fi
  exit "$status"
}
trap cleanup_on_failure EXIT

[[ -d "$APP_DIR_INPUT" ]] || die "APP_DIR must be an existing application directory"
# `/opt/airfoils-pro/app` is normally an active-release symlink. Resolve it
# once, bind this run to that concrete release, and keep checking the active
# link before every irreversible step. A symlink swap can therefore never
# make a recovery prepared from release A operate on release B.
if [[ -z "$ACTIVE_APP_LINK" && -L "$APP_DIR_INPUT" ]]; then
  ACTIVE_APP_LINK="$APP_DIR_INPUT"
fi
APP_DIR="$(cd "$APP_DIR_INPUT" && pwd -P)"
if [[ -z "$ENV_FILE" ]]; then
  ENV_FILE="$AIRFOILS_PRO_STATE_DIR/.env.deploy"
fi
if [[ -z "$COMPOSE_FILE" ]]; then
  COMPOSE_FILE="$APP_DIR/docker-compose.deploy.yml"
fi
if [[ -z "$DEPLOYMENT_MANIFEST_FILE" ]]; then
  DEPLOYMENT_MANIFEST_FILE="$APP_DIR/.deployment-source.json"
fi
DEPLOY_SCRIPT_DIR="$APP_DIR/scripts/deploy"
[[ -d "$DEPLOY_SCRIPT_DIR" ]] || die "deployment script directory is missing"
[[ -f "$DEPLOY_SCRIPT_DIR/deployment-source-manifest.py" ]] || die "source manifest verifier is missing"
[[ -f "$DEPLOY_SCRIPT_DIR/deployment-env-preflight.py" ]] || die "deployment environment verifier is missing"
[[ -f "$DEPLOY_SCRIPT_DIR/production_maintenance_preflight.py" ]] || die "receipt preflight verifier is missing"
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || die "deployment env file is missing or unsafe"
[[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] || die "compose file is missing or unsafe"
[[ -f "$DEPLOYMENT_MANIFEST_FILE" && ! -L "$DEPLOYMENT_MANIFEST_FILE" ]] || die "deployment source manifest is missing or unsafe"
[[ -f "$PRODUCTION_MAINTENANCE_RECEIPT_FILE" && ! -L "$PRODUCTION_MAINTENANCE_RECEIPT_FILE" ]] || die "production maintenance receipt is missing or unsafe"
[[ "$(readlink -f "$COMPOSE_FILE")" == "$APP_DIR/docker-compose.deploy.yml" ]] || die "compose file must belong to the pinned application release"
[[ "$(readlink -f "$DEPLOYMENT_MANIFEST_FILE")" == "$APP_DIR/.deployment-source.json" ]] || die "deployment source manifest must belong to the pinned application release"

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$SCRIPT_NAME"
[[ "$SCRIPT_PATH" == "$DEPLOY_SCRIPT_DIR/$SCRIPT_NAME" ]] || die "recovery script must run from the verified APP_DIR source tree"

verify_active_release() {
  local active_release
  [[ -n "$ACTIVE_APP_LINK" ]] || return 0
  active_release="$(cd "$ACTIVE_APP_LINK" && pwd -P)" || die "active application link is unavailable"
  [[ "$active_release" == "$APP_DIR" ]] || die "active application release changed during receipt recovery"
}

verify_active_release

"$PYTHON_BIN" "$DEPLOY_SCRIPT_DIR/deployment-env-preflight.py" \
  --app-dir "$APP_DIR" --state-dir "$AIRFOILS_PRO_STATE_DIR" --env-file "$ENV_FILE" \
  >/dev/null || die "deployment environment is not eligible for receipt recovery"

# shellcheck source=scripts/deploy/deployment-compose-profile.sh
source "$DEPLOY_SCRIPT_DIR/deployment-compose-profile.sh"
configure_deployment_compose_profile || die "could not configure the deployment compose profile"
[[ "$DEPLOYMENT_ROLE" == "hub" ]] || die "post-engine receipt recovery is production-hub only"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi

compose() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" "${COMPOSE_FILE_ARGS[@]}" "$@"
}
COMPOSE_READY=true

read_env_var() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

verify_source() {
  local fields revision tree_sha file_count
  fields="$("$PYTHON_BIN" "$DEPLOY_SCRIPT_DIR/deployment-source-manifest.py" \
    --verify --root "$APP_DIR" --manifest "$DEPLOYMENT_MANIFEST_FILE")" || return 1
  IFS=$'\t' read -r revision tree_sha file_count <<<"$fields"
  [[ "$revision" == "$EXPECTED_SOURCE_REVISION" ]] || {
    printf 'expected source revision %s, found %s\n' "$EXPECTED_SOURCE_REVISION" "$revision" >&2
    return 1
  }
  [[ "$tree_sha" == "$EXPECTED_SOURCE_TREE_SHA256" ]] || {
    printf 'expected source tree %s, found %s\n' "$EXPECTED_SOURCE_TREE_SHA256" "$tree_sha" >&2
    return 1
  }
  printf 'Verified recovery source: revision=%s sha256=%s files=%s\n' "$revision" "$tree_sha" "$file_count"
}

verify_receipt_binding() {
  "$PYTHON_BIN" - "$PRODUCTION_MAINTENANCE_RECEIPT_FILE" "$MAINTENANCE_TOKEN" \
    "$EXPECTED_RECEIPT_SHA256" "$EXPECTED_CANDIDATE_DIGEST" <<'PY'
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import stat
import sys

path = Path(sys.argv[1])
token = sys.argv[2]
expected_file_sha = sys.argv[3]
expected_candidate_digest = sys.argv[4]
metadata = path.lstat()
if not stat.S_ISREG(metadata.st_mode) or path.is_symlink() or stat.S_IMODE(metadata.st_mode) != 0o600:
    raise SystemExit("maintenance receipt is not a regular mode-0600 file")
raw = path.read_bytes()
if hashlib.sha256(raw).hexdigest() != expected_file_sha:
    raise SystemExit("maintenance receipt SHA-256 changed")
value = json.loads(raw)
if not isinstance(value, dict):
    raise SystemExit("maintenance receipt is not an object")
if value.get("schemaVersion") != 1 or value.get("maintenanceToken") != token:
    raise SystemExit("maintenance receipt does not own the exact drain token")
digest = value.get("candidateDigest")
if not isinstance(digest, str) or digest != expected_candidate_digest:
    raise SystemExit("maintenance receipt candidate digest changed")
candidates = value.get("candidates")
if not isinstance(candidates, list) or not candidates or len(candidates) > 100:
    raise SystemExit("maintenance receipt candidate scope is invalid")
print(f"Verified immutable receipt: sha256={expected_file_sha} candidates={len(candidates)}")
PY
}

verify_build_identity() {
  local configured_build node_api_id node_expected served_build
  configured_build="$(read_env_var AIRFOILFOAM_BUILD_ID || true)"
  [[ "$configured_build" == "$EXPECTED_BUILD_ID" ]] || die "deployment AIRFOILFOAM_BUILD_ID does not match the expected engine build"
  node_api_id="$(compose ps --status running -q node-api)"
  [[ -n "$node_api_id" && "$(wc -l <<<"$node_api_id")" -eq 1 ]] || die "node-api is not uniquely running"
  node_expected="$(docker inspect "$node_api_id" --format '{{json .Config.Env}}' | "$PYTHON_BIN" -c '
import json, sys
values = json.load(sys.stdin)
matches = [value.split("=", 1)[1] for value in values if value.startswith("ENGINE_EXPECTED_BUILD_ID=")]
if len(matches) != 1:
    raise SystemExit("node-api engine expectation is missing or ambiguous")
print(matches[0])
')" || die "could not read the node-api engine expectation"
  [[ "$node_expected" == "$EXPECTED_BUILD_ID" ]] || die "node-api expects a different engine build"
  served_build="$(curl -fsS --max-time 8 http://127.0.0.1:8000/health | "$PYTHON_BIN" -c '
import json, sys
value = json.load(sys.stdin)
build = value.get("build_id")
if not isinstance(build, str) or not build:
    raise SystemExit("engine health has no build id")
print(build)
')" || die "engine health is unavailable or malformed"
  [[ "$served_build" == "$EXPECTED_BUILD_ID" ]] || die "engine serves a different build"
  curl -fsS --max-time 8 http://127.0.0.1:4000/health >/dev/null || die "node-api health is unavailable"
  printf 'Verified engine and node-api build expectation: %s\n' "$EXPECTED_BUILD_ID"
}

stop_and_require_writers_stopped() {
  local configured running
  configured="$(compose config --services)" || die "could not enumerate control-plane writers"
  grep -Fxq sweeper <<<"$configured" || die "sweeper is not configured"
  grep -Fxq media-repair <<<"$configured" || die "media-repair is not configured"
  compose stop sweeper
  compose stop media-repair
  for service in sweeper media-repair; do
    running="$(compose ps --status running -q "$service")" || die "could not inspect $service after stop"
    [[ -z "$running" ]] || die "$service remained running while receipt reconciliation is fenced"
  done
}

preflight_reconcile() {
  "$PYTHON_BIN" "$DEPLOY_SCRIPT_DIR/production_maintenance_preflight.py" \
    --project "$COMPOSE_PROJECT_NAME" \
    --maintenance-token "$MAINTENANCE_TOKEN" \
    --phase reconcile \
    --receipt-file "$PRODUCTION_MAINTENANCE_RECEIPT_FILE" \
    --timeout-seconds 20
}

repair_known_retry_rollback() {
  # This flag is for the one pre-fix receipt-read rollback only.  The
  # source-controlled CLI parses the whole immutable receipt, locks the exact
  # maintenance token, then accepts only an original ingesting/completed
  # candidate whose current row is the known tokenless running rollback.  It
  # writes no evidence, starts no writer, and leaves admission stopped.
  compose run --rm --no-deps -T \
    --volume "$PRODUCTION_MAINTENANCE_RECEIPT_FILE:$RECEIPT_CONTAINER_PATH:ro" \
    sweeper pnpm --filter @aerodb/sweeper maintenance:reconcile-receipt -- \
    --receipt-file "$RECEIPT_CONTAINER_PATH" \
    --repair-known-retry-rollback \
    || die "receipt retry-shape repair refused"
}

preflight_field() {
  local payload="$1" field="$2"
  printf '%s' "$payload" | "$PYTHON_BIN" -c '
import json, sys
payload = json.load(sys.stdin)
field = sys.argv[1]
value = payload.get(field)
if isinstance(value, bool):
    print("true" if value else "false")
elif isinstance(value, int):
    print(value)
else:
    raise SystemExit(f"missing or invalid receipt-preflight field {field}")
' "$field"
}

require_terminal_receipt_settlement() {
  local payload="$1" ready reconciled candidates terminals remaining unexpected
  ready="$(preflight_field "$payload" readyForReconcile)" || return 1
  reconciled="$(preflight_field "$payload" reconciled)" || return 1
  candidates="$(preflight_field "$payload" candidateCount)" || return 1
  terminals="$(preflight_field "$payload" terminalCount)" || return 1
  remaining="$(preflight_field "$payload" remainingCount)" || return 1
  unexpected="$(preflight_field "$payload" unexpectedActiveCount)" || return 1
  [[ "$ready" == true && "$reconciled" == true && "$candidates" -gt 0 && "$terminals" == "$candidates" && "$remaining" == 0 && "$unexpected" == 0 ]] || return 1
}

validate_new_engine_idle_queue() {
  printf '%s' "$1" | "$PYTHON_BIN" -c '
import json, sys
value = json.load(sys.stdin)
if value.get("queue_observation_state") == "stale" and value.get("queue_observation_error") is None:
    # The endpoint truthfully exposes the previous snapshot while its bounded
    # single-flight refresh runs. This is retryable, never sufficient proof.
    raise SystemExit(75)
if value.get("queue_observation_state") != "fresh" or value.get("queue_observation_error") is not None:
    raise SystemExit("engine queue observation is not fresh")
for key in ("active_count", "reserved_count", "scheduled_count", "queue_depth"):
    if value.get(key) != 0:
        raise SystemExit(f"engine queue is not idle: {key}={value.get(key)!r}")
depths = value.get("queue_depths")
if not isinstance(depths, dict) or not depths or any(type(count) is not int or count != 0 for count in depths.values()):
    raise SystemExit("engine registered queue depths are incomplete or nonzero")
errors = value.get("inspection_errors")
if not isinstance(errors, dict) or errors:
    raise SystemExit("engine task inspection is incomplete")
for key in ("worker_queues_error", "worker_runtime_error"):
    if key not in value or value[key] is not None:
        raise SystemExit(f"engine worker observation failed: {key}")
workers = value.get("worker_queues")
if not isinstance(workers, list) or not workers:
    raise SystemExit("engine worker inventory is unavailable")
print("Engine queue proof is fresh and empty")
'
}

require_new_engine_idle() {
  local queue_payload worker_services service worker_ids process_output
  local attempt=0 validation_status last_error=""
  while ((attempt < 30)); do
    if queue_payload="$(curl -fsS --max-time 8 http://127.0.0.1:8000/queue 2>&1)"; then
      if validate_new_engine_idle_queue "$queue_payload"; then
        break
      else
        validation_status=$?
      fi
      if ((validation_status != 75)); then
        die "new engine queue proof is malformed, incomplete, or non-empty"
      fi
      last_error="new engine queue observation is still refreshing"
    else
      # A cold cache intentionally answers unavailable until its first
      # bounded observation completes. Retry only inside this fixed wait.
      last_error="new engine queue proof is temporarily unavailable: $queue_payload"
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  ((attempt < 30)) || die "new engine queue did not become fresh, complete, and empty: $last_error"
  # Inspect only workers selected by the active deployment profile. Expanding
  # every optional profile would incorrectly require deliberately disabled
  # solver pools (for example Foundation 14) to be running.
  worker_services="$(compose config --services | awk '$0 == "worker" || $0 ~ /^worker-/')" || die "could not enumerate active-profile engine workers"
  [[ -n "$worker_services" ]] || die "no engine worker service is configured"
  for service in $worker_services; do
    worker_ids="$(compose ps --status running -q "$service")" || die "could not inspect engine worker $service"
    [[ -n "$worker_ids" ]] || die "engine worker $service is not running"
    process_output="$(compose exec -T "$service" sh -lc "pgrep -af '$OPENFOAM_PROCESS_RE' || true")" || die "could not inspect OpenFOAM processes in $service"
    [[ -z "$process_output" ]] || die "OpenFOAM processes remain active in $service"
  done
}

require_owned_drain() {
  local postgres_id result
  postgres_id="$(compose ps --status running -q postgres)"
  [[ -n "$postgres_id" && "$(wc -l <<<"$postgres_id")" -eq 1 ]] || die "postgres is not uniquely running"
  result="$(docker exec "$postgres_id" psql -U aerodb -d aerodb -X -A -t \
    -v ON_ERROR_STOP=1 -c "
SELECT json_build_object(
  'enabled', enabled,
  'admission_fence_active', admission_fence_active,
  'maintenance_drain_token', maintenance_drain_token::text,
  'maintenance_drain_started_at', maintenance_drain_started_at
)::text
FROM sweeper_state
WHERE id = 1;")" || die "could not inspect production maintenance drain"
  printf '%s' "$result" | "$PYTHON_BIN" -c '
import json, sys
value = json.load(sys.stdin)
token = sys.argv[1]
if (
    not isinstance(value, dict)
    or value.get("enabled") is not False
    or value.get("admission_fence_active") is not False
    or value.get("maintenance_drain_token") != token
    or not isinstance(value.get("maintenance_drain_started_at"), str)
):
    raise SystemExit("maintenance drain ownership changed")
' "$MAINTENANCE_TOKEN" || die "production maintenance drain ownership changed"
}

wait_for_writer() {
  local service="$1" attempts=15 stable=0 previous="" current
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    current="$(compose ps --status running -q "$service")" || die "could not inspect $service start"
    if [[ -n "$current" && "$current" == "$previous" ]]; then
      stable=$((stable + 1))
    elif [[ -n "$current" ]]; then
      previous="$current"
      stable=1
    else
      previous=""
      stable=0
    fi
    if ((stable >= 3)); then
      printf '%s remained running with scheduling still fenced.\n' "$service"
      return 0
    fi
    sleep 2
  done
  die "$service did not remain running"
}

restore_admission_last() {
  local postgres_id query result
  postgres_id="$(compose ps --status running -q postgres)"
  [[ -n "$postgres_id" && "$(wc -l <<<"$postgres_id")" -eq 1 ]] || die "postgres is not uniquely running"
  # The canonical UUID validator above makes literal binding safe. Keep a
  # single marker so a future edit cannot silently widen this one last CAS.
  query="
UPDATE sweeper_state
SET enabled = true,
    maintenance_drain_token = NULL,
    maintenance_drain_started_at = NULL,
    \"updatedAt\" = now()
WHERE id = 1
  AND enabled = false
  AND admission_fence_active = false
  AND maintenance_drain_token = :'maintenance_token'::uuid
RETURNING json_build_object(
  'enabled', enabled,
  'admission_fence_active', admission_fence_active,
  'maintenance_drain_token', maintenance_drain_token::text,
  'maintenance_drain_started_at', maintenance_drain_started_at
)::text;"
  [[ "$(grep -o ":'maintenance_token'" <<<"$query" | wc -l)" -eq 1 ]] || die "admission restore CAS lost its exact token marker"
  query="${query//:\'maintenance_token\'/\'$MAINTENANCE_TOKEN\'}"
  # `-t` removes headings/footers but PostgreSQL still emits the DML command
  # tag (`UPDATE 1`) after a RETURNING row. Quiet mode makes this transport
  # exactly one JSON value so a successful CAS cannot look like parse drift.
  result="$(docker exec "$postgres_id" psql -U aerodb -d aerodb -X -A -t -q \
    -v ON_ERROR_STOP=1 -c "$query")" || die "maintenance admission restore query failed"
  [[ -n "$result" ]] || die "maintenance admission restore CAS did not acquire the exact token"
  printf '%s' "$result" | "$PYTHON_BIN" -c '
import json, sys
value = json.load(sys.stdin)
if (
    not isinstance(value, dict)
    or value.get("enabled") is not True
    or value.get("admission_fence_active") is not False
    or value.get("maintenance_drain_token") is not None
    or value.get("maintenance_drain_started_at") is not None
):
    raise SystemExit("admission restore did not retire exact maintenance ownership")
' || die "maintenance admission restore CAS returned an invalid state"
  ADMISSION_RELEASED=true
  printf 'Receipt recovery complete: admission restored only after exact terminal settlement and idle proof.\n'
}

exec 9>"$LOCK_FILE"
flock -n 9 || die "another Airfoils.Pro deploy or maintenance action is running"

verify_source || die "source manifest did not match the pinned recovery release"
verify_receipt_binding || die "immutable receipt binding failed"
verify_build_identity
stop_and_require_writers_stopped

if [[ "$REPAIR_KNOWN_RETRY_ROLLBACK" == "true" ]]; then
  printf 'Repairing only the receipt-pinned legacy ingest retry rollback while admission and writers remain stopped.\n'
  repair_known_retry_rollback
  verify_source || die "source manifest changed during receipt retry-shape repair"
  verify_receipt_binding || die "immutable receipt changed during receipt retry-shape repair"
fi

before="$(preflight_reconcile)" || die "receipt preflight refused before reconciliation"
if [[ "$(preflight_field "$before" readyForReconcile)" != true ]]; then
  die "receipt scope is no longer exclusive"
fi
if [[ "$(preflight_field "$before" reconciled)" != true ]]; then
  printf 'Reconciling only the receipt-pinned terminal jobs while normal writers remain stopped.\n'
  compose run --rm --no-deps -T \
    --volume "$PRODUCTION_MAINTENANCE_RECEIPT_FILE:$RECEIPT_CONTAINER_PATH:ro" \
    sweeper pnpm --filter @aerodb/sweeper maintenance:reconcile-receipt -- \
    --receipt-file "$RECEIPT_CONTAINER_PATH" \
    || die "receipt-scoped reconciliation failed"
fi

verify_source || die "source manifest changed during receipt reconciliation"
verify_receipt_binding || die "immutable receipt changed during reconciliation"
after="$(preflight_reconcile)" || die "receipt preflight refused after reconciliation"
require_terminal_receipt_settlement "$after" || die "receipt rows did not reach exact terminal settlement"
require_new_engine_idle

# Start only the ordinary writers, while the exact maintenance token still
# keeps their work loops inert. This proves the promoted control plane can
# run before the one irreversible scheduler-admission change below.
WRITERS_STARTED=true
compose up -d --no-deps media-repair
wait_for_writer media-repair
compose up -d --no-deps sweeper
wait_for_writer sweeper
verify_source || die "source manifest changed before admission restore"
verify_receipt_binding || die "immutable receipt changed before admission restore"
require_owned_drain
verify_active_release
restore_admission_last
