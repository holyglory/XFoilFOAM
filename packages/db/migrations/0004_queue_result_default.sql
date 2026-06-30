ALTER TABLE "public"."results" ALTER COLUMN "source" SET DEFAULT 'queued';--> statement-breakpoint
UPDATE "public"."results" SET "source" = 'queued' WHERE "source" = 'synthesized' AND "status" <> 'done';--> statement-breakpoint
DELETE FROM "public"."results" WHERE "source" = 'synthesized';--> statement-breakpoint
