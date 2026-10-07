CREATE INDEX progressive_cfd_attempts_unit_lookup_idx
  ON progressive_cfd_attempts (unit_id, outcome, sim_job_id);
