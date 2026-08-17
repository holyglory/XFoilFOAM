-- Failed or unpublished solver generations are disposable.  This forward
-- migration removes the terminal-forensic and quarantine ledgers introduced by
-- earlier releases; accepted canonical result evidence remains on the normal
-- artifact/archive path.

-- Do not discard an accepted result through a formerly zero-owner quarantine
-- association.  Such a state is incompatible with the old model and requires
-- an explicit recovery before this removal can proceed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "solver_evidence_orphan_quarantines" quarantine
    JOIN "solver_evidence_artifacts" artifact
      ON artifact."id" = quarantine."source_artifact_id"
    LEFT JOIN "result_attempts" attempt
      ON attempt."id" = artifact."result_attempt_id"
    LEFT JOIN "result_classifications" classification
      ON classification."result_attempt_id" = attempt."id"
    WHERE classification."state" = 'accepted'
  ) OR EXISTS (
    SELECT 1
    FROM "solver_evidence_incomplete_quarantines" quarantine
    JOIN "solver_evidence_archives" archive
      ON archive."blob_id" = quarantine."blob_id"
    JOIN "result_classifications" classification
      ON classification."result_attempt_id" = archive."result_attempt_id"
    WHERE classification."state" = 'accepted'
  ) THEN
    RAISE EXCEPTION
      'refusing to remove forensic quarantine rows that are referenced by accepted canonical result evidence';
  END IF;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "results_remote_terminal_receipt_owner_fence" ON "results";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "result_attempts_remote_terminal_receipt_owner_fence" ON "result_attempts";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "results_verified_terminal_quarantine_owner_fence" ON "results";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "result_attempts_verified_terminal_quarantine_owner_fence" ON "result_attempts";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sync_remote_terminal_evidence_receipts_immutable" ON "sync_remote_terminal_evidence_receipts";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sync_remote_terminal_evidence_receipts_scope_guard" ON "sync_remote_terminal_evidence_receipts";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sync_brokered_terminal_evidence_uploads_zero_result_fence" ON "sync_brokered_terminal_evidence_uploads";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sync_brokered_terminal_evidence_uploads_immutable_verified" ON "sync_brokered_terminal_evidence_uploads";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sync_brokered_terminal_evidence_uploads_no_verified_delete" ON "sync_brokered_terminal_evidence_uploads";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "aaa_incomplete_quarantine_artifact_guard" ON "solver_evidence_artifacts";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "aaa_incomplete_quarantine_archive_guard" ON "solver_evidence_archives";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "solver_evidence_incomplete_quarantines_source_guard" ON "solver_evidence_incomplete_quarantines";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "solver_evidence_incomplete_quarantines_immutable" ON "solver_evidence_incomplete_quarantines";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "aaa_incomplete_quarantine_existing_orphan_guard" ON "solver_evidence_incomplete_quarantines";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "aaa_incomplete_quarantine_orphan_guard" ON "solver_evidence_orphan_quarantines";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "solver_evidence_orphan_quarantines_source_guard" ON "solver_evidence_orphan_quarantines";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "solver_evidence_orphan_quarantines_immutable" ON "solver_evidence_orphan_quarantines";
--> statement-breakpoint

DROP FUNCTION IF EXISTS prevent_result_ownership_of_remote_terminal_receipt();
--> statement-breakpoint
DROP FUNCTION IF EXISTS prevent_result_ownership_of_verified_terminal_quarantine();
--> statement-breakpoint
DROP FUNCTION IF EXISTS prevent_remote_terminal_evidence_receipt_mutation();
--> statement-breakpoint
DROP FUNCTION IF EXISTS enforce_remote_terminal_evidence_receipt_scope();
--> statement-breakpoint
DROP FUNCTION IF EXISTS enforce_brokered_terminal_evidence_zero_result();
--> statement-breakpoint
DROP FUNCTION IF EXISTS prevent_verified_brokered_terminal_evidence_mutation();
--> statement-breakpoint
DROP FUNCTION IF EXISTS prevent_verified_brokered_terminal_evidence_delete();
--> statement-breakpoint
DROP FUNCTION IF EXISTS enforce_solver_evidence_incomplete_quarantine();
--> statement-breakpoint
DROP FUNCTION IF EXISTS reject_solver_evidence_incomplete_quarantine_mutation();
--> statement-breakpoint
DROP FUNCTION IF EXISTS reject_existing_orphan_incomplete_quarantine();
--> statement-breakpoint
DROP FUNCTION IF EXISTS reject_artifact_incomplete_quarantine_ownership();
--> statement-breakpoint
DROP FUNCTION IF EXISTS reject_archive_incomplete_quarantine_ownership();
--> statement-breakpoint
DROP FUNCTION IF EXISTS reject_orphan_incomplete_quarantine_ownership();
--> statement-breakpoint
DROP FUNCTION IF EXISTS enforce_solver_evidence_orphan_quarantine();
--> statement-breakpoint
DROP FUNCTION IF EXISTS reject_solver_evidence_orphan_quarantine_mutation();
--> statement-breakpoint

DROP TABLE "sync_remote_terminal_evidence_receipts";
--> statement-breakpoint
DROP TABLE "sync_remote_terminal_evidence_uploads";
--> statement-breakpoint
DROP TABLE "sync_brokered_terminal_evidence_uploads";
--> statement-breakpoint
DROP TABLE "solver_evidence_incomplete_quarantines";
--> statement-breakpoint
DROP TABLE "solver_evidence_orphan_quarantines";
--> statement-breakpoint

-- Keep the content-addressed blob locator even when its obsolete quarantine
-- owner disappears.  Production cleanup deletes the exact GCS generation and
-- verifies absence before deleting this now-unowned row.  Removing the row in
-- this schema migration would make a failed external deletion untraceable and
-- permanently billable.

-- 0073 extended this pre-existing artifact immutability trigger with a
-- quarantine lookup. Restore its normal accepted-evidence definition before
-- the dropped table can be observed by a later artifact update.
CREATE OR REPLACE FUNCTION reject_linked_solver_evidence_artifact_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "solver_evidence_archives" archive
    WHERE archive."source_artifact_id" = OLD."id"
  ) OR EXISTS (
    SELECT 1 FROM "solver_evidence_artifact_members" member
    WHERE member."artifact_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'linked solver evidence artifacts are immutable';
  END IF;
  RETURN NEW;
END;
$$;
