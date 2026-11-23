import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import {
  analysisContentHash, verifyProgressiveEvidenceCustodyReceipt,
  type DB, type ProgressiveEvidenceCustodyReceipt,
} from "@aerodb/db";
import { sql } from "drizzle-orm";
import { preflightProgressiveArchive } from "./progressive-archive-reclaim";

type RetryTarget = {
  jobId: string;
  pointSignature: string;
  uploadId: string;
  attemptCount: number;
};

/** Bring one deferred queue entry forward after an authenticated complete read.
 * The normal claim service retains exclusive ownership of filesystem reclamation.
 */
export async function recheckDeferredProgressiveArchive(db: DB, target: RetryTarget, signal: AbortSignal) {
  const pending = sql`SELECT q.retry_after::text AS retry, q.last_error, ar.receipt AS signed,
    h.result_attempt_id::text AS attempt, h.receipt->>'resultAttemptId' AS canonical_attempt,
    sp.id::text AS promise, s.remote_solver_registered_id::text AS solver, s.remote_solver_auth_token AS token,
    s.upstream_base_url AS base
    FROM progressive_worker_archive_reclaims q JOIN progressive_worker_archive_receipts ar USING(sim_job_id,point_content_signature)
    JOIN progressive_worker_hub_receipts h USING(sim_job_id,point_content_signature)
    JOIN sim_jobs j ON j.id=q.sim_job_id AND j.engine_job_id=j.id::text
    JOIN sync_sweep_promises sp ON sp.id::text=j.request_payload->>'syncPromiseId'
    JOIN sync_api_settings s ON s.id=1 AND sp.registered_solver_id=s.remote_solver_registered_id AND sp.source_base_url=s.upstream_base_url
    WHERE q.sim_job_id=${target.jobId}::uuid AND q.point_content_signature=${target.pointSignature}
      AND ar.brokered_upload_id=${target.uploadId}::uuid AND q.attempt_count=${target.attemptCount}
      AND q.completed_at IS NULL AND q.claim_token IS NULL AND q.claim_expires_at IS NULL AND q.retry_after>clock_timestamp()
      AND q.last_error IN ('Progressive archive readback returned HTTP 503','Registered archive admission remains busy (HTTP 503)')
      AND j.status IN ('cancelled','done','failed') AND (j.ingest_lease_expires_at IS NULL OR j.ingest_lease_expires_at<=clock_timestamp())
      AND j.request_payload?'remoteProgressiveExecution' AND j.request_payload->>'upstreamBaseUrl'=s.upstream_base_url
      AND NOT s.remote_solver_transfer_paused AND s.remote_solver_auth_token<>''
      AND EXISTS(SELECT FROM progressive_worker_reports wr WHERE wr.sim_job_id=j.id AND wr.stopped_engine_job_id=j.engine_job_id)
      AND NOT EXISTS(SELECT FROM sync_remote_hub_binding_receipts l WHERE l.result_attempt_id=h.result_attempt_id)`;
  const rows = await db.execute(pending);
  if (!rows.length) return { status: "unchanged" } as const;
  if (rows.length !== 1) throw Error("Ambiguous registered point retry");
  const row = rows[0]!;
  const signed = row.signed as {receipt: ProgressiveEvidenceCustodyReceipt; receiptHmac: string};
  const result = verifyProgressiveEvidenceCustodyReceipt(signed, String(row.token), signed.receipt);
  if (result.source.engineJobId !== target.jobId || result.brokeredUploadId !== target.uploadId ||
      result.source.solverId !== row.solver || result.source.promiseId !== row.promise ||
      result.source.remoteResultAttemptId !== row.attempt || result.canonical.resultAttemptId !== row.canonical_attempt ||
      result.source.progressiveEvidence.pointContentSignature !== target.pointSignature)
    throw Error("Registered retry differs from its signed point owner");
  const base = canonicalRemoteHubBaseUrl(String(row.base));
  const url = new URL(`/api/sync/v1/evidence-uploads/${target.uploadId}/download`, base);
  await preflightProgressiveArchive(url.toString(), String(row.token), result.remote, signal);
  const moved = await db.transaction(async (tx) => {
    signal.throwIfAborted();
    const locked = await tx.execute(sql`${pending} FOR UPDATE OF q SKIP LOCKED`);
    if (locked.length !== 1 || analysisContentHash(locked[0]) !== analysisContentHash(row)) return false;
    const updated = await tx.execute(sql`UPDATE progressive_worker_archive_reclaims SET retry_after=clock_timestamp()
      WHERE sim_job_id=${target.jobId}::uuid AND point_content_signature=${target.pointSignature}
        AND attempt_count=${target.attemptCount} AND completed_at IS NULL AND claim_token IS NULL
      RETURNING sim_job_id`);
    return updated.length === 1;
  });
  return {
    status: moved ? "rescheduled" as const : "unchanged" as const, uploadId: target.uploadId,
    generation: result.remote.generation, storedSha256: result.remote.storedSha256,
    storedByteSize: result.remote.storedByteSize, previousRetry: String(row.retry),
  };
}
