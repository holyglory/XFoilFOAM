CREATE INDEX IF NOT EXISTS "results_catalog_metrics_idx"
ON "public"."results" (
  "airfoil_id",
  "simulation_preset_revision_id",
  "status",
  "source",
  "regime",
  "aoa_deg"
);

CREATE INDEX IF NOT EXISTS "result_attempts_catalog_rejected_idx"
ON "public"."result_attempts" (
  "airfoil_id",
  "simulation_preset_revision_id",
  "status",
  "source",
  "regime",
  "valid_for_polar",
  "aoa_deg"
);
