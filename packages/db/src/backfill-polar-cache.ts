import { sql as dsql } from "drizzle-orm";

import { createClient } from "./client";
import { refreshPolarCacheForRevision } from "./polar-cache";
import { satisfyPrecalcObligationFromAcceptedResult } from "./precalc-obligations";

type PairRow = {
  airfoil_id: string;
  simulation_preset_revision_id: string;
};

const { db, sql } = createClient({ max: 1 });
const airfoilId = process.env.AIRFOIL_ID?.trim() || null;
const revisionId = process.env.SIMULATION_PRESET_REVISION_ID?.trim() || null;

if (Boolean(airfoilId) !== Boolean(revisionId)) {
  throw new Error(
    "AIRFOIL_ID and SIMULATION_PRESET_REVISION_ID must be supplied together",
  );
}

let refreshed = 0;
let failed = 0;
let obligationsSatisfied = 0;

try {
  const pairs = (await db.execute(dsql<PairRow>`
    SELECT airfoil_id, simulation_preset_revision_id
    FROM (
      SELECT DISTINCT airfoil_id, simulation_preset_revision_id
      FROM results
      WHERE simulation_preset_revision_id IS NOT NULL
      UNION
      SELECT DISTINCT airfoil_id, simulation_preset_revision_id
      FROM result_attempts
      WHERE simulation_preset_revision_id IS NOT NULL
    ) candidates
    ${
      airfoilId && revisionId
        ? dsql`WHERE airfoil_id = ${airfoilId}::uuid
             AND simulation_preset_revision_id = ${revisionId}::uuid`
        : dsql``
    }
    ORDER BY airfoil_id, simulation_preset_revision_id
  `)) as PairRow[];

  if (airfoilId && revisionId) {
    console.log(`scoped to ${airfoilId} ${revisionId}`);
  }

  for (const pair of pairs) {
    try {
      const result = await refreshPolarCacheForRevision(
        db,
        pair.airfoil_id,
        pair.simulation_preset_revision_id,
      );
      refreshed += 1;
      console.log(
        `✓ ${pair.airfoil_id} ${pair.simulation_preset_revision_id}: ${result.fitStatus}, needs URANS ${result.needsUransAoas.length}, rejected ${result.hardRejectedAoas.length}`,
      );
      const acceptedPrecalc = (await db.execute(dsql<{ id: string }>`
        SELECT DISTINCT result.id
        FROM results result
        JOIN result_classifications classification
          ON classification.result_id = result.id
         AND classification.state = 'accepted'
        WHERE result.airfoil_id = ${pair.airfoil_id}::uuid
          AND result.simulation_preset_revision_id = ${pair.simulation_preset_revision_id}::uuid
          AND result.status = 'done'
          AND result.fidelity = 'urans_precalc'
        ORDER BY result.id
      `)) as Array<{ id: string }>;
      for (const row of acceptedPrecalc) {
        const satisfaction = await satisfyPrecalcObligationFromAcceptedResult(
          db,
          row.id,
        );
        if (satisfaction?.changed) obligationsSatisfied += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(
        `✗ ${pair.airfoil_id} ${pair.simulation_preset_revision_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(
    `polar cache backfill complete: ${refreshed} refreshed, ${obligationsSatisfied} preliminary obligations satisfied, ${failed} failed`,
  );
  if (failed) process.exitCode = 1;
} finally {
  await sql.end();
}
