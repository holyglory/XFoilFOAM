#!/bin/sh
set -eu
case "$1" in
  workspace) exec corepack pnpm install --offline --frozen-lockfile --ignore-scripts ;;
  schema|seed)
    action="$1"
    if [ "$action" = schema ]; then action=migrate; fi
    exec corepack pnpm --filter @aerodb/db "$action" ;;
  types)
    exec corepack pnpm --filter @aerodb/sweeper --filter @aerodb/api --filter @aerodb/engine-client typecheck ;;
  node|engine)
    # Worktrees can use the repository's installed interpreter; always import this checkout's sources.
    python="$PWD/.venv/bin/python"
    if [ ! -x "$python" ]; then
      common=$(git rev-parse --path-format=absolute --git-common-dir)
      python="${common%/*}/.venv/bin/python"
    fi
    test -x "$python"
    export AIRFOILFOAM_RETENTION_PYTHON="$python" PYTHONPATH="$PWD/src" PYTHONDONTWRITEBYTECODE=1
    if [ "$1" = engine ]; then exec "$python" -m pytest tests/test_retention.py -q; fi
    corepack pnpm --filter @aerodb/sweeper exec vitest run --no-file-parallelism test/retention.test.ts test/closed-progressive-retention.test.ts
    exec corepack pnpm --filter @aerodb/db exec vitest run test/campaign-profile-enrollment.test.ts -t "delivers an exact physical case beside a retained terminal material diagnostic" ;;
  *) exit 2 ;;
esac
