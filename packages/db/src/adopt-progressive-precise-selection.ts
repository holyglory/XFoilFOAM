import { createClient } from "./client";
import {
  adoptProgressivePreciseSelectionPolicy,
  previewProgressivePreciseSelectionPolicy,
} from "./progressive-recipe-adoption";

const [campaignId, mode = "--dry-run"] = process.argv.slice(2);
if (
  !campaignId ||
  !["--dry-run", "--apply"].includes(mode) ||
  process.argv.length > 4
)
  throw new Error(
    "Usage: adopt-progressive-precise-selection CAMPAIGN_UUID [--dry-run|--apply]",
  );

const { db, sql } = createClient({ max: 1 });
const rollback = new Error("reviewed dry-run rollback");
let result:
  | Awaited<ReturnType<typeof previewProgressivePreciseSelectionPolicy>>
  | Awaited<ReturnType<typeof adoptProgressivePreciseSelectionPolicy>>
  | undefined;
try {
  await db
    .transaction(async (transaction) => {
      const connection = transaction as unknown as typeof db;
      result =
        mode === "--dry-run"
          ? await previewProgressivePreciseSelectionPolicy(
              connection,
              campaignId,
            )
          : await adoptProgressivePreciseSelectionPolicy(
              connection,
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
