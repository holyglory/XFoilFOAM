CREATE TABLE "result_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid,
  "airfoil_id" uuid NOT NULL,
  "bc_id" uuid NOT NULL,
  "aoa_deg" double precision NOT NULL,
  "sim_job_id" uuid,
  "engine_job_id" text,
  "engine_case_slug" text,
  "status" "result_status" DEFAULT 'done' NOT NULL,
  "source" "data_source" DEFAULT 'solved' NOT NULL,
  "regime" "regime",
  "valid_for_polar" boolean DEFAULT false NOT NULL,
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
  "evidence_payload" jsonb,
  "solvedAt" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "result_attempts" ADD CONSTRAINT "result_attempts_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "result_attempts" ADD CONSTRAINT "result_attempts_airfoil_id_airfoils_id_fk" FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "result_attempts" ADD CONSTRAINT "result_attempts_bc_id_boundary_conditions_id_fk" FOREIGN KEY ("bc_id") REFERENCES "public"."boundary_conditions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "result_attempts" ADD CONSTRAINT "result_attempts_sim_job_id_sim_jobs_id_fk" FOREIGN KEY ("sim_job_id") REFERENCES "public"."sim_jobs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "result_attempts_result_idx" ON "result_attempts" USING btree ("result_id");
--> statement-breakpoint
CREATE INDEX "result_attempts_airfoil_bc_idx" ON "result_attempts" USING btree ("airfoil_id","bc_id");
--> statement-breakpoint
CREATE INDEX "result_attempts_sim_job_idx" ON "result_attempts" USING btree ("sim_job_id");
--> statement-breakpoint
CREATE INDEX "result_attempts_valid_idx" ON "result_attempts" USING btree ("valid_for_polar");
