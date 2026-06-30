DO $$ BEGIN
  CREATE TYPE "public"."evidence_artifact_kind" AS ENUM (
    'manifest',
    'openfoam_bundle',
    'vtk_window',
    'time_directory',
    'log',
    'force_coefficients',
    'mesh',
    'dictionary',
    'field_data'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "solver_evidence_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid,
  "result_attempt_id" uuid,
  "airfoil_id" uuid NOT NULL,
  "sim_job_id" uuid,
  "engine_job_id" text,
  "engine_case_slug" text,
  "aoa_deg" double precision,
  "kind" "evidence_artifact_kind" NOT NULL,
  "field" text,
  "role" text,
  "storage_key" text NOT NULL,
  "mime_type" text NOT NULL,
  "sha256" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "engine_url" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "field_render_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid NOT NULL,
  "field" text NOT NULL,
  "role" text DEFAULT 'instantaneous' NOT NULL,
  "params_hash" text NOT NULL,
  "params" jsonb NOT NULL,
  "kind" "media_kind" DEFAULT 'image' NOT NULL,
  "storage_key" text NOT NULL,
  "mime_type" text NOT NULL,
  "sha256" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "width" integer,
  "height" integer,
  "frame_count" integer,
  "duration_s" double precision,
  "engine_url" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "solver_evidence_artifacts"
  ADD CONSTRAINT "solver_evidence_artifacts_result_id_results_id_fk"
  FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "solver_evidence_artifacts"
  ADD CONSTRAINT "solver_evidence_artifacts_result_attempt_id_result_attempts_id_fk"
  FOREIGN KEY ("result_attempt_id") REFERENCES "public"."result_attempts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "solver_evidence_artifacts"
  ADD CONSTRAINT "solver_evidence_artifacts_airfoil_id_airfoils_id_fk"
  FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "solver_evidence_artifacts"
  ADD CONSTRAINT "solver_evidence_artifacts_sim_job_id_sim_jobs_id_fk"
  FOREIGN KEY ("sim_job_id") REFERENCES "public"."sim_jobs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "field_render_cache"
  ADD CONSTRAINT "field_render_cache_result_id_results_id_fk"
  FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "solver_evidence_artifacts_result_idx" ON "solver_evidence_artifacts" USING btree ("result_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "solver_evidence_artifacts_attempt_idx" ON "solver_evidence_artifacts" USING btree ("result_attempt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "solver_evidence_artifacts_airfoil_idx" ON "solver_evidence_artifacts" USING btree ("airfoil_id","aoa_deg");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "solver_evidence_artifacts_storage_uq" ON "solver_evidence_artifacts" USING btree ("storage_key","sha256");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "field_render_cache_result_idx" ON "field_render_cache" USING btree ("result_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "field_render_cache_result_params_uq" ON "field_render_cache" USING btree ("result_id","field","role","params_hash");
--> statement-breakpoint
ALTER TABLE "output_profiles"
  ALTER COLUMN "write_images" SET DEFAULT '[
    "velocity_magnitude",
    "velocity_x",
    "velocity_y",
    "pressure",
    "pressure_coefficient",
    "vorticity",
    "turbulent_kinetic_energy",
    "turbulent_viscosity"
  ]'::jsonb;
--> statement-breakpoint
ALTER TABLE "boundary_conditions"
  ALTER COLUMN "write_images" SET DEFAULT '[
    "velocity_magnitude",
    "velocity_x",
    "velocity_y",
    "pressure",
    "pressure_coefficient",
    "vorticity",
    "turbulent_kinetic_energy",
    "turbulent_viscosity"
  ]'::jsonb;
--> statement-breakpoint
UPDATE "output_profiles"
SET "write_images" = '[
  "velocity_magnitude",
  "velocity_x",
  "velocity_y",
  "pressure",
  "pressure_coefficient",
  "vorticity",
  "turbulent_kinetic_energy",
  "turbulent_viscosity"
]'::jsonb;
--> statement-breakpoint
UPDATE "boundary_conditions"
SET "write_images" = '[
  "velocity_magnitude",
  "velocity_x",
  "velocity_y",
  "pressure",
  "pressure_coefficient",
  "vorticity",
  "turbulent_kinetic_energy",
  "turbulent_viscosity"
]'::jsonb;
