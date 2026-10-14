CREATE TABLE IF NOT EXISTS progressive_worker_report_conflicts (
  sim_job_id uuid NOT NULL REFERENCES sim_jobs(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  content_signature text NOT NULL,
  report jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sim_job_id, sequence),
  CONSTRAINT progressive_worker_report_conflicts_content_signature_check
    CHECK (content_signature ~ '^[a-f0-9]{64}$')
);
