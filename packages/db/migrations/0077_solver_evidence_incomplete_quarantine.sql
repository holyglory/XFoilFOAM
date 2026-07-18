-- Preserve the exact bytes recoverable from a terminal, incomplete solver
-- evidence package without re-labelling the forensic package as a canonical
-- result archive.  This table intentionally references only the immutable
-- physical blob; it has no result, attempt, AoA, artifact, or archive owner.
CREATE TABLE "solver_evidence_incomplete_quarantines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sim_job_id" uuid NOT NULL REFERENCES "sim_jobs"("id"),
  "engine_job_id" text NOT NULL,
  "engine_case_slug" text NOT NULL,
  "evidence_path" text NOT NULL,
  "quarantine_reason" text DEFAULT 'terminal_uningested_incomplete_archive' NOT NULL,
  "blob_id" uuid NOT NULL REFERENCES "solver_evidence_blobs"("id"),
  "original_manifest_sha256" text NOT NULL,
  "original_manifest_byte_size" bigint NOT NULL,
  "expected_member_set_sha256" text NOT NULL,
  "expected_member_count" integer NOT NULL,
  "retained_member_set_sha256" text NOT NULL,
  "retained_member_count" integer NOT NULL,
  "missing_member_set_sha256" text NOT NULL,
  "missing_member_count" integer NOT NULL,
  "expected_members" jsonb NOT NULL,
  "retained_members" jsonb NOT NULL,
  "missing_members" jsonb NOT NULL,
  "source_archives" jsonb NOT NULL,
  "package_manifest_sha256" text NOT NULL,
  "package_manifest_byte_size" bigint NOT NULL,
  "package_member_set_sha256" text NOT NULL,
  "package_member_count" integer NOT NULL,
  "package_members" jsonb NOT NULL,
  "migration_receipt_sha256" text NOT NULL,
  "migration_receipt_byte_size" bigint NOT NULL,
  "verification_mode" text NOT NULL,
  "remoteVerifiedAt" timestamp with time zone NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_evidence_incomplete_quarantines_job_evidence_uq"
    UNIQUE ("engine_job_id", "evidence_path"),
  CONSTRAINT "solver_evidence_incomplete_quarantines_blob_uq" UNIQUE ("blob_id"),
  CONSTRAINT "solver_evidence_incomplete_quarantines_job_id_check" CHECK (
    btrim("engine_job_id") <> '' AND "engine_job_id" !~ '[/\\]'
  ),
  CONSTRAINT "solver_evidence_incomplete_quarantines_case_slug_check" CHECK (
    btrim("engine_case_slug") <> ''
    AND "engine_case_slug" !~ '[/\\]'
    AND "engine_case_slug" NOT IN ('.', '..')
  ),
  CONSTRAINT "solver_evidence_incomplete_quarantines_evidence_path_check" CHECK (
    btrim("evidence_path") <> ''
    AND "evidence_path" NOT LIKE '/%'
    AND "evidence_path" !~ '(^|/)[.]{1,2}(/|$)'
    AND position(E'\\\\' in "evidence_path") = 0
  ),
  CONSTRAINT "solver_evidence_incomplete_quarantines_reason_check"
    CHECK ("quarantine_reason" = 'terminal_uningested_incomplete_archive'),
  CONSTRAINT "solver_evidence_incomplete_quarantines_identity_checks" CHECK (
    "original_manifest_sha256" ~ '^[0-9a-f]{64}$'
    AND "original_manifest_byte_size" > 0
    AND "expected_member_set_sha256" ~ '^[0-9a-f]{64}$'
    AND "retained_member_set_sha256" ~ '^[0-9a-f]{64}$'
    AND "missing_member_set_sha256" ~ '^[0-9a-f]{64}$'
    AND "package_manifest_sha256" ~ '^[0-9a-f]{64}$'
    AND "package_manifest_byte_size" > 0
    AND "package_member_set_sha256" ~ '^[0-9a-f]{64}$'
    AND "migration_receipt_sha256" ~ '^[0-9a-f]{64}$'
    AND "migration_receipt_byte_size" > 0
  ),
  CONSTRAINT "solver_evidence_incomplete_quarantines_count_checks" CHECK (
    "expected_member_count" > 0
    AND "retained_member_count" >= 0
    AND "missing_member_count" >= 0
    AND "expected_member_count" = "retained_member_count" + "missing_member_count"
    AND "package_member_count" > 0
  ),
  CONSTRAINT "solver_evidence_incomplete_quarantines_json_checks" CHECK (
    jsonb_typeof("expected_members") = 'array'
    AND jsonb_typeof("retained_members") = 'array'
    AND jsonb_typeof("missing_members") = 'array'
    AND jsonb_typeof("source_archives") = 'array'
    AND jsonb_array_length("source_archives") > 0
    AND jsonb_typeof("package_members") = 'array'
  )
);
--> statement-breakpoint
CREATE INDEX "solver_evidence_incomplete_quarantines_sim_job_idx"
  ON "solver_evidence_incomplete_quarantines" ("sim_job_id");
--> statement-breakpoint
CREATE INDEX "solver_evidence_incomplete_quarantines_created_idx"
  ON "solver_evidence_incomplete_quarantines" ("createdAt");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_solver_evidence_incomplete_quarantine()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item record;
  source record;
  expected_digest bytea := ''::bytea;
  retained_digest bytea := ''::bytea;
  missing_digest bytea := ''::bytea;
  package_digest bytea := ''::bytea;
  corrupt_sources integer := 0;
  base_storage_key text := 'jobs/' || NEW."engine_job_id" || '/' || NEW."evidence_path" || '/';
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM "sim_jobs" job
      JOIN "solver_evidence_blobs" blob ON blob."id" = NEW."blob_id"
     WHERE job."id" = NEW."sim_job_id"
       AND job."engine_job_id" = NEW."engine_job_id"
       AND job."status" IN ('done', 'failed', 'cancelled')
       AND blob."backend" = 'gcs'
       AND blob."compression" = 'zstd'
       AND blob."mime_type" = 'application/zstd'
       AND blob."object_key" =
         'solver-evidence-partial/v1/sha256/' || substr(blob."sha256", 1, 2) ||
         '/' || blob."sha256" || '.tar.zst'
  ) THEN
    RAISE EXCEPTION 'incomplete quarantine must reference one terminal job and exact partial-evidence GCS blob';
  END IF;
  IF split_part(NEW."evidence_path", '/', 1) <> 'cases'
     OR split_part(NEW."evidence_path", '/', 2) <> NEW."engine_case_slug"
     OR split_part(NEW."evidence_path", '/', 3) = '' THEN
    RAISE EXCEPTION 'incomplete quarantine evidence path does not match its engine case';
  END IF;

  -- The outer engine case can legitimately own results for sibling angles.
  -- Only an artifact under this exact evidence path means that this package
  -- has already acquired canonical evidence ownership.
  IF EXISTS (
    SELECT 1 FROM "solver_evidence_artifacts" artifact
     WHERE artifact."engine_job_id" = NEW."engine_job_id"
       AND left(artifact."storage_key", length(base_storage_key)) = base_storage_key
  ) THEN
    RAISE EXCEPTION 'exact evidence path already has canonical artifact ownership';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "solver_evidence_archives" archive
     WHERE archive."blob_id" = NEW."blob_id"
  ) THEN
    RAISE EXCEPTION 'partial-evidence blob is already owned by a canonical solver archive';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "solver_evidence_orphan_quarantines" orphaned
     WHERE orphaned."blob_id" = NEW."blob_id"
        OR (
          orphaned."engine_job_id" = NEW."engine_job_id"
          AND orphaned."evidence_path" = NEW."evidence_path"
        )
  ) THEN
    RAISE EXCEPTION 'partial evidence already has orphan quarantine ownership';
  END IF;

  IF jsonb_array_length(NEW."expected_members") <> NEW."expected_member_count"
     OR jsonb_array_length(NEW."retained_members") <> NEW."retained_member_count"
     OR jsonb_array_length(NEW."missing_members") <> NEW."missing_member_count"
     OR jsonb_array_length(NEW."package_members") <> NEW."package_member_count" THEN
    RAISE EXCEPTION 'incomplete quarantine member count mismatch';
  END IF;

  FOR item IN
    SELECT value AS entry FROM jsonb_array_elements(NEW."expected_members")
     ORDER BY (value ->> 'path') COLLATE "C"
  LOOP
    IF jsonb_typeof(item.entry) <> 'object'
       OR COALESCE(item.entry ->> 'path', '') = ''
       OR (item.entry ->> 'path') LIKE '/%'
       OR (item.entry ->> 'path') ~ '(^|/)[.]{1,2}(/|$)'
       OR position(E'\\\\' in (item.entry ->> 'path')) <> 0
       OR COALESCE(item.entry ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(item.entry -> 'byteSize') <> 'number'
       OR (item.entry ->> 'byteSize') !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'incomplete quarantine contains malformed expected member';
    END IF;
    expected_digest := expected_digest
      || convert_to(item.entry ->> 'path', 'UTF8') || decode('00', 'hex')
      || convert_to(item.entry ->> 'sha256', 'UTF8') || decode('00', 'hex')
      || convert_to(((item.entry ->> 'byteSize')::bigint)::text, 'UTF8')
      || convert_to(E'\n', 'UTF8');
  END LOOP;
  IF (SELECT count(DISTINCT value ->> 'path') FROM jsonb_array_elements(NEW."expected_members"))
       <> NEW."expected_member_count"
     OR encode(sha256(expected_digest), 'hex') <> NEW."expected_member_set_sha256" THEN
    RAISE EXCEPTION 'incomplete quarantine expected member identity mismatch';
  END IF;

  FOR item IN
    SELECT value AS entry FROM jsonb_array_elements(NEW."package_members")
     ORDER BY (value ->> 'path') COLLATE "C"
  LOOP
    IF jsonb_typeof(item.entry) <> 'object'
       OR COALESCE(item.entry ->> 'path', '') = ''
       OR (item.entry ->> 'path') LIKE '/%'
       OR (item.entry ->> 'path') ~ '(^|/)[.]{1,2}(/|$)'
       OR position(E'\\\\' in (item.entry ->> 'path')) <> 0
       OR COALESCE(item.entry ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(item.entry -> 'byteSize') <> 'number'
       OR (item.entry ->> 'byteSize') !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'incomplete quarantine contains malformed package member';
    END IF;
    package_digest := package_digest
      || convert_to(item.entry ->> 'path', 'UTF8') || decode('00', 'hex')
      || convert_to(item.entry ->> 'sha256', 'UTF8') || decode('00', 'hex')
      || convert_to(((item.entry ->> 'byteSize')::bigint)::text, 'UTF8')
      || convert_to(E'\n', 'UTF8');
  END LOOP;
  IF (SELECT count(DISTINCT value ->> 'path') FROM jsonb_array_elements(NEW."package_members"))
       <> NEW."package_member_count"
     OR encode(sha256(package_digest), 'hex') <> NEW."package_member_set_sha256" THEN
    RAISE EXCEPTION 'incomplete quarantine package member identity mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW."package_members") member
     WHERE member ->> 'path' = 'original/evidence_manifest.json'
       AND member ->> 'sha256' = NEW."original_manifest_sha256"
       AND (member ->> 'byteSize')::bigint = NEW."original_manifest_byte_size"
  ) THEN
    RAISE EXCEPTION 'incomplete quarantine package lacks the exact original manifest';
  END IF;

  FOR item IN
    SELECT value AS entry FROM jsonb_array_elements(NEW."retained_members")
     ORDER BY (value ->> 'path') COLLATE "C"
  LOOP
    IF jsonb_typeof(item.entry) <> 'object'
       OR COALESCE(item.entry ->> 'path', '') = ''
       OR (item.entry ->> 'path') LIKE '/%'
       OR (item.entry ->> 'path') ~ '(^|/)[.]{1,2}(/|$)'
       OR position(E'\\\\' in (item.entry ->> 'path')) <> 0
       OR COALESCE(item.entry ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(item.entry -> 'byteSize') <> 'number'
       OR (item.entry ->> 'byteSize') !~ '^(0|[1-9][0-9]*)$'
       OR COALESCE(item.entry ->> 'packagePath', '') = ''
       OR item.entry ->> 'packagePath' <> 'retained/' || (item.entry ->> 'path')
       OR (item.entry ->> 'packagePath') LIKE '/%'
       OR (item.entry ->> 'packagePath') ~ '(^|/)[.]{1,2}(/|$)'
       OR position(E'\\\\' in (item.entry ->> 'packagePath')) <> 0
       OR jsonb_typeof(item.entry -> 'sources') <> 'array'
       OR jsonb_array_length(item.entry -> 'sources') = 0 THEN
      RAISE EXCEPTION 'incomplete quarantine contains malformed retained member';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW."expected_members") expected
       WHERE expected ->> 'path' = item.entry ->> 'path'
         AND expected ->> 'sha256' = item.entry ->> 'sha256'
         AND (expected ->> 'byteSize')::bigint = (item.entry ->> 'byteSize')::bigint
    ) OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW."package_members") packaged
       WHERE packaged ->> 'path' = item.entry ->> 'packagePath'
         AND packaged ->> 'sha256' = item.entry ->> 'sha256'
         AND (packaged ->> 'byteSize')::bigint = (item.entry ->> 'byteSize')::bigint
    ) THEN
      RAISE EXCEPTION 'retained member does not match original and package manifests';
    END IF;
    FOR source IN SELECT value AS entry FROM jsonb_array_elements(item.entry -> 'sources') LOOP
      IF jsonb_typeof(source.entry) <> 'object'
         OR COALESCE(source.entry ->> 'kind', '') NOT IN (
           'local_raw', 'corrupt_archive_member', 'sibling_archive_member'
         ) THEN
        RAISE EXCEPTION 'retained member contains malformed source provenance';
      END IF;
      IF source.entry ->> 'kind' = 'local_raw' THEN
        IF COALESCE(source.entry ->> 'sourcePath', '') = ''
           OR (source.entry ->> 'sourcePath') LIKE '/%'
           OR (source.entry ->> 'sourcePath') ~ '(^|/)[.]{1,2}(/|$)'
           OR position(E'\\\\' in (source.entry ->> 'sourcePath')) <> 0 THEN
          RAISE EXCEPTION 'local retained member source lacks its exact path';
        END IF;
        IF source.entry ->> 'sourcePath' <> item.entry ->> 'path' THEN
          RAISE EXCEPTION 'local retained member source path does not match its member';
        END IF;
      ELSE
        IF COALESCE(source.entry ->> 'sourceArchiveSha256', '') !~ '^[0-9a-f]{64}$'
           OR COALESCE(source.entry ->> 'memberPath', '') = ''
           OR (source.entry ->> 'memberPath') LIKE '/%'
           OR (source.entry ->> 'memberPath') ~ '(^|/)[.]{1,2}(/|$)'
           OR position(E'\\\\' in (source.entry ->> 'memberPath')) <> 0
           OR NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(NEW."source_archives") archive
              WHERE archive ->> 'sha256' = source.entry ->> 'sourceArchiveSha256'
                AND (
                  (source.entry ->> 'kind' = 'corrupt_archive_member'
                    AND archive ->> 'role' = 'corrupt_original')
                  OR (source.entry ->> 'kind' = 'sibling_archive_member'
                    AND archive ->> 'role' = 'recovery_sibling')
                )
           ) THEN
          RAISE EXCEPTION 'archive member source lacks exact archive provenance';
        END IF;
        IF source.entry ->> 'memberPath' <> item.entry ->> 'path' THEN
          RAISE EXCEPTION 'archive member source path does not match its member';
        END IF;
      END IF;
    END LOOP;
    retained_digest := retained_digest
      || convert_to(item.entry ->> 'path', 'UTF8') || decode('00', 'hex')
      || convert_to(item.entry ->> 'sha256', 'UTF8') || decode('00', 'hex')
      || convert_to(((item.entry ->> 'byteSize')::bigint)::text, 'UTF8')
      || convert_to(E'\n', 'UTF8');
  END LOOP;
  IF (SELECT count(DISTINCT value ->> 'path') FROM jsonb_array_elements(NEW."retained_members"))
       <> NEW."retained_member_count"
     OR encode(sha256(retained_digest), 'hex') <> NEW."retained_member_set_sha256" THEN
    RAISE EXCEPTION 'incomplete quarantine retained member identity mismatch';
  END IF;

  FOR item IN
    SELECT value AS entry FROM jsonb_array_elements(NEW."missing_members")
     ORDER BY (value ->> 'path') COLLATE "C"
  LOOP
    IF jsonb_typeof(item.entry) <> 'object'
       OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(NEW."expected_members") expected
          WHERE expected ->> 'path' = item.entry ->> 'path'
            AND expected ->> 'sha256' = item.entry ->> 'sha256'
            AND (expected ->> 'byteSize')::bigint = (item.entry ->> 'byteSize')::bigint
       ) THEN
      RAISE EXCEPTION 'missing member does not match original manifest';
    END IF;
    missing_digest := missing_digest
      || convert_to(item.entry ->> 'path', 'UTF8') || decode('00', 'hex')
      || convert_to(item.entry ->> 'sha256', 'UTF8') || decode('00', 'hex')
      || convert_to(((item.entry ->> 'byteSize')::bigint)::text, 'UTF8')
      || convert_to(E'\n', 'UTF8');
  END LOOP;
  IF (SELECT count(DISTINCT value ->> 'path') FROM jsonb_array_elements(NEW."missing_members"))
       <> NEW."missing_member_count"
     OR encode(sha256(missing_digest), 'hex') <> NEW."missing_member_set_sha256" THEN
    RAISE EXCEPTION 'incomplete quarantine missing member identity mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW."expected_members") expected
     WHERE (
       SELECT count(*) FROM jsonb_array_elements(NEW."retained_members") retained
        WHERE retained ->> 'path' = expected ->> 'path'
     ) + (
       SELECT count(*) FROM jsonb_array_elements(NEW."missing_members") missing
        WHERE missing ->> 'path' = expected ->> 'path'
     ) <> 1
  ) THEN
    RAISE EXCEPTION 'retained and missing members do not partition the original manifest';
  END IF;

  FOR item IN SELECT value AS entry FROM jsonb_array_elements(NEW."source_archives") LOOP
    IF jsonb_typeof(item.entry) <> 'object'
       OR COALESCE(item.entry ->> 'role', '') NOT IN ('corrupt_original', 'recovery_sibling')
       OR COALESCE(item.entry ->> 'jobId', '') = ''
       OR (item.entry ->> 'jobId') ~ '[/\\\\]'
       OR (item.entry ->> 'jobId') IN ('.', '..')
       OR COALESCE(item.entry ->> 'evidencePath', '') = ''
       OR (item.entry ->> 'evidencePath') LIKE '/%'
       OR (item.entry ->> 'evidencePath') ~ '(^|/)[.]{1,2}(/|$)'
       OR position(E'\\\\' in (item.entry ->> 'evidencePath')) <> 0
       OR COALESCE(item.entry ->> 'path', '') = ''
       OR (item.entry ->> 'path') LIKE '/%'
       OR (item.entry ->> 'path') ~ '(^|/)[.]{1,2}(/|$)'
       OR position(E'\\\\' in (item.entry ->> 'path')) <> 0
       OR COALESCE(item.entry ->> 'compression', '') NOT IN ('gzip', 'zstd')
       OR COALESCE(item.entry ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(item.entry -> 'byteSize') <> 'number'
       OR (item.entry ->> 'byteSize') !~ '^[1-9][0-9]*$'
       OR ((item.entry ? 'uncompressedTarSha256') <> (item.entry ? 'uncompressedTarByteSize'))
       OR (
         item.entry ? 'uncompressedTarSha256'
         AND (
           COALESCE(item.entry ->> 'uncompressedTarSha256', '') !~ '^[0-9a-f]{64}$'
           OR jsonb_typeof(item.entry -> 'uncompressedTarByteSize') <> 'number'
           OR (item.entry ->> 'uncompressedTarByteSize') !~ '^[1-9][0-9]*$'
         )
       ) THEN
      RAISE EXCEPTION 'incomplete quarantine contains malformed source archive';
    END IF;
    IF item.entry ->> 'role' = 'corrupt_original' THEN
      corrupt_sources := corrupt_sources + 1;
      IF item.entry ->> 'jobId' <> NEW."engine_job_id"
         OR item.entry ->> 'evidencePath' <> NEW."evidence_path"
         OR item.entry ->> 'compression' <> 'gzip'
         OR item.entry ->> 'integrity' <> 'truncated'
         OR item.entry ->> 'packagePath' <> 'original/openfoam_evidence.tar.gz'
         OR (item.entry ->> 'packagePath') LIKE '/%'
         OR (item.entry ->> 'packagePath') ~ '(^|/)[.]{1,2}(/|$)'
         OR position(E'\\\\' in (item.entry ->> 'packagePath')) <> 0
         OR COALESCE(item.entry ->> 'terminalError', '') = ''
         OR jsonb_typeof(item.entry -> 'readableTarByteSize') <> 'number'
         OR (item.entry ->> 'readableTarByteSize') !~ '^[1-9][0-9]*$'
         OR NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(NEW."package_members") packaged
            WHERE packaged ->> 'path' = item.entry ->> 'packagePath'
              AND packaged ->> 'sha256' = item.entry ->> 'sha256'
              AND (packaged ->> 'byteSize')::bigint = (item.entry ->> 'byteSize')::bigint
         ) THEN
        RAISE EXCEPTION 'corrupt original archive provenance is incomplete';
      END IF;
    ELSIF item.entry ->> 'integrity' <> 'verified_complete'
       OR NOT (item.entry ? 'uncompressedTarSha256') THEN
      RAISE EXCEPTION 'recovery sibling archive was not completely verified';
    END IF;
  END LOOP;
  IF corrupt_sources <> 1 THEN
    RAISE EXCEPTION 'incomplete quarantine requires exactly one corrupt original archive';
  END IF;

  IF NEW."verification_mode" <>
       'archive+manifest+all-members-restore:' || NEW."package_member_count"::text THEN
    RAISE EXCEPTION 'incomplete quarantine verification does not cover every package member';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_evidence_incomplete_quarantines_source_guard"
BEFORE INSERT ON "solver_evidence_incomplete_quarantines"
FOR EACH ROW EXECUTE FUNCTION enforce_solver_evidence_incomplete_quarantine();
--> statement-breakpoint

-- Reciprocal ownership guards keep the quarantine true after registration.
-- The registration transaction fences these tables while inserting the
-- incomplete record; these guards prevent every later canonical association.
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
CREATE TRIGGER "aaa_incomplete_quarantine_orphan_guard"
BEFORE INSERT OR UPDATE ON "solver_evidence_orphan_quarantines"
FOR EACH ROW EXECUTE FUNCTION reject_orphan_incomplete_quarantine_ownership();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_solver_evidence_incomplete_quarantine_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'solver evidence incomplete quarantines are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_evidence_incomplete_quarantines_immutable"
BEFORE UPDATE OR DELETE ON "solver_evidence_incomplete_quarantines"
FOR EACH ROW EXECUTE FUNCTION reject_solver_evidence_incomplete_quarantine_mutation();
