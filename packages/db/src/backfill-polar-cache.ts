import { sql as dsql } from "drizzle-orm";

import { createClient } from "./client";
import { refreshPolarCacheForRevision } from "./polar-cache";

type PairRow = {
  airfoil_id: string;
  simulation_preset_revision_id: string;
};

const { db, sql } = createClient({ max: 1 });

let refreshed = 0;
let failed = 0;

try {
  const pairs = (await db.execute(dsql<PairRow>`
    SELECT DISTINCT airfoil_id, simulation_preset_revision_id
    FROM results
    WHERE simulation_preset_revision_id IS NOT NULL
    UNION
    SELECT DISTINCT airfoil_id, simulation_preset_revision_id
    FROM result_attempts
    WHERE simulation_preset_revision_id IS NOT NULL
    ORDER BY airfoil_id, simulation_preset_revision_id
  `)) as PairRow[];

  for (const pair of pairs) {
    try {
      const result = await refreshPolarCacheForRevision(db, pair.airfoil_id, pair.simulation_preset_revision_id);
      refreshed += 1;
      console.log(
        `✓ ${pair.airfoil_id} ${pair.simulation_preset_revision_id}: ${result.fitStatus}, needs URANS ${result.needsUransAoas.length}, rejected ${result.hardRejectedAoas.length}`,
      );
    } catch (error) {
      failed += 1;
      console.error(
        `✗ ${pair.airfoil_id} ${pair.simulation_preset_revision_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`polar cache backfill complete: ${refreshed} refreshed, ${failed} failed`);
  if (failed) process.exitCode = 1;
} finally {
  await sql.end();
}
