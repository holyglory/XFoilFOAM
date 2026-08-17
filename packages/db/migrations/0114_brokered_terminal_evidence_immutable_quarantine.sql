-- A hub terminal-evidence row is a job-level quarantine record, not canonical
-- solver evidence.  Once the engine has authenticated an exact GCS generation,
-- its identity is the deletion authority that a remote receipt references.
-- Do not let an accepted result/attempt share that engine job identity at the
-- verification transition.
CREATE OR REPLACE FUNCTION enforce_brokered_terminal_evidence_zero_result()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."state" = 'verified' AND (
    EXISTS (
      SELECT 1
      FROM results result_row
      WHERE result_row.engine_job_id = NEW.engine_job_id
    )
    OR EXISTS (
      SELECT 1
      FROM result_attempts attempt_row
      WHERE attempt_row.engine_job_id = NEW.engine_job_id
    )
  ) THEN
    RAISE EXCEPTION 'verified terminal evidence quarantine requires no result or result-attempt';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "sync_brokered_terminal_evidence_uploads_zero_result_fence"
  ON "sync_brokered_terminal_evidence_uploads";--> statement-breakpoint
CREATE TRIGGER "sync_brokered_terminal_evidence_uploads_zero_result_fence"
BEFORE INSERT OR UPDATE ON "sync_brokered_terminal_evidence_uploads"
FOR EACH ROW EXECUTE FUNCTION enforce_brokered_terminal_evidence_zero_result();
--> statement-breakpoint

-- A verified quarantine is immutable as a whole.  In particular, it cannot
-- leave the verified state or be retargeted to a different object/generation
-- after a remote solver has received its signed preservation receipt.
CREATE OR REPLACE FUNCTION prevent_verified_brokered_terminal_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."state" = 'verified' THEN
    RAISE EXCEPTION 'verified terminal evidence quarantine is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "sync_brokered_terminal_evidence_uploads_immutable_verified"
  ON "sync_brokered_terminal_evidence_uploads";--> statement-breakpoint
CREATE TRIGGER "sync_brokered_terminal_evidence_uploads_immutable_verified"
BEFORE UPDATE ON "sync_brokered_terminal_evidence_uploads"
FOR EACH ROW EXECUTE FUNCTION prevent_verified_brokered_terminal_evidence_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_verified_brokered_terminal_evidence_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."state" = 'verified' THEN
    RAISE EXCEPTION 'verified terminal evidence quarantine is immutable';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "sync_brokered_terminal_evidence_uploads_no_verified_delete"
  ON "sync_brokered_terminal_evidence_uploads";--> statement-breakpoint
CREATE TRIGGER "sync_brokered_terminal_evidence_uploads_no_verified_delete"
BEFORE DELETE ON "sync_brokered_terminal_evidence_uploads"
FOR EACH ROW EXECUTE FUNCTION prevent_verified_brokered_terminal_evidence_delete();
