-- Engine maintenance must not infer scheduler-pause ownership from a local
-- file receipt.  The token is acquired atomically with enabled=false and is
-- the only authority allowed to restore admission.  A genuine safety fence
-- retires the token while keeping admission disabled.
ALTER TABLE "sweeper_state"
  ADD COLUMN IF NOT EXISTS "maintenance_drain_token" uuid,
  ADD COLUMN IF NOT EXISTS "maintenance_drain_started_at" timestamp with time zone;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sweeper_state'::regclass
      AND conname = 'sweeper_state_maintenance_drain_shape_check'
  ) THEN
    ALTER TABLE "sweeper_state"
      ADD CONSTRAINT "sweeper_state_maintenance_drain_shape_check"
      CHECK (
        ("maintenance_drain_token" IS NULL) =
          ("maintenance_drain_started_at" IS NULL)
        AND (
          "maintenance_drain_token" IS NULL
          OR (
            "enabled" = false
            AND "admission_fence_active" = false
          )
        )
      );
  END IF;
END $$;
