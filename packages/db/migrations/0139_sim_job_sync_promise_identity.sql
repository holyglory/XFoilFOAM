CREATE INDEX sim_jobs_sync_promise_identity_idx ON sim_jobs ((request_payload->>'syncPromiseId'));
