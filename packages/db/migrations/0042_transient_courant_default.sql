-- Keep new Node-side solver profiles aligned with the engine's pinned safe
-- relaxed-PIMPLE ceiling. Existing immutable profiles/revisions are evidence
-- and deliberately remain unchanged; only future omitted values default to 4.

ALTER TABLE "solver_profiles"
  ALTER COLUMN "transient_max_courant" SET DEFAULT 4;--> statement-breakpoint

ALTER TABLE "boundary_conditions"
  ALTER COLUMN "transient_max_courant" SET DEFAULT 4;
