import { sql } from "drizzle-orm";

export function progressivePublicationSelectionSql(lane = 0, laneCount = 1) {
  if (
    !Number.isSafeInteger(lane) ||
    !Number.isSafeInteger(laneCount) ||
    laneCount < 1 ||
    lane < 0 ||
    lane >= laneCount
  )
    throw new Error("Progressive publication lane is out of range");
  return sql`
    WITH settings AS MATERIALIZED (
      SELECT remote_solver_registered_id,upstream_base_url FROM sync_api_settings
      WHERE id = 1 AND NOT remote_solver_transfer_paused
        AND remote_solver_auth_token <> '' AND upstream_base_url IS NOT NULL
    ), active_candidate AS MATERIALIZED (
      SELECT report.sim_job_id, report.created_at
      FROM sync_sweep_promises promise
      JOIN sim_jobs job ON job.request_payload->>'syncPromiseId' = promise.id::text
      CROSS JOIN settings
      JOIN LATERAL (
        SELECT report.sim_job_id, report.created_at
        FROM progressive_worker_reports report
        WHERE report.sim_job_id = job.id
          AND report.acknowledged_at IS NULL
          AND report.report->>'solverId' = settings.remote_solver_registered_id::text
        ORDER BY report.sequence
        LIMIT 1
      ) report ON TRUE
      WHERE promise.status = 'active' AND promise."expiresAt" > clock_timestamp()
        AND promise.registered_solver_id = settings.remote_solver_registered_id
        AND promise.source_base_url = settings.upstream_base_url
        AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
        AND job.request_payload->>'remoteSolver' = 'true'
        AND ${laneCount === 1 ? sql`TRUE` : sql`mod((hashtext(report.sim_job_id::text)::bigint & 2147483647), ${laneCount}) = ${lane}`}
      ORDER BY report.created_at, report.sim_job_id
      LIMIT 1
    ), fallback_candidate AS MATERIALIZED (
      SELECT report.sim_job_id, report.created_at, report.sequence
      FROM progressive_worker_reports report
      WHERE report.acknowledged_at IS NULL
        AND report.report->>'solverId' = (SELECT remote_solver_registered_id::text FROM settings)
        AND ${laneCount === 1 ? sql`TRUE` : sql`mod((hashtext(report.sim_job_id::text)::bigint & 2147483647), ${laneCount}) = ${lane}`}
        AND (SELECT true FROM sim_jobs job CROSS JOIN settings
          JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
          WHERE job.id = report.sim_job_id
            AND promise.registered_solver_id = settings.remote_solver_registered_id
            AND promise.source_base_url = settings.upstream_base_url
            AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
            AND job.request_payload->>'remoteSolver' = 'true'
        ) IS TRUE
      ORDER BY report.created_at, report.sim_job_id, report.sequence LIMIT 1
    )
    SELECT sim_job_id FROM active_candidate
    UNION ALL
    SELECT sim_job_id FROM fallback_candidate
    WHERE NOT EXISTS (SELECT 1 FROM active_candidate)
    LIMIT 1
  `;
}

export function progressivePublicationBatchSelectionSql(limit = 32) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
    throw new Error("Progressive publication batch limit is out of range");
  return sql`
    WITH settings AS MATERIALIZED (
      SELECT remote_solver_registered_id,upstream_base_url FROM sync_api_settings
      WHERE id = 1 AND NOT remote_solver_transfer_paused
        AND remote_solver_auth_token <> '' AND upstream_base_url IS NOT NULL
    ), eligible AS MATERIALIZED (
      SELECT DISTINCT ON (report.sim_job_id)
        report.sim_job_id,
        report.created_at,
        (promise.status = 'active' AND promise."expiresAt" > clock_timestamp()) AS active_lease
      FROM progressive_worker_reports report
      JOIN sim_jobs job ON job.id = report.sim_job_id
      JOIN sync_sweep_promises promise
        ON promise.id::text = job.request_payload->>'syncPromiseId'
      CROSS JOIN settings
      WHERE report.acknowledged_at IS NULL
        AND report.report->>'solverId' = settings.remote_solver_registered_id::text
        AND promise.registered_solver_id = settings.remote_solver_registered_id
        AND promise.source_base_url = settings.upstream_base_url
        AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
        AND job.request_payload->>'remoteSolver' = 'true'
      ORDER BY report.sim_job_id, report.sequence
    )
    SELECT sim_job_id FROM eligible
    ORDER BY active_lease DESC, created_at, sim_job_id
    LIMIT ${limit}
  `;
}
