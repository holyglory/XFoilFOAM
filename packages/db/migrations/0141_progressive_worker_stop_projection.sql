ALTER TABLE progressive_worker_reports
ADD COLUMN assignment_signature text GENERATED ALWAYS AS (report->>'assignmentSignature') STORED,
ADD COLUMN stopped_engine_job_id text GENERATED ALWAYS AS (
  CASE WHEN report#>>'{stopProof,execution_stopped}' = 'true'
    THEN report#>>'{stopProof,job_id}' END
) STORED;
--> statement-breakpoint
CREATE INDEX progressive_worker_reports_stop_identity_idx
ON progressive_worker_reports (sim_job_id, assignment_signature, stopped_engine_job_id)
WHERE stopped_engine_job_id IS NOT NULL;
