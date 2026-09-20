ALTER TABLE solver_profiles ADD COLUMN local_time_step_smoothing double precision;
ALTER TABLE solver_profiles ADD CONSTRAINT solver_profiles_local_time_step_smoothing_check
  CHECK (local_time_step_smoothing IS NULL OR local_time_step_smoothing BETWEEN 0 AND 1);
