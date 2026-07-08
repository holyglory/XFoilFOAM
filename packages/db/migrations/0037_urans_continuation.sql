-- URANS continuation work items (approved design c19fd74a, amendment C,
-- 2026-07-08): a URANS solve stopped by the wall-clock budget guard leaves its
-- case state saved on the engine volume. The user can CONTINUE the calculation
-- with an increased budget: an admin request-URANS item gains
--   continue_from_result_id — the rejected results row whose saved engine case
--     (engine_job_id + engine_case_slug on that row) the continuation resumes
--     from (latestTime restart, coefficient history merged engine-side);
--   budget_override_s — the increased wall-clock solver budget for the resumed
--     transient (+2h / +6h choices in the UI; the engine replaces its
--     fidelity-derived budget with this value for the continuation run).
-- Extending sim_urans_requests (not a sibling table) keeps the fidelity,
-- idempotency (one open item per cell+fidelity) and scheduler-rank semantics
-- of contract 6 without a second work-item mechanism.
ALTER TABLE "sim_urans_requests" ADD COLUMN IF NOT EXISTS "continue_from_result_id" uuid REFERENCES "results"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sim_urans_requests" ADD COLUMN IF NOT EXISTS "budget_override_s" integer;
