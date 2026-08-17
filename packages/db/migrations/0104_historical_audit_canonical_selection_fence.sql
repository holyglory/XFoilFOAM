-- Historical released-evidence audit interpretations are immutable scientific
-- receipts, not publication candidates.  The application admission path
-- already keeps them out of canonical selection; this forward-only database
-- fence closes the equivalent direct-SQL paths without changing any recorded
-- interpretation, selection, or result pointer.
-- Existing non-audit sources remain valid canonical candidates.  In
-- particular, this must not collapse engine-reported, archive-backfill,
-- continuation, or corrective-generation selection paths into one source.
--
-- A pre-fence direct writer could already have installed an otherwise-valid
-- selection and projected it onto a result.  Do not silently leave that
-- historical-audit evidence public merely because this migration prevents only
-- future writes.  The result lock closes the check/validator replacement race:
-- while this migration is installing, no writer can publish a new current
-- projection.  Standalone old audit selections remain immutable forensic
-- records and are deliberately not rejected here.
DO $$
BEGIN
  LOCK TABLE "results" IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1
    FROM "results" result
    JOIN "result_canonical_selections" selection
      ON selection."id" = result."current_canonical_selection_id"
     AND selection."result_id" = result."id"
    JOIN "result_interpretations" interpretation
      ON interpretation."id" = selection."result_interpretation_id"
     AND interpretation."result_id" = selection."result_id"
     AND interpretation."result_attempt_id" = selection."result_attempt_id"
    WHERE interpretation."source" = 'historical_archive_audit'
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = '0104 migration blocked: a current result projects a historical archive audit interpretation',
      HINT = 'Clear or rebuild the current result projection through the repair workflow, then retry. Standalone historical audit selections may remain forensic records.';
  END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "validate_result_canonical_selection"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  interpretation_state "result_interpretation_state";
  interpretation_source text;
BEGIN
  SELECT "state", "source"
  INTO interpretation_state, interpretation_source
  FROM "result_interpretations"
  WHERE "id" = NEW."result_interpretation_id"
    AND "result_attempt_id" = NEW."result_attempt_id"
    AND "result_id" = NEW."result_id";

  IF NOT FOUND OR interpretation_state NOT IN ('accepted', 'legacy_uncertified') THEN
    RAISE EXCEPTION 'canonical selection requires an accepted or legacy interpretation';
  END IF;

  IF interpretation_source = 'historical_archive_audit' THEN
    RAISE EXCEPTION
      'canonical selection cannot reference a historical archive audit interpretation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- A selection can be historically present from before this fence (or from a
-- controlled forensic import), so protect the result projection separately.
-- The projection must name the selected attempt as well as the selection and
-- interpretation; otherwise a direct writer could attach an old selection to
-- a different current generation.
CREATE OR REPLACE FUNCTION "validate_result_interpretation_projection"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_interpretation_source text;
BEGIN
  IF NEW."current_result_interpretation_id" IS NULL
     AND NEW."current_canonical_selection_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."current_result_interpretation_id" IS NULL
     OR NEW."current_canonical_selection_id" IS NULL THEN
    RAISE EXCEPTION 'result current interpretation and selection pointers must be set or cleared together';
  END IF;

  IF NEW."current_result_attempt_id" IS NULL THEN
    RAISE EXCEPTION
      'result current attempt must match its canonical selection when interpretation pointers are set';
  END IF;

  SELECT interpretation."source"
  INTO selected_interpretation_source
  FROM "result_canonical_selections" selection
  JOIN "result_interpretations" interpretation
    ON interpretation."id" = selection."result_interpretation_id"
   AND interpretation."result_id" = selection."result_id"
   AND interpretation."result_attempt_id" = selection."result_attempt_id"
  WHERE selection."id" = NEW."current_canonical_selection_id"
    AND selection."result_id" = NEW."id"
    AND selection."result_attempt_id" = NEW."current_result_attempt_id"
    AND selection."result_interpretation_id" = NEW."current_result_interpretation_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'result current attempt, interpretation, and selection must match one canonical selection';
  END IF;

  IF selected_interpretation_source = 'historical_archive_audit' THEN
    RAISE EXCEPTION
      'result projection cannot reference a historical archive audit interpretation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 0096 originally subscribed this projection validator only to the two
-- interpretation/selection pointers.  That leaves a direct writer able to
-- change just `current_result_attempt_id` after a valid projection has been
-- installed, silently detaching the public result from the selected attempt.
-- Recreate rather than alter the trigger: PostgreSQL has no ALTER TRIGGER
-- form for its UPDATE OF column list.  Keep INSERT coverage so a newly
-- created result is checked by exactly the same complete-pointer contract.
DROP TRIGGER IF EXISTS "results_validate_interpretation_projection" ON "results";
--> statement-breakpoint

CREATE TRIGGER "results_validate_interpretation_projection"
BEFORE INSERT OR UPDATE OF
  "current_result_attempt_id",
  "current_result_interpretation_id",
  "current_canonical_selection_id"
ON "results"
FOR EACH ROW EXECUTE FUNCTION "validate_result_interpretation_projection"();
