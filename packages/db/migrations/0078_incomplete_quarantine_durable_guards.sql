-- Upgrade databases that applied an earlier form of migration 0077.
--
-- A forensic quarantine may retain every declared member (zero missing) or no
-- declared members (zero retained).  In both cases the package and original
-- manifest remain non-empty and the retained/missing partition must exactly
-- conserve the expected member count.
ALTER TABLE "solver_evidence_incomplete_quarantines"
  DROP CONSTRAINT IF EXISTS "solver_evidence_incomplete_quarantines_count_checks";
--> statement-breakpoint
ALTER TABLE "solver_evidence_incomplete_quarantines"
  ADD CONSTRAINT "solver_evidence_incomplete_quarantines_count_checks" CHECK (
    "expected_member_count" > 0
    AND "retained_member_count" >= 0
    AND "missing_member_count" >= 0
    AND "expected_member_count" = "retained_member_count" + "missing_member_count"
    AND "package_member_count" > 0
  );
--> statement-breakpoint

-- Older 0077 installations did not reject an orphan quarantine that already
-- owned the same physical blob or exact engine evidence path.  Keep this as a
-- separate guard so upgrading does not need to replace the large forensic
-- manifest-validation function installed by 0077.
CREATE OR REPLACE FUNCTION reject_existing_orphan_incomplete_quarantine()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "solver_evidence_orphan_quarantines" orphaned
     WHERE orphaned."blob_id" = NEW."blob_id"
        OR (
          orphaned."engine_job_id" = NEW."engine_job_id"
          AND orphaned."evidence_path" = NEW."evidence_path"
        )
  ) THEN
    RAISE EXCEPTION 'partial evidence already has orphan quarantine ownership';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "aaa_incomplete_quarantine_existing_orphan_guard"
  ON "solver_evidence_incomplete_quarantines";
--> statement-breakpoint
CREATE TRIGGER "aaa_incomplete_quarantine_existing_orphan_guard"
BEFORE INSERT ON "solver_evidence_incomplete_quarantines"
FOR EACH ROW EXECUTE FUNCTION reject_existing_orphan_incomplete_quarantine();
--> statement-breakpoint

-- Reciprocal guards keep incomplete quarantine blob/path ownership exclusive
-- after registration.  CREATE OR REPLACE plus DROP/CREATE TRIGGER makes this
-- migration safe both after the current 0077 and after an older applied 0077.
CREATE OR REPLACE FUNCTION reject_artifact_incomplete_quarantine_ownership()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."engine_job_id" IS NOT NULL AND EXISTS (
    SELECT 1
      FROM "solver_evidence_incomplete_quarantines" incomplete
     WHERE incomplete."engine_job_id" = NEW."engine_job_id"
       AND left(
         NEW."storage_key",
         length(
           'jobs/' || incomplete."engine_job_id" || '/' ||
           incomplete."evidence_path" || '/'
         )
       ) =
         'jobs/' || incomplete."engine_job_id" || '/' ||
         incomplete."evidence_path" || '/'
  ) THEN
    RAISE EXCEPTION 'solver evidence artifact conflicts with immutable incomplete quarantine exact path';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "aaa_incomplete_quarantine_artifact_guard"
  ON "solver_evidence_artifacts";
--> statement-breakpoint
CREATE TRIGGER "aaa_incomplete_quarantine_artifact_guard"
BEFORE INSERT OR UPDATE ON "solver_evidence_artifacts"
FOR EACH ROW EXECUTE FUNCTION reject_artifact_incomplete_quarantine_ownership();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_archive_incomplete_quarantine_ownership()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "solver_evidence_incomplete_quarantines" incomplete
     WHERE incomplete."blob_id" = NEW."blob_id"
  ) THEN
    RAISE EXCEPTION 'solver evidence archive cannot own an incomplete quarantine blob';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "aaa_incomplete_quarantine_archive_guard"
  ON "solver_evidence_archives";
--> statement-breakpoint
CREATE TRIGGER "aaa_incomplete_quarantine_archive_guard"
BEFORE INSERT OR UPDATE ON "solver_evidence_archives"
FOR EACH ROW EXECUTE FUNCTION reject_archive_incomplete_quarantine_ownership();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_orphan_incomplete_quarantine_ownership()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "solver_evidence_incomplete_quarantines" incomplete
     WHERE incomplete."blob_id" = NEW."blob_id"
        OR (
          incomplete."engine_job_id" = NEW."engine_job_id"
          AND incomplete."evidence_path" = NEW."evidence_path"
        )
  ) THEN
    RAISE EXCEPTION 'solver evidence orphan quarantine conflicts with immutable incomplete quarantine blob or exact path';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "aaa_incomplete_quarantine_orphan_guard"
  ON "solver_evidence_orphan_quarantines";
--> statement-breakpoint
CREATE TRIGGER "aaa_incomplete_quarantine_orphan_guard"
BEFORE INSERT OR UPDATE ON "solver_evidence_orphan_quarantines"
FOR EACH ROW EXECUTE FUNCTION reject_orphan_incomplete_quarantine_ownership();
