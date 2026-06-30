DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sync_data_type') THEN
    CREATE TYPE "public"."sync_data_type" AS ENUM (
      'sweeps',
      'airfoils',
      'catalog_metadata',
      'mediums',
      'simulation_setup',
      'polars',
      'evidence_artifacts',
      'result_media'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sync_promise_status') THEN
    CREATE TYPE "public"."sync_promise_status" AS ENUM ('active', 'fulfilled', 'expired', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sync_import_conflict_status') THEN
    CREATE TYPE "public"."sync_import_conflict_status" AS ENUM ('pending', 'promoted', 'archived');
  END IF;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sync_api_settings" (
  "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "instance_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "instance_name" text DEFAULT 'XFoilFOAM instance' NOT NULL,
  "public_endpoint_override" text,
  "secret" text DEFAULT '' NOT NULL,
  "default_promise_ttl_hours" integer DEFAULT 24 NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sync_api_permissions" (
  "data_type" "sync_data_type" PRIMARY KEY NOT NULL,
  "can_fetch" boolean DEFAULT false NOT NULL,
  "can_push" boolean DEFAULT false NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sync_sweep_promises" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_instance_id" text,
  "source_instance_name" text,
  "source_base_url" text,
  "status" "sync_promise_status" DEFAULT 'active' NOT NULL,
  "airfoil_id" uuid NOT NULL,
  "simulation_preset_revision_id" uuid NOT NULL,
  "aoa_count" integer DEFAULT 0 NOT NULL,
  "expiresAt" timestamp with time zone NOT NULL,
  "fulfilledAt" timestamp with time zone,
  "cancelledAt" timestamp with time zone,
  "expiredAt" timestamp with time zone,
  "lastHeartbeatAt" timestamp with time zone,
  "request_payload" jsonb,
  "response_payload" jsonb,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sync_sweep_promise_points" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "promise_id" uuid NOT NULL,
  "airfoil_id" uuid NOT NULL,
  "simulation_preset_revision_id" uuid NOT NULL,
  "aoa_deg" double precision NOT NULL,
  "status" "sync_promise_status" DEFAULT 'active' NOT NULL,
  "result_id" uuid,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sync_import_conflicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "data_type" "sync_data_type" NOT NULL,
  "natural_key" text NOT NULL,
  "source_instance_id" text,
  "source_instance_name" text,
  "status" "sync_import_conflict_status" DEFAULT 'pending' NOT NULL,
  "incoming_payload" jsonb NOT NULL,
  "local_snapshot" jsonb,
  "artifact_manifest" jsonb,
  "resolution_note" text,
  "resolvedAt" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "sync_sweep_promises"
  ADD CONSTRAINT "sync_sweep_promises_airfoil_id_airfoils_id_fk"
  FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_sweep_promises"
  ADD CONSTRAINT "sync_sweep_promises_revision_id_revisions_id_fk"
  FOREIGN KEY ("simulation_preset_revision_id") REFERENCES "public"."simulation_preset_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_sweep_promise_points"
  ADD CONSTRAINT "sync_sweep_promise_points_promise_id_promises_id_fk"
  FOREIGN KEY ("promise_id") REFERENCES "public"."sync_sweep_promises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_sweep_promise_points"
  ADD CONSTRAINT "sync_sweep_promise_points_airfoil_id_airfoils_id_fk"
  FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_sweep_promise_points"
  ADD CONSTRAINT "sync_sweep_promise_points_revision_id_revisions_id_fk"
  FOREIGN KEY ("simulation_preset_revision_id") REFERENCES "public"."simulation_preset_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_sweep_promise_points"
  ADD CONSTRAINT "sync_sweep_promise_points_result_id_results_id_fk"
  FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sync_sweep_promises_status_idx" ON "sync_sweep_promises" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_sweep_promises_expires_idx" ON "sync_sweep_promises" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_sweep_promises_scope_idx" ON "sync_sweep_promises" USING btree ("airfoil_id","simulation_preset_revision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_sweep_promise_points_promise_idx" ON "sync_sweep_promise_points" USING btree ("promise_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_sweep_promise_points_status_idx" ON "sync_sweep_promise_points" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_sweep_promise_points_scope_idx" ON "sync_sweep_promise_points" USING btree ("airfoil_id","simulation_preset_revision_id","aoa_deg");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_sweep_promise_points_active_uq" ON "sync_sweep_promise_points" USING btree ("airfoil_id","simulation_preset_revision_id","aoa_deg") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_import_conflicts_status_idx" ON "sync_import_conflicts" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_import_conflicts_natural_key_idx" ON "sync_import_conflicts" USING btree ("data_type","natural_key");--> statement-breakpoint

INSERT INTO "sync_api_settings" ("id")
VALUES (1)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

INSERT INTO "sync_api_permissions" ("data_type", "can_fetch", "can_push")
VALUES
  ('sweeps', false, false),
  ('airfoils', false, false),
  ('catalog_metadata', false, false),
  ('mediums', false, false),
  ('simulation_setup', false, false),
  ('polars', false, false),
  ('evidence_artifacts', false, false),
  ('result_media', false, false)
ON CONFLICT ("data_type") DO NOTHING;
