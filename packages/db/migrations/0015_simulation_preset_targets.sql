CREATE TYPE "preset_target_scope" AS ENUM ('all', 'airfoils');

ALTER TABLE "simulation_presets"
  ADD COLUMN "target_scope" "preset_target_scope" DEFAULT 'all' NOT NULL;

CREATE TABLE "simulation_preset_airfoil_targets" (
  "preset_id" uuid NOT NULL,
  "airfoil_id" uuid NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "simulation_preset_airfoil_targets_preset_id_airfoil_id_pk" PRIMARY KEY("preset_id", "airfoil_id")
);

ALTER TABLE "simulation_preset_airfoil_targets"
  ADD CONSTRAINT "simulation_preset_airfoil_targets_preset_id_simulation_presets_id_fk"
  FOREIGN KEY ("preset_id") REFERENCES "public"."simulation_presets"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "simulation_preset_airfoil_targets"
  ADD CONSTRAINT "simulation_preset_airfoil_targets_airfoil_id_airfoils_id_fk"
  FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "simulation_preset_targets_preset_idx" ON "simulation_preset_airfoil_targets" USING btree ("preset_id");
CREATE INDEX "simulation_preset_targets_airfoil_idx" ON "simulation_preset_airfoil_targets" USING btree ("airfoil_id");
