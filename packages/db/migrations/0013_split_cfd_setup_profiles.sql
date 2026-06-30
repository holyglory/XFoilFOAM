CREATE TABLE "operating_conditions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"medium_id" uuid NOT NULL,
	"reference_chord_m" double precision DEFAULT 1 NOT NULL,
	"temperature_k" double precision DEFAULT 288.15 NOT NULL,
	"pressure_pa" double precision DEFAULT 101325 NOT NULL,
	"speed_mps" double precision DEFAULT 50 NOT NULL,
	"density" double precision DEFAULT 1.225 NOT NULL,
	"dynamic_viscosity" double precision DEFAULT 0.00001789 NOT NULL,
	"kinematic_viscosity" double precision DEFAULT 0.0000146 NOT NULL,
	"reynolds" bigint NOT NULL,
	"mach" double precision,
	"is_seeded" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operating_conditions_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "boundary_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"turbulence_intensity" double precision DEFAULT 0.001 NOT NULL,
	"viscosity_ratio" double precision DEFAULT 10 NOT NULL,
	"sand_grain_height" double precision DEFAULT 0 NOT NULL,
	"roughness_constant" double precision DEFAULT 0.5 NOT NULL,
	"is_seeded" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boundary_profiles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "mesh_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"mesher" text DEFAULT 'blockmesh-cgrid' NOT NULL,
	"farfield_radius_chords" double precision DEFAULT 15 NOT NULL,
	"wake_length_chords" double precision DEFAULT 12 NOT NULL,
	"n_surface" integer DEFAULT 130 NOT NULL,
	"n_radial" integer DEFAULT 80 NOT NULL,
	"n_wake" integer DEFAULT 60 NOT NULL,
	"target_y_plus" double precision DEFAULT 1 NOT NULL,
	"span_chords" double precision DEFAULT 0.1 NOT NULL,
	"is_seeded" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mesh_profiles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "solver_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"turbulence_model" text DEFAULT 'kOmegaSST' NOT NULL,
	"n_iterations" integer DEFAULT 3000 NOT NULL,
	"convergence_tolerance" double precision DEFAULT 0.00001 NOT NULL,
	"momentum_scheme" text DEFAULT 'linearUpwind' NOT NULL,
	"transient_cycles" double precision DEFAULT 10 NOT NULL,
	"transient_discard_fraction" double precision DEFAULT 0.4 NOT NULL,
	"transient_max_courant" double precision DEFAULT 15 NOT NULL,
	"is_seeded" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "solver_profiles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "scheduling_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"scheduling_policy" text DEFAULT 'auto' NOT NULL,
	"cpu_budget" integer,
	"case_concurrency" integer,
	"solver_processes" integer,
	"is_seeded" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduling_profiles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "output_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"write_images" jsonb DEFAULT '["velocity_magnitude","pressure"]'::jsonb NOT NULL,
	"image_zoom_chords" double precision DEFAULT 2 NOT NULL,
	"is_seeded" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "output_profiles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sweep_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"aoa_start" double precision DEFAULT -8 NOT NULL,
	"aoa_stop" double precision DEFAULT 20 NOT NULL,
	"aoa_step" double precision DEFAULT 1 NOT NULL,
	"aoa_list" jsonb,
	"is_seeded" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sweep_definitions_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "simulation_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"operating_condition_id" uuid NOT NULL,
	"boundary_profile_id" uuid NOT NULL,
	"mesh_profile_id" uuid NOT NULL,
	"solver_profile_id" uuid NOT NULL,
	"scheduling_profile_id" uuid NOT NULL,
	"output_profile_id" uuid NOT NULL,
	"sweep_definition_id" uuid NOT NULL,
	"legacy_boundary_condition_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_seeded" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "simulation_presets_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "simulation_preset_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preset_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"signature_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operating_conditions" ADD CONSTRAINT "operating_conditions_medium_id_mediums_id_fk" FOREIGN KEY ("medium_id") REFERENCES "public"."mediums"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ADD CONSTRAINT "simulation_presets_operating_condition_id_operating_conditions_id_fk" FOREIGN KEY ("operating_condition_id") REFERENCES "public"."operating_conditions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ADD CONSTRAINT "simulation_presets_boundary_profile_id_boundary_profiles_id_fk" FOREIGN KEY ("boundary_profile_id") REFERENCES "public"."boundary_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ADD CONSTRAINT "simulation_presets_mesh_profile_id_mesh_profiles_id_fk" FOREIGN KEY ("mesh_profile_id") REFERENCES "public"."mesh_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ADD CONSTRAINT "simulation_presets_solver_profile_id_solver_profiles_id_fk" FOREIGN KEY ("solver_profile_id") REFERENCES "public"."solver_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ADD CONSTRAINT "simulation_presets_scheduling_profile_id_scheduling_profiles_id_fk" FOREIGN KEY ("scheduling_profile_id") REFERENCES "public"."scheduling_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ADD CONSTRAINT "simulation_presets_output_profile_id_output_profiles_id_fk" FOREIGN KEY ("output_profile_id") REFERENCES "public"."output_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ADD CONSTRAINT "simulation_presets_sweep_definition_id_sweep_definitions_id_fk" FOREIGN KEY ("sweep_definition_id") REFERENCES "public"."sweep_definitions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "simulation_presets" ADD CONSTRAINT "simulation_presets_legacy_boundary_condition_id_boundary_conditions_id_fk" FOREIGN KEY ("legacy_boundary_condition_id") REFERENCES "public"."boundary_conditions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "simulation_preset_revisions" ADD CONSTRAINT "simulation_preset_revisions_preset_id_simulation_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."simulation_presets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "simulation_preset_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "result_attempts" ADD COLUMN "simulation_preset_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "sim_jobs" ADD COLUMN "simulation_preset_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_simulation_preset_revision_id_simulation_preset_revisions_id_fk" FOREIGN KEY ("simulation_preset_revision_id") REFERENCES "public"."simulation_preset_revisions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "result_attempts" ADD CONSTRAINT "result_attempts_simulation_preset_revision_id_simulation_preset_revisions_id_fk" FOREIGN KEY ("simulation_preset_revision_id") REFERENCES "public"."simulation_preset_revisions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sim_jobs" ADD CONSTRAINT "sim_jobs_simulation_preset_revision_id_simulation_preset_revisions_id_fk" FOREIGN KEY ("simulation_preset_revision_id") REFERENCES "public"."simulation_preset_revisions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "operating_conditions_medium_idx" ON "operating_conditions" USING btree ("medium_id");
--> statement-breakpoint
CREATE INDEX "operating_conditions_reynolds_idx" ON "operating_conditions" USING btree ("reynolds");
--> statement-breakpoint
CREATE INDEX "simulation_presets_enabled_idx" ON "simulation_presets" USING btree ("enabled");
--> statement-breakpoint
CREATE INDEX "simulation_presets_legacy_bc_idx" ON "simulation_presets" USING btree ("legacy_boundary_condition_id");
--> statement-breakpoint
CREATE INDEX "simulation_preset_revisions_preset_idx" ON "simulation_preset_revisions" USING btree ("preset_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "simulation_preset_revisions_signature_uq" ON "simulation_preset_revisions" USING btree ("preset_id","signature_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "simulation_preset_revisions_revision_uq" ON "simulation_preset_revisions" USING btree ("preset_id","revision_number");
--> statement-breakpoint
CREATE INDEX "results_preset_revision_idx" ON "results" USING btree ("simulation_preset_revision_id");
--> statement-breakpoint
CREATE INDEX "result_attempts_preset_revision_idx" ON "result_attempts" USING btree ("simulation_preset_revision_id");
--> statement-breakpoint
CREATE INDEX "sim_jobs_preset_revision_idx" ON "sim_jobs" USING btree ("simulation_preset_revision_id");
--> statement-breakpoint
INSERT INTO "operating_conditions" (
	"slug", "name", "medium_id", "reference_chord_m", "temperature_k",
	"pressure_pa", "speed_mps", "density", "dynamic_viscosity",
	"kinematic_viscosity", "reynolds", "mach", "is_seeded", "createdAt", "updatedAt"
)
SELECT
	b.slug, b.name, b.medium_id, b.reference_chord_m, b.temperature_k,
	b.pressure_pa, b.speed_mps, b.density, b.dynamic_viscosity,
	b.kinematic_viscosity, b.reynolds, b.mach, b.is_seeded, b."createdAt", b."updatedAt"
FROM "boundary_conditions" b
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "boundary_profiles" (
	"slug", "name", "turbulence_intensity", "viscosity_ratio",
	"sand_grain_height", "roughness_constant", "is_seeded", "createdAt", "updatedAt"
)
SELECT
	b.slug, b.name, b.turbulence_intensity, b.viscosity_ratio,
	b.sand_grain_height, b.roughness_constant, b.is_seeded, b."createdAt", b."updatedAt"
FROM "boundary_conditions" b
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "mesh_profiles" (
	"slug", "name", "mesher", "farfield_radius_chords", "wake_length_chords",
	"n_surface", "n_radial", "n_wake", "target_y_plus", "span_chords",
	"is_seeded", "createdAt", "updatedAt"
)
SELECT
	b.slug, b.name, b.mesher, b.farfield_radius_chords, b.wake_length_chords,
	b.n_surface, b.n_radial, b.n_wake, b.target_y_plus, b.span_chords,
	b.is_seeded, b."createdAt", b."updatedAt"
FROM "boundary_conditions" b
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "solver_profiles" (
	"slug", "name", "turbulence_model", "n_iterations", "convergence_tolerance",
	"momentum_scheme", "transient_cycles", "transient_discard_fraction",
	"transient_max_courant", "is_seeded", "createdAt", "updatedAt"
)
SELECT
	b.slug, b.name, b.turbulence_model, b.n_iterations, b.convergence_tolerance,
	b.momentum_scheme, b.transient_cycles, b.transient_discard_fraction,
	b.transient_max_courant, b.is_seeded, b."createdAt", b."updatedAt"
FROM "boundary_conditions" b
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "scheduling_profiles" (
	"slug", "name", "scheduling_policy", "cpu_budget", "case_concurrency",
	"solver_processes", "is_seeded", "createdAt", "updatedAt"
)
SELECT
	b.slug, b.name, b.scheduling_policy, b.cpu_budget, b.case_concurrency,
	b.solver_processes, b.is_seeded, b."createdAt", b."updatedAt"
FROM "boundary_conditions" b
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "output_profiles" (
	"slug", "name", "write_images", "image_zoom_chords", "is_seeded", "createdAt", "updatedAt"
)
SELECT b.slug, b.name, b.write_images, b.image_zoom_chords, b.is_seeded, b."createdAt", b."updatedAt"
FROM "boundary_conditions" b
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "sweep_definitions" (
	"slug", "name", "aoa_start", "aoa_stop", "aoa_step", "aoa_list", "is_seeded", "createdAt", "updatedAt"
)
SELECT b.slug, b.name, b.aoa_start, b.aoa_stop, b.aoa_step, b.aoa_list, b.is_seeded, b."createdAt", b."updatedAt"
FROM "boundary_conditions" b
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "simulation_presets" (
	"slug", "name", "operating_condition_id", "boundary_profile_id",
	"mesh_profile_id", "solver_profile_id", "scheduling_profile_id",
	"output_profile_id", "sweep_definition_id", "legacy_boundary_condition_id",
	"enabled", "is_seeded", "createdAt", "updatedAt"
)
SELECT
	b.slug, b.name, oc.id, bp.id, mp.id, sp.id, sched.id, op.id, sw.id, b.id,
	b.enabled, b.is_seeded, b."createdAt", b."updatedAt"
FROM "boundary_conditions" b
JOIN "operating_conditions" oc ON oc.slug = b.slug
JOIN "boundary_profiles" bp ON bp.slug = b.slug
JOIN "mesh_profiles" mp ON mp.slug = b.slug
JOIN "solver_profiles" sp ON sp.slug = b.slug
JOIN "scheduling_profiles" sched ON sched.slug = b.slug
JOIN "output_profiles" op ON op.slug = b.slug
JOIN "sweep_definitions" sw ON sw.slug = b.slug
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
WITH resolved AS (
	SELECT
		p.id AS preset_id,
		jsonb_build_object(
			'preset', jsonb_build_object('id', p.id, 'slug', p.slug, 'name', p.name, 'enabled', p.enabled, 'legacyBoundaryConditionId', p.legacy_boundary_condition_id),
			'operating', jsonb_build_object(
				'id', oc.id, 'slug', oc.slug, 'name', oc.name, 'mediumId', oc.medium_id,
				'mediumSlug', m.slug, 'mediumName', m.name, 'temperatureK', oc.temperature_k,
				'pressurePa', oc.pressure_pa, 'speedMps', oc.speed_mps,
				'referenceChordM', oc.reference_chord_m, 'density', oc.density,
				'dynamicViscosity', oc.dynamic_viscosity, 'kinematicViscosity', oc.kinematic_viscosity,
				'reynolds', oc.reynolds, 'mach', oc.mach
			),
			'boundary', jsonb_build_object(
				'id', bp.id, 'slug', bp.slug, 'name', bp.name, 'turbulenceIntensity', bp.turbulence_intensity,
				'viscosityRatio', bp.viscosity_ratio, 'sandGrainHeight', bp.sand_grain_height,
				'roughnessConstant', bp.roughness_constant
			),
			'mesh', jsonb_build_object(
				'id', mp.id, 'slug', mp.slug, 'name', mp.name, 'mesher', mp.mesher,
				'farfieldRadiusChords', mp.farfield_radius_chords, 'wakeLengthChords', mp.wake_length_chords,
				'nSurface', mp.n_surface, 'nRadial', mp.n_radial, 'nWake', mp.n_wake,
				'targetYPlus', mp.target_y_plus, 'spanChords', mp.span_chords
			),
			'solver', jsonb_build_object(
				'id', sol.id, 'slug', sol.slug, 'name', sol.name, 'turbulenceModel', sol.turbulence_model,
				'nIterations', sol.n_iterations, 'convergenceTolerance', sol.convergence_tolerance,
				'momentumScheme', sol.momentum_scheme, 'transientCycles', sol.transient_cycles,
				'transientDiscardFraction', sol.transient_discard_fraction,
				'transientMaxCourant', sol.transient_max_courant
			),
			'scheduling', jsonb_build_object(
				'id', sched.id, 'slug', sched.slug, 'name', sched.name, 'schedulingPolicy', sched.scheduling_policy,
				'cpuBudget', sched.cpu_budget, 'caseConcurrency', sched.case_concurrency,
				'solverProcesses', sched.solver_processes
			),
			'output', jsonb_build_object(
				'id', op.id, 'slug', op.slug, 'name', op.name, 'writeImages', op.write_images,
				'imageZoomChords', op.image_zoom_chords
			),
			'sweep', jsonb_build_object(
				'id', sw.id, 'slug', sw.slug, 'name', sw.name, 'aoaStart', sw.aoa_start,
				'aoaStop', sw.aoa_stop, 'aoaStep', sw.aoa_step, 'aoaList', sw.aoa_list
			)
		) AS snapshot
	FROM "simulation_presets" p
	JOIN "operating_conditions" oc ON oc.id = p.operating_condition_id
	JOIN "mediums" m ON m.id = oc.medium_id
	JOIN "boundary_profiles" bp ON bp.id = p.boundary_profile_id
	JOIN "mesh_profiles" mp ON mp.id = p.mesh_profile_id
	JOIN "solver_profiles" sol ON sol.id = p.solver_profile_id
	JOIN "scheduling_profiles" sched ON sched.id = p.scheduling_profile_id
	JOIN "output_profiles" op ON op.id = p.output_profile_id
	JOIN "sweep_definitions" sw ON sw.id = p.sweep_definition_id
)
INSERT INTO "simulation_preset_revisions" ("preset_id", "revision_number", "signature_hash", "snapshot")
SELECT preset_id, 1, md5(snapshot::text), snapshot
FROM resolved
ON CONFLICT ("preset_id", "signature_hash") DO NOTHING;
--> statement-breakpoint
UPDATE "results" r
SET "simulation_preset_revision_id" = rev.id
FROM "simulation_presets" p
JOIN "simulation_preset_revisions" rev ON rev.preset_id = p.id AND rev.revision_number = 1
WHERE r.bc_id = p.legacy_boundary_condition_id
  AND r."simulation_preset_revision_id" IS NULL;
--> statement-breakpoint
UPDATE "result_attempts" a
SET "simulation_preset_revision_id" = rev.id
FROM "simulation_presets" p
JOIN "simulation_preset_revisions" rev ON rev.preset_id = p.id AND rev.revision_number = 1
WHERE a.bc_id = p.legacy_boundary_condition_id
  AND a."simulation_preset_revision_id" IS NULL;
--> statement-breakpoint
UPDATE "sim_jobs" j
SET "simulation_preset_revision_id" = rev.id
FROM "simulation_presets" p
JOIN "simulation_preset_revisions" rev ON rev.preset_id = p.id AND rev.revision_number = 1
WHERE j.bc_ids ? (p.legacy_boundary_condition_id::text)
  AND j."simulation_preset_revision_id" IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "results_natural_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "results_revision_natural_uq" ON "results" USING btree ("airfoil_id","simulation_preset_revision_id","aoa_deg");
