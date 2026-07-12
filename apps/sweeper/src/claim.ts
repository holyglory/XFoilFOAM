import { type DB, lockPrecalcCells } from "@aerodb/db";
import { sql } from "drizzle-orm";

/** Drizzle transaction clients expose the same insert builder but deliberately
 * omit `transaction` itself. Claiming needs execute; the top-level client is
 * wrapped so the advisory lock and ownership recheck cover the mutation.
 * top-level client and an already-open transaction without lying about nested
 * transaction support. */
type ClaimClient = Pick<DB, "execute"> & Partial<Pick<DB, "transaction">>;

async function claimAoasInTransaction(
  tx: Pick<DB, "execute">,
  airfoilId: string,
  bcId: string,
  presetRevisionId: string,
  aoas: number[],
  simJobId: string,
): Promise<number[]> {
  await lockPrecalcCells(
    tx,
    aoas.map((aoaDeg) => ({
      airfoilId,
      revisionId: presetRevisionId,
      aoaDeg,
    })),
  );
  const claimed: number[] = [];
  for (const aoa of aoas) {
    const rows = (await tx.execute(sql`
      INSERT INTO results (
        airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg,
        status, source, sim_job_id
      )
      SELECT ${airfoilId}::uuid, ${bcId}::uuid, ${presetRevisionId}::uuid,
             ${aoa}, 'queued', 'queued', ${simJobId}::uuid
      WHERE NOT EXISTS (
        SELECT 1 FROM sim_precalc_obligations obligation
        WHERE obligation.airfoil_id = ${airfoilId}
          AND obligation.revision_id = ${presetRevisionId}
          AND obligation.aoa_deg = ${aoa}
      )
      ON CONFLICT (airfoil_id, simulation_preset_revision_id, aoa_deg)
      DO UPDATE SET
        status = 'queued', source = 'queued', sim_job_id = ${simJobId}::uuid,
        error = NULL, "updatedAt" = now()
      WHERE results.status IN ('pending', 'stale')
        AND results.regime IS DISTINCT FROM 'urans'
        AND COALESCE(results.fidelity, '') NOT LIKE 'urans%'
        AND NOT EXISTS (
          SELECT 1 FROM sim_precalc_obligations obligation
          WHERE obligation.airfoil_id = results.airfoil_id
            AND obligation.revision_id = results.simulation_preset_revision_id
            AND obligation.aoa_deg = results.aoa_deg
        )
        AND NOT EXISTS (
          SELECT 1 FROM sim_result_submit_retries submit_retry
          WHERE submit_retry.result_id = results.id
            AND submit_retry.state = 'retry_wait'
            AND submit_retry.next_attempt_at > now()
        )
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    if (rows.length) claimed.push(aoa);
  }
  return claimed;
}

/**
 * Claim AoA points for a job before submitting. A fresh insert always claims;
 * an existing row is claimed only if pending/stale (the ON CONFLICT WHERE
 * guard) — rows already queued/running/done/failed are left in place until an
 * admin explicitly requeues failed evidence back to pending.
 * Returns the AoAs actually claimed.
 */
export async function claimAoas(
  db: ClaimClient,
  airfoilId: string,
  bcId: string,
  presetRevisionId: string,
  aoas: number[],
  simJobId: string,
): Promise<number[]> {
  if (typeof db.transaction === "function") {
    return db.transaction((tx) =>
      claimAoasInTransaction(
        tx,
        airfoilId,
        bcId,
        presetRevisionId,
        aoas,
        simJobId,
      ),
    );
  }
  return claimAoasInTransaction(
    db,
    airfoilId,
    bcId,
    presetRevisionId,
    aoas,
    simJobId,
  );
}
