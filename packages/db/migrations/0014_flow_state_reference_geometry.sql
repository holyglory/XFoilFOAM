CREATE TABLE "flow_conditions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"medium_id" uuid NOT NULL,
	"temperature_k" double precision DEFAULT 288.15 NOT NULL,
	"pressure_pa" double precision DEFAULT 101325 NOT NULL,
	"speed_mps" double precision DEFAULT 50 NOT NULL,
	"density" double precision DEFAULT 1.225 NOT NULL,
	"dynamic_viscosity" double precision DEFAULT 1.789e-5 NOT NULL,
	"kinematic_viscosity" double precision DEFAULT 1.46e-5 NOT NULL,
	"mach" double precision,
	"is_seeded" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_conditions_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "reference_geometry_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"geometry_type" text DEFAULT 'airfoil_2d' NOT NULL,
	"reference_length_kind" text DEFAULT 'chord' NOT NULL,
	"reference_length_m" double precision DEFAULT 1 NOT NULL,
	"span_m" double precision,
	"reference_area_m2" double precision,
	"is_seeded" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_geometry_profiles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "flow_conditions" ADD CONSTRAINT "flow_conditions_medium_id_mediums_id_fk" FOREIGN KEY ("medium_id") REFERENCES "public"."mediums"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "flow_conditions_medium_idx" ON "flow_conditions" USING btree ("medium_id");
--> statement-breakpoint
CREATE INDEX "reference_geometry_profiles_type_idx" ON "reference_geometry_profiles" USING btree ("geometry_type");
--> statement-breakpoint
INSERT INTO "flow_conditions" (
	"id", "slug", "name", "medium_id", "temperature_k", "pressure_pa", "speed_mps",
	"density", "dynamic_viscosity", "kinematic_viscosity", "mach", "is_seeded",
	"createdAt", "updatedAt"
)
SELECT
	oc.id, oc.slug, oc.name, oc.medium_id, oc.temperature_k, oc.pressure_pa, oc.speed_mps,
	oc.density, oc.dynamic_viscosity, oc.kinematic_viscosity, oc.mach, oc.is_seeded,
	oc."createdAt", oc."updatedAt"
FROM "operating_conditions" oc
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "reference_geometry_profiles" (
	"slug", "name", "geometry_type", "reference_length_kind", "reference_length_m",
	"is_seeded", "createdAt", "updatedAt"
)
SELECT
	oc.slug || '-reference-geometry',
	oc.name || ' reference geometry',
	'airfoil_2d',
	'chord',
	oc.reference_chord_m,
	oc.is_seeded,
	oc."createdAt",
	oc."updatedAt"
FROM "operating_conditions" oc
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ADD COLUMN "flow_condition_id" uuid;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ADD COLUMN "reference_geometry_profile_id" uuid;
--> statement-breakpoint
UPDATE "simulation_presets" p
SET
	"flow_condition_id" = fc.id,
	"reference_geometry_profile_id" = rg.id
FROM "operating_conditions" oc
JOIN "flow_conditions" fc ON fc.id = oc.id
JOIN "reference_geometry_profiles" rg ON rg.slug = oc.slug || '-reference-geometry'
WHERE p."operating_condition_id" = oc.id;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ALTER COLUMN "flow_condition_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ALTER COLUMN "reference_geometry_profile_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ALTER COLUMN "operating_condition_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ADD CONSTRAINT "simulation_presets_flow_condition_id_flow_conditions_id_fk" FOREIGN KEY ("flow_condition_id") REFERENCES "public"."flow_conditions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ADD CONSTRAINT "simulation_presets_reference_geometry_profile_id_reference_geometry_profiles_id_fk" FOREIGN KEY ("reference_geometry_profile_id") REFERENCES "public"."reference_geometry_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "simulation_presets_flow_condition_idx" ON "simulation_presets" USING btree ("flow_condition_id");
--> statement-breakpoint
CREATE INDEX "simulation_presets_reference_geometry_idx" ON "simulation_presets" USING btree ("reference_geometry_profile_id");
--> statement-breakpoint
ALTER TABLE "simulation_preset_revisions" ADD COLUMN "reynolds" bigint;
--> statement-breakpoint
ALTER TABLE "simulation_preset_revisions" ADD COLUMN "mach" double precision;
--> statement-breakpoint
ALTER TABLE "simulation_preset_revisions" ADD COLUMN "reference_length_m" double precision;
--> statement-breakpoint
UPDATE "simulation_preset_revisions" rev
SET
	"reynolds" = round((fc.speed_mps * rg.reference_length_m) / NULLIF(fc.kinematic_viscosity, 0))::bigint,
	"mach" = fc.mach,
	"reference_length_m" = rg.reference_length_m,
	"snapshot" = jsonb_build_object(
		'preset', rev.snapshot->'preset',
		'flowState', jsonb_build_object(
			'id', fc.id,
			'slug', fc.slug,
			'name', fc.name,
			'mediumId', fc.medium_id,
			'mediumSlug', rev.snapshot->'operating'->>'mediumSlug',
			'mediumName', rev.snapshot->'operating'->>'mediumName',
			'temperatureK', fc.temperature_k,
			'pressurePa', fc.pressure_pa,
			'speedMps', fc.speed_mps,
			'density', fc.density,
			'dynamicViscosity', fc.dynamic_viscosity,
			'kinematicViscosity', fc.kinematic_viscosity,
			'mach', fc.mach
		),
		'referenceGeometry', jsonb_build_object(
			'id', rg.id,
			'slug', rg.slug,
			'name', rg.name,
			'geometryType', rg.geometry_type,
			'referenceLengthKind', rg.reference_length_kind,
			'referenceLengthM', rg.reference_length_m,
			'spanM', rg.span_m,
			'referenceAreaM2', rg.reference_area_m2
		),
		'derived', jsonb_build_object(
			'reynolds', round((fc.speed_mps * rg.reference_length_m) / NULLIF(fc.kinematic_viscosity, 0))::bigint,
			'mach', fc.mach
		),
		'boundary', rev.snapshot->'boundary',
		'mesh', rev.snapshot->'mesh',
		'solver', rev.snapshot->'solver',
		'scheduling', rev.snapshot->'scheduling',
		'output', rev.snapshot->'output',
		'sweep', rev.snapshot->'sweep'
	)
FROM "simulation_presets" p
JOIN "flow_conditions" fc ON fc.id = p.flow_condition_id
JOIN "reference_geometry_profiles" rg ON rg.id = p.reference_geometry_profile_id
WHERE rev.preset_id = p.id;
--> statement-breakpoint
ALTER TABLE "simulation_preset_revisions" ALTER COLUMN "reynolds" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "simulation_preset_revisions" ALTER COLUMN "reference_length_m" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "simulation_preset_revisions_reynolds_idx" ON "simulation_preset_revisions" USING btree ("reynolds");
