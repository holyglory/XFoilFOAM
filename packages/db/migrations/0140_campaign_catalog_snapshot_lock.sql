CREATE OR REPLACE FUNCTION record_campaign_catalog_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.campaign_catalog_boundaries (campaign_id) VALUES (NEW.id);
  INSERT INTO public.campaign_catalog_snapshot (campaign_id, airfoil_id)
  SELECT NEW.id, airfoil.id
  FROM public.catalog_profile_events event
  JOIN public.airfoils airfoil ON airfoil.id = event.airfoil_id
  ORDER BY airfoil.id
  FOR KEY SHARE OF airfoil;
  RETURN NEW;
END;
$$;
