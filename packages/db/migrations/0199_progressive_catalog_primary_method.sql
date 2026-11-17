-- Publication choice is immutable model metadata. Derive it once alongside
-- catalog_metrics_v1 so catalog reads never detoast the full fitted response.
ALTER TABLE progressive_polar_models
  ADD COLUMN catalog_primary_method text
  GENERATED ALWAYS AS (
    coalesce(response#>>'{estimate,publication,primary_method}', 'composite')
  ) STORED;
