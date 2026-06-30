CREATE TABLE "airfoil_hashtags" (
	"airfoil_id" uuid NOT NULL,
	"hashtag_id" uuid NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airfoil_hashtags_airfoil_id_hashtag_id_pk" PRIMARY KEY("airfoil_id","hashtag_id")
);
--> statement-breakpoint
CREATE TABLE "hashtags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hashtags_slug_uq" ON "hashtags" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "airfoils" ADD COLUMN "area_profile" double precision;--> statement-breakpoint
ALTER TABLE "airfoils" ADD COLUMN "area_upper_positive" double precision;--> statement-breakpoint
ALTER TABLE "airfoils" ADD COLUMN "area_upper_negative" double precision;--> statement-breakpoint
ALTER TABLE "airfoils" ADD COLUMN "area_lower_positive" double precision;--> statement-breakpoint
ALTER TABLE "airfoils" ADD COLUMN "area_lower_negative" double precision;--> statement-breakpoint
ALTER TABLE "airfoils" ADD COLUMN "area_camber_positive" double precision;--> statement-breakpoint
ALTER TABLE "airfoils" ADD COLUMN "area_camber_negative" double precision;--> statement-breakpoint
ALTER TABLE "airfoils" ADD COLUMN "archivedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "airfoils" ADD COLUMN "deletedAt" timestamp with time zone;--> statement-breakpoint
UPDATE "airfoils"
SET
  "area_profile" = COALESCE("area_upper", 0) - COALESCE("area_lower", 0),
  "area_upper_positive" = GREATEST(COALESCE("area_upper", 0), 0),
  "area_upper_negative" = LEAST(COALESCE("area_upper", 0), 0),
  "area_lower_positive" = GREATEST(COALESCE("area_lower", 0), 0),
  "area_lower_negative" = LEAST(COALESCE("area_lower", 0), 0),
  "area_camber_positive" = GREATEST(COALESCE("area_camber", 0), 0),
  "area_camber_negative" = LEAST(COALESCE("area_camber", 0), 0);--> statement-breakpoint
WITH raw_tags AS (
  SELECT DISTINCT
    tag AS name,
    COALESCE(
      NULLIF(trim(both '-' from lower(regexp_replace(tag, '[^a-zA-Z0-9]+', '-', 'g'))), ''),
      'tag'
    ) AS slug
  FROM "airfoils", unnest("tags") AS tag
  WHERE trim(tag) <> ''
)
INSERT INTO "hashtags" ("slug", "name")
SELECT slug, min(name) AS name
FROM raw_tags
GROUP BY slug
ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "airfoil_hashtags" ("airfoil_id", "hashtag_id")
SELECT DISTINCT a."id", h."id"
FROM "airfoils" a
CROSS JOIN LATERAL unnest(a."tags") AS tag(name)
INNER JOIN "hashtags" h ON h."slug" = COALESCE(
  NULLIF(trim(both '-' from lower(regexp_replace(tag.name, '[^a-zA-Z0-9]+', '-', 'g'))), ''),
  'tag'
)
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "airfoil_hashtags" ADD CONSTRAINT "airfoil_hashtags_airfoil_id_airfoils_id_fk" FOREIGN KEY ("airfoil_id") REFERENCES "public"."airfoils"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airfoil_hashtags" ADD CONSTRAINT "airfoil_hashtags_hashtag_id_hashtags_id_fk" FOREIGN KEY ("hashtag_id") REFERENCES "public"."hashtags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "airfoil_hashtags_hashtag_idx" ON "airfoil_hashtags" USING btree ("hashtag_id");--> statement-breakpoint
CREATE INDEX "hashtags_name_idx" ON "hashtags" USING btree ("name");--> statement-breakpoint
CREATE INDEX "airfoils_archived_idx" ON "airfoils" USING btree ("archivedAt");--> statement-breakpoint
CREATE INDEX "airfoils_deleted_idx" ON "airfoils" USING btree ("deletedAt");
