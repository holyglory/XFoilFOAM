CREATE FUNCTION is_exact_retained_progressive_archive(candidate sync_brokered_evidence_uploads)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM progressive_remote_evidence_receipts receipt
    JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id = receipt.sim_job_id
    JOIN registered_remote_solvers solver ON solver.id = dispatch.solver_id
    JOIN result_attempts attempt ON attempt.id = receipt.result_attempt_id AND attempt.sim_job_id = receipt.sim_job_id
    JOIN sync_sweep_promise_points point ON point.id = candidate.promise_point_id AND point.promise_id = dispatch.promise_id
    WHERE dispatch.sim_job_id::text = candidate.engine_job_id
      AND dispatch.solver_id = candidate.solver_id AND dispatch.promise_id = candidate.promise_id
      AND solver.instance_id = candidate.source_instance_id AND solver.revoked_at IS NULL AND solver.auth_token_hash IS NOT NULL
      AND receipt.remote_result_id = candidate.remote_result_id AND receipt.remote_result_attempt_id = candidate.remote_result_attempt_id
      AND attempt.engine_job_id = candidate.engine_job_id AND attempt.engine_case_slug IS NOT DISTINCT FROM candidate.engine_case_slug
      AND attempt.aoa_deg = candidate.aoa_deg AND point.aoa_deg = candidate.aoa_deg
      AND point.airfoil_id = attempt.airfoil_id AND point.simulation_preset_revision_id = attempt.simulation_preset_revision_id
      AND (candidate.canonical_result_id IS NULL OR candidate.canonical_result_id = attempt.result_id)
      AND (candidate.canonical_result_attempt_id IS NULL OR candidate.canonical_result_attempt_id = attempt.id)
      AND (
        SELECT count(*) = 1 AND count(*) FILTER (WHERE manifest->>'sha256' = candidate.manifest_sha256
          AND manifest->>'byte_size' = candidate.manifest_byte_size::text) = 1
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(attempt.evidence_payload->'evidence_artifacts') = 'array'
          THEN attempt.evidence_payload->'evidence_artifacts' ELSE '[]'::jsonb END) manifest
        WHERE manifest->>'kind' = 'manifest'
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
  closed_lease_archive boolean := false;
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
    closed_lease_archive :=
      is_exact_settled_legacy_evidence_upgrade(NEW) OR is_exact_retained_progressive_archive(NEW);
  END IF;
  IF (TG_OP = 'INSERT' OR expired_retry)
     AND (promise_row.status <> 'active' OR promise_row."expiresAt" <= now())
     AND NOT closed_lease_archive THEN
    RAISE EXCEPTION 'brokered evidence upload requires an active promise lease';
  END IF;
  IF (TG_OP = 'INSERT' OR expired_retry)
     AND point_row.status <> 'active'
     AND NOT closed_lease_archive THEN
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
  retained_progressive boolean := false;
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
  retained_progressive := is_exact_retained_progressive_archive(NEW);
  IF promise_row.id IS NULL
     OR point_row.id IS NULL
     OR (
       (
         promise_row.status <> 'active'
         OR promise_row."expiresAt" <= now()
         OR point_row.status <> 'active'
       )
       AND NOT settled_legacy_upgrade AND NOT retained_progressive
     ) THEN
    RAISE EXCEPTION 'brokered evidence binding requires the exact active promise lease';
  END IF;
  IF NOT retained_progressive AND (point_row.result_id IS NOT NULL OR point_row.result_attempt_id IS NOT NULL) THEN
    IF point_row.result_id IS DISTINCT FROM NEW.canonical_result_id
       OR point_row.result_attempt_id IS DISTINCT FROM NEW.canonical_result_attempt_id THEN
      RAISE EXCEPTION 'promise point already owns a different fulfilled generation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
