-- Optional per-tier URANS mesh pins on simulation presets. NULL preserves the
-- engine-derived default meshes for URANS full/precalc tiers.
ALTER TABLE "simulation_presets" ADD COLUMN IF NOT EXISTS "urans_mesh_profile_id" uuid REFERENCES "mesh_profiles"("id");--> statement-breakpoint
ALTER TABLE "simulation_presets" ADD COLUMN IF NOT EXISTS "urans_precalc_mesh_profile_id" uuid REFERENCES "mesh_profiles"("id");
