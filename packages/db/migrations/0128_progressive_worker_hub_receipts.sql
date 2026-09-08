CREATE TABLE progressive_worker_hub_receipts (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  result_attempt_id uuid NOT NULL,
  point_content_signature text NOT NULL CHECK (point_content_signature ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sim_job_id, point_content_signature),
  FOREIGN KEY (sim_job_id, sequence, result_attempt_id)
    REFERENCES progressive_worker_evidence_attempts(sim_job_id, sequence, result_attempt_id) ON DELETE CASCADE
);
CREATE TRIGGER progressive_worker_hub_receipts_immutable BEFORE UPDATE ON progressive_worker_hub_receipts
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
