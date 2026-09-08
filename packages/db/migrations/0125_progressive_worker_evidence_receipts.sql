ALTER TABLE sim_jobs ADD COLUMN ingest_lease_previous_status sim_job_status;
ALTER TABLE sim_jobs ADD CONSTRAINT sim_jobs_ingest_lease_previous_status_check
CHECK (ingest_lease_previous_status IS NULL OR ingest_lease_previous_status <> 'ingesting');
CREATE TABLE progressive_worker_evidence_receipts (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  content_signature text NOT NULL CHECK (content_signature ~ '^[a-f0-9]{64}$'),
  staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sim_job_id, sequence),
  FOREIGN KEY (sim_job_id, sequence) REFERENCES progressive_worker_reports(sim_job_id, sequence) ON DELETE CASCADE
);
CREATE TRIGGER progressive_worker_evidence_receipts_immutable BEFORE UPDATE ON progressive_worker_evidence_receipts
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
CREATE TABLE progressive_worker_evidence_attempts (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  result_attempt_id uuid NOT NULL REFERENCES result_attempts(id) ON DELETE CASCADE,
  point_content_signature text NOT NULL CHECK (point_content_signature ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (sim_job_id, sequence, result_attempt_id),
  FOREIGN KEY (sim_job_id, sequence) REFERENCES progressive_worker_evidence_receipts(sim_job_id, sequence) ON DELETE CASCADE
);
CREATE INDEX progressive_worker_evidence_attempts_attempt_idx ON progressive_worker_evidence_attempts(result_attempt_id);
CREATE TRIGGER progressive_worker_evidence_attempts_immutable BEFORE UPDATE ON progressive_worker_evidence_attempts
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
