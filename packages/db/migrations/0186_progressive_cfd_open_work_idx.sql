-- Custom SQL migration file, put your code below! --
CREATE INDEX IF NOT EXISTS progressive_cfd_units_open_work_idx
  ON progressive_cfd_units (work_id, state)
  WHERE state IN ('pending', 'leased', 'blocked', 'cancelled');
