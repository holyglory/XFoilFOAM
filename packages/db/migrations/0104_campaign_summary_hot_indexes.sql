CREATE INDEX IF NOT EXISTS "sim_urans_verify_queue_campaigns_campaign_state_queue_idx"
  ON "sim_urans_verify_queue_campaigns" ("campaign_id", "state", "queue_id");
