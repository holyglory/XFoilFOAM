#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
case "${1:?Expected api or web}" in
  api)
    export API_PORT="${PORT:?}" API_HOST=127.0.0.1
    export ENGINE_URL=http://127.0.0.1:1 AIRFOILFOAM_EVIDENCE_BUCKET= ENGINE_CONTROL_PLANE_TOKEN=
    corepack pnpm --filter @aerodb/db migrate
    corepack pnpm --filter @aerodb/db exec node --import tsx src/seed-progressive-preview.ts
    exec node scripts/dev/progressive-preview-engine.mjs api
    ;;
  web)
    export API_URL="http://127.0.0.1:${DC2_PORT_API:?}"
    export NEXT_PUBLIC_API_URL="" NEXT_DIST_DIR=".next-progressive-preview-${DC2_GENERATION:?}"
    export NEXT_TSCONFIG_PATH
    NEXT_TSCONFIG_PATH="$(node scripts/dev/prepare-progressive-tsconfig.mjs apps/web "$DC2_GENERATION")"
    corepack pnpm --filter @aerodb/web exec next build
    exec corepack pnpm --filter @aerodb/web exec next start --hostname 127.0.0.1 --port "${PORT:?}"
    ;;
  solver)
    exec node scripts/dev/progressive-preview-engine.mjs solver
    ;;
  *) exit 2 ;;
esac
