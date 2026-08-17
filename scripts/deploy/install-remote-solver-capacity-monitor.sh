#!/usr/bin/env bash
# Install the read-only six-hour capacity audit on a dedicated remote solver.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"
SYSTEMD_UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
DEPLOY_DIR="$APP_DIR/scripts/deploy"
SERVICE_NAME="airfoils-remote-capacity-check.service"
TIMER_NAME="airfoils-remote-capacity-check.timer"

cd "$APP_DIR"
python3 "$DEPLOY_DIR/deployment-env-preflight.py" \
  --app-dir "$APP_DIR" --state-dir "$AIRFOILS_PRO_STATE_DIR" \
  --env-file "$ENV_FILE" >/dev/null
# shellcheck source=scripts/deploy/deployment-compose-profile.sh
source "$DEPLOY_DIR/deployment-compose-profile.sh"
configure_deployment_compose_profile
if [[ "$DEPLOYMENT_ROLE" != "remote-solver" ]]; then
  echo "Capacity-monitor timer installation requires AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver." >&2
  exit 2
fi

for path in \
  "$DEPLOY_DIR/$SERVICE_NAME" \
  "$DEPLOY_DIR/$TIMER_NAME" \
  "$APP_DIR/scripts/ops/remote_solver_capacity_report.py"; do
  if [[ ! -f "$path" || -L "$path" ]]; then
    echo "Capacity-monitor source must be a regular non-symlink file: $path" >&2
    exit 2
  fi
done
if [[ ! -x "$APP_DIR/scripts/ops/check-remote-solver-capacity.sh" ]] ||
   [[ -L "$APP_DIR/scripts/ops/check-remote-solver-capacity.sh" ]]; then
  echo "Capacity-monitor entrypoint must be an executable non-symlink file." >&2
  exit 2
fi

install -d -m 0755 "$SYSTEMD_UNIT_DIR"
temporary_service="$(mktemp "$SYSTEMD_UNIT_DIR/.${SERVICE_NAME}.XXXXXX")"
temporary_timer="$(mktemp "$SYSTEMD_UNIT_DIR/.${TIMER_NAME}.XXXXXX")"
cleanup() {
  rm -f "$temporary_service" "$temporary_timer"
}
trap cleanup EXIT
install -m 0644 "$DEPLOY_DIR/$SERVICE_NAME" "$temporary_service"
install -m 0644 "$DEPLOY_DIR/$TIMER_NAME" "$temporary_timer"
mv -f "$temporary_service" "$SYSTEMD_UNIT_DIR/$SERVICE_NAME"
mv -f "$temporary_timer" "$SYSTEMD_UNIT_DIR/$TIMER_NAME"
trap - EXIT

"$SYSTEMCTL_BIN" daemon-reload
"$SYSTEMCTL_BIN" reset-failed "$SERVICE_NAME" "$TIMER_NAME"
"$SYSTEMCTL_BIN" enable --now "$TIMER_NAME"
"$SYSTEMCTL_BIN" is-enabled --quiet "$TIMER_NAME"
"$SYSTEMCTL_BIN" is-active --quiet "$TIMER_NAME"
echo "Installed $TIMER_NAME (read-only audit every six hours)."
