-- Reassert the exact-generation publication invariant after the 0056 rollout.
-- A post-migration classifier refresh could change a selected attempt from
-- accepted to rejected (notably when default URANS video was missing) without
-- clearing the one-time-cleaned pointer. These statements are deliberately
-- idempotent: rerunning them only touches currently invalid selections.

-- 0056 could only act on the classification snapshot it received. Detect the
-- physical selected-attempt media gate directly so legacy result-scoped video
-- cannot keep an exact URANS generation looking accepted. Preserve any other
-- rejection reasons; a previously accepted row gets the sole repairable reason.
WITH missing_selected_urans AS (
  SELECT
    result.id AS result_id,
    result.airfoil_id,
    result.simulation_preset_revision_id,
    attempt.id AS result_attempt_id,
    attempt.aoa_deg,
    attempt.regime
  FROM results result
  JOIN result_attempts attempt
    ON attempt.id = result.current_result_attempt_id
   AND attempt.result_id = result.id
  WHERE attempt.regime = 'urans'
    AND NOT EXISTS (
      SELECT 1
      FROM result_media media
      WHERE media.result_id = result.id
        AND media.result_attempt_id = attempt.id
        AND media.kind = 'video'
        AND media.role = 'instantaneous'
        AND media.mime_type LIKE 'video/%'
        AND media.sha256 ~ '^[0-9a-fA-F]{64}$'
        AND media.byte_size > 0
        AND length(trim(media.storage_key)) > 0
    )
)
INSERT INTO result_classifications (
  result_attempt_id, airfoil_id, simulation_preset_revision_id, aoa_deg,
  regime, classifier_version, state, region, confidence, reasons,
  superseded_by_result_id, "updatedAt"
)
SELECT
  missing.result_attempt_id,
  missing.airfoil_id,
  missing.simulation_preset_revision_id,
  missing.aoa_deg,
  missing.regime,
  '0057-exact-video-gate-v1',
  'rejected',
  'unknown',
  1,
  ARRAY['missing-urans-video']::text[],
  NULL,
  now()
FROM missing_selected_urans missing
ON CONFLICT (result_attempt_id) DO UPDATE SET
  regime = EXCLUDED.regime,
  classifier_version = EXCLUDED.classifier_version,
  state = 'rejected',
  region = 'unknown',
  confidence = 1,
  reasons = ARRAY(
    SELECT DISTINCT reason
    FROM unnest(
      result_classifications.reasons || ARRAY['missing-urans-video']::text[]
    ) reason
    ORDER BY reason
  ),
  superseded_by_result_id = NULL,
  "updatedAt" = now();
--> statement-breakpoint

-- The runtime classifier reads force history from the immutable exact attempt
-- payload, never from legacy result-level force_history rows. Reassert that
-- ownership gate independently of video so an accepted selected URANS attempt
-- with present media but absent/malformed coefficient arrays also fails closed.
WITH selected_urans AS (
  SELECT
    result.id AS result_id,
    result.airfoil_id,
    result.simulation_preset_revision_id,
    attempt.id AS result_attempt_id,
    attempt.aoa_deg,
    attempt.regime,
    COALESCE(
      NULLIF(attempt.evidence_payload -> 'force_history', 'null'::jsonb),
      attempt.evidence_payload -> 'forceHistory'
    ) AS force_payload
  FROM results result
  JOIN result_attempts attempt
    ON attempt.id = result.current_result_attempt_id
   AND attempt.result_id = result.id
  WHERE attempt.regime = 'urans'
), missing_selected_urans_force AS (
  SELECT *
  FROM selected_urans selected
  WHERE NOT COALESCE(
    jsonb_typeof(selected.force_payload) = 'object'
    AND CASE
      WHEN jsonb_typeof(selected.force_payload -> 't') = 'array'
      THEN jsonb_array_length(selected.force_payload -> 't') > 0
      ELSE false
    END
    AND CASE
      WHEN jsonb_typeof(selected.force_payload -> 'cl') = 'array'
      THEN jsonb_array_length(selected.force_payload -> 'cl') > 0
      ELSE false
    END
    AND CASE
      WHEN jsonb_typeof(selected.force_payload -> 'cd') = 'array'
      THEN jsonb_array_length(selected.force_payload -> 'cd') > 0
      ELSE false
    END,
    false
  )
)
INSERT INTO result_classifications (
  result_attempt_id, airfoil_id, simulation_preset_revision_id, aoa_deg,
  regime, classifier_version, state, region, confidence, reasons,
  superseded_by_result_id, "updatedAt"
)
SELECT
  missing.result_attempt_id,
  missing.airfoil_id,
  missing.simulation_preset_revision_id,
  missing.aoa_deg,
  missing.regime,
  '0057-exact-force-gate-v1',
  'rejected',
  'unknown',
  1,
  ARRAY['missing-force-history']::text[],
  NULL,
  now()
FROM missing_selected_urans_force missing
ON CONFLICT (result_attempt_id) DO UPDATE SET
  regime = EXCLUDED.regime,
  classifier_version = EXCLUDED.classifier_version,
  state = 'rejected',
  region = 'unknown',
  confidence = 1,
  reasons = ARRAY(
    SELECT DISTINCT reason
    FROM unnest(
      result_classifications.reasons || ARRAY['missing-force-history']::text[]
    ) reason
    ORDER BY reason
  ),
  superseded_by_result_id = NULL,
  "updatedAt" = now();
--> statement-breakpoint

-- Preserve the exact attempt as bounded output-repair work before withdrawing
-- it from public truth. Only one valid attempt-owned manifest can create or
-- retarget an obligation; ambiguous raw evidence remains immutable history.
WITH repairable AS (
  SELECT
    result.id AS result_id,
    attempt.id AS result_attempt_id,
    CASE
      WHEN producing_job.id IS NULL THEN true
      WHEN producing_job.campaign_id IS NOT NULL THEN false
      WHEN producing_job.request_payload ? 'verifyQueueItemId' THEN COALESCE((
        SELECT verify_item.background_owner
        FROM sim_urans_verify_queue verify_item
        WHERE verify_item.id::text = producing_job.request_payload ->> 'verifyQueueItemId'
      ), false)
      WHEN producing_job.request_payload ? 'uransRequestId' THEN COALESCE((
        SELECT request_item.background_owner
        FROM sim_urans_requests request_item
        WHERE request_item.id::text = producing_job.request_payload ->> 'uransRequestId'
      ), false)
      ELSE true
    END AS background_owner,
    concat_ws(':',
      COALESCE(attempt.engine_job_id, ''),
      COALESCE(attempt.engine_case_slug, ''),
      manifest.sha256
    ) AS evidence_signature
  FROM results result
  JOIN result_attempts attempt
    ON attempt.id = result.current_result_attempt_id
   AND attempt.result_id = result.id
  JOIN result_classifications classification
    ON classification.result_attempt_id = attempt.id
   AND classification.state = 'rejected'
   AND classification.reasons = ARRAY['missing-urans-video']::text[]
  JOIN LATERAL (
    SELECT min(artifact.sha256) AS sha256
    FROM solver_evidence_artifacts artifact
    WHERE artifact.result_id = result.id
      AND artifact.result_attempt_id = attempt.id
      AND artifact.kind = 'manifest'
    HAVING count(*) = 1
       AND bool_and(
         artifact.airfoil_id = result.airfoil_id
         AND artifact.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
         AND artifact.sim_job_id IS NOT DISTINCT FROM attempt.sim_job_id
         AND artifact.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
         AND artifact.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
         AND artifact.sha256 ~ '^[0-9a-fA-F]{64}$'
         AND artifact.byte_size > 0
         AND length(trim(artifact.storage_key)) > 0
         AND length(trim(artifact.mime_type)) > 0
       )
  ) manifest ON true
  LEFT JOIN sim_jobs producing_job ON producing_job.id = attempt.sim_job_id
  WHERE attempt.status = 'done'
    AND attempt.source = 'solved'
    AND jsonb_typeof(COALESCE(
      NULLIF(attempt.evidence_payload -> 'force_history', 'null'::jsonb),
      attempt.evidence_payload -> 'forceHistory'
    )) = 'object'
    AND jsonb_typeof(COALESCE(
      NULLIF(attempt.evidence_payload -> 'force_history', 'null'::jsonb),
      attempt.evidence_payload -> 'forceHistory'
    ) -> 't') = 'array'
    AND jsonb_typeof(COALESCE(
      NULLIF(attempt.evidence_payload -> 'force_history', 'null'::jsonb),
      attempt.evidence_payload -> 'forceHistory'
    ) -> 'cl') = 'array'
    AND jsonb_typeof(COALESCE(
      NULLIF(attempt.evidence_payload -> 'force_history', 'null'::jsonb),
      attempt.evidence_payload -> 'forceHistory'
    ) -> 'cd') = 'array'
    AND jsonb_array_length(COALESCE(
      NULLIF(attempt.evidence_payload -> 'force_history', 'null'::jsonb),
      attempt.evidence_payload -> 'forceHistory'
    ) -> 't') > 0
    AND jsonb_array_length(COALESCE(
      NULLIF(attempt.evidence_payload -> 'force_history', 'null'::jsonb),
      attempt.evidence_payload -> 'forceHistory'
    ) -> 'cl') > 0
    AND jsonb_array_length(COALESCE(
      NULLIF(attempt.evidence_payload -> 'force_history', 'null'::jsonb),
      attempt.evidence_payload -> 'forceHistory'
    ) -> 'cd') > 0
)
INSERT INTO result_media_repairs (
  result_id, result_attempt_id, state, evidence_signature, background_owner,
  attempt_count, max_attempts, next_attempt_at, last_error, claim_token,
  claimed_at, claim_expires_at, completed_at, downstream_finalized_at,
  "updatedAt"
)
SELECT
  repairable.result_id, repairable.result_attempt_id, 'pending',
  repairable.evidence_signature, repairable.background_owner,
  0, 3, now(), NULL, NULL, NULL, NULL, NULL, NULL, now()
FROM repairable
ON CONFLICT (result_id) DO UPDATE SET
  result_attempt_id = EXCLUDED.result_attempt_id,
  state = CASE
    WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
      OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
      OR result_media_repairs.state = 'done'
    THEN 'pending'
    ELSE result_media_repairs.state
  END,
  evidence_signature = EXCLUDED.evidence_signature,
  background_owner = result_media_repairs.background_owner OR EXCLUDED.background_owner,
  attempt_count = CASE
    WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
      OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
      OR result_media_repairs.state = 'done'
    THEN 0
    ELSE result_media_repairs.attempt_count
  END,
  max_attempts = CASE
    WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
      OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
      OR result_media_repairs.state = 'done'
    THEN 3
    ELSE result_media_repairs.max_attempts
  END,
  next_attempt_at = CASE
    WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
      OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
      OR result_media_repairs.state = 'done'
    THEN now()
    ELSE result_media_repairs.next_attempt_at
  END,
  last_error = CASE
    WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
      OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
      OR result_media_repairs.state = 'done'
    THEN NULL
    ELSE result_media_repairs.last_error
  END,
  claim_token = CASE
    WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
      OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
      OR result_media_repairs.state = 'done'
    THEN NULL
    ELSE result_media_repairs.claim_token
  END,
  claimed_at = CASE
    WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
      OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
      OR result_media_repairs.state = 'done'
    THEN NULL
    ELSE result_media_repairs.claimed_at
  END,
  claim_expires_at = CASE
    WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
      OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
      OR result_media_repairs.state = 'done'
    THEN NULL
    ELSE result_media_repairs.claim_expires_at
  END,
  completed_at = CASE
    WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
      OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
      OR result_media_repairs.state = 'done'
    THEN NULL
    ELSE result_media_repairs.completed_at
  END,
  downstream_finalized_at = CASE
    WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
      OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
      OR result_media_repairs.state = 'done'
    THEN NULL
    ELSE result_media_repairs.downstream_finalized_at
  END,
  "updatedAt" = now()
WHERE result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
   OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
   OR result_media_repairs.state = 'done'
   OR (result_media_repairs.background_owner = false AND EXCLUDED.background_owner);
--> statement-breakpoint

-- Revision and compatibility read models must become unavailable before their
-- rejected source pointer is cleared. Scope revision fits to the exact affected
-- revision and compatibility fits to its value-level physics hash; unrelated
-- public polars remain current. Normal refreshes rebuild retired rows only from
-- accepted/needs_urans exact generations.
UPDATE polar_fit_sets fit
SET is_current = false,
    "updatedAt" = now()
WHERE fit.is_current = true
  AND EXISTS (
    SELECT 1
    FROM results result
    WHERE result.current_result_attempt_id IS NOT NULL
      AND result.airfoil_id = fit.airfoil_id
      AND result.simulation_preset_revision_id = fit.simulation_preset_revision_id
      AND NOT EXISTS (
        SELECT 1
        FROM result_classifications classification
        JOIN result_attempts attempt
          ON attempt.id = classification.result_attempt_id
         AND attempt.result_id = result.id
        WHERE classification.result_attempt_id = result.current_result_attempt_id
          AND attempt.airfoil_id = result.airfoil_id
          AND attempt.simulation_preset_revision_id = result.simulation_preset_revision_id
          AND attempt.aoa_deg = result.aoa_deg
          AND classification.airfoil_id = result.airfoil_id
          AND classification.simulation_preset_revision_id = result.simulation_preset_revision_id
          AND classification.aoa_deg = attempt.aoa_deg
          AND classification.regime IS NOT DISTINCT FROM attempt.regime
          AND classification.state IN ('accepted', 'needs_urans')
          AND EXISTS (
            SELECT 1
            FROM solver_evidence_artifacts manifest
            WHERE manifest.result_id = result.id
              AND manifest.result_attempt_id = attempt.id
              AND manifest.kind = 'manifest'
            HAVING count(*) = 1
              AND bool_and(
                manifest.airfoil_id = result.airfoil_id
                AND manifest.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
                AND manifest.sim_job_id IS NOT DISTINCT FROM attempt.sim_job_id
                AND manifest.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
                AND manifest.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
                AND manifest.sha256 ~ '^[0-9a-fA-F]{64}$'
                AND manifest.byte_size > 0
                AND length(trim(manifest.storage_key)) > 0
                AND length(trim(manifest.mime_type)) > 0
              )
          )
      )
  );
--> statement-breakpoint

UPDATE polar_compatibility_fit_sets fit
SET is_current = false,
    "updatedAt" = now()
WHERE fit.is_current = true
  AND EXISTS (
    SELECT 1
    FROM results result
    JOIN simulation_preset_revisions revision
      ON revision.id = result.simulation_preset_revision_id
    WHERE result.current_result_attempt_id IS NOT NULL
      AND result.airfoil_id = fit.airfoil_id
      AND revision.physics_hash = fit.compatibility_hash
      AND NOT EXISTS (
        SELECT 1
        FROM result_classifications classification
        JOIN result_attempts attempt
          ON attempt.id = classification.result_attempt_id
         AND attempt.result_id = result.id
        WHERE classification.result_attempt_id = result.current_result_attempt_id
          AND attempt.airfoil_id = result.airfoil_id
          AND attempt.simulation_preset_revision_id = result.simulation_preset_revision_id
          AND attempt.aoa_deg = result.aoa_deg
          AND classification.airfoil_id = result.airfoil_id
          AND classification.simulation_preset_revision_id = result.simulation_preset_revision_id
          AND classification.aoa_deg = attempt.aoa_deg
          AND classification.regime IS NOT DISTINCT FROM attempt.regime
          AND classification.state IN ('accepted', 'needs_urans')
          AND EXISTS (
            SELECT 1
            FROM solver_evidence_artifacts manifest
            WHERE manifest.result_id = result.id
              AND manifest.result_attempt_id = attempt.id
              AND manifest.kind = 'manifest'
            HAVING count(*) = 1
              AND bool_and(
                manifest.airfoil_id = result.airfoil_id
                AND manifest.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
                AND manifest.sim_job_id IS NOT DISTINCT FROM attempt.sim_job_id
                AND manifest.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
                AND manifest.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
                AND manifest.sha256 ~ '^[0-9a-fA-F]{64}$'
                AND manifest.byte_size > 0
                AND length(trim(manifest.storage_key)) > 0
                AND length(trim(manifest.mime_type)) > 0
              )
          )
      )
  );
--> statement-breakpoint

-- Result-level classifications are derived projections of the selected exact
-- generation. Remove the stale projection for every pointer that is about to
-- be withdrawn; leaving an accepted result_id row would let campaign/ladder
-- consumers treat pointer-null unavailable evidence as solved. Exact attempt
-- classifications remain intact as immutable history and media-repair input.
DELETE FROM result_classifications result_classification
USING results result
WHERE result_classification.result_id = result.id
  AND result_classification.result_attempt_id IS NULL
  AND result.current_result_attempt_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM result_classifications classification
    JOIN result_attempts attempt
      ON attempt.id = classification.result_attempt_id
     AND attempt.result_id = result.id
    WHERE classification.result_attempt_id = result.current_result_attempt_id
      AND attempt.airfoil_id = result.airfoil_id
      AND attempt.simulation_preset_revision_id = result.simulation_preset_revision_id
      AND attempt.aoa_deg = result.aoa_deg
      AND classification.airfoil_id = result.airfoil_id
      AND classification.simulation_preset_revision_id = result.simulation_preset_revision_id
      AND classification.aoa_deg = attempt.aoa_deg
      AND classification.regime IS NOT DISTINCT FROM attempt.regime
      AND classification.state IN ('accepted', 'needs_urans')
      AND EXISTS (
        SELECT 1
        FROM solver_evidence_artifacts manifest
        WHERE manifest.result_id = result.id
          AND manifest.result_attempt_id = attempt.id
          AND manifest.kind = 'manifest'
        HAVING count(*) = 1
          AND bool_and(
            manifest.airfoil_id = result.airfoil_id
            AND manifest.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
            AND manifest.sim_job_id IS NOT DISTINCT FROM attempt.sim_job_id
            AND manifest.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
            AND manifest.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
            AND manifest.sha256 ~ '^[0-9a-fA-F]{64}$'
            AND manifest.byte_size > 0
            AND length(trim(manifest.storage_key)) > 0
            AND length(trim(manifest.mime_type)) > 0
          )
      )
  );
--> statement-breakpoint

UPDATE results result
SET current_result_attempt_id = NULL,
    "updatedAt" = now()
WHERE result.current_result_attempt_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM result_classifications classification
    JOIN result_attempts attempt
      ON attempt.id = classification.result_attempt_id
     AND attempt.result_id = result.id
    WHERE classification.result_attempt_id = result.current_result_attempt_id
      AND attempt.airfoil_id = result.airfoil_id
      AND attempt.simulation_preset_revision_id = result.simulation_preset_revision_id
      AND attempt.aoa_deg = result.aoa_deg
      AND classification.airfoil_id = result.airfoil_id
      AND classification.simulation_preset_revision_id = result.simulation_preset_revision_id
      AND classification.aoa_deg = attempt.aoa_deg
      AND classification.regime IS NOT DISTINCT FROM attempt.regime
      AND classification.state IN ('accepted', 'needs_urans')
      AND EXISTS (
        SELECT 1
        FROM solver_evidence_artifacts manifest
        WHERE manifest.result_id = result.id
          AND manifest.result_attempt_id = attempt.id
          AND manifest.kind = 'manifest'
        HAVING count(*) = 1
          AND bool_and(
            manifest.airfoil_id = result.airfoil_id
            AND manifest.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
            AND manifest.sim_job_id IS NOT DISTINCT FROM attempt.sim_job_id
            AND manifest.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
            AND manifest.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
            AND manifest.sha256 ~ '^[0-9a-fA-F]{64}$'
            AND manifest.byte_size > 0
            AND length(trim(manifest.storage_key)) > 0
            AND length(trim(manifest.mime_type)) > 0
          )
      )
  );
--> statement-breakpoint

-- Exact-pointer migrations can leave older result-level projections behind
-- after their selected attempt was conservatively cleared. These rows are
-- derived cache state, not immutable attempt evidence. A pointer-null result
-- cannot be accepted, provisional, or treated as a completed superseded cell,
-- and scheduler consumers join by result_id. Retire every affected read model
-- before removing those stale projections rather than relying on a later
-- all-revision cache backfill.
UPDATE polar_fit_sets fit
SET is_current = false,
    "updatedAt" = now()
WHERE fit.is_current = true
  AND EXISTS (
    SELECT 1
    FROM result_classifications classification
    JOIN results result ON result.id = classification.result_id
    WHERE classification.state IN ('accepted', 'needs_urans', 'superseded_by_urans')
      AND result.current_result_attempt_id IS NULL
      AND result.airfoil_id = fit.airfoil_id
      AND result.simulation_preset_revision_id = fit.simulation_preset_revision_id
  );
--> statement-breakpoint

UPDATE polar_compatibility_fit_sets fit
SET is_current = false,
    "updatedAt" = now()
WHERE fit.is_current = true
  AND EXISTS (
    SELECT 1
    FROM result_classifications classification
    JOIN results result ON result.id = classification.result_id
    JOIN simulation_preset_revisions revision
      ON revision.id = result.simulation_preset_revision_id
    WHERE classification.state IN ('accepted', 'needs_urans', 'superseded_by_urans')
      AND result.current_result_attempt_id IS NULL
      AND result.airfoil_id = fit.airfoil_id
      AND revision.physics_hash = fit.compatibility_hash
  );
--> statement-breakpoint

-- Migration 0053 intentionally preserved valid legacy owner pairs that carry
-- both result_id and result_attempt_id. If their result pointer is now null,
-- keep the immutable attempt verdict but detach the derived result-level key;
-- otherwise result_id-only scheduler joins can still mistake that historical
-- attempt for current solved truth.
UPDATE result_classifications result_classification
SET result_id = NULL,
    "updatedAt" = now()
FROM results result
WHERE result_classification.result_id = result.id
  AND result_classification.result_attempt_id IS NOT NULL
  AND result.current_result_attempt_id IS NULL
  AND result_classification.state IN (
    'accepted', 'needs_urans', 'superseded_by_urans'
  );
--> statement-breakpoint

-- Rejected pointer-null projections remain available for the continuation,
-- retry, and campaign-routing consumers that own machine-failure state. The
-- normal refresh recreates an honest rejected projection after any future
-- pointer withdrawal.
DELETE FROM result_classifications result_classification
USING results result
WHERE result_classification.result_id = result.id
  AND result_classification.result_attempt_id IS NULL
  AND result.current_result_attempt_id IS NULL
  AND result_classification.state IN (
    'accepted', 'needs_urans', 'superseded_by_urans'
  );
