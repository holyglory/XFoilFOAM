-- A solver-evidence blob is one immutable physical archive object. Logical
-- ownership and solver/runtime provenance remain on solver_evidence_artifacts;
-- this table records only the bytes and their exact storage identity.
CREATE TYPE "solver_evidence_blob_backend" AS ENUM ('volume', 'gcs');
--> statement-breakpoint
CREATE TYPE "solver_evidence_blob_compression" AS ENUM ('gzip', 'zstd');
--> statement-breakpoint
CREATE TYPE "solver_evidence_archive_state" AS ENUM ('current', 'superseded');
--> statement-breakpoint

CREATE TABLE "solver_evidence_blobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "backend" "solver_evidence_blob_backend" NOT NULL,
  "bucket" text,
  "object_key" text NOT NULL,
  -- Google Cloud Storage generation is an unsigned decimal identifier. Keep
  -- it as text so JavaScript never rounds it and every read can be
  -- generation-pinned. Volume objects have no generation or bucket.
  "generation" text,
  "compression" "solver_evidence_blob_compression" NOT NULL,
  "mime_type" text NOT NULL,
  -- Digest/size of the bytes physically stored at backend + object identity.
  "sha256" text NOT NULL,
  "byte_size" bigint NOT NULL,
  -- Canonical base64 big-endian CRC32C (the representation returned by GCS).
  "crc32c" text NOT NULL,
  -- Digest/size of the uncompressed tar stream. This proves a gzip -> zstd
  -- conversion preserved evidence without retaining both encodings.
  "uncompressed_tar_sha256" text NOT NULL,
  "uncompressed_tar_byte_size" bigint NOT NULL,
  "verifiedAt" timestamp with time zone NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_evidence_blobs_backend_shape_check" CHECK (
    (
      "backend" = 'volume'
      AND "bucket" IS NULL
      AND "generation" IS NULL
    ) OR (
      "backend" = 'gcs'
      AND btrim(COALESCE("bucket", '')) <> ''
      AND "generation" ~ '^[1-9][0-9]{0,19}$'
    )
  ),
  CONSTRAINT "solver_evidence_blobs_object_key_check" CHECK (
    btrim("object_key") <> ''
    AND "object_key" NOT LIKE '/%'
    AND "object_key" !~ '(^|/)[.]{1,2}(/|$)'
    AND position(E'\\\\' in "object_key") = 0
  ),
  CONSTRAINT "solver_evidence_blobs_mime_type_check"
    CHECK (btrim("mime_type") <> ''),
  CONSTRAINT "solver_evidence_blobs_sha256_check"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "solver_evidence_blobs_byte_size_check"
    CHECK ("byte_size" > 0),
  CONSTRAINT "solver_evidence_blobs_crc32c_check"
    CHECK ("crc32c" ~ '^[A-Za-z0-9+/]{6}==$'),
  CONSTRAINT "solver_evidence_blobs_tar_sha256_check"
    CHECK ("uncompressed_tar_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "solver_evidence_blobs_tar_byte_size_check"
    CHECK ("uncompressed_tar_byte_size" > 0),
  CONSTRAINT "solver_evidence_blobs_metadata_check"
    CHECK (jsonb_typeof("metadata") = 'object')
);
--> statement-breakpoint

-- One row names one physical object. Identical content may deliberately
-- coexist on the volume and GCS during a verified migration, so content hash
-- is not (incorrectly) used as physical identity.
CREATE UNIQUE INDEX "solver_evidence_blobs_volume_identity_uq"
  ON "solver_evidence_blobs" ("object_key")
  WHERE "backend" = 'volume';
--> statement-breakpoint
CREATE UNIQUE INDEX "solver_evidence_blobs_gcs_identity_uq"
  ON "solver_evidence_blobs" ("bucket", "object_key", "generation")
  WHERE "backend" = 'gcs';
--> statement-breakpoint
CREATE INDEX "solver_evidence_blobs_content_idx"
  ON "solver_evidence_blobs" ("sha256", "byte_size");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_solver_evidence_blob_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'solver evidence blobs are immutable; insert a new physical blob';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_evidence_blobs_immutable"
BEFORE UPDATE ON "solver_evidence_blobs"
FOR EACH ROW EXECUTE FUNCTION reject_solver_evidence_blob_update();
--> statement-breakpoint

-- A composite source FK below proves that an archive is anchored to a bundle
-- artifact belonging to the same exact result generation. It also lets all
-- runtime/build/method identity stay on that source artifact instead of being
-- copied into storage rows.
ALTER TABLE "solver_evidence_artifacts"
  ADD CONSTRAINT "solver_evidence_artifacts_id_attempt_result_uq"
  UNIQUE ("id", "result_attempt_id", "result_id");
--> statement-breakpoint

CREATE TABLE "solver_evidence_archives" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid NOT NULL,
  "result_attempt_id" uuid NOT NULL,
  "source_artifact_id" uuid NOT NULL,
  "blob_id" uuid NOT NULL REFERENCES "solver_evidence_blobs"("id"),
  "state" "solver_evidence_archive_state" DEFAULT 'current' NOT NULL,
  "superseded_by_archive_id" uuid,
  "supersededAt" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_evidence_archives_attempt_owner_fk"
    FOREIGN KEY ("result_attempt_id", "result_id")
    REFERENCES "result_attempts"("id", "result_id") ON DELETE CASCADE,
  CONSTRAINT "solver_evidence_archives_source_owner_fk"
    FOREIGN KEY ("source_artifact_id", "result_attempt_id", "result_id")
    REFERENCES "solver_evidence_artifacts"("id", "result_attempt_id", "result_id")
    ON DELETE CASCADE,
  CONSTRAINT "solver_evidence_archives_id_attempt_uq"
    UNIQUE ("id", "result_attempt_id"),
  CONSTRAINT "solver_evidence_archives_attempt_blob_uq"
    UNIQUE ("result_attempt_id", "blob_id"),
  CONSTRAINT "solver_evidence_archives_supersession_shape_check" CHECK (
    ("state" = 'current' AND "superseded_by_archive_id" IS NULL AND "supersededAt" IS NULL)
    OR ("state" = 'superseded' AND "supersededAt" IS NOT NULL)
  ),
  CONSTRAINT "solver_evidence_archives_no_self_supersession_check" CHECK (
    "superseded_by_archive_id" IS NULL OR "superseded_by_archive_id" <> "id"
  ),
  CONSTRAINT "solver_evidence_archives_superseded_by_attempt_fk"
    FOREIGN KEY ("superseded_by_archive_id", "result_attempt_id")
    REFERENCES "solver_evidence_archives"("id", "result_attempt_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "solver_evidence_archives_current_attempt_uq"
  ON "solver_evidence_archives" ("result_attempt_id")
  WHERE "state" = 'current';
--> statement-breakpoint
CREATE INDEX "solver_evidence_archives_result_idx"
  ON "solver_evidence_archives" ("result_id", "result_attempt_id");
--> statement-breakpoint
CREATE INDEX "solver_evidence_archives_source_artifact_idx"
  ON "solver_evidence_archives" ("source_artifact_id");
--> statement-breakpoint
CREATE INDEX "solver_evidence_archives_blob_idx"
  ON "solver_evidence_archives" ("blob_id");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_solver_evidence_archive_source()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "solver_evidence_artifacts" artifact
    WHERE artifact."id" = NEW."source_artifact_id"
      AND artifact."result_attempt_id" = NEW."result_attempt_id"
      AND artifact."result_id" = NEW."result_id"
      AND artifact."kind" IN ('engine_bundle', 'openfoam_bundle')
  ) THEN
    RAISE EXCEPTION 'solver evidence archive source must be an exact owned bundle artifact';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_evidence_archives_source_guard"
BEFORE INSERT OR UPDATE OF "result_id", "result_attempt_id", "source_artifact_id"
ON "solver_evidence_archives"
FOR EACH ROW EXECUTE FUNCTION enforce_solver_evidence_archive_source();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_solver_evidence_archive_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."result_id" IS DISTINCT FROM NEW."result_id"
     OR OLD."result_attempt_id" IS DISTINCT FROM NEW."result_attempt_id"
     OR OLD."source_artifact_id" IS DISTINCT FROM NEW."source_artifact_id"
     OR OLD."blob_id" IS DISTINCT FROM NEW."blob_id"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'solver evidence archive identity is immutable';
  END IF;
  IF OLD."state" = 'superseded' AND NEW."state" <> 'superseded' THEN
    RAISE EXCEPTION 'a superseded solver evidence archive cannot become current';
  END IF;
  IF OLD."supersededAt" IS NOT NULL
     AND OLD."supersededAt" IS DISTINCT FROM NEW."supersededAt" THEN
    RAISE EXCEPTION 'solver evidence archive supersession time is immutable';
  END IF;
  IF OLD."superseded_by_archive_id" IS NOT NULL
     AND OLD."superseded_by_archive_id" IS DISTINCT FROM NEW."superseded_by_archive_id" THEN
    RAISE EXCEPTION 'solver evidence archive successor is immutable once recorded';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_evidence_archives_update_guard"
BEFORE UPDATE ON "solver_evidence_archives"
FOR EACH ROW EXECUTE FUNCTION enforce_solver_evidence_archive_update();
--> statement-breakpoint

-- Logical artifacts remain addressable after their former volume files are
-- removed. A member row says where those exact artifact bytes live inside one
-- immutable archive; it does not copy physical or runtime identity.
CREATE TABLE "solver_evidence_artifact_members" (
  "archive_id" uuid NOT NULL REFERENCES "solver_evidence_archives"("id") ON DELETE CASCADE,
  "artifact_id" uuid NOT NULL REFERENCES "solver_evidence_artifacts"("id") ON DELETE CASCADE,
  "member_path" text NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_evidence_artifact_members_pk"
    PRIMARY KEY ("archive_id", "artifact_id"),
  CONSTRAINT "solver_evidence_artifact_members_archive_path_uq"
    UNIQUE ("archive_id", "member_path"),
  CONSTRAINT "solver_evidence_artifact_members_path_check" CHECK (
    btrim("member_path") <> ''
    AND "member_path" NOT LIKE '/%'
    AND "member_path" !~ '(^|/)[.]{1,2}(/|$)'
    AND position(E'\\\\' in "member_path") = 0
  )
);
--> statement-breakpoint
CREATE INDEX "solver_evidence_artifact_members_artifact_idx"
  ON "solver_evidence_artifact_members" ("artifact_id");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_solver_evidence_artifact_member_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "solver_evidence_archives" archive
    JOIN "solver_evidence_artifacts" artifact
      ON artifact."id" = NEW."artifact_id"
     AND artifact."result_id" = archive."result_id"
     AND artifact."result_attempt_id" = archive."result_attempt_id"
    WHERE archive."id" = NEW."archive_id"
      AND artifact."id" <> archive."source_artifact_id"
  ) THEN
    RAISE EXCEPTION 'archive members must be logical artifacts owned by the same exact result attempt';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_evidence_artifact_members_owner_guard"
BEFORE INSERT OR UPDATE ON "solver_evidence_artifact_members"
FOR EACH ROW EXECUTE FUNCTION enforce_solver_evidence_artifact_member_owner();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_solver_evidence_artifact_member_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'solver evidence artifact member mappings are immutable; replace the row';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_evidence_artifact_members_immutable"
BEFORE UPDATE ON "solver_evidence_artifact_members"
FOR EACH ROW EXECUTE FUNCTION reject_solver_evidence_artifact_member_update();
--> statement-breakpoint

-- Once an artifact anchors or belongs to an immutable archive, its ownership,
-- path, checksums, runtime provenance, and metadata are immutable too. The
-- member/source guards run when links are created; this complementary trigger
-- prevents a later artifact UPDATE from invalidating those already-proven
-- relationships without touching the guarded link rows.
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
--> statement-breakpoint
CREATE TRIGGER "solver_evidence_artifacts_linked_immutable"
BEFORE UPDATE ON "solver_evidence_artifacts"
FOR EACH ROW EXECUTE FUNCTION reject_linked_solver_evidence_artifact_update();
