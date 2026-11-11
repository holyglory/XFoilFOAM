import { createClient } from "./client";
import { requeueProgressiveCompletionRetries } from "./progressive-completion-retry";

const [campaignId, expectedCountText, ...unitIds] = process.argv.slice(2);
const expectedCount = Number(expectedCountText);
if (!campaignId || !Number.isSafeInteger(expectedCount))
  throw new Error("Usage: recover-progressive-completion-retries CAMPAIGN_UUID EXPECTED_COUNT [UNIT_UUID ...]");
const { db, sql } = createClient({ max: 1 });
try {
  console.log(JSON.stringify(await requeueProgressiveCompletionRetries(db, {
    campaignId, expectedCount, ...(unitIds.length ? { unitIds } : {}),
  })));
} finally {
  await sql.end();
}
