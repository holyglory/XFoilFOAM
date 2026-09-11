CREATE TABLE progressive_worker_archive_reclaims (
  sim_job_id uuid NOT NULL,
  point_content_signature text NOT NULL,
  claim_token uuid,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_after timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  reclaimed_bytes bigint CHECK (reclaimed_bytes >= 0),
  last_error text,
  PRIMARY KEY (sim_job_id, point_content_signature),
  FOREIGN KEY (sim_job_id, point_content_signature)
    REFERENCES progressive_worker_archive_receipts(sim_job_id, point_content_signature) ON DELETE CASCADE,
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK ((completed_at IS NULL) = (reclaimed_bytes IS NULL))
);
CREATE INDEX progressive_worker_archive_reclaims_due_idx
  ON progressive_worker_archive_reclaims(retry_after) WHERE completed_at IS NULL;
