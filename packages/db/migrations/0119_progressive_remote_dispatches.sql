CREATE TABLE progressive_remote_dispatches (
  sim_job_id uuid PRIMARY KEY REFERENCES sim_jobs(id) ON DELETE RESTRICT,
  promise_id uuid NOT NULL UNIQUE REFERENCES sync_sweep_promises(id) ON DELETE RESTRICT,
  solver_id uuid NOT NULL REFERENCES registered_remote_solvers(id) ON DELETE RESTRICT,
  cpu_slots integer NOT NULL CHECK (cpu_slots > 0),
  content_signature text NOT NULL CHECK (content_signature ~ '^[a-f0-9]{64}$'),
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (coalesce(jsonb_typeof(envelope) = 'object'
    AND envelope->>'version' = '1'
    AND envelope->>'solverId' = solver_id::text
    AND envelope->>'promiseId' = promise_id::text
    AND envelope->>'contentSignature' = content_signature
    AND envelope#>>'{scope,executionId}' = sim_job_id::text
    AND envelope#>>'{request,execution_id}' = sim_job_id::text, false))
);
CREATE INDEX progressive_remote_dispatches_solver_idx ON progressive_remote_dispatches(solver_id);
CREATE TRIGGER progressive_remote_dispatches_immutable BEFORE UPDATE ON progressive_remote_dispatches
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
