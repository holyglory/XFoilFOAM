CREATE INDEX IF NOT EXISTS progressive_remote_reports_received_order_idx
  ON progressive_remote_reports (received_at, sim_job_id, sequence);
