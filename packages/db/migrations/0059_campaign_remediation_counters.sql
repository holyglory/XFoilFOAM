ALTER TABLE "sim_precalc_obligation_attempts"
  ADD COLUMN "mesh_recovery_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Execution truth is worker-acknowledged. The desired/requested
-- meshRecoveryVersion is deliberately ignored: an old worker which did not
-- acknowledge the strategy remains legacy v0 even after a control-plane
-- cutover.
UPDATE "sim_precalc_obligation_attempts" attempt
SET "mesh_recovery_version" = CASE
  WHEN jsonb_typeof(job.request_payload -> 'executedMeshRecoveryVersion') = 'number'
  THEN CASE
    WHEN (job.request_payload ->> 'executedMeshRecoveryVersion')::numeric >= 0
      AND (job.request_payload ->> 'executedMeshRecoveryVersion')::numeric
        = trunc((job.request_payload ->> 'executedMeshRecoveryVersion')::numeric)
      AND (job.request_payload ->> 'executedMeshRecoveryVersion')::numeric <= 2147483647
    THEN (job.request_payload ->> 'executedMeshRecoveryVersion')::integer
    ELSE 0
  END
  ELSE 0
END
FROM "sim_jobs" job
WHERE job.id = attempt.sim_job_id;
--> statement-breakpoint
ALTER TABLE "sim_precalc_obligation_attempts"
  ADD CONSTRAINT "sim_precalc_obligation_attempts_mesh_recovery_version_check"
  CHECK ("mesh_recovery_version" >= 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "sim_precalc_obligation_attempts"
  VALIDATE CONSTRAINT "sim_precalc_obligation_attempts_mesh_recovery_version_check";
--> statement-breakpoint
CREATE INDEX "sim_precalc_obligations_mesh_recovery_candidate_idx"
  ON "sim_precalc_obligations" USING btree ("id")
  WHERE "state" = 'blocked'
    AND "attempt_count" = 1
    AND "last_outcome" = 'deterministic_failure';
--> statement-breakpoint
ALTER TABLE "sim_campaign_progress"
  ADD COLUMN "precalc_mesh_repairing" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "blocked_mesh_quality" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "blocked_precalc_exhausted" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "blocked_engine_submit" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "blocked_other" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Establish conservation immediately for every legacy progress row, including
-- any orphaned row without surviving points. The canonical point backfill
-- below then replaces this catch-all with exact reason groups.
UPDATE "sim_campaign_progress"
SET "blocked_other" = "blocked";
--> statement-breakpoint
WITH attempt_flags AS (
  SELECT
    obligation_id,
    bool_or(outcome = 'deterministic_failure') AS typed_deterministic_mesh,
    bool_or(outcome IS NOT NULL) AS has_typed_outcome
  FROM sim_precalc_obligation_attempts
  GROUP BY obligation_id
),
accepted_precalc_cells AS (
  SELECT DISTINCT
    accepted_attempt.airfoil_id,
    accepted_attempt.simulation_preset_revision_id AS revision_id,
    accepted_attempt.aoa_deg
  FROM result_attempts accepted_attempt
  JOIN result_classifications accepted_classification
    ON accepted_classification.result_attempt_id = accepted_attempt.id
   AND accepted_classification.state = 'accepted'
  WHERE accepted_attempt.regime = 'urans'
     OR accepted_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
),
facts AS (
  SELECT
    point.campaign_id,
    point.condition_id,
    point.airfoil_id,
    point.state AS point_state,
    point.derived_by_symmetry,
    result.status AS result_status,
    classification.state AS classification_state,
    obligation.state AS obligation_state,
    obligation.last_outcome,
    COALESCE(attempt_flags.typed_deterministic_mesh, false) AS typed_deterministic_mesh,
    COALESCE(attempt_flags.has_typed_outcome, false) AS has_typed_outcome,
    (
      position('mesh degenerate at this fidelity tier' in lower(COALESCE(obligation.last_error, ''))) > 0
      AND position('max non-orthogonality' in lower(COALESCE(obligation.last_error, ''))) > 0
    ) AS legacy_deterministic_mesh,
    accepted_precalc_cells.airfoil_id IS NOT NULL AS has_accepted_precalc
  FROM sim_campaign_points point
  LEFT JOIN results result ON result.id = point.result_id
  LEFT JOIN result_classifications classification
    ON classification.result_id = point.result_id
  LEFT JOIN sim_precalc_obligations obligation
    ON obligation.airfoil_id = point.airfoil_id
   AND obligation.revision_id = point.revision_id
   AND obligation.aoa_deg = CASE
     WHEN point.derived_by_symmetry THEN result.aoa_deg
     ELSE point.aoa_deg
   END
  LEFT JOIN attempt_flags ON attempt_flags.obligation_id = obligation.id
  LEFT JOIN accepted_precalc_cells
    ON accepted_precalc_cells.airfoil_id = obligation.airfoil_id
   AND accepted_precalc_cells.revision_id = obligation.revision_id
   AND accepted_precalc_cells.aoa_deg = obligation.aoa_deg
),
classified AS (
  SELECT
    facts.*,
    (
      obligation_state = 'blocked'
      OR (
        obligation_state IS DISTINCT FROM 'pending'
        AND obligation_state IS DISTINCT FROM 'running'
        AND obligation_state IS DISTINCT FROM 'blocked'
        AND (
          (
            point_state = 'terminal'
            AND NOT derived_by_symmetry
            AND result_status = 'done'
            AND (
              classification_state IS NULL
              OR classification_state NOT IN (
                'accepted', 'needs_urans', 'superseded_by_urans', 'rejected'
              )
            )
          )
          OR (
            point_state = 'terminal'
            AND derived_by_symmetry
            AND (
              result_status = 'failed'
              OR (
                result_status = 'done'
                AND (
                  classification_state IS NULL
                  OR classification_state NOT IN (
                    'accepted', 'needs_urans', 'superseded_by_urans', 'rejected'
                  )
                )
              )
            )
          )
        )
      )
    ) AS canonical_blocked,
    (
      obligation_state IN ('pending', 'running')
      AND last_outcome IN (
        'mesh_recovery_upgrade_pending', 'composed', 'submitted'
      )
      AND (
        typed_deterministic_mesh
        OR (NOT has_typed_outcome AND legacy_deterministic_mesh)
      )
      AND NOT has_accepted_precalc
    ) AS mesh_repairing,
    (
      obligation_state = 'blocked'
      AND (
        last_outcome = 'deterministic_failure'
        OR (
          last_outcome IS NULL
          AND (
            typed_deterministic_mesh
            OR (NOT has_typed_outcome AND legacy_deterministic_mesh)
          )
        )
      )
    ) AS blocked_mesh,
    (
      obligation_state = 'blocked'
      AND last_outcome IN (
        'failed_exhausted', 'rejected_exhausted', 'cancelled_exhausted'
      )
    ) AS blocked_exhausted,
    (
      obligation_state = 'blocked'
      AND last_outcome = 'submit_blocked'
    ) AS blocked_submit
  FROM facts
),
progress_backfill AS (
  SELECT
    campaign_id,
    condition_id,
    airfoil_id,
    count(*) FILTER (
      WHERE point_state <> 'released' AND canonical_blocked
    )::integer AS blocked,
    count(*) FILTER (
      WHERE point_state <> 'released' AND mesh_repairing
    )::integer AS precalc_mesh_repairing,
    count(*) FILTER (
      WHERE point_state <> 'released' AND canonical_blocked AND blocked_mesh
    )::integer AS blocked_mesh_quality,
    count(*) FILTER (
      WHERE point_state <> 'released' AND canonical_blocked AND blocked_exhausted
    )::integer AS blocked_precalc_exhausted,
    count(*) FILTER (
      WHERE point_state <> 'released' AND canonical_blocked AND blocked_submit
    )::integer AS blocked_engine_submit,
    count(*) FILTER (
      WHERE point_state <> 'released'
        AND canonical_blocked
        AND NOT COALESCE(blocked_mesh, false)
        AND NOT COALESCE(blocked_exhausted, false)
        AND NOT COALESCE(blocked_submit, false)
    )::integer AS blocked_other
  FROM classified
  GROUP BY campaign_id, condition_id, airfoil_id
)
UPDATE sim_campaign_progress progress
SET
  blocked = backfill.blocked,
  precalc_mesh_repairing = backfill.precalc_mesh_repairing,
  blocked_mesh_quality = backfill.blocked_mesh_quality,
  blocked_precalc_exhausted = backfill.blocked_precalc_exhausted,
  blocked_engine_submit = backfill.blocked_engine_submit,
  blocked_other = backfill.blocked_other
FROM progress_backfill backfill
WHERE progress.campaign_id = backfill.campaign_id
  AND progress.condition_id = backfill.condition_id
  AND progress.airfoil_id = backfill.airfoil_id;
--> statement-breakpoint
ALTER TABLE "sim_campaign_progress"
  ADD CONSTRAINT "sim_campaign_progress_remediation_nonnegative_check"
  CHECK (
    "precalc_mesh_repairing" >= 0
    AND "blocked_mesh_quality" >= 0
    AND "blocked_precalc_exhausted" >= 0
    AND "blocked_engine_submit" >= 0
    AND "blocked_other" >= 0
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "sim_campaign_progress"
  VALIDATE CONSTRAINT "sim_campaign_progress_remediation_nonnegative_check";
--> statement-breakpoint
ALTER TABLE "sim_campaign_progress"
  ADD CONSTRAINT "sim_campaign_progress_blocked_reason_conservation_check"
  CHECK (
    "blocked" = "blocked_mesh_quality"
      + "blocked_precalc_exhausted"
      + "blocked_engine_submit"
      + "blocked_other"
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "sim_campaign_progress"
  VALIDATE CONSTRAINT "sim_campaign_progress_blocked_reason_conservation_check";
