#!/usr/bin/env bash
set -Eeuo pipefail

# Run on the registered worker host. The window and source checks are shared
# with the normal control-plane deployment. The command never starts a service.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"
operation="${1:-status}"
case "$operation" in
  status|verify) [[ $# -le 1 ]] || exit 2 ;;
  backfill) [[ $# -ge 2 && $# -le 4 ]] || { echo "backfill requires the worker instance UUID and accepts a page size and bounded page count." >&2; exit 2; } ;;
  start|stop|enable|disable|restore) [[ $# == 2 ]] || { echo "$operation requires the worker instance UUID." >&2; exit 2; } ;;
  retire) [[ $# == 3 && "$3" =~ ^[0-9a-f]{40}$ ]] || { echo "retire requires the worker instance UUID and exact serving commit." >&2; exit 2; } ;;
  *) echo "Expected status, start, backfill, verify, enable, retire, restore, disable or stop." >&2; exit 2 ;;
esac
if [[ "$operation" != status ]]; then
  # Pin the serving release alongside archive readers. PostgreSQL serializes
  # staging mutations with its advisory lock and locked backfill cursor.
  mode=-s
  case "$operation" in retire|restore) mode=-x ;; esac
  if [[ -f "$LOCK_FILE" ]]; then
    exec 9<"$LOCK_FILE"
  else
    exec 9>>"$LOCK_FILE"
  fi
  flock "$mode" -n -E 9 9 || {
    rc=$?
    if ((rc == 9)); then echo "An incompatible deployment lock is held." >&2; fi
    exit "$rc"
  }
fi
source "$SCRIPT_DIR/deployment-compose-profile.sh"
configure_deployment_compose_profile
[[ "$DEPLOYMENT_ROLE" == remote-solver ]] || { echo "Expected a registered remote worker host." >&2; exit 2; }
compose=(docker compose --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" "${COMPOSE_FILE_ARGS[@]}")
if [[ "$operation" == retire ]]; then
  release="$(python3 "$APP_DIR/scripts/deploy/deployment-source-manifest.py" --verify --root "$APP_DIR" \
    --manifest "$APP_DIR/.deployment-source.json" | cut -f1)"
  [[ "$release" == "$3" ]] || { echo "Serving checkout differs from requested revision." >&2; exit 2; }
  files=(apps/sweeper/src/progressive-staging-selection.ts apps/sweeper/src/progressive-evidence-wake.ts
    apps/sweeper/src/progressive-worker-evidence.ts apps/sweeper/src/progressive-stopped-storage.ts
    packages/db/src/worker-staging-key-maintenance.ts packages/db/src/schema.ts
    packages/db/migrations/0218_worker_report_staging_keys.sql packages/db/migrations/meta/_journal.json)
  proofs="$(cd "$APP_DIR" && sha256sum -- "${files[@]}")"
  for service in sweeper node-api; do
    ids="$("${compose[@]}" ps --status running -q "$service")"
    [[ -n "$ids" ]] || { echo "No running $service reader." >&2; exit 2; }
    while IFS= read -r container; do
      docker exec -i -w /app "$container" sha256sum -c - <<<"$proofs" >/dev/null
    done <<<"$ids"
  done
fi
operator=(-w /app sweeper node --import tsx packages/db/src/worker-staging-key-maintenance.ts)
if [[ "$operation" == backfill && $# == 4 ]]; then
  # Closing this pipe asks the in-container operator to finish its current
  # transaction. This also works when Compose doesn't forward a host signal.
  stopping=false
  input_fd=
  stop_batch() {
    stopping=true
    if [[ -n "$input_fd" ]]; then exec {input_fd}>&-; input_fd=; fi
  }
  trap stop_batch HUP INT TERM
  exec 3>&1
  coproc BATCH { exec "${compose[@]}" exec -T -e STAGING_KEY_PARENT_PIPE=1 "${operator[@]}" "$@" >&3; }
  batch_pid=$!
  input_fd="${BATCH[1]:-}"
  exec 3>&-
  if [[ "$stopping" == true ]]; then stop_batch; fi
  while true; do
    rc=0
    wait "$batch_pid" || rc=$?
    if ((rc < 128)) || ! kill -0 "$batch_pid" 2>/dev/null; then exit "$rc"; fi
  done
fi
exec "${compose[@]}" exec -T "${operator[@]}" "$@"
