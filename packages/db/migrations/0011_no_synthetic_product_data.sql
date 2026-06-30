UPDATE "public"."airfoils"
SET
  "ref_ldmax" = NULL,
  "ref_clmax" = NULL,
  "ref_cdmin" = NULL,
  "ref_metrics_source" = 'queued'
WHERE
  "ref_ldmax" IS NOT NULL
  OR "ref_clmax" IS NOT NULL
  OR "ref_cdmin" IS NOT NULL
  OR "ref_metrics_source"::text = 'synthesized';--> statement-breakpoint

ALTER TABLE "public"."airfoils"
  ALTER COLUMN "ref_metrics_source" SET DEFAULT 'queued';--> statement-breakpoint

UPDATE "public"."results"
SET "source" = 'queued'
WHERE "source"::text = 'synthesized' AND "status" <> 'done';--> statement-breakpoint

DELETE FROM "public"."results"
WHERE "source"::text = 'synthesized';--> statement-breakpoint
