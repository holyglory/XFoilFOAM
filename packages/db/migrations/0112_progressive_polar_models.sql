CREATE TABLE progressive_polar_models (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  prediction_id text NOT NULL REFERENCES neuralfoil_predictions(id) ON DELETE CASCADE,
  source_signature text NOT NULL CHECK (source_signature ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER progressive_polar_models_immutable BEFORE UPDATE ON progressive_polar_models
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
CREATE TABLE progressive_polar_fit_work (
  prediction_id text PRIMARY KEY REFERENCES neuralfoil_predictions(id) ON DELETE CASCADE,
  source_version integer NOT NULL DEFAULT 1 CHECK (source_version > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'ready', 'gap')),
  lease_token uuid,
  lease_owner text,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  model_id text REFERENCES progressive_polar_models(id) ON DELETE SET NULL,
  error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX progressive_polar_fit_work_pending_idx ON progressive_polar_fit_work(state, updated_at);
CREATE TABLE progressive_polar_model_evidence (
  model_id text NOT NULL REFERENCES progressive_polar_models(id) ON DELETE CASCADE,
  attempt_token uuid NOT NULL,
  result_attempt_id uuid NOT NULL REFERENCES result_attempts(id) ON DELETE CASCADE,
  PRIMARY KEY(model_id, result_attempt_id),
  FOREIGN KEY(attempt_token, result_attempt_id) REFERENCES progressive_cfd_evidence(attempt_token, result_attempt_id) ON DELETE CASCADE
);
CREATE TRIGGER progressive_polar_model_evidence_immutable BEFORE UPDATE ON progressive_polar_model_evidence
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
CREATE FUNCTION invalidate_progressive_polar_target(target_key text, epoch_key uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE progressive_polar_fit_work work SET source_version = source_version + 1,
    state = 'pending', lease_token = NULL, lease_owner = NULL, lease_until = NULL,
    model_id = NULL, attempts = 0, error = NULL, updated_at = clock_timestamp()
  FROM neuralfoil_predictions prediction WHERE prediction.id = work.prediction_id
    AND prediction.target_id = target_key AND prediction.epoch_id = epoch_key;
END $$;
CREATE FUNCTION queue_progressive_prediction_fit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO progressive_polar_fit_work(prediction_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER progressive_prediction_fit_created AFTER INSERT ON neuralfoil_predictions
FOR EACH ROW EXECUTE FUNCTION queue_progressive_prediction_fit();
CREATE FUNCTION invalidate_progressive_receipt_fit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope record; receipt_token uuid;
BEGIN
  receipt_token := CASE WHEN TG_OP = 'DELETE' THEN OLD.attempt_token ELSE NEW.attempt_token END;
  SELECT work.target_id, generation.epoch_id INTO scope FROM progressive_cfd_attempts attempt
    JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
    JOIN progressive_work work ON work.id = unit.work_id
    JOIN progressive_generations generation ON generation.id = work.generation_id
    WHERE attempt.token = receipt_token;
  IF FOUND THEN PERFORM invalidate_progressive_polar_target(scope.target_id, scope.epoch_id); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER progressive_receipt_fit_changed AFTER INSERT OR DELETE ON progressive_cfd_evidence
FOR EACH ROW EXECUTE FUNCTION invalidate_progressive_receipt_fit();
CREATE FUNCTION invalidate_progressive_attempt_fit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.evidence_payload IS NOT DISTINCT FROM OLD.evidence_payload THEN RETURN NULL; END IF;
  FOR scope IN SELECT DISTINCT work.target_id, generation.epoch_id FROM progressive_cfd_evidence receipt
    JOIN progressive_cfd_attempts attempt ON attempt.token = receipt.attempt_token
    JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
    JOIN progressive_work work ON work.id = unit.work_id
    JOIN progressive_generations generation ON generation.id = work.generation_id
    WHERE receipt.result_attempt_id = OLD.id
  LOOP PERFORM invalidate_progressive_polar_target(scope.target_id, scope.epoch_id); END LOOP;
  RETURN OLD;
END $$;
CREATE TRIGGER progressive_attempt_fit_changed AFTER UPDATE OF evidence_payload ON result_attempts
FOR EACH ROW EXECUTE FUNCTION invalidate_progressive_attempt_fit();
CREATE TRIGGER progressive_attempt_fit_deleted BEFORE DELETE ON result_attempts
FOR EACH ROW EXECUTE FUNCTION invalidate_progressive_attempt_fit();
CREATE FUNCTION invalidate_deleted_progressive_model_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE progressive_polar_fit_work SET source_version = source_version + 1, state = 'pending',
    lease_token = NULL, lease_owner = NULL, lease_until = NULL, model_id = NULL, attempts = 0,
    error = NULL, updated_at = clock_timestamp() WHERE model_id = OLD.model_id;
  RETURN NULL;
END $$;
CREATE TRIGGER progressive_model_evidence_deleted AFTER DELETE ON progressive_polar_model_evidence
FOR EACH ROW EXECUTE FUNCTION invalidate_deleted_progressive_model_evidence();
CREATE TRIGGER progressive_polar_fit_work_changed AFTER INSERT OR UPDATE ON progressive_polar_fit_work
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_work_changed();
INSERT INTO progressive_polar_fit_work(prediction_id) SELECT id FROM neuralfoil_predictions;
