ALTER TABLE mediums ADD COLUMN gas_thermodynamics jsonb;
ALTER TABLE mediums ADD CONSTRAINT mediums_gas_thermodynamics_phase_check
  CHECK (gas_thermodynamics IS NULL OR (phase = 'gas' AND jsonb_typeof(gas_thermodynamics) = 'object'));
