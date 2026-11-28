import type { DB } from "@aerodb/db";
import { sql } from "drizzle-orm";
import { progressiveStoppedStorageEligible } from "./progressive-stopped-storage";

const pageSize = 8;
const positions = new WeakMap<DB, { job: string; signature: string }>();

// The error code selects candidates. Only the registered worker, an actual
// expired promise, the exact staged source and the native stop authorize retry.
const closedScopeFailure = sql`failure.state='conflict' AND failure.last_http_status=409
  AND failure.attempt_count < 5 AND failure.remote_conflict_ids='[]'::jsonb
  AND (starts_with(failure.last_error,'Progressive evidence delivery failed (409): progressive_scope_closed ')
    OR starts_with(failure.last_error,'Progressive evidence delivery failed (409): promise_inactive '))`;

export async function requeueExpiredProgressiveDeliveries(db: DB): Promise<number> {
  const after = positions.get(db);
  const candidates = await db.execute(sql`
    SELECT failure.sim_job_id, failure.point_content_signature
    FROM progressive_worker_delivery_failures failure WHERE ${closedScopeFailure}
      ${after ? sql`AND (failure.sim_job_id, failure.point_content_signature) >
        (${after.job}::uuid, ${after.signature})` : sql``}
    ORDER BY failure.sim_job_id, failure.point_content_signature LIMIT ${pageSize}`);
  let requeued = 0;
  for (const candidate of candidates) {
    const job = String(candidate.sim_job_id);
    const signature = String(candidate.point_content_signature);
    // A refused or busy source must not hide later jobs on every poll.
    positions.set(db, { job, signature });
    requeued += await db.transaction(async transaction => {
      const connection = transaction as unknown as DB;
      const [held] = await connection.execute(sql`
        SELECT failure.sequence, failure.result_attempt_id, attempt.status
        FROM progressive_worker_delivery_failures failure
        JOIN result_attempts attempt ON attempt.id=failure.result_attempt_id
          AND attempt.sim_job_id=failure.sim_job_id
        JOIN sim_jobs job ON job.id=failure.sim_job_id
        JOIN sync_sweep_promises promise ON promise.id::text=job.request_payload->>'syncPromiseId'
        JOIN progressive_worker_submission_intents permit ON permit.sim_job_id=job.id
          AND permit.authorization->>'kind'='authorized'
          AND permit.authorization->>'executionId'=job.id::text
          AND permit.authorization->>'contentSignature'=permit.assignment_signature
          AND permit.assignment_signature=job.request_payload#>>'{remoteProgressiveExecution,contentSignature}'
        WHERE ${closedScopeFailure} AND failure.sim_job_id=${job}::uuid
          AND failure.point_content_signature=${signature} AND promise.status='expired'
          AND promise."expiresAt" <= clock_timestamp()
          AND NOT EXISTS (SELECT FROM progressive_worker_hub_receipts receipt
            WHERE receipt.sim_job_id=failure.sim_job_id AND receipt.point_content_signature=failure.point_content_signature)
          AND NOT EXISTS (SELECT FROM progressive_worker_evidence_delivery_claims claim
            WHERE claim.sim_job_id=failure.sim_job_id AND claim.point_content_signature=failure.point_content_signature
              AND claim.claim_expires_at > clock_timestamp())
        FOR UPDATE OF failure SKIP LOCKED FOR SHARE OF job, promise, permit, attempt SKIP LOCKED`);
      if (!held) return 0;
      const point = {
        resultAttemptId: String(held.result_attempt_id),
        sequence: Number(held.sequence),
        pointContentSignature: signature,
      };
      const mode = held.status === "failed" ? "failed" : "expired-measured";
      if (!await progressiveStoppedStorageEligible(connection, job, point, mode)) return 0;
      const changed = await connection.execute(sql`
        UPDATE progressive_worker_delivery_failures failure
        SET state='retry', retry_after=clock_timestamp(), updated_at=clock_timestamp(),
          last_error='Expired assignment retained-source storage retry queued'
        WHERE ${closedScopeFailure} AND sim_job_id=${job}::uuid
          AND point_content_signature=${signature} AND sequence=${point.sequence}
          AND result_attempt_id=${point.resultAttemptId}::uuid RETURNING sim_job_id`);
      return changed.length;
    });
  }
  if (candidates.length < pageSize) positions.delete(db);
  return requeued;
}
