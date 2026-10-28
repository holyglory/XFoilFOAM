import { createClient } from "./client";
import { recoverProgressivePreciseBudgetExtensions } from "./progressive-cfd-budget-extension";

const [campaignId, expectedCountText, mode = "--dry-run"] = process.argv.slice(2);
const expectedCount = Number(expectedCountText);
if (!campaignId || !Number.isSafeInteger(expectedCount) || !["--dry-run", "--apply"].includes(mode) || process.argv.length > 5)
  throw new Error("Usage: recover-progressive-precise-budget CAMPAIGN_UUID EXPECTED_COUNT [--dry-run|--apply]");
const { db, sql } = createClient({ max: 1 });
const rollback = new Error("precise budget recovery dry-run rollback");
let result: Awaited<ReturnType<typeof recoverProgressivePreciseBudgetExtensions>> | undefined;
try {
  await db.transaction(async (transaction) => {
    result = await recoverProgressivePreciseBudgetExtensions(transaction as unknown as typeof db, { campaignId, expectedCount });
    if (mode === "--dry-run") throw rollback;
  }).catch((error) => { if (error !== rollback) throw error; });
  console.log(JSON.stringify({ mode, result }));
} finally {
  await sql.end();
}
