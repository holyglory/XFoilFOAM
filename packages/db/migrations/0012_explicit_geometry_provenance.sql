ALTER TABLE "public"."airfoils"
ALTER COLUMN "source" SET DEFAULT 'naca-analytic';--> statement-breakpoint

UPDATE "public"."airfoils"
SET "source" = 'naca-analytic'
WHERE "source" = 'naca-generated';--> statement-breakpoint
