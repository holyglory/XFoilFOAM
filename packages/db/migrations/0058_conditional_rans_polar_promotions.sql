CREATE TABLE "sim_rans_polar_promotions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "parent_job_id" uuid NOT NULL,
  "airfoil_id" uuid NOT NULL,
  "revision_id" uuid NOT NULL,
  "condition_id" uuid,
  "owner_kind" text NOT NULL,
  "campaign_id" uuid,
  "sync_promise_id" uuid,
  "trigger_result_attempt_id" uuid NOT NULL,
  "trigger_aoa_deg" double precision NOT NULL,
  "failure_disposition" text NOT NULL,
  "request_origin" text NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sim_rans_polar_promotions_trigger_uq" UNIQUE("trigger_result_attempt_id"),
  CONSTRAINT "sim_rans_polar_promotions_parent_revision_uq" UNIQUE("parent_job_id", "revision_id"),
  CONSTRAINT "sim_rans_polar_promotions_trigger_range_check" CHECK ("trigger_aoa_deg" >= 0 AND "trigger_aoa_deg" <= 5),
  CONSTRAINT "sim_rans_polar_promotions_disposition_check" CHECK ("failure_disposition" = 'hard_solver'),
  CONSTRAINT "sim_rans_polar_promotions_origin_check" CHECK ("request_origin" = 'continuous-polar'),
  CONSTRAINT "sim_rans_polar_promotions_owner_kind_check" CHECK ("owner_kind" IN ('campaign', 'background', 'sync_promise')),
  CONSTRAINT "sim_rans_polar_promotions_owner_shape_check" CHECK (
    ("owner_kind" = 'campaign' AND "campaign_id" IS NOT NULL AND "sync_promise_id" IS NULL)
    OR ("owner_kind" = 'background' AND "campaign_id" IS NULL AND "sync_promise_id" IS NULL)
    OR ("owner_kind" = 'sync_promise' AND "campaign_id" IS NULL AND "sync_promise_id" IS NOT NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "sim_rans_polar_promotions" ADD CONSTRAINT "sim_rans_polar_promotions_parent_job_id_sim_jobs_id_fk" FOREIGN KEY ("parent_job_id") REFERENCES "public"."sim_jobs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sim_rans_polar_promotions" ADD CONSTRAINT "sim_rans_polar_promotions_airfoil_id_airfoils_id_fk" FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sim_rans_polar_promotions" ADD CONSTRAINT "sim_rans_polar_promotions_revision_id_simulation_preset_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."simulation_preset_revisions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sim_rans_polar_promotions" ADD CONSTRAINT "sim_rans_polar_promotions_condition_id_sim_campaign_conditions_id_fk" FOREIGN KEY ("condition_id") REFERENCES "public"."sim_campaign_conditions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sim_rans_polar_promotions" ADD CONSTRAINT "sim_rans_polar_promotions_campaign_id_sim_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."sim_campaigns"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sim_rans_polar_promotions" ADD CONSTRAINT "sim_rans_polar_promotions_trigger_result_attempt_id_result_attempts_id_fk" FOREIGN KEY ("trigger_result_attempt_id") REFERENCES "public"."result_attempts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sim_rans_polar_promotions" ADD CONSTRAINT "sim_rans_polar_promotions_sync_promise_id_sync_sweep_promises_id_fk" FOREIGN KEY ("sync_promise_id") REFERENCES "public"."sync_sweep_promises"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "sim_rans_polar_promotions_parent_idx" ON "sim_rans_polar_promotions" USING btree ("parent_job_id");
--> statement-breakpoint
CREATE INDEX "sim_rans_polar_promotions_revision_idx" ON "sim_rans_polar_promotions" USING btree ("airfoil_id", "revision_id");
--> statement-breakpoint
CREATE INDEX "sim_rans_polar_promotions_campaign_idx" ON "sim_rans_polar_promotions" USING btree ("campaign_id");
--> statement-breakpoint
CREATE INDEX "sim_rans_polar_promotions_sync_promise_idx" ON "sim_rans_polar_promotions" USING btree ("sync_promise_id");
--> statement-breakpoint
CREATE TABLE "sim_rans_polar_promotion_points" (
  "promotion_id" uuid NOT NULL,
  "aoa_deg" double precision NOT NULL,
  "obligation_id" uuid NOT NULL,
  "intentionally_omitted_by_rans" boolean DEFAULT false NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sim_rans_polar_promotion_points_promotion_id_aoa_deg_pk" PRIMARY KEY("promotion_id", "aoa_deg"),
  CONSTRAINT "sim_rans_polar_promotion_points_promotion_obligation_uq" UNIQUE("promotion_id", "obligation_id")
);
--> statement-breakpoint
ALTER TABLE "sim_rans_polar_promotion_points" ADD CONSTRAINT "sim_rans_polar_promotion_points_promotion_id_sim_rans_polar_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."sim_rans_polar_promotions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sim_rans_polar_promotion_points" ADD CONSTRAINT "sim_rans_polar_promotion_points_obligation_id_sim_precalc_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."sim_precalc_obligations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "sim_rans_polar_promotion_points_obligation_idx" ON "sim_rans_polar_promotion_points" USING btree ("obligation_id");
