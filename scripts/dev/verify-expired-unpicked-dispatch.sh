#!/usr/bin/env bash
set -uo pipefail

if [[ ${1:-} == --intake ]]; then
  exec /usr/bin/corepack pnpm --filter @aerodb/sweeper exec vitest run \
    test/progressive-intake-service.test.ts test/progressive-evidence-service.test.ts \
    --reporter=default --reporter=junit \
    --outputFile.junit="$DEVCOORDINATOR_DIAGNOSTICS_DIR/intake.xml"
fi

# Reuse the installed Python environment while importing this candidate's source.
shared_git=$(git rev-parse --path-format=absolute --git-common-dir)
project_root=${shared_git%/*}
export PYTHONPATH="$PWD/src${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONDONTWRITEBYTECODE=1
result=0
"$project_root/.venv/bin/python" -m pytest tests/test_execution_stop.py -q \
  -k 'current_route_unregistered_cancellation or stop_requires_the_real_execution_lock_and_no_remaining_children' \
  --junitxml="$DEVCOORDINATOR_DIAGNOSTICS_DIR/fences.xml" || result=1
/usr/bin/corepack pnpm --filter @aerodb/db exec vitest run test/campaign-profile-enrollment.test.ts \
  -t 'progressive remote dispatch pins one exact request|sealed dispatch cutover compatibility' --reporter=default --reporter=junit \
  --outputFile.junit="$DEVCOORDINATOR_DIAGNOSTICS_DIR/recovery.xml" || result=1
PROGRESSIVE_REPORT_ARCHIVE_DISPOSABLE_DB=1 /usr/bin/corepack pnpm --filter @aerodb/sweeper exec vitest run \
  test/progressive-terminal-mirror.test.ts --reporter=default --reporter=junit \
  --outputFile.junit="$DEVCOORDINATOR_DIAGNOSTICS_DIR/terminal.xml" || result=1
exit "$result"
