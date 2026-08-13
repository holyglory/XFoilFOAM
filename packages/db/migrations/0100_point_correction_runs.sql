CREATE TABLE "point_correction_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_result_id" uuid NOT NULL,
  "source_result_attempt_id" uuid NOT NULL,
  "corrected_preset_id" uuid NOT NULL,
  "corrected_revision_id" uuid NOT NULL,
  "urans_request_id" uuid NOT NULL,
  "fidelity" text NOT NULL,
  "settings_sha256" text NOT NULL,
  "settings" jsonb NOT NULL,
  "requested_by" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "point_correction_runs_fidelity_check" CHECK ("fidelity" IN ('precalc', 'full')),
  CONSTRAINT "point_correction_runs_settings_hash_check" CHECK ("settings_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "point_correction_runs" ADD CONSTRAINT "point_correction_runs_source_result_id_results_id_fk" FOREIGN KEY ("source_result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "point_correction_runs" ADD CONSTRAINT "point_correction_runs_source_attempt_owner_fk" FOREIGN KEY ("source_result_attempt_id", "source_result_id") REFERENCES "public"."result_attempts"("id", "result_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "point_correction_runs" ADD CONSTRAINT "point_correction_runs_corrected_preset_id_simulation_presets_id_fk" FOREIGN KEY ("corrected_preset_id") REFERENCES "public"."simulation_presets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "point_correction_runs" ADD CONSTRAINT "point_correction_runs_corrected_revision_id_simulation_preset_revisions_id_fk" FOREIGN KEY ("corrected_revision_id") REFERENCES "public"."simulation_preset_revisions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "point_correction_runs" ADD CONSTRAINT "point_correction_runs_urans_request_id_sim_urans_requests_id_fk" FOREIGN KEY ("urans_request_id") REFERENCES "public"."sim_urans_requests"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "point_correction_runs_source_settings_uq" ON "point_correction_runs" USING btree ("source_result_attempt_id", "settings_sha256");
--> statement-breakpoint
CREATE UNIQUE INDEX "point_correction_runs_request_uq" ON "point_correction_runs" USING btree ("urans_request_id");
--> statement-breakpoint
CREATE INDEX "point_correction_runs_source_idx" ON "point_correction_runs" USING btree ("source_result_id", "createdAt");
