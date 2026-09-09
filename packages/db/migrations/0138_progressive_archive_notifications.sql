CREATE FUNCTION notify_progressive_worker_archive_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('progressive_worker_archive_changed', '');
  RETURN NULL;
END $$;
CREATE TRIGGER progressive_archive_source_retained AFTER INSERT ON progressive_worker_hub_receipts
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_worker_archive_changed();
CREATE TRIGGER progressive_archive_delivery_changed AFTER INSERT OR UPDATE OR DELETE ON progressive_worker_archive_deliveries
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_worker_archive_changed();
CREATE TRIGGER progressive_archive_custody_received AFTER INSERT ON progressive_worker_archive_receipts
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_worker_archive_changed();
CREATE TRIGGER progressive_archive_settings_changed
AFTER INSERT OR UPDATE OF upstream_base_url, remote_solver_registered_id, remote_solver_auth_token, remote_solver_transfer_paused
ON sync_api_settings FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_worker_archive_changed();
