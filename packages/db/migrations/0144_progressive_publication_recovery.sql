CREATE TABLE progressive_publication_recoveries (
  unit_id uuid PRIMARY KEY REFERENCES progressive_cfd_units(id) ON DELETE CASCADE,
  predecessor_attempt_token uuid NOT NULL UNIQUE REFERENCES progressive_cfd_attempts(token) ON DELETE CASCADE,
  sim_job_id uuid NOT NULL REFERENCES sim_jobs(id) ON DELETE CASCADE,
  report_sequence bigint NOT NULL CHECK (report_sequence > 0),
  report_signature text NOT NULL CHECK (report_signature ~ '^[a-f0-9]{64}$'),
  cancellation jsonb NOT NULL CHECK (jsonb_typeof(cancellation)='object'),
  active_seconds double precision NOT NULL CHECK (active_seconds >= 0 AND active_seconds < 'Infinity'::double precision),
  attempts_before integer NOT NULL CHECK (attempts_before BETWEEN 1 AND 2),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE progressive_publication_recovery_claims (
  unit_id uuid PRIMARY KEY REFERENCES progressive_publication_recoveries(unit_id) ON DELETE CASCADE,
  attempt_token uuid NOT NULL UNIQUE REFERENCES progressive_cfd_attempts(token) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER progressive_publication_recoveries_immutable BEFORE UPDATE ON progressive_publication_recoveries
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
CREATE TRIGGER progressive_publication_recovery_claims_immutable BEFORE UPDATE ON progressive_publication_recovery_claims
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
