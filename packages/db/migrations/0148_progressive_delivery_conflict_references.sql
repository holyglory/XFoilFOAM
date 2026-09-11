ALTER TABLE progressive_worker_delivery_failures
  ADD COLUMN remote_conflict_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT progressive_worker_delivery_failures_conflict_ids_check
    CHECK (jsonb_typeof(remote_conflict_ids) = 'array' AND jsonb_array_length(remote_conflict_ids) <= 128
      AND (state = 'conflict' OR remote_conflict_ids = '[]'::jsonb));
