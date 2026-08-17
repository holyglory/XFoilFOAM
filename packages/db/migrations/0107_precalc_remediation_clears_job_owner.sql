-- A remediation grant reopens an exhausted PRECALC obligation for one fresh
-- physical generation.  The previous terminal job must no longer remain the
-- submission owner: leaving latest_sim_job_id populated makes the normal
-- scheduler treat the reopened obligation as already owned and silently
-- strands the grant.
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
    "last_outcome" = 'corrective_engine_fix_retry_pending',
    "last_error" = NULL,
    "completed_at" = NULL,
    "latest_sim_job_id" = NULL,
    "updatedAt" = now()
  WHERE "id" = NEW."obligation_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'precalc remediation obligation % disappeared',
      NEW."obligation_id";
  END IF;
  RETURN NEW;
END;
$$;
