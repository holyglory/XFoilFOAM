CREATE TABLE progressive_remote_progress_receipts (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  content_signature text NOT NULL CHECK (content_signature ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sim_job_id, sequence),
  FOREIGN KEY (sim_job_id, sequence) REFERENCES progressive_remote_reports(sim_job_id, sequence) ON DELETE CASCADE
);
CREATE TRIGGER progressive_remote_progress_receipts_immutable BEFORE UPDATE ON progressive_remote_progress_receipts
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
