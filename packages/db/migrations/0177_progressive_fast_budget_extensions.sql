CREATE TABLE progressive_cfd_budget_extensions (
  unit_id uuid PRIMARY KEY REFERENCES progressive_cfd_units(id) ON DELETE CASCADE,
  source_attempt_token uuid NOT NULL UNIQUE REFERENCES progressive_cfd_attempts(token),
  source_result_attempt_id uuid NOT NULL UNIQUE REFERENCES result_attempts(id),
  source_evidence_signature text NOT NULL,
  source_engine_job_id text NOT NULL,
  source_engine_case_slug text NOT NULL,
  extension_seconds double precision NOT NULL,
  policy_version text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  claim_attempt_token uuid UNIQUE REFERENCES progressive_cfd_attempts(token),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  consumed_at timestamptz,
  CONSTRAINT progressive_cfd_budget_extensions_signature_check
    CHECK (source_evidence_signature ~ '^[a-f0-9]{64}$'),
  CONSTRAINT progressive_cfd_budget_extensions_seconds_check
    CHECK (extension_seconds > 0 AND extension_seconds <= 43200),
  CONSTRAINT progressive_cfd_budget_extensions_state_check
    CHECK (state IN ('pending', 'claimed', 'consumed', 'exhausted')),
  CONSTRAINT progressive_cfd_budget_extensions_claim_check
    CHECK ((state = 'pending' AND claim_attempt_token IS NULL AND claimed_at IS NULL AND consumed_at IS NULL)
      OR (state = 'claimed' AND claim_attempt_token IS NOT NULL AND claimed_at IS NOT NULL AND consumed_at IS NULL)
      OR (state IN ('consumed', 'exhausted') AND claim_attempt_token IS NOT NULL AND claimed_at IS NOT NULL AND consumed_at IS NOT NULL))
);
CREATE INDEX progressive_cfd_budget_extensions_pending_idx
  ON progressive_cfd_budget_extensions(state, created_at)
  WHERE state = 'pending';
