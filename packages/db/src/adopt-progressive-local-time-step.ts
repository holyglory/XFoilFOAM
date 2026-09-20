import { createClient } from "./client";
import { adoptProgressiveLocalTimeStepPolicy } from "./progressive-recipe-adoption";

const [campaignId, smoothingText = "0.2", mode = "--dry-run"] = process.argv.slice(2);
const smoothing = Number(smoothingText);
if (
  !campaignId ||
  !Number.isFinite(smoothing) ||
  !["--dry-run", "--apply"].includes(mode) ||
  process.argv.length > 5
)
  throw new Error(
    "Usage: adopt-progressive-local-time-step CAMPAIGN_UUID [SMOOTHING] [--dry-run|--apply]",
  );
const { db, sql } = createClient({ max: 1 });
const rollback = new Error("reviewed dry-run rollback");
let result: Awaited<ReturnType<typeof adoptProgressiveLocalTimeStepPolicy>> | undefined;
try {
  await db
    .transaction(async (transaction) => {
      result = await adoptProgressiveLocalTimeStepPolicy(
        transaction as unknown as typeof db,
        campaignId,
        smoothing,
      );
      if (mode === "--dry-run") throw rollback;
    })
    .catch((error) => {
      if (error !== rollback) throw error;
    });
  console.log(JSON.stringify({ mode, smoothing, result }));
} finally {
  await sql.end();
}
