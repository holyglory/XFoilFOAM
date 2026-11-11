-- Deployment stops the Node writers before this transactional migration.
-- Rebuild even a present index: interrupted concurrent incident removal can
-- leave it invalid, which CREATE IF NOT EXISTS would silently preserve.
DROP INDEX IF EXISTS sim_jobs_remote_worker_identity_idx;
CREATE INDEX sim_jobs_remote_worker_identity_idx
  ON sim_jobs ((request_payload->>'upstreamBaseUrl'), (request_payload->>'syncPromiseId'), id)
  WHERE request_payload->>'remoteSolver' = 'true';
