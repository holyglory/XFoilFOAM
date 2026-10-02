CREATE TABLE progressive_worker_evidence_delivery_claims (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  result_attempt_id uuid NOT NULL,
  point_content_signature text NOT NULL
    CHECK (point_content_signature ~ '^[a-f0-9]{64}$'),
  claim_token uuid NOT NULL,
  claim_expires_at timestamptz NOT NULL,
  PRIMARY KEY (sim_job_id, point_content_signature),
  FOREIGN KEY (sim_job_id, sequence, result_attempt_id)
    REFERENCES progressive_worker_evidence_attempts(sim_job_id, sequence, result_attempt_id)
    ON DELETE CASCADE,
  CHECK (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
);
CREATE INDEX progressive_worker_evidence_delivery_claims_expiry_idx
  ON progressive_worker_evidence_delivery_claims (claim_expires_at);
