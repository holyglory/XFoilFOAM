-- Cross-job preliminary continuation must be bounded by real physical
-- progress, not by process-local retry counters or worker heartbeats.
ALTER TABLE "sim_precalc_obligations"
  ADD COLUMN IF NOT EXISTS "continuation_segment_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "continuation_no_progress_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

ALTER TABLE "sim_precalc_obligations"
  ADD CONSTRAINT "sim_precalc_obligations_continuation_progress_bounds_check"
    CHECK (
      "continuation_segment_count" >= 0
      AND "continuation_no_progress_count" >= 0
      AND "continuation_no_progress_count" <= "continuation_segment_count"
    );
--> statement-breakpoint

ALTER TABLE "sim_precalc_obligation_attempts"
  ADD COLUMN IF NOT EXISTS "continuation_segment_number" integer,
  ADD COLUMN IF NOT EXISTS "progress_periods_retained" double precision,
  ADD COLUMN IF NOT EXISTS "progress_simulated_time_s" double precision,
  ADD COLUMN IF NOT EXISTS "progress_drift_frac" double precision,
  ADD COLUMN IF NOT EXISTS "progress_stationary" boolean,
  ADD COLUMN IF NOT EXISTS "continuation_progressed" boolean;
--> statement-breakpoint

-- Preserve every real metric already present in immutable attempt payloads.
-- Malformed/legacy values stay NULL rather than being guessed.
UPDATE "sim_precalc_obligation_attempts" submission
SET "progress_periods_retained" = CASE
      WHEN jsonb_typeof(attempt.evidence_payload -> 'frame_track' -> 'periods_retained') = 'number'
      THEN (attempt.evidence_payload -> 'frame_track' ->> 'periods_retained')::double precision
      ELSE NULL
    END,
    "progress_simulated_time_s" = CASE
      WHEN jsonb_typeof(attempt.evidence_payload -> 'frame_track' -> 'window' -> 't_end') = 'number'
      THEN (attempt.evidence_payload -> 'frame_track' -> 'window' ->> 't_end')::double precision
      ELSE NULL
    END,
    "progress_drift_frac" = CASE
      WHEN jsonb_typeof(attempt.evidence_payload -> 'frame_track' -> 'drift_frac') = 'number'
      THEN (attempt.evidence_payload -> 'frame_track' ->> 'drift_frac')::double precision
      ELSE NULL
    END,
    "progress_stationary" = CASE
      WHEN jsonb_typeof(attempt.evidence_payload -> 'frame_track' -> 'stationary') = 'boolean'
      THEN (attempt.evidence_payload -> 'frame_track' ->> 'stationary')::boolean
      ELSE NULL
    END
FROM "result_attempts" attempt
WHERE attempt.id = submission.result_attempt_id;
--> statement-breakpoint

-- Historical same-case submissions get a durable ordinal. Their progress
-- comparison remains NULL because older controllers did not persist that
-- decision; migration never fabricates a verdict.
WITH continuation AS (
  SELECT submission.id,
         row_number() OVER (
           PARTITION BY submission.obligation_id
           ORDER BY submission.attempt_number, submission.id
         )::integer AS segment_number
  FROM "sim_precalc_obligation_attempts" submission
  JOIN "sim_jobs" job ON job.id = submission.sim_job_id
  WHERE submission.result_attempt_id IS NOT NULL
    AND (
      NULLIF(job.request_payload ->> 'continueFromResultAttemptId', '') IS NOT NULL
      OR NULLIF(job.request_payload ->> 'continueFromResultId', '') IS NOT NULL
    )
)
UPDATE "sim_precalc_obligation_attempts" submission
SET "continuation_segment_number" = continuation.segment_number
FROM continuation
WHERE submission.id = continuation.id;
--> statement-breakpoint

UPDATE "sim_precalc_obligations" obligation
SET "continuation_segment_count" = history.segment_count,
    "updatedAt" = now()
FROM (
  SELECT obligation_id, max(continuation_segment_number)::integer AS segment_count
  FROM "sim_precalc_obligation_attempts"
  WHERE continuation_segment_number IS NOT NULL
  GROUP BY obligation_id
) history
WHERE obligation.id = history.obligation_id;
--> statement-breakpoint

-- Legacy controllers could leave a physical obligation pending or blocked
-- even though an exact immutable URANS attempt for the same cell had already
-- classified accepted. Project that existing truth before applying bounded
-- continuation exhaustion or incident backfill. Only exact accepted evidence
-- qualifies; rejected/needs-URANS rows remain recovery work.
WITH accepted AS (
  SELECT
    obligation.id AS obligation_id,
    attempt.result_id,
    attempt.id AS result_attempt_id,
    row_number() OVER (
      PARTITION BY obligation.id
      ORDER BY
        CASE attempt.evidence_payload ->> 'fidelity'
          WHEN 'urans_full' THEN 2
          WHEN 'urans_precalc' THEN 1
          ELSE 0
        END DESC,
        COALESCE(attempt."solvedAt", attempt."createdAt") DESC,
        attempt.id DESC
    ) AS evidence_rank
  FROM "sim_precalc_obligations" obligation
  JOIN "result_attempts" attempt
    ON attempt.airfoil_id = obligation.airfoil_id
   AND attempt.simulation_preset_revision_id = obligation.revision_id
   AND attempt.aoa_deg = obligation.aoa_deg
   AND attempt.status = 'done'
   AND attempt.source = 'solved'
   AND attempt.evidence_payload ->> 'fidelity'
     IN ('urans_precalc', 'urans_full')
  JOIN "result_classifications" classification
    ON classification.result_attempt_id = attempt.id
   AND classification.state = 'accepted'
  JOIN "results" result
    ON result.id = attempt.result_id
   AND result.status = 'done'
   AND result.source = 'solved'
  WHERE obligation.state IN ('pending', 'blocked')
)
UPDATE "sim_precalc_obligations" obligation
SET state = 'satisfied',
    source_result_id = accepted.result_id,
    source_result_attempt_id = accepted.result_attempt_id,
    latest_sim_job_id = COALESCE(
      (
        SELECT attempt.sim_job_id
        FROM "result_attempts" attempt
        WHERE attempt.id = accepted.result_attempt_id
      ),
      obligation.latest_sim_job_id
    ),
    next_submit_at = NULL,
    last_outcome = 'accepted',
    last_error = NULL,
    completed_at = COALESCE(obligation.completed_at, now()),
    "updatedAt" = now()
FROM accepted
WHERE obligation.id = accepted.obligation_id
  AND accepted.evidence_rank = 1
  AND obligation.state IN ('pending', 'blocked');
--> statement-breakpoint

-- A legacy controller may already have run more same-case segments than the
-- new bounded recovery policy permits. Terminalize those idle cells now;
-- otherwise the bounded scheduler would correctly refuse another segment
-- while the old pending/blocked state left the campaign waiting forever.
UPDATE "sim_precalc_obligations" obligation
SET state = 'blocked',
    last_outcome = 'continuation_segment_exhausted',
    last_error =
      'historical same-case continuation count reached the bounded recovery limit',
    next_submit_at = NULL,
    completed_at = COALESCE(completed_at, now()),
    "updatedAt" = now()
WHERE obligation.continuation_segment_count >= 4
  AND obligation.state IN ('pending', 'blocked')
  AND NOT EXISTS (
    SELECT 1
    FROM "result_attempts" accepted_attempt
    JOIN "result_classifications" accepted_classification
      ON accepted_classification.result_attempt_id = accepted_attempt.id
     AND accepted_classification.state = 'accepted'
    WHERE accepted_attempt.airfoil_id = obligation.airfoil_id
      AND accepted_attempt.simulation_preset_revision_id =
        obligation.revision_id
      AND accepted_attempt.aoa_deg = obligation.aoa_deg
      AND (
        accepted_attempt.regime = 'urans'
        OR accepted_attempt.evidence_payload ->> 'fidelity' =
          'urans_precalc'
      )
  );
--> statement-breakpoint

ALTER TABLE "sim_precalc_obligation_attempts"
  ADD CONSTRAINT "sim_precalc_obligation_attempts_continuation_segment_check"
    CHECK (
      "continuation_segment_number" IS NULL
      OR "continuation_segment_number" > 0
    ),
  ADD CONSTRAINT "sim_precalc_obligation_attempts_continuation_progress_check"
    CHECK (
      "continuation_progressed" IS NULL
      OR "continuation_segment_number" IS NOT NULL
    );
--> statement-breakpoint

-- One row is one immutable recovery occurrence. Recurrence is grouped by
-- stage/reason/logical solver/remediation version in the bounded read model.
CREATE TABLE "sim_solver_incidents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stage" text NOT NULL,
  "reason" text NOT NULL,
  "severity" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "precalc_obligation_id" uuid
    REFERENCES "sim_precalc_obligations"("id") ON DELETE CASCADE,
  "verify_queue_id" uuid
    REFERENCES "sim_urans_verify_queue"("id") ON DELETE CASCADE,
  "urans_request_id" uuid
    REFERENCES "sim_urans_requests"("id") ON DELETE CASCADE,
  "solver_implementation_id" uuid NOT NULL
    REFERENCES "solver_implementations"("id"),
  "sim_job_id" uuid REFERENCES "sim_jobs"("id") ON DELETE SET NULL,
  "result_attempt_id" uuid
    REFERENCES "result_attempts"("id") ON DELETE SET NULL,
  "occurrence_key" text NOT NULL,
  "remediation_version" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sim_solver_incidents_owner_xor_check"
    CHECK (
      num_nonnulls(
        "precalc_obligation_id",
        "verify_queue_id",
        "urans_request_id"
      ) = 1
    ),
  CONSTRAINT "sim_solver_incidents_stage_check"
    CHECK ("stage" IN ('preliminary', 'final')),
  CONSTRAINT "sim_solver_incidents_severity_check"
    CHECK ("severity" IN ('warning', 'critical')),
  CONSTRAINT "sim_solver_incidents_status_check"
    CHECK ("status" IN ('open', 'resolved')),
  CONSTRAINT "sim_solver_incidents_status_shape_check"
    CHECK (
      ("status" = 'open' AND "resolved_at" IS NULL)
      OR ("status" = 'resolved' AND "resolved_at" IS NOT NULL)
    ),
  CONSTRAINT "sim_solver_incidents_reason_check"
    CHECK (btrim("reason") <> ''),
  CONSTRAINT "sim_solver_incidents_occurrence_key_check"
    CHECK (btrim("occurrence_key") <> ''),
  CONSTRAINT "sim_solver_incidents_remediation_version_check"
    CHECK (btrim("remediation_version") <> '')
);
--> statement-breakpoint

CREATE UNIQUE INDEX "sim_solver_incidents_occurrence_uq"
  ON "sim_solver_incidents" ("occurrence_key");
--> statement-breakpoint
CREATE INDEX "sim_solver_incidents_aggregate_idx"
  ON "sim_solver_incidents" (
    "stage",
    "reason",
    "solver_implementation_id",
    "remediation_version",
    "occurred_at"
  );
--> statement-breakpoint
CREATE INDEX "sim_solver_incidents_open_idx"
  ON "sim_solver_incidents" ("severity", "occurred_at")
  WHERE "status" = 'open';
--> statement-breakpoint
CREATE INDEX "sim_solver_incidents_precalc_owner_idx"
  ON "sim_solver_incidents" ("precalc_obligation_id", "status");
--> statement-breakpoint
CREATE INDEX "sim_solver_incidents_verify_owner_idx"
  ON "sim_solver_incidents" ("verify_queue_id", "status");
--> statement-breakpoint
CREATE INDEX "sim_solver_incidents_request_owner_idx"
  ON "sim_solver_incidents" ("urans_request_id", "status");
--> statement-breakpoint

CREATE TABLE "sim_solver_incident_campaigns" (
  "incident_id" uuid NOT NULL
    REFERENCES "sim_solver_incidents"("id") ON DELETE CASCADE,
  "campaign_id" uuid NOT NULL
    REFERENCES "sim_campaigns"("id") ON DELETE CASCADE,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sim_solver_incident_campaigns_pk"
    PRIMARY KEY ("incident_id", "campaign_id")
);
--> statement-breakpoint
CREATE INDEX "sim_solver_incident_campaigns_campaign_idx"
  ON "sim_solver_incident_campaigns" ("campaign_id", "incident_id");
--> statement-breakpoint

-- Existing exceptional PRECALC exhaustion must be visible immediately after
-- deploy. This creates incident metadata only; immutable attempts/results stay
-- untouched and remain the evidence source.
INSERT INTO "sim_solver_incidents" (
  "stage",
  "reason",
  "severity",
  "status",
  "precalc_obligation_id",
  "solver_implementation_id",
  "sim_job_id",
  "result_attempt_id",
  "occurrence_key",
  "remediation_version",
  "metadata"
)
SELECT
  'preliminary',
  CASE obligation.last_outcome
    WHEN 'continuation_no_progress_exhausted' THEN 'continuation-no-progress'
    WHEN 'continuation_segment_exhausted' THEN 'continuation-segment-limit'
    WHEN 'continuation_permanent_failure' THEN 'continuation-source-unavailable'
    WHEN 'deterministic_failure' THEN 'deterministic_mesh'
    WHEN 'failed_exhausted' THEN 'solver-execution-failed'
    ELSE 'non-publishable-evidence'
  END,
  'critical',
  'open',
  obligation.id,
  revision.solver_implementation_id,
  obligation.latest_sim_job_id,
  latest_attempt.result_attempt_id,
  'preliminary:' || obligation.id::text ||
    ':migration:urans-recovery-2026-07-16-v1',
  'urans-recovery-2026-07-16-v1',
  jsonb_build_object(
    'backfilled', true,
    'lastOutcome', obligation.last_outcome,
    'attemptCount', obligation.attempt_count,
    'continuationSegmentCount', obligation.continuation_segment_count,
    'continuationNoProgressCount', obligation.continuation_no_progress_count
  )
FROM "sim_precalc_obligations" obligation
JOIN "simulation_preset_revisions" revision
  ON revision.id = obligation.revision_id
LEFT JOIN LATERAL (
  SELECT submission.result_attempt_id
  FROM "sim_precalc_obligation_attempts" submission
  WHERE submission.obligation_id = obligation.id
    AND submission.result_attempt_id IS NOT NULL
  ORDER BY submission.attempt_number DESC
  LIMIT 1
) latest_attempt ON true
WHERE obligation.state = 'blocked'
  AND (
    obligation.background_owner
    OR EXISTS (
      SELECT 1
      FROM "sim_precalc_obligation_campaigns" ownership
      JOIN "sim_campaigns" campaign ON campaign.id = ownership.campaign_id
      WHERE ownership.obligation_id = obligation.id
        AND ownership.state = 'active'
        AND campaign.status IN ('active', 'attention', 'paused')
    )
  )
ON CONFLICT ("occurrence_key") DO NOTHING;
--> statement-breakpoint

INSERT INTO "sim_solver_incident_campaigns" ("incident_id", "campaign_id")
SELECT incident.id, ownership.campaign_id
FROM "sim_solver_incidents" incident
JOIN "sim_precalc_obligation_campaigns" ownership
  ON ownership.obligation_id = incident.precalc_obligation_id
 AND ownership.state = 'active'
WHERE incident.occurrence_key LIKE
  'preliminary:%:migration:urans-recovery-2026-07-16-v1'
ON CONFLICT ("incident_id", "campaign_id") DO NOTHING;
--> statement-breakpoint

-- Migration 0068 reopened every recoverable historical final attempt. Any
-- live blocked verify row that remains is already exceptional exhaustion.
INSERT INTO "sim_solver_incidents" (
  "stage",
  "reason",
  "severity",
  "status",
  "verify_queue_id",
  "solver_implementation_id",
  "sim_job_id",
  "result_attempt_id",
  "occurrence_key",
  "remediation_version",
  "metadata"
)
SELECT
  'final',
  CASE verify.last_outcome
    WHEN 'continuation_permanent_failure' THEN 'continuation-source-unavailable'
    WHEN 'deterministic_failure' THEN 'deterministic_mesh'
    ELSE 'non-publishable-evidence'
  END,
  'critical',
  'open',
  verify.id,
  revision.solver_implementation_id,
  verify.sim_job_id,
  verify.latest_result_attempt_id,
  'final:' || verify.id::text ||
    ':migration:urans-recovery-2026-07-16-v1',
  'urans-recovery-2026-07-16-v1',
  jsonb_build_object(
    'backfilled', true,
    'lastOutcome', verify.last_outcome,
    'freshAttemptCount', verify.fresh_attempt_count,
    'maxFreshAttempts', verify.max_fresh_attempts,
    'continuationAttemptCount', verify.continuation_attempt_count
  )
FROM "sim_urans_verify_queue" verify
JOIN "simulation_preset_revisions" revision
  ON revision.id = verify.revision_id
WHERE verify.state = 'blocked'
  AND (
    verify.background_owner
    OR EXISTS (
      SELECT 1
      FROM "sim_urans_verify_queue_campaigns" ownership
      JOIN "sim_campaigns" campaign ON campaign.id = ownership.campaign_id
      WHERE ownership.queue_id = verify.id
        AND ownership.state = 'active'
        AND campaign.status IN ('active', 'attention', 'paused')
    )
  )
ON CONFLICT ("occurrence_key") DO NOTHING;
--> statement-breakpoint

INSERT INTO "sim_solver_incident_campaigns" ("incident_id", "campaign_id")
SELECT incident.id, ownership.campaign_id
FROM "sim_solver_incidents" incident
JOIN "sim_urans_verify_queue_campaigns" ownership
  ON ownership.queue_id = incident.verify_queue_id
 AND ownership.state = 'active'
WHERE incident.occurrence_key LIKE
  'final:%:migration:urans-recovery-2026-07-16-v1'
ON CONFLICT ("incident_id", "campaign_id") DO NOTHING;
