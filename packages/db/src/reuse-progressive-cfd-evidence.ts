import { createClient } from "./client";
import { reuseAcceptedProgressiveCfdEvidence } from "./progressive-recipe-adoption";
import { sql as drizzleSql } from "drizzle-orm";

const [campaignId, mode = "--dry-run"] = process.argv.slice(2);
if (
  !campaignId ||
  !["--dry-run", "--apply"].includes(mode) ||
  process.argv.length > 4
)
  throw new Error(
    "Usage: reuse-progressive-cfd-evidence CAMPAIGN_UUID [--dry-run|--apply]",
  );

const { db, sql } = createClient({ max: 1 });
const rollback = new Error("reviewed dry-run rollback");
let result:
  | { generationId: string; previousGenerationIds: string[]; reused: number }
  | undefined;
try {
  await db
    .transaction(async (transaction) => {
      const connection = transaction as unknown as typeof db;
      const [epoch] = await connection.execute(
        drizzleSql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
      );
      const [adoption] = await connection.execute(drizzleSql`
        SELECT generation_id,previous_generation_ids
        FROM progressive_recipe_adoptions
        WHERE campaign_id=${campaignId}::uuid
        ORDER BY created_at DESC LIMIT 1
      `);
      if (!epoch || !adoption)
        throw new Error("The campaign has no progressive recipe adoption");
      const generationId = String(adoption.generation_id);
      const previousGenerationIds = (
        adoption.previous_generation_ids as unknown[]
      ).map(String);
      const reused = await reuseAcceptedProgressiveCfdEvidence(
        connection,
        generationId,
        previousGenerationIds,
        String(epoch.id),
      );
      result = { generationId, previousGenerationIds, reused };
      if (mode === "--dry-run") throw rollback;
    })
    .catch((error) => {
      if (error !== rollback) throw error;
    });
  console.log(JSON.stringify({ mode, result }));
} finally {
  await sql.end();
}
