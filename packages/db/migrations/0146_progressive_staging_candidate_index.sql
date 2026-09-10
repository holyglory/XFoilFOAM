CREATE INDEX progressive_worker_reports_staging_candidate_idx
ON progressive_worker_reports(sim_job_id,sequence,created_at)
WHERE acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result')='object';
