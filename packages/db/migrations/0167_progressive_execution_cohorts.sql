CREATE TABLE campaign_progressive_execution_policies (
  campaign_id uuid PRIMARY KEY REFERENCES sim_campaigns(id) ON DELETE CASCADE,
  policy text NOT NULL CHECK (policy = 'subsonic-through-precise-v1'),
  adopted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE progressive_generation_cohorts (
  generation_id uuid NOT NULL REFERENCES progressive_generations(id) ON DELETE CASCADE,
  cohort text NOT NULL CHECK (cohort IN ('low', 'high')),
  stage smallint NOT NULL DEFAULT 1 CHECK (stage IN (1, 2, 3)),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'complete', 'attention')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (generation_id, cohort)
);
CREATE TABLE progressive_generation_cohort_targets (
  generation_id uuid NOT NULL,
  target_id text NOT NULL,
  cohort text NOT NULL,
  PRIMARY KEY (generation_id, target_id),
  FOREIGN KEY (generation_id, target_id) REFERENCES progressive_generation_targets(generation_id, target_id) ON DELETE CASCADE,
  FOREIGN KEY (generation_id, cohort) REFERENCES progressive_generation_cohorts(generation_id, cohort) ON DELETE CASCADE
);
CREATE INDEX progressive_generation_cohort_targets_cohort_idx ON progressive_generation_cohort_targets(generation_id, cohort, target_id);
CREATE TRIGGER progressive_generation_cohort_target_immutable BEFORE UPDATE ON progressive_generation_cohort_targets
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
CREATE TRIGGER campaign_progressive_execution_policy_immutable BEFORE UPDATE ON campaign_progressive_execution_policies
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
CREATE TRIGGER campaign_progressive_execution_policy_changed AFTER INSERT ON campaign_progressive_execution_policies
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_work_changed();
CREATE TRIGGER progressive_generation_cohort_changed AFTER INSERT OR UPDATE ON progressive_generation_cohorts
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_work_changed();
