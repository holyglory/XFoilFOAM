CREATE INDEX progressive_cfd_units_complete_idx
  ON progressive_cfd_units (work_id)
  WHERE state = 'complete';
