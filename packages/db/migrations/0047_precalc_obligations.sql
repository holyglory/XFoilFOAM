-- A preliminary URANS solve is scheduling work, not the canonical coefficient
-- row. Keep its bounded attempt/outcome lifecycle in a dedicated physical-cell
-- ledger so a rejected replace-guard attempt never has to corrupt accepted or
-- needs_urans RANS evidence merely to make retries/counts durable.
ALTER TABLE "sim_campaign_progress"
  ADD COLUMN IF NOT EXISTS "blocked" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "sim_campaign_points"
  ADD COLUMN IF NOT EXISTS "result_attempt_id" uuid
  REFERENCES "result_attempts"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_campaign_points_result_attempt_idx"
  ON "sim_campaign_points" ("result_attempt_id");
--> statement-breakpoint

-- Preserve a stable attempt identity only when the point's linked canonical
-- result has exactly one classified attempt for the same natural cell. Older
-- rows with several plausible attempts remain NULL instead of guessing.
WITH candidate AS (
  SELECT point."campaign_id", point."condition_id", point."airfoil_id",
         point."aoa_deg",
         min(classification."result_attempt_id"::text)::uuid AS attempt_id
  FROM "sim_campaign_points" point
  JOIN "results" source ON source."id" = point."result_id"
  JOIN "result_attempts" attempt
    ON attempt."result_id" = point."result_id"
   AND attempt."airfoil_id" = point."airfoil_id"
   AND attempt."simulation_preset_revision_id" = point."revision_id"
   AND attempt."aoa_deg" = CASE
         WHEN point."derived_by_symmetry" THEN source."aoa_deg"
         ELSE point."aoa_deg"
       END
  JOIN "result_classifications" classification
    ON classification."result_attempt_id" = attempt."id"
  WHERE point."result_id" IS NOT NULL
    AND point."result_attempt_id" IS NULL
  GROUP BY point."campaign_id", point."condition_id", point."airfoil_id",
           point."aoa_deg"
  HAVING count(DISTINCT classification."result_attempt_id") = 1
)
UPDATE "sim_campaign_points" point
SET "result_attempt_id" = candidate.attempt_id,
    "updatedAt" = now()
FROM candidate
WHERE point."campaign_id" = candidate."campaign_id"
  AND point."condition_id" = candidate."condition_id"
  AND point."airfoil_id" = candidate."airfoil_id"
  AND point."aoa_deg" = candidate."aoa_deg";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sim_precalc_obligations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "airfoil_id" uuid NOT NULL REFERENCES "airfoils"("id") ON DELETE CASCADE,
  "revision_id" uuid NOT NULL REFERENCES "simulation_preset_revisions"("id") ON DELETE CASCADE,
  "aoa_deg" double precision NOT NULL,
  "source_result_id" uuid REFERENCES "results"("id") ON DELETE SET NULL,
  "source_result_attempt_id" uuid REFERENCES "result_attempts"("id") ON DELETE SET NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 2,
  "submit_failure_count" integer NOT NULL DEFAULT 0,
  "next_submit_at" timestamptz,
  "latest_sim_job_id" uuid REFERENCES "sim_jobs"("id") ON DELETE SET NULL,
  "background_owner" boolean NOT NULL DEFAULT false,
  "last_outcome" text,
  "last_error" text,
  "last_attempt_at" timestamptz,
  "completed_at" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sim_precalc_obligations_state_check"
    CHECK ("state" IN ('pending', 'running', 'satisfied', 'blocked', 'cancelled')),
  CONSTRAINT "sim_precalc_obligations_attempt_bounds_check"
    CHECK ("attempt_count" >= 0 AND "max_attempts" = 2 AND "attempt_count" <= "max_attempts"),
  CONSTRAINT "sim_precalc_obligations_submit_failure_bounds_check"
    CHECK ("submit_failure_count" >= 0 AND "submit_failure_count" <= 2),
  CONSTRAINT "sim_precalc_obligations_cell_uq"
    UNIQUE ("airfoil_id", "revision_id", "aoa_deg")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_precalc_obligations_state_idx"
  ON "sim_precalc_obligations" ("state", "updatedAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_precalc_obligations_submit_due_idx"
  ON "sim_precalc_obligations" ("state", "next_submit_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_precalc_obligations_latest_job_idx"
  ON "sim_precalc_obligations" ("latest_sim_job_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sim_precalc_obligation_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "obligation_id" uuid NOT NULL REFERENCES "sim_precalc_obligations"("id") ON DELETE CASCADE,
  -- Jobs are operational rows and may be purged.  Keep the bounded attempt
  -- audit (like result_attempts) after that purge; attempt_number remains the
  -- stable per-obligation identity when the job link is gone.
  "sim_job_id" uuid REFERENCES "sim_jobs"("id") ON DELETE SET NULL,
  "attempt_number" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'submitted',
  "outcome" text,
  "result_attempt_id" uuid REFERENCES "result_attempts"("id") ON DELETE SET NULL,
  "error" text,
  "submitted_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sim_precalc_obligation_attempts_state_check"
    CHECK ("state" IN ('submitted', 'accepted', 'rejected', 'failed', 'cancelled')),
  CONSTRAINT "sim_precalc_obligation_attempts_number_check"
    CHECK ("attempt_number" IN (1, 2)),
  CONSTRAINT "sim_precalc_obligation_attempts_job_uq"
    UNIQUE ("obligation_id", "sim_job_id"),
  CONSTRAINT "sim_precalc_obligation_attempts_number_uq"
    UNIQUE ("obligation_id", "attempt_number")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_precalc_obligation_attempts_job_idx"
  ON "sim_precalc_obligation_attempts" ("sim_job_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sim_precalc_obligation_campaigns" (
  "obligation_id" uuid NOT NULL REFERENCES "sim_precalc_obligations"("id") ON DELETE CASCADE,
  "campaign_id" uuid NOT NULL REFERENCES "sim_campaigns"("id") ON DELETE CASCADE,
  "state" text NOT NULL DEFAULT 'active',
  "cancelled_at" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sim_precalc_obligation_campaigns_pk" PRIMARY KEY ("obligation_id", "campaign_id"),
  CONSTRAINT "sim_precalc_obligation_campaigns_state_check"
    CHECK ("state" IN ('active', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_precalc_obligation_campaigns_campaign_state_idx"
  ON "sim_precalc_obligation_campaigns" ("campaign_id", "state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_precalc_obligation_campaigns_obligation_state_idx"
  ON "sim_precalc_obligation_campaigns" ("obligation_id", "state");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sim_precalc_obligation_requests" (
  "obligation_id" uuid NOT NULL REFERENCES "sim_precalc_obligations"("id") ON DELETE CASCADE,
  "request_id" uuid NOT NULL REFERENCES "sim_urans_requests"("id") ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sim_precalc_obligation_requests_pk" PRIMARY KEY ("obligation_id", "request_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_precalc_obligation_requests_request_idx"
  ON "sim_precalc_obligation_requests" ("request_id");
--> statement-breakpoint

-- Historical PRECALC/FULL evidence is ground truth. Build physical cells from
-- it before scheduling rows so an accepted preliminary or full replacement
-- cannot be reopened by a lower-tier request during the upgrade.
INSERT INTO "sim_precalc_obligations" (
  "airfoil_id", "revision_id", "aoa_deg", "source_result_id",
  "source_result_attempt_id", "state", "last_outcome", "completed_at"
)
SELECT result."airfoil_id", result."simulation_preset_revision_id",
       result."aoa_deg", result."id", source_attempt."id",
       CASE WHEN classification."state" = 'accepted' AND completeness.complete
            THEN 'satisfied' ELSE 'pending' END,
       CASE WHEN classification."state" = 'accepted' AND completeness.complete
            THEN 'accepted' ELSE NULL END,
       CASE WHEN classification."state" = 'accepted' AND completeness.complete
            THEN now() ELSE NULL END
FROM "results" result
JOIN "result_classifications" classification
  ON classification."result_id" = result."id"
LEFT JOIN LATERAL (
  SELECT attempt."id"
  FROM "result_attempts" attempt
  WHERE attempt."result_id" = result."id"
    AND (
      attempt."evidence_payload" ->> 'fidelity' = 'urans_precalc'
      OR (
        attempt."evidence_payload" ->> 'fidelity' IS NULL
        AND attempt."regime" = 'urans'
        AND result."fidelity" = 'urans_precalc'
      )
    )
  ORDER BY attempt."createdAt" DESC, attempt."id" DESC
  LIMIT 1
) source_attempt ON true
CROSS JOIN LATERAL (
  SELECT NOT EXISTS (
    SELECT 1
    FROM unnest(COALESCE(result."quality_warnings", ARRAY[]::text[])) warning
    WHERE warning LIKE '%stopped by the wall-clock budget guard%'
       OR warning LIKE '%requires further same-case integration%'
  ) AS complete
) completeness
WHERE result."simulation_preset_revision_id" IS NOT NULL
  AND result."status" = 'done'
  AND result."fidelity" IN ('urans_precalc', 'urans_full')
  AND (
    result."fidelity" = 'urans_precalc'
    OR classification."state" = 'accepted'
  )
ON CONFLICT ("airfoil_id", "revision_id", "aoa_deg") DO UPDATE
  SET "source_result_id" = CASE
        WHEN EXCLUDED."state" = 'satisfied' THEN EXCLUDED."source_result_id"
        ELSE COALESCE("sim_precalc_obligations"."source_result_id", EXCLUDED."source_result_id")
      END,
      "source_result_attempt_id" = COALESCE(EXCLUDED."source_result_attempt_id", "sim_precalc_obligations"."source_result_attempt_id"),
      "state" = CASE
        WHEN EXCLUDED."state" = 'satisfied' THEN 'satisfied'
        ELSE "sim_precalc_obligations"."state"
      END,
      "last_outcome" = CASE
        WHEN EXCLUDED."state" = 'satisfied' THEN 'accepted'
        ELSE "sim_precalc_obligations"."last_outcome"
      END,
      "completed_at" = CASE
        WHEN EXCLUDED."state" = 'satisfied' THEN now()
        ELSE "sim_precalc_obligations"."completed_at"
      END,
      "updatedAt" = now();
--> statement-breakpoint

-- Existing exact-angle request work becomes request coverage, never sticky
-- autonomous obligation ownership. A legacy request marked running is only a
-- running physical attempt when its linked job crossed engine acceptance.
INSERT INTO "sim_precalc_obligations" (
  "airfoil_id", "revision_id", "aoa_deg", "source_result_id", "state",
  "latest_sim_job_id"
)
SELECT req."airfoil_id", req."revision_id", req."aoa_deg",
       req."continue_from_result_id",
       CASE WHEN req."state" = 'running' AND accepted_job."id" IS NOT NULL
            THEN 'running' ELSE 'pending' END,
       req."sim_job_id"
FROM "sim_urans_requests" req
LEFT JOIN "sim_jobs" accepted_job
  ON accepted_job."id" = req."sim_job_id"
 AND (
   accepted_job."engine_job_id" IS NOT NULL
   OR accepted_job."submittedAt" IS NOT NULL
   OR accepted_job."status" IN ('submitted', 'running', 'ingesting', 'done', 'failed')
 )
WHERE req."fidelity" = 'precalc'
  AND req."aoa_deg" IS NOT NULL
  AND req."state" IN ('pending', 'running')
ON CONFLICT ("airfoil_id", "revision_id", "aoa_deg") DO UPDATE
  SET "source_result_id" = COALESCE("sim_precalc_obligations"."source_result_id", EXCLUDED."source_result_id"),
      "latest_sim_job_id" = COALESCE(EXCLUDED."latest_sim_job_id", "sim_precalc_obligations"."latest_sim_job_id"),
      "state" = CASE
        WHEN "sim_precalc_obligations"."state" IN ('satisfied', 'blocked')
          THEN "sim_precalc_obligations"."state"
        WHEN EXCLUDED."state" = 'running' THEN 'running'
        WHEN "sim_precalc_obligations"."state" = 'cancelled' THEN 'pending'
        ELSE "sim_precalc_obligations"."state"
      END,
      "updatedAt" = now();
--> statement-breakpoint

-- Pre-0047 automatic wave-2 jobs and whole-polar request jobs carry their
-- exact cells only in request_payload. Expand those AoAs now. NULL campaign
-- ids are ambiguous after ON DELETE SET NULL, so they never invent autonomous
-- background ownership; accepted active work can finish, while genuine
-- background discovery may recreate an owner later.
WITH expanded_job AS (
  SELECT DISTINCT ON (
    job."airfoil_id", job."simulation_preset_revision_id",
    angle.value::double precision
  )
    job."airfoil_id", job."simulation_preset_revision_id" AS revision_id,
    angle.value::double precision AS aoa_deg,
    CASE WHEN (
      job."engine_job_id" IS NOT NULL
      OR job."submittedAt" IS NOT NULL
      OR job."status" IN ('submitted', 'running', 'ingesting', 'done', 'failed')
    ) THEN 'running' ELSE 'pending' END AS state,
    job."id" AS latest_sim_job_id
  FROM "sim_jobs" job
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(job."request_payload" -> 'aoas') = 'array'
         THEN job."request_payload" -> 'aoas' ELSE '[]'::jsonb END
  ) angle(value)
  WHERE job."simulation_preset_revision_id" IS NOT NULL
    AND angle.value ~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
    AND (
      job."request_payload" ->> 'uransFidelity' = 'precalc'
      OR EXISTS (
        SELECT 1 FROM "sim_urans_requests" request
        WHERE request."sim_job_id" = job."id"
          AND request."fidelity" = 'precalc'
      )
    )
  ORDER BY job."airfoil_id", job."simulation_preset_revision_id",
           angle.value::double precision,
           (job."engine_job_id" IS NOT NULL OR job."submittedAt" IS NOT NULL) DESC,
           job."submittedAt" DESC NULLS LAST, job."createdAt" DESC, job."id" DESC
)
INSERT INTO "sim_precalc_obligations" (
  "airfoil_id", "revision_id", "aoa_deg", "state", "latest_sim_job_id",
  "background_owner"
)
SELECT expanded_job."airfoil_id", expanded_job.revision_id,
       expanded_job.aoa_deg, expanded_job.state,
       expanded_job.latest_sim_job_id, false
FROM expanded_job
ON CONFLICT ("airfoil_id", "revision_id", "aoa_deg") DO UPDATE
  SET "latest_sim_job_id" = COALESCE(EXCLUDED."latest_sim_job_id", "sim_precalc_obligations"."latest_sim_job_id"),
      "state" = CASE
        WHEN "sim_precalc_obligations"."state" IN ('satisfied', 'blocked')
          THEN "sim_precalc_obligations"."state"
        WHEN EXCLUDED."state" = 'running' THEN 'running'
        WHEN "sim_precalc_obligations"."state" = 'cancelled' THEN 'pending'
        ELSE "sim_precalc_obligations"."state"
      END,
      "updatedAt" = now();
--> statement-breakpoint

-- A cancelled/partially-ingested wave-1 job may have immutable RANS attempt
-- evidence without a canonical row. Preserve it as a zero-PRECALC-attempt
-- source; RANS never consumes the preliminary attempt budget.
INSERT INTO "sim_precalc_obligations" (
  "airfoil_id", "revision_id", "aoa_deg", "source_result_attempt_id", "state"
)
SELECT DISTINCT attempt."airfoil_id", attempt."simulation_preset_revision_id",
       attempt."aoa_deg", attempt."id", 'pending'
FROM "result_attempts" attempt
JOIN "sim_jobs" parent ON parent."id" = attempt."sim_job_id"
JOIN "sim_campaigns" campaign ON campaign."id" = parent."campaign_id"
JOIN "sim_campaign_points" point
  ON point."campaign_id" = parent."campaign_id"
 AND point."airfoil_id" = attempt."airfoil_id"
 AND point."revision_id" = attempt."simulation_preset_revision_id"
 AND point."aoa_deg" = attempt."aoa_deg"
 AND point."derived_by_symmetry" = false
 AND point."state" <> 'released'
JOIN "sim_campaign_conditions" condition
  ON condition."id" = point."condition_id"
 AND condition."status" IN ('active', 'kept')
WHERE parent."wave" = 1
  AND parent."status" = 'cancelled'
  AND campaign."status" IN ('active', 'attention', 'paused')
  AND attempt."simulation_preset_revision_id" IS NOT NULL
  AND attempt."regime" = 'rans'
  AND attempt."valid_for_polar" = false
  AND (
    attempt."status" = 'failed'
    OR EXISTS (
      SELECT 1 FROM "result_classifications" attempt_classification
      WHERE attempt_classification."result_attempt_id" = attempt."id"
        AND attempt_classification."state" IN ('needs_urans', 'rejected')
    )
  )
ON CONFLICT ("airfoil_id", "revision_id", "aoa_deg") DO UPDATE
  SET "source_result_attempt_id" = COALESCE(
        "sim_precalc_obligations"."source_result_attempt_id",
        EXCLUDED."source_result_attempt_id"
      ),
      "updatedAt" = now();
--> statement-breakpoint

-- Campaign-linked RANS evidence still owing preliminary URANS gets a physical
-- cell, but its RANS source leaves attempt_count at zero.
INSERT INTO "sim_precalc_obligations" (
  "airfoil_id", "revision_id", "aoa_deg", "source_result_id", "state"
)
SELECT DISTINCT point."airfoil_id", point."revision_id", point."aoa_deg",
       result."id", 'pending'
FROM "sim_campaign_points" point
JOIN "sim_campaigns" campaign ON campaign."id" = point."campaign_id"
JOIN "results" result ON result."id" = point."result_id"
JOIN "result_classifications" classification
  ON classification."result_id" = result."id"
WHERE campaign."status" IN ('active', 'attention', 'paused')
  AND point."state" = 'terminal'
  AND point."derived_by_symmetry" = false
  AND result."status" = 'done'
  AND (
    classification."state" = 'needs_urans'
    OR (
      classification."state" = 'rejected'
      AND (
        result."fidelity" = 'rans'
        OR (result."fidelity" IS NULL AND result."regime" IS DISTINCT FROM 'urans')
      )
    )
  )
ON CONFLICT ("airfoil_id", "revision_id", "aoa_deg") DO UPDATE
  SET "source_result_id" = COALESCE("sim_precalc_obligations"."source_result_id", EXCLUDED."source_result_id"),
      "updatedAt" = now();
--> statement-breakpoint

INSERT INTO "sim_precalc_obligation_campaigns" ("obligation_id", "campaign_id", "state")
SELECT DISTINCT obligation."id", point."campaign_id", 'active'
FROM "sim_precalc_obligations" obligation
JOIN "sim_campaign_points" point
  ON point."airfoil_id" = obligation."airfoil_id"
 AND point."revision_id" = obligation."revision_id"
 AND point."aoa_deg" = obligation."aoa_deg"
JOIN "sim_campaigns" campaign ON campaign."id" = point."campaign_id"
WHERE campaign."status" IN ('active', 'attention', 'paused')
  AND point."state" <> 'released'
  AND point."derived_by_symmetry" = false
ON CONFLICT ("obligation_id", "campaign_id") DO UPDATE
  SET "state" = 'active', "cancelled_at" = NULL, "updatedAt" = now();
--> statement-breakpoint

INSERT INTO "sim_precalc_obligation_campaigns" ("obligation_id", "campaign_id", "state")
SELECT DISTINCT obligation."id", parent."campaign_id", 'active'
FROM "sim_precalc_obligations" obligation
JOIN "result_attempts" attempt
  ON attempt."id" = obligation."source_result_attempt_id"
JOIN "sim_jobs" parent ON parent."id" = attempt."sim_job_id"
JOIN "sim_campaigns" campaign ON campaign."id" = parent."campaign_id"
JOIN "sim_campaign_points" point
  ON point."campaign_id" = parent."campaign_id"
 AND point."airfoil_id" = obligation."airfoil_id"
 AND point."revision_id" = obligation."revision_id"
 AND point."aoa_deg" = obligation."aoa_deg"
 AND point."derived_by_symmetry" = false
 AND point."state" <> 'released'
JOIN "sim_campaign_conditions" condition
  ON condition."id" = point."condition_id"
 AND condition."status" IN ('active', 'kept')
WHERE campaign."status" IN ('active', 'attention', 'paused')
ON CONFLICT ("obligation_id", "campaign_id") DO UPDATE
  SET "state" = 'active', "cancelled_at" = NULL, "updatedAt" = now();
--> statement-breakpoint

-- Jobs whose campaign owner lived on the job/parent (rather than a linked
-- campaign point) retain that exact owner for every payload AoA.
INSERT INTO "sim_precalc_obligation_campaigns" ("obligation_id", "campaign_id", "state")
SELECT DISTINCT obligation."id", campaign."id", 'active'
FROM "sim_jobs" job
LEFT JOIN "sim_jobs" parent ON parent."id" = job."parent_job_id"
JOIN "sim_campaigns" campaign
  ON campaign."id" = COALESCE(job."campaign_id", parent."campaign_id")
 AND campaign."status" IN ('active', 'attention', 'paused')
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(job."request_payload" -> 'aoas') = 'array'
       THEN job."request_payload" -> 'aoas' ELSE '[]'::jsonb END
) angle(value)
JOIN "sim_precalc_obligations" obligation
  ON obligation."airfoil_id" = job."airfoil_id"
 AND obligation."revision_id" = job."simulation_preset_revision_id"
 AND obligation."aoa_deg" = CASE
   WHEN angle.value ~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
   THEN angle.value::double precision ELSE NULL END
WHERE angle.value ~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
  AND (
    job."request_payload" ->> 'uransFidelity' = 'precalc'
    OR EXISTS (
      SELECT 1 FROM "sim_urans_requests" request
      WHERE request."sim_job_id" = job."id"
        AND request."fidelity" = 'precalc'
    )
  )
ON CONFLICT ("obligation_id", "campaign_id") DO UPDATE
  SET "state" = 'active', "cancelled_at" = NULL, "updatedAt" = now();
--> statement-breakpoint

-- Recover a request↔job association when only the immutable payload retained
-- it, then bind every exact request to its physical cell.
UPDATE "sim_urans_requests" request
SET "sim_job_id" = candidate."job_id", "updatedAt" = now()
FROM (
  SELECT DISTINCT ON (request_row."id") request_row."id" AS request_id,
         job."id" AS job_id
  FROM "sim_urans_requests" request_row
  JOIN "sim_jobs" job
    ON job."request_payload" ->> 'uransRequestId' = request_row."id"::text
  WHERE request_row."sim_job_id" IS NULL
  ORDER BY request_row."id", job."createdAt" DESC, job."id" DESC
) candidate
WHERE request."id" = candidate."request_id";
--> statement-breakpoint

INSERT INTO "sim_precalc_obligation_requests" ("obligation_id", "request_id")
SELECT obligation."id", request."id"
FROM "sim_urans_requests" request
JOIN "sim_precalc_obligations" obligation
  ON obligation."airfoil_id" = request."airfoil_id"
 AND obligation."revision_id" = request."revision_id"
 AND obligation."aoa_deg" = request."aoa_deg"
WHERE request."fidelity" = 'precalc'
  AND request."aoa_deg" IS NOT NULL
ON CONFLICT ("obligation_id", "request_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "sim_precalc_obligation_requests" ("obligation_id", "request_id")
SELECT obligation."id", request."id"
FROM "sim_urans_requests" request
JOIN "sim_jobs" job ON job."id" = request."sim_job_id"
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(job."request_payload" -> 'aoas') = 'array'
       THEN job."request_payload" -> 'aoas' ELSE '[]'::jsonb END
) angle(value)
JOIN "sim_precalc_obligations" obligation
  ON obligation."airfoil_id" = request."airfoil_id"
 AND obligation."revision_id" = request."revision_id"
 AND obligation."aoa_deg" = CASE
   WHEN angle.value ~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
   THEN angle.value::double precision ELSE NULL END
WHERE request."fidelity" = 'precalc'
  AND request."aoa_deg" IS NULL
  AND angle.value ~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
ON CONFLICT ("obligation_id", "request_id") DO NOTHING;
--> statement-breakpoint

-- Every composed PRECALC job receives all and only its exact physical IDs.
-- This includes automatic children, exact requests, whole-polar requests, and
-- pre-boundary jobs which may submit after the migration commits.
WITH job_cell AS (
  SELECT DISTINCT job."id" AS job_id, obligation."id" AS obligation_id,
         obligation."aoa_deg"
  FROM "sim_jobs" job
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(job."request_payload" -> 'aoas') = 'array'
         THEN job."request_payload" -> 'aoas' ELSE '[]'::jsonb END
  ) angle(value)
  JOIN "sim_precalc_obligations" obligation
    ON obligation."airfoil_id" = job."airfoil_id"
   AND obligation."revision_id" = job."simulation_preset_revision_id"
   AND obligation."aoa_deg" = CASE
     WHEN angle.value ~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
     THEN angle.value::double precision ELSE NULL END
  WHERE angle.value ~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
    AND (
      job."request_payload" ->> 'uransFidelity' = 'precalc'
      OR EXISTS (
        SELECT 1 FROM "sim_urans_requests" request
        WHERE request."sim_job_id" = job."id"
          AND request."fidelity" = 'precalc'
      )
    )
), job_coverage AS (
  SELECT job_cell.job_id,
         array_agg(job_cell.obligation_id ORDER BY job_cell.aoa_deg) AS obligation_ids
  FROM job_cell
  GROUP BY job_cell.job_id
)
UPDATE "sim_jobs" job
SET "request_payload" = jsonb_set(
      jsonb_set(COALESCE(job."request_payload", '{}'::jsonb),
        '{precalcObligationIds}', to_jsonb(job_coverage.obligation_ids), true),
      '{uransFidelity}', to_jsonb('precalc'::text), true),
    "updatedAt" = now()
FROM job_coverage
WHERE job."id" = job_coverage.job_id;
--> statement-breakpoint

UPDATE "sim_jobs" job
SET "request_payload" = jsonb_set(COALESCE(job."request_payload", '{}'::jsonb),
      '{uransRequestId}', to_jsonb(request."id"::text), true),
    "updatedAt" = now()
FROM "sim_urans_requests" request
WHERE request."fidelity" = 'precalc'
  AND request."sim_job_id" = job."id";
--> statement-breakpoint

-- Reconstruct actual historical PRECALC attempts only. RANS warm-start/source
-- rows and full-verification rows do not consume this two-attempt budget.
WITH ranked_attempt AS (
  SELECT obligation."id" AS obligation_id,
         attempt."id" AS result_attempt_id,
         attempt."sim_job_id",
         attempt."error",
         attempt."createdAt" AS attempted_at,
         row_number() OVER (
           PARTITION BY obligation."id"
           ORDER BY attempt."createdAt", attempt."id"
         )::integer AS attempt_number,
         CASE
           WHEN classification."state" = 'accepted'
             AND NOT EXISTS (
               SELECT 1
               FROM unnest(COALESCE(attempt."quality_warnings", ARRAY[]::text[])) warning
               WHERE warning LIKE '%stopped by the wall-clock budget guard%'
                  OR warning LIKE '%requires further same-case integration%'
             ) THEN 'accepted'
           WHEN attempt."status" = 'failed' THEN 'failed'
           WHEN classification."state" IN ('accepted', 'needs_urans', 'rejected') THEN 'rejected'
           ELSE 'failed'
         END AS ledger_state
  FROM "sim_precalc_obligations" obligation
  JOIN "result_attempts" attempt
    ON attempt."airfoil_id" = obligation."airfoil_id"
   AND attempt."simulation_preset_revision_id" = obligation."revision_id"
   AND attempt."aoa_deg" = obligation."aoa_deg"
  LEFT JOIN "results" result ON result."id" = attempt."result_id"
  LEFT JOIN "result_classifications" classification
    ON classification."result_attempt_id" = attempt."id"
  WHERE attempt."evidence_payload" ->> 'fidelity' = 'urans_precalc'
     OR (
       attempt."evidence_payload" ->> 'fidelity' IS NULL
       AND attempt."regime" = 'urans'
       AND result."fidelity" = 'urans_precalc'
     )
)
INSERT INTO "sim_precalc_obligation_attempts" (
  "obligation_id", "sim_job_id", "attempt_number", "state", "outcome",
  "result_attempt_id", "error", "submitted_at", "completed_at"
)
SELECT ranked."obligation_id", ranked."sim_job_id", ranked."attempt_number",
       ranked."ledger_state", ranked."ledger_state", ranked."result_attempt_id",
       ranked."error", ranked."attempted_at", ranked."attempted_at"
FROM ranked_attempt ranked
WHERE ranked."attempt_number" <= 2
ON CONFLICT ("obligation_id", "attempt_number") DO NOTHING;
--> statement-breakpoint

-- Very old ingests may have only the canonical PRECALC row. Preserve that one
-- spent solver attempt without inventing a result_attempt evidence row.
INSERT INTO "sim_precalc_obligation_attempts" (
  "obligation_id", "sim_job_id", "attempt_number", "state", "outcome",
  "error", "submitted_at", "completed_at"
)
SELECT obligation."id", result."sim_job_id", 1,
       CASE WHEN classification."state" = 'accepted' AND completeness.complete
            THEN 'accepted' ELSE 'rejected' END,
       CASE WHEN classification."state" = 'accepted' AND completeness.complete
            THEN 'accepted' ELSE 'rejected' END,
       result."error", COALESCE(job."submittedAt", result."createdAt"),
       COALESCE(result."solvedAt", result."updatedAt")
FROM "sim_precalc_obligations" obligation
JOIN "results" result
  ON result."airfoil_id" = obligation."airfoil_id"
 AND result."simulation_preset_revision_id" = obligation."revision_id"
 AND result."aoa_deg" = obligation."aoa_deg"
 AND result."fidelity" = 'urans_precalc'
JOIN "result_classifications" classification
  ON classification."result_id" = result."id"
LEFT JOIN "sim_jobs" job ON job."id" = result."sim_job_id"
CROSS JOIN LATERAL (
  SELECT NOT EXISTS (
    SELECT 1
    FROM unnest(COALESCE(result."quality_warnings", ARRAY[]::text[])) warning
    WHERE warning LIKE '%stopped by the wall-clock budget guard%'
       OR warning LIKE '%requires further same-case integration%'
  ) AS complete
) completeness
WHERE NOT EXISTS (
  SELECT 1 FROM "sim_precalc_obligation_attempts" existing
  WHERE existing."obligation_id" = obligation."id"
)
ON CONFLICT ("obligation_id", "attempt_number") DO NOTHING;
--> statement-breakpoint

-- Any composed PRECALC job which crossed acceptance but has no corresponding
-- evidence ledger row is a spent attempt. This covers exact/whole requests and
-- automatic wave-2 children. Pre-boundary compositions consume zero.
WITH accepted_precalc_job_unranked AS (
  SELECT DISTINCT obligation."id" AS obligation_id, job."id" AS sim_job_id,
         COALESCE(existing.max_attempt, 0) AS existing_max_attempt,
         job."status", job."error",
         COALESCE(job."submittedAt", job."createdAt") AS submitted_at
  FROM "sim_jobs" job
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(job."request_payload" -> 'precalcObligationIds') = 'array'
         THEN job."request_payload" -> 'precalcObligationIds' ELSE '[]'::jsonb END
  ) payload_obligation(id)
  JOIN "sim_precalc_obligations" obligation
    ON obligation."id" = CASE
      WHEN payload_obligation.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN payload_obligation.id::uuid ELSE NULL END
  LEFT JOIN LATERAL (
    SELECT max(attempt."attempt_number") AS max_attempt
    FROM "sim_precalc_obligation_attempts" attempt
    WHERE attempt."obligation_id" = obligation."id"
  ) existing ON true
  WHERE job."request_payload" ->> 'uransFidelity' = 'precalc'
    AND (
      job."engine_job_id" IS NOT NULL
      OR job."submittedAt" IS NOT NULL
      OR job."status" IN ('submitted', 'running', 'ingesting', 'done', 'failed')
    )
    AND COALESCE(existing.max_attempt, 0) < 2
    AND NOT EXISTS (
      SELECT 1 FROM "sim_precalc_obligation_attempts" prior_job
      WHERE prior_job."obligation_id" = obligation."id"
        AND prior_job."sim_job_id" = job."id"
    )
), accepted_precalc_job AS (
  SELECT candidate.obligation_id, candidate.sim_job_id,
         candidate.existing_max_attempt
           + row_number() OVER (
               PARTITION BY candidate.obligation_id
               ORDER BY candidate.submitted_at ASC, candidate.sim_job_id ASC
             ) AS attempt_number,
         candidate.status, candidate.error, candidate.submitted_at
  FROM accepted_precalc_job_unranked candidate
)
INSERT INTO "sim_precalc_obligation_attempts" (
  "obligation_id", "sim_job_id", "attempt_number", "state", "outcome",
  "error", "submitted_at", "completed_at"
)
SELECT candidate."obligation_id", candidate."sim_job_id", candidate."attempt_number",
       CASE
         WHEN candidate."status" IN ('submitted', 'running', 'ingesting') THEN 'submitted'
         WHEN candidate."status" = 'cancelled' THEN 'cancelled'
         ELSE 'failed'
       END,
       CASE
         WHEN candidate."status" IN ('submitted', 'running', 'ingesting') THEN 'submitted'
         WHEN candidate."status" = 'cancelled' THEN 'cancelled'
         ELSE 'failed'
       END,
       candidate."error", candidate."submitted_at",
       CASE WHEN candidate."status" IN ('submitted', 'running', 'ingesting')
            THEN NULL ELSE now() END
FROM accepted_precalc_job candidate
WHERE candidate.attempt_number <= 2
ON CONFLICT ("obligation_id", "attempt_number") DO NOTHING;
--> statement-breakpoint

UPDATE "sim_precalc_obligations" obligation
SET "attempt_count" = ledger.max_attempt,
    "last_attempt_at" = ledger.last_attempt_at,
    "updatedAt" = now()
FROM (
  SELECT attempt."obligation_id", max(attempt."attempt_number") AS max_attempt,
         max(attempt."submitted_at") AS last_attempt_at
  FROM "sim_precalc_obligation_attempts" attempt
  GROUP BY attempt."obligation_id"
) ledger
WHERE obligation."id" = ledger."obligation_id";
--> statement-breakpoint

UPDATE "sim_precalc_obligations" obligation
SET "source_result_attempt_id" = accepted."result_attempt_id",
    "updatedAt" = now()
FROM (
  SELECT DISTINCT ON (attempt."obligation_id") attempt."obligation_id",
         attempt."result_attempt_id"
  FROM "sim_precalc_obligation_attempts" attempt
  WHERE attempt."state" = 'accepted'
    AND attempt."result_attempt_id" IS NOT NULL
  ORDER BY attempt."obligation_id", attempt."attempt_number" DESC
) accepted
WHERE obligation."id" = accepted."obligation_id";
--> statement-breakpoint

-- Derive the final physical state after both evidence and accepted-job history
-- exist. Accepted PRECALC/FULL truth wins; an active accepted engine attempt is
-- running; two spent attempts or a completed physics rejection is blocked;
-- only live campaign/autonomous/independent-request owners keep retryable work.
WITH facts AS (
  SELECT obligation."id" AS obligation_id,
    obligation."attempt_count", obligation."max_attempts",
    obligation."last_outcome",
    EXISTS (
        SELECT 1
        FROM "results" result
        JOIN "result_classifications" classification
          ON classification."result_id" = result."id"
        WHERE result."airfoil_id" = obligation."airfoil_id"
          AND result."simulation_preset_revision_id" = obligation."revision_id"
          AND result."aoa_deg" = obligation."aoa_deg"
          AND result."status" = 'done'
          AND result."fidelity" IN ('urans_precalc', 'urans_full')
          AND classification."state" = 'accepted'
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(COALESCE(result."quality_warnings", ARRAY[]::text[])) warning
            WHERE warning LIKE '%stopped by the wall-clock budget guard%'
               OR warning LIKE '%requires further same-case integration%'
          )
      ) AS accepted_truth,
    EXISTS (
        SELECT 1
        FROM "sim_precalc_obligation_attempts" attempt
        JOIN "sim_jobs" job ON job."id" = attempt."sim_job_id"
        WHERE attempt."obligation_id" = obligation."id"
          AND attempt."state" = 'submitted'
          AND job."status" IN ('submitted', 'running', 'ingesting')
      ) AS active_attempt,
    EXISTS (
        SELECT 1
        FROM "sim_precalc_obligation_attempts" attempt
        LEFT JOIN "result_attempts" evidence
          ON evidence."id" = attempt."result_attempt_id"
        LEFT JOIN "results" source_result
          ON source_result."id" = obligation."source_result_id"
        WHERE attempt."obligation_id" = obligation."id"
          AND attempt."state" = 'rejected'
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(COALESCE(evidence."quality_warnings", ARRAY[]::text[])) warning
            WHERE warning LIKE '%stopped by the wall-clock budget guard%'
               OR warning LIKE '%requires further same-case integration%'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(COALESCE(source_result."quality_warnings", ARRAY[]::text[])) warning
            WHERE warning LIKE '%stopped by the wall-clock budget guard%'
               OR warning LIKE '%requires further same-case integration%'
          )
      ) AS nonrestartable_rejection,
    (
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
      ) AS live_owner,
    EXISTS (
        SELECT 1 FROM "sim_precalc_obligation_attempts" attempt
        WHERE attempt."obligation_id" = obligation."id"
          AND attempt."state" = 'submitted'
      ) AS has_submitted,
    EXISTS (
        SELECT 1 FROM "sim_precalc_obligation_attempts" attempt
        WHERE attempt."obligation_id" = obligation."id"
          AND attempt."state" = 'rejected'
      ) AS has_rejected,
    (
      SELECT attempt."error"
      FROM "sim_precalc_obligation_attempts" attempt
      WHERE attempt."obligation_id" = obligation."id"
      ORDER BY attempt."attempt_number" DESC
      LIMIT 1
    ) AS latest_error
  FROM "sim_precalc_obligations" obligation
), decision AS (
  SELECT facts.obligation_id,
    CASE
      WHEN facts.accepted_truth THEN 'satisfied'
      WHEN facts.active_attempt THEN 'running'
      WHEN facts.attempt_count >= facts.max_attempts THEN 'blocked'
      WHEN facts.nonrestartable_rejection THEN 'blocked'
      WHEN facts.live_owner THEN 'pending'
      ELSE 'cancelled'
    END AS next_state,
    CASE
      WHEN facts.accepted_truth THEN 'accepted'
      WHEN facts.active_attempt OR facts.has_submitted THEN 'submitted'
      WHEN facts.attempt_count >= facts.max_attempts
        THEN CASE WHEN facts.has_rejected THEN 'rejected_exhausted' ELSE 'failed_exhausted' END
      WHEN facts.nonrestartable_rejection THEN 'rejected_exhausted'
      WHEN facts.has_rejected THEN 'rejected'
      WHEN facts.live_owner THEN COALESCE(facts.last_outcome, 'pending')
      ELSE 'ownerless'
    END AS next_outcome,
    CASE WHEN facts.accepted_truth THEN NULL ELSE facts.latest_error END AS next_error
  FROM facts
)
UPDATE "sim_precalc_obligations" obligation
SET "state" = decision.next_state,
    "last_outcome" = decision.next_outcome,
    "last_error" = decision.next_error,
    "next_submit_at" = CASE WHEN decision.next_state = 'satisfied' THEN NULL ELSE obligation."next_submit_at" END,
    "completed_at" = CASE
      WHEN decision.next_state IN ('satisfied', 'blocked', 'cancelled') THEN now()
      ELSE NULL
    END,
    "updatedAt" = now()
FROM decision
WHERE obligation."id" = decision.obligation_id;
--> statement-breakpoint

-- Keep exact request lifecycle aligned with the physical projection. A
-- pre-boundary legacy running request becomes pending; an accepted in-flight
-- attempt stays running; accepted/full truth is done; exhaustion is blocked.
WITH request_projection AS (
  SELECT coverage."request_id",
         bool_or(obligation."state" = 'running') AS has_running,
         bool_or(obligation."state" = 'pending') AS has_pending,
         bool_or(obligation."state" = 'blocked') AS has_blocked,
         bool_or(obligation."state" = 'satisfied') AS has_satisfied
  FROM "sim_precalc_obligation_requests" coverage
  JOIN "sim_precalc_obligations" obligation
    ON obligation."id" = coverage."obligation_id"
  GROUP BY coverage."request_id"
)
UPDATE "sim_urans_requests" request
SET "state" = CASE
      WHEN projection.has_running THEN 'running'
      WHEN projection.has_pending THEN 'pending'
      WHEN projection.has_blocked THEN 'blocked'
      WHEN projection.has_satisfied THEN 'done'
      ELSE 'cancelled'
    END,
    "sim_job_id" = CASE
      WHEN NOT projection.has_running AND projection.has_pending THEN NULL
      ELSE request."sim_job_id"
    END,
    "updatedAt" = now()
FROM request_projection projection
WHERE projection."request_id" = request."id"
  AND request."fidelity" = 'precalc'
  AND request."state" IN ('pending', 'running');
--> statement-breakpoint

-- Production may restart with the sweeper disabled, so the migration itself
-- must publish truthful campaign counters immediately after reconstructing
-- obligation state. Rebuild every row with the exact runtime precedence:
-- blocked physical cells are terminal and disjoint from solved/failed/rejected.
DELETE FROM "sim_campaign_progress";
--> statement-breakpoint
INSERT INTO "sim_campaign_progress" (
  "campaign_id", "condition_id", "airfoil_id", "requested", "solved",
  "failed", "running", "superseded", "derived", "rejected", "blocked"
)
SELECT point."campaign_id", point."condition_id", point."airfoil_id",
       count(*) FILTER (WHERE point."state" <> 'released')::int,
       count(*) FILTER (
         WHERE point."state" = 'terminal'
           AND point."derived_by_symmetry" = false
           AND result."status" = 'done'
           AND classification."state" IN ('accepted', 'needs_urans', 'superseded_by_urans')
           AND obligation."state" IS DISTINCT FROM 'blocked'
       )::int,
       count(*) FILTER (
         WHERE point."state" = 'terminal'
           AND point."derived_by_symmetry" = false
           AND result."status" = 'failed'
           AND obligation."state" IS DISTINCT FROM 'blocked'
       )::int,
       count(*) FILTER (
         WHERE point."state" = 'requested'
           AND live_result."status" IN ('queued', 'running')
       )::int,
       count(*) FILTER (
         WHERE classification."state" = 'superseded_by_urans'
       )::int,
       count(*) FILTER (
         WHERE point."state" = 'terminal'
           AND point."derived_by_symmetry" = true
           AND result."status" = 'done'
           AND classification."state" IN ('accepted', 'needs_urans', 'superseded_by_urans')
           AND obligation."state" IS DISTINCT FROM 'blocked'
       )::int,
       count(*) FILTER (
         WHERE point."state" = 'terminal'
           AND point."derived_by_symmetry" = false
           AND result."status" = 'done'
           AND classification."state" = 'rejected'
           AND obligation."state" IS DISTINCT FROM 'blocked'
       )::int,
       count(*) FILTER (
         WHERE point."state" <> 'released'
           AND (
             obligation."state" = 'blocked'
             OR (
               point."state" = 'terminal'
               AND point."derived_by_symmetry" = false
               AND result."status" = 'done'
               AND (
                 classification."state" IS NULL
                 OR classification."state" NOT IN ('accepted', 'needs_urans', 'superseded_by_urans', 'rejected')
               )
             )
             OR (
               point."state" = 'terminal'
               AND point."derived_by_symmetry" = true
               AND (
                 result."status" = 'failed'
                 OR (
                   result."status" = 'done'
                   AND (
                     classification."state" IS NULL
                     OR classification."state" NOT IN ('accepted', 'needs_urans', 'superseded_by_urans', 'rejected')
                   )
                 )
               )
             )
           )
       )::int
FROM "sim_campaign_points" point
LEFT JOIN "results" result ON result."id" = point."result_id"
LEFT JOIN "results" live_result
  ON live_result."airfoil_id" = point."airfoil_id"
 AND live_result."simulation_preset_revision_id" = point."revision_id"
 AND live_result."aoa_deg" = point."aoa_deg"
LEFT JOIN "result_classifications" classification
  ON classification."result_id" = point."result_id"
LEFT JOIN "sim_precalc_obligations" obligation
  ON obligation."airfoil_id" = point."airfoil_id"
 AND obligation."revision_id" = point."revision_id"
 AND obligation."aoa_deg" = CASE
       WHEN point."derived_by_symmetry" THEN result."aoa_deg"
       ELSE point."aoa_deg"
     END
GROUP BY point."campaign_id", point."condition_id", point."airfoil_id";
