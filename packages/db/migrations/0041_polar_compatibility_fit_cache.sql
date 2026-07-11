-- Public polar compatibility cache. Exact revision-scoped polar_fit_sets stay
-- unchanged; this additive read model combines evidence only across revisions
-- carrying the same physics-only compatibility hash.

CREATE TABLE IF NOT EXISTS "polar_compatibility_fit_sets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "airfoil_id" uuid NOT NULL,
  "compatibility_version" text NOT NULL,
  "compatibility_hash" text NOT NULL,
  "fit_version" text NOT NULL,
  "evidence_signature" text NOT NULL,
  "status" "public"."polar_fit_status" NOT NULL,
  "confidence" double precision DEFAULT 0 NOT NULL,
  "accepted_point_count" integer DEFAULT 0 NOT NULL,
  "provisional_point_count" integer DEFAULT 0 NOT NULL,
  "rejected_point_count" integer DEFAULT 0 NOT NULL,
  "conflict_point_count" integer DEFAULT 0 NOT NULL,
  "reynolds" bigint,
  "mach" double precision,
  "ldmax" double precision,
  "alpha_ldmax" double precision,
  "alpha_ldmax_fine" double precision,
  "alpha_cl_zero_fine" double precision,
  "alpha_cl_max_fine" double precision,
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
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "polar_compatibility_fit_points" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fit_set_id" uuid NOT NULL,
  "aoa_deg" double precision NOT NULL,
  "cl" double precision NOT NULL,
  "cd" double precision NOT NULL,
  "cm" double precision NOT NULL,
  "cl_cd" double precision NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "polar_compatibility_fit_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fit_set_id" uuid NOT NULL,
  "result_id" uuid NOT NULL,
  "simulation_preset_revision_id" uuid NOT NULL,
  "aoa_deg" double precision NOT NULL,
  "role" text NOT NULL,
  "selection_rank" integer NOT NULL,
  "selection_reason" text NOT NULL,
  "classification_state" "public"."result_classification_state" NOT NULL,
  "classification_region" "public"."result_classification_region" NOT NULL,
  "classification_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
  "classification_confidence" double precision NOT NULL,
  "review_verdict" text,
  "fidelity" text,
  "regime" "public"."regime",
  "cl" double precision NOT NULL,
  "cd" double precision NOT NULL,
  "cm" double precision,
  "cl_cd" double precision,
  "cl_std" double precision,
  "cd_std" double precision,
  "cm_std" double precision,
  "stalled" boolean NOT NULL,
  "unsteady" boolean NOT NULL,
  "converged" boolean NOT NULL,
  "result_updated_at" timestamp with time zone NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "polar_compatibility_fit_members_role_check"
    CHECK ("role" IN ('selected', 'shadowed', 'conflict'))
);--> statement-breakpoint

ALTER TABLE "polar_compatibility_fit_sets"
  ADD CONSTRAINT "polar_compatibility_fit_sets_airfoil_id_airfoils_id_fk"
  FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "polar_compatibility_fit_points"
  ADD CONSTRAINT "polar_compatibility_fit_points_fit_set_id_fk"
  FOREIGN KEY ("fit_set_id") REFERENCES "public"."polar_compatibility_fit_sets"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "polar_compatibility_fit_members"
  ADD CONSTRAINT "polar_compatibility_fit_members_fit_set_id_fk"
  FOREIGN KEY ("fit_set_id") REFERENCES "public"."polar_compatibility_fit_sets"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "polar_compatibility_fit_members"
  ADD CONSTRAINT "polar_compatibility_fit_members_result_id_results_id_fk"
  FOREIGN KEY ("result_id") REFERENCES "public"."results"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "polar_compatibility_fit_members"
  ADD CONSTRAINT "polar_compatibility_fit_members_revision_id_fk"
  FOREIGN KEY ("simulation_preset_revision_id") REFERENCES "public"."simulation_preset_revisions"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "polar_compatibility_fit_sets_signature_uq"
  ON "polar_compatibility_fit_sets" (
    "airfoil_id", "compatibility_version", "compatibility_hash",
    "fit_version", "evidence_signature"
  );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "polar_compatibility_fit_sets_current_uq"
  ON "polar_compatibility_fit_sets" (
    "airfoil_id", "compatibility_version", "compatibility_hash"
  ) WHERE "is_current";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "polar_compatibility_fit_sets_airfoil_idx"
  ON "polar_compatibility_fit_sets" ("airfoil_id", "is_current", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "polar_compatibility_fit_sets_compatibility_idx"
  ON "polar_compatibility_fit_sets" ("compatibility_version", "compatibility_hash");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "polar_compatibility_fit_points_fit_set_idx"
  ON "polar_compatibility_fit_points" ("fit_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "polar_compatibility_fit_points_aoa_uq"
  ON "polar_compatibility_fit_points" ("fit_set_id", "aoa_deg");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "polar_compatibility_fit_members_result_uq"
  ON "polar_compatibility_fit_members" ("fit_set_id", "result_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "polar_compatibility_fit_members_fit_role_idx"
  ON "polar_compatibility_fit_members" ("fit_set_id", "role", "aoa_deg");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "polar_compatibility_fit_members_result_idx"
  ON "polar_compatibility_fit_members" ("result_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "polar_compatibility_fit_members_revision_idx"
  ON "polar_compatibility_fit_members" ("simulation_preset_revision_id");
