ALTER TABLE "sim_jobs"
  ADD COLUMN IF NOT EXISTS "ingest_lease_token" text;
--> statement-breakpoint
ALTER TABLE "sim_jobs"
  ADD COLUMN IF NOT EXISTS "ingest_lease_claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sim_jobs"
  ADD COLUMN IF NOT EXISTS "ingest_lease_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_jobs_ingest_lease_idx"
  ON "sim_jobs" ("status", "ingest_lease_expires_at");
