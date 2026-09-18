CREATE FUNCTION public_curve_metrics_v1(angles jsonb, coefficients jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  sample_count integer;
  sample_index integer;
  sample_values jsonb;
  alpha_value double precision;
  previous_alpha double precision;
  lift_value double precision;
  drag_value double precision;
  moment_value double precision;
  ratio_value double precision;
  maximum_ratio double precision;
  maximum_lift double precision;
  minimum_drag double precision;
BEGIN
  IF jsonb_typeof(angles) IS DISTINCT FROM 'array'
    OR jsonb_typeof(coefficients) IS DISTINCT FROM 'array' THEN
    RETURN NULL;
  END IF;
  sample_count := jsonb_array_length(angles);
  IF sample_count < 2 OR jsonb_array_length(coefficients) <> sample_count THEN
    RETURN NULL;
  END IF;
  FOR sample_index IN 0..sample_count - 1 LOOP
    sample_values := coefficients->sample_index;
    IF jsonb_typeof(sample_values) IS DISTINCT FROM 'array' THEN
      RETURN NULL;
    END IF;
    IF jsonb_array_length(sample_values) <> 3
      OR jsonb_typeof(angles->sample_index) IS DISTINCT FROM 'number'
      OR jsonb_typeof(sample_values->0) IS DISTINCT FROM 'number'
      OR jsonb_typeof(sample_values->1) IS DISTINCT FROM 'number'
      OR jsonb_typeof(sample_values->2) IS DISTINCT FROM 'number' THEN
      RETURN NULL;
    END IF;
    alpha_value := (angles->>sample_index)::double precision;
    lift_value := (sample_values->>0)::double precision;
    drag_value := (sample_values->>1)::double precision;
    moment_value := (sample_values->>2)::double precision;
    IF drag_value <= 0 OR alpha_value <= previous_alpha THEN
      RETURN NULL;
    END IF;
    previous_alpha := alpha_value;
    maximum_lift := greatest(maximum_lift, lift_value);
    minimum_drag := least(minimum_drag, drag_value);
    IF lift_value > 0 THEN
      BEGIN
        ratio_value := lift_value / drag_value;
      EXCEPTION WHEN numeric_value_out_of_range THEN
        ratio_value := NULL;
      END;
      maximum_ratio := greatest(maximum_ratio, ratio_value);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ldmax', maximum_ratio, 'clmax', maximum_lift, 'cdmin', minimum_drag);
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint
ALTER TABLE polar_analysis_targets ADD COLUMN condition_group_id text
  GENERATED ALWAYS AS (encode(sha256(jsonb_send(physical - 'airfoilId' - 'geometry')), 'hex')) STORED;
--> statement-breakpoint
ALTER TABLE neuralfoil_predictions ADD COLUMN catalog_metrics_v1 jsonb
  GENERATED ALWAYS AS (public_curve_metrics_v1(payload->'alpha', payload->'coefficients')) STORED;
--> statement-breakpoint
ALTER TABLE progressive_polar_models ADD COLUMN catalog_metrics_v1 jsonb
  GENERATED ALWAYS AS (public_curve_metrics_v1(response#>'{estimate,alpha}', response#>'{estimate,curves,composite,coefficients}')) STORED,
  ADD COLUMN catalog_composite_present boolean
  GENERATED ALWAYS AS (response#>'{estimate,curves,composite}' IS NOT NULL) STORED;
--> statement-breakpoint
CREATE INDEX simulation_preset_revisions_air_catalog_idx ON simulation_preset_revisions (id)
  WHERE snapshot->'flowState'->>'mediumSlug' = 'air';
