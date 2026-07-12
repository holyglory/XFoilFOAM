import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";

import type { DB } from "./client";
import { results } from "./schema";

/** Evidence that an ownerless result still belongs to the wave-2 precalc
 * ladder rather than the generic wave-1 gap queue.
 *
 * A precalc crash carries the durable one-shot retry marker. A RANS row carries
 * the rejected/needs_urans classification that originally created the wave-2
 * obligation. Merely having been attached to a wave-2 job is not enough: an
 * empty placeholder has no evidence-backed fidelity and safely returns to the
 * ordinary pending queue. */
export const EVIDENCE_BACKED_WAVE2_RESULT_SQL = sql`(
  (
    ${results.fidelity} = 'urans_precalc'
    AND ${results.autoRetriedAt} IS NOT NULL
  )
  OR (
    ${results.fidelity} = 'rans'
    AND EXISTS (
      SELECT 1
      FROM result_classifications released_classification
      WHERE released_classification.result_id = ${results.id}
        AND released_classification.state IN ('rejected', 'needs_urans')
    )
  )
)`;

/** Truthful release destination for a claimed result.
 *
 * The owner argument may be a concrete job id or the result row's sim_job_id
 * column (for a multi-job startup cleanup statement). */
export function releasedResultStatusSql(ownerJobId: string | SQLWrapper) {
  return sql`CASE WHEN (
    EXISTS (
      SELECT 1 FROM sim_jobs released_job
      WHERE released_job.id = ${ownerJobId}
        AND released_job.wave = 2
        AND released_job.request_payload ->> 'uransFidelity' = 'precalc'
    )
    AND ${EVIDENCE_BACKED_WAVE2_RESULT_SQL}
  ) THEN 'queued'::result_status ELSE 'pending'::result_status END`;
}

/** Release rows owned by one terminalized/lost job. Call this inside the same
 * transaction that wins the sim_job state transition so cancellation cannot
 * detach rows from a competing ingest owner. */
export async function releaseResultClaimsForJob(
  db: DB,
  jobId: string,
  statuses: Array<"pending" | "queued" | "running" | "stale" | "failed">,
): Promise<number> {
  const released = await db
    .update(results)
    .set({
      status: releasedResultStatusSql(jobId),
      source: "queued",
      simJobId: null,
      engineJobId: null,
      engineCaseSlug: null,
    })
    .where(and(eq(results.simJobId, jobId), inArray(results.status, statuses)))
    .returning({ id: results.id });
  return released.length;
}
