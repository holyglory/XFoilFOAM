#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname -- "$0")/../.."
[[ "${DC2_COMPONENT:?}" == api && -n "${DC2_POSTGRES_DB_URL:?}" && "${DATABASE_URL:?}" == "$DC2_POSTGRES_DB_URL" ]]
export API_HOST=127.0.0.1 API_PORT="${PORT:?}" ENGINE_URL=http://127.0.0.1:1
export AIRFOILFOAM_EVIDENCE_BUCKET= ENGINE_CONTROL_PLANE_TOKEN=
export ADMIN_AUTH_REQUIRED=true ADMIN_AUTH_DISABLED=false ADMIN_EMAIL=catalog-qa@example.invalid
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
if [[ "${1:-}" == --campaign-stage-fixture ]]; then
  [[ "${DATABASE_URL%%\?*}" == */aerodb_campaign_stage ]]
  corepack pnpm --filter @aerodb/db migrate
  corepack pnpm --filter @aerodb/db seed
  corepack pnpm --filter @aerodb/api exec tsx test/seed-campaign-stage-preview.ts
  exec corepack pnpm --filter @aerodb/api start
fi
corepack pnpm --filter @aerodb/db migrate
# The ordinary preview enrolls every new profile in its campaign. On subsequent
# starts the full catalog is present, but this fixture only needs the two
# measured examples. Reuse them when all six conditions per example can be read.
examples_ready="$(corepack pnpm --filter @aerodb/db exec node --import tsx --input-type=module - <<'JS'
import { createClient } from './src/client.ts';
import { publicProgressiveCatalog } from './src/progressive-catalog.ts';
const { db, sql } = createClient({ max: 1 });
try {
  const rows = await sql`SELECT id FROM airfoils WHERE slug IN ('ag24', 'ag25') AND "deletedAt" IS NULL AND "archivedAt" IS NULL`;
  const examples = await publicProgressiveCatalog(db, rows.map((row) => row.id));
  console.log(rows.length === 2 && examples.conditions.length === 6 &&
    rows.every((row) => examples.metrics.get(row.id)?.polarCount === 6));
} finally {
  await sql.end();
}
JS
)"
if [[ "$examples_ready" != true ]]; then
  corepack pnpm --filter @aerodb/db exec node --import tsx src/seed-progressive-preview.ts
fi
corepack pnpm --filter @aerodb/db seed
exec corepack pnpm --filter @aerodb/api start
