CREATE TABLE progressive_worker_archive_deliveries (
  sim_job_id uuid NOT NULL,
  point_content_signature text NOT NULL,
  claim_token uuid,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_after timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sim_job_id, point_content_signature),
  FOREIGN KEY (sim_job_id, point_content_signature) REFERENCES progressive_worker_hub_receipts(sim_job_id, point_content_signature) ON DELETE CASCADE,
  CONSTRAINT progressive_worker_archive_deliveries_claim_check CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL))
);
