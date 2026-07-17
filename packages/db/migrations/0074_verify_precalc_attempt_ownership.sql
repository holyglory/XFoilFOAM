-- Final verification owns one exact accepted preliminary generation. The
-- natural-cell results row is mutable and can select a later preliminary or
-- full attempt, so neither retry budget nor coefficient comparison may use it
-- as generation identity.
ALTER TABLE "sim_urans_verify_queue"
  ADD COLUMN "precalc_result_attempt_id" uuid;
--> statement-breakpoint

-- Reconstruct the preliminary generation that existed when each historical
-- queue row was created. Prefer the newest accepted preliminary attempt at or
-- before queue creation; a clock-skewed later attempt is only a fallback.
-- This preserves a blocked generation A even when the same results row now
-- selects a newer accepted generation B.
WITH ranked AS (
  SELECT
    queue.id AS queue_id,
    attempt.id AS result_attempt_id,
    row_number() OVER (
      PARTITION BY queue.id
      ORDER BY
        CASE WHEN attempt."createdAt" <= queue."createdAt" THEN 0 ELSE 1 END,
        CASE
          WHEN attempt."createdAt" <= queue."createdAt"
          THEN attempt."createdAt"
        END DESC NULLS LAST,
        CASE
          WHEN attempt."createdAt" > queue."createdAt"
          THEN attempt."createdAt"
        END ASC NULLS LAST,
        attempt.id DESC
    ) AS ordinal
  FROM "sim_urans_verify_queue" queue
  JOIN "result_attempts" attempt
    ON attempt.result_id = queue.precalc_result_id
   AND attempt.airfoil_id = queue.airfoil_id
   AND attempt.simulation_preset_revision_id = queue.revision_id
   AND attempt.aoa_deg = queue.aoa_deg
   AND attempt.status = 'done'
   AND attempt.source = 'solved'
   AND attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
  JOIN "result_classifications" classification
    ON classification.result_attempt_id = attempt.id
   AND classification.state = 'accepted'
)
UPDATE "sim_urans_verify_queue" queue
SET precalc_result_attempt_id = ranked.result_attempt_id,
    "updatedAt" = now()
FROM ranked
WHERE queue.id = ranked.queue_id
  AND ranked.ordinal = 1;
--> statement-breakpoint

-- Runnable and critically exhausted verification ledgers must always have an
-- exact accepted preliminary owner. Cancelled historical rows are inert.
-- A terminal done/disagreed row may be the explicit legacy projection of
-- accepted direct-FULL evidence, which truthfully had no preliminary stage.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "sim_urans_verify_queue" queue
    WHERE queue.precalc_result_attempt_id IS NULL
      AND NOT (
        queue.state = 'cancelled'
        OR (
          queue.state IN ('done', 'disagreed')
          AND queue.verify_result_id IS NOT NULL
        )
      )
  ) THEN
    RAISE EXCEPTION 'active final verification lacks an exact accepted preliminary attempt';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "sim_urans_verify_queue"
  ADD CONSTRAINT "sim_urans_verify_queue_precalc_attempt_owner_fk"
    FOREIGN KEY ("precalc_result_attempt_id", "precalc_result_id")
    REFERENCES "result_attempts"("id", "result_id")
    ON DELETE CASCADE,
  ADD CONSTRAINT "sim_urans_verify_queue_precalc_attempt_required_check"
    CHECK (
      "precalc_result_attempt_id" IS NOT NULL
      OR "state" = 'cancelled'
      OR (
        "state" IN ('done', 'disagreed')
        AND "verify_result_id" IS NOT NULL
      )
    );
--> statement-breakpoint

-- Multiple preliminary generations may coexist in one natural cell. Only the
-- same immutable generation conflicts; terminal history keeps its budget and
-- is reused by application-level generation locking instead of being reset.
DROP INDEX "sim_urans_verify_queue_open_cell_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "sim_urans_verify_queue_open_precalc_attempt_uq"
  ON "sim_urans_verify_queue" ("precalc_result_attempt_id")
  WHERE "precalc_result_attempt_id" IS NOT NULL
    AND "state" IN ('pending', 'running');
--> statement-breakpoint
CREATE INDEX "sim_urans_verify_queue_precalc_attempt_idx"
  ON "sim_urans_verify_queue" ("precalc_result_attempt_id");
