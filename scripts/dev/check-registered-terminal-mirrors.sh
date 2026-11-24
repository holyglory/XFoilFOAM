#!/bin/sh
set -u
mkdir -p "$DEVCOORDINATOR_DIAGNOSTICS_DIR/registered" || exit 1
status=0
DEVCOORDINATOR_DIAGNOSTICS_DIR="$DEVCOORDINATOR_DIAGNOSTICS_DIR/registered" REGISTERED_REPLACEMENT_ROUND=1 \
  /bin/bash scripts/dev/run-vitest-with-diagnostics.sh @aerodb/db test/campaign-profile-enrollment.test.ts -t "progressive remote dispatch composes only after authenticated capabilities" || status=$?
/bin/bash scripts/dev/run-vitest-with-diagnostics.sh @aerodb/sweeper --no-file-parallelism test/progressive-report-archive.test.ts test/progressive-terminal-mirror.test.ts test/closed-worker-report-custody.test.mjs || status=$?
exit "$status"
