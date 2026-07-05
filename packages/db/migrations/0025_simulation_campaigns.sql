-- Simulation campaigns (docs/simulation-campaigns-spec.md §3, §14 step 1):
-- additive columns on existing tables + the eight new campaign tables.
-- No destructive changes. Backfills run separately AFTER this migration:
--   pnpm --filter @aerodb/db backfill:physics-hash
--   pnpm --filter @aerodb/db backfill:canonical-keys
--   pnpm --filter @aerodb/db backfill:airfoil-symmetry

-- ---------------------------------------------------------------------------
-- Modified tables (spec §3.2)
-- ---------------------------------------------------------------------------
ALTER TABLE "airfoils" ADD COLUMN IF NOT EXISTS "is_symmetric" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "airfoils" ADD COLUMN IF NOT EXISTS "symmetryCheckedAt" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "flow_conditions" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "flow_conditions" ADD COLUMN IF NOT EXISTS "created_by_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "flow_conditions" ADD COLUMN IF NOT EXISTS "canonical_key" text;--> statement-breakpoint
UPDATE "flow_conditions" SET "origin" = 'seeded' WHERE "is_seeded" AND "origin" = 'user';--> statement-breakpoint

ALTER TABLE "reference_geometry_profiles" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "reference_geometry_profiles" ADD COLUMN IF NOT EXISTS "created_by_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "reference_geometry_profiles" ADD COLUMN IF NOT EXISTS "canonical_key" text;--> statement-breakpoint
UPDATE "reference_geometry_profiles" SET "origin" = 'seeded' WHERE "is_seeded" AND "origin" = 'user';--> statement-breakpoint

ALTER TABLE "simulation_presets" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'library' NOT NULL;--> statement-breakpoint

ALTER TABLE "simulation_preset_revisions" ADD COLUMN IF NOT EXISTS "physics_hash" text;--> statement-breakpoint
ALTER TABLE "simulation_preset_revisions" ADD COLUMN IF NOT EXISTS "is_canonical_physics" boolean DEFAULT false NOT NULL;--> statement-breakpoint

ALTER TABLE "sim_jobs" ADD COLUMN IF NOT EXISTS "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "sim_jobs" ADD COLUMN IF NOT EXISTS "job_kind" text DEFAULT 'sweep' NOT NULL;--> statement-breakpoint

-- 0 = auto: jobs are submitted without a cpu_budget cap and the engine
-- resolves its own worker budget — the pre-campaign effective behavior.
ALTER TABLE "sweeper_state" ADD COLUMN IF NOT EXISTS "cpu_slots" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "polar_fit_sets" ADD COLUMN IF NOT EXISTS "alpha_ldmax_fine" double precision;--> statement-breakpoint
ALTER TABLE "polar_fit_sets" ADD COLUMN IF NOT EXISTS "alpha_cl_zero_fine" double precision;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- New tables (spec §3.1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "sim_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "notes" text,
  "status" text DEFAULT 'active' NOT NULL,
  "priority" integer DEFAULT 5 NOT NULL,
  "idempotency_key" text NOT NULL,
  "current_plan_revision_id" uuid,
  "closed_with_failed_count" integer,
  "completedAt" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sim_campaigns_priority_check" CHECK ("priority" >= 0 AND "priority" <= 9)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sim_campaign_airfoils" (
  "campaign_id" uuid NOT NULL,
  "airfoil_id" uuid NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("campaign_id", "airfoil_id")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sim_campaign_plan_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL,
  "revision_number" integer NOT NULL,
  "kind" text NOT NULL,
  "plan" jsonb NOT NULL,
  "summary" jsonb NOT NULL,
  "created_by" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sim_campaign_conditions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL,
  "ord" integer NOT NULL,
  "flow_condition_id" uuid NOT NULL,
  "reference_geometry_profile_id" uuid NOT NULL,
  "preset_id" uuid NOT NULL,
  "simulation_preset_revision_id" uuid NOT NULL,
  "reynolds" bigint NOT NULL,
  "mach" double precision,
  "status" text DEFAULT 'active' NOT NULL,
  "introduced_in_plan_revision_id" uuid NOT NULL,
  "status_changed_in_plan_revision_id" uuid,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sim_campaign_points" (
  "campaign_id" uuid NOT NULL,
  "condition_id" uuid NOT NULL,
  "airfoil_id" uuid NOT NULL,
  "aoa_deg" double precision NOT NULL,
  "revision_id" uuid NOT NULL,
  "plan_revision_number" integer NOT NULL,
  "state" text DEFAULT 'requested' NOT NULL,
  "result_id" uuid,
  "derived_by_symmetry" boolean DEFAULT false NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("campaign_id", "condition_id", "airfoil_id", "aoa_deg")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sim_campaign_progress" (
  "campaign_id" uuid NOT NULL,
  "condition_id" uuid NOT NULL,
  "airfoil_id" uuid NOT NULL,
  "requested" integer DEFAULT 0 NOT NULL,
  "solved" integer DEFAULT 0 NOT NULL,
  "failed" integer DEFAULT 0 NOT NULL,
  "running" integer DEFAULT 0 NOT NULL,
  "superseded" integer DEFAULT 0 NOT NULL,
  "derived" integer DEFAULT 0 NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("campaign_id", "condition_id", "airfoil_id")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sim_campaign_lanes" (
  "campaign_id" uuid NOT NULL,
  "airfoil_id" uuid NOT NULL,
  "condition_id" uuid NOT NULL,
  "objective" text NOT NULL,
  "state" text DEFAULT 'awaiting_seed' NOT NULL,
  "current_target_alpha" double precision,
  "iteration_count" integer DEFAULT 0 NOT NULL,
  "witness_fit_set_id" uuid,
  "extra_rounds_granted" integer DEFAULT 0 NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("campaign_id", "airfoil_id", "condition_id", "objective")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sim_campaign_lane_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL,
  "airfoil_id" uuid NOT NULL,
  "condition_id" uuid NOT NULL,
  "objective" text NOT NULL,
  "iteration" integer NOT NULL,
  "predicted_alpha" double precision NOT NULL,
  "fit_set_id" uuid NOT NULL,
  "solved_result_id" uuid,
  "outcome" text DEFAULT 'predicted' NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Foreign keys (sim_campaigns ↔ sim_campaign_plan_revisions is circular, so
-- the current_plan_revision_id FK is added after both tables exist)
-- ---------------------------------------------------------------------------
ALTER TABLE "sim_campaigns"
  ADD CONSTRAINT "sim_campaigns_current_plan_revision_id_fk"
  FOREIGN KEY ("current_plan_revision_id") REFERENCES "public"."sim_campaign_plan_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_conditions"
  ADD CONSTRAINT "flow_conditions_created_by_campaign_id_fk"
  FOREIGN KEY ("created_by_campaign_id") REFERENCES "public"."sim_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_geometry_profiles"
  ADD CONSTRAINT "reference_geometry_profiles_created_by_campaign_id_fk"
  FOREIGN KEY ("created_by_campaign_id") REFERENCES "public"."sim_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_jobs"
  ADD CONSTRAINT "sim_jobs_campaign_id_fk"
  FOREIGN KEY ("campaign_id") REFERENCES "public"."sim_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_airfoils"
  ADD CONSTRAINT "sim_campaign_airfoils_campaign_id_fk"
  FOREIGN KEY ("campaign_id") REFERENCES "public"."sim_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_airfoils"
  ADD CONSTRAINT "sim_campaign_airfoils_airfoil_id_fk"
  FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_plan_revisions"
  ADD CONSTRAINT "sim_campaign_plan_revisions_campaign_id_fk"
  FOREIGN KEY ("campaign_id") REFERENCES "public"."sim_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_conditions"
  ADD CONSTRAINT "sim_campaign_conditions_campaign_id_fk"
  FOREIGN KEY ("campaign_id") REFERENCES "public"."sim_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_conditions"
  ADD CONSTRAINT "sim_campaign_conditions_flow_condition_id_fk"
  FOREIGN KEY ("flow_condition_id") REFERENCES "public"."flow_conditions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_conditions"
  ADD CONSTRAINT "sim_campaign_conditions_reference_geometry_profile_id_fk"
  FOREIGN KEY ("reference_geometry_profile_id") REFERENCES "public"."reference_geometry_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_conditions"
  ADD CONSTRAINT "sim_campaign_conditions_preset_id_fk"
  FOREIGN KEY ("preset_id") REFERENCES "public"."simulation_presets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_conditions"
  ADD CONSTRAINT "sim_campaign_conditions_revision_id_fk"
  FOREIGN KEY ("simulation_preset_revision_id") REFERENCES "public"."simulation_preset_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_conditions"
  ADD CONSTRAINT "sim_campaign_conditions_introduced_plan_revision_fk"
  FOREIGN KEY ("introduced_in_plan_revision_id") REFERENCES "public"."sim_campaign_plan_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_conditions"
  ADD CONSTRAINT "sim_campaign_conditions_status_changed_plan_revision_fk"
  FOREIGN KEY ("status_changed_in_plan_revision_id") REFERENCES "public"."sim_campaign_plan_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_points"
  ADD CONSTRAINT "sim_campaign_points_campaign_id_fk"
  FOREIGN KEY ("campaign_id") REFERENCES "public"."sim_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_points"
  ADD CONSTRAINT "sim_campaign_points_condition_id_fk"
  FOREIGN KEY ("condition_id") REFERENCES "public"."sim_campaign_conditions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_points"
  ADD CONSTRAINT "sim_campaign_points_airfoil_id_fk"
  FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_points"
  ADD CONSTRAINT "sim_campaign_points_result_id_fk"
  FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_progress"
  ADD CONSTRAINT "sim_campaign_progress_campaign_id_fk"
  FOREIGN KEY ("campaign_id") REFERENCES "public"."sim_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_progress"
  ADD CONSTRAINT "sim_campaign_progress_condition_id_fk"
  FOREIGN KEY ("condition_id") REFERENCES "public"."sim_campaign_conditions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_progress"
  ADD CONSTRAINT "sim_campaign_progress_airfoil_id_fk"
  FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_lanes"
  ADD CONSTRAINT "sim_campaign_lanes_campaign_id_fk"
  FOREIGN KEY ("campaign_id") REFERENCES "public"."sim_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_lanes"
  ADD CONSTRAINT "sim_campaign_lanes_airfoil_id_fk"
  FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_lanes"
  ADD CONSTRAINT "sim_campaign_lanes_condition_id_fk"
  FOREIGN KEY ("condition_id") REFERENCES "public"."sim_campaign_conditions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_lanes"
  ADD CONSTRAINT "sim_campaign_lanes_witness_fit_set_id_fk"
  FOREIGN KEY ("witness_fit_set_id") REFERENCES "public"."polar_fit_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_lane_steps"
  ADD CONSTRAINT "sim_campaign_lane_steps_lane_fk"
  FOREIGN KEY ("campaign_id", "airfoil_id", "condition_id", "objective") REFERENCES "public"."sim_campaign_lanes"("campaign_id", "airfoil_id", "condition_id", "objective") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_lane_steps"
  ADD CONSTRAINT "sim_campaign_lane_steps_fit_set_id_fk"
  FOREIGN KEY ("fit_set_id") REFERENCES "public"."polar_fit_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_campaign_lane_steps"
  ADD CONSTRAINT "sim_campaign_lane_steps_solved_result_id_fk"
  FOREIGN KEY ("solved_result_id") REFERENCES "public"."results"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Indexes (unique / partial-unique indexes match the drizzle schema)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "flow_conditions_canonical_key_uq" ON "flow_conditions" USING btree ("canonical_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reference_geometry_profiles_canonical_key_uq" ON "reference_geometry_profiles" USING btree ("canonical_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "simulation_preset_revisions_physics_hash_idx" ON "simulation_preset_revisions" USING btree ("physics_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "simulation_preset_revisions_canonical_physics_uq" ON "simulation_preset_revisions" USING btree ("physics_hash") WHERE "is_canonical_physics";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_jobs_campaign_idx" ON "sim_jobs" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sim_campaigns_slug_uq" ON "sim_campaigns" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sim_campaigns_idempotency_key_uq" ON "sim_campaigns" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_campaigns_status_idx" ON "sim_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_campaign_airfoils_airfoil_idx" ON "sim_campaign_airfoils" USING btree ("airfoil_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sim_campaign_plan_revisions_revision_uq" ON "sim_campaign_plan_revisions" USING btree ("campaign_id","revision_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_campaign_plan_revisions_campaign_idx" ON "sim_campaign_plan_revisions" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sim_campaign_conditions_combo_uq" ON "sim_campaign_conditions" USING btree ("campaign_id","flow_condition_id","reference_geometry_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_campaign_conditions_campaign_status_idx" ON "sim_campaign_conditions" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_campaign_conditions_revision_idx" ON "sim_campaign_conditions" USING btree ("simulation_preset_revision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_campaign_points_requested_idx" ON "sim_campaign_points" USING btree ("campaign_id") WHERE "state" = 'requested';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_campaign_points_requested_revision_idx" ON "sim_campaign_points" USING btree ("revision_id","airfoil_id","aoa_deg") WHERE "state" = 'requested';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_campaign_points_result_idx" ON "sim_campaign_points" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_campaign_progress_condition_idx" ON "sim_campaign_progress" USING btree ("condition_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_campaign_lanes_state_idx" ON "sim_campaign_lanes" USING btree ("campaign_id","objective","state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sim_campaign_lane_steps_iteration_uq" ON "sim_campaign_lane_steps" USING btree ("campaign_id","airfoil_id","condition_id","objective","iteration");--> statement-breakpoint
