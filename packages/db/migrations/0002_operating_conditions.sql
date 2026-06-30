ALTER TABLE "mediums" ADD COLUMN "ref_pressure_pa" double precision DEFAULT 101325 NOT NULL;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ADD COLUMN "pressure_pa" double precision DEFAULT 101325 NOT NULL;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ADD COLUMN "speed_mps" double precision;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ADD COLUMN "density" double precision;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ADD COLUMN "dynamic_viscosity" double precision;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ADD COLUMN "kinematic_viscosity" double precision;--> statement-breakpoint
ALTER TABLE "sim_jobs" ADD COLUMN "parent_job_id" uuid;--> statement-breakpoint
UPDATE "boundary_conditions" b
SET
  "temperature_k" = COALESCE(b."temperature_k", m."ref_temperature_k"),
  "density" = m."density",
  "dynamic_viscosity" = m."dynamic_viscosity",
  "kinematic_viscosity" = m."kinematic_viscosity",
  "speed_mps" = (b."reynolds"::double precision * m."kinematic_viscosity") / NULLIF(b."reference_chord_m", 0),
  "mach" = CASE
    WHEN m."speed_of_sound" IS NOT NULL AND m."speed_of_sound" > 0
      THEN ((b."reynolds"::double precision * m."kinematic_viscosity") / NULLIF(b."reference_chord_m", 0)) / m."speed_of_sound"
    ELSE b."mach"
  END
FROM "mediums" m
WHERE b."medium_id" = m."id";--> statement-breakpoint
ALTER TABLE "boundary_conditions" ALTER COLUMN "temperature_k" SET DEFAULT 288.15;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ALTER COLUMN "temperature_k" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ALTER COLUMN "speed_mps" SET DEFAULT 50;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ALTER COLUMN "speed_mps" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ALTER COLUMN "density" SET DEFAULT 1.225;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ALTER COLUMN "density" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ALTER COLUMN "dynamic_viscosity" SET DEFAULT 1.789e-5;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ALTER COLUMN "dynamic_viscosity" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ALTER COLUMN "kinematic_viscosity" SET DEFAULT 1.46e-5;--> statement-breakpoint
ALTER TABLE "boundary_conditions" ALTER COLUMN "kinematic_viscosity" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_jobs" ADD CONSTRAINT "sim_jobs_parent_job_id_sim_jobs_id_fk" FOREIGN KEY ("parent_job_id") REFERENCES "public"."sim_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_jobs_parent_job_idx" ON "sim_jobs" USING btree ("parent_job_id");
