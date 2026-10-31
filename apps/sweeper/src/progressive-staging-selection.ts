import { sql } from "drizzle-orm";

export function progressiveStagingSelectionSql(preferActive: boolean) {
  const ownedJobs = sql`SELECT job.id, promise.status, promise."expiresAt" AS expires_at
    FROM sim_jobs job
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE NOT settings.remote_solver_transfer_paused AND settings.remote_solver_auth_token <> ''
      AND settings.upstream_base_url IS NOT NULL AND job.request_payload->>'remoteSolver' = 'true'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND promise.source_base_url = settings.upstream_base_url
      AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
      AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())`;
  const report = (active: boolean, terminalOnly: boolean) => {
    const direction = active ? sql`DESC` : sql`ASC`;
    return sql`SELECT report.sim_job_id, report.sequence, report.created_at
      FROM progressive_worker_reports report
      LEFT JOIN progressive_worker_staging_failures failure
        ON failure.sim_job_id = report.sim_job_id AND failure.sequence = report.sequence
      WHERE report.sim_job_id = owned.id
        AND report.acknowledged_at IS NOT NULL
        AND jsonb_typeof(report.report->'result') = 'object'
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_report_conflicts conflict
          WHERE conflict.sim_job_id = report.sim_job_id AND conflict.sequence = report.sequence)
        AND (failure.sim_job_id IS NULL OR failure.retry_after <= clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts receipt
          WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence)
        ${terminalOnly ? sql`AND report.stopped_engine_job_id = report.sim_job_id::text` : sql``}
      ORDER BY report.created_at ${direction}, report.sequence ${direction}
      LIMIT 1`;
  };
  const candidate = (active: boolean, terminalOnly: boolean) => {
    const direction = active ? sql`DESC` : sql`ASC`;
    if (terminalOnly)
      return sql`SELECT terminal.sim_job_id, terminal.sequence, terminal.created_at
        FROM owned_jobs owned
        CROSS JOIN LATERAL (${report(active, true)}) terminal
        WHERE ${active ? sql`owned.status = 'active' AND owned.expires_at > clock_timestamp()` : sql`true`}
        ORDER BY terminal.created_at ${direction}, terminal.sim_job_id ${direction}, terminal.sequence ${direction}
        LIMIT 1`;
    if (!active)
      return sql`SELECT fallback.sim_job_id, fallback.sequence, fallback.created_at
        FROM owned_jobs owned
        CROSS JOIN LATERAL (${report(false, false)}) fallback
        ORDER BY fallback.created_at ASC, fallback.sim_job_id ASC, fallback.sequence ASC
        LIMIT 1`;
    return sql`SELECT COALESCE(terminal.sim_job_id, fallback.sim_job_id) AS sim_job_id,
        COALESCE(terminal.sequence, fallback.sequence) AS sequence,
        COALESCE(terminal.created_at, fallback.created_at) AS created_at
      FROM owned_jobs owned
      LEFT JOIN LATERAL (${report(true, true)}) terminal ON true
      LEFT JOIN LATERAL (${report(true, false)}) fallback ON terminal.sim_job_id IS NULL
      WHERE owned.status = 'active' AND owned.expires_at > clock_timestamp()
        AND (terminal.sim_job_id IS NOT NULL OR fallback.sim_job_id IS NOT NULL)
      ORDER BY (terminal.sim_job_id IS NOT NULL) DESC,
        COALESCE(terminal.created_at, fallback.created_at) DESC,
        COALESCE(terminal.sim_job_id, fallback.sim_job_id) DESC,
        COALESCE(terminal.sequence, fallback.sequence) DESC
      LIMIT 1`;
  };
  const terminal = candidate(false, true);
  const fallback = candidate(false, false);
  if (!preferActive)
    return sql`WITH owned_jobs AS MATERIALIZED (${ownedJobs}),
        terminal AS MATERIALIZED (${terminal}), fallback AS MATERIALIZED (${fallback})
      SELECT sim_job_id, sequence, created_at FROM terminal
      UNION ALL SELECT sim_job_id, sequence, created_at FROM fallback
      WHERE NOT EXISTS (SELECT 1 FROM terminal)`;
  const active = candidate(true, false);
  return sql`WITH owned_jobs AS MATERIALIZED (${ownedJobs}),
    active AS MATERIALIZED (${active}), terminal AS MATERIALIZED (${terminal}),
    fallback AS MATERIALIZED (${fallback})
  SELECT sim_job_id, sequence, created_at FROM active
  UNION ALL SELECT sim_job_id, sequence, created_at FROM terminal
    WHERE NOT EXISTS (SELECT 1 FROM active)
  UNION ALL SELECT sim_job_id, sequence, created_at FROM fallback
    WHERE NOT EXISTS (SELECT 1 FROM active) AND NOT EXISTS (SELECT 1 FROM terminal)`;
}
