-- Worker custody selectors must not read every large HUB request payload just
-- to discover that no remote-worker jobs exist. Keep disabled-worker draining
-- available: this index classifies rows, not the current deployment role.
CREATE INDEX sim_jobs_remote_worker_identity_idx
  ON sim_jobs ((request_payload->>'upstreamBaseUrl'), (request_payload->>'syncPromiseId'), id)
  WHERE request_payload->>'remoteSolver' = 'true';
