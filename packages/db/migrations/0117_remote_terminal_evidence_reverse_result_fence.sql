-- A remote receipt is deletion authority for one exact no-result job tree.
-- Receipt insertion and delayed result ingestion can race on separate
-- transactions, so both directions take the same engine-identity advisory
-- lock and inspect the opposing owner.  Once a signed receipt exists, that
-- remote job remains immutable blob-only quarantine evidence.
-- Acquire every DML-conflicting lock before the compatibility scan. Without
-- this early fence, delayed ingest could commit after the DO snapshot but
-- before trigger creation and leave split receipt/result ownership.
LOCK TABLE sync_remote_terminal_evidence_receipts,
  results,
  result_attempts,
  sim_jobs
IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_remote_terminal_evidence_receipt_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_row sim_jobs%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('remote-terminal-evidence-engine:' || NEW.engine_job_id, 0)
  );

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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_result_ownership_of_remote_terminal_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_engine_id text;
  lock_engine_id text;
BEGIN
  IF NEW.sim_job_id IS NOT NULL THEN
    SELECT engine_job_id INTO job_engine_id
    FROM sim_jobs
    WHERE id = NEW.sim_job_id;
  END IF;

  -- A malformed/mismatched incoming row is still serialized against every
  -- identity by which it could collide with the exact receipt.  Deterministic
  -- ordering prevents two-key updates from introducing a lock inversion.
  FOR lock_engine_id IN
    SELECT DISTINCT candidate
    FROM (VALUES
      (NULLIF(btrim(NEW.engine_job_id), '')),
      (NULLIF(btrim(job_engine_id), ''))
    ) AS candidates(candidate)
    WHERE candidate IS NOT NULL
    ORDER BY candidate
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('remote-terminal-evidence-engine:' || lock_engine_id, 0)
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM sync_remote_terminal_evidence_receipts quarantine
    WHERE (NEW.sim_job_id IS NOT NULL AND quarantine.sim_job_id = NEW.sim_job_id)
       OR (
         NULLIF(btrim(NEW.engine_job_id), '') IS NOT NULL
         AND quarantine.engine_job_id = NEW.engine_job_id
       )
       OR (
         NULLIF(btrim(job_engine_id), '') IS NOT NULL
         AND quarantine.engine_job_id = job_engine_id
       )
  ) THEN
    RAISE EXCEPTION 'result or result-attempt cannot own a signed remote terminal evidence receipt';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Fail the migration rather than installing a fence around an already split
-- ownership state.  Such a row requires evidence-preserving investigation.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM sync_remote_terminal_evidence_receipts quarantine
    WHERE EXISTS (
      SELECT 1 FROM results result_row
      WHERE result_row.sim_job_id = quarantine.sim_job_id
         OR result_row.engine_job_id = quarantine.engine_job_id
    ) OR EXISTS (
      SELECT 1 FROM result_attempts attempt_row
      WHERE attempt_row.sim_job_id = quarantine.sim_job_id
         OR attempt_row.engine_job_id = quarantine.engine_job_id
    )
  ) THEN
    RAISE EXCEPTION 'signed remote terminal evidence receipt already conflicts with result ownership';
  END IF;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "results_remote_terminal_receipt_owner_fence"
  ON results;
--> statement-breakpoint
CREATE TRIGGER "results_remote_terminal_receipt_owner_fence"
BEFORE INSERT OR UPDATE ON results
FOR EACH ROW EXECUTE FUNCTION prevent_result_ownership_of_remote_terminal_receipt();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "result_attempts_remote_terminal_receipt_owner_fence"
  ON result_attempts;
--> statement-breakpoint
CREATE TRIGGER "result_attempts_remote_terminal_receipt_owner_fence"
BEFORE INSERT OR UPDATE ON result_attempts
FOR EACH ROW EXECUTE FUNCTION prevent_result_ownership_of_remote_terminal_receipt();
