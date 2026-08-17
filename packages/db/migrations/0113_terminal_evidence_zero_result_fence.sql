-- A job-level terminal receipt protects only a genuinely result-less,
-- attempt-less remote job tree.  Rejected evidence is still result-owned
-- forensic material and may carry a restartable PRECALC checkpoint, so it
-- must remain on the normal result/attempt recovery and broker path.
CREATE OR REPLACE FUNCTION enforce_remote_terminal_evidence_receipt_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_row sim_jobs%ROWTYPE;
BEGIN
  SELECT * INTO job_row FROM sim_jobs WHERE id = NEW."sim_job_id";
  IF NOT FOUND
     OR job_row."engine_job_id" IS DISTINCT FROM NEW."engine_job_id"
     OR job_row."request_payload" ->> 'syncPromiseId' IS DISTINCT FROM NEW."promise_id"::text
     OR job_row."request_payload" ->> 'remoteSolver' IS DISTINCT FROM 'true'
     OR job_row."status" NOT IN ('done', 'failed', 'cancelled')
     OR NEW."receipt" ->> 'terminalState' IS DISTINCT FROM job_row."status"::text THEN
    RAISE EXCEPTION 'terminal preservation receipt is not scoped to its exact terminal remote job';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM results result_row
    WHERE result_row.sim_job_id = NEW."sim_job_id"
       OR result_row.engine_job_id = NEW."engine_job_id"
  ) OR EXISTS (
    SELECT 1
    FROM result_attempts attempt_row
    WHERE attempt_row.sim_job_id = NEW."sim_job_id"
       OR attempt_row.engine_job_id = NEW."engine_job_id"
  ) THEN
    RAISE EXCEPTION 'terminal preservation receipt requires a job with no result or result-attempt';
  END IF;
  RETURN NEW;
END;
$$;
