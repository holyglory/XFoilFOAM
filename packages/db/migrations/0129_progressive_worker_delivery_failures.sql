CREATE TABLE progressive_worker_delivery_failures (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  result_attempt_id uuid NOT NULL,
  point_content_signature text NOT NULL CHECK (point_content_signature ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('retry', 'conflict')),
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  retry_after timestamptz,
  last_http_status integer CHECK (last_http_status BETWEEN 100 AND 599),
  last_error text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sim_job_id, point_content_signature),
  FOREIGN KEY (sim_job_id, sequence, result_attempt_id)
    REFERENCES progressive_worker_evidence_attempts(sim_job_id, sequence, result_attempt_id) ON DELETE CASCADE,
  CHECK ((state = 'retry' AND retry_after IS NOT NULL) OR (state = 'conflict' AND retry_after IS NULL))
);
