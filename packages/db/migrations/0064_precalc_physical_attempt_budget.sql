-- PRECALC's two-attempt limit is a physical CFD budget, not an engine-task
-- budget. Keep every accepted engine submission as immutable audit while
-- allowing infrastructure interruptions and deterministic setup/mesh
-- failures to be retried automatically without exhausting CFD attempts.
ALTER TABLE "sim_precalc_obligation_attempts"
  ADD COLUMN IF NOT EXISTS "solver_attempt_number" integer,
  ADD COLUMN IF NOT EXISTS "consumes_solver_attempt" boolean DEFAULT true NOT NULL;
--> statement-breakpoint

UPDATE "sim_precalc_obligation_attempts"
SET "solver_attempt_number" = "attempt_number"
WHERE "solver_attempt_number" IS NULL
  AND "consumes_solver_attempt";
--> statement-breakpoint

ALTER TABLE "sim_precalc_obligation_attempts"
  DROP CONSTRAINT IF EXISTS "sim_precalc_obligation_attempts_number_check";
--> statement-breakpoint
ALTER TABLE "sim_precalc_obligation_attempts"
  ADD CONSTRAINT "sim_precalc_obligation_attempts_number_check"
    CHECK ("attempt_number" > 0);
--> statement-breakpoint
ALTER TABLE "sim_precalc_obligation_attempts"
  ADD CONSTRAINT "sim_precalc_obligation_attempts_solver_number_check"
    CHECK ("solver_attempt_number" IS NULL OR "solver_attempt_number" IN (1, 2));
--> statement-breakpoint
DROP INDEX IF EXISTS "sim_precalc_obligations_mesh_recovery_candidate_idx";
--> statement-breakpoint
CREATE INDEX "sim_precalc_obligations_mesh_recovery_candidate_idx"
  ON "sim_precalc_obligations" ("id")
  WHERE "state" = 'blocked'
    AND "attempt_count" < "max_attempts"
    AND "last_outcome" = 'deterministic_failure';
--> statement-breakpoint

-- Structured deterministic mesh/setup failures happened before usable CFD
-- evidence. Their immutable submission rows remain, but they no longer spend
-- a physical solver attempt.
UPDATE "sim_precalc_obligation_attempts"
SET "consumes_solver_attempt" = false,
    "solver_attempt_number" = NULL,
    "updatedAt" = now()
WHERE "outcome" = 'deterministic_failure'
  AND "state" = 'failed';
--> statement-breakpoint

-- Reconcile the production worker-loss signature that predates the typed
-- non-consuming settlement. Typed infrastructure evidence is authoritative;
-- the legacy text predicate is deliberately narrow to the zombie-task
-- detector's exact diagnosis.
UPDATE "sim_precalc_obligation_attempts" attempt
SET "consumes_solver_attempt" = false,
    "solver_attempt_number" = NULL,
    "updatedAt" = now()
WHERE attempt."consumes_solver_attempt"
  AND (
    EXISTS (
      SELECT 1
      FROM "result_attempts" result_attempt
      WHERE result_attempt."id" = attempt."result_attempt_id"
        AND result_attempt."evidence_payload" ->> 'failure_disposition' = 'infrastructure'
    )
    OR COALESCE(attempt."error", '') LIKE '%no OpenFOAM process exists%task lost%'
    OR EXISTS (
      SELECT 1
      FROM "sim_jobs" job
      WHERE job."id" = attempt."sim_job_id"
        AND job."status" = 'cancelled'
        AND COALESCE(job."error", '') LIKE '%no OpenFOAM process exists%task lost%'
    )
  );
--> statement-breakpoint

-- Removing a setup/infrastructure submission can leave the first real CFD
-- window carrying legacy ordinal 2. Compact only the mutable budget ordinal;
-- attempt_number remains the immutable engine-submission order.
WITH ranked AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "obligation_id"
           ORDER BY "attempt_number"
         )::integer AS "solver_attempt_number"
  FROM "sim_precalc_obligation_attempts"
  WHERE "consumes_solver_attempt"
)
UPDATE "sim_precalc_obligation_attempts" attempt
SET "solver_attempt_number" = ranked."solver_attempt_number",
    "updatedAt" = now()
FROM ranked
WHERE attempt."id" = ranked."id"
  AND attempt."solver_attempt_number" IS DISTINCT FROM ranked."solver_attempt_number";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sim_precalc_obligation_attempts_solver_number_uq"
  ON "sim_precalc_obligation_attempts" ("obligation_id", "solver_attempt_number")
  WHERE "solver_attempt_number" IS NOT NULL;
--> statement-breakpoint

-- The obligation counter is the number of physical CFD attempts, while
-- attempt_number remains the monotonic submission audit sequence.
UPDATE "sim_precalc_obligations" obligation
SET "attempt_count" = COALESCE((
      SELECT count(*)::integer
      FROM "sim_precalc_obligation_attempts" attempt
      WHERE attempt."obligation_id" = obligation."id"
        AND attempt."consumes_solver_attempt"
    ), 0),
    "updatedAt" = now();
--> statement-breakpoint

-- A row that was blocked only because the old counter included setup or
-- infrastructure submissions has restored physical budget. Reopen it only
-- while an owner is still live, no accepted PRECALC truth exists, and no
-- active job already owns the exact obligation.
UPDATE "sim_precalc_obligations" obligation
SET "state" = 'pending',
    "submit_failure_count" = 0,
    "next_submit_at" = NULL,
    "last_outcome" = 'attempt_budget_reconciled',
    "completed_at" = NULL,
    "updatedAt" = now()
WHERE obligation."state" = 'blocked'
  AND obligation."attempt_count" < obligation."max_attempts"
  AND obligation."last_outcome" IN (
    'failed_exhausted',
    'rejected_exhausted',
    'cancelled_exhausted'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "sim_jobs" active_job
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(active_job."request_payload" -> 'precalcObligationIds') = 'array'
        THEN active_job."request_payload" -> 'precalcObligationIds'
        ELSE '[]'::jsonb
      END
    ) active_payload_obligation(id)
    WHERE active_payload_obligation.id = obligation."id"::text
      AND active_job."status" IN ('pending', 'submitted', 'running', 'ingesting')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "result_attempts" accepted_attempt
    JOIN "result_classifications" accepted_classification
      ON accepted_classification."result_attempt_id" = accepted_attempt."id"
     AND accepted_classification."state" = 'accepted'
    WHERE accepted_attempt."airfoil_id" = obligation."airfoil_id"
      AND accepted_attempt."simulation_preset_revision_id" = obligation."revision_id"
      AND accepted_attempt."aoa_deg" = obligation."aoa_deg"
      AND (
        accepted_attempt."regime" = 'urans'
        OR accepted_attempt."evidence_payload" ->> 'fidelity' = 'urans_precalc'
      )
  )
  AND (
    obligation."background_owner"
    OR EXISTS (
      SELECT 1
      FROM "sim_precalc_obligation_campaigns" ownership
      JOIN "sim_campaigns" campaign ON campaign."id" = ownership."campaign_id"
      WHERE ownership."obligation_id" = obligation."id"
        AND ownership."state" = 'active'
        AND campaign."status" IN ('active', 'attention', 'paused')
    )
    OR EXISTS (
      SELECT 1
      FROM "sim_precalc_obligation_requests" coverage
      JOIN "sim_urans_requests" request ON request."id" = coverage."request_id"
      WHERE coverage."obligation_id" = obligation."id"
        AND request."background_owner"
        AND request."state" IN ('pending', 'running')
    )
    OR EXISTS (
      SELECT 1
      FROM "sync_sweep_promise_points" promise_point
      JOIN "sync_sweep_promises" promise ON promise."id" = promise_point."promise_id"
      WHERE promise_point."airfoil_id" = obligation."airfoil_id"
        AND promise_point."simulation_preset_revision_id" = obligation."revision_id"
        AND promise_point."aoa_deg" = obligation."aoa_deg"
        AND promise_point."status" = 'active'
        AND promise."status" = 'active'
        AND promise."expiresAt" > now()
        AND promise."request_payload" ->> 'remoteSolver' = 'true'
    )
  );
