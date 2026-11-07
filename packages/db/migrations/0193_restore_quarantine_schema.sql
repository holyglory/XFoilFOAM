DO $repair$
DECLARE
  table_specs jsonb := jsonb_build_array(
    jsonb_build_object(
      'name', 'solver_evidence_orphan_quarantines',
      'definition', $definition$
CREATE TABLE "solver_evidence_orphan_quarantines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sim_job_id" uuid NOT NULL REFERENCES "sim_jobs"("id"),
  "engine_job_id" text NOT NULL,
  "engine_case_slug" text NOT NULL,
  "evidence_path" text NOT NULL,
  "quarantine_reason" text DEFAULT 'terminal_engine_evidence_not_ingested' NOT NULL,
  "source_artifact_id" uuid NOT NULL REFERENCES "solver_evidence_artifacts"("id"),
  "blob_id" uuid NOT NULL REFERENCES "solver_evidence_blobs"("id"),
  "manifest_sha256" text NOT NULL,
  "manifest_byte_size" bigint NOT NULL,
  "archive_member_set_sha256" text NOT NULL,
  "archive_member_count" integer NOT NULL,
  "archive_members" jsonb NOT NULL,
  "source_archives" jsonb NOT NULL,
  "migration_receipt_sha256" text NOT NULL,
  "migration_receipt_byte_size" bigint NOT NULL,
  "verification_mode" text NOT NULL,
  "remoteVerifiedAt" timestamp with time zone NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_evidence_orphan_quarantines_job_evidence_uq"
    UNIQUE ("engine_job_id", "evidence_path"),
  CONSTRAINT "solver_evidence_orphan_quarantines_source_artifact_uq"
    UNIQUE ("source_artifact_id"),
  CONSTRAINT "solver_evidence_orphan_quarantines_job_id_check" CHECK (
    btrim("engine_job_id") <> '' AND "engine_job_id" !~ '[/\\]'
  ),
  CONSTRAINT "solver_evidence_orphan_quarantines_case_slug_check" CHECK (
    btrim("engine_case_slug") <> ''
    AND "engine_case_slug" !~ '[/\\]'
    AND "engine_case_slug" NOT IN ('.', '..')
  ),
  CONSTRAINT "solver_evidence_orphan_quarantines_evidence_path_check" CHECK (
    btrim("evidence_path") <> ''
    AND "evidence_path" NOT LIKE '/%'
    AND "evidence_path" !~ '(^|/)[.]{1,2}(/|$)'
    AND position(E'\\\\' in "evidence_path") = 0
  ),
  CONSTRAINT "solver_evidence_orphan_quarantines_reason_check"
    CHECK ("quarantine_reason" = 'terminal_engine_evidence_not_ingested'),
  CONSTRAINT "solver_evidence_orphan_quarantines_manifest_sha_check"
    CHECK ("manifest_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "solver_evidence_orphan_quarantines_manifest_size_check"
    CHECK ("manifest_byte_size" > 0),
  CONSTRAINT "solver_evidence_orphan_quarantines_member_set_sha_check"
    CHECK ("archive_member_set_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "solver_evidence_orphan_quarantines_member_count_check"
    CHECK ("archive_member_count" > 0),
  CONSTRAINT "solver_evidence_orphan_quarantines_archive_members_check"
    CHECK (jsonb_typeof("archive_members") = 'array'),
  CONSTRAINT "solver_evidence_orphan_quarantines_source_archives_check"
    CHECK (jsonb_typeof("source_archives") = 'array' AND jsonb_array_length("source_archives") > 0),
  CONSTRAINT "solver_evidence_orphan_quarantines_receipt_sha_check"
    CHECK ("migration_receipt_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "solver_evidence_orphan_quarantines_receipt_size_check"
    CHECK ("migration_receipt_byte_size" > 0)
);
$definition$,
      'indexes', jsonb_build_array($definition$
CREATE INDEX "solver_evidence_orphan_quarantines_sim_job_idx"
  ON "solver_evidence_orphan_quarantines" ("sim_job_id");
$definition$, $definition$
CREATE INDEX "solver_evidence_orphan_quarantines_blob_idx"
  ON "solver_evidence_orphan_quarantines" ("blob_id");
$definition$, $definition$
CREATE INDEX "solver_evidence_orphan_quarantines_created_idx"
  ON "solver_evidence_orphan_quarantines" ("createdAt");
$definition$),
      'foreignKeys', '[{"column":"sim_job_id","table":"sim_jobs","target":"id"},{"column":"source_artifact_id","table":"solver_evidence_artifacts","target":"id"},{"column":"blob_id","table":"solver_evidence_blobs","target":"id"}]'::jsonb
    ),
    jsonb_build_object(
      'name', 'solver_evidence_incomplete_quarantines',
      'definition', $definition$
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
$definition$,
      'indexes', jsonb_build_array($definition$
CREATE INDEX "solver_evidence_incomplete_quarantines_sim_job_idx"
  ON "solver_evidence_incomplete_quarantines" ("sim_job_id");
$definition$, $definition$
CREATE INDEX "solver_evidence_incomplete_quarantines_created_idx"
  ON "solver_evidence_incomplete_quarantines" ("createdAt");
$definition$),
      'foreignKeys', '[{"column":"sim_job_id","table":"sim_jobs","target":"id"},{"column":"blob_id","table":"solver_evidence_blobs","target":"id"}]'::jsonb
    )
  );
  function_specs jsonb := jsonb_build_array(
    jsonb_build_object(
      'name', 'enforce_solver_evidence_orphan_quarantine',
      'definition', $definition$
CREATE OR REPLACE FUNCTION enforce_solver_evidence_orphan_quarantine()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  member record;
  canonical_members bytea := ''::bytea;
  manifest_count integer := 0;
  source_count integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM "solver_evidence_artifacts" artifact
      JOIN "solver_evidence_blobs" blob ON blob."id" = NEW."blob_id"
      JOIN "sim_jobs" job ON job."id" = NEW."sim_job_id"
     WHERE artifact."id" = NEW."source_artifact_id"
       AND artifact."result_id" IS NULL
       AND artifact."result_attempt_id" IS NULL
       AND artifact."aoa_deg" IS NULL
       AND artifact."sim_job_id" = NEW."sim_job_id"
       AND artifact."airfoil_id" = job."airfoil_id"
       AND artifact."engine_job_id" = NEW."engine_job_id"
       AND artifact."engine_case_slug" = NEW."engine_case_slug"
       AND artifact."kind" = 'engine_bundle'
       AND artifact."storage_key" = 'jobs/' || NEW."engine_job_id" || '/' || NEW."evidence_path" || '/engine_evidence.tar.zst'
       AND artifact."mime_type" = 'application/zstd'
       AND artifact."sha256" = blob."sha256"
       AND artifact."byte_size" = blob."byte_size"
       AND job."engine_job_id" = NEW."engine_job_id"
       AND job."status" IN ('done', 'failed', 'cancelled')
       AND blob."backend" = 'gcs'
       AND blob."compression" = 'zstd'
       AND blob."mime_type" = 'application/zstd'
       AND (
         blob."object_key" =
           'sha256/' || substr(blob."sha256", 1, 2) || '/' ||
           blob."sha256" || '.tar.zst'
         OR right(
           blob."object_key",
           length(
             '/sha256/' || substr(blob."sha256", 1, 2) || '/' ||
             blob."sha256" || '.tar.zst'
           )
         ) =
           '/sha256/' || substr(blob."sha256", 1, 2) || '/' ||
           blob."sha256" || '.tar.zst'
       )
  ) THEN
    RAISE EXCEPTION 'orphan quarantine must reference one exact unbound GCS bundle artifact and sim job';
  END IF;
  IF split_part(NEW."evidence_path", '/', 1) <> 'cases'
     OR split_part(NEW."evidence_path", '/', 2) <> NEW."engine_case_slug"
     OR split_part(NEW."evidence_path", '/', 3) = '' THEN
    RAISE EXCEPTION 'orphan quarantine evidence path does not match its exact engine case';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "result_attempts" attempt
     WHERE attempt."sim_job_id" = NEW."sim_job_id"
       AND attempt."engine_job_id" = NEW."engine_job_id"
       AND attempt."engine_case_slug" = NEW."engine_case_slug"
  ) OR EXISTS (
    SELECT 1 FROM "results" result
     WHERE result."sim_job_id" = NEW."sim_job_id"
       AND result."engine_job_id" = NEW."engine_job_id"
       AND result."engine_case_slug" = NEW."engine_case_slug"
  ) THEN
    RAISE EXCEPTION 'exact result ownership exists; evidence cannot be quarantined as orphan';
  END IF;

  IF jsonb_array_length(NEW."archive_members") <> NEW."archive_member_count" THEN
    RAISE EXCEPTION 'orphan quarantine archive member count mismatch';
  END IF;
  IF (
    SELECT count(DISTINCT value ->> 'path')
      FROM jsonb_array_elements(NEW."archive_members")
  ) <> NEW."archive_member_count" THEN
    RAISE EXCEPTION 'orphan quarantine contains duplicate archive member paths';
  END IF;
  FOR member IN
    SELECT value AS item
      FROM jsonb_array_elements(NEW."archive_members")
     ORDER BY (value ->> 'path') COLLATE "C"
  LOOP
    IF jsonb_typeof(member.item) <> 'object'
       OR COALESCE(member.item ->> 'path', '') = ''
       OR (member.item ->> 'path') LIKE '/%'
       OR (member.item ->> 'path') ~ '(^|/)[.]{1,2}(/|$)'
       OR position(E'\\\\' in (member.item ->> 'path')) <> 0
       OR COALESCE(member.item ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(member.item -> 'byteSize') <> 'number'
       OR (member.item ->> 'byteSize') !~ '^(0|[1-9][0-9]*)$'
    THEN
      RAISE EXCEPTION 'orphan quarantine contains malformed archive member provenance';
    END IF;
    IF member.item ->> 'path' = 'evidence_manifest.json' THEN
      manifest_count := manifest_count + 1;
      IF member.item ->> 'sha256' <> NEW."manifest_sha256"
         OR (member.item ->> 'byteSize')::bigint <> NEW."manifest_byte_size" THEN
        RAISE EXCEPTION 'orphan quarantine manifest member identity mismatch';
      END IF;
    END IF;
    canonical_members := canonical_members
      || convert_to(member.item ->> 'path', 'UTF8') || decode('00', 'hex')
      || convert_to(member.item ->> 'sha256', 'UTF8') || decode('00', 'hex')
      || convert_to(((member.item ->> 'byteSize')::bigint)::text, 'UTF8')
      || convert_to(E'\n', 'UTF8');
  END LOOP;
  IF manifest_count <> 1 THEN
    RAISE EXCEPTION 'orphan quarantine must contain one exact manifest member';
  END IF;
  IF encode(sha256(canonical_members), 'hex') <> NEW."archive_member_set_sha256" THEN
    RAISE EXCEPTION 'orphan quarantine archive member-set digest mismatch';
  END IF;
  IF NEW."verification_mode" <> (
    'archive+manifest+all-members-restore:' || (NEW."archive_member_count" - 1)::text
  ) THEN
    RAISE EXCEPTION 'orphan quarantine verification mode does not cover every bundled member';
  END IF;

  IF (
    SELECT count(DISTINCT value ->> 'path')
      FROM jsonb_array_elements(NEW."source_archives")
  ) <> jsonb_array_length(NEW."source_archives") THEN
    RAISE EXCEPTION 'orphan quarantine contains duplicate source archive paths';
  END IF;
  FOR member IN SELECT value AS item FROM jsonb_array_elements(NEW."source_archives") LOOP
    source_count := source_count + 1;
    IF jsonb_typeof(member.item) <> 'object'
       OR COALESCE(member.item ->> 'path', '') = ''
       OR (member.item ->> 'path') LIKE '/%'
       OR (member.item ->> 'path') ~ '(^|/)[.]{1,2}(/|$)'
       OR position(E'\\\\' in (member.item ->> 'path')) <> 0
       OR COALESCE(member.item ->> 'compression', '') NOT IN ('gzip', 'zstd')
       OR COALESCE(member.item ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(member.item -> 'byteSize') <> 'number'
       OR (member.item ->> 'byteSize') !~ '^[1-9][0-9]*$'
       OR (
         (member.item ? 'uncompressedTarSha256')
         <> (member.item ? 'uncompressedTarByteSize')
       )
       OR (
         member.item ? 'uncompressedTarSha256'
         AND (
           COALESCE(member.item ->> 'uncompressedTarSha256', '')
             !~ '^[0-9a-f]{64}$'
           OR jsonb_typeof(member.item -> 'uncompressedTarByteSize') <> 'number'
           OR (member.item ->> 'uncompressedTarByteSize') !~ '^[1-9][0-9]*$'
         )
       )
    THEN
      RAISE EXCEPTION 'orphan quarantine contains malformed source archive provenance';
    END IF;
  END LOOP;
  IF source_count = 0 THEN
    RAISE EXCEPTION 'orphan quarantine requires retained source archive provenance';
  END IF;
  RETURN NEW;
END;
$$;
$definition$
    ),
    jsonb_build_object(
      'name', 'reject_solver_evidence_orphan_quarantine_mutation',
      'definition', $definition$
CREATE OR REPLACE FUNCTION reject_solver_evidence_orphan_quarantine_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'solver evidence orphan quarantines are immutable';
END;
$$;
$definition$
    ),
    jsonb_build_object(
      'name', 'enforce_solver_evidence_incomplete_quarantine',
      'definition', $definition$
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
$definition$
    ),
    jsonb_build_object(
      'name', 'reject_artifact_incomplete_quarantine_ownership',
      'definition', $definition$
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
$definition$
    ),
    jsonb_build_object(
      'name', 'reject_archive_incomplete_quarantine_ownership',
      'definition', $definition$
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
$definition$
    ),
    jsonb_build_object(
      'name', 'reject_orphan_incomplete_quarantine_ownership',
      'definition', $definition$
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
$definition$
    ),
    jsonb_build_object(
      'name', 'reject_solver_evidence_incomplete_quarantine_mutation',
      'definition', $definition$
CREATE OR REPLACE FUNCTION reject_solver_evidence_incomplete_quarantine_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'solver evidence incomplete quarantines are immutable';
END;
$$;
$definition$
    ),
    jsonb_build_object(
      'name', 'reject_existing_orphan_incomplete_quarantine',
      'definition', $definition$
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
$definition$
    )
  );
  trigger_specs jsonb := jsonb_build_array(
    jsonb_build_object(
      'name', 'solver_evidence_orphan_quarantines_source_guard',
      'table', 'solver_evidence_orphan_quarantines',
      'function', 'enforce_solver_evidence_orphan_quarantine',
      'type', 7,
      'definition', $definition$
CREATE TRIGGER "solver_evidence_orphan_quarantines_source_guard"
BEFORE INSERT ON "solver_evidence_orphan_quarantines"
FOR EACH ROW EXECUTE FUNCTION enforce_solver_evidence_orphan_quarantine();
$definition$
    ),
    jsonb_build_object(
      'name', 'solver_evidence_orphan_quarantines_immutable',
      'table', 'solver_evidence_orphan_quarantines',
      'function', 'reject_solver_evidence_orphan_quarantine_mutation',
      'type', 27,
      'definition', $definition$
CREATE TRIGGER "solver_evidence_orphan_quarantines_immutable"
BEFORE UPDATE OR DELETE ON "solver_evidence_orphan_quarantines"
FOR EACH ROW EXECUTE FUNCTION reject_solver_evidence_orphan_quarantine_mutation();
$definition$
    ),
    jsonb_build_object(
      'name', 'solver_evidence_incomplete_quarantines_source_guard',
      'table', 'solver_evidence_incomplete_quarantines',
      'function', 'enforce_solver_evidence_incomplete_quarantine',
      'type', 7,
      'definition', $definition$
CREATE TRIGGER "solver_evidence_incomplete_quarantines_source_guard"
BEFORE INSERT ON "solver_evidence_incomplete_quarantines"
FOR EACH ROW EXECUTE FUNCTION enforce_solver_evidence_incomplete_quarantine();
$definition$
    ),
    jsonb_build_object(
      'name', 'aaa_incomplete_quarantine_artifact_guard',
      'table', 'solver_evidence_artifacts',
      'function', 'reject_artifact_incomplete_quarantine_ownership',
      'type', 23,
      'definition', $definition$
CREATE TRIGGER "aaa_incomplete_quarantine_artifact_guard"
BEFORE INSERT OR UPDATE ON "solver_evidence_artifacts"
FOR EACH ROW EXECUTE FUNCTION reject_artifact_incomplete_quarantine_ownership();
$definition$
    ),
    jsonb_build_object(
      'name', 'aaa_incomplete_quarantine_archive_guard',
      'table', 'solver_evidence_archives',
      'function', 'reject_archive_incomplete_quarantine_ownership',
      'type', 23,
      'definition', $definition$
CREATE TRIGGER "aaa_incomplete_quarantine_archive_guard"
BEFORE INSERT OR UPDATE ON "solver_evidence_archives"
FOR EACH ROW EXECUTE FUNCTION reject_archive_incomplete_quarantine_ownership();
$definition$
    ),
    jsonb_build_object(
      'name', 'aaa_incomplete_quarantine_orphan_guard',
      'table', 'solver_evidence_orphan_quarantines',
      'function', 'reject_orphan_incomplete_quarantine_ownership',
      'type', 23,
      'definition', $definition$
CREATE TRIGGER "aaa_incomplete_quarantine_orphan_guard"
BEFORE INSERT OR UPDATE ON "solver_evidence_orphan_quarantines"
FOR EACH ROW EXECUTE FUNCTION reject_orphan_incomplete_quarantine_ownership();
$definition$
    ),
    jsonb_build_object(
      'name', 'solver_evidence_incomplete_quarantines_immutable',
      'table', 'solver_evidence_incomplete_quarantines',
      'function', 'reject_solver_evidence_incomplete_quarantine_mutation',
      'type', 27,
      'definition', $definition$
CREATE TRIGGER "solver_evidence_incomplete_quarantines_immutable"
BEFORE UPDATE OR DELETE ON "solver_evidence_incomplete_quarantines"
FOR EACH ROW EXECUTE FUNCTION reject_solver_evidence_incomplete_quarantine_mutation();
$definition$
    ),
    jsonb_build_object(
      'name', 'aaa_incomplete_quarantine_existing_orphan_guard',
      'table', 'solver_evidence_incomplete_quarantines',
      'function', 'reject_existing_orphan_incomplete_quarantine',
      'type', 7,
      'definition', $definition$
CREATE TRIGGER "aaa_incomplete_quarantine_existing_orphan_guard"
BEFORE INSERT ON "solver_evidence_incomplete_quarantines"
FOR EACH ROW EXECUTE FUNCTION reject_existing_orphan_incomplete_quarantine();
$definition$
    )
  );
  legacy_shared text := $definition$
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
$definition$;
  canonical_shared text := $definition$
CREATE OR REPLACE FUNCTION reject_linked_solver_evidence_artifact_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "solver_evidence_archives" archive
    WHERE archive."source_artifact_id" = OLD."id"
  ) OR EXISTS (
    SELECT 1 FROM "solver_evidence_artifact_members" member
    WHERE member."artifact_id" = OLD."id"
  ) OR EXISTS (
    SELECT 1 FROM "solver_evidence_orphan_quarantines" quarantine
    WHERE quarantine."source_artifact_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'linked solver evidence artifacts are immutable';
  END IF;
  RETURN NEW;
END;
$$;
$definition$;
  migration_hashes text[] := ARRAY['2d37a9e53ccbac46e7926291cc5f1b327675468a700500078c00ba46de8baef9','769f8cb2a7dd55a6e89b8e2811e9199451989ae1fd76ab9a515e20aadfb06902','7f21919e770ddfadfb6e2c910e99c3072153246df84e2f16d5c8f3cb6b56f5ec'];
  definition jsonb;
  foreign_key jsonb;
  index_definition jsonb;
  present_tables integer;
  present_functions integer;
  present_triggers integer;
  shared_body text;
  expected_body text;
  template_name text;
  template_id oid;
  actual_id oid;
  relation_id oid;
  expected_shape jsonb;
  actual_shape jsonb;
  restoring boolean;
  settings_path text := current_setting('search_path');
BEGIN
  PERFORM set_config('search_path', 'public,pg_catalog', true);
  PERFORM pg_advisory_xact_lock(hashtextextended('quarantine-schema-repair:0193', 0));
  IF (SELECT count(DISTINCT hash) FROM drizzle.__drizzle_migrations WHERE hash = ANY(migration_hashes)) <> 3 THEN
    RAISE EXCEPTION '0193 requires the exact canonical 0073/0077/0078 migration history';
  END IF;
  SELECT count(*) INTO present_tables FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='public' AND relation.relname IN
      (SELECT item->>'name' FROM jsonb_array_elements(table_specs) item) AND relation.relkind='r';
  SELECT count(*) INTO present_functions FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
    WHERE namespace.nspname='public' AND procedure.proname IN
      (SELECT item->>'name' FROM jsonb_array_elements(function_specs) item);
  SELECT count(*) INTO present_triggers FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='public' AND NOT trigger.tgisinternal AND trigger.tgname IN
      (SELECT item->>'name' FROM jsonb_array_elements(trigger_specs) item);
  restoring := present_tables=0 AND present_functions=0 AND present_triggers=0;
  IF NOT restoring AND NOT (present_tables=2 AND present_functions=8 AND present_triggers=8) THEN
    RAISE EXCEPTION '0193 refuses partial quarantine schema: tables %, functions %, triggers %', present_tables,present_functions,present_triggers;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE relation.relname IN (SELECT item->>'name' FROM jsonb_array_elements(table_specs) item)
      AND (namespace.nspname<>'public' OR relation.relkind<>'r')) THEN
    RAISE EXCEPTION '0193 refuses alternate quarantine relation ownership';
  END IF;
  SELECT regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g') INTO shared_body
    FROM pg_proc WHERE oid=to_regprocedure('public.reject_linked_solver_evidence_artifact_update()')
      AND prorettype='trigger'::regtype AND NOT prosecdef AND proconfig IS NULL;
  expected_body := regexp_replace(split_part(canonical_shared,'$$',2), '\s+', '', 'g');
  IF shared_body IS NULL OR (shared_body<>expected_body
    AND (NOT restoring OR shared_body<>regexp_replace(split_part(legacy_shared,'$$',2), '\s+', '', 'g'))) THEN
    RAISE EXCEPTION '0193 refuses an unexpected shared artifact immutability guard';
  END IF;
  IF restoring THEN
    FOR definition IN SELECT * FROM jsonb_array_elements(table_specs) LOOP
      EXECUTE definition->>'definition';
      FOR index_definition IN SELECT * FROM jsonb_array_elements(definition->'indexes') LOOP
        EXECUTE index_definition#>>'{}';
      END LOOP;
    END LOOP;
    FOR definition IN SELECT * FROM jsonb_array_elements(function_specs) LOOP
      EXECUTE definition->>'definition';
    END LOOP;
    FOR definition IN SELECT * FROM jsonb_array_elements(trigger_specs) LOOP
      EXECUTE definition->>'definition';
    END LOOP;
    IF shared_body<>expected_body THEN EXECUTE canonical_shared; END IF;
  END IF;
  FOR definition IN SELECT * FROM jsonb_array_elements(table_specs) LOOP
    template_name := '_contract0193_' || CASE WHEN definition->>'name' LIKE '%orphan%' THEN 'orphan' ELSE 'incomplete' END;
    IF to_regclass('pg_temp.' || template_name) IS NOT NULL THEN
      RAISE EXCEPTION '0193 contract table already exists';
    END IF;
    EXECUTE replace(regexp_replace(definition->>'definition', ' REFERENCES "[^"]+"\("[^"]+"\)', '', 'g'),
      'CREATE TABLE "' || (definition->>'name') || '"', 'CREATE TEMP TABLE "' || template_name || '"');
    template_id := to_regclass('pg_temp.' || template_name);
    actual_id := to_regclass('public.' || (definition->>'name'));
    FOR index_definition IN SELECT * FROM jsonb_array_elements(definition->'indexes') LOOP
      EXECUTE replace(index_definition#>>'{}', 'ON "' || (definition->>'name') || '"', 'ON pg_temp."' || template_name || '"');
    END LOOP;
    FOR relation_id IN SELECT template_id UNION ALL SELECT actual_id LOOP
      SELECT jsonb_build_object(
        'columns',(SELECT jsonb_agg(jsonb_build_array(attribute.attname,format_type(attribute.atttypid,attribute.atttypmod),
          attribute.attnotnull,attribute.attidentity,attribute.attgenerated,pg_get_expr(default_value.adbin,default_value.adrelid)) ORDER BY attribute.attnum)
          FROM pg_attribute attribute LEFT JOIN pg_attrdef default_value ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
          WHERE attribute.attrelid=relation_id AND attribute.attnum>0 AND NOT attribute.attisdropped),
        'constraints',(SELECT jsonb_agg(item ORDER BY item::text) FROM
          (SELECT jsonb_build_array(contype,pg_get_constraintdef(oid),convalidated,condeferrable,condeferred) AS item
            FROM pg_constraint WHERE conrelid=relation_id AND contype<>'f') descriptors),
        'indexes',(SELECT jsonb_agg(item ORDER BY item::text) FROM
          (SELECT jsonb_build_array(index.indisunique,index.indisprimary,index.indisvalid,index.indisready,
            index.indnkeyatts,index.indnatts,index.indkey::text,index.indclass::text,index.indcollation::text,index.indoption::text,
            pg_get_expr(index.indexprs,index.indrelid),pg_get_expr(index.indpred,index.indrelid),method.amname) AS item
            FROM pg_index index JOIN pg_class relation ON relation.oid=index.indexrelid JOIN pg_am method ON method.oid=relation.relam
            WHERE index.indrelid=relation_id) descriptors)
      ) INTO actual_shape;
      IF relation_id=template_id THEN expected_shape:=actual_shape;
      ELSIF actual_shape IS DISTINCT FROM expected_shape THEN
        RAISE EXCEPTION '0193 refuses unexpected columns, constraints or indexes on %',definition->>'name';
      END IF;
    END LOOP;
    IF (SELECT count(*) FROM pg_constraint WHERE conrelid=actual_id AND contype='f') <> jsonb_array_length(definition->'foreignKeys') THEN
      RAISE EXCEPTION '0193 refuses unexpected quarantine foreign keys';
    END IF;
    FOR foreign_key IN SELECT * FROM jsonb_array_elements(definition->'foreignKeys') LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_constraint reference
        JOIN pg_attribute source ON source.attrelid=reference.conrelid AND source.attnum=reference.conkey[1]
        JOIN pg_attribute target ON target.attrelid=reference.confrelid AND target.attnum=reference.confkey[1]
        WHERE reference.conrelid=actual_id AND reference.contype='f' AND reference.convalidated
          AND cardinality(reference.conkey)=1 AND cardinality(reference.confkey)=1
          AND reference.confrelid=to_regclass('public.' || (foreign_key->>'table'))
          AND source.attname=foreign_key->>'column' AND target.attname=foreign_key->>'target'
          AND reference.confupdtype='a' AND reference.confdeltype='a' AND reference.confmatchtype='s'
          AND NOT reference.condeferrable AND NOT reference.condeferred) THEN
        RAISE EXCEPTION '0193 refuses altered quarantine foreign key %',foreign_key;
      END IF;
    END LOOP;
    EXECUTE format('DROP TABLE pg_temp.%I',template_name);
  END LOOP;
  FOR definition IN SELECT * FROM jsonb_array_elements(function_specs) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc procedure JOIN pg_language language ON language.oid=procedure.prolang
      WHERE procedure.oid=to_regprocedure('public.' || (definition->>'name') || '()')
        AND procedure.prorettype='trigger'::regtype AND language.lanname='plpgsql'
        AND NOT procedure.prosecdef AND procedure.proconfig IS NULL AND NOT procedure.proisstrict
        AND procedure.provolatile='v'
        AND regexp_replace(regexp_replace(procedure.prosrc,'--[^\n]*','','g'),'\s+','','g')
          =regexp_replace(split_part(definition->>'definition','$$',2),'\s+','','g')) THEN
      RAISE EXCEPTION '0193 refuses altered quarantine function %',definition->>'name';
    END IF;
  END LOOP;
  FOR definition IN SELECT * FROM jsonb_array_elements(trigger_specs) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger trigger
      WHERE trigger.tgrelid=to_regclass('public.' || (definition->>'table'))
        AND trigger.tgname=definition->>'name' AND trigger.tgtype=(definition->>'type')::integer
        AND trigger.tgfoid=to_regprocedure('public.' || (definition->>'function') || '()')
        AND trigger.tgenabled='O' AND NOT trigger.tgisinternal
        AND trigger.tgnargs=0 AND trigger.tgqual IS NULL AND trigger.tgattr=''::int2vector
        AND NOT trigger.tgdeferrable AND NOT trigger.tginitdeferred) THEN
      RAISE EXCEPTION '0193 refuses altered quarantine trigger %',definition->>'name';
    END IF;
  END LOOP;
  PERFORM set_config('search_path',settings_path,true);
  IF restoring THEN
    RAISE NOTICE '0193 restored quarantine schema and guards only; historical quarantine clearance remains unknown';
  END IF;
END;
$repair$;

