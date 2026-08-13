ALTER TABLE "point_correction_runs" DROP CONSTRAINT "point_correction_runs_corrected_preset_id_simulation_presets_id_fk";
--> statement-breakpoint
ALTER TABLE "point_correction_runs" DROP CONSTRAINT "point_correction_runs_corrected_revision_id_simulation_preset_revisions_id_fk";
--> statement-breakpoint
ALTER TABLE "point_correction_runs" DROP CONSTRAINT "point_correction_runs_urans_request_id_sim_urans_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "point_correction_runs" ADD CONSTRAINT "point_correction_runs_corrected_preset_id_simulation_presets_id_fk" FOREIGN KEY ("corrected_preset_id") REFERENCES "public"."simulation_presets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "point_correction_runs" ADD CONSTRAINT "point_correction_runs_corrected_revision_id_simulation_preset_revisions_id_fk" FOREIGN KEY ("corrected_revision_id") REFERENCES "public"."simulation_preset_revisions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "point_correction_runs" ADD CONSTRAINT "point_correction_runs_urans_request_id_sim_urans_requests_id_fk" FOREIGN KEY ("urans_request_id") REFERENCES "public"."sim_urans_requests"("id") ON DELETE cascade ON UPDATE no action;
