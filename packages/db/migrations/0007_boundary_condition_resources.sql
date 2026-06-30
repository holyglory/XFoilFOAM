ALTER TABLE "boundary_conditions" ADD COLUMN "scheduling_policy" text DEFAULT 'auto' NOT NULL;
ALTER TABLE "boundary_conditions" ADD COLUMN "cpu_budget" integer;
ALTER TABLE "boundary_conditions" ADD COLUMN "case_concurrency" integer;
ALTER TABLE "boundary_conditions" ADD COLUMN "solver_processes" integer;
