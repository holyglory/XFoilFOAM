CREATE TABLE progressive_cfd_execution_stops (
  sim_job_id uuid PRIMARY KEY REFERENCES sim_jobs(id) ON DELETE CASCADE,
  engine_job_id text NOT NULL,
  epoch_id uuid NOT NULL REFERENCES calculation_epochs(id) ON DELETE CASCADE,
  proof jsonb NOT NULL CHECK (jsonb_typeof(proof) = 'object' AND proof->>'execution_stopped' = 'true'),
  proof_signature text NOT NULL CHECK (proof_signature ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX progressive_cfd_execution_stops_epoch_idx ON progressive_cfd_execution_stops(epoch_id);
CREATE TRIGGER progressive_cfd_execution_stops_immutable BEFORE UPDATE ON progressive_cfd_execution_stops
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
CREATE TRIGGER progressive_cfd_execution_stops_changed AFTER INSERT ON progressive_cfd_execution_stops
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_work_changed();
