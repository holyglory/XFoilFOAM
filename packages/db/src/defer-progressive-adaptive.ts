import { sql as dsql } from "drizzle-orm";
import { createClient } from "./client";
import { deferProgressiveAdaptiveFastUnits } from "./progressive-adaptive-deferral";

const [campaignId, mode = "--dry-run"] = process.argv.slice(2);
if (
  !campaignId ||
  !["--dry-run", "--apply"].includes(mode) ||
  process.argv.length > 4
)
  throw new Error(
    "Usage: defer-progressive-adaptive CAMPAIGN_UUID [--dry-run|--apply]",
  );
const { db, sql } = createClient({ max: 1 });
const rollback = new Error("reviewed adaptive deferral dry-run rollback");
let result!: Awaited<ReturnType<typeof deferProgressiveAdaptiveFastUnits>>;
try {
  await db
    .transaction(async (transaction) => {
      const connection = transaction as unknown as typeof db;
      const [sweeper] = await connection.execute(
        dsql`SELECT enabled FROM sweeper_state WHERE id = 1 FOR UPDATE`,
      );
      if (mode === "--apply")
        await connection.execute(
          dsql`UPDATE sweeper_state SET enabled = false WHERE id = 1`,
        );
      result = await deferProgressiveAdaptiveFastUnits(connection, campaignId);
      if (mode === "--apply")
        await connection.execute(
          dsql`UPDATE sweeper_state SET enabled = ${sweeper?.enabled === true} WHERE id = 1`,
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
