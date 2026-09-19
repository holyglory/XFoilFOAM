CREATE INDEX progressive_cfd_attempts_unstarted_idx
  ON progressive_cfd_attempts (unit_id)
  WHERE outcome = 'cancelled' AND active_seconds = 0;
