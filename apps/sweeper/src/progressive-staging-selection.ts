import { sql } from "drizzle-orm";

export function progressiveStagingSelectionSql(preferActive: boolean) {
  const reportOrder = (active: boolean) => {
    const direction = active ? sql`DESC` : sql`ASC`;
    return sql`ORDER BY report.created_at ${direction}, report.sim_job_id ${direction}, report.sequence ${direction}`;
  };
  const order = (active: boolean) => {
    const direction = active ? sql`DESC` : sql`ASC`;
    return sql`ORDER BY CASE WHEN NOT ${active}
        AND promise_status IN ('expired', 'cancelled', 'fulfilled')
        AND is_terminal THEN 0 ELSE 1 END,
      created_at ${direction}, sim_job_id ${direction}, sequence ${direction}`;
  };
  const reports = (
    active: boolean,
  ) => sql`SELECT report.sim_job_id, report.sequence, report.created_at,
      report#>>'{stopProof,execution_stopped}' = 'true' AS is_terminal
    FROM progressive_worker_reports report
    LEFT JOIN progressive_worker_staging_failures failure ON failure.sim_job_id = report.sim_job_id AND failure.sequence = report.sequence
    WHERE report.acknowledged_at IS NOT NULL AND jsonb_typeof(report.report->'result') = 'object'
      AND (failure.sim_job_id IS NULL OR failure.retry_after <= clock_timestamp())
      AND NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts receipt
        WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence)
    ${reportOrder(active)} OFFSET 0`;
  const owned = (active: boolean) => sql`SELECT job.id, promise.status AS promise_status FROM sim_jobs job
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE job.id = report.sim_job_id AND NOT settings.remote_solver_transfer_paused AND settings.remote_solver_auth_token <> ''
      AND settings.upstream_base_url IS NOT NULL AND job.request_payload->>'remoteSolver' = 'true'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND promise.source_base_url = settings.upstream_base_url
      AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
      AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())
      AND (${!active} OR (promise.status = 'active' AND promise."expiresAt" > clock_timestamp())) OFFSET 0`;
  const candidate = (
    active: boolean,
  ) => sql`SELECT report.sim_job_id, report.sequence, report.created_at, report.is_terminal,
      owned.promise_status FROM (${reports(active)}) report
    JOIN LATERAL (${owned(active)}) owned ON true`;
  if (!preferActive)
    return sql`SELECT sim_job_id, sequence, created_at FROM (${candidate(false)}) report
      ${order(false)} LIMIT 1`;
  return sql`WITH active AS MATERIALIZED (
    ${candidate(true)} ${order(true)} LIMIT 1
  ), fallback AS (
    ${candidate(false)} WHERE NOT EXISTS (SELECT 1 FROM active) ${order(false)} LIMIT 1
  ) SELECT sim_job_id, sequence, created_at FROM active
    UNION ALL SELECT sim_job_id, sequence, created_at FROM fallback`;
}
