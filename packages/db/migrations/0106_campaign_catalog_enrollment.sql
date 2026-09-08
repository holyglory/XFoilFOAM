CREATE TABLE "catalog_profile_events" (
  "airfoil_id" uuid PRIMARY KEY REFERENCES "airfoils"("id") ON DELETE CASCADE,
  "registered_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE INDEX "catalog_profile_events_registered_idx" ON "catalog_profile_events" ("registered_at", "airfoil_id");
--> statement-breakpoint
INSERT INTO "catalog_profile_events" ("airfoil_id", "registered_at")
SELECT "id", "createdAt" FROM "airfoils";
--> statement-breakpoint
CREATE TABLE "campaign_catalog_boundaries" (
  "campaign_id" uuid PRIMARY KEY REFERENCES "sim_campaigns"("id") ON DELETE CASCADE,
  "opened_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
INSERT INTO "campaign_catalog_boundaries" ("campaign_id", "opened_at")
SELECT "id", "createdAt" FROM "sim_campaigns";
--> statement-breakpoint
CREATE TABLE "campaign_catalog_snapshot" (
  "campaign_id" uuid NOT NULL REFERENCES "sim_campaigns"("id") ON DELETE CASCADE,
  "airfoil_id" uuid NOT NULL REFERENCES "airfoils"("id") ON DELETE CASCADE,
  PRIMARY KEY ("campaign_id", "airfoil_id")
);
--> statement-breakpoint
INSERT INTO "campaign_catalog_snapshot" ("campaign_id", "airfoil_id")
SELECT boundary.campaign_id, event.airfoil_id
FROM campaign_catalog_boundaries boundary
JOIN catalog_profile_events event ON event.registered_at <= boundary.opened_at;
--> statement-breakpoint
CREATE TABLE "campaign_profile_expansions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaign_id" uuid NOT NULL REFERENCES "sim_campaigns"("id") ON DELETE CASCADE,
  "airfoil_ids" uuid[] NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "campaign_profile_expansions_nonempty" CHECK (cardinality("airfoil_ids") > 0)
);
--> statement-breakpoint
CREATE INDEX "campaign_profile_expansions_campaign_idx" ON "campaign_profile_expansions" ("campaign_id", "createdAt");
--> statement-breakpoint
CREATE TABLE "campaign_condition_scopes" (
  "condition_id" uuid PRIMARY KEY REFERENCES "sim_campaign_conditions"("id") ON DELETE CASCADE,
  "angles" double precision[] NOT NULL,
  "source_plan_revision_id" uuid NOT NULL REFERENCES "sim_campaign_plan_revisions"("id"),
  CONSTRAINT "campaign_condition_scopes_finite" CHECK (
    NOT "angles" && ARRAY['NaN'::float8, 'Infinity'::float8, '-Infinity'::float8]
  )
);
--> statement-breakpoint
INSERT INTO "campaign_condition_scopes" ("condition_id", "angles", "source_plan_revision_id")
SELECT condition.id,
       coalesce(array_agg(DISTINCT point.aoa_deg ORDER BY point.aoa_deg)
         FILTER (WHERE point.aoa_deg IS NOT NULL AND point.state <> 'released'), '{}'::float8[]),
       coalesce(condition.status_changed_in_plan_revision_id, condition.introduced_in_plan_revision_id)
FROM sim_campaign_conditions condition
LEFT JOIN sim_campaign_points point ON point.condition_id = condition.id
WHERE condition.status = 'kept'
GROUP BY condition.id;
--> statement-breakpoint
CREATE FUNCTION record_catalog_profile_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.catalog_profile_events (airfoil_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER catalog_profile_inserted AFTER INSERT ON airfoils
FOR EACH ROW EXECUTE FUNCTION record_catalog_profile_event();
--> statement-breakpoint
CREATE FUNCTION record_campaign_catalog_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.campaign_catalog_boundaries (campaign_id) VALUES (NEW.id);
  INSERT INTO public.campaign_catalog_snapshot (campaign_id, airfoil_id)
  SELECT NEW.id, airfoil_id FROM public.catalog_profile_events;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER campaign_catalog_opened AFTER INSERT ON sim_campaigns
FOR EACH ROW EXECUTE FUNCTION record_campaign_catalog_boundary();
