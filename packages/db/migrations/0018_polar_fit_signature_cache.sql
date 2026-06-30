DROP INDEX IF EXISTS "public"."polar_fit_sets_current_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "polar_fit_sets_signature_uq"
  ON "public"."polar_fit_sets" ("airfoil_id", "simulation_preset_revision_id", "fit_version", "evidence_signature");
