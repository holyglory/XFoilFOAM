CREATE INDEX progressive_worker_reports_staging_job_order_idx
  ON progressive_worker_reports (sim_job_id, created_at, sequence)
  WHERE acknowledged_at IS NOT NULL
    AND jsonb_typeof(report->'result') = 'object';

CREATE INDEX progressive_worker_reports_terminal_staging_job_order_idx
  ON progressive_worker_reports (sim_job_id, created_at, sequence)
  WHERE acknowledged_at IS NOT NULL
    AND jsonb_typeof(report->'result') = 'object'
    AND stopped_engine_job_id IS NOT NULL;
