-- Final/full URANS is an automatic reliability stage, not a one-shot queue
-- item. Preserve the accepted preliminary result while immutable full-fidelity
-- attempts accumulate, and keep the corrective state durable across sweeper
-- restarts.
ALTER TABLE "sim_urans_verify_queue"
  ADD COLUMN IF NOT EXISTS "fresh_attempt_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "max_fresh_attempts" integer DEFAULT 2 NOT NULL,
  ADD COLUMN IF NOT EXISTS "continuation_attempt_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "latest_result_attempt_id" uuid
    REFERENCES "result_attempts"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "next_submit_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_outcome" text,
  ADD COLUMN IF NOT EXISTS "last_error" text;
--> statement-breakpoint

-- Reconstruct the physical retry ledger from durable submitted-job history.
-- A continuation extends one existing trajectory; it never spends a fresh
-- solve. Preserve unexpected historical fresh-start counts and widen only
-- that row's future bound when old data already exceeds the new two-start
-- policy. Legacy continuation counts are normalized to the enforceable
-- one-per-observed-trajectory invariant; immutable jobs/attempts retain the
-- complete audit history.
WITH counts AS (
  SELECT q.id,
         COUNT(*) FILTER (
           WHERE job."submittedAt" IS NOT NULL
             AND COALESCE(job.request_payload ->> 'finalRecoveryMode', 'fresh') <> 'continuation'
             AND job.request_payload ->> 'continueFromResultAttemptId' IS NULL
         )::integer AS fresh_count,
         COUNT(*) FILTER (
           WHERE job."submittedAt" IS NOT NULL
             AND (
               job.request_payload ->> 'finalRecoveryMode' = 'continuation'
               OR job.request_payload ->> 'continueFromResultAttemptId' IS NOT NULL
             )
         )::integer AS continuation_count
  FROM "sim_urans_verify_queue" q
  LEFT JOIN "sim_jobs" job
    ON job.request_payload ->> 'verifyQueueItemId' = q.id::text
   AND job.request_payload ->> 'uransFidelity' = 'full'
  GROUP BY q.id
)
UPDATE "sim_urans_verify_queue" q
SET "fresh_attempt_count" = counts.fresh_count,
    "max_fresh_attempts" = GREATEST(q."max_fresh_attempts", counts.fresh_count, 2),
    "continuation_attempt_count" = LEAST(
      counts.continuation_count,
      GREATEST(counts.fresh_count, 0)
    ),
    "updatedAt" = now()
FROM counts
WHERE q.id = counts.id;
--> statement-breakpoint

-- Pin the latest exact full-fidelity attempt even when the replace guard kept
-- the accepted preliminary generation selected as the canonical result.
WITH ranked AS (
  SELECT q.id AS queue_id,
         attempt.id AS result_attempt_id,
         row_number() OVER (
           PARTITION BY q.id
           ORDER BY attempt."createdAt" DESC, attempt.id DESC
         ) AS ordinal
  FROM "sim_urans_verify_queue" q
  JOIN "sim_jobs" job
    ON job.request_payload ->> 'verifyQueueItemId' = q.id::text
  JOIN "result_attempts" attempt
    ON attempt.sim_job_id = job.id
   AND attempt.airfoil_id = q.airfoil_id
   AND attempt.simulation_preset_revision_id = q.revision_id
   AND attempt.aoa_deg = q.aoa_deg
   AND attempt.evidence_payload ->> 'fidelity' = 'urans_full'
)
UPDATE "sim_urans_verify_queue" q
SET "latest_result_attempt_id" = ranked.result_attempt_id,
    "updatedAt" = now()
FROM ranked
WHERE q.id = ranked.queue_id
  AND ranked.ordinal = 1;
--> statement-breakpoint

-- The old controller cancelled completed-but-nonpublishable final attempts.
-- Several historical queue rows may exist for one physical cell. Elect one
-- deterministic target (an already-open row wins; otherwise the newest
-- recoverable cancelled row), merge every live owner onto it, and reopen only
-- that target. Non-winners remain immutable terminal history. Ranking before
-- the UPDATE is mandatory: one snapshot-level UPDATE of every cancelled row
-- would make two siblings pending and abort on the partial open-cell unique
-- index.
WITH recoverable AS (
  SELECT
    q.id AS source_id,
    q.airfoil_id,
    q.revision_id,
    q.aoa_deg,
    q.background_owner,
    COALESCE(attempt."solvedAt", attempt."createdAt") AS evidence_at
  FROM "sim_urans_verify_queue" q
  JOIN "result_attempts" attempt
    ON attempt.id = q.latest_result_attempt_id
  LEFT JOIN "result_classifications" classification
    ON classification.result_attempt_id = attempt.id
  JOIN "results" preliminary
    ON preliminary.id = attempt.result_id
   AND preliminary.id = q.precalc_result_id
  WHERE q.state = 'cancelled'
    AND attempt.status = 'done'
    AND attempt.source = 'solved'
    AND attempt.evidence_payload ->> 'fidelity' = 'urans_full'
    AND classification.state IS DISTINCT FROM 'accepted'
    AND preliminary.status = 'done'
    AND preliminary.fidelity = 'urans_precalc'
    AND (
      q.background_owner
      OR EXISTS (
        SELECT 1
        FROM "sim_urans_verify_queue_campaigns" ownership
        JOIN "sim_campaigns" campaign
          ON campaign.id = ownership.campaign_id
        WHERE ownership.queue_id = q.id
          AND ownership.state = 'active'
          AND campaign.status IN ('active', 'attention', 'paused')
      )
    )
    AND (
      classification.reasons = ARRAY['missing-urans-video']::text[]
      OR (
        attempt.engine_job_id IS NOT NULL
        AND attempt.engine_case_slug IS NOT NULL
        AND q.continuation_attempt_count < q.fresh_attempt_count
        AND EXISTS (
          SELECT 1
          FROM unnest(
            COALESCE(attempt.quality_warnings, ARRAY[]::text[])
          ) warning
          WHERE warning LIKE '%stopped by the wall-clock budget guard%'
             OR warning LIKE '%requires further same-case integration%'
        )
      )
      OR q.fresh_attempt_count < q.max_fresh_attempts
    )
),
ranked AS (
  SELECT
    recoverable.*,
    row_number() OVER (
      PARTITION BY airfoil_id, revision_id, aoa_deg
      ORDER BY evidence_at DESC, source_id DESC
    ) AS recovery_rank
  FROM recoverable
),
mapped AS (
  SELECT
    ranked.*,
    COALESCE(
      (
        SELECT open_item.id
        FROM "sim_urans_verify_queue" open_item
        WHERE open_item.airfoil_id = ranked.airfoil_id
          AND open_item.revision_id = ranked.revision_id
          AND open_item.aoa_deg = ranked.aoa_deg
          AND open_item.state IN ('pending', 'running')
        ORDER BY open_item."createdAt", open_item.id
        LIMIT 1
      ),
      first_value(source_id) OVER (
        PARTITION BY airfoil_id, revision_id, aoa_deg
        ORDER BY recovery_rank
      )
    ) AS target_id
  FROM ranked
),
target_summary AS (
  SELECT
    target_id,
    bool_or(background_owner) AS inherited_background_owner
  FROM mapped
  GROUP BY target_id
),
merged_campaigns AS (
  INSERT INTO "sim_urans_verify_queue_campaigns" (
    queue_id,
    campaign_id,
    state,
    cancelled_at,
    "createdAt",
    "updatedAt"
  )
  SELECT
    mapped.target_id,
    ownership.campaign_id,
    'active',
    NULL,
    min(ownership."createdAt"),
    now()
  FROM mapped
  JOIN "sim_urans_verify_queue_campaigns" ownership
    ON ownership.queue_id = mapped.source_id
   AND ownership.state = 'active'
  GROUP BY mapped.target_id, ownership.campaign_id
  ON CONFLICT (queue_id, campaign_id) DO UPDATE
  SET state = 'active',
      cancelled_at = NULL,
      "updatedAt" = now()
  RETURNING queue_id
),
target_details AS (
  SELECT
    summary.target_id,
    summary.inherited_background_owner,
    target.state AS target_state,
    attempt.engine_job_id,
    attempt.engine_case_slug,
    attempt.quality_warnings,
    attempt.error,
    classification.reasons
  FROM target_summary summary
  JOIN "sim_urans_verify_queue" target
    ON target.id = summary.target_id
  LEFT JOIN "result_attempts" attempt
    ON attempt.id = target.latest_result_attempt_id
  LEFT JOIN "result_classifications" classification
    ON classification.result_attempt_id = attempt.id
)
UPDATE "sim_urans_verify_queue" target
SET background_owner =
      target.background_owner OR details.inherited_background_owner,
    state = CASE
      WHEN details.target_state = 'cancelled' THEN 'pending'
      ELSE target.state
    END,
    sim_job_id = CASE
      WHEN details.target_state = 'cancelled' THEN NULL
      ELSE target.sim_job_id
    END,
    next_submit_at = CASE
      WHEN details.target_state = 'cancelled' THEN NULL
      ELSE target.next_submit_at
    END,
    last_outcome = CASE
      WHEN details.target_state <> 'cancelled' THEN target.last_outcome
      WHEN details.reasons = ARRAY['missing-urans-video']::text[]
      THEN 'media_repair_pending'
      WHEN details.engine_job_id IS NOT NULL
       AND details.engine_case_slug IS NOT NULL
       AND target.continuation_attempt_count < target.fresh_attempt_count
       AND EXISTS (
         SELECT 1
         FROM unnest(
           COALESCE(details.quality_warnings, ARRAY[]::text[])
         ) warning
         WHERE warning LIKE '%stopped by the wall-clock budget guard%'
            OR warning LIKE '%requires further same-case integration%'
       )
      THEN 'continuation_pending'
      ELSE 'fresh_retry_pending'
    END,
    last_error = CASE
      WHEN details.target_state <> 'cancelled' THEN target.last_error
      ELSE COALESCE(
        NULLIF(details.error, ''),
        NULLIF(array_to_string(details.reasons, ', '), ''),
        'full URANS completed without publishable evidence'
      )
    END,
    "updatedAt" = now()
FROM target_details details
WHERE target.id = details.target_id
  AND (
    details.target_state = 'cancelled'
    OR (
      NOT target.background_owner
      AND details.inherited_background_owner
    )
  );
--> statement-breakpoint

ALTER TABLE "sim_urans_verify_queue"
  ADD CONSTRAINT "sim_urans_verify_queue_fresh_attempt_count_check"
    CHECK ("fresh_attempt_count" >= 0),
  ADD CONSTRAINT "sim_urans_verify_queue_max_fresh_attempts_check"
    CHECK ("max_fresh_attempts" >= 1),
  ADD CONSTRAINT "sim_urans_verify_queue_continuation_attempt_count_check"
    CHECK (
      "continuation_attempt_count" >= 0
      AND "continuation_attempt_count" <= "fresh_attempt_count"
    );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sim_urans_verify_queue_pending_due_idx"
  ON "sim_urans_verify_queue" ("next_submit_at", "createdAt")
  WHERE state = 'pending';
