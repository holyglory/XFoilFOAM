CREATE TYPE "public"."color_scale_status" AS ENUM('active', 'rebalancing', 'failed');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "field_color_scales" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "airfoil_id" uuid NOT NULL,
  "simulation_preset_revision_id" uuid NOT NULL,
  "field" text NOT NULL,
  "render_profile_key" text DEFAULT 'default:v1:zoom2' NOT NULL,
  "scale_policy" text NOT NULL,
  "vmin" double precision NOT NULL,
  "vmax" double precision NOT NULL,
  "evidence_signature" text NOT NULL,
  "status" "color_scale_status" DEFAULT 'active' NOT NULL,
  "version" integer NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "failure_reason" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "activatedAt" timestamp with time zone
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "result_field_extents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid NOT NULL,
  "airfoil_id" uuid NOT NULL,
  "simulation_preset_revision_id" uuid NOT NULL,
  "field" text NOT NULL,
  "render_profile_key" text DEFAULT 'default:v1:zoom2' NOT NULL,
  "vmin" double precision NOT NULL,
  "vmax" double precision NOT NULL,
  "finite_count" integer NOT NULL,
  "source_time_start" double precision,
  "source_time_end" double precision,
  "evidence_sha256" text NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "result_media" ADD COLUMN IF NOT EXISTS "color_scale_id" uuid;--> statement-breakpoint
ALTER TABLE "result_media" ADD COLUMN IF NOT EXISTS "color_scale_version" integer;--> statement-breakpoint
ALTER TABLE "result_media" ADD COLUMN IF NOT EXISTS "scale_vmin" double precision;--> statement-breakpoint
ALTER TABLE "result_media" ADD COLUMN IF NOT EXISTS "scale_vmax" double precision;--> statement-breakpoint
ALTER TABLE "result_media" ADD COLUMN IF NOT EXISTS "scale_policy" text;--> statement-breakpoint
ALTER TABLE "result_media" ADD COLUMN IF NOT EXISTS "render_profile_key" text DEFAULT 'default:v1:zoom2' NOT NULL;--> statement-breakpoint

ALTER TABLE "field_color_scales"
  ADD CONSTRAINT "field_color_scales_airfoil_id_airfoils_id_fk"
  FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_color_scales"
  ADD CONSTRAINT "field_color_scales_simulation_preset_revision_id_simulation_preset_revisions_id_fk"
  FOREIGN KEY ("simulation_preset_revision_id") REFERENCES "public"."simulation_preset_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_field_extents"
  ADD CONSTRAINT "result_field_extents_result_id_results_id_fk"
  FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_field_extents"
  ADD CONSTRAINT "result_field_extents_airfoil_id_airfoils_id_fk"
  FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_field_extents"
  ADD CONSTRAINT "result_field_extents_simulation_preset_revision_id_simulation_preset_revisions_id_fk"
  FOREIGN KEY ("simulation_preset_revision_id") REFERENCES "public"."simulation_preset_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_media"
  ADD CONSTRAINT "result_media_color_scale_id_field_color_scales_id_fk"
  FOREIGN KEY ("color_scale_id") REFERENCES "public"."field_color_scales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "field_color_scales_scope_idx" ON "field_color_scales" USING btree ("airfoil_id","simulation_preset_revision_id","field","render_profile_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "field_color_scales_active_uq" ON "field_color_scales" USING btree ("airfoil_id","simulation_preset_revision_id","field","render_profile_key") WHERE "active";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "field_color_scales_version_uq" ON "field_color_scales" USING btree ("airfoil_id","simulation_preset_revision_id","field","render_profile_key","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_field_extents_result_idx" ON "result_field_extents" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_field_extents_scope_idx" ON "result_field_extents" USING btree ("airfoil_id","simulation_preset_revision_id","field","render_profile_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "result_field_extents_result_field_uq" ON "result_field_extents" USING btree ("result_id","field","render_profile_key");
