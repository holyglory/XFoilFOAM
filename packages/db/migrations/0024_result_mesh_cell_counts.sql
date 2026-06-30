ALTER TABLE "public"."results" ADD COLUMN IF NOT EXISTS "n_cells" integer;--> statement-breakpoint
ALTER TABLE "public"."result_attempts" ADD COLUMN IF NOT EXISTS "n_cells" integer;--> statement-breakpoint
