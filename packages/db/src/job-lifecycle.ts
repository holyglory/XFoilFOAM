import { and, eq, inArray, sql } from "drizzle-orm";

import type { DB } from "./client";
import {
  refreshPrecalcSettlementCampaigns,
  settlePrecalcObligationsForJobInTransaction,
} from "./precalc-obligations";
import { releaseResultClaimsForJob } from "./result-claim-lifecycle";
import { simJobs, simUransRequests, simUransVerifyQueue } from "./schema";

/** Compatibility grace for `ingesting` rows created before migration 0045.
 *
 * A post-migration owner always has an explicit expiry. A tokenless legacy row
 * is treated as live for one normal lease duration after its last update, then
 * becomes recoverable. Keep admin recovery and the sweeper on this exact rule.
 */
export const SIM_JOB_INGEST_LEASE_MS = 10 * 60_000;

/** True for jobs which are not protected by a live evidence-ingest lease.
 *
 * Use this predicate on both the candidate read and the winning mutation. A
 * sweeper may acquire/renew a lease after an admin action reads the row;
 * PostgreSQL must re-evaluate the same condition before any recovery write.
 */
export function outsideLiveSimJobIngestLeaseWhere() {
  return sql`(
    ${simJobs.status} <> 'ingesting'
    OR ${simJobs.ingestLeaseExpiresAt} <= now()
    OR (
      ${simJobs.ingestLeaseExpiresAt} IS NULL
      AND ${simJobs.updatedAt} <= now() - (${SIM_JOB_INGEST_LEASE_MS} * interval '1 millisecond')
    )
  )`;
}

/** States where an explicit cancellation may still own the job.
 *
 * `pending` is a durable pre-submit composition. `submitted`/`running` own an
 * addressable engine task. `ingesting` is deliberately excluded: once ingest
 * wins that conditional transition, evidence/media settlement owns the row
 * and cancellation must retry after the job reaches a cancellable/terminal
 * state instead of releasing claims underneath evidence writes. */
export const CANCELLABLE_SIM_JOB_STATUSES = [
  "pending",
  "submitted",
  "running",
] as const;

export type SimJobCancellationClaim =
  | { kind: "cancelled"; jobId: string; engineJobId: string | null }
  | { kind: "not_cancellable"; status: string | null };

/** Atomically claim admin cancellation and release only claims owned by the
 * won status transition. PostgreSQL rechecks the status predicate after a
 * concurrent ingest transition, so cancel-vs-ingest has exactly one winner. */
export async function claimSimJobCancellation(
  db: DB,
  jobId: string,
  reason: string,
): Promise<SimJobCancellationClaim> {
  const outcome = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [claimed] = await tx
      .update(simJobs)
      .set({
        status: "cancelled",
        // Persist the engine-side cancellation obligation before the API call.
        // Pending compositions have no external task; submitted/running rows
        // remain independently retryable after API process death.
        engineState: sql`CASE WHEN ${simJobs.engineJobId} IS NULL THEN 'cancelled' ELSE 'cancelling' END`,
        finishedAt: new Date(),
        error: reason,
      })
      .where(
        and(
          eq(simJobs.id, jobId),
          inArray(simJobs.status, [...CANCELLABLE_SIM_JOB_STATUSES]),
        ),
      )
      .returning();
    if (claimed) {
      await releaseResultClaimsForJob(tx, jobId, ["queued", "running"]);

      // An explicit admin cancellation owns the linked ladder work item too.
      // Settle it in this same transaction so an API-process death before the
      // engine cancel call cannot let the orphan healer resurrect user-cancelled
      // URANS/verification work as pending.
      const payload = (claimed.requestPayload ?? {}) as {
        uransRequestId?: unknown;
        verifyQueueItemId?: unknown;
      };
      if (typeof payload.uransRequestId === "string") {
        const cancelledOwner = await tx
          .update(simUransRequests)
          .set({ state: "cancelled", simJobId: claimed.id })
          .where(
            and(
              eq(simUransRequests.id, payload.uransRequestId),
              eq(simUransRequests.state, "running"),
              eq(simUransRequests.simJobId, claimed.id),
            ),
          )
          .returning({ id: simUransRequests.id });
        if (cancelledOwner.length) {
          await tx.execute(sql`
            DELETE FROM sim_ladder_submit_retries
            WHERE urans_request_id = ${payload.uransRequestId}
              AND (latest_sim_job_id IS NULL OR latest_sim_job_id = ${claimed.id})
          `);
        }
      }
      if (typeof payload.verifyQueueItemId === "string") {
        const cancelledOwner = await tx
          .update(simUransVerifyQueue)
          .set({ state: "cancelled", simJobId: null })
          .where(
            and(
              eq(simUransVerifyQueue.id, payload.verifyQueueItemId),
              eq(simUransVerifyQueue.state, "running"),
              eq(simUransVerifyQueue.simJobId, claimed.id),
              sql`NOT EXISTS (
                SELECT 1 FROM sim_ladder_submit_retries submit_retry
                WHERE submit_retry.verify_queue_id = ${simUransVerifyQueue.id}
                  AND submit_retry.latest_sim_job_id IS DISTINCT FROM ${claimed.id}
              )`,
            ),
          )
          .returning({ id: simUransVerifyQueue.id });
        if (cancelledOwner.length) {
          await tx.execute(sql`
            DELETE FROM sim_ladder_submit_retries
            WHERE verify_queue_id = ${payload.verifyQueueItemId}
              AND (latest_sim_job_id IS NULL OR latest_sim_job_id = ${claimed.id})
          `);
        }
      }
      const settlement = await settlePrecalcObligationsForJobInTransaction(
        tx,
        claimed,
        { terminalError: reason, cancellation: "explicit" },
      );
      return {
        claim: {
          kind: "cancelled" as const,
          jobId: claimed.id,
          engineJobId: claimed.engineJobId,
        },
        campaignIds: settlement.campaignIds,
      };
    }

    const [existing] = await tx
      .select({ status: simJobs.status })
      .from(simJobs)
      .where(eq(simJobs.id, jobId))
      .limit(1);
    return {
      claim: {
        kind: "not_cancellable" as const,
        status: existing?.status ?? null,
      },
      campaignIds: [] as string[],
    };
  });
  await refreshPrecalcSettlementCampaigns(db, outcome.campaignIds);
  return outcome.claim;
}
