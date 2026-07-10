ALTER TABLE "sim_jobs" ADD COLUMN IF NOT EXISTS "stripped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sim_jobs" ADD COLUMN IF NOT EXISTS "strip_report" jsonb;
