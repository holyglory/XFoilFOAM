#!/usr/bin/env bash
set -euo pipefail

workspace=$1
shift
exec /usr/bin/corepack pnpm --filter "$workspace" exec vitest run "$@" \
  --reporter=default --reporter=junit \
  --outputFile.junit="${DEVCOORDINATOR_DIAGNOSTICS_DIR:?}/report.xml"
