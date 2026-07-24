ALTER TABLE "sync_api_settings"
  ADD COLUMN IF NOT EXISTS "remote_solver_transfer_paused" boolean DEFAULT false NOT NULL;
