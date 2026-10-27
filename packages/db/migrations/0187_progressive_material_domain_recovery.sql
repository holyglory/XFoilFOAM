ALTER TABLE progressive_cfd_recovery_plans
  DROP CONSTRAINT progressive_cfd_recovery_plans_reason_check;
ALTER TABLE progressive_cfd_recovery_plans
  ADD CONSTRAINT progressive_cfd_recovery_plans_reason_check
  CHECK (reason IN ('hard_solver', 'needs_urans', 'material_domain', 'accepted_precalc'));
