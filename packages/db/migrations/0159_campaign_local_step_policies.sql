CREATE TABLE campaign_local_step_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
  campaign_id uuid NOT NULL REFERENCES sim_campaigns(id) ON DELETE CASCADE,
  plan_revision_id uuid NOT NULL REFERENCES sim_campaign_plan_revisions(id) ON DELETE CASCADE,
  smoothing double precision NOT NULL CHECK (smoothing BETWEEN 0 AND 1),
  source text NOT NULL CHECK (source IN ('default', 'adopted', 'inherited')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX campaign_local_step_policies_current_idx
  ON campaign_local_step_policies(campaign_id, plan_revision_id, sequence DESC);

CREATE TABLE progressive_cfd_local_step_claims (
  attempt_token uuid PRIMARY KEY REFERENCES progressive_cfd_attempts(token) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES campaign_local_step_policies(id)
);
CREATE INDEX progressive_cfd_local_step_claims_policy_idx
  ON progressive_cfd_local_step_claims(policy_id);
