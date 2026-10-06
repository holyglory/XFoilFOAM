import { sql } from "drizzle-orm";

export type ProgressiveEvidenceWakeScope = "staging" | "delivery";

export function progressiveEvidenceWakeSql(
  scope: ProgressiveEvidenceWakeScope,
  ready: boolean,
) {
  const source =
    scope === "staging"
      ? sql`SELECT report.sim_job_id, failure.retry_after, NULL::timestamptz AS claim_until
        FROM progressive_worker_reports report
        LEFT JOIN progressive_worker_staging_failures failure
          ON failure.sim_job_id = report.sim_job_id AND failure.sequence = report.sequence
        WHERE report.acknowledged_at IS NOT NULL AND jsonb_typeof(report.report->'result') = 'object'
          AND NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts staged
            WHERE staged.sim_job_id = report.sim_job_id AND staged.sequence = report.sequence)
          ${ready ? sql`AND (failure.sim_job_id IS NULL OR failure.retry_after <= clock_timestamp())` : sql``}
        ORDER BY report.created_at, report.sim_job_id, report.sequence OFFSET 0`
      : sql`SELECT association.sim_job_id, failure.retry_after,
          CASE WHEN claim.claim_token IS NOT NULL THEN claim.claim_expires_at END AS claim_until
        FROM progressive_worker_evidence_attempts association
        JOIN progressive_worker_evidence_receipts staged
          ON staged.sim_job_id = association.sim_job_id AND staged.sequence = association.sequence
        JOIN progressive_worker_reports report
          ON report.sim_job_id = association.sim_job_id AND report.sequence = association.sequence
        JOIN result_attempts attempt ON attempt.id = association.result_attempt_id
          AND attempt.sim_job_id = association.sim_job_id AND attempt.engine_job_id = association.sim_job_id::text
        LEFT JOIN progressive_worker_delivery_failures failure
          ON failure.sim_job_id = association.sim_job_id AND failure.point_content_signature = association.point_content_signature
        LEFT JOIN progressive_worker_evidence_delivery_claims claim
          ON claim.sim_job_id = association.sim_job_id AND claim.point_content_signature = association.point_content_signature
        WHERE report.acknowledged_at IS NOT NULL AND jsonb_typeof(report.report->'result') = 'object'
          AND attempt.result_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM progressive_worker_hub_receipts delivered
            WHERE delivered.sim_job_id = association.sim_job_id
              AND delivered.point_content_signature = association.point_content_signature)
          AND (failure.sim_job_id IS NULL OR failure.state = 'retry')
          AND (claim.claim_token IS NULL OR claim.claim_expires_at IS NOT NULL)
          ${
            ready
              ? sql`AND (failure.sim_job_id IS NULL OR failure.retry_after <= clock_timestamp())
            AND (claim.claim_token IS NULL OR claim.claim_expires_at <= clock_timestamp())`
              : sql``
          }
        ORDER BY report.created_at, association.sim_job_id, association.sequence, association.result_attempt_id OFFSET 0`;
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
  const deadline = sql`greatest(candidate.retry_after, ${scope === "staging" ? sql`CASE WHEN owned.ingest_lease_token IS NOT NULL THEN owned.ingest_lease_expires_at END` : sql`candidate.claim_until`})`;
  return ready
    ? sql`SELECT clock_timestamp() AS wake_at FROM (${source}) candidate
      JOIN LATERAL (${ownership}) owned ON true
      ${scope === "staging" ? sql`WHERE owned.ingest_lease_token IS NULL OR owned.ingest_lease_expires_at <= clock_timestamp()` : sql``}
      LIMIT 1`
    : sql`SELECT min(greatest(${deadline}, clock_timestamp())) AS wake_at FROM (${source}) candidate
      JOIN LATERAL (${ownership}) owned ON true`;
}
