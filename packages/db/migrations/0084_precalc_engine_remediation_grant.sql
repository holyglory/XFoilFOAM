-- Ordinary preliminary URANS remains bounded to two physical CFD runs. A
-- proven engine/controller defect can otherwise consume both runs after
-- producing valid restartable physics but before publication. Preserve both
-- immutable attempts and permit exactly one explicitly audited remediation
-- run; never reset or relabel the historical attempts.
ALTER TABLE "sim_precalc_obligations"
  ADD COLUMN "remediation_attempts_granted" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "remediation_reason" text,
  ADD COLUMN "remediation_source_revision" text,
  ADD COLUMN "remediation_granted_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "sim_precalc_obligations"
  DROP CONSTRAINT "sim_precalc_obligations_attempt_bounds_check";
--> statement-breakpoint

ALTER TABLE "sim_precalc_obligations"
  ADD CONSTRAINT "sim_precalc_obligations_attempt_bounds_check"
  CHECK (
    "attempt_count" >= 0
    AND "remediation_attempts_granted" IN (0, 1)
    AND "max_attempts" = 2 + "remediation_attempts_granted"
    AND "attempt_count" <= "max_attempts"
  ),
  ADD CONSTRAINT "sim_precalc_obligations_remediation_shape_check"
  CHECK (
    (
      "remediation_attempts_granted" = 0
      AND "remediation_reason" IS NULL
      AND "remediation_source_revision" IS NULL
      AND "remediation_granted_at" IS NULL
    )
    OR (
      "remediation_attempts_granted" = 1
      AND btrim(COALESCE("remediation_reason", '')) <> ''
      AND COALESCE("remediation_source_revision", '') ~ '^[0-9a-f]{40}$'
      AND "remediation_granted_at" IS NOT NULL
    )
  );
--> statement-breakpoint

ALTER TABLE "sim_precalc_obligation_attempts"
  DROP CONSTRAINT "sim_precalc_obligation_attempts_solver_number_check";
--> statement-breakpoint

ALTER TABLE "sim_precalc_obligation_attempts"
  ADD CONSTRAINT "sim_precalc_obligation_attempts_solver_number_check"
  CHECK (
    "solver_attempt_number" IS NULL
    OR "solver_attempt_number" IN (1, 2, 3)
  );
