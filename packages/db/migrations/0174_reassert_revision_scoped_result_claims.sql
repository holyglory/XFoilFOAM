DROP INDEX IF EXISTS results_natural_uq;
DROP INDEX IF EXISTS results_revision_natural_uq;
CREATE UNIQUE INDEX results_revision_natural_uq
  ON results (airfoil_id, simulation_preset_revision_id, aoa_deg);
