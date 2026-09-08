CREATE TABLE progressive_worker_archive_receipts (
  sim_job_id uuid NOT NULL,
  point_content_signature text NOT NULL,
  brokered_upload_id uuid NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sim_job_id, point_content_signature),
  FOREIGN KEY (sim_job_id, point_content_signature)
    REFERENCES progressive_worker_hub_receipts(sim_job_id, point_content_signature) ON DELETE CASCADE
);
CREATE TRIGGER progressive_worker_archive_receipts_immutable BEFORE UPDATE ON progressive_worker_archive_receipts
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
