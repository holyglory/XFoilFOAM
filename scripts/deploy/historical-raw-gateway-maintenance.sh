# Sourced only by the complete-state HZ engine maintenance entry point.
gateway_image() {
  local -a args=("$DEPLOY_SCRIPT_DIR/hz-historical-raw-gateway.py" "$1" --app "$APP_DIR"
    --state "$AIRFOILS_PRO_STATE_DIR/historical-raw-gateway.json" --project "$COMPOSE_PROJECT_NAME" --build "$ACTION")
  if [[ "$1" == verify || "$1" == bind-canary ]]; then args+=(--canary "$GATEWAY_CANARY"); fi
  python3 "${args[@]}"
}

historical_gateway_recovery_queue() {
  compose exec -T worker python -IB -c '
import json
from airfoilfoam.api.main import app
routes=[r for r in app.routes if getattr(r,"path",None)=="/queue" and "GET" in r.methods]
if len(routes)!=1: raise SystemExit("original worker queue endpoint unavailable")
print(json.dumps(routes[0].endpoint()))
'
}

historical_gateway_wait_transfers() {
  local stage="$1" claims started=$SECONDS
  wait_remote_transfer_quiescence "$stage" || return 12
  while true; do
    claims="$(compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c "
      SELECT count(*) FROM progressive_worker_evidence_delivery_claims WHERE claim_expires_at>clock_timestamp()")" || return 12
    [[ "$claims" =~ ^[0-9]+$ ]] || return 12
    if [[ "$claims" == 0 ]]; then return 0; fi
    if (( SECONDS - started >= REMOTE_TRANSFER_QUIESCE_TIMEOUT_SECONDS )); then
      echo "Registered evidence delivery still holds $claims active claims." >&2
      return 12
    fi
    sleep 2
  done
}

historical_gateway_restore_controls() {
  # No exclusive deployment lock is held while CFD drains. Only this final
  # short handoff opens intake; the prior transfer and writer settings are exact.
  set_remote_transfer_paused "$DRAIN_TRANSFER_PAUSED"
  if [[ "$(writer_state sweeper)" != "$DRAIN_SWEEPER_WAS_RUNNING" ||
        "$(writer_state media-repair)" != "$DRAIN_MEDIA_REPAIR_WAS_RUNNING" ]]; then
    restore_writers "$DRAIN_SWEEPER_WAS_RUNNING" "$DRAIN_MEDIA_REPAIR_WAS_RUNNING"
  fi
  [[ "$(writer_state sweeper)" == "$DRAIN_SWEEPER_WAS_RUNNING" &&
     "$(writer_state media-repair)" == "$DRAIN_MEDIA_REPAIR_WAS_RUNNING" &&
     "$(remote_transfer_paused)" == "$DRAIN_TRANSFER_PAUSED" ]] || return 14
  gateway_image release-holder
  restore_drain_pool_state
  clear_drain_state
  FAIL_SAFE_ARMED=false
}

historical_gateway_no_retirements() {
  local committed
  committed="$(compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c "
    SELECT EXISTS(SELECT FROM sim_jobs WHERE strip_report#>>'{historicalRawFiles,complete}'='true')::text")" || return 12
  compose exec -T worker python -IB -c '
from airfoilfoam.config import get_settings
root = get_settings().data_dir / "jobs"
for job in root.iterdir():
    if (job/"closed_progressive_historical_raw_files.intent.json").exists() or (job/"closed_progressive_historical_raw_files.complete.json").exists():
        raise SystemExit("A local raw retirement already depends on the file gateway")
'
  [[ "$committed" == false ]] || { echo "Closed raw files already depend on the live gateway." >&2; return 14; }
}

historical_gateway_recover() {
  local phase
  phase="$(gateway_image phase)" || return 14
  case "$phase" in
    captured|built)
      gateway_image original
      ;;
    verified)
      # The real HTTP and worker proofs completed. Finish restoring controls.
      gateway_image attest
      ;;
    switching|rolling-back)
      historical_gateway_no_retirements
      require_drain_admission_closed
      set_remote_transfer_paused true
      historical_gateway_wait_transfers "before historical gateway recovery"
      stop_writers
      FAIL_SAFE_CONTEXT=maintenance
      FAIL_SAFE_ARMED=true
      GATEWAY_RECOVERY_QUEUE=true
      require_maintenance_safe "before historical gateway rollback"
      gateway_image restore-tag
      require_maintenance_safe "stabilized before historical gateway rollback"
      if ! gateway_image original; then
        compose up -d --no-build --no-deps --force-recreate api
      fi
      wait_http "restored original file gateway" http://127.0.0.1:8000/health
      validate_live_2606_volume_runtime "$ACTION"
      gateway_image verify-original
      ;;
    restored)
      gateway_image verify-original
      ;;
    *) echo "Unknown historical gateway recovery state." >&2; return 14 ;;
  esac
  historical_gateway_restore_controls
}

historical_gateway_operation() {
  local pending phase activity
  [[ "$(read_env_var AIRFOILFOAM_BUILD_ID)" == "$ACTION" &&
     "$(read_env_var ENGINE_EXPECTED_BUILD_ID)" == "$ACTION" ]] || {
    echo "The gateway refresh must retain the original engine build." >&2; return 14;
  }
  pending="$(read_env_var REMOTE_SOLVER2606_DRAIN_PENDING)"
  if [[ "$pending" != 1 ]]; then
    if [[ "$GATEWAY_ACTION" != prepare ]]; then
      if [[ "$GATEWAY_ACTION" == install && "$(gateway_image phase)" == verified ]]; then
        gateway_image verify
        return
      fi
      echo "No prepared historical gateway drain." >&2; return 14
    fi
    if [[ -f "$AIRFOILS_PRO_STATE_DIR/historical-raw-gateway.json" && "$(gateway_image phase)" == verified ]]; then
      gateway_image attest
      return
    fi
    numerics2_preflight
    validate_live_2606_volume_runtime "$ACTION"
    gateway_image capture
    begin_remote_solver_drain
  else
    # Unrelated Node releases may continue during this long drain. Rebinding
    # only the draining phase also requires identical qualified gateway modules.
    if [[ "$(read_env_var REMOTE_SOLVER2606_DRAIN_PHASE)" == draining ]]; then
      gateway_image original
      DRAIN_REBIND=true
    fi
    load_drain_state
  fi

  if [[ "$GATEWAY_ACTION" == recover ]]; then historical_gateway_recover; return; fi
  if [[ "$DRAIN_PHASE" == prepared ]]; then
    disable_all_opencfd_pools
    require_drain_admission_closed
    persist_drain_state draining
  fi
  if [[ "$GATEWAY_ACTION" == prepare ]]; then
    require_drain_admission_closed
    echo "Historical gateway drain prepared; writers continue and the deployment lock is released."
    return
  fi
  [[ -f "$GATEWAY_CANARY" && ! -L "$GATEWAY_CANARY" ]] || {
    echo "A private, real closed-source canary is required." >&2; return 14;
  }
  if [[ "$DRAIN_PHASE" == draining ]]; then
    [[ "$(remote_transfer_paused)" == "$DRAIN_TRANSFER_PAUSED" ]] || return 14
    for sample in 1 2; do
      activity="$(remote_solver_drain_activity)" || return 12
      if [[ -n "$activity" ]]; then
        echo "Historical file gateway deferred; existing jobs and transfers continue: $activity"
        return
      fi
      if [[ "$sample" == 1 ]]; then sleep "$REMOTE_SOLVER_DRAIN_POLL_SECONDS"; fi
    done
    persist_drain_state drained
  fi
  if [[ "$DRAIN_PHASE" == maintenance ]]; then
    phase="$(gateway_image phase)" || return 14
    if [[ "$phase" == verified ]]; then gateway_image verify; historical_gateway_restore_controls; return; fi
    if [[ "$phase" == switching || "$phase" == rolling-back || "$phase" == restored ]]; then
      echo "The gateway switch was interrupted. Use the historical gateway recover action." >&2
      return 14
    fi
  fi
  require_drain_admission_closed
  gateway_image original
  gateway_image bind-canary
  historical_gateway_no_retirements
  persist_drain_state maintenance
  MAINTENANCE_TRANSFER_PAUSE_WAS="$DRAIN_TRANSFER_PAUSED"
  MAINTENANCE_QUIESCE_ARMED=true
  set_remote_transfer_paused true
  historical_gateway_wait_transfers "before historical gateway writer stop"
  MAINTENANCE_QUIESCE_ARMED=false
  FAIL_SAFE_CONTEXT=maintenance
  FAIL_SAFE_ARMED=true
  stop_writers
  if ! require_maintenance_safe "before historical gateway image build" || ! gateway_image build ||
     ! require_maintenance_safe "after historical gateway image build"; then
    historical_gateway_recover
    return 12
  fi
  sleep 2
  if ! require_maintenance_safe "stabilized before historical gateway recreate"; then
    historical_gateway_recover
    return 12
  fi
  gateway_image select
  if ! compose up -d --no-build --no-deps --force-recreate api ||
     ! wait_http "historical file gateway" http://127.0.0.1:8000/health ||
     ! validate_live_2606_volume_runtime "$ACTION" || ! gateway_image verify; then
    echo "Historical readback or gateway startup failed; recovering the captured gateway and writer state." >&2
    historical_gateway_recover
    return 13
  fi
  historical_gateway_restore_controls
  echo "Historical source read verified and original worker configuration restored."
}
