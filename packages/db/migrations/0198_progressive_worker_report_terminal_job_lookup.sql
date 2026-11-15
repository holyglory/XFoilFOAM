CREATE INDEX progressive_worker_reports_terminal_job_lookup_idx
  ON progressive_worker_reports(sim_job_id, stopped_engine_job_id, sequence)
  WHERE acknowledged_at IS NOT NULL
    AND jsonb_typeof(report->'result') = 'object'
    AND stopped_engine_job_id IS NOT NULL;
