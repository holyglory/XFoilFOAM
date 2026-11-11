#!/usr/bin/env bash
# Read-only identities from the pinned runtime, before adding build tools.
source /usr/lib/openfoam/openfoam2606/etc/bashrc || exit 1
set -euo pipefail
mkdir -p /opt/phase-runtime-base
phase_solver_path=$(command -v rhoPimpleFoam)
sha256sum "$phase_solver_path" > /opt/phase-runtime-base/solver.sha256
ldd "$phase_solver_path" > /opt/phase-runtime-base/ldd.txt
while IFS= read -r phase_library_path; do
    sha256sum "$phase_library_path"
done < <(awk '$2 == "=>" && $3 ~ /^\// { print $3 }' /opt/phase-runtime-base/ldd.txt) > /opt/phase-runtime-base/libraries.sha256
