CREATE FUNCTION notify_progressive_worker_report_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('progressive_worker_report_changed', '');
  RETURN NULL;
END $$;
CREATE TRIGGER progressive_report_delivery_settings_changed
AFTER INSERT OR UPDATE OF upstream_base_url, remote_solver_registered_id, remote_solver_auth_token, remote_solver_transfer_paused
ON sync_api_settings FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_worker_report_changed();
