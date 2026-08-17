-- Historical archive audits reduce an exact, immutable GCS archive without
-- publishing a canonical result or creating solver work.  Keep this receipt
-- append-only and physically incapable of carrying a scheduler target: any
-- later continuation/rerun must be explicitly promoted through a separately
-- authorized recovery path.
CREATE TABLE IF NOT EXISTS "historical_archive_audit_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "audit_run_id" uuid NOT NULL
    REFERENCES "result_interpretation_backfill_runs"("id") ON DELETE RESTRICT,
  "result_id" uuid NOT NULL REFERENCES "results"("id") ON DELETE CASCADE,
  "result_attempt_id" uuid NOT NULL,
  "source_archive_id" uuid NOT NULL,
  "reducer_version_id" uuid NOT NULL
    REFERENCES "result_reducer_versions"("id") ON DELETE RESTRICT,
  "input_evidence_signature" text NOT NULL,
  "reducer_state" text NOT NULL,
  "result_interpretation_id" uuid,
  "advisory_continuation_action" text,
  "advisory_tail_periods" integer,
  "diagnostics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "historical_archive_audit_decisions_attempt_owner_fk"
    FOREIGN KEY ("result_attempt_id", "result_id")
    REFERENCES "result_attempts"("id", "result_id") ON DELETE CASCADE,
  CONSTRAINT "historical_archive_audit_decisions_archive_owner_fk"
    FOREIGN KEY ("source_archive_id", "result_attempt_id")
    REFERENCES "solver_evidence_archives"("id", "result_attempt_id")
    ON DELETE RESTRICT,
  CONSTRAINT "historical_archive_audit_decisions_interpretation_owner_fk"
    FOREIGN KEY ("result_interpretation_id", "result_attempt_id", "result_id")
    REFERENCES "result_interpretations"("id", "result_attempt_id", "result_id")
    ON DELETE RESTRICT,
  CONSTRAINT "historical_archive_audit_decisions_signature_check"
    CHECK ("input_evidence_signature" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "historical_archive_audit_decisions_reducer_state_check"
    CHECK (
      "reducer_state" IN (
        'accepted', 'continuation_required', 'recovery_exhausted',
        'rerun_required', 'missing_evidence'
      )
    ),
  CONSTRAINT "historical_archive_audit_decisions_advisory_shape_check"
    CHECK (
      (
        "reducer_state" = 'continuation_required'
        AND "advisory_continuation_action" = 'continue_exact_case'
        AND "advisory_tail_periods" BETWEEN 1 AND 3
      ) OR (
        "reducer_state" <> 'continuation_required'
        AND "advisory_continuation_action" IS NULL
        AND "advisory_tail_periods" IS NULL
      )
    ),
  CONSTRAINT "historical_archive_audit_decisions_diagnostics_shape_check"
    CHECK (jsonb_typeof("diagnostics") = 'object')
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "historical_archive_audit_decisions_identity_uq"
  ON "historical_archive_audit_decisions" (
    "result_attempt_id", "source_archive_id", "reducer_version_id",
    "input_evidence_signature"
  );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "historical_archive_audit_decisions_audit_run_idx"
  ON "historical_archive_audit_decisions" ("audit_run_id", "createdAt");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "historical_archive_audit_decisions_result_created_idx"
  ON "historical_archive_audit_decisions" ("result_id", "createdAt");
--> statement-breakpoint

-- Reuse the ledger's established immutable-row guard.  Cascading parent
-- deletion remains allowed by that function, while direct updates/deletes are
-- rejected even for an audit that did not publish an interpretation.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.historical_archive_audit_decisions'::regclass
      AND tgname = 'historical_archive_audit_decisions_append_only'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "historical_archive_audit_decisions_append_only"
    BEFORE UPDATE OR DELETE ON "historical_archive_audit_decisions"
    FOR EACH ROW EXECUTE FUNCTION "reject_result_interpretation_ledger_mutation"();
  END IF;
END $$;
