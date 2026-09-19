import { sql } from "drizzle-orm";

export function progressivePublicationSelectionSql() {
  return sql`
    WITH settings AS MATERIALIZED (
      SELECT remote_solver_registered_id,upstream_base_url FROM sync_api_settings
      WHERE id = 1 AND NOT remote_solver_transfer_paused
        AND remote_solver_auth_token <> '' AND upstream_base_url IS NOT NULL
    )
      SELECT report.sim_job_id FROM progressive_worker_reports report
      WHERE report.acknowledged_at IS NULL
        AND report.report->>'solverId' = (SELECT remote_solver_registered_id::text FROM settings)
        AND (SELECT true FROM sim_jobs job CROSS JOIN settings
          JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
          WHERE job.id = report.sim_job_id
            AND promise.registered_solver_id = settings.remote_solver_registered_id
            AND promise.source_base_url = settings.upstream_base_url
            AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
            AND job.request_payload->>'remoteSolver' = 'true'
        ) IS TRUE
      ORDER BY report.created_at, report.sim_job_id, report.sequence LIMIT 1
  `;
}
