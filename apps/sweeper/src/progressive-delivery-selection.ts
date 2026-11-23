import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";

export async function workerEvidenceStorageColumns(db: DB) {
  const [row] =
    await db.execute(sql`SELECT EXISTS(SELECT FROM pg_attribute WHERE attrelid=to_regclass('progressive_worker_reports')
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

function closedScopeFailureSql(failureAlias: string) {
  const failure = sql.identifier(failureAlias);
  return sql`(${failure}.state='conflict' AND ${failure}.last_http_status=409
    AND ${failure}.remote_conflict_ids='[]'::jsonb
    AND ${failure}.last_error ~ '^Progressive evidence delivery failed [(]409[)]: progressive_scope_closed( |$)')`;
}

export function progressiveDiagnosticRetrySql(
  failureAlias: string,
  attemptAlias: string,
) {
  return sql`(${closedScopeFailureSql(failureAlias)} AND ${progressiveMaterialDiagnosticSql(attemptAlias)})`;
}

export function progressiveDeliverySelectionSql(
  preferActive: boolean,
  claimToken?: string,
  hasArchivePointer = false,
) {
  // Classify cheap point-level blockers before reading the attempt or expanding report aliases.
  // NULL excludes this binding, false admits the ordinary retry path, and true requires the exact diagnostic proof.
  const needsDiagnostic = sql`CASE
    WHEN failure.sim_job_id IS NULL OR failure.state='retry' THEN false
    WHEN failure.state='conflict' AND failure.last_error ILIKE ANY(ARRAY[
      '%aborted%','%timeout%','%timed out%','%source is not retained yet%']) THEN false
    WHEN ${closedScopeFailureSql("failure")} AND disposition.material_domain IS DISTINCT FROM false THEN true
    END`;
  const pointSources = sql`pending_bindings AS MATERIALIZED (
    SELECT p.sim_job_id,p.point_content_signature,b.result_attempt_id,
      failure.sim_job_id IS NOT NULL AS is_retry, ${needsDiagnostic} AS needs_diagnostic
    FROM progressive_worker_delivery_points p
    CROSS JOIN LATERAL unnest(p.attempt_ids) b(result_attempt_id)
    LEFT JOIN progressive_worker_delivery_diagnostics disposition ON disposition.result_attempt_id=b.result_attempt_id
    LEFT JOIN progressive_worker_delivery_failures failure ON (failure.sim_job_id,failure.point_content_signature)=(p.sim_job_id,p.point_content_signature)
    LEFT JOIN progressive_worker_evidence_delivery_claims claim ON (claim.sim_job_id,claim.point_content_signature)=(p.sim_job_id,p.point_content_signature)
    WHERE NOT p.received AND cardinality(p.attempt_ids)>0
      AND NOT EXISTS(SELECT FROM progressive_worker_hub_receipts h WHERE (h.sim_job_id,h.point_content_signature)=(p.sim_job_id,p.point_content_signature))
      AND (claim.claim_token IS NULL OR claim.claim_expires_at<=clock_timestamp())
      AND (failure.retry_after IS NULL OR failure.retry_after<=clock_timestamp())
  ), eligible_bindings AS MATERIALIZED (
    SELECT b.sim_job_id,b.point_content_signature,b.result_attempt_id,b.is_retry,attempt.aoa_deg
    FROM pending_bindings b JOIN LATERAL (
      SELECT a.* FROM result_attempts a WHERE a.id=b.result_attempt_id OFFSET 0
    ) attempt ON attempt.sim_job_id=b.sim_job_id AND attempt.engine_job_id=b.sim_job_id::text
    WHERE b.needs_diagnostic IS NOT NULL AND attempt.result_id IS NOT NULL
      AND (NOT b.needs_diagnostic OR ${progressiveMaterialDiagnosticSql("attempt")})
  ), deliverable_sources AS MATERIALIZED (
    SELECT binding.*,first_alias.sequence,first_alias.created_at
    FROM eligible_bindings binding
    JOIN LATERAL (
      SELECT alias.sequence,header.created_at
      FROM progressive_worker_delivery_order alias
      JOIN LATERAL (SELECT r.created_at FROM progressive_worker_reports r
        WHERE (r.sim_job_id,r.sequence)=(alias.sim_job_id,alias.sequence) AND r.acknowledged_at IS NOT NULL
        OFFSET 0) header ON true
      WHERE (alias.sim_job_id,alias.point_content_signature,alias.result_attempt_id)=
            (binding.sim_job_id,binding.point_content_signature,binding.result_attempt_id)
        AND NOT EXISTS(SELECT FROM progressive_worker_report_conflicts c
                       WHERE (c.sim_job_id,c.sequence)=(alias.sim_job_id,alias.sequence))
      ORDER BY alias.created_at,alias.sequence LIMIT 1
    ) first_alias ON true
  )`;
  const candidate = (
    active: boolean,
    excludeActive = false,
  ) => sql`SELECT point.*, job.request_payload, settings.upstream_base_url,
      settings.remote_solver_auth_token, settings.remote_solver_registered_id, settings.instance_id, settings.instance_name,
      promise.id AS promise_id
    FROM deliverable_sources point
    ${
      claimToken
        ? sql`JOIN progressive_worker_delivery_points claim_point
      ON (claim_point.sim_job_id,claim_point.point_content_signature)=(point.sim_job_id,point.point_content_signature)
      AND NOT claim_point.received`
        : sql``
    }
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
    ORDER BY point.is_retry DESC, point.created_at, point.sim_job_id, point.sequence, point.aoa_deg, point.result_attempt_id
    LIMIT 1 ${claimToken ? sql`FOR UPDATE OF claim_point SKIP LOCKED` : sql``}`;
  const selected = preferActive
    ? sql`WITH ${pointSources},active AS MATERIALIZED (${candidate(true)}),
        fallback AS (${candidate(false, true)})
      SELECT * FROM active UNION ALL SELECT * FROM fallback`
    : sql`WITH ${pointSources} ${candidate(false)}`;
  const selectedCandidate = sql`SELECT selected.sim_job_id, signed_source.sequence, selected.result_attempt_id, selected.point_content_signature,
      report.content_signature AS report_signature, resolve_progressive_report(to_jsonb(report.*)) AS report, attempt.result_id, attempt.aoa_deg,
      attempt.engine_case_slug, attempt.evidence_payload,
      ${hasArchivePointer ? sql`attempt.evidence_archive_id,attempt.evidence_storage_event_id` : sql`NULL::uuid AS evidence_archive_id,NULL::uuid AS evidence_storage_event_id`},
      selected.request_payload, selected.upstream_base_url,
      selected.remote_solver_auth_token, selected.remote_solver_registered_id, selected.instance_id, selected.instance_name,
      selected.promise_id
    FROM (${selected}) selected
    JOIN progressive_worker_evidence_attempts signed_source ON
      (signed_source.sim_job_id,signed_source.sequence,signed_source.result_attempt_id,signed_source.point_content_signature)=
      (selected.sim_job_id,selected.sequence,selected.result_attempt_id,selected.point_content_signature)
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
