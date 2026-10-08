ALTER TABLE progressive_worker_assignment_cursors
  ADD COLUMN cycle_started_at timestamptz,
  ADD COLUMN after_created_at timestamptz;

CREATE INDEX progressive_remote_dispatches_solver_created_idx
  ON progressive_remote_dispatches (solver_id, created_at DESC, sim_job_id DESC);
