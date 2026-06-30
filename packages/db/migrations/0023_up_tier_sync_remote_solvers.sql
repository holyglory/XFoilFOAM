DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sync_mode') THEN
    CREATE TYPE "public"."sync_mode" AS ENUM ('full', 'db_only_remote_assets');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'remote_solver_status') THEN
    CREATE TYPE "public"."remote_solver_status" AS ENUM (
      'disabled',
      'idle',
      'syncing',
      'claiming',
      'solving',
      'pushing',
      'error',
      'offline'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'remote_asset_availability') THEN
    CREATE TYPE "public"."remote_asset_availability" AS ENUM ('remote_only', 'cached', 'missing', 'failed');
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "sync_api_settings"
  ADD COLUMN IF NOT EXISTS "upstream_base_url" text,
  ADD COLUMN IF NOT EXISTS "upstream_secret" text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "sync_mode" "sync_mode" DEFAULT 'full' NOT NULL,
  ADD COLUMN IF NOT EXISTS "remote_solver_enabled" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "remote_solver_cpu_budget" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "remote_solver_claim_size" integer DEFAULT 36 NOT NULL,
  ADD COLUMN IF NOT EXISTS "remote_solver_heartbeat_interval_seconds" integer DEFAULT 60 NOT NULL,
  ADD COLUMN IF NOT EXISTS "remote_solver_registered_id" uuid,
  ADD COLUMN IF NOT EXISTS "remote_solver_last_sync_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "remote_solver_last_promise_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "remote_solver_last_push_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "remote_solver_last_status" "remote_solver_status" DEFAULT 'disabled' NOT NULL,
  ADD COLUMN IF NOT EXISTS "remote_solver_last_error" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "registered_remote_solvers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instance_id" text NOT NULL,
  "instance_name" text NOT NULL,
  "public_endpoint" text,
  "local_endpoint" text,
  "cpu_capacity" integer DEFAULT 0 NOT NULL,
  "cpu_budget" integer DEFAULT 0 NOT NULL,
  "build_version" text,
  "status" "remote_solver_status" DEFAULT 'idle' NOT NULL,
  "last_heartbeat_at" timestamp with time zone,
  "active_promise_count" integer DEFAULT 0 NOT NULL,
  "active_aoa_count" integer DEFAULT 0 NOT NULL,
  "solved_count" integer DEFAULT 0 NOT NULL,
  "pushed_count" integer DEFAULT 0 NOT NULL,
  "recent_error" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "registered_remote_solvers_instance_uq" ON "registered_remote_solvers" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registered_remote_solvers_status_idx" ON "registered_remote_solvers" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registered_remote_solvers_heartbeat_idx" ON "registered_remote_solvers" USING btree ("last_heartbeat_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "remote_asset_references" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "local_kind" text NOT NULL,
  "local_row_id" uuid,
  "local_storage_key" text NOT NULL,
  "result_id" uuid,
  "result_attempt_id" uuid,
  "source_instance_id" text,
  "source_instance_name" text,
  "remote_result_id" text,
  "remote_artifact_id" text,
  "remote_media_id" text,
  "remote_cache_id" text,
  "remote_download_url" text NOT NULL,
  "remote_render_url" text,
  "sha256" text,
  "byte_size" bigint,
  "mime_type" text NOT NULL,
  "availability" "remote_asset_availability" DEFAULT 'remote_only' NOT NULL,
  "cached_storage_key" text,
  "last_fetched_at" timestamp with time zone,
  "last_error" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "remote_asset_references"
  ADD CONSTRAINT "remote_asset_references_result_id_results_id_fk"
  FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_asset_references"
  ADD CONSTRAINT "remote_asset_references_attempt_id_attempts_id_fk"
  FOREIGN KEY ("result_attempt_id") REFERENCES "public"."result_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "remote_asset_references_storage_uq" ON "remote_asset_references" USING btree ("local_storage_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_asset_references_local_row_idx" ON "remote_asset_references" USING btree ("local_kind","local_row_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_asset_references_result_idx" ON "remote_asset_references" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_asset_references_remote_artifact_idx" ON "remote_asset_references" USING btree ("source_instance_id","remote_artifact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_asset_references_remote_media_idx" ON "remote_asset_references" USING btree ("source_instance_id","remote_media_id");--> statement-breakpoint
