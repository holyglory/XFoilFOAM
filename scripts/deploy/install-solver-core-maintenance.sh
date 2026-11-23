#!/usr/bin/env bash
set -euo pipefail
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sbin="${SBIN_DIR:-/usr/local/sbin}"
lib="${SOLVER_CORE_LIB_DIR:-$(dirname "$sbin")/lib/airfoils-pro/solver-core}"
case "$lib" in /*) ;; *) echo 'Solver core helper directory must be absolute.' >&2; exit 2;; esac
[[ "$lib" != *$'\n'* && "$lib" != *$'\r'* && "$lib" != *'"'* && "$lib" != *'%'* && "$lib" != *'\'* && "$lib" != *'$'* ]]

units="${SYSTEMD_DIR:-/etc/systemd/system}"
install -d -m 0755 "$lib" "$units/airfoils-docker-storage-prune.service.d"
for module in solver_core_host solver_core_limits solver_core_database solver_core_files solver_core_processes; do
  install -m 0644 "$src/$module.py" "$lib/$module.py"
done
install -m 0755 "$src/solver_core_maintenance.py" "$lib/solver_core_maintenance.py"
dropin="$units/airfoils-docker-storage-prune.service.d/solver-core-maintenance.conf"
printf '[Service]\nExecStartPost="%s/solver_core_maintenance.py" auto\n' "$lib" > "$dropin"
chmod 0644 "$dropin"
