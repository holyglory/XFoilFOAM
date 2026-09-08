CREATE TABLE progressive_cfd_evidence (
  attempt_token uuid NOT NULL REFERENCES progressive_cfd_attempts(token) ON DELETE CASCADE,
  result_attempt_id uuid NOT NULL REFERENCES result_attempts(id) ON DELETE CASCADE,
  evidence_signature text NOT NULL CHECK (evidence_signature ~ '^[a-f0-9]{64}$'),
  solver_active_seconds double precision NOT NULL CHECK (solver_active_seconds >= 0 AND solver_active_seconds < 'Infinity'::double precision),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (attempt_token, result_attempt_id),
  UNIQUE (result_attempt_id)
);
CREATE TRIGGER progressive_cfd_evidence_immutable BEFORE UPDATE ON progressive_cfd_evidence
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
CREATE TRIGGER progressive_cfd_evidence_changed AFTER INSERT ON progressive_cfd_evidence
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_work_changed();
