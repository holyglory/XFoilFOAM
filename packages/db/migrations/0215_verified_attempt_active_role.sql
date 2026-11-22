-- The hub can retain a prior upstream registration while remote solving is off.
-- The deployment role and canonical bucket are also checked by the hub CLI and worker.
CREATE OR REPLACE FUNCTION attempt_evidence_verified_hub() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT FROM sync_api_settings s JOIN attempt_evidence_storage_policy p ON p.id=s.id
    WHERE s.id=1 AND s.remote_solver_enabled IS FALSE AND p.hz_worker_only IS FALSE
  )
$$;
