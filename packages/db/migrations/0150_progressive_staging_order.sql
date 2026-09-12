CREATE INDEX progressive_worker_reports_staging_order_idx
  ON progressive_worker_reports (created_at, sim_job_id, sequence)
  WHERE acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result') = 'object';
