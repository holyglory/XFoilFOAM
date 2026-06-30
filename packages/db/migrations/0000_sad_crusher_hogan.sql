CREATE TYPE "public"."data_source" AS ENUM('synthesized', 'queued', 'solved');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."media_role" AS ENUM('instantaneous', 'mean', 'history');--> statement-breakpoint
CREATE TYPE "public"."phase" AS ENUM('gas', 'liquid');--> statement-breakpoint
CREATE TYPE "public"."regime" AS ENUM('rans', 'urans');--> statement-breakpoint
CREATE TYPE "public"."result_status" AS ENUM('pending', 'queued', 'running', 'done', 'failed', 'stale');--> statement-breakpoint
CREATE TYPE "public"."sim_job_status" AS ENUM('pending', 'submitted', 'running', 'ingesting', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "airfoils" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid NOT NULL,
	"source" text DEFAULT 'naca-generated' NOT NULL,
	"points" jsonb NOT NULL,
	"point_format" text DEFAULT 'selig' NOT NULL,
	"naca_t" double precision,
	"naca_m" double precision,
	"naca_p" double precision,
	"thickness_pct" double precision,
	"thickness_x_pct" double precision,
	"camber_pct" double precision,
	"camber_x_pct" double precision,
	"le_radius_pct" double precision,
	"te_thickness_pct" double precision,
	"area_upper" double precision,
	"area_lower" double precision,
	"area_camber" double precision,
	"ref_re" bigint DEFAULT 300000,
	"ref_ldmax" double precision,
	"ref_clmax" double precision,
	"ref_cdmin" double precision,
	"ref_metrics_source" "data_source" DEFAULT 'synthesized' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airfoils_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "boundary_conditions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"medium_id" uuid NOT NULL,
	"reynolds" bigint NOT NULL,
	"reference_chord_m" double precision DEFAULT 1 NOT NULL,
	"temperature_k" double precision,
	"mach" double precision,
	"turbulence_model" text DEFAULT 'kOmegaSST' NOT NULL,
	"turbulence_intensity" double precision DEFAULT 0.001 NOT NULL,
	"viscosity_ratio" double precision DEFAULT 10 NOT NULL,
	"sand_grain_height" double precision DEFAULT 0 NOT NULL,
	"roughness_constant" double precision DEFAULT 0.5 NOT NULL,
	"mesher" text DEFAULT 'blockmesh-cgrid' NOT NULL,
	"farfield_radius_chords" double precision DEFAULT 15 NOT NULL,
	"wake_length_chords" double precision DEFAULT 12 NOT NULL,
	"n_surface" integer DEFAULT 130 NOT NULL,
	"n_radial" integer DEFAULT 80 NOT NULL,
	"n_wake" integer DEFAULT 60 NOT NULL,
	"target_y_plus" double precision DEFAULT 1 NOT NULL,
	"span_chords" double precision DEFAULT 0.1 NOT NULL,
	"n_iterations" integer DEFAULT 3000 NOT NULL,
	"convergence_tolerance" double precision DEFAULT 0.00001 NOT NULL,
	"momentum_scheme" text DEFAULT 'linearUpwind' NOT NULL,
	"transient_cycles" double precision DEFAULT 10 NOT NULL,
	"transient_discard_fraction" double precision DEFAULT 0.4 NOT NULL,
	"transient_max_courant" double precision DEFAULT 15 NOT NULL,
	"write_images" jsonb DEFAULT '["velocity_magnitude","pressure"]'::jsonb NOT NULL,
	"image_zoom_chords" double precision DEFAULT 2 NOT NULL,
	"aoa_start" double precision DEFAULT -8 NOT NULL,
	"aoa_stop" double precision DEFAULT 20 NOT NULL,
	"aoa_step" double precision DEFAULT 1 NOT NULL,
	"aoa_list" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_seeded" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boundary_conditions_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"path" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"description" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "force_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"result_id" uuid NOT NULL,
	"t" jsonb NOT NULL,
	"cl" jsonb NOT NULL,
	"cd" jsonb NOT NULL,
	"cm" jsonb,
	"cl_mean" double precision,
	"cl_rms" double precision,
	"cd_mean" double precision,
	"cd_rms" double precision,
	"strouhal" double precision,
	"shedding_freq_hz" double precision,
	"sample_count" integer,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "force_history_result_id_unique" UNIQUE("result_id")
);
--> statement-breakpoint
CREATE TABLE "mediums" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"phase" "phase" NOT NULL,
	"density" double precision NOT NULL,
	"ref_temperature_k" double precision DEFAULT 288.15 NOT NULL,
	"viscosity_model" text NOT NULL,
	"viscosity_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dynamic_viscosity" double precision NOT NULL,
	"kinematic_viscosity" double precision NOT NULL,
	"speed_of_sound" double precision,
	"notes" text,
	"is_seeded" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mediums_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "result_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"result_id" uuid NOT NULL,
	"kind" "media_kind" NOT NULL,
	"field" text,
	"role" "media_role" NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration_s" double precision,
	"engine_url" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"airfoil_id" uuid NOT NULL,
	"bc_id" uuid NOT NULL,
	"aoa_deg" double precision NOT NULL,
	"status" "result_status" DEFAULT 'pending' NOT NULL,
	"source" "data_source" DEFAULT 'queued' NOT NULL,
	"regime" "regime",
	"reynolds" bigint,
	"speed" double precision,
	"chord" double precision,
	"mach" double precision,
	"cl" double precision,
	"cd" double precision,
	"cm" double precision,
	"cl_cd" double precision,
	"cl_std" double precision,
	"cd_std" double precision,
	"cm_std" double precision,
	"stalled" boolean DEFAULT false NOT NULL,
	"unsteady" boolean DEFAULT false NOT NULL,
	"converged" boolean DEFAULT false NOT NULL,
	"final_residual" double precision,
	"iterations" integer,
	"y_plus_avg" double precision,
	"y_plus_max" double precision,
	"first_order_fallback" boolean DEFAULT false NOT NULL,
	"strouhal" double precision,
	"error" text,
	"sim_job_id" uuid,
	"engine_job_id" text,
	"engine_case_slug" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"solvedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engine_job_id" text,
	"airfoil_id" uuid NOT NULL,
	"bc_ids" jsonb NOT NULL,
	"reference_chord_m" double precision NOT NULL,
	"wave" integer DEFAULT 1 NOT NULL,
	"status" "sim_job_status" DEFAULT 'pending' NOT NULL,
	"total_cases" integer DEFAULT 0 NOT NULL,
	"completed_cases" integer DEFAULT 0 NOT NULL,
	"request_payload" jsonb,
	"engine_state" text,
	"error" text,
	"submittedAt" timestamp with time zone,
	"polledAt" timestamp with time zone,
	"ingestedAt" timestamp with time zone,
	"finishedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sweeper_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"max_concurrent_jobs" integer DEFAULT 2 NOT NULL,
	"poll_interval_ms" integer DEFAULT 5000 NOT NULL,
	"submit_interval_ms" integer DEFAULT 15000 NOT NULL,
	"heartbeatAt" timestamp with time zone,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "airfoils" ADD CONSTRAINT "airfoils_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ADD CONSTRAINT "boundary_conditions_medium_id_mediums_id_fk" FOREIGN KEY ("medium_id") REFERENCES "public"."mediums"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "force_history" ADD CONSTRAINT "force_history_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_media" ADD CONSTRAINT "result_media_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_airfoil_id_airfoils_id_fk" FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_bc_id_boundary_conditions_id_fk" FOREIGN KEY ("bc_id") REFERENCES "public"."boundary_conditions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_sim_job_id_sim_jobs_id_fk" FOREIGN KEY ("sim_job_id") REFERENCES "public"."sim_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_jobs" ADD CONSTRAINT "sim_jobs_airfoil_id_airfoils_id_fk" FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "airfoils_category_idx" ON "airfoils" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "airfoils_thickness_idx" ON "airfoils" USING btree ("thickness_pct");--> statement-breakpoint
CREATE INDEX "airfoils_ldmax_idx" ON "airfoils" USING btree ("ref_ldmax");--> statement-breakpoint
CREATE INDEX "bc_medium_idx" ON "boundary_conditions" USING btree ("medium_id");--> statement-breakpoint
CREATE INDEX "bc_reynolds_idx" ON "boundary_conditions" USING btree ("reynolds");--> statement-breakpoint
CREATE INDEX "bc_enabled_idx" ON "boundary_conditions" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_uq" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_path_idx" ON "categories" USING btree ("path");--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "result_media_result_idx" ON "result_media" USING btree ("result_id");--> statement-breakpoint
CREATE UNIQUE INDEX "result_media_uq" ON "result_media" USING btree ("result_id","kind","field","role");--> statement-breakpoint
CREATE UNIQUE INDEX "results_natural_uq" ON "results" USING btree ("airfoil_id","bc_id","aoa_deg");--> statement-breakpoint
CREATE INDEX "results_airfoil_bc_idx" ON "results" USING btree ("airfoil_id","bc_id");--> statement-breakpoint
CREATE INDEX "results_bc_idx" ON "results" USING btree ("bc_id");--> statement-breakpoint
CREATE INDEX "results_status_idx" ON "results" USING btree ("status");--> statement-breakpoint
CREATE INDEX "results_sim_job_idx" ON "results" USING btree ("sim_job_id");--> statement-breakpoint
CREATE INDEX "sim_jobs_status_idx" ON "sim_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sim_jobs_engine_job_idx" ON "sim_jobs" USING btree ("engine_job_id");--> statement-breakpoint
CREATE INDEX "sim_jobs_airfoil_idx" ON "sim_jobs" USING btree ("airfoil_id");
