-- Cross-job continuation has a stricter authority boundary than a fresh
-- in-process v2 trajectory.  NULL is deliberately the historical v1
-- FAST=9/FINAL=12 policy; only an authenticated reducer handoff may persist
-- the explicit adaptive v2 extension.  Never backfill historical rows.
ALTER TABLE "result_interpretation_recovery_actions"
  ADD COLUMN IF NOT EXISTS "clean_cycle_recovery_policy_version" text;
--> statement-breakpoint
ALTER TABLE "sim_urans_requests"
  ADD COLUMN IF NOT EXISTS "clean_cycle_recovery_policy_version" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.result_interpretation_recovery_actions'::regclass
      AND conname = 'ri_recovery_policy_version_ck'
  ) THEN
    ALTER TABLE "result_interpretation_recovery_actions"
      ADD CONSTRAINT "ri_recovery_policy_version_ck"
      CHECK (
        "clean_cycle_recovery_policy_version" IS NULL
        OR "clean_cycle_recovery_policy_version" = 'adaptive-clean-tail-v2'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sim_urans_requests'::regclass
      AND conname = 'sim_urans_recovery_policy_version_ck'
  ) THEN
    ALTER TABLE "sim_urans_requests"
      ADD CONSTRAINT "sim_urans_recovery_policy_version_ck"
      CHECK (
        "clean_cycle_recovery_policy_version" IS NULL
        OR "clean_cycle_recovery_policy_version" = 'adaptive-clean-tail-v2'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sim_urans_requests'::regclass
      AND conname = 'sim_urans_recovery_policy_continue_ck'
  ) THEN
    ALTER TABLE "sim_urans_requests"
      ADD CONSTRAINT "sim_urans_recovery_policy_continue_ck"
      CHECK (
        "clean_cycle_recovery_policy_version" IS NULL
        OR (
          "continue_from_result_id" IS NOT NULL
          AND "continue_from_result_attempt_id" IS NOT NULL
        )
      );
  END IF;
END $$;
