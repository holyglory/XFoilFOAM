ALTER TABLE progressive_cfd_recovery_plans
  ADD COLUMN active_budget_seconds double precision;

UPDATE progressive_cfd_recovery_plans
SET active_budget_seconds = CASE
  WHEN recipe->>'uransFidelity' = 'precalc' THEN 14400
  ELSE 43200
END
WHERE active_budget_seconds IS NULL;

ALTER TABLE progressive_cfd_recovery_plans
  ALTER COLUMN active_budget_seconds SET NOT NULL;

ALTER TABLE progressive_cfd_recovery_plans
  ADD CONSTRAINT progressive_cfd_recovery_plans_active_budget_seconds_check
  CHECK (active_budget_seconds > 0 AND active_budget_seconds <= 43200);
