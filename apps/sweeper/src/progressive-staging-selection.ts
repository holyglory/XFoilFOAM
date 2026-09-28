import { sql } from "drizzle-orm";

export function progressiveStagingSelectionSql(preferActive: boolean) {
  const reportOrder = (active: boolean) => {
    const direction = active ? sql`DESC` : sql`ASC`;
    return sql`ORDER BY report.created_at ${direction}, report.sim_job_id ${direction}, report.sequence ${direction}`;
  };
  const order = (active: boolean) => {
    const direction = active ? sql`DESC` : sql`ASC`;
    return sql`ORDER BY created_at ${direction}, sim_job_id ${direction}, sequence ${direction}`;
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
  const terminalReports = sql`SELECT report.sim_job_id, report.sequence, report.created_at,
      true AS is_terminal
    FROM progressive_worker_reports report
    WHERE report.acknowledged_at IS NOT NULL
      AND jsonb_typeof(report.report->'result') = 'object'
      AND report.stopped_engine_job_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM progressive_worker_staging_failures failure
        WHERE failure.sim_job_id = report.sim_job_id AND failure.sequence = report.sequence
          AND failure.retry_after > clock_timestamp())
      AND NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts receipt
        WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence)
    ORDER BY report.created_at, report.sim_job_id, report.sequence OFFSET 0`;
  const owned = (active: boolean) => sql`SELECT job.id, promise.status AS promise_status
    FROM sim_jobs job
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE job.id = report.sim_job_id AND NOT settings.remote_solver_transfer_paused AND settings.remote_solver_auth_token <> ''
      AND settings.upstream_base_url IS NOT NULL AND job.request_payload->>'remoteSolver' = 'true'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND promise.source_base_url = settings.upstream_base_url
      AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
      AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())
      AND (${!active} OR (promise.status = 'active' AND promise."expiresAt" > clock_timestamp())) OFFSET 0`;
  const activeOwned = sql`SELECT job.id
    FROM sim_jobs job
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE NOT settings.remote_solver_transfer_paused AND settings.remote_solver_auth_token <> ''
      AND settings.upstream_base_url IS NOT NULL AND job.request_payload->>'remoteSolver' = 'true'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND promise.source_base_url = settings.upstream_base_url
      AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
      AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())
      AND promise.status = 'active' AND promise."expiresAt" > clock_timestamp()`;
  const activeCandidate = sql`SELECT report.sim_job_id, report.sequence, report.created_at
    FROM (${activeOwned}) owned
    JOIN progressive_worker_reports report ON report.sim_job_id = owned.id
    LEFT JOIN progressive_worker_staging_failures failure
      ON failure.sim_job_id = report.sim_job_id AND failure.sequence = report.sequence
    WHERE report.acknowledged_at IS NOT NULL
      AND jsonb_typeof(report.report->'result') = 'object'
      AND (failure.sim_job_id IS NULL OR failure.retry_after <= clock_timestamp())
      AND NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts receipt
        WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence)
    ORDER BY report.created_at DESC, report.sim_job_id DESC, report.sequence DESC
    LIMIT 1`;
  const candidate = (
    active: boolean,
  ) => sql`SELECT report.sim_job_id, report.sequence, report.created_at, report.is_terminal,
      owned.promise_status FROM (${reports(active)}) report
    JOIN LATERAL (${owned(active)}) owned ON true`;
  const terminalCandidate = sql`SELECT report.sim_job_id, report.sequence, report.created_at
    FROM (${terminalReports}) report
    JOIN LATERAL (${owned(false)}) owned ON true
    WHERE owned.promise_status IN ('expired', 'cancelled', 'fulfilled')
    ORDER BY report.created_at, report.sim_job_id, report.sequence LIMIT 1`;
  const terminal = sql`SELECT sim_job_id, sequence, created_at
    FROM (${terminalCandidate}) report`;
  if (!preferActive)
    return sql`WITH terminal AS MATERIALIZED (${terminal}), fallback AS MATERIALIZED (
        SELECT sim_job_id, sequence, created_at FROM (${candidate(false)}) report
        ${order(false)} LIMIT 1
      )
      SELECT sim_job_id, sequence, created_at FROM terminal
      UNION ALL SELECT sim_job_id, sequence, created_at FROM fallback
      WHERE NOT EXISTS (SELECT 1 FROM terminal)`;
  return sql`WITH active AS MATERIALIZED (
    ${activeCandidate}
  ), terminal AS MATERIALIZED (${terminal}), fallback AS MATERIALIZED (
    ${candidate(false)} ${order(false)} LIMIT 1
  )
  SELECT sim_job_id, sequence, created_at FROM active
  UNION ALL SELECT sim_job_id, sequence, created_at FROM terminal
    WHERE NOT EXISTS (SELECT 1 FROM active)
  UNION ALL SELECT sim_job_id, sequence, created_at FROM fallback
    WHERE NOT EXISTS (SELECT 1 FROM active) AND NOT EXISTS (SELECT 1 FROM terminal)`;
}
