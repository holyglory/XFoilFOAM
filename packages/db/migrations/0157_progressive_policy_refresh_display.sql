ALTER TABLE progressive_polar_fit_work
  ADD COLUMN policy_refresh_model_id text REFERENCES progressive_polar_models(id) ON DELETE SET NULL,
  ADD COLUMN policy_refresh_policy_id text;

ALTER TABLE progressive_polar_fit_work
  ADD CONSTRAINT progressive_fit_policy_refresh_pointer_check
  CHECK (policy_refresh_model_id IS NULL OR
    (state <> 'ready' AND model_id IS NULL AND policy_refresh_policy_id IS NOT NULL
      AND length(trim(policy_refresh_policy_id)) > 0));

CREATE OR REPLACE FUNCTION invalidate_progressive_polar_target(target_key text, epoch_key uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE progressive_polar_fit_work work SET source_version = source_version + 1,
    state = 'pending', lease_token = NULL, lease_owner = NULL, lease_until = NULL,
    model_id = NULL, policy_refresh_model_id = NULL, policy_refresh_policy_id = NULL,
    attempts = 0, error = NULL, updated_at = clock_timestamp()
    FROM neuralfoil_predictions prediction WHERE prediction.id = work.prediction_id
      AND prediction.target_id = target_key AND prediction.epoch_id = epoch_key;
END $$;

CREATE OR REPLACE FUNCTION invalidate_deleted_progressive_model_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE progressive_polar_fit_work SET source_version = source_version + 1, state = 'pending',
    lease_token = NULL, lease_owner = NULL, lease_until = NULL, model_id = NULL,
    policy_refresh_model_id = NULL, policy_refresh_policy_id = NULL,
    attempts = 0, error = NULL, updated_at = clock_timestamp()
    WHERE model_id = OLD.model_id OR policy_refresh_model_id = OLD.model_id;
  RETURN NULL;
END $$;
