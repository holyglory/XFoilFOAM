-- Withdrawn during rollout. Evaluating the JSON predicate reads hundreds of GB
-- of TOAST data while holding a writer-blocking lock. Migration 0202 removes
-- the index on installations that already built it and uses metadata keys.
SELECT 1;
