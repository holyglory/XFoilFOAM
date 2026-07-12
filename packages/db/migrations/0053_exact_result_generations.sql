-- Canonical public evidence is an explicit accepted attempt generation.  The
-- composite ownership keys below prevent an attempt belonging to result A
-- from ever owning evidence rows for result B.
ALTER TABLE result_attempts
  ADD CONSTRAINT result_attempts_id_result_id_uq UNIQUE (id, result_id);
--> statement-breakpoint

-- One batched engine job may solve the same AoA/regime for several physical
-- conditions.  Result identity is therefore part of the local attempt key;
-- omitting it caused later conditions to reuse the first condition's attempt.
DROP INDEX IF EXISTS result_attempts_job_aoa_regime_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX result_attempts_job_result_aoa_regime_uq
  ON result_attempts (sim_job_id, engine_job_id, result_id, aoa_deg, regime);
--> statement-breakpoint

ALTER TABLE results ADD COLUMN current_result_attempt_id uuid;
--> statement-breakpoint
ALTER TABLE result_media ADD COLUMN result_attempt_id uuid;
--> statement-breakpoint
ALTER TABLE force_history ADD COLUMN result_attempt_id uuid;
--> statement-breakpoint
ALTER TABLE result_field_extents ADD COLUMN result_attempt_id uuid;
--> statement-breakpoint

-- Older artifact ingestion could attach an attempt without copying its result
-- owner.  MATCH SIMPLE composite foreign keys do not reject that half-owned
-- shape, so repair it before exact-generation election.  The attempt is an
-- acceptable source of result_id only when every redundant artifact identity
-- agrees with that exact attempt.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM solver_evidence_artifacts artifact
    JOIN result_attempts attempt ON attempt.id = artifact.result_attempt_id
    WHERE artifact.result_attempt_id IS NOT NULL
      AND artifact.result_id IS NULL
      AND (
        attempt.result_id IS NULL
        OR artifact.airfoil_id IS DISTINCT FROM attempt.airfoil_id
        OR artifact.aoa_deg IS DISTINCT FROM attempt.aoa_deg
        OR artifact.sim_job_id IS DISTINCT FROM attempt.sim_job_id
        OR artifact.engine_job_id IS DISTINCT FROM attempt.engine_job_id
        OR artifact.engine_case_slug IS DISTINCT FROM attempt.engine_case_slug
      )
  ) THEN
    RAISE EXCEPTION
      '0053 refuses to infer result ownership for an artifact whose provenance differs from its attempt';
  END IF;
END $$;
--> statement-breakpoint

UPDATE solver_evidence_artifacts artifact
SET result_id = attempt.result_id
FROM result_attempts attempt
WHERE artifact.result_attempt_id = attempt.id
  AND artifact.result_id IS NULL
  AND attempt.result_id IS NOT NULL
  AND artifact.airfoil_id IS NOT DISTINCT FROM attempt.airfoil_id
  AND artifact.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
  AND artifact.sim_job_id IS NOT DISTINCT FROM attempt.sim_job_id
  AND artifact.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
  AND artifact.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug;
--> statement-breakpoint

-- bffc25c-era batched ingestion looked up attempts without the condition,
-- revision, or engine case.  The artifact's declared result owner and its
-- redundant provenance remained correct, but the attempt association could
-- point at another condition in the same batch.  Prefer the sole provenance-
-- exact attempt under the declared result.  Refuse a repoint that would merge
-- divergent immutable rows.
DO $$
BEGIN
  IF EXISTS (
    WITH repair_candidates AS (
      SELECT
        artifact.id AS artifact_id,
        candidate.id AS candidate_attempt_id,
        count(*) OVER (PARTITION BY artifact.id) AS candidate_count
      FROM solver_evidence_artifacts artifact
      JOIN result_attempts candidate
        ON candidate.result_id = artifact.result_id
       AND candidate.airfoil_id IS NOT DISTINCT FROM artifact.airfoil_id
       AND candidate.aoa_deg IS NOT DISTINCT FROM artifact.aoa_deg
       AND candidate.sim_job_id IS NOT DISTINCT FROM artifact.sim_job_id
       AND candidate.engine_job_id IS NOT DISTINCT FROM artifact.engine_job_id
       AND candidate.engine_case_slug IS NOT DISTINCT FROM artifact.engine_case_slug
      WHERE artifact.result_attempt_id IS NOT NULL
        AND artifact.result_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM result_attempts owner
          WHERE owner.id = artifact.result_attempt_id
            AND owner.result_id = artifact.result_id
        )
    )
    SELECT 1
    FROM repair_candidates repair
    JOIN solver_evidence_artifacts invalid
      ON invalid.id = repair.artifact_id
    JOIN solver_evidence_artifacts existing
      ON existing.id <> invalid.id
     AND existing.result_attempt_id = repair.candidate_attempt_id
     AND existing.kind = invalid.kind
     AND existing.field IS NOT DISTINCT FROM invalid.field
     AND existing.role IS NOT DISTINCT FROM invalid.role
     AND existing.storage_key = invalid.storage_key
     AND existing.sha256 = invalid.sha256
    WHERE repair.candidate_count = 1
      AND NOT (
        existing.result_id IS NOT DISTINCT FROM invalid.result_id
        AND existing.airfoil_id IS NOT DISTINCT FROM invalid.airfoil_id
        AND existing.sim_job_id IS NOT DISTINCT FROM invalid.sim_job_id
        AND existing.engine_job_id IS NOT DISTINCT FROM invalid.engine_job_id
        AND existing.engine_case_slug IS NOT DISTINCT FROM invalid.engine_case_slug
        AND existing.aoa_deg IS NOT DISTINCT FROM invalid.aoa_deg
        AND existing.mime_type IS NOT DISTINCT FROM invalid.mime_type
        AND existing.byte_size IS NOT DISTINCT FROM invalid.byte_size
        AND existing.engine_url IS NOT DISTINCT FROM invalid.engine_url
        AND existing.metadata IS NOT DISTINCT FROM invalid.metadata
      )
  ) THEN
    RAISE EXCEPTION
      '0053 refuses to repoint an artifact onto divergent immutable evidence';
  END IF;
END $$;
--> statement-breakpoint

-- When a correct association already preserves byte-for-byte identical
-- evidence, drop only the obsolete wrong-attempt association.
WITH repair_candidates AS (
  SELECT
    artifact.id AS artifact_id,
    candidate.id AS candidate_attempt_id,
    count(*) OVER (PARTITION BY artifact.id) AS candidate_count
  FROM solver_evidence_artifacts artifact
  JOIN result_attempts candidate
    ON candidate.result_id = artifact.result_id
   AND candidate.airfoil_id IS NOT DISTINCT FROM artifact.airfoil_id
   AND candidate.aoa_deg IS NOT DISTINCT FROM artifact.aoa_deg
   AND candidate.sim_job_id IS NOT DISTINCT FROM artifact.sim_job_id
   AND candidate.engine_job_id IS NOT DISTINCT FROM artifact.engine_job_id
   AND candidate.engine_case_slug IS NOT DISTINCT FROM artifact.engine_case_slug
  WHERE artifact.result_attempt_id IS NOT NULL
    AND artifact.result_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM result_attempts owner
      WHERE owner.id = artifact.result_attempt_id
        AND owner.result_id = artifact.result_id
    )
)
DELETE FROM solver_evidence_artifacts invalid
USING repair_candidates repair, solver_evidence_artifacts existing
WHERE invalid.id = repair.artifact_id
  AND repair.candidate_count = 1
  AND existing.id <> invalid.id
  AND existing.result_attempt_id = repair.candidate_attempt_id
  AND existing.result_id IS NOT DISTINCT FROM invalid.result_id
  AND existing.kind = invalid.kind
  AND existing.field IS NOT DISTINCT FROM invalid.field
  AND existing.role IS NOT DISTINCT FROM invalid.role
  AND existing.storage_key = invalid.storage_key
  AND existing.sha256 = invalid.sha256
  AND existing.airfoil_id IS NOT DISTINCT FROM invalid.airfoil_id
  AND existing.sim_job_id IS NOT DISTINCT FROM invalid.sim_job_id
  AND existing.engine_job_id IS NOT DISTINCT FROM invalid.engine_job_id
  AND existing.engine_case_slug IS NOT DISTINCT FROM invalid.engine_case_slug
  AND existing.aoa_deg IS NOT DISTINCT FROM invalid.aoa_deg
  AND existing.mime_type IS NOT DISTINCT FROM invalid.mime_type
  AND existing.byte_size IS NOT DISTINCT FROM invalid.byte_size
  AND existing.engine_url IS NOT DISTINCT FROM invalid.engine_url
  AND existing.metadata IS NOT DISTINCT FROM invalid.metadata;
--> statement-breakpoint

WITH repair_candidates AS (
  SELECT
    artifact.id AS artifact_id,
    candidate.id AS candidate_attempt_id,
    count(*) OVER (PARTITION BY artifact.id) AS candidate_count
  FROM solver_evidence_artifacts artifact
  JOIN result_attempts candidate
    ON candidate.result_id = artifact.result_id
   AND candidate.airfoil_id IS NOT DISTINCT FROM artifact.airfoil_id
   AND candidate.aoa_deg IS NOT DISTINCT FROM artifact.aoa_deg
   AND candidate.sim_job_id IS NOT DISTINCT FROM artifact.sim_job_id
   AND candidate.engine_job_id IS NOT DISTINCT FROM artifact.engine_job_id
   AND candidate.engine_case_slug IS NOT DISTINCT FROM artifact.engine_case_slug
  WHERE artifact.result_attempt_id IS NOT NULL
    AND artifact.result_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM result_attempts owner
      WHERE owner.id = artifact.result_attempt_id
        AND owner.result_id = artifact.result_id
    )
)
UPDATE solver_evidence_artifacts artifact
SET result_attempt_id = repair.candidate_attempt_id
FROM repair_candidates repair
WHERE artifact.id = repair.artifact_id
  AND repair.candidate_count = 1;
--> statement-breakpoint

-- A remaining wrong-attempt association has no unique exact replacement.
-- Its declared result remains trustworthy only when the artifact's physical
-- cell matches that result.  Preserve the immutable artifact as result-scoped
-- evidence; never guess a generation.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM solver_evidence_artifacts artifact
    JOIN results result ON result.id = artifact.result_id
    WHERE artifact.result_attempt_id IS NOT NULL
      AND artifact.result_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM result_attempts owner
        WHERE owner.id = artifact.result_attempt_id
          AND owner.result_id = artifact.result_id
      )
      AND (
        artifact.airfoil_id IS DISTINCT FROM result.airfoil_id
        OR artifact.aoa_deg IS DISTINCT FROM result.aoa_deg
      )
  ) THEN
    RAISE EXCEPTION
      '0053 refuses to detach an artifact whose declared result provenance is inconsistent';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM solver_evidence_artifacts invalid
    JOIN solver_evidence_artifacts legacy
      ON legacy.id <> invalid.id
     AND legacy.result_attempt_id IS NULL
     AND legacy.result_id = invalid.result_id
     AND legacy.kind = invalid.kind
     AND legacy.field IS NOT DISTINCT FROM invalid.field
     AND legacy.role IS NOT DISTINCT FROM invalid.role
     AND legacy.storage_key = invalid.storage_key
     AND legacy.sha256 = invalid.sha256
    WHERE invalid.result_attempt_id IS NOT NULL
      AND invalid.result_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM result_attempts owner
        WHERE owner.id = invalid.result_attempt_id
          AND owner.result_id = invalid.result_id
      )
      AND NOT (
        legacy.airfoil_id IS NOT DISTINCT FROM invalid.airfoil_id
        AND legacy.sim_job_id IS NOT DISTINCT FROM invalid.sim_job_id
        AND legacy.engine_job_id IS NOT DISTINCT FROM invalid.engine_job_id
        AND legacy.engine_case_slug IS NOT DISTINCT FROM invalid.engine_case_slug
        AND legacy.aoa_deg IS NOT DISTINCT FROM invalid.aoa_deg
        AND legacy.mime_type IS NOT DISTINCT FROM invalid.mime_type
        AND legacy.byte_size IS NOT DISTINCT FROM invalid.byte_size
        AND legacy.engine_url IS NOT DISTINCT FROM invalid.engine_url
        AND legacy.metadata IS NOT DISTINCT FROM invalid.metadata
      )
  ) THEN
    RAISE EXCEPTION
      '0053 refuses to detach an artifact onto divergent result-scoped evidence';
  END IF;
END $$;
--> statement-breakpoint

-- Delete only a fully identical result-scoped association that would collide
-- with the wrong-attempt row when the latter becomes result-scoped.
DELETE FROM solver_evidence_artifacts legacy
USING solver_evidence_artifacts invalid
WHERE legacy.result_attempt_id IS NULL
  AND legacy.result_id = invalid.result_id
  AND invalid.result_attempt_id IS NOT NULL
  AND invalid.result_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM result_attempts owner
    WHERE owner.id = invalid.result_attempt_id
      AND owner.result_id = invalid.result_id
  )
  AND legacy.id <> invalid.id
  AND legacy.kind = invalid.kind
  AND legacy.field IS NOT DISTINCT FROM invalid.field
  AND legacy.role IS NOT DISTINCT FROM invalid.role
  AND legacy.storage_key = invalid.storage_key
  AND legacy.sha256 = invalid.sha256
  AND legacy.airfoil_id IS NOT DISTINCT FROM invalid.airfoil_id
  AND legacy.sim_job_id IS NOT DISTINCT FROM invalid.sim_job_id
  AND legacy.engine_job_id IS NOT DISTINCT FROM invalid.engine_job_id
  AND legacy.engine_case_slug IS NOT DISTINCT FROM invalid.engine_case_slug
  AND legacy.aoa_deg IS NOT DISTINCT FROM invalid.aoa_deg
  AND legacy.mime_type IS NOT DISTINCT FROM invalid.mime_type
  AND legacy.byte_size IS NOT DISTINCT FROM invalid.byte_size
  AND legacy.engine_url IS NOT DISTINCT FROM invalid.engine_url
  AND legacy.metadata IS NOT DISTINCT FROM invalid.metadata;
--> statement-breakpoint

UPDATE solver_evidence_artifacts artifact
SET result_attempt_id = NULL
WHERE artifact.result_attempt_id IS NOT NULL
  AND artifact.result_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM result_attempts owner
    WHERE owner.id = artifact.result_attempt_id
      AND owner.result_id = artifact.result_id
  );
--> statement-breakpoint

-- A legacy attempt becomes current only when exactly one eligible attempt at
-- the strongest available classification (accepted before needs_urans)
-- matches canonical provenance and every available projection value.
WITH eligible AS (
  SELECT
    result.id AS result_id,
    attempt.id AS attempt_id,
    CASE classification.state WHEN 'accepted' THEN 2 ELSE 1 END AS priority
  FROM results result
  JOIN result_attempts attempt
    ON attempt.result_id = result.id
   AND attempt.airfoil_id = result.airfoil_id
   AND attempt.bc_id = result.bc_id
   AND attempt.simulation_preset_revision_id IS NOT DISTINCT FROM result.simulation_preset_revision_id
   AND attempt.sim_job_id IS NOT DISTINCT FROM result.sim_job_id
   AND attempt.engine_job_id IS NOT DISTINCT FROM result.engine_job_id
   AND attempt.engine_case_slug IS NOT DISTINCT FROM result.engine_case_slug
   AND attempt.aoa_deg = result.aoa_deg
   AND attempt.status = result.status
   AND attempt.source = result.source
   AND attempt.regime IS NOT DISTINCT FROM result.regime
   AND attempt.cl IS NOT DISTINCT FROM result.cl
   AND attempt.cd IS NOT DISTINCT FROM result.cd
   AND attempt.cm IS NOT DISTINCT FROM result.cm
   AND attempt.cl_cd IS NOT DISTINCT FROM result.cl_cd
   AND attempt.cl_std IS NOT DISTINCT FROM result.cl_std
   AND attempt.cd_std IS NOT DISTINCT FROM result.cd_std
   AND attempt.cm_std IS NOT DISTINCT FROM result.cm_std
   AND attempt.stalled = result.stalled
   AND attempt.unsteady = result.unsteady
   AND attempt.converged = result.converged
   AND attempt.final_residual IS NOT DISTINCT FROM result.final_residual
   AND attempt.iterations IS NOT DISTINCT FROM result.iterations
   AND attempt.y_plus_avg IS NOT DISTINCT FROM result.y_plus_avg
   AND attempt.y_plus_max IS NOT DISTINCT FROM result.y_plus_max
   AND attempt.n_cells IS NOT DISTINCT FROM result.n_cells
   AND attempt.first_order_fallback = result.first_order_fallback
   AND attempt.strouhal IS NOT DISTINCT FROM result.strouhal
   AND attempt.error IS NOT DISTINCT FROM result.error
   AND attempt.quality_warnings IS NOT DISTINCT FROM result.quality_warnings
   AND (
     COALESCE(attempt.evidence_payload -> 'fidelity', 'null'::jsonb)
       = COALESCE(to_jsonb(result.fidelity), 'null'::jsonb)
     OR (
       COALESCE(attempt.evidence_payload -> 'fidelity', 'null'::jsonb) = 'null'::jsonb
       AND (
         (attempt.regime = 'urans' AND result.fidelity = 'urans_full')
         OR (attempt.regime = 'rans' AND result.fidelity = 'rans')
       )
     )
   )
   AND COALESCE(
         NULLIF(attempt.evidence_payload -> 'frame_track', 'null'::jsonb),
         NULLIF(attempt.evidence_payload -> 'frameTrack', 'null'::jsonb),
         'null'::jsonb
       ) = COALESCE(result.frame_track, 'null'::jsonb)
   AND COALESCE(
         NULLIF(attempt.evidence_payload -> 'steady_history', 'null'::jsonb),
         NULLIF(attempt.evidence_payload -> 'steadyHistory', 'null'::jsonb),
         'null'::jsonb
       ) = COALESCE(result.steady_history, 'null'::jsonb)
  JOIN LATERAL (
    SELECT classification.state
    FROM result_classifications classification
    WHERE classification.result_attempt_id = attempt.id
      AND (classification.result_id IS NULL OR classification.result_id = result.id)
      AND classification.airfoil_id = result.airfoil_id
      AND classification.simulation_preset_revision_id = result.simulation_preset_revision_id
      AND classification.aoa_deg = result.aoa_deg
      AND classification.regime IS NOT DISTINCT FROM attempt.regime
      AND classification.state IN ('accepted', 'needs_urans')
    ORDER BY CASE classification.state WHEN 'accepted' THEN 2 ELSE 1 END DESC,
             classification."updatedAt" DESC,
             classification.id DESC
    LIMIT 1
  ) classification ON true
  WHERE 1 = (
      SELECT count(*)
      FROM solver_evidence_artifacts manifest
      WHERE manifest.result_id = result.id
        AND manifest.result_attempt_id = attempt.id
        AND manifest.kind = 'manifest'
    )
    AND 1 = (
      SELECT count(*)
      FROM solver_evidence_artifacts manifest
      WHERE manifest.result_id = result.id
        AND manifest.result_attempt_id = attempt.id
        AND manifest.kind = 'manifest'
        AND manifest.airfoil_id = result.airfoil_id
        AND manifest.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
        AND manifest.sim_job_id IS NOT DISTINCT FROM attempt.sim_job_id
        AND manifest.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
        AND manifest.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
        AND manifest.sha256 ~ '^[0-9a-fA-F]{64}$'
        AND manifest.byte_size > 0
        AND length(trim(manifest.storage_key)) > 0
        AND length(trim(manifest.mime_type)) > 0
    )
), strongest AS (
  SELECT eligible.*,
         max(priority) OVER (PARTITION BY result_id) AS strongest_priority
  FROM eligible
), candidates AS (
  SELECT strongest.*,
         count(*) OVER (PARTITION BY result_id) AS candidate_count
  FROM strongest
  WHERE priority = strongest_priority
)
UPDATE results result
SET current_result_attempt_id = candidate.attempt_id
FROM candidates candidate
WHERE candidate.result_id = result.id
  AND candidate.candidate_count = 1;
--> statement-breakpoint

-- Bind presentation rows only through the unique manifest of the elected
-- generation.  A missing/duplicate manifest or signature mismatch stays
-- legacy NULL rather than being guessed from result identity.
WITH exact_manifests AS (
  SELECT
    artifact.result_id,
    artifact.result_attempt_id,
    min(artifact.sha256) AS sha256
  FROM solver_evidence_artifacts artifact
  JOIN result_attempts attempt
    ON attempt.id = artifact.result_attempt_id
   AND attempt.result_id = artifact.result_id
  JOIN results result ON result.id = artifact.result_id
  WHERE artifact.kind = 'manifest'
    AND artifact.result_id IS NOT NULL
    AND artifact.result_attempt_id IS NOT NULL
    AND artifact.airfoil_id = result.airfoil_id
    AND artifact.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
    AND artifact.sim_job_id IS NOT DISTINCT FROM attempt.sim_job_id
    AND artifact.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
    AND artifact.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
    AND artifact.sha256 ~ '^[0-9a-fA-F]{64}$'
    AND artifact.byte_size > 0
    AND length(trim(artifact.storage_key)) > 0
    AND length(trim(artifact.mime_type)) > 0
  GROUP BY artifact.result_id, artifact.result_attempt_id
  HAVING count(*) = 1
), bindable_media AS (
  SELECT media.id,
         result.current_result_attempt_id,
         count(*) OVER (
           PARTITION BY media.result_id, media.kind, COALESCE(media.field, ''),
                        media.role, media.render_profile_key
         ) AS identity_count
  FROM result_media media
  JOIN results result ON result.id = media.result_id
  JOIN exact_manifests manifest
    ON manifest.result_id = result.id
   AND manifest.result_attempt_id = result.current_result_attempt_id
   AND media.evidence_sha256 = manifest.sha256
  WHERE result.current_result_attempt_id IS NOT NULL
    AND media.sha256 ~ '^[0-9a-fA-F]{64}$'
    AND media.byte_size > 0
    AND length(trim(media.storage_key)) > 0
    AND length(trim(media.mime_type)) > 0
)
UPDATE result_media media
SET result_attempt_id = bindable.current_result_attempt_id
FROM bindable_media bindable
WHERE media.id = bindable.id
  AND bindable.identity_count = 1;
--> statement-breakpoint

WITH exact_manifests AS (
  SELECT
    artifact.result_id,
    artifact.result_attempt_id,
    min(artifact.sha256) AS sha256
  FROM solver_evidence_artifacts artifact
  JOIN result_attempts attempt
    ON attempt.id = artifact.result_attempt_id
   AND attempt.result_id = artifact.result_id
  JOIN results result ON result.id = artifact.result_id
  WHERE artifact.kind = 'manifest'
    AND artifact.result_id IS NOT NULL
    AND artifact.result_attempt_id IS NOT NULL
    AND artifact.airfoil_id = result.airfoil_id
    AND artifact.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
    AND artifact.sim_job_id IS NOT DISTINCT FROM attempt.sim_job_id
    AND artifact.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
    AND artifact.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
    AND artifact.sha256 ~ '^[0-9a-fA-F]{64}$'
    AND artifact.byte_size > 0
    AND length(trim(artifact.storage_key)) > 0
    AND length(trim(artifact.mime_type)) > 0
  GROUP BY artifact.result_id, artifact.result_attempt_id
  HAVING count(*) = 1
)
UPDATE result_field_extents extent
SET result_attempt_id = result.current_result_attempt_id
FROM results result
JOIN exact_manifests manifest
  ON manifest.result_id = result.id
 AND manifest.result_attempt_id = result.current_result_attempt_id
WHERE extent.result_id = result.id
  AND result.current_result_attempt_id IS NOT NULL
  AND extent.airfoil_id = result.airfoil_id
  AND extent.simulation_preset_revision_id = result.simulation_preset_revision_id
  AND extent.evidence_sha256 = manifest.sha256;
--> statement-breakpoint

-- Force history has no artifact checksum.  Bind it only when the elected
-- attempt carries an exact normalized force-history object whose arrays and
-- statistics semantically equal the stored projection.  Missing/mismatched
-- payloads remain legacy NULL.
WITH candidate_force AS (
  SELECT
    history.id AS history_id,
    result.current_result_attempt_id AS attempt_id,
    COALESCE(
      NULLIF(attempt.evidence_payload -> 'force_history', 'null'::jsonb),
      NULLIF(attempt.evidence_payload -> 'forceHistory', 'null'::jsonb)
    ) AS payload,
    attempt.cl AS attempt_cl,
    attempt.cl_std AS attempt_cl_std,
    attempt.cd AS attempt_cd,
    attempt.cd_std AS attempt_cd_std,
    attempt.strouhal AS attempt_strouhal
  FROM force_history history
  JOIN results result ON result.id = history.result_id
  JOIN result_attempts attempt
    ON attempt.id = result.current_result_attempt_id
   AND attempt.result_id = result.id
  WHERE result.current_result_attempt_id IS NOT NULL
)
UPDATE force_history history
SET result_attempt_id = candidate.attempt_id
FROM candidate_force candidate
WHERE candidate.history_id = history.id
  AND jsonb_typeof(candidate.payload) = 'object'
  AND COALESCE(candidate.payload -> 't', 'null'::jsonb) = history.t
  AND COALESCE(candidate.payload -> 'cl', 'null'::jsonb) = history.cl
  AND COALESCE(candidate.payload -> 'cd', 'null'::jsonb) = history.cd
  AND COALESCE(candidate.payload -> 'cm', 'null'::jsonb)
      = COALESCE(history.cm, 'null'::jsonb)
  AND COALESCE(NULLIF(candidate.payload -> 'clMean', 'null'::jsonb), NULLIF(candidate.payload -> 'cl_mean', 'null'::jsonb), to_jsonb(candidate.attempt_cl), 'null'::jsonb)
      = COALESCE(to_jsonb(history.cl_mean), 'null'::jsonb)
  AND COALESCE(NULLIF(candidate.payload -> 'clRms', 'null'::jsonb), NULLIF(candidate.payload -> 'cl_rms', 'null'::jsonb), to_jsonb(candidate.attempt_cl_std), 'null'::jsonb)
      = COALESCE(to_jsonb(history.cl_rms), 'null'::jsonb)
  AND COALESCE(NULLIF(candidate.payload -> 'cdMean', 'null'::jsonb), NULLIF(candidate.payload -> 'cd_mean', 'null'::jsonb), to_jsonb(candidate.attempt_cd), 'null'::jsonb)
      = COALESCE(to_jsonb(history.cd_mean), 'null'::jsonb)
  AND COALESCE(NULLIF(candidate.payload -> 'cdRms', 'null'::jsonb), NULLIF(candidate.payload -> 'cd_rms', 'null'::jsonb), to_jsonb(candidate.attempt_cd_std), 'null'::jsonb)
      = COALESCE(to_jsonb(history.cd_rms), 'null'::jsonb)
  AND COALESCE(NULLIF(candidate.payload -> 'strouhal', 'null'::jsonb), to_jsonb(candidate.attempt_strouhal), 'null'::jsonb)
      = COALESCE(to_jsonb(history.strouhal), 'null'::jsonb)
  AND COALESCE(NULLIF(candidate.payload -> 'sheddingFreqHz', 'null'::jsonb), NULLIF(candidate.payload -> 'shedding_freq_hz', 'null'::jsonb), 'null'::jsonb)
      = COALESCE(to_jsonb(history.shedding_freq_hz), 'null'::jsonb)
  AND COALESCE(NULLIF(candidate.payload -> 'sampleCount', 'null'::jsonb), NULLIF(candidate.payload -> 'sample_count', 'null'::jsonb), NULLIF(candidate.payload -> 'samples', 'null'::jsonb), 'null'::jsonb)
      = COALESCE(to_jsonb(history.sample_count), 'null'::jsonb);
--> statement-breakpoint

DROP INDEX IF EXISTS result_media_uq;
--> statement-breakpoint
DROP INDEX IF EXISTS result_field_extents_result_field_uq;
--> statement-breakpoint
ALTER TABLE force_history
  DROP CONSTRAINT IF EXISTS force_history_result_id_unique;
--> statement-breakpoint

ALTER TABLE results
  ADD CONSTRAINT results_current_attempt_owner_fk
  FOREIGN KEY (current_result_attempt_id, id)
  REFERENCES result_attempts(id, result_id)
  ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE result_media
  ADD CONSTRAINT result_media_attempt_owner_fk
  FOREIGN KEY (result_attempt_id, result_id)
  REFERENCES result_attempts(id, result_id)
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE force_history
  ADD CONSTRAINT force_history_attempt_owner_fk
  FOREIGN KEY (result_attempt_id, result_id)
  REFERENCES result_attempts(id, result_id)
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE result_field_extents
  ADD CONSTRAINT result_field_extents_attempt_owner_fk
  FOREIGN KEY (result_attempt_id, result_id)
  REFERENCES result_attempts(id, result_id)
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE solver_evidence_artifacts
  ADD CONSTRAINT solver_evidence_artifacts_attempt_owner_fk
  FOREIGN KEY (result_attempt_id, result_id)
  REFERENCES result_attempts(id, result_id)
  ON DELETE CASCADE;
--> statement-breakpoint

-- Rows carrying both identities must name one owner pair.  Abort an upgrade
-- rather than silently rewriting cross-result scheduler, sync, or derived
-- state that needs an operator to resolve.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM result_classifications row
    WHERE row.result_id IS NOT NULL AND row.result_attempt_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM result_attempts attempt
        WHERE attempt.id = row.result_attempt_id AND attempt.result_id = row.result_id
      )
  ) OR EXISTS (
    SELECT 1 FROM sim_precalc_obligations row
    WHERE row.source_result_id IS NOT NULL AND row.source_result_attempt_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM result_attempts attempt
        WHERE attempt.id = row.source_result_attempt_id AND attempt.result_id = row.source_result_id
      )
  ) OR EXISTS (
    SELECT 1 FROM sim_campaign_points row
    WHERE row.result_id IS NOT NULL AND row.result_attempt_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM result_attempts attempt
        WHERE attempt.id = row.result_attempt_id AND attempt.result_id = row.result_id
      )
  ) OR EXISTS (
    SELECT 1 FROM sync_sweep_promise_points row
    WHERE row.result_id IS NOT NULL AND row.result_attempt_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM result_attempts attempt
        WHERE attempt.id = row.result_attempt_id AND attempt.result_id = row.result_id
      )
  ) OR EXISTS (
    SELECT 1 FROM sync_remote_result_deliveries row
    WHERE row.result_id IS NOT NULL AND row.result_attempt_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM result_attempts attempt
        WHERE attempt.id = row.result_attempt_id AND attempt.result_id = row.result_id
      )
  ) OR EXISTS (
    SELECT 1 FROM remote_asset_references row
    WHERE row.result_id IS NOT NULL AND row.result_attempt_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM result_attempts attempt
        WHERE attempt.id = row.result_attempt_id AND attempt.result_id = row.result_id
      )
  ) THEN
    RAISE EXCEPTION 'cross-result attempt ownership must be resolved before exact-generation migration';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE result_classifications
  ADD CONSTRAINT result_classifications_attempt_owner_fk
  FOREIGN KEY (result_attempt_id, result_id)
  REFERENCES result_attempts(id, result_id)
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE sim_campaign_points
  ADD CONSTRAINT sim_campaign_points_attempt_owner_fk
  FOREIGN KEY (result_attempt_id, result_id)
  REFERENCES result_attempts(id, result_id);
--> statement-breakpoint
ALTER TABLE sync_sweep_promise_points
  ADD CONSTRAINT sync_sweep_promise_points_attempt_owner_fk
  FOREIGN KEY (result_attempt_id, result_id)
  REFERENCES result_attempts(id, result_id);
--> statement-breakpoint
ALTER TABLE sync_remote_result_deliveries
  ADD CONSTRAINT sync_remote_result_deliveries_attempt_owner_fk
  FOREIGN KEY (result_attempt_id, result_id)
  REFERENCES result_attempts(id, result_id)
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE remote_asset_references
  ADD CONSTRAINT remote_asset_references_attempt_owner_fk
  FOREIGN KEY (result_attempt_id, result_id)
  REFERENCES result_attempts(id, result_id);
--> statement-breakpoint
ALTER TABLE sim_precalc_obligations
  ADD CONSTRAINT sim_precalc_obligations_source_attempt_owner_fk
  FOREIGN KEY (source_result_attempt_id, source_result_id)
  REFERENCES result_attempts(id, result_id);
--> statement-breakpoint

CREATE INDEX results_current_attempt_idx
  ON results (current_result_attempt_id);
--> statement-breakpoint
CREATE INDEX result_media_attempt_idx
  ON result_media (result_attempt_id);
--> statement-breakpoint
CREATE INDEX result_field_extents_attempt_idx
  ON result_field_extents (result_attempt_id);
--> statement-breakpoint
CREATE INDEX force_history_result_idx
  ON force_history (result_id);
--> statement-breakpoint

CREATE UNIQUE INDEX result_media_attempt_role_uq
  ON result_media (
    result_attempt_id,
    kind,
    COALESCE(field, ''),
    role,
    render_profile_key
  )
  WHERE result_attempt_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX result_media_legacy_result_role_idx
  ON result_media (result_id, kind, field, role, render_profile_key)
  WHERE result_attempt_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX result_field_extents_attempt_field_uq
  ON result_field_extents (result_attempt_id, field, render_profile_key)
  WHERE result_attempt_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX result_field_extents_legacy_result_field_uq
  ON result_field_extents (result_id, field, render_profile_key)
  WHERE result_attempt_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX force_history_attempt_uq
  ON force_history (result_attempt_id)
  WHERE result_attempt_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX force_history_legacy_result_uq
  ON force_history (result_id)
  WHERE result_attempt_id IS NULL;
--> statement-breakpoint
