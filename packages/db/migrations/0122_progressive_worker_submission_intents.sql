CREATE TABLE progressive_worker_submission_intents (
  sim_job_id uuid PRIMARY KEY REFERENCES sim_jobs(id) ON DELETE RESTRICT,
  token uuid NOT NULL UNIQUE,
  assignment_signature text NOT NULL CHECK (assignment_signature ~ '^[a-f0-9]{64}$'),
  "authorization" jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (coalesce(jsonb_typeof("authorization") = 'object'
    AND "authorization"->>'kind' = 'authorized'
    AND "authorization"->>'executionId' = sim_job_id::text
    AND "authorization"->>'contentSignature' = assignment_signature, false))
);
CREATE TRIGGER progressive_worker_submission_intents_immutable BEFORE UPDATE ON progressive_worker_submission_intents
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
