import { sql } from "drizzle-orm";

export type ProgressivePublicationPass = "active" | "backlog";

function progressivePublicationHeadsSql() {
  // Probe worker custody first so a HUB with no worker jobs avoids the walk.
  // Then seek once per pending job in the (sim_job_id, sequence) index. Starting
  // from sim_jobs revisits every historical assignment on every publication;
  // DISTINCT ON reports instead walks every pending sequence of a large job.
  // Resolve the head before any ownership filter so a foreign head cannot be
  // skipped in favor of a later sequence.
  return sql`
    publication_worker AS MATERIALIZED (
      SELECT job.id FROM sim_jobs job CROSS JOIN settings
      WHERE job.request_payload->>'remoteSolver' = 'true'
        AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
      LIMIT 1
    ), pending_heads AS (
      (
        SELECT head.sim_job_id, head.sequence
        FROM progressive_worker_reports head
        WHERE head.acknowledged_at IS NULL
          AND EXISTS (SELECT 1 FROM publication_worker)
        ORDER BY head.sim_job_id, head.sequence LIMIT 1
      )
      UNION ALL
      SELECT next_head.sim_job_id, next_head.sequence
      FROM pending_heads previous
      CROSS JOIN LATERAL (
        SELECT head.sim_job_id, head.sequence
        FROM progressive_worker_reports head
        WHERE head.acknowledged_at IS NULL
          AND head.sim_job_id > previous.sim_job_id
        ORDER BY head.sim_job_id, head.sequence LIMIT 1
      ) next_head
    )
  `;
}

function progressivePublicationEligibleSql(lane: number, laneCount: number) {
  // Keep every metadata lookup correlated to the pending head. Without these
  // barriers the planner can scan retained jobs or every report for this
  // solver before joining the heads, even though only a few jobs have work.
  return sql`
    SELECT report.sim_job_id, report.created_at, report.sequence,
      (promise.status = 'active' AND promise."expiresAt" > clock_timestamp()
        AND job.status IN ('pending', 'submitted', 'running', 'ingesting')) AS active_lease
    FROM pending_heads head
    JOIN LATERAL (
      SELECT stored_job.status, stored_job.request_payload
      FROM sim_jobs stored_job
      WHERE stored_job.id = head.sim_job_id
      OFFSET 0
    ) job ON true
    JOIN LATERAL (
      SELECT stored_promise.status, stored_promise."expiresAt",
        stored_promise.registered_solver_id, stored_promise.source_base_url
      FROM sync_sweep_promises stored_promise
      WHERE stored_promise.id::text = job.request_payload->>'syncPromiseId'
      OFFSET 0
    ) promise ON true
    CROSS JOIN settings
    JOIN LATERAL (
      SELECT stored.sim_job_id, stored.created_at, stored.sequence,
        stored.report->>'solverId' AS solver_id
      FROM progressive_worker_reports stored
      WHERE stored.sim_job_id = head.sim_job_id
        AND stored.sequence = head.sequence
        AND stored.acknowledged_at IS NULL
      OFFSET 0
    ) report ON report.solver_id = settings.remote_solver_registered_id::text
    WHERE promise.registered_solver_id = settings.remote_solver_registered_id
      AND promise.source_base_url = settings.upstream_base_url
      AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
      AND job.request_payload->>'remoteSolver' = 'true'
      AND ${
        laneCount === 1
          ? sql`TRUE`
          : sql`mod((hashtext(head.sim_job_id::text)::bigint & 2147483647), ${laneCount}) = ${lane}`
      }
  `;
}

export function progressivePublicationSelectionSql(
  lane = 0,
  laneCount = 1,
  pass: ProgressivePublicationPass = "active",
) {
  if (
    !Number.isSafeInteger(lane) ||
    !Number.isSafeInteger(laneCount) ||
    laneCount < 1 ||
    lane < 0 ||
    lane >= laneCount
  )
    throw new Error("Progressive publication lane is out of range");
  return sql`
    WITH RECURSIVE settings AS MATERIALIZED (
      SELECT remote_solver_registered_id,upstream_base_url FROM sync_api_settings
      WHERE id = 1 AND NOT remote_solver_transfer_paused
        AND remote_solver_auth_token <> '' AND upstream_base_url IS NOT NULL
    ), ${progressivePublicationHeadsSql()}, eligible AS MATERIALIZED (
      ${progressivePublicationEligibleSql(lane, laneCount)}
    )
    SELECT sim_job_id FROM eligible
    ORDER BY ${pass === "active" ? sql`active_lease DESC,` : sql``}
      created_at, sim_job_id, sequence
    LIMIT 1
  `;
}

export function progressivePublicationBatchSelectionSql(limit = 32) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
    throw new Error("Progressive publication batch limit is out of range");
  return sql`
    WITH RECURSIVE settings AS MATERIALIZED (
      SELECT remote_solver_registered_id,upstream_base_url FROM sync_api_settings
      WHERE id = 1 AND NOT remote_solver_transfer_paused
        AND remote_solver_auth_token <> '' AND upstream_base_url IS NOT NULL
    ), ${progressivePublicationHeadsSql()}, eligible AS MATERIALIZED (
      ${progressivePublicationEligibleSql(0, 1)}
    )
    SELECT sim_job_id FROM eligible
    ORDER BY active_lease DESC, created_at, sim_job_id
    LIMIT ${limit}
  `;
}
