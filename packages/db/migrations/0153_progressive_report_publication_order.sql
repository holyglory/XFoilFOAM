CREATE INDEX progressive_worker_reports_publication_order_idx
  ON progressive_worker_reports((report->>'solverId'), created_at, sim_job_id, sequence)
  WHERE acknowledged_at IS NULL;
