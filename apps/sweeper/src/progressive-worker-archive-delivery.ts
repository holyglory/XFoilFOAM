import { randomUUID } from "node:crypto";
import type { DB } from "@aerodb/db";
import { sql } from "drizzle-orm";

const archiveCandidateScope = sql`
      FROM progressive_worker_hub_receipts retained
      JOIN result_attempts attempt ON attempt.id = retained.result_attempt_id AND attempt.sim_job_id = retained.sim_job_id
        AND attempt.engine_job_id = retained.sim_job_id::text
      JOIN sim_jobs job ON job.id = retained.sim_job_id
      JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
      JOIN sync_api_settings settings ON settings.id = 1
      LEFT JOIN progressive_worker_archive_receipts custody ON custody.sim_job_id = retained.sim_job_id
        AND custody.point_content_signature = retained.point_content_signature
      LEFT JOIN progressive_worker_archive_deliveries delivery ON delivery.sim_job_id = retained.sim_job_id
        AND delivery.point_content_signature = retained.point_content_signature
      WHERE custody.sim_job_id IS NULL AND attempt.result_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE
            WHEN jsonb_typeof(attempt.evidence_payload->'evidence_artifacts') = 'array'
              THEN attempt.evidence_payload->'evidence_artifacts' ELSE '[]'::jsonb END) artifact
          WHERE artifact->>'kind' = 'manifest'
        )
        AND NOT settings.remote_solver_transfer_paused
        AND settings.remote_solver_auth_token <> '' AND settings.upstream_base_url IS NOT NULL
        AND job.request_payload->>'remoteSolver' = 'true'
        AND job.request_payload->'remoteProgressiveExecution' IS NOT NULL
        AND promise.registered_solver_id = settings.remote_solver_registered_id
        AND promise.source_base_url = settings.upstream_base_url
        AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
        AND NOT EXISTS (SELECT 1 FROM result_classifications classification
          JOIN results selected ON selected.current_result_attempt_id = classification.result_attempt_id
          WHERE classification.result_attempt_id = attempt.id AND classification.state = 'accepted')
`;

export async function nextProgressiveArchiveWakeAt(
  db: DB,
): Promise<Date | null> {
  const [pending] = await db.execute(sql`
    SELECT min(greatest(delivery.claim_expires_at, delivery.retry_after)) AS wake_at
    ${archiveCandidateScope}
      AND (delivery.claim_expires_at > clock_timestamp() OR delivery.retry_after > clock_timestamp())
  `);
  return pending?.wake_at == null
    ? null
    : pending.wake_at instanceof Date
      ? pending.wake_at
      : new Date(String(pending.wake_at));
}

export type ProgressiveArchiveClaim = {
  executionId: string;
  pointContentSignature: string;
  resultAttemptId: string;
  token: string;
};

export async function claimProgressiveWorkerArchive(
  db: DB,
): Promise<ProgressiveArchiveClaim | null> {
  return db.transaction(async (transaction) => {
    const [source] = await transaction.execute(sql`
      SELECT retained.sim_job_id, retained.point_content_signature, retained.result_attempt_id
      ${archiveCandidateScope}
        AND (delivery.claim_expires_at IS NULL OR delivery.claim_expires_at <= clock_timestamp())
        AND (delivery.retry_after IS NULL OR delivery.retry_after <= clock_timestamp())
      ORDER BY coalesce(delivery.retry_after, retained.delivered_at), retained.delivered_at, retained.sim_job_id, retained.point_content_signature
      LIMIT 1 FOR UPDATE OF retained SKIP LOCKED
    `);
    if (!source) return null;
    const token = randomUUID();
    const acquired = await transaction.execute(sql`
      INSERT INTO progressive_worker_archive_deliveries(sim_job_id, point_content_signature, claim_token, claim_expires_at)
      VALUES (${source.sim_job_id}::uuid, ${source.point_content_signature}, ${token}::uuid, clock_timestamp() + interval '30 minutes')
      ON CONFLICT (sim_job_id, point_content_signature) DO UPDATE SET claim_token = EXCLUDED.claim_token,
        claim_expires_at = EXCLUDED.claim_expires_at, updated_at = clock_timestamp()
      WHERE (progressive_worker_archive_deliveries.claim_expires_at IS NULL OR progressive_worker_archive_deliveries.claim_expires_at <= clock_timestamp())
        AND (progressive_worker_archive_deliveries.retry_after IS NULL OR progressive_worker_archive_deliveries.retry_after <= clock_timestamp())
      RETURNING sim_job_id
    `);
    if (acquired.length !== 1) return null;
    return {
      executionId: String(source.sim_job_id),
      pointContentSignature: String(source.point_content_signature),
      resultAttemptId: String(source.result_attempt_id),
      token,
    };
  });
}

export async function renewProgressiveWorkerArchiveClaim(
  db: DB,
  claim: ProgressiveArchiveClaim,
) {
  const updated = await db.execute(sql`
    UPDATE progressive_worker_archive_deliveries SET claim_expires_at = clock_timestamp() + interval '30 minutes', updated_at = clock_timestamp()
    WHERE sim_job_id = ${claim.executionId}::uuid AND point_content_signature = ${claim.pointContentSignature}
      AND claim_token = ${claim.token}::uuid AND claim_expires_at > clock_timestamp() RETURNING sim_job_id
  `);
  if (updated.length !== 1)
    throw new Error("Progressive archive delivery lost its source claim");
}

export async function settleProgressiveWorkerArchiveClaim(
  db: DB,
  claim: ProgressiveArchiveClaim,
  error?: unknown,
) {
  if (error === undefined) {
    const removed = await db.execute(sql`
      DELETE FROM progressive_worker_archive_deliveries delivery
      WHERE delivery.sim_job_id = ${claim.executionId}::uuid AND delivery.point_content_signature = ${claim.pointContentSignature}
        AND delivery.claim_token = ${claim.token}::uuid
        AND EXISTS (SELECT 1 FROM progressive_worker_archive_receipts custody WHERE custody.sim_job_id = delivery.sim_job_id
          AND custody.point_content_signature = delivery.point_content_signature) RETURNING sim_job_id
    `);
    if (removed.length !== 1)
      throw new Error(
        "Progressive archive delivery has no owned custody receipt",
      );
    return;
  }
  await db.execute(sql`
    UPDATE progressive_worker_archive_deliveries delivery SET claim_token = NULL, claim_expires_at = NULL,
      attempt_count = attempt_count + 1,
      retry_after = clock_timestamp() + make_interval(secs => least(60, power(2, least(attempt_count + 1, 6)))::double precision),
      last_error = ${String(error instanceof Error ? error.message : error).slice(0, 700)}, updated_at = clock_timestamp()
    WHERE delivery.sim_job_id = ${claim.executionId}::uuid AND delivery.point_content_signature = ${claim.pointContentSignature}
      AND delivery.claim_token = ${claim.token}::uuid
      AND NOT EXISTS (SELECT 1 FROM progressive_worker_archive_receipts custody WHERE custody.sim_job_id = delivery.sim_job_id
        AND custody.point_content_signature = delivery.point_content_signature)
  `);
}
