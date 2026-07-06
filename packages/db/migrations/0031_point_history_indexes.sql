-- Point History Explorer table + story query support (approved 2026-07-06).
-- 1) The explorer lists points newest-activity-first with keyset pagination on
--    (results."updatedAt", row key); this index lets the page query walk in
--    activity order with an incremental sort instead of a full top-N sort as
--    results grows toward campaign scale (millions of rows).
CREATE INDEX IF NOT EXISTS "results_updated_at_id_idx" ON "results" ("updatedAt" DESC, "id" DESC);--> statement-breakpoint
-- 2) Derived-by-symmetry mirror rows come from terminal derived campaign
--    cells; this partial index keeps that UNION arm from scanning the full
--    sim_campaign_points ledger (1.5M+ rows, overwhelmingly 'requested').
CREATE INDEX IF NOT EXISTS "sim_campaign_points_derived_terminal_idx" ON "sim_campaign_points" ("updatedAt" DESC) WHERE derived_by_symmetry AND state = 'terminal';--> statement-breakpoint
-- 3) Story-panel closure context ("this angle open for N of M airfoils in
--    condition X") aggregates one (condition, aoa) slice; the ledger PK
--    (campaign, condition, airfoil, aoa) cannot serve an aoa-sliced probe
--    without scanning every airfoil row of the condition.
CREATE INDEX IF NOT EXISTS "sim_campaign_points_condition_aoa_idx" ON "sim_campaign_points" ("condition_id", "aoa_deg", "state");--> statement-breakpoint
