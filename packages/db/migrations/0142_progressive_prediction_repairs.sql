CREATE TABLE progressive_prediction_repairs (
  work_id uuid NOT NULL REFERENCES progressive_work(id) ON DELETE CASCADE,
  policy_version text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'complete', 'gap')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  lease_token uuid,
  lease_owner text,
  lease_until timestamptz,
  prediction_id text REFERENCES neuralfoil_predictions(id) ON DELETE CASCADE,
  error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (work_id, policy_version)
);
--> statement-breakpoint
CREATE TABLE progressive_prediction_repair_attempts (
  token uuid PRIMARY KEY,
  work_id uuid NOT NULL,
  policy_version text NOT NULL,
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'complete', 'failed', 'expired')),
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  FOREIGN KEY (work_id, policy_version) REFERENCES progressive_prediction_repairs(work_id, policy_version) ON DELETE CASCADE
);
