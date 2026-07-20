-- A scheduling promise is a lease for new CFD work, not the lifetime of the
-- immutable evidence that already fulfilled one of its points. Permit one
-- narrowly fenced storage-only replay to replace an exact accepted legacy
-- gzip container with its manifest-authenticated brokered Zstandard archive.
-- The predicate deliberately fails closed if the canonical attempt, manifest,
-- container multiplicity, solver generation identity, or accepted pointer has
-- changed.
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
      )
  );
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_brokered_evidence_upload_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  solver_row registered_remote_solvers%ROWTYPE;
  promise_row sync_sweep_promises%ROWTYPE;
  point_row sync_sweep_promise_points%ROWTYPE;
  expired_retry boolean := false;
  settled_legacy_upgrade boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    expired_retry := OLD.state = 'expired' AND NEW.state = 'issuing';
    IF ROW(
      NEW.idempotency_key, NEW.promise_id, NEW.promise_point_id, NEW.solver_id,
      NEW.source_instance_id, NEW.remote_result_id, NEW.remote_result_attempt_id,
      NEW.aoa_deg, NEW.engine_job_id, NEW.engine_case_slug, NEW.bucket, NEW.object_key,
      NEW.stored_sha256, NEW.stored_byte_size, NEW.tar_sha256, NEW.tar_byte_size,
      NEW.manifest_sha256, NEW.manifest_byte_size, NEW.zstd_level,
      NEW.bundled_file_count
    ) IS DISTINCT FROM ROW(
      OLD.idempotency_key, OLD.promise_id, OLD.promise_point_id, OLD.solver_id,
      OLD.source_instance_id, OLD.remote_result_id, OLD.remote_result_attempt_id,
      OLD.aoa_deg, OLD.engine_job_id, OLD.engine_case_slug, OLD.bucket, OLD.object_key,
      OLD.stored_sha256, OLD.stored_byte_size, OLD.tar_sha256, OLD.tar_byte_size,
      OLD.manifest_sha256, OLD.manifest_byte_size, OLD.zstd_level,
      OLD.bundled_file_count
    ) THEN
      RAISE EXCEPTION 'brokered evidence upload immutable identity cannot change';
    END IF;
    IF OLD.state = 'bound' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'bound brokered evidence upload is immutable';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'brokered evidence upload revocation cannot be cleared';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'requested' AND NEW.state IN ('issuing', 'revoked', 'expired'))
      OR (OLD.state = 'issuing' AND NEW.state IN ('issued', 'verified', 'failed', 'revoked', 'expired'))
      OR (OLD.state = 'issued' AND NEW.state IN ('issuing', 'verifying', 'revoked', 'expired'))
      OR (OLD.state = 'verifying' AND NEW.state IN ('verified', 'failed', 'revoked', 'expired'))
      OR (OLD.state = 'failed' AND NEW.state IN ('issuing', 'verifying', 'revoked', 'expired'))
      OR (OLD.state = 'verified' AND NEW.state IN ('bound', 'revoked'))
      OR (
        expired_retry
        AND OLD.session_cancellation_acknowledged_at IS NOT NULL
        AND OLD.upload_url IS NULL
        AND OLD.upload_expires_at IS NULL
        AND OLD.revoked_at IS NULL
        AND NEW.upload_url IS NULL
        AND NEW.upload_expires_at IS NULL
        AND NEW.session_cancellation_acknowledged_at IS NULL
        AND NEW.revoked_at IS NULL
        AND NEW.attempt_count = OLD.attempt_count + 1
      )
    ) THEN
      RAISE EXCEPTION 'illegal brokered evidence upload state transition: % -> %', OLD.state, NEW.state;
    END IF;
  END IF;

  SELECT * INTO solver_row
  FROM registered_remote_solvers
  WHERE id = NEW.solver_id;
  IF NOT FOUND OR solver_row.instance_id <> NEW.source_instance_id THEN
    RAISE EXCEPTION 'brokered evidence upload solver identity mismatch';
  END IF;
  IF (TG_OP = 'INSERT' OR expired_retry)
     AND (solver_row.revoked_at IS NOT NULL OR solver_row.auth_token_hash IS NULL) THEN
    RAISE EXCEPTION 'brokered evidence upload solver credential is not active';
  END IF;

  SELECT * INTO promise_row
  FROM sync_sweep_promises
  WHERE id = NEW.promise_id;
  IF NOT FOUND
     OR promise_row.source_instance_id IS DISTINCT FROM NEW.source_instance_id
     OR promise_row.request_payload ->> 'solverId' IS DISTINCT FROM NEW.solver_id::text THEN
    RAISE EXCEPTION 'brokered evidence upload promise is not owned by this solver';
  END IF;

  SELECT * INTO point_row
  FROM sync_sweep_promise_points
  WHERE id = NEW.promise_point_id;
  IF NOT FOUND
     OR point_row.promise_id <> NEW.promise_id
     OR point_row.aoa_deg <> NEW.aoa_deg THEN
    RAISE EXCEPTION 'brokered evidence upload promise point mismatch';
  END IF;

  IF TG_OP = 'INSERT' OR expired_retry THEN
    settled_legacy_upgrade :=
      is_exact_settled_legacy_evidence_upgrade(NEW);
  END IF;
  IF (TG_OP = 'INSERT' OR expired_retry)
     AND (promise_row.status <> 'active' OR promise_row."expiresAt" <= now())
     AND NOT settled_legacy_upgrade THEN
    RAISE EXCEPTION 'brokered evidence upload requires an active promise lease';
  END IF;
  IF (TG_OP = 'INSERT' OR expired_retry)
     AND point_row.status <> 'active'
     AND NOT settled_legacy_upgrade THEN
    RAISE EXCEPTION 'brokered evidence upload requires an active promise point';
  END IF;

  IF btrim(NEW.bucket) = '' THEN
    RAISE EXCEPTION 'brokered evidence upload bucket is required';
  END IF;
  IF NEW.object_key <> (
    'solver-evidence/v1/sha256/' || substr(NEW.stored_sha256, 1, 2) || '/' ||
    NEW.stored_sha256 || '.tar.zst'
  ) THEN
    RAISE EXCEPTION 'brokered evidence upload object key is not canonical';
  END IF;
  RETURN NEW;
END;
$$;
