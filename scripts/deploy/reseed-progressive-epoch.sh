#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT="${PROJECT:-app}"
SERVICE="${SERVICE:-node-api}"
REASON="${1:-}"
AUTHORITATIVE_ID="${2:-}"

if [[ -z "$REASON" ]]; then
  echo "Usage: $0 REASON [AUTHORITATIVE_ID]" >&2
  exit 2
fi
if [[ -n "$AUTHORITATIVE_ID" && ! "$AUTHORITATIVE_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
  echo "AUTHORITATIVE_ID must be a UUID." >&2
  exit 2
fi

docker exec \
  --env "RESEED_REASON=$REASON" \
  --env "RESEED_AUTHORITATIVE_ID=$AUTHORITATIVE_ID" \
  -w /app \
  "$PROJECT-$SERVICE-1" \
  node --import tsx --input-type=module -e '
import { createClient, rotateCalculationEpoch } from "./packages/db/src/index.ts";

const { db, sql } = createClient();
try {
  const epochId = await rotateCalculationEpoch(
    db,
    process.env.RESEED_REASON,
    process.env.RESEED_AUTHORITATIVE_ID || undefined,
  );
  console.log(JSON.stringify({ epochId, reason: process.env.RESEED_REASON }));
} finally {
  await sql.end();
}
'
