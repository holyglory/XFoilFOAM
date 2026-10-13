import { createClient } from "./client";
import { recoverProgressiveFastBudgetExtensions } from "./progressive-cfd-budget-extension";

const [campaignId, expectedCountText, mode = "--dry-run"] =
  process.argv.slice(2);
const expectedCount = Number(expectedCountText);
if (
  !campaignId ||
  !Number.isSafeInteger(expectedCount) ||
  !["--dry-run", "--apply"].includes(mode) ||
  process.argv.length > 5
)
  throw new Error(
    "Usage: recover-progressive-fast-budget CAMPAIGN_UUID EXPECTED_COUNT [--dry-run|--apply]",
  );

const { db, sql } = createClient({ max: 1 });
const rollback = new Error("FAST budget recovery dry-run rollback");
let result:
  | Awaited<ReturnType<typeof recoverProgressiveFastBudgetExtensions>>
  | undefined;
try {
  await db
    .transaction(async (transaction) => {
      result = await recoverProgressiveFastBudgetExtensions(
        transaction as unknown as typeof db,
        { campaignId, expectedCount },
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
