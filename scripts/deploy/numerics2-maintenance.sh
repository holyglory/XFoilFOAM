NUMERICS2_POOL_ID="3f8bc764-09ae-4ff3-8fd2-260600000002"
NUMERICS2_PRIOR_ENABLED=""

numerics2_preflight() {
  local revision prepared prior_pool
  revision="$(read_env_var OPENCFD2606_NUMERICS_REVISION)"
  revision="${revision:-1}"
  if [[ "$revision" != "2" && "${NUMERICS2_TRANSITION:-false}" != "true" ]]; then
    echo "The corrected adapter requires --numerics-2 after campaign/default preparation; refusing an implicit numerical change." >&2
    return 14
  fi
  if [[ "$revision" != "1" && "$revision" != "2" ]]; then
    echo "Unknown deployed numerical revision; refusing maintenance." >&2
    return 14
  fi
  if [[ "${NUMERICS2_TRANSITION:-false}" == "true" ]]; then
    prepared="$(compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c "
SELECT (EXISTS(SELECT 1 FROM sweeper_state WHERE id=1 AND NOT enabled)
 AND EXISTS(SELECT 1 FROM solver_execution_pools WHERE id='$NUMERICS2_POOL_ID' AND solver_implementation_id='2f8bc764-09ae-4ff3-8fd2-260600000002' AND routing_key='openfoam-opencfd-2606-numerics-2')
 AND NOT EXISTS(SELECT 1 FROM solver_profiles WHERE solver_implementation_id='2f8bc764-09ae-4ff3-8fd2-260600000001')
 AND NOT EXISTS(SELECT 1 FROM sim_campaigns campaign JOIN sim_campaign_conditions condition ON condition.campaign_id=campaign.id AND condition.generation=campaign.current_condition_generation
   JOIN simulation_preset_revisions revision ON revision.id=condition.simulation_preset_revision_id
   WHERE campaign.status IN ('active','paused','attention','completed') AND condition.status IN ('active','kept') AND revision.solver_implementation_id='2f8bc764-09ae-4ff3-8fd2-260600000001')
 AND NOT EXISTS(SELECT 1 FROM sim_jobs WHERE solver_implementation_id='2f8bc764-09ae-4ff3-8fd2-260600000001' AND status IN ('pending','submitted','running','ingesting')))::text;")" || return 14
    if [[ "$prepared" != "true" ]]; then
      echo "Numerical transition requires paused admission, prepared campaigns/defaults, and settled revision-1 jobs." >&2
      return 14
    fi
  fi
  prior_pool="$OPENCFD_2606_POOL_ID"
  [[ "$revision" == "2" ]] && prior_pool="$NUMERICS2_POOL_ID"
  NUMERICS2_PRIOR_ENABLED="$(compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c "SELECT enabled::text FROM solver_execution_pools WHERE id='$prior_pool';")" || return 14
  [[ "$NUMERICS2_PRIOR_ENABLED" == "true" || "$NUMERICS2_PRIOR_ENABLED" == "false" ]] || return 14
}

numerics2_enabled_keys() {
  local keys
  keys="$(read_env_var AIRFOILFOAM_ENABLED_ENGINE_KEYS)"
  python3 - "$keys" <<'PY'
import sys
keys = [key.strip() for key in sys.argv[1].split(',') if key.strip()]
old = 'openfoam:opencfd:2606:numerics-1:adapter-1'
new = 'openfoam:opencfd:2606:numerics-2:adapter-1'
keys = [new if key == old else key for key in keys]
if new not in keys:
    keys.append(new)
print(','.join(dict.fromkeys(keys)))
PY
}

numerics2_verify_runtime() {
  local build="$1" source_hash payload expected_workers=1 deadline
  source_hash="$(PYTHONPATH="$APP_DIR/src" python3 -c 'from pathlib import Path; import sys; from airfoilfoam.provenance import application_source_sha256; print(application_source_sha256(Path(sys.argv[1])))' "$APP_DIR")" || return 13
  if declare -F configured_engine_worker_services >/dev/null; then
    expected_workers="$(configured_engine_worker_services | awk 'NF{count++} END{print count+0}')" || return 13
  fi
  deadline=$((SECONDS + 90))
  while ((SECONDS < deadline)); do
    payload="$(compose exec -T api python - <<'PY'
import json,urllib.request
from airfoilfoam.config import get_settings
settings=get_settings()
request=urllib.request.Request('http://127.0.0.1:8000/queue',headers={'Authorization':'Bearer '+(settings.control_plane_token or '')})
with urllib.request.urlopen(request,timeout=30) as response:
    print(json.dumps(json.load(response)))
PY
)" || payload=""
    if [[ -n "$payload" ]] && printf '%s' "$payload" | python3 "$DEPLOY_SCRIPT_DIR/verify-numerics2-workers.py" --build "$build" --source-sha256 "$source_hash" --expected-workers "$expected_workers"; then
      return 0
    fi
    sleep 3
  done
  echo "The corrected worker identity was not verified before the startup deadline." >&2
  return 13
}

numerics2_restore_pool() {
  [[ "$NUMERICS2_PRIOR_ENABLED" == "true" || "$NUMERICS2_PRIOR_ENABLED" == "false" ]] || return 14
  compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb -c "
UPDATE solver_execution_pools SET enabled=CASE WHEN id='$NUMERICS2_POOL_ID' THEN $NUMERICS2_PRIOR_ENABLED ELSE false END, \"updatedAt\"=now()
WHERE id IN ('$OPENCFD_2606_POOL_ID','$NUMERICS2_POOL_ID');" >/dev/null
}
