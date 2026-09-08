CREATE TABLE progressive_cfd_recovery_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES progressive_cfd_units(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal IN (1, 2)),
  parent_attempt_token uuid NOT NULL REFERENCES progressive_cfd_attempts(token) ON DELETE CASCADE,
  parent_job_id uuid NOT NULL REFERENCES sim_jobs(id) ON DELETE CASCADE,
  diagnostic_attempt_id uuid NOT NULL REFERENCES result_attempts(id) ON DELETE CASCADE,
  diagnostic_signature text NOT NULL CHECK (diagnostic_signature ~ '^[a-f0-9]{64}$'),
  scope text NOT NULL CHECK (scope IN ('targeted', 'original_sweep')),
  reason text NOT NULL CHECK (reason IN ('hard_solver', 'needs_urans', 'accepted_precalc')),
  recipe jsonb NOT NULL CHECK (jsonb_typeof(recipe) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (unit_id, ordinal),
  CHECK ((ordinal = 2) = (reason = 'accepted_precalc'))
);
CREATE TRIGGER progressive_cfd_recovery_plans_immutable BEFORE UPDATE ON progressive_cfd_recovery_plans
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
ALTER TABLE progressive_cfd_units DROP CONSTRAINT progressive_cfd_units_attempts_check;
ALTER TABLE progressive_cfd_units ADD CONSTRAINT progressive_cfd_units_attempts_check CHECK (attempts BETWEEN 0 AND 3);
CREATE TABLE progressive_cfd_recovery_claims (
  attempt_token uuid PRIMARY KEY REFERENCES progressive_cfd_attempts(token) ON DELETE CASCADE,
  recovery_plan_id uuid NOT NULL UNIQUE REFERENCES progressive_cfd_recovery_plans(id) ON DELETE CASCADE
);
CREATE TRIGGER progressive_cfd_recovery_claims_immutable BEFORE UPDATE ON progressive_cfd_recovery_claims
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
