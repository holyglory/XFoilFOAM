import { createClient } from "./client";
import { recoverProgressivePublicationLosses } from "./progressive-publication-recovery";

const [campaignId, mode = "--dry-run"] = process.argv.slice(2);
if (
  !campaignId ||
  !["--dry-run", "--apply"].includes(mode) ||
  process.argv.length > 4
)
  throw new Error(
    "Usage: recover-progressive-publication CAMPAIGN_UUID [--dry-run|--apply]",
  );
const { db, sql } = createClient({ max: 1 });
const rollback = new Error("Publication recovery dry-run rollback");
let result:
  | Awaited<ReturnType<typeof recoverProgressivePublicationLosses>>
  | undefined;
try {
  await db
    .transaction(async (transaction) => {
      result = await recoverProgressivePublicationLosses(
        transaction as unknown as typeof db,
        campaignId,
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
