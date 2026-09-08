CREATE TABLE progressive_remote_evidence_receipts (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  point_content_signature text NOT NULL CHECK (point_content_signature ~ '^[a-f0-9]{64}$'),
  result_attempt_id uuid NOT NULL UNIQUE REFERENCES result_attempts(id) ON DELETE CASCADE,
  remote_result_id uuid NOT NULL,
  remote_result_attempt_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sim_job_id, point_content_signature),
  FOREIGN KEY (sim_job_id, sequence) REFERENCES progressive_remote_reports(sim_job_id, sequence) ON DELETE CASCADE
);
CREATE TRIGGER progressive_remote_evidence_receipts_immutable BEFORE UPDATE ON progressive_remote_evidence_receipts
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
