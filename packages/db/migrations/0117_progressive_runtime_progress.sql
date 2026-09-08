CREATE TABLE progressive_cfd_runtime_progress (
  attempt_token uuid PRIMARY KEY REFERENCES progressive_cfd_attempts(token) ON DELETE CASCADE,
  engine_job_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  active_seconds double precision NOT NULL CHECK (active_seconds >= 0 AND active_seconds < 'Infinity'::double precision),
  limit_seconds double precision NOT NULL CHECK (limit_seconds > 0 AND limit_seconds <= 43200),
  solver_running boolean NOT NULL,
  observation jsonb NOT NULL CHECK (jsonb_typeof(observation) = 'object'),
  observation_signature text NOT NULL CHECK (observation_signature ~ '^[a-f0-9]{64}$')
);
