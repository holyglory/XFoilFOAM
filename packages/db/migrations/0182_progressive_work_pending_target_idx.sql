CREATE INDEX IF NOT EXISTS progressive_work_pending_target_idx
  ON progressive_work (generation_id, stage, target_id, id)
  WHERE state = 'pending';
