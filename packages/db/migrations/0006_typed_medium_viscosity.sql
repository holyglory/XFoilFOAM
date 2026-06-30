ALTER TABLE "mediums" ADD COLUMN "constant_dynamic_viscosity" double precision;
ALTER TABLE "mediums" ADD COLUMN "sutherland_mu_ref" double precision;
ALTER TABLE "mediums" ADD COLUMN "sutherland_t_ref" double precision;
ALTER TABLE "mediums" ADD COLUMN "sutherland_s" double precision;

CREATE TABLE IF NOT EXISTS "medium_viscosity_table_points" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "medium_id" uuid NOT NULL,
  "temperature_k" double precision NOT NULL,
  "dynamic_viscosity" double precision NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "medium_viscosity_table_points"
  ADD CONSTRAINT "medium_viscosity_table_points_medium_id_mediums_id_fk"
  FOREIGN KEY ("medium_id") REFERENCES "public"."mediums"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "medium_viscosity_points_medium_idx"
  ON "medium_viscosity_table_points" USING btree ("medium_id");
CREATE UNIQUE INDEX IF NOT EXISTS "medium_viscosity_points_order_uq"
  ON "medium_viscosity_table_points" USING btree ("medium_id", "sort_order");

UPDATE "mediums"
SET "constant_dynamic_viscosity" = NULLIF("viscosity_params"->>'mu', '')::double precision
WHERE "viscosity_model" = 'constant';

UPDATE "mediums"
SET
  "sutherland_mu_ref" = NULLIF("viscosity_params"->>'muRef', '')::double precision,
  "sutherland_t_ref" = NULLIF("viscosity_params"->>'tRef', '')::double precision,
  "sutherland_s" = NULLIF("viscosity_params"->>'s', '')::double precision
WHERE "viscosity_model" = 'sutherland';

INSERT INTO "medium_viscosity_table_points" (
  "medium_id",
  "temperature_k",
  "dynamic_viscosity",
  "sort_order"
)
SELECT
  m."id",
  temps."value"::text::double precision,
  mus."value"::text::double precision,
  temps."ordinality"::integer - 1
FROM "mediums" m
CROSS JOIN LATERAL jsonb_array_elements(m."viscosity_params"->'tempsK') WITH ORDINALITY AS temps("value", "ordinality")
JOIN LATERAL jsonb_array_elements(m."viscosity_params"->'mu') WITH ORDINALITY AS mus("value", "ordinality")
  ON mus."ordinality" = temps."ordinality"
WHERE m."viscosity_model" = 'table';

ALTER TABLE "mediums" DROP COLUMN "viscosity_params";
