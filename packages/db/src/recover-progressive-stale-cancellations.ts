import { createClient } from "./client";
import { recoverStaleProgressiveCancellations } from "./progressive-stale-cancellation-recovery";

const [campaignId, expectedJobsText, mode = "--dry-run", olderThanText] = process.argv.slice(2);
const expectedJobs = Number(expectedJobsText);
const olderThanMinutes = olderThanText === undefined ? undefined : Number(olderThanText);
if (!campaignId || !Number.isSafeInteger(expectedJobs) || expectedJobs < 0 ||
    !["--dry-run", "--apply"].includes(mode) ||
    (olderThanMinutes !== undefined && !Number.isSafeInteger(olderThanMinutes)) || process.argv.length > 6)
  throw new Error("Usage: recover-progressive-stale-cancellations CAMPAIGN_UUID EXPECTED_JOBS [--dry-run|--apply] [OLDER_THAN_MINUTES]");
const { db, sql } = createClient({ max: 1 });
const rollback = new Error("stale cancellation recovery dry-run rollback");
let result: Awaited<ReturnType<typeof recoverStaleProgressiveCancellations>> | undefined;
try {
  await db.transaction(async (transaction) => {
    result = await recoverStaleProgressiveCancellations(transaction as unknown as typeof db, {
      campaignId, expectedJobs, olderThanMinutes,
    });
    if (mode === "--dry-run") throw rollback;
  }).catch((error) => { if (error !== rollback) throw error; });
  console.log(JSON.stringify({ mode, result }));
} finally { await sql.end(); }
