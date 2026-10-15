CREATE INDEX IF NOT EXISTS sim_jobs_remote_payload_cleanup_idx
  ON sim_jobs ("updatedAt", id)
  WHERE (
    request_payload ? 'remoteSolver'
    OR request_payload ? 'solverId'
    OR request_payload ? 'syncPromiseId'
    OR request_payload ? 'upstreamBaseUrl'
    OR request_payload ? 'remoteProgressiveExecution'
  );
