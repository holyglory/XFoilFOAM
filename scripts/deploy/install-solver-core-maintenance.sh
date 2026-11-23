#!/usr/bin/env bash
set -euo pipefail
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lib="${SOLVER_CORE_LIB_DIR:-/usr/local/lib/airfoils-pro/solver-core}"
units="${SYSTEMD_DIR:-/etc/systemd/system}"
install -d -m 0755 "$lib" "$units/airfoils-docker-storage-prune.service.d"
for module in solver_core_host solver_core_limits solver_core_database solver_core_files solver_core_processes; do
  install -m 0644 "$src/$module.py" "$lib/$module.py"
done
install -m 0755 "$src/solver_core_maintenance.py" "$lib/solver_core_maintenance.py"
install -m 0644 "$src/solver-core-maintenance.conf" "$units/airfoils-docker-storage-prune.service.d/solver-core-maintenance.conf"
