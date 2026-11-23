import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";

export async function workerEvidenceStorageColumns(db: DB) {
  const [row] = await db.execute(sql`SELECT EXISTS(SELECT FROM pg_attribute WHERE attrelid=to_regclass('progressive_worker_reports')
      AND attname='archived_at' AND NOT attisdropped) AS reports,
    EXISTS(SELECT FROM pg_attribute WHERE attrelid=to_regclass('result_attempts')
      AND attname='evidence_archive_id' AND NOT attisdropped) AS attempts`);
  return { reports: row?.reports === true, attempts: row?.attempts === true };
}

export function progressiveMaterialDiagnosticSql(alias: string) {
  const attempt = sql.identifier(alias);
  return sql`(${attempt}.evidence_payload->>'failure_disposition'='material_domain'
    AND ${attempt}.evidence_payload->>'converged'='false'
    AND coalesce(${attempt}.evidence_payload->>'cl',${attempt}.evidence_payload->>'cd',${attempt}.evidence_payload->>'cm') IS NULL
    AND coalesce(${attempt}.evidence_payload->'evidence_artifacts','[]'::jsonb)='[]'::jsonb
    AND coalesce(${attempt}.evidence_payload->'force_history','null'::jsonb)='null'::jsonb
    AND coalesce(${attempt}.evidence_payload->'steady_history','null'::jsonb)='null'::jsonb
    AND coalesce(${attempt}.evidence_payload->'frame_track','null'::jsonb)='null'::jsonb
    AND coalesce(${attempt}.evidence_payload->'urans_cycle_certificate','null'::jsonb)='null'::jsonb
    AND coalesce(${attempt}.evidence_payload->'aperiodic_mean_certificate','null'::jsonb)='null'::jsonb
    AND coalesce(${attempt}.evidence_payload->'no_shedding_certificate','null'::jsonb)='null'::jsonb
    AND coalesce(${attempt}.evidence_payload->'rans_hold_certificate','null'::jsonb)='null'::jsonb
    AND coalesce(nullif(${attempt}.evidence_payload->'images','null'::jsonb),'{}'::jsonb)='{}'::jsonb
    AND coalesce(nullif(${attempt}.evidence_payload->'video','null'::jsonb),'{}'::jsonb)='{}'::jsonb
    AND coalesce(nullif(${attempt}.evidence_payload->'mean_images','null'::jsonb),'{}'::jsonb)='{}'::jsonb)`;
}

export function progressiveDiagnosticRetrySql(failureAlias: string, attemptAlias: string) {
  const failure = sql.identifier(failureAlias);
  return sql`(${failure}.state='conflict' AND ${failure}.last_http_status=409
    AND ${failure}.remote_conflict_ids='[]'::jsonb
    AND ${failure}.last_error ~ '^Progressive evidence delivery failed [(]409[)]: progressive_scope_closed( |$)'
    AND ${progressiveMaterialDiagnosticSql(attemptAlias)})`;
}

export function progressiveDeliverySelectionSql(
  preferActive: boolean,
  claimToken?: string,
  hasArchivePointer = false,
) {
  const retryableFailure = sql`(
    failure.state = 'retry'
    OR ${progressiveDiagnosticRetrySql("failure", "attempt")}
    OR (
      failure.state = 'conflict'
      AND failure.last_error ILIKE ANY (ARRAY[
        '%aborted%', '%timeout%', '%timed out%',
        '%source is not retained yet%'
      ])
    )
  )`;
  // One signed point can appear in many cumulative reports. Keep every
  // unreceived sequence, but evaluate the claim and scientific retry gates
  // once for each distinct point/attempt binding.
  const pointSources = sql`outstanding_sources AS MATERIALIZED (
    SELECT source.sim_job_id,source.sequence,source.result_attempt_id,source.point_content_signature
    FROM progressive_worker_evidence_attempts source
    WHERE NOT EXISTS (
      SELECT 1 FROM progressive_worker_hub_receipts delivered
      WHERE delivered.sim_job_id=source.sim_job_id AND delivered.point_content_signature=source.point_content_signature)
  ), eligible_bindings AS MATERIALIZED (
    SELECT binding.*,attempt.aoa_deg,failure.sim_job_id IS NOT NULL AS is_retry
    FROM (SELECT DISTINCT sim_job_id,point_content_signature,result_attempt_id FROM outstanding_sources) binding
    JOIN result_attempts attempt ON attempt.id=binding.result_attempt_id AND attempt.sim_job_id=binding.sim_job_id
      AND attempt.engine_job_id=binding.sim_job_id::text
    LEFT JOIN progressive_worker_delivery_failures failure ON failure.sim_job_id=binding.sim_job_id
      AND failure.point_content_signature=binding.point_content_signature
    LEFT JOIN progressive_worker_evidence_delivery_claims claim ON claim.sim_job_id=binding.sim_job_id
      AND claim.point_content_signature=binding.point_content_signature
    WHERE attempt.result_id IS NOT NULL AND (claim.claim_token IS NULL OR claim.claim_expires_at<=clock_timestamp())
      AND (failure.sim_job_id IS NULL OR (${retryableFailure}
        AND (failure.retry_after IS NULL OR failure.retry_after<=clock_timestamp())))
  ), deliverable_sources AS MATERIALIZED (
    SELECT source.*,report.created_at FROM (
      SELECT s.sim_job_id,s.sequence,s.result_attempt_id,s.point_content_signature,binding.aoa_deg,binding.is_retry
      FROM eligible_bindings binding JOIN outstanding_sources s
        USING(sim_job_id,point_content_signature,result_attempt_id)
      -- Discard held bindings before looking up their repeated report headers.
      OFFSET 0
    ) source
    JOIN progressive_worker_reports report ON report.sim_job_id=source.sim_job_id AND report.sequence=source.sequence
    WHERE report.acknowledged_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM progressive_worker_report_conflicts conflict
        WHERE conflict.sim_job_id=source.sim_job_id AND conflict.sequence=source.sequence)
  )`;
  const candidate = (
    active: boolean,
    excludeActive = false,
  ) => sql`SELECT point.*, job.request_payload, settings.upstream_base_url,
      settings.remote_solver_auth_token, settings.remote_solver_registered_id, settings.instance_id, settings.instance_name,
      promise.id AS promise_id
    FROM deliverable_sources point
    JOIN LATERAL (SELECT * FROM sim_jobs WHERE id = point.sim_job_id OFFSET 0) job ON true
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE NOT settings.remote_solver_transfer_paused AND settings.remote_solver_auth_token <> ''
      AND settings.upstream_base_url IS NOT NULL AND job.request_payload->>'remoteSolver' = 'true'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND promise.source_base_url = settings.upstream_base_url
      AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
      AND (${!active} OR (promise.status = 'active' AND promise."expiresAt" > clock_timestamp()))
      ${excludeActive ? sql`AND NOT EXISTS (SELECT 1 FROM active)` : sql``}
    ORDER BY point.is_retry DESC, point.created_at, point.sim_job_id, point.sequence, point.aoa_deg, point.result_attempt_id LIMIT 1`;
  const selected = preferActive
    ? sql`WITH ${pointSources},active AS MATERIALIZED (${candidate(true)}),
        fallback AS (${candidate(false, true)})
      SELECT * FROM active UNION ALL SELECT * FROM fallback`
    : sql`WITH ${pointSources} ${candidate(false)}`;
  const selectedCandidate = sql`SELECT selected.sim_job_id, selected.sequence, selected.result_attempt_id, selected.point_content_signature,
      report.content_signature AS report_signature, resolve_progressive_report(to_jsonb(report.*)) AS report, attempt.result_id, attempt.aoa_deg,
      attempt.engine_case_slug, attempt.evidence_payload,
      ${hasArchivePointer ? sql`attempt.evidence_archive_id,attempt.evidence_storage_event_id` : sql`NULL::uuid AS evidence_archive_id,NULL::uuid AS evidence_storage_event_id`},
      selected.request_payload, selected.upstream_base_url,
      selected.remote_solver_auth_token, selected.remote_solver_registered_id, selected.instance_id, selected.instance_name,
      selected.promise_id
    FROM (${selected}) selected
    JOIN progressive_worker_reports report ON report.sim_job_id = selected.sim_job_id AND report.sequence = selected.sequence
    JOIN result_attempts attempt ON attempt.id = selected.result_attempt_id`;
  if (!claimToken) return selectedCandidate;
  return sql`
    WITH candidate AS MATERIALIZED (${selectedCandidate}), claimed AS (
      INSERT INTO progressive_worker_evidence_delivery_claims
        (sim_job_id, sequence, result_attempt_id, point_content_signature, claim_token, claim_expires_at)
      SELECT candidate.sim_job_id, candidate.sequence, candidate.result_attempt_id,
        candidate.point_content_signature, ${claimToken}::uuid,
        clock_timestamp() + interval '120 seconds'
      FROM candidate
      ON CONFLICT (sim_job_id, point_content_signature) DO UPDATE SET
        sequence = EXCLUDED.sequence,
        result_attempt_id = EXCLUDED.result_attempt_id,
        claim_token = EXCLUDED.claim_token,
        claim_expires_at = EXCLUDED.claim_expires_at
      WHERE progressive_worker_evidence_delivery_claims.claim_expires_at <= clock_timestamp()
      RETURNING sim_job_id, point_content_signature
    )
    SELECT candidate.*
    FROM candidate JOIN claimed USING (sim_job_id, point_content_signature)
  `;
}
