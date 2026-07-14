-- `max_concurrent_jobs` was an internal legacy ceiling (default 2) while the
-- admin product exposes only one capacity control: OpenFOAM CPU slots. Zero
-- now means automatic admission derived by the sweeper from that control or
-- the engine worker's token budget. Preserve any positive API-set override.
ALTER TABLE "sweeper_state"
  ALTER COLUMN "max_concurrent_jobs" SET DEFAULT 0;--> statement-breakpoint
UPDATE "sweeper_state"
SET "max_concurrent_jobs" = 0,
    "updatedAt" = now()
WHERE id = 1
  AND "max_concurrent_jobs" = 2;
