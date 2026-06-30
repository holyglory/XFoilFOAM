DO $$ BEGIN
 CREATE TYPE "public"."result_classification_state" AS ENUM('accepted', 'needs_urans', 'superseded_by_urans', 'rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 CREATE TYPE "public"."result_classification_region" AS ENUM('attached', 'near_stall', 'post_stall', 'unknown');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 CREATE TYPE "public"."polar_fit_status" AS ENUM('final', 'provisional', 'insufficient');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "public"."result_classifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid,
  "result_attempt_id" uuid,
  "airfoil_id" uuid NOT NULL,
  "simulation_preset_revision_id" uuid NOT NULL,
  "aoa_deg" double precision NOT NULL,
  "regime" "public"."regime",
  "classifier_version" text NOT NULL,
  "state" "public"."result_classification_state" NOT NULL,
  "region" "public"."result_classification_region" DEFAULT 'unknown' NOT NULL,
  "confidence" double precision DEFAULT 1 NOT NULL,
  "reasons" text[] DEFAULT '{}'::text[] NOT NULL,
  "superseded_by_result_id" uuid,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."polar_fit_sets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "airfoil_id" uuid NOT NULL,
  "simulation_preset_revision_id" uuid NOT NULL,
  "fit_version" text NOT NULL,
  "evidence_signature" text NOT NULL,
  "status" "public"."polar_fit_status" NOT NULL,
  "confidence" double precision DEFAULT 0 NOT NULL,
  "accepted_point_count" integer DEFAULT 0 NOT NULL,
  "provisional_point_count" integer DEFAULT 0 NOT NULL,
  "rejected_point_count" integer DEFAULT 0 NOT NULL,
  "reynolds" bigint,
  "mach" double precision,
  "ldmax" double precision,
  "alpha_ldmax" double precision,
  "clmax" double precision,
  "alpha_clmax" double precision,
  "cdmin" double precision,
  "cl_at_cdmin" double precision,
  "cd0" double precision,
  "cm0" double precision,
  "aoa_min" double precision,
  "aoa_max" double precision,
  "is_current" boolean DEFAULT true NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."polar_fit_points" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fit_set_id" uuid NOT NULL,
  "aoa_deg" double precision NOT NULL,
  "cl" double precision NOT NULL,
  "cd" double precision NOT NULL,
  "cm" double precision NOT NULL,
  "cl_cd" double precision NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "public"."result_classifications"
   ADD CONSTRAINT "result_classifications_result_id_results_id_fk"
   FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "public"."result_classifications"
   ADD CONSTRAINT "result_classifications_result_attempt_id_result_attempts_id_fk"
   FOREIGN KEY ("result_attempt_id") REFERENCES "public"."result_attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "public"."result_classifications"
   ADD CONSTRAINT "result_classifications_airfoil_id_airfoils_id_fk"
   FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "public"."result_classifications"
   ADD CONSTRAINT "result_classifications_simulation_preset_revision_id_simulation_preset_revisions_id_fk"
   FOREIGN KEY ("simulation_preset_revision_id") REFERENCES "public"."simulation_preset_revisions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "public"."result_classifications"
   ADD CONSTRAINT "result_classifications_superseded_by_result_id_results_id_fk"
   FOREIGN KEY ("superseded_by_result_id") REFERENCES "public"."results"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "public"."polar_fit_sets"
   ADD CONSTRAINT "polar_fit_sets_airfoil_id_airfoils_id_fk"
   FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "public"."polar_fit_sets"
   ADD CONSTRAINT "polar_fit_sets_simulation_preset_revision_id_simulation_preset_revisions_id_fk"
   FOREIGN KEY ("simulation_preset_revision_id") REFERENCES "public"."simulation_preset_revisions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "public"."polar_fit_points"
   ADD CONSTRAINT "polar_fit_points_fit_set_id_polar_fit_sets_id_fk"
   FOREIGN KEY ("fit_set_id") REFERENCES "public"."polar_fit_sets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "result_classifications_result_uq" ON "public"."result_classifications" ("result_id");
CREATE UNIQUE INDEX IF NOT EXISTS "result_classifications_attempt_uq" ON "public"."result_classifications" ("result_attempt_id");
CREATE INDEX IF NOT EXISTS "result_classifications_polar_idx" ON "public"."result_classifications" ("airfoil_id","simulation_preset_revision_id","state","aoa_deg");
CREATE UNIQUE INDEX IF NOT EXISTS "polar_fit_sets_current_uq" ON "public"."polar_fit_sets" ("airfoil_id","simulation_preset_revision_id","fit_version");
CREATE INDEX IF NOT EXISTS "polar_fit_sets_airfoil_idx" ON "public"."polar_fit_sets" ("airfoil_id","is_current","status");
CREATE INDEX IF NOT EXISTS "polar_fit_sets_revision_idx" ON "public"."polar_fit_sets" ("simulation_preset_revision_id");
CREATE INDEX IF NOT EXISTS "polar_fit_points_fit_set_idx" ON "public"."polar_fit_points" ("fit_set_id");
CREATE UNIQUE INDEX IF NOT EXISTS "polar_fit_points_aoa_uq" ON "public"."polar_fit_points" ("fit_set_id","aoa_deg");
