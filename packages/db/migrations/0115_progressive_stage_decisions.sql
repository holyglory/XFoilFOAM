CREATE TABLE progressive_cfd_stage_decisions (
  work_id uuid NOT NULL REFERENCES progressive_work(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  kind text NOT NULL CHECK (kind IN ('adaptive', 'close_fast', 'close_precise')),
  reason text NOT NULL CHECK (length(reason) > 0),
  model_id text REFERENCES progressive_polar_models(id) ON DELETE CASCADE,
  cost_evidence_id uuid REFERENCES result_attempts(id) ON DELETE CASCADE,
  candidate_alpha double precision,
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (work_id, ordinal),
  CHECK ((kind = 'adaptive' AND candidate_alpha IS NOT NULL AND candidate_alpha > '-Infinity'::double precision
    AND candidate_alpha < 'Infinity'::double precision AND model_id IS NOT NULL AND cost_evidence_id IS NOT NULL)
    OR (kind <> 'adaptive' AND candidate_alpha IS NULL))
);
CREATE TRIGGER progressive_cfd_stage_decisions_immutable BEFORE UPDATE ON progressive_cfd_stage_decisions
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
