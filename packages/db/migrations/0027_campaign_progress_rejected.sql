-- Campaign counter honesty (DecisionHistory 2026-07-05): terminal-done points
-- whose result CLASSIFIED 'rejected' (physics-invalid evidence) must not book
-- as solved work. New sim_campaign_progress.rejected bucket; solved now
-- excludes these rows and remaining = requested - solved - derived - failed
-- - rejected. Counters are recomputed idempotently by the reconciler /
-- recomputeCampaignProgress, so a plain zero-default backfill is correct.
ALTER TABLE "sim_campaign_progress" ADD COLUMN IF NOT EXISTS "rejected" integer NOT NULL DEFAULT 0;--> statement-breakpoint
