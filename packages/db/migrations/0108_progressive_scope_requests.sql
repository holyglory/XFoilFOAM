CREATE TABLE progressive_scope_requests (
  campaign_id uuid PRIMARY KEY REFERENCES sim_campaigns(id) ON DELETE CASCADE,
  requested_version bigint NOT NULL DEFAULT 1,
  processed_version bigint NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  error text,
  generation_id uuid REFERENCES progressive_generations(id) ON DELETE SET NULL,
  CHECK (requested_version > 0 AND processed_version >= 0 AND processed_version <= requested_version)
);
CREATE INDEX progressive_scope_requests_pending_idx ON progressive_scope_requests (requested_at)
WHERE requested_version > processed_version;
--> statement-breakpoint
CREATE FUNCTION enqueue_progressive_campaign_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_campaign uuid;
BEGIN
  IF TG_TABLE_NAME = 'sim_campaigns' THEN
    IF NEW.current_plan_revision_id IS NULL THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND NEW.current_plan_revision_id IS NOT DISTINCT FROM OLD.current_plan_revision_id
      AND NOT (OLD.status IS DISTINCT FROM NEW.status AND
        (OLD.status IN ('archived', 'cancelled') OR NEW.status IN ('archived', 'cancelled')))
      THEN RETURN NEW; END IF;
    target_campaign := NEW.id;
  ELSE
    target_campaign := NEW.campaign_id;
  END IF;
  INSERT INTO progressive_scope_requests (campaign_id) VALUES (target_campaign)
  ON CONFLICT (campaign_id) DO UPDATE SET requested_version = progressive_scope_requests.requested_version + 1,
    requested_at = clock_timestamp(), error = NULL;
  PERFORM pg_notify('progressive_work_changed', '');
  RETURN NEW;
END $$;
CREATE TRIGGER progressive_campaign_plan_changed AFTER INSERT OR UPDATE OF current_plan_revision_id, status ON sim_campaigns
FOR EACH ROW EXECUTE FUNCTION enqueue_progressive_campaign_scope();
CREATE TRIGGER progressive_campaign_profile_added AFTER INSERT ON sim_campaign_airfoils
FOR EACH ROW EXECUTE FUNCTION enqueue_progressive_campaign_scope();
--> statement-breakpoint
CREATE FUNCTION enqueue_progressive_epoch_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current THEN
    INSERT INTO progressive_scope_requests (campaign_id)
    SELECT id FROM sim_campaigns WHERE current_plan_revision_id IS NOT NULL
    ON CONFLICT (campaign_id) DO UPDATE SET requested_version = progressive_scope_requests.requested_version + 1,
      requested_at = clock_timestamp(), error = NULL;
    PERFORM pg_notify('progressive_work_changed', '');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER progressive_epoch_started AFTER INSERT ON calculation_epochs
FOR EACH ROW EXECUTE FUNCTION enqueue_progressive_epoch_scope();
CREATE FUNCTION notify_progressive_work_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('progressive_work_changed', '');
  RETURN NULL;
END $$;
CREATE TRIGGER progressive_work_changed AFTER INSERT OR UPDATE ON progressive_work
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_work_changed();
CREATE TRIGGER progressive_admission_changed AFTER INSERT OR UPDATE OF enabled ON sweeper_state
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_work_changed();
CREATE TRIGGER progressive_campaign_lifecycle_changed AFTER UPDATE OF status ON sim_campaigns
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_work_changed();
CREATE TRIGGER progressive_role_changed AFTER UPDATE OF remote_solver_enabled ON sync_api_settings
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_work_changed();
INSERT INTO progressive_scope_requests (campaign_id)
SELECT id FROM sim_campaigns WHERE current_plan_revision_id IS NOT NULL;
