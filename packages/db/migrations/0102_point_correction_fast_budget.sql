ALTER TABLE "solver_profiles" ADD COLUMN "urans_precalc_budget_s" integer;
--> statement-breakpoint
ALTER TABLE "solver_profiles" ADD CONSTRAINT "solver_profiles_urans_precalc_budget_s_check" CHECK ("urans_precalc_budget_s" IS NULL OR "urans_precalc_budget_s" BETWEEN 14400 AND 86400);
