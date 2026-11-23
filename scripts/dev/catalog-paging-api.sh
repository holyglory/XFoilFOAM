#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname -- "$0")/../.."
[[ "${DC2_COMPONENT:?}" == api && -n "${DC2_POSTGRES_DB_URL:?}" && "${DATABASE_URL:?}" == "$DC2_POSTGRES_DB_URL" ]]
export API_HOST=127.0.0.1 API_PORT="${PORT:?}" ENGINE_URL=http://127.0.0.1:1
export AIRFOILFOAM_EVIDENCE_BUCKET= ENGINE_CONTROL_PLANE_TOKEN=
umask 077
fixture_dir=".codex-artifacts/catalog-page-auth/${DC2_GENERATION:?}"
mkdir -p -- "$fixture_dir"
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
from secrets import token_hex
import sys
for name in ("password", "session"):
    path = Path(sys.argv[1]) / name
    try:
        with path.open("x") as out:
            out.write(token_hex(32))
    except FileExistsError:
        pass
PY
ADMIN_PASSWORD="$(cat -- "$fixture_dir/password")"
ADMIN_SESSION_SECRET="$(cat -- "$fixture_dir/session")"
export ADMIN_PASSWORD ADMIN_SESSION_SECRET
corepack pnpm --filter @aerodb/db migrate
corepack pnpm --filter @aerodb/db exec node --import tsx src/seed-progressive-preview.ts
corepack pnpm --filter @aerodb/db seed
exec corepack pnpm --filter @aerodb/api start
