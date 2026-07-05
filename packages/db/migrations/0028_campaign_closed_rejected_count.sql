-- Honest close record (review F2, 2026-07-05): "Close with failures" stored
-- only closed_with_failed_count, so an attention campaign closed over
-- REJECTED points recorded 0 and rendered "closed with 0 failed points".
-- New nullable sim_campaigns.closed_with_rejected_count stores
-- totals.rejected at close time; historical closes stay NULL (unknown is
-- shown as absent — never invented).
ALTER TABLE "sim_campaigns" ADD COLUMN IF NOT EXISTS "closed_with_rejected_count" integer;--> statement-breakpoint
