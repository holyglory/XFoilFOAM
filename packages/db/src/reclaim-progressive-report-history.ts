import { createClient } from "./client";
import { reclaimProgressiveReportHistory } from "./progressive-report-retention";

const [campaignId, batchSizeText = "2000"] = process.argv.slice(2);
const batchSize = Number(batchSizeText);
if (!campaignId || !Number.isSafeInteger(batchSize))
  throw new Error(
    "Usage: reclaim-progressive-report-history CAMPAIGN_UUID [BATCH_SIZE]",
  );
const { db, sql } = createClient({ max: 1 });
try {
  console.log(
    JSON.stringify(
      await reclaimProgressiveReportHistory(db, { campaignId, batchSize }),
    ),
  );
} finally {
  await sql.end();
}
