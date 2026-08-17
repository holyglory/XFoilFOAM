-- A historical released-evidence audit is one explicit reducer execution, not
-- merely a free-standing decision row. Bind the immutable decision to the
-- claimed child receipt that actually owns the exact source. This closes the
-- direct-SQL path that could insert `missing_evidence` (or any other outcome)
-- for a running audit run without an execution lifecycle and permanently
-- consume that run's one-decision slot.
--
-- These DDL statements eventually require ACCESS EXCLUSIVE. Acquire that
-- strongest mode up front, in one canonical order, and fail fast rather than
-- wait while holding weaker cross-table locks. The worker can retry after the
-- maintenance window; a partially concurrent forensic migration must never
-- be allowed to race an audit finalizer.
DO $$
BEGIN
  LOCK TABLE "result_interpretation_backfill_items" IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE "historical_archive_audit_decisions" IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE "result_interpretation_backfill_runs" IN ACCESS EXCLUSIVE MODE NOWAIT;
  -- 0106 also installs an owner-cascade trigger on this source table. Lock it
  -- here rather than letting CREATE TRIGGER wait after the forensic receipt
  -- tables are already exclusively held.
  LOCK TABLE "result_attempts" IN ACCESS EXCLUSIVE MODE NOWAIT;
END;
$$;
--> statement-breakpoint

ALTER TABLE "result_interpretation_backfill_items"
  ADD COLUMN "historical_audit_decision_id" uuid,
  ADD COLUMN "historical_audit_reducer_state" text,
  ADD COLUMN "historical_audit_input_evidence_signature" text;
--> statement-breakpoint

ALTER TABLE "result_interpretation_backfill_items"
  ADD CONSTRAINT "ri_bf_item_audit_receipt_shape_ck"
  CHECK (
    (
      "historical_audit_decision_id" IS NULL
      AND "historical_audit_reducer_state" IS NULL
      AND "historical_audit_input_evidence_signature" IS NULL
    ) OR (
      "historical_audit_decision_id" IS NOT NULL
      AND "historical_audit_reducer_state" IS NOT NULL
      AND "historical_audit_reducer_state" IN (
        'accepted', 'continuation_required', 'recovery_exhausted',
        'rerun_required', 'missing_evidence'
      )
      AND "historical_audit_input_evidence_signature" IS NOT NULL
      AND "historical_audit_input_evidence_signature" ~ '^[0-9a-f]{64}$'
    )
  ),
  ADD CONSTRAINT "ri_bf_item_audit_decision_fk"
  FOREIGN KEY ("historical_audit_decision_id")
  REFERENCES "historical_archive_audit_decisions"("id")
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

CREATE UNIQUE INDEX "ri_bf_item_audit_decision_uq"
  ON "result_interpretation_backfill_items" ("historical_audit_decision_id")
  WHERE "historical_audit_decision_id" IS NOT NULL;
--> statement-breakpoint

-- A 0101–0105 receipt predates the reverse child pointer. Preserve a valid
-- one only when exactly one already-settled child proves the exact run/source,
-- claim count, reducer state, and interpretation mapping. Every legacy audit
-- run must already own exactly one exact child even when that child is still
-- pending, unless its result/attempt was intentionally owner-cascaded away.
-- An empty audit run with a still-live source was never an execution receipt.
-- Anything weaker is forensic ambiguity, not a license to infer a replacement
-- child.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "result_interpretation_backfill_runs" audit_run
    WHERE audit_run."scope" ->> 'contract'
            = 'archive-clean-cycle-historical-released-audit-v1'
      AND (
        (
          (
            SELECT count(*)
            FROM "result_interpretation_backfill_items" child
            WHERE child."run_id" = audit_run."id"
          ) <> 1
          OR NOT EXISTS (
            SELECT 1
            FROM "result_interpretation_backfill_items" child
            WHERE child."run_id" = audit_run."id"
              AND child."result_id"::text
                = audit_run."scope" #>> '{exactSource,resultId}'
              AND child."result_attempt_id"::text
                = audit_run."scope" #>> '{exactSource,resultAttemptId}'
              AND child."source_archive_id"::text
                = audit_run."scope" #>> '{exactSource,sourceArchiveId}'
          )
        )
        -- Owner cascades intentionally retain the audit run after its exact
        -- result/attempt disappears. That source can have zero children only;
        -- any surviving/multiple child is still malformed forensic state.
        AND NOT (
          (
            SELECT count(*)
            FROM "result_interpretation_backfill_items" child
            WHERE child."run_id" = audit_run."id"
          ) = 0
          AND NOT EXISTS (
            SELECT 1
            FROM "result_attempts" attempt
            WHERE attempt."id"::text
                    = audit_run."scope" #>> '{exactSource,resultAttemptId}'
              AND attempt."result_id"::text
                    = audit_run."scope" #>> '{exactSource,resultId}'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = '0106 migration blocked: a historical archive audit run lacks exactly one exact child execution receipt',
      HINT = 'Preserve the malformed run as forensic evidence and repair its explicit receipt before retrying.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "historical_archive_audit_decisions" decision
    WHERE (
      SELECT count(*)
      FROM "result_interpretation_backfill_items" child
      WHERE child."run_id" = decision."audit_run_id"
        AND child."result_id" = decision."result_id"
        AND child."result_attempt_id" = decision."result_attempt_id"
        AND child."source_archive_id" = decision."source_archive_id"
    ) <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM "result_interpretation_backfill_items" child
      WHERE child."run_id" = decision."audit_run_id"
        AND child."result_id" = decision."result_id"
        AND child."result_attempt_id" = decision."result_attempt_id"
        AND child."source_archive_id" = decision."source_archive_id"
        AND child."attempt_count" >= 1
        AND child."claim_token" IS NULL
        AND child."claim_expires_at" IS NULL
        AND (
          (decision."reducer_state" = 'accepted'
            AND child."state" = 'reduced'
            AND child."result_interpretation_id" = decision."result_interpretation_id")
          OR (decision."reducer_state" = 'continuation_required'
            AND child."state" = 'continuation_required'
            AND child."result_interpretation_id" = decision."result_interpretation_id")
          OR (decision."reducer_state" = 'recovery_exhausted'
            AND child."state" = 'terminal_failure'
            AND child."result_interpretation_id" = decision."result_interpretation_id")
          OR (decision."reducer_state" = 'rerun_required'
            AND child."state" = 'rerun_required'
            AND child."result_interpretation_id"
              IS NOT DISTINCT FROM decision."result_interpretation_id")
          OR (decision."reducer_state" = 'missing_evidence'
            AND child."state" = 'missing_evidence'
            AND child."result_interpretation_id" IS NULL
            AND decision."result_interpretation_id" IS NULL)
        )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM "result_interpretation_backfill_runs" audit_run
      WHERE audit_run."id" = decision."audit_run_id"
        AND audit_run."reducer_version_id" = decision."reducer_version_id"
        AND audit_run."scope" ->> 'contract'
          = 'archive-clean-cycle-historical-released-audit-v1'
        AND audit_run."scope" ->> 'canonicalSelection' = 'forbidden'
        AND audit_run."scope" ->> 'physicalRecovery' = 'record-only'
        AND audit_run."scope" ->> 'campaignMutation' = 'forbidden'
        AND audit_run."scope" ->> 'rawEvidenceImmutable' = 'true'
        AND audit_run."scope" #>> '{exactSource,resultId}'
          = decision."result_id"::text
        AND audit_run."scope" #>> '{exactSource,resultAttemptId}'
          = decision."result_attempt_id"::text
        AND audit_run."scope" #>> '{exactSource,sourceArchiveId}'
          = decision."source_archive_id"::text
    )
    OR (
      decision."reducer_state" IN (
        'accepted', 'continuation_required', 'recovery_exhausted'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "result_interpretations" interpretation
        WHERE interpretation."id" = decision."result_interpretation_id"
          AND interpretation."result_id" = decision."result_id"
          AND interpretation."result_attempt_id" = decision."result_attempt_id"
          AND interpretation."source_archive_id" = decision."source_archive_id"
          AND interpretation."reducer_version_id" = decision."reducer_version_id"
          AND interpretation."input_evidence_signature"
            = decision."input_evidence_signature"
          AND interpretation."source" = 'historical_archive_audit'
          AND interpretation."state" = CASE decision."reducer_state"
            WHEN 'accepted' THEN 'accepted'::"result_interpretation_state"
            WHEN 'continuation_required' THEN 'continuation_required'::"result_interpretation_state"
            ELSE 'terminal_failure'::"result_interpretation_state"
          END
      )
    )
    OR (
      decision."reducer_state" = 'rerun_required'
      AND decision."result_interpretation_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "result_interpretations" interpretation
        WHERE interpretation."id" = decision."result_interpretation_id"
          AND interpretation."result_id" = decision."result_id"
          AND interpretation."result_attempt_id" = decision."result_attempt_id"
          AND interpretation."source_archive_id" = decision."source_archive_id"
          AND interpretation."reducer_version_id" = decision."reducer_version_id"
          AND interpretation."input_evidence_signature"
            = decision."input_evidence_signature"
          AND interpretation."source" = 'historical_archive_audit'
          AND interpretation."state" = 'terminal_failure'
      )
    )
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = '0106 migration blocked: a historical archive audit decision lacks one compatible settled child execution receipt',
      HINT = 'Preserve the ambiguous rows as forensic evidence and bind them through an explicit audited repair before retrying.';
  END IF;

  -- The reciprocal check is intentionally separate from the decision scan
  -- above. A terminal child with *no* decision would otherwise evade that
  -- scan, be accepted by this migration, and only become an irreparable
  -- receipt mismatch after the 0106 triggers are installed. `failed` remains
  -- a valid operational audit outcome without a scientific decision; every
  -- scientific terminal child must already have exactly one compatible
  -- immutable decision before the reverse pointer is backfilled.
  IF EXISTS (
    SELECT 1
    FROM "result_interpretation_backfill_items" child
    JOIN "result_interpretation_backfill_runs" audit_run
      ON audit_run."id" = child."run_id"
    WHERE audit_run."scope" ->> 'contract'
            = 'archive-clean-cycle-historical-released-audit-v1'
      AND child."state" IN (
        'reduced', 'missing_evidence', 'continuation_required',
        'rerun_required', 'terminal_failure'
      )
      AND (
        SELECT count(*)
        FROM "historical_archive_audit_decisions" decision
        WHERE decision."audit_run_id" = child."run_id"
          AND decision."result_id" = child."result_id"
          AND decision."result_attempt_id" = child."result_attempt_id"
          AND decision."source_archive_id" = child."source_archive_id"
          AND decision."reducer_version_id" = audit_run."reducer_version_id"
          AND (
            (decision."reducer_state" = 'accepted'
              AND child."state" = 'reduced'
              AND child."result_interpretation_id"
                = decision."result_interpretation_id")
            OR (decision."reducer_state" = 'continuation_required'
              AND child."state" = 'continuation_required'
              AND child."result_interpretation_id"
                = decision."result_interpretation_id")
            OR (decision."reducer_state" = 'recovery_exhausted'
              AND child."state" = 'terminal_failure'
              AND child."result_interpretation_id"
                = decision."result_interpretation_id")
            OR (decision."reducer_state" = 'rerun_required'
              AND child."state" = 'rerun_required'
              AND child."result_interpretation_id"
                IS NOT DISTINCT FROM decision."result_interpretation_id")
            OR (decision."reducer_state" = 'missing_evidence'
              AND child."state" = 'missing_evidence'
              AND child."result_interpretation_id" IS NULL
              AND decision."result_interpretation_id" IS NULL)
          )
      ) <> 1
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = '0106 migration blocked: a historical archive audit scientific terminal child lacks exactly one compatible immutable decision',
      HINT = 'Preserve the ambiguous child as forensic evidence and bind it through an explicit audited repair before retrying.';
  END IF;
END;
$$;
--> statement-breakpoint

UPDATE "result_interpretation_backfill_items" child
SET
  "historical_audit_decision_id" = decision."id",
  "historical_audit_reducer_state" = decision."reducer_state",
  "historical_audit_input_evidence_signature" = decision."input_evidence_signature"
FROM "historical_archive_audit_decisions" decision
WHERE child."run_id" = decision."audit_run_id"
  AND child."result_id" = decision."result_id"
  AND child."result_attempt_id" = decision."result_attempt_id"
  AND child."source_archive_id" = decision."source_archive_id";
--> statement-breakpoint

-- Legacy owner cascades from before the immediate close trigger below retain
-- their parent audit but no longer have a reducible source. Preserve that fact
-- as failed forensic history now; otherwise a completed 0/0 summary would
-- misrepresent it until an operator happened to invoke the runner again.
UPDATE "result_interpretation_backfill_runs" audit_run
SET
  "state" = 'failed',
  "completed_at" = clock_timestamp(),
  "summary" = COALESCE(audit_run."summary", '{}'::jsonb) ||
    jsonb_build_object(
      'historicalAuditIncomplete', true,
      'historicalAuditIncompleteReason',
        'historical audit exact source owner was removed before its child execution could complete',
      'historicalAuditDecisions', 0,
      'rawEvidenceImmutable', true
    ),
  "updatedAt" = clock_timestamp()
WHERE audit_run."scope" ->> 'contract'
        = 'archive-clean-cycle-historical-released-audit-v1'
  AND audit_run."state" IN ('planned', 'running', 'completed')
  AND NOT EXISTS (
    SELECT 1
    FROM "result_interpretation_backfill_items" child
    WHERE child."run_id" = audit_run."id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "result_attempts" attempt
    WHERE attempt."id"::text
            = audit_run."scope" #>> '{exactSource,resultAttemptId}'
      AND attempt."result_id"::text
            = audit_run."scope" #>> '{exactSource,resultId}'
  );
--> statement-breakpoint

-- Audit-child admission is exact and singular. The parent lock serializes
-- concurrent direct writers so two independently valid inserts cannot both
-- observe an empty audit run. This trigger only runs for child identity
-- changes; final settlement updates state under the child -> result -> source
-- -> run order and must not take a parent lock before it owns the child.
CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_item_admission"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  locked_audit_run record;
  existing_parent_scope jsonb;
  old_parent_scope jsonb;
  existing_child_count integer;
BEGIN
  SELECT audit_run."scope"
  INTO existing_parent_scope
  FROM "result_interpretation_backfill_runs" audit_run
  WHERE audit_run."id" = NEW."run_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'historical archive audit child requires an existing backfill run';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."run_id" IS DISTINCT FROM NEW."run_id" THEN
    SELECT audit_run."scope"
    INTO old_parent_scope
    FROM "result_interpretation_backfill_runs" audit_run
    WHERE audit_run."id" = OLD."run_id";
    IF old_parent_scope ->> 'contract'
         = 'archive-clean-cycle-historical-released-audit-v1' THEN
      RAISE EXCEPTION
        'historical archive audit child cannot be moved out of its exact audit run';
    END IF;

    -- The reciprocal move is just as unsafe. A generic queue child may happen
    -- to name the same result/attempt/archive, but it was not admitted by the
    -- explicit released-history audit command. Letting a direct writer move it
    -- into the audit run would bypass the INSERT-only pending-receipt proof and
    -- make an unrelated queue lifecycle look like audited scientific work.
    IF existing_parent_scope ->> 'contract'
         = 'archive-clean-cycle-historical-released-audit-v1' THEN
      RAISE EXCEPTION
        'historical archive audit child must be inserted directly into its exact audit run';
    END IF;
  END IF;

  -- Ordinary broad runs are intentionally untouched. Only the uncommon exact
  -- audit contract needs the parent mutex that prevents two direct writers
  -- from observing an empty audit run at once.
  IF existing_parent_scope ->> 'contract'
       IS DISTINCT FROM 'archive-clean-cycle-historical-released-audit-v1' THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT audit_run.*
    INTO locked_audit_run
    FROM "result_interpretation_backfill_runs" audit_run
    WHERE audit_run."id" = NEW."run_id"
    FOR UPDATE NOWAIT;
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE EXCEPTION USING
        ERRCODE = '55P03',
        MESSAGE = 'historical archive audit child admission is locked by an active audit transaction; retry the exact audit receipt';
  END;

  IF NEW."result_id"::text IS DISTINCT FROM
       locked_audit_run."scope" #>> '{exactSource,resultId}'
     OR NEW."result_attempt_id"::text IS DISTINCT FROM
       locked_audit_run."scope" #>> '{exactSource,resultAttemptId}'
     OR NEW."source_archive_id"::text IS DISTINCT FROM
       locked_audit_run."scope" #>> '{exactSource,sourceArchiveId}' THEN
    RAISE EXCEPTION
      'historical archive audit child must match its parent run exact source';
  END IF;

  SELECT count(*)
  INTO existing_child_count
  FROM "result_interpretation_backfill_items" child
  WHERE child."run_id" = NEW."run_id"
    AND child."id" <> NEW."id";
  IF existing_child_count <> 0 THEN
    RAISE EXCEPTION
      'historical archive audit run may own exactly one child execution receipt';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "ri_bf_item_audit_admission"
  ON "result_interpretation_backfill_items";
--> statement-breakpoint

CREATE TRIGGER "ri_bf_item_audit_admission"
BEFORE INSERT OR UPDATE OF "run_id", "result_id", "result_attempt_id", "source_archive_id"
ON "result_interpretation_backfill_items"
FOR EACH ROW EXECUTE FUNCTION "validate_historical_archive_audit_item_admission"();
--> statement-breakpoint

-- Once a child has named its immutable decision, no later generic receipt
-- update may retarget the decision, source, lifecycle state, or interpretation
-- pointer. The deferred FK below still permits the finalizer to write the
-- child first and insert the append-only decision in the same transaction.
CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_item_receipt_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_scope jsonb;
BEGIN
  IF NEW."historical_audit_decision_id" IS NOT NULL
     OR NEW."state" IN (
       'reduced', 'missing_evidence', 'continuation_required',
       'rerun_required', 'terminal_failure'
     ) THEN
    SELECT audit_run."scope"
    INTO parent_scope
    FROM "result_interpretation_backfill_runs" audit_run
    WHERE audit_run."id" = NEW."run_id";

    IF parent_scope ->> 'contract'
         = 'archive-clean-cycle-historical-released-audit-v1'
       AND NEW."historical_audit_decision_id" IS NULL
       AND NEW."state" IN (
         'reduced', 'missing_evidence', 'continuation_required',
         'rerun_required', 'terminal_failure'
       ) THEN
      RAISE EXCEPTION
        'historical archive audit scientific terminal state requires its immutable decision receipt';
    END IF;

    IF NEW."historical_audit_decision_id" IS NOT NULL
       AND parent_scope ->> 'contract'
         IS DISTINCT FROM 'archive-clean-cycle-historical-released-audit-v1' THEN
      RAISE EXCEPTION
        'historical audit decision receipt may only be attached to an exact historical audit child';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."historical_audit_decision_id" IS NOT NULL AND (
    NEW."historical_audit_decision_id"
      IS DISTINCT FROM OLD."historical_audit_decision_id"
    OR NEW."historical_audit_reducer_state"
      IS DISTINCT FROM OLD."historical_audit_reducer_state"
    OR NEW."historical_audit_input_evidence_signature"
      IS DISTINCT FROM OLD."historical_audit_input_evidence_signature"
    OR NEW."run_id" IS DISTINCT FROM OLD."run_id"
    OR NEW."result_id" IS DISTINCT FROM OLD."result_id"
    OR NEW."result_attempt_id" IS DISTINCT FROM OLD."result_attempt_id"
    OR NEW."source_archive_id" IS DISTINCT FROM OLD."source_archive_id"
    OR NEW."state" IS DISTINCT FROM OLD."state"
    OR NEW."result_interpretation_id"
      IS DISTINCT FROM OLD."result_interpretation_id"
  ) THEN
    RAISE EXCEPTION
      'historical archive audit child receipt is immutable after its decision is recorded';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "ri_bf_item_audit_receipt"
  ON "result_interpretation_backfill_items";
--> statement-breakpoint

CREATE TRIGGER "ri_bf_item_audit_receipt"
BEFORE INSERT OR UPDATE
ON "result_interpretation_backfill_items"
FOR EACH ROW EXECUTE FUNCTION "validate_historical_archive_audit_item_receipt_identity"();
--> statement-breakpoint

-- A direct terminal child insert can otherwise pair a made-up UUID with a
-- matching decision in one deferred-FK transaction. An immutable decision is
-- only meaningful when the audit child first existed as the unclaimed pending
-- receipt admitted by the exact audit command, then passed through a claimed
-- hydrating lifecycle. This cannot attest to remote reducer I/O for a database
-- superuser, but it removes the database-level forged-terminal receipt path
-- and keeps every ordinary writer on the same lease lifecycle as the worker.
CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_item_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_scope jsonb;
  parent_state text;
BEGIN
  SELECT audit_run."scope"
  INTO parent_scope
  FROM "result_interpretation_backfill_runs" audit_run
  WHERE audit_run."id" = NEW."run_id";

  IF parent_scope ->> 'contract'
       IS DISTINCT FROM 'archive-clean-cycle-historical-released-audit-v1' THEN
    RETURN NEW;
  END IF;

  -- The row update has already locked the child.  A worker that enters,
  -- renews, or reclaims a lease must lock the parent second and observe that
  -- its authority is still running.  Keep this child → parent fence limited
  -- to the leased lifecycle: terminal settlement continues through the
  -- direct-decision validator's child → result → source → parent ordering.
  IF TG_OP = 'UPDATE'
     AND NEW."state" = 'hydrating'
     AND OLD."state" IN ('pending', 'hydrating') THEN
    BEGIN
      SELECT audit_run."state"
      INTO parent_state
      FROM "result_interpretation_backfill_runs" audit_run
      WHERE audit_run."id" = NEW."run_id"
      FOR UPDATE NOWAIT;
    EXCEPTION
      WHEN lock_not_available THEN
        RAISE EXCEPTION USING
          ERRCODE = '55P03',
          MESSAGE = 'historical archive audit child lease parent is locked by an active transaction; retry the exact audit receipt';
    END;

    IF parent_state IS DISTINCT FROM 'running' THEN
      RAISE EXCEPTION
        'historical archive audit child lease requires a running parent audit run';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."state" IS DISTINCT FROM 'pending'
       OR NEW."attempt_count" <> 0
       OR NEW."claim_token" IS NOT NULL
       OR NEW."claim_expires_at" IS NOT NULL
       OR NEW."last_error" IS NOT NULL
       OR NEW."result_interpretation_id" IS NOT NULL
       OR NEW."historical_audit_decision_id" IS NOT NULL
       OR NEW."historical_audit_reducer_state" IS NOT NULL
       OR NEW."historical_audit_input_evidence_signature" IS NOT NULL THEN
      RAISE EXCEPTION
        'historical archive audit child must be inserted as an unclaimed pending receipt';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."state" = 'pending' THEN
    IF NEW."state" = 'pending' THEN
      IF NEW."attempt_count" <> 0
         OR NEW."claim_token" IS NOT NULL
         OR NEW."claim_expires_at" IS NOT NULL
         OR NEW."result_interpretation_id" IS NOT NULL
         OR NEW."historical_audit_decision_id" IS NOT NULL
         OR NEW."historical_audit_reducer_state" IS NOT NULL
         OR NEW."historical_audit_input_evidence_signature" IS NOT NULL THEN
        RAISE EXCEPTION
          'historical archive audit pending child must remain an unclaimed initial receipt';
      END IF;
      RETURN NEW;
    END IF;

    IF NEW."state" = 'hydrating'
       AND OLD."attempt_count" = 0
       AND NEW."attempt_count" = 1
       AND NEW."claim_token" IS NOT NULL
       AND NEW."claim_expires_at" IS NOT NULL
       AND NEW."claim_expires_at" > clock_timestamp()
       AND NEW."result_interpretation_id" IS NULL
       AND NEW."historical_audit_decision_id" IS NULL
       AND NEW."historical_audit_reducer_state" IS NULL
       AND NEW."historical_audit_input_evidence_signature" IS NULL THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'historical archive audit child must move pending → claimed hydrating before any terminal settlement';
  END IF;

  IF OLD."state" = 'hydrating' THEN
    IF NEW."state" = 'hydrating' THEN
      IF NEW."result_interpretation_id" IS NOT NULL
         OR NEW."historical_audit_decision_id" IS NOT NULL
         OR NEW."historical_audit_reducer_state" IS NOT NULL
         OR NEW."historical_audit_input_evidence_signature" IS NOT NULL THEN
        RAISE EXCEPTION
          'historical archive audit claimed child cannot record a decision before terminal settlement';
      END IF;

      IF NEW."claim_token" IS NOT DISTINCT FROM OLD."claim_token" THEN
        IF NEW."claim_token" IS NULL
           OR NEW."claim_expires_at" IS NULL
           OR NEW."claim_expires_at" <= clock_timestamp()
           OR OLD."claim_expires_at" <= clock_timestamp()
           OR NEW."attempt_count" <> OLD."attempt_count" THEN
          RAISE EXCEPTION
            'historical archive audit claim renewal requires one still-live claimed lease and cannot alter its execution count';
        END IF;
      ELSIF OLD."claim_expires_at" > clock_timestamp()
         OR NEW."attempt_count" <> OLD."attempt_count" + 1
         OR NEW."claim_token" IS NULL
         OR NEW."claim_expires_at" IS NULL
         OR NEW."claim_expires_at" <= clock_timestamp() THEN
        RAISE EXCEPTION
          'historical archive audit claimed child may be reclaimed only after its prior lease expires with a new live lease';
      END IF;
      RETURN NEW;
    END IF;

    IF NEW."state" IN (
      'reduced', 'missing_evidence', 'continuation_required',
      'rerun_required', 'terminal_failure', 'failed'
    )
       AND OLD."attempt_count" >= 1
       AND NEW."attempt_count" = OLD."attempt_count"
       AND OLD."claim_token" IS NOT NULL
       AND OLD."claim_expires_at" IS NOT NULL
       AND NEW."claim_token" IS NULL
       AND NEW."claim_expires_at" IS NULL THEN
      -- An expired audit lease may be closed only as an operational failure.
      -- Every scientific terminal state/decision must still be derived while
      -- the worker owns a live lease, otherwise a stale writer could settle a
      -- forged terminal receipt after authority had already elapsed.
      IF NEW."state" <> 'failed'
         AND OLD."claim_expires_at" <= clock_timestamp() THEN
        RAISE EXCEPTION
          'historical archive audit scientific terminal settlement requires a still-live claimed lease';
      END IF;
      IF NEW."state" = 'failed' AND (
        NEW."result_interpretation_id" IS NOT NULL
        OR NEW."historical_audit_decision_id" IS NOT NULL
        OR NEW."historical_audit_reducer_state" IS NOT NULL
        OR NEW."historical_audit_input_evidence_signature" IS NOT NULL
      ) THEN
        RAISE EXCEPTION
          'historical archive audit operational failure cannot carry a scientific decision receipt';
      END IF;
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'historical archive audit child must settle from its claimed hydrating lifecycle';
  END IF;

  IF NEW."state" IS DISTINCT FROM OLD."state"
     OR NEW."attempt_count" IS DISTINCT FROM OLD."attempt_count"
     OR NEW."claim_token" IS DISTINCT FROM OLD."claim_token"
     OR NEW."claim_expires_at" IS DISTINCT FROM OLD."claim_expires_at" THEN
    RAISE EXCEPTION
      'historical archive audit child lifecycle is immutable after settlement';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "ri_bf_item_audit_lifecycle"
  ON "result_interpretation_backfill_items";
--> statement-breakpoint

CREATE TRIGGER "ri_bf_item_audit_lifecycle"
BEFORE INSERT OR UPDATE
ON "result_interpretation_backfill_items"
FOR EACH ROW EXECUTE FUNCTION "validate_historical_archive_audit_item_lifecycle"();
--> statement-breakpoint

-- The decision validator performs the immediate claim/source proof; this
-- deferred pair validator proves that the committing transaction left exactly
-- one final child pointing back at that decision. It also makes a later direct
-- child deletion or pointer change fail instead of silently severing forensic
-- provenance.
CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_decision_child_pair"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_decision_id uuid;
  decision_row record;
  child_count integer;
  child_row record;
BEGIN
  IF TG_TABLE_NAME = 'historical_archive_audit_decisions' THEN
    target_decision_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    target_decision_id := OLD."historical_audit_decision_id";
  ELSE
    target_decision_id := NEW."historical_audit_decision_id";
  END IF;

  IF target_decision_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- `results`/attempts intentionally cascade both the mutable child and the
  -- immutable decision. Direct child deletion remains illegal below, but a
  -- source-owner cascade is not an orphaned forensic receipt to preserve.
  IF TG_TABLE_NAME = 'result_interpretation_backfill_items'
     AND TG_OP = 'DELETE'
     AND NOT EXISTS (
       SELECT 1
       FROM "result_attempts" attempt
       WHERE attempt."id" = OLD."result_attempt_id"
         AND attempt."result_id" = OLD."result_id"
     ) THEN
    RETURN NULL;
  END IF;

  SELECT decision.*
  INTO decision_row
  FROM "historical_archive_audit_decisions" decision
  WHERE decision."id" = target_decision_id;
  IF NOT FOUND THEN
    -- Direct decision deletion is already rejected by the append-only guard.
    -- A missing decision here can therefore only be the same owner cascade
    -- above; tolerate it without weakening the live-owner false-positive path.
    IF TG_TABLE_NAME = 'result_interpretation_backfill_items'
       AND TG_OP = 'DELETE'
       AND NOT EXISTS (
         SELECT 1
         FROM "result_attempts" attempt
         WHERE attempt."id" = OLD."result_attempt_id"
           AND attempt."result_id" = OLD."result_id"
       ) THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION
      'historical archive audit child references a missing immutable decision';
  END IF;

  SELECT count(*)
  INTO child_count
  FROM "result_interpretation_backfill_items" child
  WHERE child."historical_audit_decision_id" = target_decision_id;
  IF child_count <> 1 THEN
    RAISE EXCEPTION
      'historical archive audit decision requires exactly one final child execution receipt';
  END IF;

  SELECT child.*
  INTO child_row
  FROM "result_interpretation_backfill_items" child
  WHERE child."historical_audit_decision_id" = target_decision_id;
  IF child_row."run_id" IS DISTINCT FROM decision_row."audit_run_id"
     OR child_row."result_id" IS DISTINCT FROM decision_row."result_id"
     OR child_row."result_attempt_id" IS DISTINCT FROM decision_row."result_attempt_id"
     OR child_row."source_archive_id" IS DISTINCT FROM decision_row."source_archive_id"
     OR child_row."historical_audit_reducer_state"
       IS DISTINCT FROM decision_row."reducer_state"
     OR child_row."historical_audit_input_evidence_signature"
       IS DISTINCT FROM decision_row."input_evidence_signature"
     OR child_row."attempt_count" < 1
     OR child_row."claim_token" IS NOT NULL
     OR child_row."claim_expires_at" IS NOT NULL
     OR child_row."result_interpretation_id"
       IS DISTINCT FROM decision_row."result_interpretation_id"
     OR NOT (
       (decision_row."reducer_state" = 'accepted'
         AND child_row."state" = 'reduced')
       OR (decision_row."reducer_state" = 'continuation_required'
         AND child_row."state" = 'continuation_required')
       OR (decision_row."reducer_state" = 'recovery_exhausted'
         AND child_row."state" = 'terminal_failure')
       OR (decision_row."reducer_state" = 'rerun_required'
         AND child_row."state" = 'rerun_required')
       OR (decision_row."reducer_state" = 'missing_evidence'
         AND child_row."state" = 'missing_evidence'
         AND child_row."result_interpretation_id" IS NULL)
     ) THEN
    RAISE EXCEPTION
      'historical archive audit decision and child execution receipt have incompatible identity or terminal lifecycle';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "hist_audit_decision_child_pair"
  ON "historical_archive_audit_decisions";
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "hist_audit_decision_child_pair"
AFTER INSERT
ON "historical_archive_audit_decisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_historical_archive_audit_decision_child_pair"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "ri_bf_item_audit_decision_pair"
  ON "result_interpretation_backfill_items";
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "ri_bf_item_audit_decision_pair"
AFTER INSERT OR UPDATE OR DELETE
ON "result_interpretation_backfill_items"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_historical_archive_audit_decision_child_pair"();
--> statement-breakpoint

-- Enforce the parent/child cardinality after the creating transaction has had
-- a chance to insert both rows. The matching child trigger also catches a
-- later direct deletion or retargeting. A result/attempt owner cascade removes
-- the child and decision but intentionally retains the run as a non-executable
-- historical record; only that exact missing source may leave an audit run
-- empty.
CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_run_child_shape"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_run_id uuid;
  audit_scope jsonb;
  child_count integer;
  child_source record;
BEGIN
  IF TG_TABLE_NAME = 'result_interpretation_backfill_runs' THEN
    target_run_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    target_run_id := OLD."run_id";
  ELSE
    target_run_id := NEW."run_id";
  END IF;

  SELECT audit_run."scope"
  INTO audit_scope
  FROM "result_interpretation_backfill_runs" audit_run
  WHERE audit_run."id" = target_run_id;
  IF NOT FOUND
     OR audit_scope ->> 'contract'
       IS DISTINCT FROM 'archive-clean-cycle-historical-released-audit-v1' THEN
    RETURN NULL;
  END IF;

  SELECT count(*)
  INTO child_count
  FROM "result_interpretation_backfill_items" child
  WHERE child."run_id" = target_run_id;
  IF child_count <> 1 THEN
    IF child_count = 0
       AND NOT EXISTS (
         SELECT 1
         FROM "result_attempts" attempt
         WHERE attempt."id"::text
                 = audit_scope #>> '{exactSource,resultAttemptId}'
           AND attempt."result_id"::text
                 = audit_scope #>> '{exactSource,resultId}'
       ) THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION
      'historical archive audit run requires exactly one child execution receipt';
  END IF;

  SELECT child."result_id", child."result_attempt_id", child."source_archive_id"
  INTO child_source
  FROM "result_interpretation_backfill_items" child
  WHERE child."run_id" = target_run_id;
  IF child_source."result_id"::text IS DISTINCT FROM
       audit_scope #>> '{exactSource,resultId}'
     OR child_source."result_attempt_id"::text IS DISTINCT FROM
       audit_scope #>> '{exactSource,resultAttemptId}'
     OR child_source."source_archive_id"::text IS DISTINCT FROM
       audit_scope #>> '{exactSource,sourceArchiveId}' THEN
    RAISE EXCEPTION
      'historical archive audit child does not match its parent exact source';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "ri_bf_run_audit_child_shape"
  ON "result_interpretation_backfill_runs";
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "ri_bf_run_audit_child_shape"
AFTER INSERT OR UPDATE OF "scope"
ON "result_interpretation_backfill_runs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_historical_archive_audit_run_child_shape"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "ri_bf_item_audit_parent_shape"
  ON "result_interpretation_backfill_items";
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "ri_bf_item_audit_parent_shape"
AFTER INSERT OR UPDATE OR DELETE
ON "result_interpretation_backfill_items"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_historical_archive_audit_run_child_shape"();
--> statement-breakpoint

-- An owner cascade intentionally preserves the audit run for forensic
-- traceability, but it leaves no child that can ever be reduced. Mark the
-- retained planned/running/completed run failed immediately rather than waiting for a future
-- drainer invocation to discover that its 0 children and 0 decisions do not
-- mean successful no-op work. Direct child deletion with a live source still
-- falls through to the deferred cardinality trigger above and is rejected.
CREATE OR REPLACE FUNCTION "close_historical_archive_audit_after_owner_cascade"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_scope jsonb;
BEGIN
  SELECT audit_run."scope"
  INTO audit_scope
  FROM "result_interpretation_backfill_runs" audit_run
  WHERE audit_run."id" = OLD."run_id";

  IF NOT FOUND
     OR audit_scope ->> 'contract'
       IS DISTINCT FROM 'archive-clean-cycle-historical-released-audit-v1' THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "result_attempts" attempt
    WHERE attempt."id" = OLD."result_attempt_id"
      AND attempt."result_id" = OLD."result_id"
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE "result_interpretation_backfill_runs" audit_run
  SET
    "state" = 'failed',
    "completed_at" = clock_timestamp(),
    "summary" = COALESCE(audit_run."summary", '{}'::jsonb) ||
      jsonb_build_object(
        'historicalAuditIncomplete', true,
        'historicalAuditIncompleteReason',
          'historical audit exact source owner was removed before its child execution could complete',
        'historicalAuditDecisions', 0,
        'rawEvidenceImmutable', true
      ),
    "updatedAt" = clock_timestamp()
  WHERE audit_run."id" = OLD."run_id"
    AND audit_run."state" IN ('planned', 'running', 'completed');

  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "ri_bf_item_audit_owner_cascade"
  ON "result_interpretation_backfill_items";
--> statement-breakpoint

CREATE TRIGGER "ri_bf_item_audit_owner_cascade"
AFTER DELETE
ON "result_interpretation_backfill_items"
FOR EACH ROW EXECUTE FUNCTION "close_historical_archive_audit_after_owner_cascade"();
--> statement-breakpoint

-- Most owner cascades delete the attempt before the child trigger runs. A
-- malicious or maintenance transaction can instead remove the child first and
-- the exact attempt second. In that order the child trigger correctly defers
-- to the still-live owner, so the owner-level trigger closes any now-empty
-- exact audit run after the source disappears. It is deliberately scoped by
-- the persisted three-ID contract and requires no child to remain; it never
-- treats an unrelated attempt delete as audit completion.
CREATE OR REPLACE FUNCTION "close_historical_archive_audit_after_attempt_owner_cascade"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "result_interpretation_backfill_runs" audit_run
  SET
    "state" = 'failed',
    "completed_at" = clock_timestamp(),
    "summary" = COALESCE(audit_run."summary", '{}'::jsonb) ||
      jsonb_build_object(
        'historicalAuditIncomplete', true,
        'historicalAuditIncompleteReason',
          'historical audit exact source owner was removed before its child execution could complete',
        'historicalAuditDecisions', 0,
        'rawEvidenceImmutable', true
      ),
    "updatedAt" = clock_timestamp()
  WHERE audit_run."scope" ->> 'contract'
          = 'archive-clean-cycle-historical-released-audit-v1'
    AND audit_run."scope" #>> '{exactSource,resultId}' = OLD."result_id"::text
    AND audit_run."scope" #>> '{exactSource,resultAttemptId}' = OLD."id"::text
    AND audit_run."state" IN ('planned', 'running', 'completed')
    AND NOT EXISTS (
      SELECT 1
      FROM "result_interpretation_backfill_items" child
      WHERE child."run_id" = audit_run."id"
    );

  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "result_attempt_audit_owner_cascade"
  ON "result_attempts";
--> statement-breakpoint

CREATE TRIGGER "result_attempt_audit_owner_cascade"
AFTER DELETE
ON "result_attempts"
FOR EACH ROW EXECUTE FUNCTION "close_historical_archive_audit_after_attempt_owner_cascade"();
--> statement-breakpoint

-- Rebuild the immutable decision validator so it starts with the child
-- receipt, then follows the established child -> result -> attempt/archive
-- -> artifact/blob -> audit-run lock order. The direct writer now needs an
-- actual terminal claim before it can insert a decision; the existing 0103
-- source, GCS, reducer, and no-publication proofs remain below this prefix.
CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_decision_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_interpretation_state text;
  requires_interpretation boolean := false;
  locked_child record;
  locked_result record;
  locked_attempt record;
  locked_archive record;
  locked_source_artifact record;
  locked_blob record;
  locked_audit_run record;
BEGIN
  BEGIN
    SELECT child.*
    INTO locked_child
    FROM "result_interpretation_backfill_items" child
    WHERE child."historical_audit_decision_id" = NEW."id"
    FOR UPDATE NOWAIT;
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE EXCEPTION USING
        ERRCODE = '55P03',
        MESSAGE = 'historical archive audit child receipt is locked by an active audit transaction; retry the exact audit decision';
  END;

  IF NOT FOUND
     OR locked_child."run_id" IS DISTINCT FROM NEW."audit_run_id"
     OR locked_child."result_id" IS DISTINCT FROM NEW."result_id"
     OR locked_child."result_attempt_id" IS DISTINCT FROM NEW."result_attempt_id"
     OR locked_child."source_archive_id" IS DISTINCT FROM NEW."source_archive_id"
     OR locked_child."historical_audit_reducer_state" IS DISTINCT FROM NEW."reducer_state"
     OR locked_child."historical_audit_input_evidence_signature"
       IS DISTINCT FROM NEW."input_evidence_signature"
     OR locked_child."attempt_count" < 1
     OR locked_child."claim_token" IS NOT NULL
     OR locked_child."claim_expires_at" IS NOT NULL THEN
    RAISE EXCEPTION
      'historical archive audit decision requires one exact terminal child execution receipt';
  END IF;

  CASE NEW."reducer_state"
    WHEN 'accepted' THEN
      expected_interpretation_state := 'accepted';
      requires_interpretation := true;
      IF locked_child."state" IS DISTINCT FROM 'reduced' THEN
        RAISE EXCEPTION 'historical archive audit accepted decision requires a reduced child receipt';
      END IF;
    WHEN 'continuation_required' THEN
      expected_interpretation_state := 'continuation_required';
      requires_interpretation := true;
      IF locked_child."state" IS DISTINCT FROM 'continuation_required' THEN
        RAISE EXCEPTION 'historical archive audit continuation decision requires a continuation-required child receipt';
      END IF;
    WHEN 'recovery_exhausted' THEN
      expected_interpretation_state := 'terminal_failure';
      requires_interpretation := true;
      IF locked_child."state" IS DISTINCT FROM 'terminal_failure' THEN
        RAISE EXCEPTION 'historical archive audit recovery-exhausted decision requires a terminal child receipt';
      END IF;
    WHEN 'rerun_required' THEN
      expected_interpretation_state := 'terminal_failure';
      requires_interpretation := false;
      IF locked_child."state" IS DISTINCT FROM 'rerun_required' THEN
        RAISE EXCEPTION 'historical archive audit rerun decision requires a rerun-required child receipt';
      END IF;
    WHEN 'missing_evidence' THEN
      IF locked_child."state" IS DISTINCT FROM 'missing_evidence'
         OR locked_child."result_interpretation_id" IS NOT NULL
         OR NEW."result_interpretation_id" IS NOT NULL THEN
        RAISE EXCEPTION
          'historical archive audit missing-evidence decision requires a pointer-free missing-evidence child receipt';
      END IF;
      expected_interpretation_state := NULL;
    ELSE
      RAISE EXCEPTION 'historical archive audit decision has an unsupported reducer state';
  END CASE;

  IF locked_child."result_interpretation_id"
       IS DISTINCT FROM NEW."result_interpretation_id" THEN
    RAISE EXCEPTION
      'historical archive audit decision interpretation must match its terminal child receipt';
  END IF;

  -- The decision must be checked and written against one stable released
  -- source. Do not collapse this into one joined EXISTS: a direct SQL writer
  -- could otherwise read a released/current snapshot while a concurrent
  -- publication, archive supersession, or blob correction changes it before
  -- the receipt becomes durable.
  SELECT result.*
  INTO locked_result
  FROM "results" result
  WHERE result."id" = NEW."result_id"
  FOR UPDATE;

  IF NOT FOUND
     OR locked_result."current_result_attempt_id" IS NOT NULL
     OR locked_result."current_result_interpretation_id" IS NOT NULL
     OR locked_result."current_canonical_selection_id" IS NOT NULL
     OR locked_result."status" IS DISTINCT FROM 'done'
     OR locked_result."source" IS DISTINCT FROM 'solved' THEN
    RAISE EXCEPTION
      'historical archive audit decision requires a released, completed URANS-compatible attempt with an exact current verified GCS Zstandard archive';
  END IF;

  SELECT attempt.*
  INTO locked_attempt
  FROM "result_attempts" attempt
  WHERE attempt."id" = NEW."result_attempt_id"
    AND attempt."result_id" = NEW."result_id"
  FOR UPDATE;

  IF NOT FOUND
     OR locked_attempt."status" IS DISTINCT FROM 'done'
     OR locked_attempt."source" IS DISTINCT FROM 'solved'
     OR NOT COALESCE((
       locked_attempt."regime" = 'urans'
       OR (
         locked_attempt."regime" = 'rans'
         AND locked_attempt."unsteady" IS FALSE
       )
     ), false)
     OR NOT COALESCE(
       (locked_attempt."evidence_payload" ->> 'fidelity')
         IN ('urans_precalc', 'urans_full'),
       false
     ) THEN
    RAISE EXCEPTION
      'historical archive audit decision requires a released, completed URANS-compatible attempt with an exact current verified GCS Zstandard archive';
  END IF;

  SELECT archive.*
  INTO locked_archive
  FROM "solver_evidence_archives" archive
  WHERE archive."id" = NEW."source_archive_id"
    AND archive."result_id" = NEW."result_id"
    AND archive."result_attempt_id" = NEW."result_attempt_id"
  FOR UPDATE;

  IF NOT FOUND OR locked_archive."state" IS DISTINCT FROM 'current' THEN
    RAISE EXCEPTION
      'historical archive audit decision requires a released, completed URANS-compatible attempt with an exact current verified GCS Zstandard archive';
  END IF;

  SELECT source_artifact.*
  INTO locked_source_artifact
  FROM "solver_evidence_artifacts" source_artifact
  WHERE source_artifact."id" = locked_archive."source_artifact_id"
    AND source_artifact."result_id" = NEW."result_id"
    AND source_artifact."result_attempt_id" = NEW."result_attempt_id"
  FOR UPDATE;

  IF NOT FOUND
     OR NOT COALESCE(
       locked_source_artifact."kind" IN ('engine_bundle', 'openfoam_bundle'),
       false
     ) THEN
    RAISE EXCEPTION
      'historical archive audit decision requires a released, completed URANS-compatible attempt with an exact current verified GCS Zstandard archive';
  END IF;

  SELECT blob.*
  INTO locked_blob
  FROM "solver_evidence_blobs" blob
  WHERE blob."id" = locked_archive."blob_id"
  FOR UPDATE;

  IF NOT FOUND
     OR locked_blob."backend" IS DISTINCT FROM 'gcs'
     OR btrim(COALESCE(locked_blob."bucket", '')) = ''
     OR btrim(locked_blob."bucket") <> locked_blob."bucket"
     OR btrim(COALESCE(locked_blob."object_key", '')) = ''
     OR btrim(locked_blob."object_key") <> locked_blob."object_key"
     OR locked_blob."object_key" LIKE '/%'
     OR locked_blob."object_key" ~ '(^|/)[.]{1,2}(/|$)'
     OR position(E'\\' in locked_blob."object_key") <> 0
     OR NOT COALESCE(
       locked_blob."generation" ~ '^[1-9][0-9]{0,19}$', false
     )
     OR locked_blob."compression" IS DISTINCT FROM 'zstd'
     OR locked_blob."mime_type" IS DISTINCT FROM 'application/zstd'
     OR NOT COALESCE(locked_blob."sha256" ~ '^[0-9a-f]{64}$', false)
     OR COALESCE(locked_blob."byte_size", 0) <= 0
     OR NOT COALESCE(locked_blob."crc32c" ~ '^[A-Za-z0-9+/]{6}==$', false)
     OR NOT COALESCE(
       locked_blob."uncompressed_tar_sha256" ~ '^[0-9a-f]{64}$', false
     )
     OR COALESCE(locked_blob."uncompressed_tar_byte_size", 0) <= 0
     OR locked_blob."verifiedAt" IS NULL
     OR (
       locked_blob."metadata" ->> 'archiveFormat' IS NOT NULL
       AND locked_blob."metadata" ->> 'archiveFormat' <> 'tar+zstd'
     )
     OR jsonb_typeof(locked_blob."metadata" -> 'zstdLevel') IS DISTINCT FROM 'number'
     OR locked_blob."metadata" ->> 'zstdLevel'
       !~ '^(?:[1-9]|1[0-9]|2[0-2])$' THEN
    RAISE EXCEPTION
      'historical archive audit decision requires a released, completed URANS-compatible attempt with an exact current verified GCS Zstandard archive';
  END IF;

  BEGIN
    SELECT audit_run.*
    INTO locked_audit_run
    FROM "result_interpretation_backfill_runs" audit_run
    WHERE audit_run."id" = NEW."audit_run_id"
    FOR UPDATE NOWAIT;
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE EXCEPTION USING
        ERRCODE = '55P03',
        MESSAGE = 'historical archive audit decision source is locked by an active audit transaction; retry the exact audit decision';
  END;

  IF NOT FOUND
     OR locked_audit_run."reducer_version_id" IS DISTINCT FROM NEW."reducer_version_id"
     OR locked_audit_run."state" IS DISTINCT FROM 'running'
     OR locked_audit_run."scope" ->> 'contract'
       IS DISTINCT FROM 'archive-clean-cycle-historical-released-audit-v1'
     OR locked_audit_run."scope" ->> 'canonicalSelection' IS DISTINCT FROM 'forbidden'
     OR locked_audit_run."scope" ->> 'physicalRecovery' IS DISTINCT FROM 'record-only'
     OR locked_audit_run."scope" ->> 'campaignMutation' IS DISTINCT FROM 'forbidden'
     OR locked_audit_run."scope" ->> 'rawEvidenceImmutable' IS DISTINCT FROM 'true'
     OR locked_audit_run."scope" #>> '{exactSource,resultId}'
       IS DISTINCT FROM NEW."result_id"::text
     OR locked_audit_run."scope" #>> '{exactSource,resultAttemptId}'
       IS DISTINCT FROM NEW."result_attempt_id"::text
     OR locked_audit_run."scope" #>> '{exactSource,sourceArchiveId}'
       IS DISTINCT FROM NEW."source_archive_id"::text THEN
    RAISE EXCEPTION
      'historical archive audit decision requires its exact no-publication audit run';
  END IF;

  IF requires_interpretation AND NEW."result_interpretation_id" IS NULL THEN
    RAISE EXCEPTION
      'historical archive audit decision % requires a matching historical interpretation',
      NEW."reducer_state";
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
         AND interpretation."state" = expected_interpretation_state::"result_interpretation_state"
     ) THEN
    RAISE EXCEPTION
      'historical archive audit decision % must point to a matching historical % interpretation',
      NEW."reducer_state", expected_interpretation_state;
  END IF;

  RETURN NEW;
END;
$$;
