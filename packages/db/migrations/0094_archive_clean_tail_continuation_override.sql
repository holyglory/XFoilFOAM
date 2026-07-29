-- Preserve the exact whole-period recovery recommendation made from the
-- authenticated raw archive.  Existing historical actions/continuations stay
-- NULL so they continue to use the legacy source-evidence heuristic rather
-- than being silently assigned a fabricated recommendation.
--
-- The ledger is installed by the later 0096 reconciliation.  Do not make an
-- upgrade fail merely because that table is not present yet: 0096 creates the
-- same final column/constraint atomically with its ledger reconciliation.
DO $$
BEGIN
  IF to_regclass('public.result_interpretation_recovery_actions') IS NOT NULL THEN
    ALTER TABLE "result_interpretation_recovery_actions"
      ADD COLUMN IF NOT EXISTS "corrective_tail_periods" integer;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'public.result_interpretation_recovery_actions'::regclass
        AND conname = 'ri_recovery_tail_periods_ck'
    ) THEN
      ALTER TABLE "result_interpretation_recovery_actions"
        ADD CONSTRAINT "ri_recovery_tail_periods_ck"
        CHECK (
          "corrective_tail_periods" IS NULL
          OR "corrective_tail_periods" BETWEEN 1 AND 3
        );
    END IF;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "sim_urans_requests"
  ADD COLUMN IF NOT EXISTS "corrective_tail_periods" integer;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.sim_urans_requests'::regclass
      AND conname = 'sim_urans_tail_periods_ck'
  ) THEN
    ALTER TABLE "sim_urans_requests"
      ADD CONSTRAINT "sim_urans_tail_periods_ck"
      CHECK (
        "corrective_tail_periods" IS NULL
        OR "corrective_tail_periods" BETWEEN 1 AND 3
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.sim_urans_requests'::regclass
      AND conname = 'sim_urans_tail_continue_ck'
  ) THEN
    ALTER TABLE "sim_urans_requests"
      ADD CONSTRAINT "sim_urans_tail_continue_ck"
      CHECK (
        "corrective_tail_periods" IS NULL
        OR (
          "continue_from_result_id" IS NOT NULL
          AND "continue_from_result_attempt_id" IS NOT NULL
        )
      );
  END IF;
END $$;

