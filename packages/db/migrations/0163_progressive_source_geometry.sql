CREATE TABLE progressive_polar_geometry_verifications (
  model_id text NOT NULL REFERENCES progressive_polar_models(id) ON DELETE CASCADE,
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  source_geometry_compatible boolean NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (model_id, policy_version)
);
CREATE TRIGGER progressive_polar_geometry_verifications_immutable
BEFORE UPDATE ON progressive_polar_geometry_verifications
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
--> statement-breakpoint
CREATE FUNCTION polar_geometry_requires_preservation(geometry jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  point jsonb;
  first_point jsonb;
  last_point jsonb;
  leading_point jsonb;
  chord_squared numeric;
  gap_squared numeric;
BEGIN
  IF jsonb_typeof(geometry) IS DISTINCT FROM 'array' THEN
    RETURN NULL;
  END IF;
  IF jsonb_array_length(geometry) < 3 THEN
    RETURN NULL;
  END IF;
  FOR point IN SELECT value FROM jsonb_array_elements(geometry) LOOP
    IF jsonb_typeof(point) IS DISTINCT FROM 'array' THEN
      RETURN NULL;
    END IF;
    IF jsonb_array_length(point) <> 2
      OR jsonb_typeof(point->0) <> 'number' OR jsonb_typeof(point->1) <> 'number' THEN
      RETURN NULL;
    END IF;
    IF leading_point IS NULL OR (point->>0)::numeric < (leading_point->>0)::numeric THEN
      leading_point := point;
    END IF;
  END LOOP;
  first_point := geometry->0;
  last_point := geometry->-1;
  chord_squared := power(((first_point->>0)::numeric + (last_point->>0)::numeric) / 2 - (leading_point->>0)::numeric, 2)
    + power(((first_point->>1)::numeric + (last_point->>1)::numeric) / 2 - (leading_point->>1)::numeric, 2);
  IF chord_squared <= 0 THEN
    RETURN NULL;
  END IF;
  gap_squared := power((first_point->>0)::numeric - (last_point->>0)::numeric, 2)
    + power((first_point->>1)::numeric - (last_point->>1)::numeric, 2);
  RETURN gap_squared > chord_squared * 1e-20;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION progressive_preserves_source_geometry(payload jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(payload->'mesh_recovery_version') = 'number' THEN
    (payload->>'mesh_recovery_version')::numeric BETWEEN 3 AND 2147483647
      AND trunc((payload->>'mesh_recovery_version')::numeric) = (payload->>'mesh_recovery_version')::numeric
    ELSE false END
$$;
--> statement-breakpoint
WITH published AS MATERIALIZED (
  SELECT DISTINCT coalesce(model_id, policy_refresh_model_id) AS id
  FROM progressive_polar_fit_work
  WHERE coalesce(model_id, policy_refresh_model_id) IS NOT NULL
), target_shapes AS MATERIALIZED (
  SELECT DISTINCT target.id, target.physical->'geometry' AS geometry
  FROM published
  JOIN progressive_polar_models model ON model.id = published.id
  JOIN neuralfoil_predictions prediction ON prediction.id = model.prediction_id
  JOIN polar_analysis_targets target ON target.id = prediction.target_id
), distinct_shapes AS MATERIALIZED (
  SELECT DISTINCT geometry FROM target_shapes
), shapes AS MATERIALIZED (
  SELECT geometry, polar_geometry_requires_preservation(geometry) AS finite_edge
  FROM distinct_shapes
), compatible AS (
  SELECT model.id
  FROM published
  JOIN progressive_polar_models model ON model.id = published.id
  JOIN neuralfoil_predictions prediction ON prediction.id = model.prediction_id
  JOIN target_shapes target ON target.id = prediction.target_id
  JOIN shapes shape ON shape.geometry = target.geometry
  WHERE shape.finite_edge IS NOT NULL AND (
    NOT shape.finite_edge OR NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(model.response#>'{estimate,contributors}') = 'array'
          THEN model.response#>'{estimate,contributors}' ELSE '[{}]'::jsonb END) contributor
      LEFT JOIN result_attempts attempt ON attempt.id = CASE
        WHEN contributor->>'attempt_id' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
          THEN (contributor->>'attempt_id')::uuid ELSE NULL END
      WHERE NOT progressive_preserves_source_geometry(attempt.evidence_payload)
    )
  )
)
INSERT INTO progressive_polar_geometry_verifications(model_id, policy_version, source_geometry_compatible)
SELECT published.id, 1, compatible.id IS NOT NULL
FROM published LEFT JOIN compatible ON compatible.id = published.id
ON CONFLICT (model_id, policy_version) DO NOTHING;
