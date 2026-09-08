CREATE FUNCTION invalidate_progressive_fit_quality() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_identity jsonb; current_identity jsonb; scope record;
BEGIN
  previous_identity := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END;
  current_identity := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END;
  IF TG_OP = 'UPDATE' AND previous_identity = current_identity THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'result_classifications' AND
    jsonb_build_array(previous_identity->'result_attempt_id', previous_identity->'state', previous_identity->'reasons', previous_identity->'classifier_version') =
    jsonb_build_array(current_identity->'result_attempt_id', current_identity->'state', current_identity->'reasons', current_identity->'classifier_version') THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'result_review_verdicts' AND
    jsonb_build_array(previous_identity->'result_id', previous_identity->'verdict', previous_identity->'revokedAt') =
    jsonb_build_array(current_identity->'result_id', current_identity->'verdict', current_identity->'revokedAt') THEN RETURN NULL; END IF;
  FOR scope IN
    SELECT DISTINCT work.target_id, generation.epoch_id FROM progressive_cfd_evidence receipt
    JOIN result_attempts evidence ON evidence.id = receipt.result_attempt_id
    JOIN progressive_cfd_attempts attempt ON attempt.token = receipt.attempt_token
    JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
    JOIN progressive_work work ON work.id = unit.work_id
    JOIN progressive_generations generation ON generation.id = work.generation_id
    WHERE (TG_TABLE_NAME = 'result_review_verdicts' AND evidence.result_id::text IN (
      previous_identity->>'result_id', current_identity->>'result_id'))
      OR (TG_TABLE_NAME <> 'result_review_verdicts' AND evidence.id::text IN (
        previous_identity->>'result_attempt_id', current_identity->>'result_attempt_id'))
  LOOP PERFORM invalidate_progressive_polar_target(scope.target_id, scope.epoch_id); END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER progressive_fit_classification_changed AFTER INSERT OR UPDATE OR DELETE ON result_classifications
FOR EACH ROW EXECUTE FUNCTION invalidate_progressive_fit_quality();
CREATE TRIGGER progressive_fit_review_changed AFTER INSERT OR UPDATE OR DELETE ON result_review_verdicts
FOR EACH ROW EXECUTE FUNCTION invalidate_progressive_fit_quality();
CREATE TRIGGER progressive_fit_interpretation_changed AFTER INSERT OR UPDATE OR DELETE ON result_interpretations
FOR EACH ROW EXECUTE FUNCTION invalidate_progressive_fit_quality();
