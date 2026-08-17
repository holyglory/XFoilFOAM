-- A permanently unusable continuation source is terminal only for that exact
-- immutable checkpoint. Older controllers left the parent physical cell
-- blocked even where its second fresh PRECALC attempt was still available.
-- Reopen only live cells with the audited non-consuming permanent submission;
-- no result or attempt evidence is changed by this data-only correction.
UPDATE "sim_precalc_obligations" obligation
SET
  "state" = 'pending',
  "latest_sim_job_id" = NULL,
  "submit_failure_count" = 0,
  "next_submit_at" = now(),
  "last_outcome" = 'fresh_recovery_pending',
  "completed_at" = NULL,
  "updatedAt" = now()
WHERE obligation."state" = 'blocked'
  AND obligation."last_outcome" = 'continuation_permanent_failure'
  AND obligation."attempt_count" < obligation."max_attempts"
  AND EXISTS (
    SELECT 1
    FROM "sim_precalc_obligation_attempts" terminal_submission
    JOIN "sim_jobs" terminal_job
      ON terminal_job."id" = terminal_submission."sim_job_id"
    JOIN "result_attempts" continuation_source_attempt
      ON continuation_source_attempt."id"::text =
        terminal_job."request_payload" ->> 'continueFromResultAttemptId'
    JOIN "sim_jobs" continuation_source_job
      ON continuation_source_job."id" = continuation_source_attempt."sim_job_id"
    JOIN "results" continuation_source_result
      ON continuation_source_result."id" = continuation_source_attempt."result_id"
      AND continuation_source_result."id"::text =
        terminal_job."request_payload" ->> 'continueFromResultId'
    JOIN "simulation_preset_revisions" target_revision
      ON target_revision."id" = obligation."revision_id"
    JOIN "simulation_presets" target_preset
      ON target_preset."id" = target_revision."preset_id"
    WHERE terminal_submission."obligation_id" = obligation."id"
      AND terminal_submission."state" = 'failed'
      AND terminal_submission."outcome" = 'continuation_permanent_failure'
      AND NOT terminal_submission."consumes_solver_attempt"
      AND obligation."latest_sim_job_id" = terminal_job."id"
      AND terminal_job."status" IN ('done', 'failed', 'cancelled')
      AND terminal_job."airfoil_id" = obligation."airfoil_id"
      AND terminal_job."simulation_preset_revision_id" = obligation."revision_id"
      AND CASE
        WHEN jsonb_typeof(terminal_job."request_payload" -> 'aoas') = 'array'
        THEN jsonb_array_length(terminal_job."request_payload" -> 'aoas') = 1
        ELSE false
      END
      AND terminal_job."request_payload" -> 'aoas' @>
        jsonb_build_array(obligation."aoa_deg")
      AND CASE
        WHEN jsonb_typeof(terminal_job."bc_ids") = 'array'
        THEN jsonb_array_length(terminal_job."bc_ids") = 1
        ELSE false
      END
      AND terminal_job."bc_ids" @> jsonb_build_array(continuation_source_attempt."bc_id")
      AND terminal_job."request_payload" ? 'continueFromResultId'
      AND terminal_job."request_payload" ? 'continueFromResultAttemptId'
      AND terminal_job."request_payload" ->> 'continueFromResultId' <> ''
      AND terminal_job."request_payload" ->> 'continueFromResultAttemptId' <> ''
      AND continuation_source_attempt."airfoil_id" = obligation."airfoil_id"
      AND continuation_source_attempt."simulation_preset_revision_id" =
        obligation."revision_id"
      AND continuation_source_attempt."aoa_deg" = obligation."aoa_deg"
      AND continuation_source_job."airfoil_id" = obligation."airfoil_id"
      AND continuation_source_job."simulation_preset_revision_id" =
        obligation."revision_id"
      AND NULLIF(btrim(continuation_source_job."engine_job_id"), '') IS NOT NULL
      AND continuation_source_attempt."engine_job_id" =
        continuation_source_job."engine_job_id"
      AND CASE
        WHEN jsonb_typeof(continuation_source_job."bc_ids") = 'array'
        THEN jsonb_array_length(continuation_source_job."bc_ids") = 1
        ELSE false
      END
      AND continuation_source_job."bc_ids" @>
        jsonb_build_array(continuation_source_attempt."bc_id")
      AND CASE
        WHEN terminal_job."solver_implementation_id" =
          '2f8bc764-09ae-4ff3-8fd2-000000000000'::uuid
        THEN '2f8bc764-09ae-4ff3-8fd2-240600000001'::uuid
        ELSE terminal_job."solver_implementation_id"
      END = CASE
        WHEN target_revision."solver_implementation_id" =
          '2f8bc764-09ae-4ff3-8fd2-000000000000'::uuid
        THEN '2f8bc764-09ae-4ff3-8fd2-240600000001'::uuid
        ELSE target_revision."solver_implementation_id"
      END
      AND CASE
        WHEN continuation_source_job."solver_implementation_id" =
          '2f8bc764-09ae-4ff3-8fd2-000000000000'::uuid
        THEN '2f8bc764-09ae-4ff3-8fd2-240600000001'::uuid
        ELSE continuation_source_job."solver_implementation_id"
      END = CASE
        WHEN target_revision."solver_implementation_id" =
          '2f8bc764-09ae-4ff3-8fd2-000000000000'::uuid
        THEN '2f8bc764-09ae-4ff3-8fd2-240600000001'::uuid
        ELSE target_revision."solver_implementation_id"
      END
      AND CASE
        WHEN continuation_source_attempt."solver_implementation_id" =
          '2f8bc764-09ae-4ff3-8fd2-000000000000'::uuid
        THEN '2f8bc764-09ae-4ff3-8fd2-240600000001'::uuid
        ELSE continuation_source_attempt."solver_implementation_id"
      END = CASE
        WHEN target_revision."solver_implementation_id" =
          '2f8bc764-09ae-4ff3-8fd2-000000000000'::uuid
        THEN '2f8bc764-09ae-4ff3-8fd2-240600000001'::uuid
        ELSE target_revision."solver_implementation_id"
      END
      AND NULLIF(btrim(continuation_source_attempt."engine_case_slug"), '') IS NOT NULL
      AND continuation_source_result."airfoil_id" = obligation."airfoil_id"
      AND continuation_source_result."bc_id" = continuation_source_attempt."bc_id"
      AND continuation_source_attempt."bc_id" = COALESCE(
        CASE
          WHEN COALESCE(
            target_revision."snapshot" #>> '{preset,legacyBoundaryConditionId}',
            ''
          ) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN (
            target_revision."snapshot" #>> '{preset,legacyBoundaryConditionId}'
          )::uuid
          ELSE NULL
        END,
        target_preset."legacy_boundary_condition_id"
      )
      AND continuation_source_result."simulation_preset_revision_id" =
        obligation."revision_id"
      AND continuation_source_result."aoa_deg" = obligation."aoa_deg"
      AND continuation_source_result."engine_job_id" =
        continuation_source_attempt."engine_job_id"
      AND continuation_source_result."engine_case_slug" =
        continuation_source_attempt."engine_case_slug"
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
--> statement-breakpoint

-- A one-angle request that directly owned the terminal continuation must not
-- serialize the dead checkpoint again after the obligation reopens. Clear it
-- only when the terminal job, request id, exact source pair, and natural cell
-- all agree. Other pending/running requests retain their selected source.
UPDATE "sim_urans_requests" request
SET
  "state" = 'pending',
  "sim_job_id" = NULL,
  "continue_from_result_id" = NULL,
  "continue_from_result_attempt_id" = NULL,
  "budget_override_s" = NULL,
  "corrective_tail_periods" = NULL,
  "clean_cycle_recovery_policy_version" = NULL,
  "updatedAt" = now()
FROM "sim_precalc_obligation_requests" coverage
JOIN "sim_precalc_obligations" obligation
  ON obligation."id" = coverage."obligation_id"
JOIN "sim_precalc_obligation_attempts" terminal_submission
  ON terminal_submission."obligation_id" = obligation."id"
JOIN "sim_jobs" terminal_job
  ON terminal_job."id" = terminal_submission."sim_job_id"
WHERE request."id" = coverage."request_id"
  AND request."fidelity" = 'precalc'
  AND request."state" IN ('blocked', 'pending', 'running')
  AND request."aoa_deg" IS NOT DISTINCT FROM obligation."aoa_deg"
  AND obligation."state" = 'pending'
  AND obligation."last_outcome" = 'fresh_recovery_pending'
  AND terminal_submission."state" = 'failed'
  AND terminal_submission."outcome" = 'continuation_permanent_failure'
  AND NOT terminal_submission."consumes_solver_attempt"
  AND terminal_job."airfoil_id" = obligation."airfoil_id"
  AND terminal_job."simulation_preset_revision_id" = obligation."revision_id"
  AND CASE
    WHEN jsonb_typeof(terminal_job."request_payload" -> 'aoas') = 'array'
    THEN jsonb_array_length(terminal_job."request_payload" -> 'aoas') = 1
    ELSE false
  END
  AND terminal_job."request_payload" -> 'aoas' @>
    jsonb_build_array(obligation."aoa_deg")
  AND terminal_job."status" IN ('done', 'failed', 'cancelled')
  AND request."sim_job_id" = terminal_job."id"
  AND terminal_job."request_payload" ->> 'uransRequestId' = request."id"::text
  AND terminal_job."request_payload" ->> 'continueFromResultId' =
    request."continue_from_result_id"::text
  AND terminal_job."request_payload" ->> 'continueFromResultAttemptId' =
    request."continue_from_result_attempt_id"::text;
