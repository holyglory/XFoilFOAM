-- Execution scheduling state only. The ordinary campaign mutex serializes
-- first batch claims; a failed outer admission transaction also rolls back its
-- turn. Epoch and plan identity prevent old claim history from steering new work.
CREATE TABLE progressive_cfd_claim_turns (
  campaign_id uuid PRIMARY KEY REFERENCES sim_campaigns(id) ON DELETE CASCADE,
  epoch_id uuid NOT NULL REFERENCES calculation_epochs(id) ON DELETE CASCADE,
  plan_revision_id uuid NOT NULL REFERENCES sim_campaign_plan_revisions(id) ON DELETE CASCADE,
  last_stage smallint NOT NULL CHECK (last_stage IN (2, 3))
);
