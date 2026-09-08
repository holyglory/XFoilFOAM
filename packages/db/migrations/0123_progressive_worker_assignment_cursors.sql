CREATE TABLE progressive_worker_assignment_cursors (
  settings_id integer PRIMARY KEY REFERENCES sync_api_settings(id) ON DELETE CASCADE,
  solver_id uuid NOT NULL,
  upstream_base_url text NOT NULL,
  after_execution_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
