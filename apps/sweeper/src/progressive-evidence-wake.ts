import { sql } from "drizzle-orm";
import { workerReportWithoutStagingProof } from "./progressive-staging-selection";
import { progressiveDiagnosticRetrySql } from "./progressive-delivery-selection";

export type ProgressiveEvidenceWakeScope = "staging" | "delivery";

function stagingWakeSource(ready: boolean) {
  // Once the ready search is empty, an eligible report can only be waiting on
  // its exact retry or its job's lease. Include deadlines that cross during
  // this statement. The final ownership and receipt checks still apply.
  const reports = ready ? sql`progressive_worker_staging_candidates` : sql`(
    SELECT k.sim_job_id,k.sequence FROM progressive_worker_staging_failures blocker
    JOIN progressive_worker_staging_candidates k USING(sim_job_id,sequence)
    WHERE blocker.retry_after IS NULL OR blocker.retry_after>=statement_timestamp()
    UNION ALL
    SELECT k.sim_job_id,k.sequence FROM sim_jobs owner
    JOIN progressive_worker_staging_candidates k ON k.sim_job_id=owner.id
    WHERE owner.ingest_lease_token IS NOT NULL AND owner.ingest_lease_expires_at>=statement_timestamp()
  )`;
  return sql`SELECT report.sim_job_id, failure.retry_after, NULL::timestamptz AS claim_until
    FROM ${reports} report
    LEFT JOIN progressive_worker_staging_failures failure
      ON failure.sim_job_id=report.sim_job_id AND failure.sequence=report.sequence
    WHERE ${workerReportWithoutStagingProof}
      AND NOT EXISTS (SELECT 1 FROM progressive_worker_report_conflicts conflict
        WHERE conflict.sim_job_id=report.sim_job_id AND conflict.sequence=report.sequence)
      ${ready ? sql`AND (failure.sim_job_id IS NULL OR failure.retry_after<=clock_timestamp())` : sql``}
    OFFSET 0`;
}

function deliveryWakeSource(ready: boolean) {
  const undelivered = sql`NOT EXISTS (SELECT 1 FROM progressive_worker_hub_receipts delivered
    WHERE delivered.sim_job_id=a.sim_job_id AND delivered.point_content_signature=a.point_content_signature)`;
  const membership = sql`JOIN progressive_worker_evidence_receipts staged
      ON staged.sim_job_id=a.sim_job_id AND staged.sequence=a.sequence
    JOIN progressive_worker_staging_candidates report
      ON report.sim_job_id=a.sim_job_id AND report.sequence=a.sequence
    WHERE NOT EXISTS (SELECT 1 FROM progressive_worker_report_conflicts conflict
      WHERE conflict.sim_job_id=a.sim_job_id AND conflict.sequence=a.sequence)`;
  // Deadlines depend on the point, attempt and owner. Repeated signed reports
  // still need a qualifying sequence; their shared attempt needs one check.
  const bindings = ready
    ? sql`SELECT a.sim_job_id,a.sequence,a.point_content_signature,a.result_attempt_id,report.created_at
        FROM progressive_worker_evidence_attempts a ${membership} AND ${undelivered}`
    : sql`WITH outstanding AS MATERIALIZED (
        SELECT a.sim_job_id,a.sequence,a.point_content_signature,a.result_attempt_id
        FROM progressive_worker_evidence_attempts a WHERE ${undelivered})
      SELECT DISTINCT a.sim_job_id,a.point_content_signature,a.result_attempt_id
      FROM outstanding a ${membership}`;
  return sql`SELECT association.sim_job_id, failure.retry_after,
      CASE WHEN claim.claim_token IS NOT NULL THEN claim.claim_expires_at END AS claim_until
    FROM (${bindings}) association
    JOIN result_attempts attempt ON attempt.id=association.result_attempt_id
      AND attempt.sim_job_id=association.sim_job_id AND attempt.engine_job_id=association.sim_job_id::text
    LEFT JOIN progressive_worker_delivery_failures failure
      ON failure.sim_job_id=association.sim_job_id AND failure.point_content_signature=association.point_content_signature
    LEFT JOIN progressive_worker_evidence_delivery_claims claim
      ON claim.sim_job_id=association.sim_job_id AND claim.point_content_signature=association.point_content_signature
    WHERE attempt.result_id IS NOT NULL
      AND (failure.sim_job_id IS NULL OR failure.state='retry' OR ${progressiveDiagnosticRetrySql("failure", "attempt")})
      AND (claim.claim_token IS NULL OR claim.claim_expires_at IS NOT NULL)
      ${ready ? sql`AND (failure.sim_job_id IS NULL OR failure.retry_after<=clock_timestamp())
        AND (claim.claim_token IS NULL OR claim.claim_expires_at<=clock_timestamp())
        ORDER BY association.created_at,association.sim_job_id,association.sequence,association.result_attempt_id` : sql``}
    OFFSET 0`;
}

function wakeQuery(scope: ProgressiveEvidenceWakeScope, ready: boolean) {
  const source = scope === "staging" ? stagingWakeSource(ready) : deliveryWakeSource(ready);
  const ownership = sql`SELECT job.ingest_lease_token, job.ingest_lease_expires_at
    FROM sim_jobs job
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE job.id = candidate.sim_job_id
      AND NOT settings.remote_solver_transfer_paused AND settings.remote_solver_auth_token <> ''
      AND settings.upstream_base_url IS NOT NULL AND job.request_payload->>'remoteSolver' = 'true'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND promise.source_base_url = settings.upstream_base_url
      AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
      ${scope === "staging" ? sql`AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at IS NOT NULL)` : sql``}
    OFFSET 0`;
  const deadline = sql`greatest(
    coalesce(candidate.retry_after, clock_timestamp()),
    coalesce(${scope === "staging" ? sql`CASE WHEN owned.ingest_lease_token IS NOT NULL THEN owned.ingest_lease_expires_at END` : sql`candidate.claim_until`}, clock_timestamp())
  )`;
  return ready
    ? sql`SELECT clock_timestamp() AS wake_at FROM (${source}) candidate
      JOIN LATERAL (${ownership}) owned ON true
      ${scope === "staging" ? sql`WHERE owned.ingest_lease_token IS NULL OR owned.ingest_lease_expires_at <= clock_timestamp()` : sql``}
      LIMIT 1`
    : sql`SELECT min(greatest(${deadline}, clock_timestamp())) AS wake_at FROM (${source}) candidate
      JOIN LATERAL (${ownership}) owned ON true`;
}

export function progressiveEvidenceWakeSql(scope: ProgressiveEvidenceWakeScope, ready: boolean) {
  // A runnable staging report supplies the minimum immediately. Both branches
  // see one snapshot, including a receipt, new retry, or lease change.
  if (scope === "staging" && !ready)
    return sql`SELECT coalesce((${wakeQuery(scope, true)}),(${wakeQuery(scope, false)})) AS wake_at`;
  return wakeQuery(scope, ready);
}
