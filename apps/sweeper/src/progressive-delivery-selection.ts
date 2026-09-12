import { sql } from "drizzle-orm";

export function progressiveDeliverySelectionSql(preferActive: boolean) {
  const points = sql`SELECT source.sim_job_id, source.sequence, source.result_attempt_id,
      source.point_content_signature, report.created_at, attempt.aoa_deg
    FROM progressive_worker_evidence_attempts source
    JOIN progressive_worker_reports report ON report.sim_job_id = source.sim_job_id AND report.sequence = source.sequence
    JOIN result_attempts attempt ON attempt.id = source.result_attempt_id AND attempt.sim_job_id = source.sim_job_id
      AND attempt.engine_job_id = source.sim_job_id::text
    LEFT JOIN progressive_worker_hub_receipts delivered ON delivered.sim_job_id = source.sim_job_id
      AND delivered.point_content_signature = source.point_content_signature
    LEFT JOIN progressive_worker_delivery_failures failure ON failure.sim_job_id = source.sim_job_id
      AND failure.point_content_signature = source.point_content_signature
    WHERE delivered.sim_job_id IS NULL AND report.acknowledged_at IS NOT NULL AND attempt.result_id IS NOT NULL
      AND (failure.sim_job_id IS NULL OR (failure.state = 'retry' AND failure.retry_after <= clock_timestamp()))
    ORDER BY report.created_at, source.sim_job_id, source.sequence, attempt.aoa_deg, source.result_attempt_id OFFSET 0`;
  const owned = (
    active: boolean,
  ) => sql`SELECT job.request_payload, settings.upstream_base_url,
      settings.remote_solver_auth_token, settings.remote_solver_registered_id, settings.instance_id, settings.instance_name,
      promise.id AS promise_id
    FROM sim_jobs job
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE job.id = point.sim_job_id AND NOT settings.remote_solver_transfer_paused AND settings.remote_solver_auth_token <> ''
      AND settings.upstream_base_url IS NOT NULL AND job.request_payload->>'remoteSolver' = 'true'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND promise.source_base_url = settings.upstream_base_url
      AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
      AND (${!active} OR (promise.status = 'active' AND promise."expiresAt" > clock_timestamp())) OFFSET 0`;
  const candidate = (
    active: boolean,
  ) => sql`SELECT point.*, owned.* FROM (${points}) point
    JOIN LATERAL (${owned(active)}) owned ON true`;
  const order = sql`ORDER BY point.created_at, point.sim_job_id, point.sequence, point.aoa_deg, point.result_attempt_id LIMIT 1`;
  const selected = preferActive
    ? sql`WITH active AS MATERIALIZED (${candidate(true)} ${order}),
        fallback AS (${candidate(false)} WHERE NOT EXISTS (SELECT 1 FROM active) ${order})
      SELECT * FROM active UNION ALL SELECT * FROM fallback`
    : sql`${candidate(false)} ${order}`;
  return sql`SELECT selected.sim_job_id, selected.sequence, selected.result_attempt_id, selected.point_content_signature,
      report.content_signature AS report_signature, report.report, attempt.result_id, attempt.aoa_deg,
      attempt.engine_case_slug, attempt.evidence_payload, selected.request_payload, selected.upstream_base_url,
      selected.remote_solver_auth_token, selected.remote_solver_registered_id, selected.instance_id, selected.instance_name,
      selected.promise_id
    FROM (${selected}) selected
    JOIN progressive_worker_reports report ON report.sim_job_id = selected.sim_job_id AND report.sequence = selected.sequence
    JOIN result_attempts attempt ON attempt.id = selected.result_attempt_id`;
}
