CREATE TABLE progressive_ingestion_ownership_recoveries (
  attempt_token uuid PRIMARY KEY REFERENCES progressive_cfd_attempts(token) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES progressive_cfd_units(id) ON DELETE CASCADE,
  sim_job_id uuid NOT NULL REFERENCES sim_jobs(id) ON DELETE CASCADE,
  manifest_signature text NOT NULL CHECK (manifest_signature ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  prior_state jsonb NOT NULL CHECK (jsonb_typeof(prior_state) = 'object'),
  restored_lease_until timestamptz NOT NULL,
  restored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  database_actor text NOT NULL DEFAULT current_user
);
CREATE INDEX progressive_ingestion_ownership_recoveries_job_idx
  ON progressive_ingestion_ownership_recoveries(sim_job_id, unit_id);
CREATE TRIGGER progressive_ingestion_ownership_recoveries_immutable
  BEFORE UPDATE ON progressive_ingestion_ownership_recoveries
  FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
