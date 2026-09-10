CREATE INDEX progressive_remote_reports_stop_candidate_idx ON progressive_remote_reports(sim_job_id)
WHERE report#>>'{stopProof,execution_stopped}'='true';
