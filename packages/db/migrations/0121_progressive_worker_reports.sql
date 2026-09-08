CREATE TABLE progressive_worker_reports (
  sim_job_id uuid NOT NULL REFERENCES sim_jobs(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  content_signature text NOT NULL CHECK (content_signature ~ '^[a-f0-9]{64}$'),
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  PRIMARY KEY (sim_job_id, sequence),
  CHECK (coalesce(jsonb_typeof(report) = 'object'
    AND report->>'version' = '1'
    AND report->>'executionId' = sim_job_id::text
    AND report->>'sequence' = sequence::text, false))
);
CREATE INDEX progressive_worker_reports_pending_idx ON progressive_worker_reports(sim_job_id, sequence)
WHERE acknowledged_at IS NULL;
CREATE FUNCTION protect_progressive_worker_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.sim_job_id, NEW.sequence, NEW.content_signature, NEW.report, NEW.created_at)
    IS DISTINCT FROM (OLD.sim_job_id, OLD.sequence, OLD.content_signature, OLD.report, OLD.created_at)
    OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at) THEN
    RAISE EXCEPTION 'Progressive worker report content and acknowledgements are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER progressive_worker_report_immutable BEFORE UPDATE ON progressive_worker_reports
FOR EACH ROW EXECUTE FUNCTION protect_progressive_worker_report();
