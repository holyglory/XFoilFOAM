#!/usr/bin/env bash
# Shared server-side maintenance lifecycle. Never deploy/recreate containers or touch the
# OpenFOAM engines. Run on the server, from a stable release directory.
set -Eeuo pipefail

usage() {
  cat <<'HELP'
Usage: compact-progressive-remote-reports.sh [--dry-run | --execute] [--server-run]

For the HZ worker use rewrite-hz-worker-reports.py on the operator host.
Default: print the plan without probing or changing Docker, SQL, or lock files.
--execute: hold the shared deploy lock, capture existing containers, stop only
  running node-api/web/sweeper/media-repair, VACUUM FULL the fixed report table,
  then restore their exact prior running state on success, failure, or signals.
--server-run: submit execute mode to a detached systemd service on THIS server.
  Example (only after maintenance is authorized):
    sudo /opt/airfoils-pro/app/scripts/deploy/compact-progressive-remote-reports.sh --execute --server-run
  Submission is not completion. Inspect journalctl -u airfoils-progressive-report-compaction
  and state/progressive-report-compaction.*/result for the final exit/restoration result.
  A failed submission must be inspected before resubmitting; it may have started.
  Recovery checks API /health when node-api was running, and the public-origin
  /admin and /airfoils/ag24 HTML routes when both web and node-api were running.
  These prove route availability, not authenticated admin interactions or UI QA.
  PUBLIC_ORIGIN defaults to https://airfoils.pro; API_ORIGIN defaults to
  http://127.0.0.1:4000. Origins must not contain credentials, paths or queries.

Bounds (seconds, positive integers): COMMAND_TIMEOUT_SECONDS=15 (max 60),
COMPACTION_TIMEOUT_SECONDS=300 (max 1800), MAINTENANCE_TIMEOUT_SECONDS=900
(max 2400), RESTORE_TIMEOUT_SECONDS=180 (max 300), READINESS_TIMEOUT_SECONDS=120
(max 240, within the restoration deadline). Each command has a two-second
kill grace. PostgreSQL also enforces lock/statement timeouts inside its session.
The Nov 9 rewrite alone used 561.99 CPU seconds before ANALYZE; the default can
therefore time out safely. For a separately authorized longer window, explicitly
set COMPACTION_TIMEOUT_SECONDS=900 MAINTENANCE_TIMEOUT_SECONDS=1200 before the
--execute --server-run invocation. This is still bounded, not a duration guarantee;
there is no automatic compaction retry. Do not rerun merely to test restoration.
EXIT/HUP/INT/TERM/PIPE restore; repeated signals are ignored during bounded cleanup.
SIGKILL, host failure, or an unavailable Docker daemon cannot guarantee recovery;
the retained snapshot and nonzero result/journal identify recovery still needed.
HELP
}

execute=false
server_run=false
hz=false
restore_only=false
for arg in "$@"; do
  case "$arg" in
    --execute) execute=true ;;
    --dry-run) execute=false ;;
    --server-run) server_run=true ;;
    --hz-worker-session) hz=true ;;
    --restore-worker-state) hz=true; restore_only=true ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done
if [[ "$execute" == false ]]; then
  if [[ "$hz" == true ]]; then
    printf '%s\n' 'Use rewrite-hz-worker-reports.py --dry-run for the live worker capacity and lease check.'
    exit 0
  fi
  printf '%s\n' 'DRY RUN: lock deployment; snapshot prior containers; stop running node-api web sweeper media-repair; VACUUM (FULL, ANALYZE) public.progressive_remote_reports; restore exact prior state. Engines api/worker remain untouched.'
  exit 0
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.deploy.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
COMPOSE_OVERRIDE_FILE="${COMPOSE_OVERRIDE_FILE:-}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"
COMMAND_TIMEOUT_SECONDS="${COMMAND_TIMEOUT_SECONDS:-15}"
COMPACTION_TIMEOUT_SECONDS="${COMPACTION_TIMEOUT_SECONDS:-300}"
MAINTENANCE_TIMEOUT_SECONDS="${MAINTENANCE_TIMEOUT_SECONDS:-900}"
RESTORE_TIMEOUT_SECONDS="${RESTORE_TIMEOUT_SECONDS:-180}"
READINESS_TIMEOUT_SECONDS="${READINESS_TIMEOUT_SECONDS:-120}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://airfoils.pro}"
API_ORIGIN="${API_ORIGIN:-http://127.0.0.1:4000}"

UNIT=airfoils-progressive-report-compaction
SQL_TAG=xfoilfoam_progressive_report_compaction
if [[ "$hz" == true ]]; then
  # The operator creates this unique, private package/receipt directory after
  # preflight. HZ never runs the hub SQL or checks a public hub URL.
  RUN_KEY="${SCRIPT_DIR##*/}"
  [[ "$RUN_KEY" =~ ^[0-9a-f]{32}$ && "$SCRIPT_DIR" == "$AIRFOILS_PRO_STATE_DIR/worker-report-rewrite/$RUN_KEY" &&
     -f "$SCRIPT_DIR/plan.json" ]] || { echo 'Use the HZ operator rewrite command.' >&2; exit 2; }
  UNIT="airfoils-hz-report-rewrite-$RUN_KEY"
  SQL_TAG="hz_rewrite_$RUN_KEY"
  PUBLIC_ORIGIN=http://127.0.0.1:3100
  API_ORIGIN=http://127.0.0.1:4000
fi

die() { printf '%s\n' "$2" >&2; exit "$1"; }
bound() {
  [[ "$2" =~ ^[1-9][0-9]{0,5}$ ]] && (( $2 <= $3 )) ||
    die 2 "$1 must be a positive integer no greater than $3."
}
bound COMMAND_TIMEOUT_SECONDS "$COMMAND_TIMEOUT_SECONDS" 60
if [[ "$hz" == true ]]; then
  bound COMPACTION_TIMEOUT_SECONDS "$COMPACTION_TIMEOUT_SECONDS" 86400
  bound MAINTENANCE_TIMEOUT_SECONDS "$MAINTENANCE_TIMEOUT_SECONDS" 259800
else
  bound COMPACTION_TIMEOUT_SECONDS "$COMPACTION_TIMEOUT_SECONDS" 1800
  bound MAINTENANCE_TIMEOUT_SECONDS "$MAINTENANCE_TIMEOUT_SECONDS" 2400
fi
bound RESTORE_TIMEOUT_SECONDS "$RESTORE_TIMEOUT_SECONDS" 300
bound READINESS_TIMEOUT_SECONDS "$READINESS_TIMEOUT_SECONDS" 240
for key in PUBLIC_ORIGIN API_ORIGIN; do
  value="${!key}"
  [[ "$value" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]] ||
    die 2 "$key must be an HTTP(S) origin without credentials, paths, or queries."
done
PUBLIC_ORIGIN="${PUBLIC_ORIGIN%/}"
API_ORIGIN="${API_ORIGIN%/}"

if [[ "$server_run" == true ]]; then
  # systemd owns the child and its journal after SSH/chat exits. KillMode=mixed
  # sends the first TERM only to Bash, leaving cleanup's Docker clients alive.
  env_args=()
  for key in APP_DIR AIRFOILS_PRO_STATE_DIR ENV_FILE COMPOSE_FILE COMPOSE_PROJECT_NAME \
    COMPOSE_OVERRIDE_FILE LOCK_FILE COMMAND_TIMEOUT_SECONDS COMPACTION_TIMEOUT_SECONDS \
    MAINTENANCE_TIMEOUT_SECONDS RESTORE_TIMEOUT_SECONDS READINESS_TIMEOUT_SECONDS \
    PUBLIC_ORIGIN API_ORIGIN; do
    env_args+=("--setenv=$key=${!key}")
  done
  target_args=()
  if [[ "$hz" == true ]]; then target_args+=(--hz-worker-session); fi
  if [[ "$restore_only" == true ]]; then target_args+=(--restore-worker-state); fi
  timeout --kill-after=2 15 systemd-run --unit="$UNIT" \
    --collect --property=Type=exec --property=KillMode=mixed \
    "--property=TimeoutStopSec=$((RESTORE_TIMEOUT_SECONDS + 15))s" \
    "--property=RuntimeMaxSec=$((MAINTENANCE_TIMEOUT_SECONDS + RESTORE_TIMEOUT_SECONDS + 30))s" \
    "${env_args[@]}" /bin/bash "$SCRIPT_DIR/compact-progressive-remote-reports.sh" --execute "${target_args[@]}"
  exit $?
fi

for path in "$APP_DIR" "$AIRFOILS_PRO_STATE_DIR"; do
  [[ "$path" == /* && -d "$path" ]] || die 2 "Expected an absolute existing directory: $path"
done
for path in "$ENV_FILE" "$COMPOSE_FILE"; do
  [[ "$path" == /* && -f "$path" && -r "$path" ]] || die 2 "Expected an absolute readable file: $path"
done
[[ "$LOCK_FILE" == /* && ! -L "$LOCK_FILE" && -d "$(dirname -- "$LOCK_FILE")" ]] ||
  die 2 'Expected an absolute non-symlink deployment lock in an existing directory.'
umask 077
if [[ -e "$LOCK_FILE" ]]; then
  [[ -f "$LOCK_FILE" ]] || die 2 'Expected a regular deployment lock.'
  # Linux permits flock on a read-only descriptor. Reopening an existing
  # deployer-owned lock with O_CREAT in sticky /tmp can fail even for root.
  exec 9<"$LOCK_FILE"
else
  exec 9>>"$LOCK_FILE"
fi
flock -n 9 || die 9 'Another deployment or maintenance operation holds the deployment lock.'

DEADLINE=$((SECONDS + MAINTENANCE_TIMEOUT_SECONDS))
ACTIVE_PID=""
RESTORE_ARMED=false
SQL_ACTIVE=false
RUN_DIR=""
WRITERS=(node-api web sweeper media-repair)
PROTECTED=(api worker postgres)
if [[ "$hz" == true ]]; then PROTECTED+=(redis); fi
SERVICES=("${PROTECTED[@]}" "${WRITERS[@]}")
declare -A IDS STATES STARTED

# All clients lose fd 9: neither an orphaned client nor its child can retain
# the lock after the owner exits. Background wait lets TERM/INT interrupt SQL.
run_bounded() {
  local limit="$1" remaining=$((DEADLINE - SECONDS)) rc=0
  shift
  (( remaining > 0 )) || return 124
  (( limit <= remaining )) || limit="$remaining"
  timeout --signal=TERM --kill-after=2 "$limit" "$@" 9>&- &
  ACTIVE_PID=$!
  wait "$ACTIVE_PID" || rc=$?
  ACTIVE_PID=""
  return "$rc"
}
compose() {
  run_bounded "$COMMAND_TIMEOUT_SECONDS" "${COMPOSE[@]}" --env-file "$ENV_FILE" \
    -p "$COMPOSE_PROJECT_NAME" "${COMPOSE_FILE_ARGS[@]}" "$@"
}
capture() {
  local service="$1" ids id details oneoff state started
  ids="$(compose ps --all -q "$service")" || return 1
  CAPTURED_ID=""; CAPTURED_STATE=absent; CAPTURED_STARTED=-
  [[ -n "$ids" ]] || return 0
  while IFS= read -r id; do
    [[ "$id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
    details="$(run_bounded "$COMMAND_TIMEOUT_SECONDS" docker inspect --format \
      '{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.State.Status}}|{{.State.StartedAt}}' "$id")" || return 1
    IFS='|' read -r oneoff state started <<<"$details"
    [[ -n "$started" && "$details" != *$'\n'* ]] || return 1
    case "${oneoff,,}" in
      true) [[ "$state" == exited ]] || return 1; continue ;;
      false|'') ;;
      *) return 1 ;;
    esac
    [[ -z "$CAPTURED_ID" ]] || return 1
    case "$state" in running|exited|created) ;; *) return 1 ;; esac
    CAPTURED_ID="$id"; CAPTURED_STATE="$state"; CAPTURED_STARTED="$started"
  done <<<"$ids"
}
assert_prior() {
  local service="$1"
  capture "$service" && [[ "$CAPTURED_ID" == "${IDS[$service]}" &&
    "$CAPTURED_STATE" == "${STATES[$service]}" ]] || return 1
  # Engine processes must not have been restarted in the same container either.
  if [[ " ${PROTECTED[*]} " == *" $service "* ]]; then
    [[ "$CAPTURED_STARTED" == "${STARTED[$service]}" ]] || return 1
  fi
}
psql_cleanup() {
  run_bounded "$COMMAND_TIMEOUT_SECONDS" docker exec \
    -e 'PGOPTIONS=-c lock_timeout=2000 -c statement_timeout=5000 -c application_name=xfoilfoam_report_compaction_cleanup' \
    "${IDS[postgres]}" psql -X -w -v ON_ERROR_STOP=1 -U aerodb -d aerodb "$@"
}
route_ready() {
  local label="$1" url="$2" expected_type="$3" response status content_type rc
  while (( SECONDS < READINESS_DEADLINE && SECONDS < DEADLINE )); do
    rc=0
    response="$(run_bounded "$COMMAND_TIMEOUT_SECONDS" curl --disable --silent \
      --connect-timeout 2 --max-time 5 --output /dev/null \
      --write-out '%{http_code}|%{content_type}' "$url")" || rc=$?
    IFS='|' read -r status content_type <<<"$response"
    if [[ "$rc" == 0 && "$status" == 200 && "$content_type" == "$expected_type"* ]]; then
      printf '%s\tpassed\t200\n' "$label" >>"$RUN_DIR/readiness.tsv"
      return 0
    fi
    # Retain only bounded status metadata, never bodies, credentials or headers.
    printf '%s\tretry\tclient_exit=%s\n' "$label" "$rc" >>"$RUN_DIR/readiness.tsv"
    run_bounded 1 sleep 0.5
  done
  printf '%s\tfailed\tdeadline\n' "$label" >>"$RUN_DIR/readiness.tsv"
  printf 'CRITICAL: restored service route %s did not become available before its deadline.\n' "$label" >&2
  return 1
}
verify_readiness() {
  local failed=false
  READINESS_DEADLINE=$((SECONDS + READINESS_TIMEOUT_SECONDS))
  if [[ "${STATES[node-api]}" == running ]]; then
    route_ready api-health "$API_ORIGIN/health" application/json || failed=true
  else
    printf 'api-health\tskipped\tnode-api was not running\n' >>"$RUN_DIR/readiness.tsv"
  fi
  if [[ "${STATES[web]}" == running && "${STATES[node-api]}" == running ]]; then
    route_ready admin "$PUBLIC_ORIGIN/admin" text/html || failed=true
    if [[ "$hz" == false ]]; then
      route_ready airfoil-detail "$PUBLIC_ORIGIN/airfoils/ag24" text/html || failed=true
    fi
  else
    printf 'web-routes\tskipped\tweb/node-api were not both running\n' >>"$RUN_DIR/readiness.tsv"
  fi
  [[ "$failed" == false ]]
}
cleanup() {
  local original_rc=$? failed=false readiness_failed=false service pending attempt
  trap - EXIT
  trap '' HUP INT TERM PIPE
  set +e
  DEADLINE=$((SECONDS + RESTORE_TIMEOUT_SECONDS))
  if [[ -n "$ACTIVE_PID" ]]; then
    kill -TERM "$ACTIVE_PID" 2>/dev/null
    wait "$ACTIVE_PID"
    ACTIVE_PID=""
  fi
  if [[ "$SQL_ACTIVE" == true ]]; then
    # Killing docker exec does not prove server-side SQL stopped. Cancel only
    # this operation's tagged session, then verify it is no longer active.
    psql_cleanup -Atc "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name = '${SQL_TAG}' AND datname=current_database() AND pid <> pg_backend_pid();" || failed=true
    pending=unknown
    for attempt in 1 2 3 4 5; do
      pending="$(psql_cleanup -Atc "SELECT count(*) FROM pg_stat_activity WHERE application_name = '${SQL_TAG}' AND datname=current_database() AND state = 'active';")" || pending=unknown
      [[ "$pending" == 0 ]] && break
      run_bounded 1 sleep 0.2
    done
    if [[ "$hz" == true && "$pending" != 0 ]]; then
      # The HZ session tag is unique to the retained run. A lost docker-exec
      # reply can leave that backend alive after its client is gone.
      psql_cleanup -Atc "SELECT pg_terminate_backend(pid, 3000) FROM pg_stat_activity WHERE application_name='${SQL_TAG}' AND datname=current_database() AND pid<>pg_backend_pid();" || failed=true
      pending="$(psql_cleanup -Atc "SELECT count(*) FROM pg_stat_activity WHERE application_name='${SQL_TAG}' AND datname=current_database() AND xact_start IS NOT NULL;")" || pending=unknown
      if [[ "$pending" != 0 ]]; then RESTORE_ARMED=false; fi
    fi
    [[ "$pending" == 0 ]] || { printf 'CRITICAL: SQL cancellation could not be confirmed.\n' >&2; failed=true; }
  fi
  if [[ "$RESTORE_ARMED" == true ]]; then
    for service in "${WRITERS[@]}"; do
      if ! capture "$service" || [[ "$CAPTURED_ID" != "${IDS[$service]}" ]]; then
        printf 'CRITICAL: container identity unavailable/changed for %s; refusing to start a replacement.\n' "$service" >&2
        failed=true
        continue
      fi
      if [[ "${STATES[$service]}" == running && ( "$hz" == false || "$CAPTURED_STATE" != running ) ]]; then
        run_bounded "$COMMAND_TIMEOUT_SECONDS" docker start "${IDS[$service]}" || {
          printf 'CRITICAL: start command failed for %s.\n' "$service" >&2; failed=true;
        }
      fi
      assert_prior "$service" || { printf 'CRITICAL: prior state not restored for %s.\n' "$service" >&2; failed=true; }
    done
    for service in "${PROTECTED[@]}"; do
      assert_prior "$service" || { printf 'CRITICAL: %s identity/state/start time changed.\n' "$service" >&2; failed=true; }
    done
    verify_readiness || readiness_failed=true
    if [[ "$hz" == true ]]; then
      run_bounded 45 python3 "$SCRIPT_DIR/hz-worker-report-rewrite-host.py" resumed "$RUN_DIR" "${IDS[postgres]}" || readiness_failed=true
    fi
  fi
  local final_rc="$original_rc"
  if [[ "$readiness_failed" == true ]]; then
    final_rc=19
    printf 'CRITICAL: route availability was not confirmed (operation exit %s).\n' "$original_rc" >&2
  fi
  if [[ "$failed" == true ]]; then
    final_rc=18
    printf 'CRITICAL: recovery incomplete (operation exit %s). Inspect the retained prior-state snapshot.\n' "$original_rc" >&2
  fi
  if [[ -n "$RUN_DIR" ]]; then
    local receipt=result
    if [[ "$restore_only" == true ]]; then receipt=recovery-result; fi
    printf 'operation_exit=%s\nrecovery_failed=%s\nreadiness_failed=%s\nexit=%s\n' \
      "$original_rc" "$failed" "$readiness_failed" "$final_rc" >"$RUN_DIR/$receipt.tmp" && mv "$RUN_DIR/$receipt.tmp" "$RUN_DIR/$receipt" || final_rc=18
  fi
  exit "$final_rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 141' PIPE

cd -- "$APP_DIR"
run_bounded "$COMMAND_TIMEOUT_SECONDS" python3 "$SCRIPT_DIR/deployment-env-preflight.py" \
  --app-dir "$APP_DIR" --state-dir "$AIRFOILS_PRO_STATE_DIR" --env-file "$ENV_FILE" >/dev/null
source "$SCRIPT_DIR/deployment-compose-profile.sh"
configure_deployment_compose_profile
if [[ "$hz" == true ]]; then
  [[ "$DEPLOYMENT_ROLE" == remote-solver && "$COMPOSE_PROJECT_NAME" == hz-solver2 ]] || die 2 'Expected the HZ remote-solver deployment.'
else
  [[ "$DEPLOYMENT_ROLE" == hub ]] || die 2 'This compaction is restricted to the hub deployment.'
fi
if run_bounded "$COMMAND_TIMEOUT_SECONDS" docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi
compose config --quiet >/dev/null
configured="$(compose config --services)"
if [[ "$hz" == true && $'\n'"$configured"$'\n' == *$'\nworker-foundation14\n'* ]]; then
  PROTECTED+=(worker-foundation14)
  SERVICES+=(worker-foundation14)
fi
for service in "${SERVICES[@]}"; do
  [[ $'\n'"$configured"$'\n' == *$'\n'"$service"$'\n'* ]] || die 2 "Missing service: $service"
  capture "$service" || die 14 "Could not capture unambiguous state for $service."
  IDS[$service]="$CAPTURED_ID"; STATES[$service]="$CAPTURED_STATE"; STARTED[$service]="$CAPTURED_STARTED"
done
[[ "${STATES[postgres]}" == running ]] || die 14 'PostgreSQL must already be running.'
if [[ "$hz" == true ]]; then
  RUN_DIR="$SCRIPT_DIR"
  if [[ "$restore_only" == true ]]; then
    [[ -s "$RUN_DIR/prior-state.tsv" ]] || die 14 'Missing original HZ container snapshot.'
    count=0
    while IFS=$'\t' read -r service id state started; do
      [[ " ${SERVICES[*]} " == *" $service "* && "${IDS[$service]:--}" == "$id" ]] || die 14 'Original container identity changed.'
      STATES[$service]="$state"; STARTED[$service]="$started"; ((count+=1))
    done < "$RUN_DIR/prior-state.tsv"
    [[ "$count" == "${#SERVICES[@]}" ]] || die 14 'Incomplete container snapshot.'
    RESTORE_ARMED=true
    SQL_ACTIVE=true
    exit 0
  fi
  [[ ! -e "$RUN_DIR/prior-state.tsv" ]] || die 14 'This rewrite already has captured state. Use recovery.'
  run_bounded 120 python3 "$SCRIPT_DIR/hz-worker-report-rewrite-host.py" preflight "$RUN_DIR" "${IDS[postgres]}"
else
  RUN_DIR="$(mktemp -d "$AIRFOILS_PRO_STATE_DIR/progressive-report-compaction.XXXXXXXX")"
fi
for service in "${SERVICES[@]}"; do
  # A dash denotes an absent ID so Bash IFS does not collapse an empty TSV field.
  id="${IDS[$service]}"
  if [[ "$hz" == true && -z "$id" ]]; then id=-; fi
  printf '%s\t%s\t%s\t%s\n' "$service" "$id" "${STATES[$service]}" "${STARTED[$service]}"
done >"$RUN_DIR/prior-state.tmp"
mv "$RUN_DIR/prior-state.tmp" "$RUN_DIR/prior-state.tsv"
printf 'Maintenance snapshot: %s\n' "$RUN_DIR"

# Arm before the first stop, including partial/failed stop commands.
if [[ "$hz" == true && -e "$RUN_DIR/cancel" ]]; then die 130 'HZ rewrite cancelled before the pause.'; fi
RESTORE_ARMED=true
for service in "${WRITERS[@]}"; do
  if [[ "${STATES[$service]}" == running ]]; then
    run_bounded "$COMMAND_TIMEOUT_SECONDS" docker stop --time 5 "${IDS[$service]}"
  fi
  capture "$service" || die 14 "Could not confirm stopped state for $service."
  [[ "$CAPTURED_ID" == "${IDS[$service]}" && "$CAPTURED_STATE" != running ]] ||
    die 14 "$service did not stop with its captured identity."
done
if [[ "$hz" == true ]]; then
  SQL_ACTIVE=true
  for phase in quiesced identity-before ready rewrite identity-after after; do
    run_bounded "$MAINTENANCE_TIMEOUT_SECONDS" python3 "$SCRIPT_DIR/hz-worker-report-rewrite-host.py" "$phase" "$RUN_DIR" "${IDS[postgres]}"
  done
  SQL_ACTIVE=false
  exit 0
fi
sql_seconds=$((DEADLINE - SECONDS - 5))
(( sql_seconds > 0 )) || die 124 'Maintenance deadline reached before compaction.'
(( sql_seconds <= COMPACTION_TIMEOUT_SECONDS )) || sql_seconds="$COMPACTION_TIMEOUT_SECONDS"
SQL_ACTIVE=true
run_bounded "$((sql_seconds + 5))" docker exec \
  -e "PGOPTIONS=-c lock_timeout=5000 -c statement_timeout=$((sql_seconds * 1000)) -c application_name=xfoilfoam_progressive_report_compaction" \
  "${IDS[postgres]}" psql -X -w -v ON_ERROR_STOP=1 -U aerodb -d "dbname=aerodb application_name=${SQL_TAG}" \
  -c 'VACUUM (FULL, ANALYZE) public.progressive_remote_reports;'
SQL_ACTIVE=false
# EXIT always restores and verifies; successful SQL alone is not completion.
