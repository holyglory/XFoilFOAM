CREATE TABLE progressive_recipe_adoptions (
  epoch_id uuid NOT NULL REFERENCES calculation_epochs(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES sim_campaigns(id) ON DELETE CASCADE,
  plan_revision_id uuid NOT NULL REFERENCES sim_campaign_plan_revisions(id),
  policy text NOT NULL,
  previous_generation_ids uuid[] NOT NULL,
  generation_id uuid NOT NULL REFERENCES progressive_generations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (epoch_id, campaign_id, plan_revision_id, policy),
  CHECK (cardinality(previous_generation_ids) > 0)
);
CREATE TRIGGER progressive_recipe_adoptions_immutable BEFORE UPDATE ON progressive_recipe_adoptions
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
