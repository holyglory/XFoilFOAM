CREATE TABLE calculation_epochs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  current boolean NOT NULL DEFAULT true,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX calculation_epochs_current_uq ON calculation_epochs (current) WHERE current;
INSERT INTO calculation_epochs (reason) VALUES ('progressive-polar initialization');
--> statement-breakpoint
CREATE TABLE polar_analysis_targets (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  airfoil_id uuid NOT NULL REFERENCES airfoils(id) ON DELETE CASCADE,
  physical jsonb NOT NULL CHECK (jsonb_typeof(physical) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX polar_analysis_targets_airfoil_idx ON polar_analysis_targets (airfoil_id);
CREATE TABLE progressive_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch_id uuid NOT NULL REFERENCES calculation_epochs(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES sim_campaigns(id) ON DELETE CASCADE,
  plan_revision_id uuid NOT NULL REFERENCES sim_campaign_plan_revisions(id),
  scope_key text NOT NULL,
  scope_signature text NOT NULL,
  stage smallint NOT NULL DEFAULT 1 CHECK (stage IN (1, 2, 3)),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'complete', 'attention', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (epoch_id, campaign_id, scope_key)
);
CREATE TABLE progressive_generation_targets (
  generation_id uuid NOT NULL REFERENCES progressive_generations(id) ON DELETE CASCADE,
  target_id text NOT NULL REFERENCES polar_analysis_targets(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES simulation_preset_revisions(id),
  angles double precision[] NOT NULL CHECK (cardinality(angles) > 0),
  recipes jsonb NOT NULL CHECK (jsonb_typeof(recipes) = 'object'),
  PRIMARY KEY (generation_id, target_id)
);
CREATE TABLE progressive_work (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL,
  target_id text NOT NULL,
  stage smallint NOT NULL CHECK (stage IN (1, 2, 3)),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'complete', 'gap')),
  lease_token uuid,
  lease_owner text,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error text,
  completed_at timestamptz,
  UNIQUE (generation_id, target_id, stage),
  FOREIGN KEY (generation_id, target_id) REFERENCES progressive_generation_targets(generation_id, target_id) ON DELETE CASCADE,
  CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX progressive_work_pending_idx ON progressive_work (generation_id, stage, state);
CREATE TABLE progressive_work_attempts (
  token uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES progressive_work(id) ON DELETE CASCADE,
  owner text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz NOT NULL,
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'complete', 'failed', 'expired', 'cancelled')),
  error text,
  finished_at timestamptz
);
CREATE UNIQUE INDEX progressive_work_attempts_running_uq ON progressive_work_attempts (work_id) WHERE outcome = 'running';
CREATE TABLE neuralfoil_predictions (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  epoch_id uuid NOT NULL REFERENCES calculation_epochs(id) ON DELETE CASCADE,
  target_id text NOT NULL REFERENCES polar_analysis_targets(id) ON DELETE CASCADE,
  payload jsonb NOT NULL CHECK (payload->>'kind' = 'prediction' AND payload->>'method' = 'neuralfoil' AND payload->>'cfd_evidence' = 'false'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX neuralfoil_predictions_target_idx ON neuralfoil_predictions (target_id, created_at DESC);
CREATE TABLE progressive_prediction_links (
  work_id uuid PRIMARY KEY REFERENCES progressive_work(id) ON DELETE CASCADE,
  prediction_id text NOT NULL REFERENCES neuralfoil_predictions(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE FUNCTION reject_progressive_artifact_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'progressive artifacts and sealed scope are immutable';
END $$;
CREATE TRIGGER polar_analysis_targets_immutable BEFORE UPDATE ON polar_analysis_targets
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
CREATE TRIGGER neuralfoil_predictions_immutable BEFORE UPDATE ON neuralfoil_predictions
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
CREATE TRIGGER progressive_generation_targets_immutable BEFORE UPDATE ON progressive_generation_targets
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
