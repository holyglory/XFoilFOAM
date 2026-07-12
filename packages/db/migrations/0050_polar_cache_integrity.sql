-- Restartable wall-budget/continuation URANS is immutable attempt evidence,
-- not a publishable point.  Downgrade any legacy classifications that were
-- accepted before the quality-warning marker became a classifier input.

UPDATE "result_classifications" rc
SET "state" = 'rejected',
    "region" = 'unknown',
    "confidence" = 1,
    "reasons" = ARRAY(
      SELECT DISTINCT unnest(
        coalesce(rc."reasons", ARRAY[]::text[])
        || ARRAY['incomplete-urans-integration']::text[]
      )
    ),
    "classifier_version" = 'fidelity-ladder-v5',
    "superseded_by_result_id" = NULL,
    "updatedAt" = now()
FROM "results" r
WHERE rc."result_id" = r."id"
  AND r."regime" = 'urans'
  AND EXISTS (
    SELECT 1
    FROM unnest(coalesce(r."quality_warnings", ARRAY[]::text[])) AS warning
    WHERE warning LIKE '%stopped by the wall-clock budget guard%'
       OR warning LIKE '%requires further same-case integration%'
  );
--> statement-breakpoint

UPDATE "result_classifications" rc
SET "state" = 'rejected',
    "region" = 'unknown',
    "confidence" = 1,
    "reasons" = ARRAY(
      SELECT DISTINCT unnest(
        coalesce(rc."reasons", ARRAY[]::text[])
        || ARRAY['incomplete-urans-integration']::text[]
      )
    ),
    "classifier_version" = 'fidelity-ladder-v5',
    "superseded_by_result_id" = NULL,
    "updatedAt" = now()
FROM "result_attempts" ra
WHERE rc."result_attempt_id" = ra."id"
  AND ra."regime" = 'urans'
  AND EXISTS (
    SELECT 1
    FROM unnest(coalesce(ra."quality_warnings", ARRAY[]::text[])) AS warning
    WHERE warning LIKE '%stopped by the wall-clock budget guard%'
       OR warning LIKE '%requires further same-case integration%'
  );
--> statement-breakpoint

-- Readers pin both provenance versions.  Retire old current artifacts now so
-- no unrefreshed v4/v2 cache can be mistaken for the new classifier output.
UPDATE "polar_fit_sets"
SET "is_current" = false,
    "updatedAt" = now()
WHERE "is_current" = true
  AND "fit_version" <> 'evidence-lowess-v5';
--> statement-breakpoint

UPDATE "polar_compatibility_fit_sets"
SET "is_current" = false,
    "updatedAt" = now()
WHERE "is_current" = true
  AND (
    "compatibility_version" <> 'polar-compat-v3'
    OR "fit_version" <> 'evidence-lowess-v5'
  );
--> statement-breakpoint

-- Historical application races could leave more than one current revision
-- fit.  Keep the newest deterministically before enforcing the invariant in
-- the database; normal refreshes additionally serialize on an advisory lock.
WITH ranked_current AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "airfoil_id", "simulation_preset_revision_id"
      ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
    ) AS rn
  FROM "polar_fit_sets"
  WHERE "is_current" = true
)
UPDATE "polar_fit_sets" pfs
SET "is_current" = false,
    "updatedAt" = now()
FROM ranked_current ranked
WHERE pfs."id" = ranked."id"
  AND ranked.rn > 1;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "polar_fit_sets_current_uq"
  ON "polar_fit_sets" ("airfoil_id", "simulation_preset_revision_id")
  WHERE "is_current" = true;
