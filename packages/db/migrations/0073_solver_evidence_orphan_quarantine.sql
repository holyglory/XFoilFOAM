-- Preserve genuine solver evidence that reached durable engine storage but
-- whose worker died before an exact result/result-attempt owner was ingested.
-- This table is not a substitute result: it has no coefficients or AoA and is
-- anchored only to exact engine job/path, manifest, member-set and GCS object
-- provenance.
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
--> statement-breakpoint
CREATE INDEX "solver_evidence_orphan_quarantines_sim_job_idx"
  ON "solver_evidence_orphan_quarantines" ("sim_job_id");
--> statement-breakpoint
CREATE INDEX "solver_evidence_orphan_quarantines_blob_idx"
  ON "solver_evidence_orphan_quarantines" ("blob_id");
--> statement-breakpoint
CREATE INDEX "solver_evidence_orphan_quarantines_created_idx"
  ON "solver_evidence_orphan_quarantines" ("createdAt");
--> statement-breakpoint

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

  -- Never reinterpret an exact ingested attempt/result as an orphan.  Exact
  -- engine job + case identity is used; AoA is deliberately absent.
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
--> statement-breakpoint
CREATE TRIGGER "solver_evidence_orphan_quarantines_source_guard"
BEFORE INSERT ON "solver_evidence_orphan_quarantines"
FOR EACH ROW EXECUTE FUNCTION enforce_solver_evidence_orphan_quarantine();
--> statement-breakpoint

-- Intentionally immutable-only. There is no generic "resolved" transition:
-- a later exact result/attempt remains a separate immutable fact and any
-- future reconciliation model must reference that exact owner explicitly.
CREATE OR REPLACE FUNCTION reject_solver_evidence_orphan_quarantine_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'solver evidence orphan quarantines are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_evidence_orphan_quarantines_immutable"
BEFORE UPDATE OR DELETE ON "solver_evidence_orphan_quarantines"
FOR EACH ROW EXECUTE FUNCTION reject_solver_evidence_orphan_quarantine_mutation();
--> statement-breakpoint

-- Quarantine source artifacts receive the same immutability fence as owned
-- archive sources/members.
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
