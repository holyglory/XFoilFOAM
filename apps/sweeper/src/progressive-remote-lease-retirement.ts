import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db";

export async function retireSettledProgressivePromise(
  db: DB,
  executionId: string,
) {
  const retired = await db.execute(sql`
    WITH eligible AS MATERIALIZED (
      SELECT promise.id
      FROM sync_sweep_promises promise
      JOIN progressive_remote_dispatches dispatch ON dispatch.promise_id = promise.id
      JOIN sim_jobs job ON job.id = dispatch.sim_job_id
      JOIN progressive_cfd_execution_stops stopped
        ON stopped.sim_job_id = job.id AND stopped.engine_job_id = job.engine_job_id
      WHERE dispatch.sim_job_id = ${executionId}::uuid
        AND promise.registered_solver_id = dispatch.solver_id
        AND promise.status IN ('active', 'expired', 'cancelled')
        AND job.status IN ('done', 'failed', 'cancelled')
        AND (job."ingestedAt" IS NOT NULL OR job.status = 'cancelled')
    )
    UPDATE sync_sweep_promises promise
    SET status = CASE WHEN promise.status IN ('active', 'expired') THEN 'cancelled' ELSE promise.status END,
      "cancelledAt" = coalesce(promise."cancelledAt", clock_timestamp()),
      "updatedAt" = clock_timestamp()
    FROM eligible
    WHERE promise.id = eligible.id
    RETURNING promise.id
  `);
  for (const promise of retired) {
    await db.execute(sql`
      UPDATE sync_sweep_promise_points SET status = 'cancelled', "updatedAt" = clock_timestamp()
      WHERE promise_id = ${promise.id}::uuid AND status = 'active'
    `);
  }
  return retired.length;
}
