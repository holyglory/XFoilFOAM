-- Migration-era PRECALC rows can be terminally rejected before the older
-- controller consumed the second physical slot.  Preserve that history and
-- allow one source-pinned remediation generation for the explicit terminal
-- outcome; do not infer exhaustion from an arbitrary blocked row.
CREATE OR REPLACE FUNCTION "validate_precalc_remediation_grant"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  obligation_state text;
  obligation_attempt_count integer;
  obligation_max_attempts integer;
  obligation_last_outcome text;
BEGIN
  SELECT "state", "attempt_count", "max_attempts", "last_outcome"
  INTO obligation_state, obligation_attempt_count, obligation_max_attempts,
       obligation_last_outcome
  FROM "sim_precalc_obligations"
  WHERE "id" = NEW."obligation_id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'precalc remediation obligation % does not exist',
      NEW."obligation_id";
  END IF;
  IF obligation_state <> 'blocked'
     OR (
       obligation_attempt_count <> obligation_max_attempts
       AND obligation_last_outcome NOT IN (
         'rejected_exhausted', 'failed_exhausted', 'cancelled_exhausted'
       )
     ) THEN
    RAISE EXCEPTION
      'precalc remediation requires an exhausted blocked obligation or explicit legacy-terminal blocked obligation (state %, attempts %/%, outcome %)',
      obligation_state, obligation_attempt_count, obligation_max_attempts,
      obligation_last_outcome;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "apply_precalc_remediation_grant"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "sim_precalc_obligations"
  SET
    "remediation_attempts_granted" = "remediation_attempts_granted" + 1,
    "max_attempts" = "max_attempts" + 1,
    "remediation_reason" = NEW."reason",
    "remediation_source_revision" = NEW."source_revision",
    "remediation_granted_at" = NEW."granted_at",
    "state" = 'pending',
    "next_submit_at" = now(),
    "latest_sim_job_id" = NULL,
    "last_outcome" = 'corrective_engine_fix_retry_pending',
    "last_error" = NULL,
    "completed_at" = NULL,
    "updatedAt" = now()
  WHERE "id" = NEW."obligation_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'precalc remediation obligation % disappeared',
      NEW."obligation_id";
  END IF;
  RETURN NEW;
END;
$$;
