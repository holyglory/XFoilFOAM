CREATE TABLE progressive_remote_reports (
  sim_job_id uuid NOT NULL REFERENCES progressive_remote_dispatches(sim_job_id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  content_signature text NOT NULL CHECK (content_signature ~ '^[a-f0-9]{64}$'),
  report jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sim_job_id, sequence),
  CHECK (coalesce(jsonb_typeof(report) = 'object'
    AND report->>'version' = '1'
    AND report->>'executionId' = sim_job_id::text
    AND report->>'sequence' = sequence::text, false))
);
CREATE TRIGGER progressive_remote_reports_immutable BEFORE UPDATE ON progressive_remote_reports
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
