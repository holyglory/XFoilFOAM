CREATE INDEX IF NOT EXISTS progressive_cfd_units_initial_work_idx
  ON progressive_cfd_units (work_id, state)
  WHERE purpose = 'initial';
