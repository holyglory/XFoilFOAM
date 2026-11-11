-- Recovery provenance is execution metadata. A diagnostic never becomes a CFD result.
-- diagnostic_signature pins the exact diagnostic reference and its complete
-- retained history; physical plans keep their existing evidence-payload hash.
ALTER TABLE progressive_cfd_recovery_plans
  ALTER COLUMN diagnostic_attempt_id DROP NOT NULL,
  ADD COLUMN diagnostic_point_content_signature text,
  ADD CONSTRAINT progressive_cfd_recovery_plans_diagnostic_source_fk
    FOREIGN KEY (parent_job_id, diagnostic_point_content_signature)
    REFERENCES progressive_remote_diagnostic_receipts(sim_job_id, point_content_signature) ON DELETE CASCADE,
  ADD CONSTRAINT progressive_cfd_recovery_plans_diagnostic_source_check
    CHECK ((diagnostic_attempt_id IS NOT NULL) <> (diagnostic_point_content_signature IS NOT NULL)),
  ADD CONSTRAINT progressive_cfd_recovery_plans_diagnostic_receipt_check
    CHECK (diagnostic_point_content_signature IS NULL OR
      (diagnostic_point_content_signature ~ '^[a-f0-9]{64}$'
        AND ordinal = 1 AND scope = 'original_sweep' AND reason = 'hard_solver'));
