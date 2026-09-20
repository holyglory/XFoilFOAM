ALTER TABLE progressive_cfd_units
  DROP CONSTRAINT progressive_cfd_units_attempts_check;

ALTER TABLE progressive_cfd_units
  ADD CONSTRAINT progressive_cfd_units_attempts_check
  CHECK (attempts BETWEEN 0 AND 4);
