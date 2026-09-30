import { createClient } from "./client";
import { adoptProgressiveNumerics2 } from "./progressive-numerics-transition";

const [campaignId, sourcePlanId, mode = "--dry-run", handoff] =
  process.argv.slice(2);
if (
  !campaignId ||
  !sourcePlanId ||
  !["--dry-run", "--apply"].includes(mode) ||
  (handoff !== undefined && handoff !== "--defer-stopped-archives") ||
  process.argv.length > 6
)
  throw new Error(
    "Usage: adopt-progressive-numerics CAMPAIGN_UUID SOURCE_PLAN_UUID [--dry-run|--apply] [--defer-stopped-archives]",
  );
const { db, sql } = createClient({ max: 1 });
const rollback = new Error("reviewed numerical transition dry-run rollback");
let result: Awaited<ReturnType<typeof adoptProgressiveNumerics2>> | undefined;
try {
  await db
    .transaction(async (transaction) => {
      result = await adoptProgressiveNumerics2(
        transaction as unknown as typeof db,
        campaignId,
        sourcePlanId,
        { deferStoppedArchives: handoff === "--defer-stopped-archives" },
      );
      if (mode === "--dry-run") throw rollback;
    })
    .catch((error) => {
      if (error !== rollback) throw error;
    });
  console.log(JSON.stringify({ mode, result }));
} finally {
  await sql.end();
}
