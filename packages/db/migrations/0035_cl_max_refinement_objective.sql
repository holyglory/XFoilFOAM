-- Cl_max refinement objective (third lane type, 2026-07-08): the campaign
-- lane/step tables use plain text objective columns, so 'cl_max' lanes need no
-- DDL there. The only new persistence is the fine refinement target computed
-- inside buildPolarFit (LOWESS-evaluated Cl argmax bracketed around the coarse
-- grid argmax, canonical 0.01°) — precedent: alpha_ldmax_fine /
-- alpha_cl_zero_fine in 0025.
--
-- NULL semantics (backward compatible, no backfill): NULL = fit predates
-- POLAR_FIT_VERSION evidence-lowess-v3 (refreshes lazily on next ingest per
-- revision) OR the coarse Cl argmax sits on the evidence-range boundary (no
-- interior maximum — stall not bracketed, honest absence instead of a value).
ALTER TABLE "polar_fit_sets" ADD COLUMN IF NOT EXISTS "alpha_cl_max_fine" double precision;--> statement-breakpoint
-- Single-current repair (idempotent): storeFit used to retire only rows of
-- the CURRENT fit version, so each POLAR_FIT_VERSION bump left the
-- prior-version row co-current with the freshly refreshed one — and the
-- detail/catalog single-current readers then picked nondeterministically.
-- storeFit now retires every current row for the pair; this repairs pairs
-- already double-current from earlier bumps (keep newest by created_at, id).
UPDATE "polar_fit_sets" p SET "is_current" = false
WHERE p."is_current" AND EXISTS (
  SELECT 1 FROM "polar_fit_sets" q
  WHERE q."airfoil_id" = p."airfoil_id"
    AND q."simulation_preset_revision_id" = p."simulation_preset_revision_id"
    AND q."is_current"
    AND (q."createdAt" > p."createdAt" OR (q."createdAt" = p."createdAt" AND q."id" > p."id"))
);--> statement-breakpoint
