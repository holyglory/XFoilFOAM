CREATE INDEX IF NOT EXISTS sim_jobs_direct_terminal_retention_idx
  ON sim_jobs (COALESCE("finishedAt", "ingestedAt", "updatedAt", "createdAt"), id)
  WHERE status IN ('done', 'failed', 'cancelled')
    AND engine_job_id IS NOT NULL
    AND NOT coalesce(request_payload ? 'remoteProgressiveExecution', false);
