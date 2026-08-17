-- Historical released-evidence audit receipts are append-only scientific
-- provenance, never a path back into live publication.  Tighten the 0102
-- validator at the write boundary: a decision must still name one released
-- result, its exact completed URANS-compatible attempt, and that attempt's
-- current, verified, generation-pinned GCS tar+zstd archive.  The decision
-- state must also agree with the optional historical interpretation pointer.
--
-- This is deliberately a forward replacement of the validator rather than an
-- edit to 0102.  Existing immutable receipts retain their recorded facts;
-- new receipts cannot weaken the provenance contract.
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_decision_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_interpretation_state text;
  requires_interpretation boolean := false;
  locked_result record;
  locked_attempt record;
  locked_archive record;
  locked_source_artifact record;
  locked_blob record;
  locked_audit_run record;
BEGIN
  -- The decision must be checked and written against one stable released
  -- source.  Do not collapse this into one joined EXISTS: a direct SQL writer
  -- could otherwise read a released/current snapshot while a concurrent
  -- publication, archive supersession, or blob correction changes it before
  -- the receipt becomes durable.  Keep this result -> attempt -> archive ->
  -- artifact -> blob order aligned with the historical settlement path (after
  -- its child receipt), so normal source mutation waits instead of creating a
  -- cross-table lock cycle.
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

  -- The application-owned settlement takes the run lock after the exact
  -- source.  Follow that order here as well.  `NOWAIT` is deliberate: a
  -- staging transaction may already own the run while it waits for a source
  -- mutation, so blocking here after holding the source could form a cycle.
  -- A direct writer gets a retryable failure instead of committing a decision
  -- against a run that is concurrently being settled or cancelled.
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

  -- The decision is a summary of the staged immutable interpretation, not a
  -- second mutable interpretation state.  Keep the mapping explicit so a
  -- malformed direct SQL insert cannot label an accepted/terminal record as a
  -- different reducer outcome.  A cadence-free rerun may legitimately have
  -- no interpretation; if it has one, it must be a historical terminal row.
  CASE NEW."reducer_state"
    WHEN 'accepted' THEN
      expected_interpretation_state := 'accepted';
      requires_interpretation := true;
    WHEN 'continuation_required' THEN
      expected_interpretation_state := 'continuation_required';
      requires_interpretation := true;
    WHEN 'recovery_exhausted' THEN
      expected_interpretation_state := 'terminal_failure';
      requires_interpretation := true;
    WHEN 'rerun_required' THEN
      expected_interpretation_state := 'terminal_failure';
      requires_interpretation := false;
    WHEN 'missing_evidence' THEN
      IF NEW."result_interpretation_id" IS NOT NULL THEN
        RAISE EXCEPTION
          'historical archive audit missing_evidence decision must not point to an interpretation';
      END IF;
      RETURN NEW;
    ELSE
      RAISE EXCEPTION 'historical archive audit decision has an unsupported reducer state';
  END CASE;

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
