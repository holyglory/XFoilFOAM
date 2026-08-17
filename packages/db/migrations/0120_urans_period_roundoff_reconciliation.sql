-- Binary64 timestamp / period division can represent an exact three-period
-- PRECALC window a few ULPs below 3. Migration 0120 does not accept or rewrite
-- any coefficients. It retires only v12 incidents whose immutable attempt,
-- classifier row, clean-cycle certificate, incident metadata, latest
-- obligation submission, and verified GCS archive all prove that exact
-- arithmetic-boundary shape. The failed clean-cycle-v5 reduction receipt stays
-- immutable history. 0120 creates a clean-cycle-v6 reducer identity and a new
-- exact archive-reduction receipt; that normal generation-pinned reducer
-- remains the sole publication authority and will settle the obligation only
-- after authenticating the archive. The migration is replay-safe: a matching
-- existing v6 receipt proves resolution only when it is actively runnable, or
-- when its exact archive_backfill interpretation already reduced as accepted.
-- Failed, terminal, or merely similar receipts do not resolve the incident.
WITH new_reducer AS (
  INSERT INTO "result_reducer_versions" (
    "id",
    "reducer_key",
    "reducer_version",
    "build_id",
    "policy_sha256",
    "policy",
    "source",
    "createdAt"
  ) VALUES (
    gen_random_uuid(),
    'airfoilfoam',
    'result-interpretation-v2',
    'clean-cycle-v6',
    '782075da76b45b55e7ec98c6bb653a4c52cc3fc9931d3dc0cf1d8a18adc3e92d',
    '{"contract":"result-interpretation-v1","noShedding":{"allChannelAmplitudeProof":true,"certificate":"no-shedding-v2","minSourceSamples":20,"minTransportSamples":20},"rans":{"certificate":"rans-hold-v1","dedicatedHoldRequired":true,"requiredFinalWindowSamples":200},"urans":{"certificate":"clean-cycle-v3","fastMinimumCleanCycles":3,"finalMinimumCleanCycles":5,"minCoefficientSamplesPerCycle":20,"minFieldFramesPerCycle":20,"periodBoundaryUlps":4}}'::jsonb,
    'migration:0120-period-roundoff',
    now()
  )
  ON CONFLICT (
    "reducer_key", "reducer_version", "build_id", "policy_sha256"
  ) DO NOTHING
  RETURNING "id"
), target_reducer AS MATERIALIZED (
  SELECT "id" FROM new_reducer
  UNION ALL
  SELECT reducer."id"
  FROM "result_reducer_versions" reducer
  WHERE reducer."reducer_key" = 'airfoilfoam'
    AND reducer."reducer_version" = 'result-interpretation-v2'
    AND reducer."build_id" = 'clean-cycle-v6'
    AND reducer."policy_sha256" = '782075da76b45b55e7ec98c6bb653a4c52cc3fc9931d3dc0cf1d8a18adc3e92d'
  LIMIT 1
), eligible AS MATERIALIZED (
  SELECT DISTINCT
    incident."id" AS incident_id,
    result."id" AS result_id,
    attempt."id" AS result_attempt_id,
    archive."id" AS source_archive_id,
    target_reducer."id" AS target_reducer_version_id
  FROM "sim_solver_incidents" incident
  JOIN "sim_precalc_obligations" obligation
    ON obligation."id" = incident."precalc_obligation_id"
  JOIN "result_attempts" attempt
    ON attempt."id" = incident."result_attempt_id"
  JOIN "results" result
    ON result."id" = attempt."result_id"
  JOIN "result_classifications" classification
    ON classification."result_attempt_id" = attempt."id"
  JOIN "sim_precalc_obligation_attempts" submission
    ON submission."obligation_id" = obligation."id"
    AND submission."sim_job_id" = attempt."sim_job_id"
    AND submission."result_attempt_id" = attempt."id"
  JOIN "solver_evidence_archives" archive
    ON archive."result_id" = result."id"
    AND archive."result_attempt_id" = attempt."id"
    AND archive."state" = 'current'
  JOIN "solver_evidence_blobs" blob
    ON blob."id" = archive."blob_id"
  JOIN "result_archive_reduction_queue" publication_queue
    ON publication_queue."result_id" = result."id"
    AND publication_queue."result_attempt_id" = attempt."id"
    AND publication_queue."source_archive_id" = archive."id"
  JOIN "result_reducer_versions" reducer
    ON reducer."id" = publication_queue."reducer_version_id"
  CROSS JOIN target_reducer
  WHERE incident."stage" = 'preliminary'
    AND incident."reason" = 'insufficient-periods'
    AND incident."severity" = 'critical'
    AND incident."status" = 'open'
    AND incident."remediation_version" = 'urans-recovery-2026-08-02-v12'
    AND incident."result_id" IS NULL
    AND incident."verify_queue_id" IS NULL
    AND incident."urans_request_id" IS NULL
    AND incident."precalc_obligation_id" IS NOT NULL
    AND incident."sim_job_id" = attempt."sim_job_id"
    AND incident."metadata" ->> 'lastOutcome' = 'rejected_exhausted'
    AND incident."metadata" ->> 'failureDisposition' = 'none'
    AND incident."metadata" -> 'classificationReasons' = '["insufficient-periods"]'::jsonb
    AND incident."metadata" #>> '{progress,stationary}' = 'true'
    AND jsonb_typeof(incident."metadata" #> '{progress,periodsRetained}') = 'number'
    AND (incident."metadata" #>> '{progress,periodsRetained}')::double precision =
      (attempt."evidence_payload" #>> '{frame_track,periods_retained}')::double precision
    AND obligation."state" = 'blocked'
    AND obligation."last_outcome" = 'rejected_exhausted'
    AND obligation."latest_sim_job_id" = attempt."sim_job_id"
    AND submission."state" = 'rejected'
    AND submission."outcome" = 'rejected_exhausted'
    AND submission."consumes_solver_attempt"
    AND attempt."status" = 'done'
    AND attempt."source" = 'solved'
    AND attempt."regime" = 'urans'
    AND attempt."unsteady" = TRUE
    AND attempt."evidence_payload" ->> 'fidelity' = 'urans_precalc'
    AND attempt."evidence_payload" #>> '{frame_track,stationary}' = 'true'
    AND jsonb_typeof(attempt."evidence_payload" #> '{frame_track,periods_retained}') = 'number'
    AND (attempt."evidence_payload" #>> '{frame_track,periods_retained}')::double precision < 3.0
    AND 3.0 - (attempt."evidence_payload" #>> '{frame_track,periods_retained}')::double precision
      <= 4.0 * 2.0 * 2.220446049250313e-16
    AND attempt."evidence_payload" #>> '{urans_cycle_certificate,reducer_version}' = 'clean-cycle-v3'
    AND attempt."evidence_payload" #>> '{urans_cycle_certificate,certified}' = 'true'
    AND (attempt."evidence_payload" #>> '{urans_cycle_certificate,required_clean_cycles}')::integer = 3
    AND (attempt."evidence_payload" #>> '{urans_cycle_certificate,terminal_clean_cycles}')::integer >= 3
    AND classification."classifier_version" = 'fidelity-ladder-v7'
    AND classification."state" = 'rejected'
    AND classification."reasons" = ARRAY['insufficient-periods']::text[]
    AND blob."backend" = 'gcs'
    AND blob."compression" = 'zstd'
    AND blob."mime_type" = 'application/zstd'
    AND btrim(COALESCE(blob."bucket", '')) <> ''
    AND blob."generation" ~ '^[1-9][0-9]{0,19}$'
    AND blob."verifiedAt" IS NOT NULL
    AND publication_queue."state" = 'failed'
    AND publication_queue."last_error" = 'fetch failed'
    AND reducer."reducer_key" = 'airfoilfoam'
    AND reducer."reducer_version" = 'result-interpretation-v2'
    AND reducer."build_id" = 'clean-cycle-v5'
    AND NOT EXISTS (
      SELECT 1
      FROM "result_canonical_selections" selection
      JOIN "result_interpretations" interpretation
        ON interpretation."id" = selection."result_interpretation_id"
      WHERE selection."result_id" = result."id"
        AND selection."result_attempt_id" = attempt."id"
        AND interpretation."source" = 'archive_backfill'
        AND interpretation."state" = 'accepted'
        AND interpretation."source_archive_id" = archive."id"
        -- A previously accepted exact v6 receipt is the replay-safe success
        -- case below. An accepted interpretation from any other reducer still
        -- proves this migration must not reopen or reinterpret that source.
        AND interpretation."reducer_version_id"
          <> target_reducer."id"
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
    )
), enqueued AS (
  INSERT INTO "result_archive_reduction_queue" (
    "id",
    "result_id",
    "result_attempt_id",
    "source_archive_id",
    "reducer_version_id",
    "state",
    "attempt_count",
    "next_attempt_at",
    "createdAt",
    "updatedAt"
  )
  SELECT
    gen_random_uuid(),
    eligible.result_id,
    eligible.result_attempt_id,
    eligible.source_archive_id,
    eligible.target_reducer_version_id,
    'pending',
    0,
    now(),
    now(),
    now()
  FROM eligible
  ON CONFLICT (
    "result_attempt_id", "source_archive_id", "reducer_version_id"
  ) DO NOTHING
  RETURNING "result_attempt_id", "source_archive_id", "reducer_version_id"
), usable_v6_receipts AS MATERIALIZED (
  -- A first execution gets its authority from the inserted receipt. A replay
  -- must not duplicate it, but may resolve the exact false incident only if
  -- the retained v6 receipt still represents live reducer work or a completed
  -- accepted exact archive interpretation.
  SELECT
    enqueued."result_attempt_id",
    enqueued."source_archive_id",
    enqueued."reducer_version_id"
  FROM enqueued
  UNION
  SELECT
    eligible.result_attempt_id,
    eligible.source_archive_id,
    eligible.target_reducer_version_id
  FROM eligible
  JOIN "result_archive_reduction_queue" receipt
    ON receipt."result_id" = eligible.result_id
    AND receipt."result_attempt_id" = eligible.result_attempt_id
    AND receipt."source_archive_id" = eligible.source_archive_id
    AND receipt."reducer_version_id" = eligible.target_reducer_version_id
  LEFT JOIN "result_interpretations" accepted_interpretation
    ON accepted_interpretation."id" = receipt."result_interpretation_id"
    AND accepted_interpretation."result_id" = eligible.result_id
    AND accepted_interpretation."result_attempt_id" = eligible.result_attempt_id
    AND accepted_interpretation."source_archive_id" = eligible.source_archive_id
    AND accepted_interpretation."reducer_version_id" = eligible.target_reducer_version_id
    AND accepted_interpretation."source" = 'archive_backfill'
    AND accepted_interpretation."state" = 'accepted'
  WHERE receipt."state" IN ('pending', 'hydrating')
    OR (
      receipt."state" = 'reduced'
      AND accepted_interpretation."id" IS NOT NULL
    )
)
UPDATE "sim_solver_incidents" incident
SET
  "status" = 'resolved',
  "resolved_at" = now(),
  "updatedAt" = now()
FROM eligible
WHERE incident."id" = eligible.incident_id
  AND EXISTS (
    SELECT 1
    FROM usable_v6_receipts receipt
    WHERE receipt."result_attempt_id" = eligible.result_attempt_id
      AND receipt."source_archive_id" = eligible.source_archive_id
      AND receipt."reducer_version_id" = eligible.target_reducer_version_id
  );
