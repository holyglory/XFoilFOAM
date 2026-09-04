ALTER TABLE "solver_profiles"
  ADD COLUMN "urans_initialization_iterations" integer;
--> statement-breakpoint
ALTER TABLE "solver_profiles"
  ADD CONSTRAINT "solver_profiles_urans_initialization_iterations_check"
  CHECK ("urans_initialization_iterations" IS NULL OR "urans_initialization_iterations" BETWEEN 50 AND 20000);
