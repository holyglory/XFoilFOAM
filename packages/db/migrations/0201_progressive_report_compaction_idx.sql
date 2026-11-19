CREATE INDEX IF NOT EXISTS progressive_worker_reports_compaction_order_idx
  ON progressive_worker_reports(created_at, sim_job_id, sequence)
  WHERE acknowledged_at IS NOT NULL
    AND archive_bundle_id IS NULL
    AND archived_at IS NULL
    AND jsonb_typeof(report->'result') = 'object';
