CREATE TABLE progressive_cfd_evidence_reuses (
  successor_unit_id uuid PRIMARY KEY REFERENCES progressive_cfd_units(id) ON DELETE CASCADE,
  source_attempt_token uuid NOT NULL REFERENCES progressive_cfd_attempts(token),
  source_result_attempt_id uuid NOT NULL REFERENCES result_attempts(id),
  source_evidence_signature text NOT NULL,
  source_generation_id uuid NOT NULL REFERENCES progressive_generations(id),
  source_execution_recipe_id text NOT NULL REFERENCES progressive_cfd_execution_recipes(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT progressive_cfd_evidence_reuses_signature_check
    CHECK (source_evidence_signature ~ '^[a-f0-9]{64}$')
);
CREATE INDEX progressive_cfd_evidence_reuses_source_attempt_idx
  ON progressive_cfd_evidence_reuses(source_attempt_token);
CREATE INDEX progressive_cfd_evidence_reuses_source_result_idx
  ON progressive_cfd_evidence_reuses(source_result_attempt_id);
