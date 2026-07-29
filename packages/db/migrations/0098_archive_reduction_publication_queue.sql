-- The raw URANS attempt is a completed physical result before its immutable
-- GCS archive has been reduced into publishable coefficients.  Keep that
-- publication work in a distinct, globally-deduplicated queue rather than
-- manufacturing a terminal failed/rejected result or creating a new backfill
-- run on every sweeper tick.
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "result_archive_reduction_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid NOT NULL REFERENCES "results"("id") ON DELETE CASCADE,
  "result_attempt_id" uuid NOT NULL,
  "source_archive_id" uuid NOT NULL,
  "reducer_version_id" uuid NOT NULL
    REFERENCES "result_reducer_versions"("id") ON DELETE RESTRICT,
  "state" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "claim_token" uuid,
  "claim_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "backfill_run_id" uuid
    REFERENCES "result_interpretation_backfill_runs"("id") ON DELETE RESTRICT,
  "result_interpretation_id" uuid,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "result_archive_reduction_queue_attempt_owner_fk"
    FOREIGN KEY ("result_attempt_id", "result_id")
    REFERENCES "result_attempts"("id", "result_id") ON DELETE CASCADE,
  CONSTRAINT "result_archive_reduction_queue_archive_owner_fk"
    FOREIGN KEY ("source_archive_id", "result_attempt_id")
    REFERENCES "solver_evidence_archives"("id", "result_attempt_id") ON DELETE RESTRICT,
  CONSTRAINT "result_archive_reduction_queue_interpretation_owner_fk"
    FOREIGN KEY ("result_interpretation_id", "result_attempt_id", "result_id")
    REFERENCES "result_interpretations"("id", "result_attempt_id", "result_id") ON DELETE RESTRICT,
  CONSTRAINT "result_archive_reduction_queue_state_check"
    CHECK ("state" IN ('pending', 'hydrating', 'reduced', 'superseded', 'missing_evidence', 'continuation_required', 'rerun_required', 'terminal_failure', 'failed')),
  CONSTRAINT "result_archive_reduction_queue_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "result_archive_reduction_queue_lease_shape_check"
    CHECK ((
      "state" = 'hydrating'
      AND "claim_token" IS NOT NULL
      AND "claim_expires_at" IS NOT NULL
    ) OR (
      "state" <> 'hydrating'
      AND "claim_token" IS NULL
      AND "claim_expires_at" IS NULL
    )),
  CONSTRAINT "result_archive_reduction_queue_reduced_shape_check"
    CHECK ("state" <> 'reduced' OR "result_interpretation_id" IS NOT NULL)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "result_archive_reduction_queue_identity_uq"
  ON "result_archive_reduction_queue" (
    "result_attempt_id", "source_archive_id", "reducer_version_id"
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_archive_reduction_queue_ready_idx"
  ON "result_archive_reduction_queue" ("state", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_archive_reduction_queue_lease_idx"
  ON "result_archive_reduction_queue" ("state", "claim_expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_archive_reduction_queue_result_idx"
  ON "result_archive_reduction_queue" ("result_id", "state");
--> statement-breakpoint

ALTER TABLE "sim_campaign_progress"
  ADD COLUMN IF NOT EXISTS "awaiting_archive_reduction" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "sim_campaign_progress"
  DROP CONSTRAINT IF EXISTS "sim_campaign_progress_remediation_nonnegative_check";
--> statement-breakpoint
ALTER TABLE "sim_campaign_progress"
  ADD CONSTRAINT "sim_campaign_progress_remediation_nonnegative_check"
  CHECK (
    "precalc_mesh_repairing" >= 0
    AND "awaiting_archive_reduction" >= 0
    AND "blocked_mesh_quality" >= 0
    AND "blocked_precalc_exhausted" >= 0
    AND "blocked_engine_submit" >= 0
    AND "blocked_other" >= 0
  );
