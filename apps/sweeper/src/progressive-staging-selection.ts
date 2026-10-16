import { sql } from "drizzle-orm";

export function progressiveStagingSelectionSql(preferActive: boolean) {
  const order = (active: boolean, terminalFirst = false) => {
    const direction = active ? sql`DESC` : sql`ASC`;
    return terminalFirst
      ? sql`ORDER BY report.stopped_engine_job_id = report.sim_job_id::text DESC,
          report.created_at ${direction}, report.sim_job_id ${direction}, report.sequence ${direction}`
      : sql`ORDER BY report.created_at ${direction}, report.sim_job_id ${direction}, report.sequence ${direction}`;
  };
  const candidate = (
    active: boolean,
    terminalOnly = false,
    terminalFirst = terminalOnly,
  ) => sql`SELECT report.sim_job_id, report.sequence, report.created_at
    FROM progressive_worker_reports report
    JOIN sim_jobs job ON job.id = report.sim_job_id
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    LEFT JOIN progressive_worker_staging_failures failure ON failure.sim_job_id = report.sim_job_id AND failure.sequence = report.sequence
    WHERE NOT settings.remote_solver_transfer_paused AND settings.remote_solver_auth_token <> ''
      AND settings.upstream_base_url IS NOT NULL AND job.request_payload->>'remoteSolver' = 'true'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND promise.source_base_url = settings.upstream_base_url
      AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
      AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())
      AND (${!active} OR (promise.status = 'active' AND promise."expiresAt" > clock_timestamp()))
      AND report.acknowledged_at IS NOT NULL AND jsonb_typeof(report.report->'result') = 'object'
      AND NOT EXISTS (SELECT 1 FROM progressive_worker_report_conflicts conflict
        WHERE conflict.sim_job_id = report.sim_job_id AND conflict.sequence = report.sequence)
      AND (failure.sim_job_id IS NULL OR failure.retry_after <= clock_timestamp())
      AND NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts receipt
        WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence)
      AND (${!terminalOnly} OR report.stopped_engine_job_id = report.sim_job_id::text)
    ${order(active, terminalFirst)} LIMIT 1`;
  if (!preferActive)
    return sql`WITH terminal AS MATERIALIZED (${candidate(false, true)}),
        fallback AS MATERIALIZED (${candidate(false)})
      SELECT sim_job_id, sequence, created_at FROM terminal
      UNION ALL SELECT sim_job_id, sequence, created_at FROM fallback
      WHERE NOT EXISTS (SELECT 1 FROM terminal)`;
  return sql`WITH active AS MATERIALIZED (
    ${candidate(true, false, true)}
  ), terminal AS MATERIALIZED (${candidate(false, true)}),
    fallback AS MATERIALIZED (${candidate(false)})
  SELECT sim_job_id, sequence, created_at FROM active
  UNION ALL SELECT sim_job_id, sequence, created_at FROM terminal
    WHERE NOT EXISTS (SELECT 1 FROM active)
  UNION ALL SELECT sim_job_id, sequence, created_at FROM fallback
    WHERE NOT EXISTS (SELECT 1 FROM active) AND NOT EXISTS (SELECT 1 FROM terminal)`;
}
