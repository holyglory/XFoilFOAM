-- Remote engine ids are instance-local. Namespace only rows that can be
-- attributed through a fulfilled promise point; rows without that provenance
-- remain untouched for review rather than being guessed.
DO $$
BEGIN
  IF EXISTS (
    SELECT point.result_id
    FROM sync_sweep_promise_points point
    JOIN sync_sweep_promises promise ON promise.id = point.promise_id
    JOIN results result ON result.id = point.result_id
    WHERE point.status = 'fulfilled'
      AND point.result_id IS NOT NULL
      AND result.engine_job_id IS NOT NULL
      AND result.engine_job_id NOT LIKE 'sync:%'
      AND promise.source_instance_id IS NOT NULL
      AND promise.source_instance_id ~ '^[A-Za-z0-9._-]{1,200}$'
      AND result.engine_job_id ~ '^[A-Za-z0-9._-]{1,200}$'
    GROUP BY point.result_id
    HAVING count(DISTINCT promise.source_instance_id) > 1
  ) THEN
    RAISE EXCEPTION
      '0051 refuses ambiguous remote result provenance; one result is attributed to multiple source instances';
  END IF;
END $$;
--> statement-breakpoint

CREATE TEMP TABLE remote_result_namespace_0051 ON COMMIT DROP AS
SELECT DISTINCT ON (result.id)
  result.id AS result_id,
  result.engine_job_id AS raw_engine_job_id,
  promise.source_instance_id,
  'sync:' || promise.source_instance_id || ':' || result.engine_job_id
    AS namespaced_engine_job_id
FROM results result
JOIN sync_sweep_promise_points point ON point.result_id = result.id
JOIN sync_sweep_promises promise ON promise.id = point.promise_id
WHERE result.engine_job_id IS NOT NULL
  AND result.engine_job_id NOT LIKE 'sync:%'
  AND point.status = 'fulfilled'
  AND promise.source_instance_id IS NOT NULL
  AND promise.source_instance_id ~ '^[A-Za-z0-9._-]{1,200}$'
  AND result.engine_job_id ~ '^[A-Za-z0-9._-]{1,200}$'
ORDER BY result.id, point."updatedAt" DESC, promise."createdAt" DESC, promise.id DESC;
--> statement-breakpoint

UPDATE result_attempts attempt
SET engine_job_id = namespace.namespaced_engine_job_id
FROM remote_result_namespace_0051 namespace
WHERE attempt.result_id = namespace.result_id
  AND attempt.sim_job_id IS NULL
  AND attempt.engine_job_id = namespace.raw_engine_job_id;
--> statement-breakpoint

UPDATE results result
SET engine_job_id = namespace.namespaced_engine_job_id,
    "updatedAt" = now()
FROM remote_result_namespace_0051 namespace
WHERE result.id = namespace.result_id
  AND result.engine_job_id = namespace.raw_engine_job_id;
--> statement-breakpoint

UPDATE solver_evidence_artifacts artifact
SET engine_job_id = namespace.namespaced_engine_job_id
FROM remote_result_namespace_0051 namespace
WHERE artifact.result_id = namespace.result_id
  AND artifact.engine_job_id = namespace.raw_engine_job_id;
--> statement-breakpoint

-- A duplicate key may be collapsed only when every immutable solver field is
-- byte/value-equivalent. Divergent evidence is a reviewable integrity problem,
-- never something a deploy migration may choose between silently.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM result_attempts attempt
    WHERE attempt.sim_job_id IS NULL
      AND attempt.engine_job_id ~ '^sync:[A-Za-z0-9._-]{1,200}:[A-Za-z0-9._-]{1,200}$'
    GROUP BY attempt.engine_job_id, attempt.aoa_deg, attempt.regime
    HAVING count(*) > 1
       AND count(DISTINCT jsonb_build_object(
         'result_id', attempt.result_id,
         'airfoil_id', attempt.airfoil_id,
         'bc_id', attempt.bc_id,
         'revision_id', attempt.simulation_preset_revision_id,
         'engine_case_slug', attempt.engine_case_slug,
         'status', attempt.status,
         'source', attempt.source,
         'valid_for_polar', attempt.valid_for_polar,
         'cl', attempt.cl,
         'cd', attempt.cd,
         'cm', attempt.cm,
         'cl_cd', attempt.cl_cd,
         'cl_std', attempt.cl_std,
         'cd_std', attempt.cd_std,
         'cm_std', attempt.cm_std,
         'stalled', attempt.stalled,
         'unsteady', attempt.unsteady,
         'converged', attempt.converged,
         'final_residual', attempt.final_residual,
         'iterations', attempt.iterations,
         'y_plus_avg', attempt.y_plus_avg,
         'y_plus_max', attempt.y_plus_max,
         'n_cells', attempt.n_cells,
         'first_order_fallback', attempt.first_order_fallback,
         'strouhal', attempt.strouhal,
         'error', attempt.error,
         'quality_warnings', attempt.quality_warnings,
         'evidence_payload', attempt.evidence_payload
       )) > 1
  ) THEN
    RAISE EXCEPTION
      '0051 refuses to collapse divergent remote result attempts; review conflicting evidence first';
  END IF;
END $$;
--> statement-breakpoint

-- Classifier rows are derived, but the migration must not silently select one
-- of two materially different stored verdicts. A lone verdict can be moved to
-- the keeper; multiple equivalent verdicts can be collapsed. Anything else
-- requires an explicit review/reclassification before the uniqueness fence is
-- installed.
DO $$
BEGIN
  IF EXISTS (
    SELECT attempt.engine_job_id, attempt.aoa_deg, attempt.regime
    FROM result_attempts attempt
    JOIN result_classifications classification
      ON classification.result_attempt_id = attempt.id
    WHERE attempt.sim_job_id IS NULL
      AND attempt.engine_job_id ~ '^sync:[A-Za-z0-9._-]{1,200}:[A-Za-z0-9._-]{1,200}$'
    GROUP BY attempt.engine_job_id, attempt.aoa_deg, attempt.regime
    HAVING count(*) > 1
       AND count(DISTINCT jsonb_build_object(
         'result_id', classification.result_id,
         'airfoil_id', classification.airfoil_id,
         'revision_id', classification.simulation_preset_revision_id,
         'aoa_deg', classification.aoa_deg,
         'regime', classification.regime,
         'classifier_version', classification.classifier_version,
         'state', classification.state,
         'region', classification.region,
         'confidence', classification.confidence,
         'reasons', classification.reasons,
         'superseded_by_result_id', classification.superseded_by_result_id
       )) > 1
  ) THEN
    RAISE EXCEPTION
      '0051 refuses to collapse divergent remote attempt classifications; review or reclassify first';
  END IF;
END $$;
--> statement-breakpoint

-- Pick the evidence-bearing duplicate first (all durable references count),
-- then newest attempt/id. Production incident 2026-07-11 had artifacts only
-- on the thirteenth/latest duplicate; oldest-first deletion would have erased
-- the actual immutable evidence owner.
CREATE TEMP TABLE remote_attempt_duplicates_0051 ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    attempt.id,
    first_value(attempt.id) OVER (
      PARTITION BY attempt.engine_job_id, attempt.aoa_deg, attempt.regime
      ORDER BY
        (
          (SELECT count(*) FROM solver_evidence_artifacts artifact
           WHERE artifact.result_attempt_id = attempt.id)
          + (SELECT count(*) FROM result_classifications classification
             WHERE classification.result_attempt_id = attempt.id)
          + (SELECT count(*) FROM sim_campaign_points campaign_point
             WHERE campaign_point.result_attempt_id = attempt.id)
          + (SELECT count(*) FROM sim_precalc_obligations obligation
             WHERE obligation.source_result_attempt_id = attempt.id)
          + (SELECT count(*) FROM sim_precalc_obligation_attempts obligation_attempt
             WHERE obligation_attempt.result_attempt_id = attempt.id)
          + (SELECT count(*) FROM remote_asset_references remote_reference
             WHERE remote_reference.result_attempt_id = attempt.id)
        ) DESC,
        attempt."createdAt" DESC,
        attempt.id DESC
    ) AS keeper_id,
    row_number() OVER (
      PARTITION BY attempt.engine_job_id, attempt.aoa_deg, attempt.regime
      ORDER BY
        (
          (SELECT count(*) FROM solver_evidence_artifacts artifact
           WHERE artifact.result_attempt_id = attempt.id)
          + (SELECT count(*) FROM result_classifications classification
             WHERE classification.result_attempt_id = attempt.id)
          + (SELECT count(*) FROM sim_campaign_points campaign_point
             WHERE campaign_point.result_attempt_id = attempt.id)
          + (SELECT count(*) FROM sim_precalc_obligations obligation
             WHERE obligation.source_result_attempt_id = attempt.id)
          + (SELECT count(*) FROM sim_precalc_obligation_attempts obligation_attempt
             WHERE obligation_attempt.result_attempt_id = attempt.id)
          + (SELECT count(*) FROM remote_asset_references remote_reference
             WHERE remote_reference.result_attempt_id = attempt.id)
        ) DESC,
        attempt."createdAt" DESC,
        attempt.id DESC
    ) AS ordinal
  FROM result_attempts attempt
  WHERE attempt.sim_job_id IS NULL
    AND attempt.engine_job_id ~ '^sync:[A-Za-z0-9._-]{1,200}:[A-Za-z0-9._-]{1,200}$'
)
SELECT id AS duplicate_id, keeper_id
FROM ranked
WHERE ordinal > 1;
--> statement-breakpoint

UPDATE solver_evidence_artifacts artifact
SET result_attempt_id = duplicate.keeper_id
FROM remote_attempt_duplicates_0051 duplicate
WHERE artifact.result_attempt_id = duplicate.duplicate_id;
--> statement-breakpoint

UPDATE sim_campaign_points campaign_point
SET result_attempt_id = duplicate.keeper_id,
    "updatedAt" = now()
FROM remote_attempt_duplicates_0051 duplicate
WHERE campaign_point.result_attempt_id = duplicate.duplicate_id;
--> statement-breakpoint

UPDATE sim_precalc_obligations obligation
SET source_result_attempt_id = duplicate.keeper_id,
    "updatedAt" = now()
FROM remote_attempt_duplicates_0051 duplicate
WHERE obligation.source_result_attempt_id = duplicate.duplicate_id;
--> statement-breakpoint

UPDATE sim_precalc_obligation_attempts obligation_attempt
SET result_attempt_id = duplicate.keeper_id,
    "updatedAt" = now()
FROM remote_attempt_duplicates_0051 duplicate
WHERE obligation_attempt.result_attempt_id = duplicate.duplicate_id;
--> statement-breakpoint

UPDATE remote_asset_references remote_reference
SET result_attempt_id = duplicate.keeper_id,
    "updatedAt" = now()
FROM remote_attempt_duplicates_0051 duplicate
WHERE remote_reference.result_attempt_id = duplicate.duplicate_id;
--> statement-breakpoint

-- At most one immutable classification represents one physical remote solve.
-- Prefer the keeper's own verdict; otherwise move the newest duplicate verdict
-- before deleting the redundant classifications.
WITH movable AS (
  SELECT DISTINCT ON (duplicate.keeper_id)
    classification.id,
    duplicate.keeper_id
  FROM remote_attempt_duplicates_0051 duplicate
  JOIN result_classifications classification
    ON classification.result_attempt_id = duplicate.duplicate_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM result_classifications keeper_classification
    WHERE keeper_classification.result_attempt_id = duplicate.keeper_id
  )
  ORDER BY duplicate.keeper_id,
           classification."updatedAt" DESC,
           classification.id DESC
)
UPDATE result_classifications classification
SET result_attempt_id = movable.keeper_id,
    "updatedAt" = now()
FROM movable
WHERE classification.id = movable.id;
--> statement-breakpoint

DELETE FROM result_classifications classification
USING remote_attempt_duplicates_0051 duplicate
WHERE classification.result_attempt_id = duplicate.duplicate_id;
--> statement-breakpoint

DELETE FROM result_attempts attempt
USING remote_attempt_duplicates_0051 duplicate
WHERE attempt.id = duplicate.duplicate_id;
--> statement-breakpoint

ALTER TABLE result_attempts
  ADD CONSTRAINT result_attempts_remote_regime_required_check
  CHECK (
    NOT (
      sim_job_id IS NULL
      AND engine_job_id ~ '^sync:[A-Za-z0-9._-]{1,200}:[A-Za-z0-9._-]{1,200}$'
    )
    OR regime IS NOT NULL
  );
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS result_attempts_remote_engine_aoa_regime_uq
  ON result_attempts (engine_job_id, aoa_deg, regime)
  WHERE sim_job_id IS NULL
    AND engine_job_id ~ '^sync:[A-Za-z0-9._-]{1,200}:[A-Za-z0-9._-]{1,200}$';
