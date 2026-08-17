-- A released-evidence audit is scientifically useful immutable provenance,
-- but it is never the same authority as a live archive-publication backfill.
-- Keep the source literal and its replay identity distinct at the database
-- boundary so equal archive bytes cannot cause one authority to reuse the
-- other authority's interpretation row.
--> statement-breakpoint

ALTER TABLE "result_interpretations"
  DROP CONSTRAINT "result_interpretations_source_check";
--> statement-breakpoint

ALTER TABLE "result_interpretations"
  ADD CONSTRAINT "result_interpretations_source_check"
  CHECK (
    "source" IN (
      'engine_reported', 'archive_backfill', 'historical_archive_audit',
      'continuation', 'corrective_generation'
    )
    AND btrim("input_evidence_signature") <> ''
    AND (
      (
        "source" IN ('archive_backfill', 'historical_archive_audit')
        AND "source_archive_id" IS NOT NULL
      )
      OR "source" NOT IN ('archive_backfill', 'historical_archive_audit')
    )
  );
--> statement-breakpoint

-- Preserve the live publication index exactly as introduced by 0099/0100.
-- Its audit counterpart is deliberately separate; the final nonarchive index
-- excludes both archive-provenance sources so neither can collide with
-- engine/continuation/corrective evidence.
DROP INDEX "result_interpretations_nonarchive_attempt_reducer_evidence_uq";
--> statement-breakpoint

CREATE UNIQUE INDEX "ri_historical_archive_attempt_reducer_source_evidence_uq"
  ON "result_interpretations" (
    "result_attempt_id", "reducer_version_id", "source_archive_id",
    "input_evidence_signature"
  )
  WHERE "source" = 'historical_archive_audit';
--> statement-breakpoint

CREATE UNIQUE INDEX "result_interpretations_nonarchive_attempt_reducer_evidence_uq"
  ON "result_interpretations" (
    "result_attempt_id", "reducer_version_id", "input_evidence_signature"
  )
  WHERE "source" <> 'archive_backfill'
    AND "source" <> 'historical_archive_audit';
--> statement-breakpoint

-- A retained release must not look like ordinary pending publication work.
-- 0101-era rows were deliberately held at an unreachable retry timestamp;
-- migrate only that exact provenance marker to the explicit dormant state.
ALTER TABLE "result_archive_reduction_queue"
  DROP CONSTRAINT "result_archive_reduction_queue_state_check";
--> statement-breakpoint

ALTER TABLE "result_archive_reduction_queue"
  ADD CONSTRAINT "result_archive_reduction_queue_state_check"
  CHECK (
    "state" IN (
      'pending', 'hydrating', 'reduced', 'superseded',
      'historical_audit_required', 'missing_evidence',
      'continuation_required', 'rerun_required', 'terminal_failure', 'failed'
    )
  );
--> statement-breakpoint

UPDATE "result_archive_reduction_queue"
SET "state" = 'historical_audit_required',
    "claim_token" = NULL,
    "claim_expires_at" = NULL,
    "next_attempt_at" = clock_timestamp(),
    "updatedAt" = clock_timestamp()
WHERE "state" = 'pending'
  AND "last_error" =
    'historical released evidence requires explicit audit; the live archive-publication queue will not reduce, publish, or schedule CFD for this source'
  AND "next_attempt_at" >= '9999-01-01T00:00:00Z'::timestamptz;
--> statement-breakpoint

-- A historical decision can be written only by the exact released-audit run
-- that owns its source.  The optional interpretation pointer must carry the
-- same result/attempt/archive/reducer/signature and the distinct audit
-- source.  This closes the hole left by the ownership-only composite FK in
-- 0101: a direct insert cannot attach an archive_backfill interpretation or
-- impersonate a no-publication audit receipt.
CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_decision_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "result_interpretation_backfill_runs" audit_run
    WHERE audit_run."id" = NEW."audit_run_id"
      AND audit_run."reducer_version_id" = NEW."reducer_version_id"
      AND audit_run."state" = 'running'
      AND audit_run."scope" ->> 'contract'
        = 'archive-clean-cycle-historical-released-audit-v1'
      AND audit_run."scope" ->> 'canonicalSelection' = 'forbidden'
      AND audit_run."scope" ->> 'physicalRecovery' = 'record-only'
      AND audit_run."scope" ->> 'campaignMutation' = 'forbidden'
      AND audit_run."scope" ->> 'rawEvidenceImmutable' = 'true'
      AND audit_run."scope" #>> '{exactSource,resultId}'
        = NEW."result_id"::text
      AND audit_run."scope" #>> '{exactSource,resultAttemptId}'
        = NEW."result_attempt_id"::text
      AND audit_run."scope" #>> '{exactSource,sourceArchiveId}'
        = NEW."source_archive_id"::text
  ) THEN
    RAISE EXCEPTION
      'historical archive audit decision requires its exact no-publication audit run';
  END IF;

  IF NEW."result_interpretation_id" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM "result_interpretations" interpretation
       WHERE interpretation."id" = NEW."result_interpretation_id"
         AND interpretation."result_id" = NEW."result_id"
         AND interpretation."result_attempt_id" = NEW."result_attempt_id"
         AND interpretation."source_archive_id" = NEW."source_archive_id"
         AND interpretation."reducer_version_id" = NEW."reducer_version_id"
         AND interpretation."input_evidence_signature"
           = NEW."input_evidence_signature"
         AND interpretation."source" = 'historical_archive_audit'
     ) THEN
    RAISE EXCEPTION
      'historical archive audit decision interpretation must match exact historical audit provenance';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "historical_archive_audit_decisions_validate_insert"
  ON "historical_archive_audit_decisions";
--> statement-breakpoint

CREATE TRIGGER "historical_archive_audit_decisions_validate_insert"
BEFORE INSERT ON "historical_archive_audit_decisions"
FOR EACH ROW EXECUTE FUNCTION "validate_historical_archive_audit_decision_insert"();
