CREATE TABLE progressive_worker_staging_failures (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  retry_after timestamptz NOT NULL,
  last_error text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sim_job_id, sequence),
  FOREIGN KEY (sim_job_id, sequence) REFERENCES progressive_worker_reports(sim_job_id, sequence) ON DELETE CASCADE
);
CREATE TRIGGER progressive_evidence_staging_retry_changed
AFTER INSERT OR UPDATE OR DELETE ON progressive_worker_staging_failures
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_worker_evidence_changed();
