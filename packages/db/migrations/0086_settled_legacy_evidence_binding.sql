-- The 0085 admission fence allowed an exact fulfilled legacy generation to
-- request and verify its replacement GCS archive after the scheduling lease
-- closed. Binding happens one step later, after the candidate engine_bundle
-- association is inserted but before the legacy gzip association is retired.
-- Admit only that exact candidate association; every other closed-lease bind
-- remains rejected.
CREATE OR REPLACE FUNCTION is_exact_settled_legacy_evidence_upgrade(
  candidate sync_brokered_evidence_uploads
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM sync_sweep_promise_points point
    JOIN results result
      ON result.id = point.result_id
     AND result.current_result_attempt_id = point.result_attempt_id
    JOIN result_attempts attempt
      ON attempt.id = point.result_attempt_id
     AND attempt.result_id = point.result_id
    WHERE point.id = candidate.promise_point_id
      AND point.promise_id = candidate.promise_id
      AND point.status = 'fulfilled'
      AND point.aoa_deg = candidate.aoa_deg
      AND result.aoa_deg = candidate.aoa_deg
      AND result.status = 'done'
      AND result.source = 'solved'
      AND attempt.aoa_deg = candidate.aoa_deg
      AND attempt.status = 'done'
      AND attempt.source = 'solved'
      AND attempt.valid_for_polar
      AND attempt.engine_job_id =
        'sync:' || candidate.source_instance_id || ':' || candidate.engine_job_id
      AND attempt.engine_case_slug IS NOT DISTINCT FROM candidate.engine_case_slug
      AND (
        SELECT count(*)
        FROM solver_evidence_artifacts manifest
        WHERE manifest.result_id = point.result_id
          AND manifest.result_attempt_id = point.result_attempt_id
          AND manifest.kind::text = 'manifest'
          AND manifest.sha256 = candidate.manifest_sha256
          AND manifest.byte_size = candidate.manifest_byte_size
          AND manifest.engine_job_id = attempt.engine_job_id
          AND manifest.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
          AND manifest.aoa_deg = candidate.aoa_deg
      ) = 1
      AND (
        SELECT count(*)
        FROM solver_evidence_artifacts manifest
        WHERE manifest.result_id = point.result_id
          AND manifest.result_attempt_id = point.result_attempt_id
          AND manifest.kind::text = 'manifest'
      ) = 1
      AND (
        SELECT count(*)
        FROM solver_evidence_artifacts legacy
        WHERE legacy.result_id = point.result_id
          AND legacy.result_attempt_id = point.result_attempt_id
          AND legacy.kind::text = 'openfoam_bundle'
          AND legacy.mime_type = 'application/gzip'
          AND legacy.storage_key LIKE 'sync-imports/%'
          AND legacy.storage_key LIKE '%.gz'
          AND legacy.engine_job_id = attempt.engine_job_id
          AND legacy.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
          AND legacy.aoa_deg = candidate.aoa_deg
      ) = 1
      AND NOT EXISTS (
        SELECT 1
        FROM solver_evidence_artifacts superseding
        WHERE superseding.result_id = point.result_id
          AND superseding.result_attempt_id = point.result_attempt_id
          AND (
            superseding.kind::text = 'engine_bundle'
            OR (
              superseding.kind::text = 'openfoam_bundle'
              AND NOT (
                superseding.mime_type = 'application/gzip'
                AND superseding.storage_key LIKE 'sync-imports/%'
                AND superseding.storage_key LIKE '%.gz'
              )
            )
          )
          AND NOT (
            candidate.state = 'bound'
            AND superseding.kind::text = 'engine_bundle'
            AND superseding.id = candidate.canonical_artifact_id
            AND candidate.canonical_result_id = point.result_id
            AND candidate.canonical_result_attempt_id = point.result_attempt_id
            AND superseding.storage_key = candidate.object_key
            AND superseding.sha256 = candidate.stored_sha256
            AND superseding.byte_size = candidate.stored_byte_size
            AND superseding.metadata ->> 'remoteEvidenceUploadId' = candidate.id::text
          )
      )
  );
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_brokered_evidence_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  artifact_row solver_evidence_artifacts%ROWTYPE;
  promise_row sync_sweep_promises%ROWTYPE;
  point_row sync_sweep_promise_points%ROWTYPE;
  settled_legacy_upgrade boolean := false;
BEGIN
  IF NEW.state <> 'bound' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO artifact_row
  FROM solver_evidence_artifacts
  WHERE id = NEW.canonical_artifact_id;
  IF NOT FOUND
     OR artifact_row.result_id <> NEW.canonical_result_id
     OR artifact_row.result_attempt_id <> NEW.canonical_result_attempt_id
     OR artifact_row.kind <> 'engine_bundle'
     OR artifact_row.storage_key <> NEW.object_key
     OR artifact_row.sha256 <> NEW.stored_sha256
     OR artifact_row.byte_size <> NEW.stored_byte_size
     OR artifact_row.metadata ->> 'remoteEvidenceUploadId' IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION 'brokered evidence upload canonical binding is invalid';
  END IF;
  SELECT * INTO promise_row FROM sync_sweep_promises
  WHERE id = NEW.promise_id FOR KEY SHARE;
  SELECT * INTO point_row FROM sync_sweep_promise_points
  WHERE id = NEW.promise_point_id FOR UPDATE;
  settled_legacy_upgrade := is_exact_settled_legacy_evidence_upgrade(NEW);
  IF promise_row.id IS NULL
     OR point_row.id IS NULL
     OR (
       (
         promise_row.status <> 'active'
         OR promise_row."expiresAt" <= now()
         OR point_row.status <> 'active'
       )
       AND NOT settled_legacy_upgrade
     ) THEN
    RAISE EXCEPTION 'brokered evidence binding requires the exact active promise lease';
  END IF;
  IF point_row.result_id IS NOT NULL OR point_row.result_attempt_id IS NOT NULL THEN
    IF point_row.result_id IS DISTINCT FROM NEW.canonical_result_id
       OR point_row.result_attempt_id IS DISTINCT FROM NEW.canonical_result_attempt_id THEN
      RAISE EXCEPTION 'promise point already owns a different fulfilled generation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
