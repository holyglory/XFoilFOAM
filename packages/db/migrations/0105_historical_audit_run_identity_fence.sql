-- One released-evidence audit receipt represents exactly one immutable source
-- and reducer identity.  Its mutable run row may still record progress and
-- completion, but it must never be retargeted into a second audit after the
-- first exact source was durably named.
--
-- Check recorded decisions before installing the forward-only fence.  A
-- mismatch cannot be repaired automatically: changing the run would rewrite
-- forensic provenance, while changing an append-only decision is prohibited.
DO $$
BEGIN
  -- Hold run writers and then decision writers while the forensic join is
  -- checked and the forward trigger is installed. Without these locks, a
  -- direct writer could retarget a run after the scan but before the trigger
  -- exists. Lock runs first: a decision INSERT's validator only takes a
  -- RowShare table lock while it reads its audit run, which remains compatible
  -- with this mode. Acquire both locks NOWAIT so an in-flight direct writer in
  -- either order makes this migration retryable before it can wait while
  -- holding the other table lock; the all-or-nothing migration transaction
  -- releases an acquired first lock on that safe failure.
  LOCK TABLE "result_interpretation_backfill_runs" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  LOCK TABLE "historical_archive_audit_decisions" IN SHARE ROW EXCLUSIVE MODE NOWAIT;

  IF EXISTS (
    SELECT 1
    FROM "historical_archive_audit_decisions" decision
    JOIN "result_interpretation_backfill_runs" audit_run
      ON audit_run."id" = decision."audit_run_id"
    WHERE audit_run."reducer_version_id" IS DISTINCT FROM decision."reducer_version_id"
       OR audit_run."scope" ->> 'contract'
         IS DISTINCT FROM 'archive-clean-cycle-historical-released-audit-v1'
       OR audit_run."scope" ->> 'canonicalSelection'
         IS DISTINCT FROM 'forbidden'
       OR audit_run."scope" ->> 'physicalRecovery'
         IS DISTINCT FROM 'record-only'
       OR audit_run."scope" ->> 'campaignMutation'
         IS DISTINCT FROM 'forbidden'
       OR jsonb_typeof(audit_run."scope" -> 'rawEvidenceImmutable')
         IS DISTINCT FROM 'boolean'
       OR audit_run."scope" ->> 'rawEvidenceImmutable'
         IS DISTINCT FROM 'true'
       OR jsonb_typeof(audit_run."scope" -> 'exactSource')
         IS DISTINCT FROM 'object'
       OR NOT COALESCE(
         (audit_run."scope" -> 'exactSource') ?& ARRAY[
           'resultId', 'resultAttemptId', 'sourceArchiveId'
         ]::text[],
         false
       )
       OR CASE
         WHEN jsonb_typeof(audit_run."scope" -> 'exactSource') = 'object' THEN
           EXISTS (
             SELECT 1
             FROM jsonb_object_keys(audit_run."scope" -> 'exactSource')
               AS exact_source_key(key)
             WHERE exact_source_key.key NOT IN (
               'resultId', 'resultAttemptId', 'sourceArchiveId'
             )
           )
         ELSE false
       END
       OR jsonb_typeof(audit_run."scope" #> '{exactSource,resultId}')
         IS DISTINCT FROM 'string'
       OR jsonb_typeof(audit_run."scope" #> '{exactSource,resultAttemptId}')
         IS DISTINCT FROM 'string'
       OR jsonb_typeof(audit_run."scope" #> '{exactSource,sourceArchiveId}')
         IS DISTINCT FROM 'string'
       OR NOT COALESCE(
         audit_run."scope" #>> '{exactSource,resultId}'
           ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
         false
       )
       OR NOT COALESCE(
         audit_run."scope" #>> '{exactSource,resultAttemptId}'
           ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
         false
       )
       OR NOT COALESCE(
         audit_run."scope" #>> '{exactSource,sourceArchiveId}'
           ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
         false
       )
       OR audit_run."scope" ? 'resultIds'
       OR audit_run."scope" ? 'resultAttemptIds'
       OR audit_run."scope" ? 'limit'
       OR audit_run."scope" #>> '{exactSource,resultId}'
         IS DISTINCT FROM decision."result_id"::text
       OR audit_run."scope" #>> '{exactSource,resultAttemptId}'
         IS DISTINCT FROM decision."result_attempt_id"::text
       OR audit_run."scope" #>> '{exactSource,sourceArchiveId}'
         IS DISTINCT FROM decision."source_archive_id"::text
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = '0105 migration blocked: a historical archive audit decision no longer matches its immutable audit run identity',
      HINT = 'Preserve the mismatched rows as forensic evidence and repair through an explicit audited migration before retrying.';
  END IF;

  -- Audit runs with no decision yet must already have the same exact,
  -- no-publication scope. Otherwise the forward identity trigger would make a
  -- malformed inert receipt impossible to repair through the normal flow.
  IF EXISTS (
    SELECT 1
    FROM "result_interpretation_backfill_runs" audit_run
    WHERE audit_run."scope" ->> 'contract'
            = 'archive-clean-cycle-historical-released-audit-v1'
      AND (
        audit_run."scope" ->> 'canonicalSelection' IS DISTINCT FROM 'forbidden'
        OR audit_run."scope" ->> 'physicalRecovery' IS DISTINCT FROM 'record-only'
        OR audit_run."scope" ->> 'campaignMutation' IS DISTINCT FROM 'forbidden'
        OR jsonb_typeof(audit_run."scope" -> 'rawEvidenceImmutable')
          IS DISTINCT FROM 'boolean'
        OR audit_run."scope" ->> 'rawEvidenceImmutable' IS DISTINCT FROM 'true'
        OR jsonb_typeof(audit_run."scope" -> 'exactSource')
          IS DISTINCT FROM 'object'
        OR NOT COALESCE(
          (audit_run."scope" -> 'exactSource') ?& ARRAY[
            'resultId', 'resultAttemptId', 'sourceArchiveId'
          ]::text[],
          false
        )
        OR CASE
          WHEN jsonb_typeof(audit_run."scope" -> 'exactSource') = 'object' THEN
            EXISTS (
              SELECT 1
              FROM jsonb_object_keys(audit_run."scope" -> 'exactSource')
                AS exact_source_key(key)
              WHERE exact_source_key.key NOT IN (
                'resultId', 'resultAttemptId', 'sourceArchiveId'
              )
            )
          ELSE false
        END
        OR jsonb_typeof(audit_run."scope" #> '{exactSource,resultId}')
          IS DISTINCT FROM 'string'
        OR jsonb_typeof(audit_run."scope" #> '{exactSource,resultAttemptId}')
          IS DISTINCT FROM 'string'
        OR jsonb_typeof(audit_run."scope" #> '{exactSource,sourceArchiveId}')
          IS DISTINCT FROM 'string'
        OR NOT COALESCE(
          audit_run."scope" #>> '{exactSource,resultId}'
            ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          false
        )
        OR NOT COALESCE(
          audit_run."scope" #>> '{exactSource,resultAttemptId}'
            ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          false
        )
        OR NOT COALESCE(
          audit_run."scope" #>> '{exactSource,sourceArchiveId}'
            ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          false
        )
        OR audit_run."scope" ? 'resultIds'
        OR audit_run."scope" ? 'resultAttemptIds'
        OR audit_run."scope" ? 'limit'
      )
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = '0105 migration blocked: a historical archive audit run no longer has its exact no-publication authority contract',
      HINT = 'Preserve the malformed run as forensic evidence and repair it through an explicit audited migration before retrying.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "historical_archive_audit_decisions"
    GROUP BY "audit_run_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = '0105 migration blocked: a historical archive audit run has more than one immutable decision',
      HINT = 'Preserve the duplicate rows as forensic evidence and split them into explicit audit runs through an audited repair before retrying.';
  END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_run_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- An audit run has no publish/recovery authority. Keep the JSON boolean
  -- typed: `->>` would otherwise accept the string "true" as if it were the
  -- deliberate immutable evidence flag.
  IF NEW."scope" ->> 'contract'
       = 'archive-clean-cycle-historical-released-audit-v1'
     AND (
       NEW."scope" ->> 'canonicalSelection' IS DISTINCT FROM 'forbidden'
       OR NEW."scope" ->> 'physicalRecovery' IS DISTINCT FROM 'record-only'
       OR NEW."scope" ->> 'campaignMutation' IS DISTINCT FROM 'forbidden'
       OR jsonb_typeof(NEW."scope" -> 'rawEvidenceImmutable')
         IS DISTINCT FROM 'boolean'
       OR NEW."scope" ->> 'rawEvidenceImmutable' IS DISTINCT FROM 'true'
       OR jsonb_typeof(NEW."scope" -> 'exactSource')
         IS DISTINCT FROM 'object'
       OR NOT COALESCE(
         (NEW."scope" -> 'exactSource') ?& ARRAY[
           'resultId', 'resultAttemptId', 'sourceArchiveId'
         ]::text[],
         false
       )
       OR CASE
         WHEN jsonb_typeof(NEW."scope" -> 'exactSource') = 'object' THEN
           EXISTS (
             SELECT 1
             FROM jsonb_object_keys(NEW."scope" -> 'exactSource')
               AS exact_source_key(key)
             WHERE exact_source_key.key NOT IN (
               'resultId', 'resultAttemptId', 'sourceArchiveId'
             )
           )
         ELSE false
       END
       OR jsonb_typeof(NEW."scope" #> '{exactSource,resultId}')
         IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW."scope" #> '{exactSource,resultAttemptId}')
         IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW."scope" #> '{exactSource,sourceArchiveId}')
         IS DISTINCT FROM 'string'
       OR NOT COALESCE(
         NEW."scope" #>> '{exactSource,resultId}'
           ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
         false
       )
       OR NOT COALESCE(
         NEW."scope" #>> '{exactSource,resultAttemptId}'
           ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
         false
       )
       OR NOT COALESCE(
         NEW."scope" #>> '{exactSource,sourceArchiveId}'
           ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
         false
       )
       OR NEW."scope" ? 'resultIds'
       OR NEW."scope" ? 'resultAttemptIds'
       OR NEW."scope" ? 'limit'
     ) THEN
    RAISE EXCEPTION
      'historical archive audit run requires its exact no-publication authority contract';
  END IF;

  -- Cover both directions.  Without the NEW check, a generic run could be
  -- retargeted into an audit after creation; without the OLD check, an audit
  -- could be stripped of its authority contract after recording a decision.
  -- State, summary, timestamps, and leases intentionally remain mutable
  -- within the narrow execution lifecycle below.
  IF TG_OP = 'UPDATE' AND (
    OLD."scope" ->> 'contract'
      = 'archive-clean-cycle-historical-released-audit-v1'
    OR NEW."scope" ->> 'contract'
      = 'archive-clean-cycle-historical-released-audit-v1'
  ) AND (
    NEW."scope" IS DISTINCT FROM OLD."scope"
    OR NEW."reducer_version_id" IS DISTINCT FROM OLD."reducer_version_id"
  ) THEN
    RAISE EXCEPTION
      'historical archive audit run identity is immutable; create a new exact audit run';
  END IF;

  -- An exact audit's state is execution authority, not ordinary mutable
  -- metadata.  In particular, a direct writer must not revive a failed,
  -- cancelled, or completed audit and hand its existing pending receipt back
  -- to the lease path.  Preserve the only forensic correction required after
  -- a source-owner cascade: `completed` may become `failed`.  Planned runs may
  -- be started or stopped; running runs may settle or be cancelled.
  IF TG_OP = 'UPDATE'
     AND NEW."state" IS DISTINCT FROM OLD."state"
     AND (
       OLD."scope" ->> 'contract'
         = 'archive-clean-cycle-historical-released-audit-v1'
       OR NEW."scope" ->> 'contract'
         = 'archive-clean-cycle-historical-released-audit-v1'
     )
     AND (
       OLD."state" IN ('failed', 'cancelled')
       OR (OLD."state" = 'completed' AND NEW."state" <> 'failed')
       OR (
         OLD."state" = 'planned'
         AND NEW."state" NOT IN ('running', 'failed', 'cancelled')
       )
       OR (
         OLD."state" = 'running'
         AND NEW."state" NOT IN ('completed', 'failed', 'cancelled')
       )
     ) THEN
    RAISE EXCEPTION
      'historical archive audit run is terminal and cannot be resumed; create a new exact audit run';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "result_interpretation_backfill_runs_validate_historical_audit_identity"
  ON "result_interpretation_backfill_runs";
--> statement-breakpoint

CREATE TRIGGER "result_interpretation_backfill_runs_validate_historical_audit_identity"
BEFORE INSERT OR UPDATE
ON "result_interpretation_backfill_runs"
FOR EACH ROW EXECUTE FUNCTION "validate_historical_archive_audit_run_identity"();
--> statement-breakpoint

-- An audit invocation materializes exactly one item and one immutable outcome.
-- Source/signature identity remains unique across all runs, while this key
-- closes the direct-SQL path that could append a conflicting second outcome to
-- the same exact audit receipt.
CREATE UNIQUE INDEX "historical_archive_audit_decisions_audit_run_uq"
  ON "historical_archive_audit_decisions" ("audit_run_id");
