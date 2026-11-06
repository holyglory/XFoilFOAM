CREATE TABLE progressive_remote_diagnostic_receipts (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  point_content_signature text NOT NULL CHECK (point_content_signature ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'
    AND receipt->>'kind' = 'retained-progressive-diagnostic'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sim_job_id, point_content_signature),
  FOREIGN KEY (sim_job_id, sequence, point_content_signature)
    REFERENCES progressive_remote_report_sources(sim_job_id, sequence, point_content_signature) ON DELETE CASCADE
);
CREATE TRIGGER progressive_remote_diagnostic_receipts_immutable BEFORE UPDATE ON progressive_remote_diagnostic_receipts
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
