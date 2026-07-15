-- Persist the scheduler's measured storage-admission gate so every admin
-- surface can distinguish "enabled but protecting PostgreSQL" from a paused,
-- dead, or healthy scheduler. Metrics are nullable when the engine disk probe
-- is unavailable; the blocked flag and reason remain truthful in that case.
ALTER TABLE "sweeper_state"
  ADD COLUMN IF NOT EXISTS "disk_admission_blocked" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "disk_admission_reason" text,
  ADD COLUMN IF NOT EXISTS "disk_used_pct" double precision,
  ADD COLUMN IF NOT EXISTS "disk_free_bytes" bigint,
  ADD COLUMN IF NOT EXISTS "disk_required_free_bytes" bigint,
  ADD COLUMN IF NOT EXISTS "disk_checked_at" timestamp with time zone;
