CREATE INDEX IF NOT EXISTS progressive_worker_reports_final_stop_identity_idx
  ON progressive_worker_reports(sim_job_id, assignment_signature, stopped_engine_job_id)
  WHERE stopped_engine_job_id IS NOT NULL
    AND (
      report#>>'{stopProof,ownership_basis}' = 'never_started_cancellation_fence'
      OR report#>>'{result,state}' IN ('completed', 'failed', 'cancelled')
      OR (
        report->'result' = 'null'::jsonb
        AND report#>>'{status,state}' = 'failed'
        AND report#>>'{status,total_cases}' = '0'
        AND report#>>'{status,completed_cases}' = '0'
        AND report#>>'{status,failure_disposition}' IN ('deterministic_mesh', 'infrastructure')
      )
    );
