-- Verification and result ingestion can race on different transactions. Both
-- paths take this same transaction-level advisory lock, then inspect the
-- opposing owner, so a terminal quarantine can never become verified beside a
-- result or result_attempt for the same engine job.
CREATE OR REPLACE FUNCTION enforce_brokered_terminal_evidence_zero_result()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."state" = 'verified' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('remote-terminal-evidence-engine:' || NEW.engine_job_id, 0)
    );
    IF EXISTS (
      SELECT 1
      FROM results result_row
      WHERE result_row.engine_job_id = NEW.engine_job_id
    ) OR EXISTS (
      SELECT 1
      FROM result_attempts attempt_row
      WHERE attempt_row.engine_job_id = NEW.engine_job_id
    ) THEN
      RAISE EXCEPTION 'verified terminal evidence quarantine requires no result or result-attempt';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_result_ownership_of_verified_terminal_quarantine()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.engine_job_id IS NULL OR btrim(NEW.engine_job_id) = '' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('remote-terminal-evidence-engine:' || NEW.engine_job_id, 0)
  );
  IF EXISTS (
    SELECT 1
    FROM sync_brokered_terminal_evidence_uploads quarantine
    WHERE quarantine.engine_job_id = NEW.engine_job_id
      AND quarantine.state = 'verified'
  ) THEN
    RAISE EXCEPTION 'result or result-attempt cannot own a verified terminal evidence quarantine engine job';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "results_verified_terminal_quarantine_owner_fence"
  ON results;--> statement-breakpoint
CREATE TRIGGER "results_verified_terminal_quarantine_owner_fence"
BEFORE INSERT OR UPDATE ON results
FOR EACH ROW EXECUTE FUNCTION prevent_result_ownership_of_verified_terminal_quarantine();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "result_attempts_verified_terminal_quarantine_owner_fence"
  ON result_attempts;--> statement-breakpoint
CREATE TRIGGER "result_attempts_verified_terminal_quarantine_owner_fence"
BEFORE INSERT OR UPDATE ON result_attempts
FOR EACH ROW EXECUTE FUNCTION prevent_result_ownership_of_verified_terminal_quarantine();
--> statement-breakpoint

CREATE INDEX "sync_brokered_terminal_evidence_uploads_verified_engine_job_idx"
  ON "sync_brokered_terminal_evidence_uploads" ("engine_job_id")
  WHERE "state" = 'verified';
