CREATE FUNCTION notify_progressive_worker_evidence_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('progressive_worker_evidence_changed', '');
  RETURN NULL;
END $$;
CREATE TRIGGER progressive_evidence_report_acknowledged
AFTER UPDATE OF acknowledged_at ON progressive_worker_reports
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_worker_evidence_changed();
CREATE TRIGGER progressive_evidence_attempt_staged
AFTER INSERT ON progressive_worker_evidence_attempts
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_worker_evidence_changed();
CREATE TRIGGER progressive_evidence_delivery_retry_changed
AFTER INSERT OR UPDATE OR DELETE ON progressive_worker_delivery_failures
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_worker_evidence_changed();
CREATE TRIGGER progressive_evidence_ingest_lease_changed
AFTER UPDATE OF ingest_lease_expires_at ON sim_jobs
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_worker_evidence_changed();
CREATE TRIGGER progressive_evidence_delivery_settings_changed
AFTER INSERT OR UPDATE OF upstream_base_url, remote_solver_registered_id, remote_solver_auth_token, remote_solver_transfer_paused
ON sync_api_settings FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_worker_evidence_changed();
