#!/usr/bin/env bash
set -euo pipefail
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sbin="${SBIN_DIR:-/usr/local/sbin}"
lib="${SOLVER_CORE_LIB_DIR:-$(dirname "$sbin")/lib/airfoils-pro/solver-core}"
case "$lib" in /*) ;; *) echo 'Solver core helper directory must be absolute.' >&2; exit 2;; esac
[[ "$lib" != *$'\n'* && "$lib" != *$'\r'* && "$lib" != *'"'* && "$lib" != *'%'* && "$lib" != *'\'* && "$lib" != *'$'* ]]

units="${SYSTEMD_DIR:-/etc/systemd/system}"
project="${SOLVER_CORE_COMPOSE_PROJECT:-}"
if [[ -z "$project" ]]; then
  deploy_env="${SOLVER_CORE_DEPLOY_ENV:-${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}/.env.deploy}"
  project="$(python3 - "$deploy_env" <<'PROJECT_PY'
import re
import sys
from pathlib import Path
values = {}
for line in Path(sys.argv[1]).read_text().splitlines():
    key, sep, value = line.partition("=")
    if sep and key in {"AIRFOILFOAM_DEPLOYMENT_ROLE", "COMPOSE_PROJECT_NAME"}:
        if key in values:
            raise SystemExit("ambiguous deployment identity")
        values[key] = value.strip().strip("'\"")
role = values.get("AIRFOILFOAM_DEPLOYMENT_ROLE") or "hub"
project = values.get("COMPOSE_PROJECT_NAME") or ("app" if role == "hub" else "")
if role not in {"hub", "remote-solver"} or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", project):
    raise SystemExit("cannot resolve the solver Compose project")
print(project)
PROJECT_PY
)"
fi
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]

install -d -m 0755 "$lib" "$units/airfoils-docker-storage-prune.service.d"
for module in solver_core_host solver_core_limits solver_core_database solver_core_files solver_core_processes; do
  install -m 0644 "$src/$module.py" "$lib/$module.py"
done
install -m 0755 "$src/solver_core_maintenance.py" "$lib/solver_core_maintenance.py"
dropin="$units/airfoils-docker-storage-prune.service.d/solver-core-maintenance.conf"
printf '[Service]\nExecStartPost="%s/solver_core_maintenance.py" auto --project "%s"\n' "$lib" "$project" > "$dropin"
chmod 0644 "$dropin"
