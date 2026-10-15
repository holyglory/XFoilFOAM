CREATE INDEX IF NOT EXISTS progressive_generation_targets_target_generation_idx
  ON progressive_generation_targets (target_id, generation_id);
