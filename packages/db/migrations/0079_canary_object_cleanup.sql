-- A canary archive is not campaign evidence.  Cleanup therefore gets a
-- separate immutable reservation and receipt ledger rather than inventing a
-- solver-evidence owner.  The reservation is also a permanent tombstone: once
-- an exact attested generation is reserved for deletion, later ingest cannot
-- race in and adopt it as canonical or quarantine evidence.
CREATE TABLE "solver_canary_object_cleanup_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "canary_attestation_id" uuid NOT NULL
    REFERENCES "solver_engine_canary_attestations"("id"),
  "bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "generation" text NOT NULL,
  "sha256" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "crc32c" text NOT NULL,
  "reserved_by" text NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_canary_cleanup_target_uq"
    UNIQUE ("bucket", "object_key", "generation"),
  CONSTRAINT "solver_canary_cleanup_bucket_check"
    CHECK (btrim("bucket") <> ''),
  CONSTRAINT "solver_canary_cleanup_object_key_check"
    CHECK (
      btrim("object_key") <> ''
      AND "object_key" NOT LIKE '/%'
      AND "object_key" !~ '(^|/)[.]{1,2}(/|$)'
      AND position(E'\\\\' in "object_key") = 0
    ),
  CONSTRAINT "solver_canary_cleanup_generation_check"
    CHECK ("generation" ~ '^[1-9][0-9]{0,19}$'),
  CONSTRAINT "solver_canary_cleanup_sha256_check"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "solver_canary_cleanup_byte_size_check"
    CHECK ("byte_size" > 0),
  CONSTRAINT "solver_canary_cleanup_crc32c_check"
    CHECK ("crc32c" ~ '^[A-Za-z0-9+/]{6}==$'),
  CONSTRAINT "solver_canary_cleanup_actor_check"
    CHECK (btrim("reserved_by") <> '')
);
--> statement-breakpoint
CREATE INDEX "solver_canary_cleanup_attestation_idx"
  ON "solver_canary_object_cleanup_reservations"
  ("canary_attestation_id", "createdAt");
--> statement-breakpoint

CREATE TABLE "solver_canary_object_cleanup_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cleanup_reservation_id" uuid NOT NULL UNIQUE
    REFERENCES "solver_canary_object_cleanup_reservations"("id"),
  "outcome" text NOT NULL,
  "receipt_sha256" text NOT NULL UNIQUE,
  "receipt" jsonb NOT NULL,
  "executed_by" text NOT NULL,
  "deleted_at" timestamp with time zone NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_canary_cleanup_receipt_outcome_check"
    CHECK ("outcome" IN ('deleted', 'already_absent_after_reservation')),
  CONSTRAINT "solver_canary_cleanup_receipt_sha256_check"
    CHECK ("receipt_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "solver_canary_cleanup_receipt_json_check"
    CHECK (jsonb_typeof("receipt") = 'object'),
  CONSTRAINT "solver_canary_cleanup_receipt_actor_check"
    CHECK (btrim("executed_by") <> '')
);
--> statement-breakpoint

-- The same exact advisory key is taken by both sides of the ownership
-- boundary.  This prevents the classic write-skew race where an owner and a
-- cleanup reservation each observe the other as absent and both commit.
CREATE OR REPLACE FUNCTION lock_solver_canary_cleanup_identity(
  p_bucket text,
  p_object_key text,
  p_generation text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      COALESCE(p_bucket, '') || chr(31) ||
      COALESCE(p_object_key, '') || chr(31) ||
      COALESCE(p_generation, ''),
      2606
    )
  );
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reserve_attested_canary_object_cleanup()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attested_matches bigint;
  blob_owners bigint;
  artifact_owners bigint;
BEGIN
  PERFORM lock_solver_canary_cleanup_identity(
    NEW."bucket", NEW."object_key", NEW."generation"
  );

  SELECT count(*) INTO attested_matches
  FROM "solver_engine_canary_attestations" attestation
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(attestation."receipt" -> 'jobs') = 'array'
      THEN attestation."receipt" -> 'jobs' ELSE '[]'::jsonb END
  ) AS job
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(job -> 'points') = 'array'
      THEN job -> 'points' ELSE '[]'::jsonb END
  ) AS point
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(point -> 'artifacts') = 'array'
      THEN point -> 'artifacts' ELSE '[]'::jsonb END
  ) AS artifact
  WHERE attestation."id" = NEW."canary_attestation_id"
    AND attestation."solver_implementation_id" =
      '2f8bc764-09ae-4ff3-8fd2-260600000001'::uuid
    AND attestation."receipt" ->> 'schema_version' = '1'
    AND attestation."receipt" ->> 'status' = 'ok'
    AND attestation."receipt" -> 'engine' ->> 'family' = 'openfoam'
    AND attestation."receipt" -> 'engine' ->> 'distribution' = 'opencfd'
    AND attestation."receipt" -> 'engine' ->> 'version' = '2606'
    AND attestation."receipt" -> 'evidence_storage' ->> 'backend' = 'gcs'
    AND attestation."receipt" -> 'evidence_storage' ->> 'bucket' = NEW."bucket"
    AND attestation."receipt" -> 'evidence_storage' ->> 'archive_format' =
      'tar+zstd'
    AND attestation."receipt" -> 'evidence_storage' ->> 'compression' = 'zstd'
    AND attestation."receipt" -> 'evidence_storage' ->> 'local_disposition' =
      'remote-only'
    AND artifact ->> 'kind' = 'engine_bundle'
    AND artifact ->> 'sha256' = NEW."sha256"
    AND artifact ->> 'byte_size' = NEW."byte_size"::text
    AND artifact -> 'storage' ->> 'bucket' = NEW."bucket"
    AND artifact -> 'storage' ->> 'object_key' = NEW."object_key"
    AND artifact -> 'storage' ->> 'generation' = NEW."generation"
    AND artifact -> 'storage' ->> 'stored_sha256' = NEW."sha256"
    AND artifact -> 'storage' ->> 'stored_byte_size' = NEW."byte_size"::text
    AND artifact -> 'storage' ->> 'crc32c' = NEW."crc32c";

  IF attested_matches = 0 THEN
    RAISE EXCEPTION
      'canary cleanup target is not an exact engine_bundle in its durable OpenCFD 2606 attestation';
  END IF;

  SELECT count(*) INTO blob_owners
  FROM "solver_evidence_blobs" blob
  WHERE blob."backend" = 'gcs'
    AND blob."bucket" = NEW."bucket"
    AND blob."object_key" = NEW."object_key"
    AND blob."generation" = NEW."generation";

  SELECT count(*) INTO artifact_owners
  FROM "solver_evidence_artifacts" artifact
  WHERE (
      artifact."metadata" ->> 'storageBackend' = 'gcs'
      AND artifact."metadata" ->> 'bucket' = NEW."bucket"
      AND artifact."metadata" ->> 'objectKey' = NEW."object_key"
      AND artifact."metadata" ->> 'generation' = NEW."generation"
    ) OR (
      artifact."metadata" -> 'storage' ->> 'backend' = 'gcs'
      AND artifact."metadata" -> 'storage' ->> 'bucket' = NEW."bucket"
      AND artifact."metadata" -> 'storage' ->> 'object_key' = NEW."object_key"
      AND artifact."metadata" -> 'storage' ->> 'generation' = NEW."generation"
    );

  IF blob_owners <> 0 OR artifact_owners <> 0 THEN
    RAISE EXCEPTION
      'canary cleanup target already has solver evidence ownership (blobs %, artifacts %)',
      blob_owners, artifact_owners;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_canary_cleanup_reservation_guard"
BEFORE INSERT ON "solver_canary_object_cleanup_reservations"
FOR EACH ROW EXECUTE FUNCTION reserve_attested_canary_object_cleanup();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_blob_for_reserved_canary_cleanup()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."backend" <> 'gcs' THEN
    RETURN NEW;
  END IF;
  PERFORM lock_solver_canary_cleanup_identity(
    NEW."bucket", NEW."object_key", NEW."generation"
  );
  IF EXISTS (
    SELECT 1 FROM "solver_canary_object_cleanup_reservations" reservation
    WHERE reservation."bucket" = NEW."bucket"
      AND reservation."object_key" = NEW."object_key"
      AND reservation."generation" = NEW."generation"
  ) THEN
    RAISE EXCEPTION
      'GCS generation is permanently reserved for attested canary cleanup';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_canary_cleanup_blob_guard"
BEFORE INSERT OR UPDATE OF "backend", "bucket", "object_key", "generation"
ON "solver_evidence_blobs"
FOR EACH ROW EXECUTE FUNCTION reject_blob_for_reserved_canary_cleanup();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_artifact_for_reserved_canary_cleanup()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  top_bucket text;
  top_key text;
  top_generation text;
  nested_bucket text;
  nested_key text;
  nested_generation text;
BEGIN
  IF NEW."metadata" ->> 'storageBackend' = 'gcs' THEN
    top_bucket := NEW."metadata" ->> 'bucket';
    top_key := NEW."metadata" ->> 'objectKey';
    top_generation := NEW."metadata" ->> 'generation';
  END IF;
  IF NEW."metadata" -> 'storage' ->> 'backend' = 'gcs' THEN
    nested_bucket := NEW."metadata" -> 'storage' ->> 'bucket';
    nested_key := NEW."metadata" -> 'storage' ->> 'object_key';
    nested_generation := NEW."metadata" -> 'storage' ->> 'generation';
  END IF;

  IF top_bucket IS NULL AND nested_bucket IS NULL THEN
    RETURN NEW;
  END IF;

  IF top_bucket IS NOT NULL AND nested_bucket IS NOT NULL
     AND ROW(top_bucket, top_key, top_generation)
       IS DISTINCT FROM ROW(nested_bucket, nested_key, nested_generation) THEN
    RAISE EXCEPTION 'artifact has conflicting dual GCS storage identities';
  END IF;

  IF top_bucket IS NOT NULL THEN
    PERFORM lock_solver_canary_cleanup_identity(
      top_bucket, top_key, top_generation
    );
    IF EXISTS (
      SELECT 1 FROM "solver_canary_object_cleanup_reservations" reservation
      WHERE reservation."bucket" = top_bucket
        AND reservation."object_key" = top_key
        AND reservation."generation" = top_generation
    ) THEN
      RAISE EXCEPTION
        'GCS generation is permanently reserved for attested canary cleanup';
    END IF;
  END IF;

  IF nested_bucket IS NOT NULL AND top_bucket IS NULL THEN
    PERFORM lock_solver_canary_cleanup_identity(
      nested_bucket, nested_key, nested_generation
    );
    IF EXISTS (
      SELECT 1 FROM "solver_canary_object_cleanup_reservations" reservation
      WHERE reservation."bucket" = nested_bucket
        AND reservation."object_key" = nested_key
        AND reservation."generation" = nested_generation
    ) THEN
      RAISE EXCEPTION
        'GCS generation is permanently reserved for attested canary cleanup';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_canary_cleanup_artifact_guard"
BEFORE INSERT OR UPDATE OF "metadata" ON "solver_evidence_artifacts"
FOR EACH ROW EXECUTE FUNCTION reject_artifact_for_reserved_canary_cleanup();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_solver_canary_cleanup_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reservation "solver_canary_object_cleanup_reservations"%ROWTYPE;
  observation_status text;
  post_delete_status text;
BEGIN
  SELECT * INTO STRICT reservation
  FROM "solver_canary_object_cleanup_reservations"
  WHERE "id" = NEW."cleanup_reservation_id";

  observation_status := NEW."receipt" -> 'preDeleteObservation' ->> 'status';
  post_delete_status := NEW."receipt" -> 'postDeleteObservation' ->> 'status';
  IF NEW."receipt" ->> 'schemaVersion' IS DISTINCT FROM '1'
     OR NEW."receipt" ->> 'kind' IS DISTINCT FROM
       'opencfd2606-canary-gcs-cleanup-receipt'
     OR NEW."receipt" ->> 'reservationId' IS DISTINCT FROM reservation."id"::text
     OR NEW."receipt" ->> 'attestationId' IS DISTINCT FROM
       reservation."canary_attestation_id"::text
     OR NEW."receipt" -> 'target' ->> 'bucket' IS DISTINCT FROM reservation."bucket"
     OR NEW."receipt" -> 'target' ->> 'objectKey' IS DISTINCT FROM reservation."object_key"
     OR NEW."receipt" -> 'target' ->> 'generation' IS DISTINCT FROM reservation."generation"
     OR NEW."receipt" -> 'target' ->> 'sha256' IS DISTINCT FROM reservation."sha256"
     OR NEW."receipt" -> 'target' ->> 'byteSize' IS DISTINCT FROM reservation."byte_size"::text
     OR NEW."receipt" -> 'target' ->> 'crc32c' IS DISTINCT FROM reservation."crc32c"
     OR NEW."receipt" ->> 'outcome' IS DISTINCT FROM NEW."outcome"
     OR NEW."receipt" ->> 'operator' IS DISTINCT FROM NEW."executed_by"
     OR (NEW."receipt" ->> 'deletedAt')::timestamptz IS DISTINCT FROM NEW."deleted_at"
     OR observation_status IS NULL
     OR observation_status NOT IN ('present', 'absent')
     OR post_delete_status IS DISTINCT FROM 'absent' THEN
    RAISE EXCEPTION 'canary cleanup receipt does not match its exact reservation';
  END IF;

  IF NEW."outcome" = 'deleted' AND (
       observation_status IS DISTINCT FROM 'present'
       OR NEW."receipt" -> 'preDeleteObservation' ->> 'generation' IS DISTINCT FROM
         reservation."generation"
       OR NEW."receipt" -> 'preDeleteObservation' ->> 'sha256' IS DISTINCT FROM
         reservation."sha256"
       OR NEW."receipt" -> 'preDeleteObservation' ->> 'byteSize' IS DISTINCT FROM
         reservation."byte_size"::text
       OR NEW."receipt" -> 'preDeleteObservation' ->> 'crc32c' IS DISTINCT FROM
         reservation."crc32c"
     ) THEN
    RAISE EXCEPTION 'deleted canary cleanup receipt lacks its exact pre-delete observation';
  END IF;
  IF NEW."outcome" = 'already_absent_after_reservation'
     AND observation_status IS DISTINCT FROM 'absent' THEN
    RAISE EXCEPTION 'absent canary cleanup receipt has a present observation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_canary_cleanup_receipt_guard"
BEFORE INSERT ON "solver_canary_object_cleanup_receipts"
FOR EACH ROW EXECUTE FUNCTION validate_solver_canary_cleanup_receipt();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_solver_canary_cleanup_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'solver canary object cleanup audit rows are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_canary_cleanup_reservation_immutable"
BEFORE UPDATE OR DELETE ON "solver_canary_object_cleanup_reservations"
FOR EACH ROW EXECUTE FUNCTION reject_solver_canary_cleanup_mutation();
--> statement-breakpoint
CREATE TRIGGER "solver_canary_cleanup_receipt_immutable"
BEFORE UPDATE OR DELETE ON "solver_canary_object_cleanup_receipts"
FOR EACH ROW EXECUTE FUNCTION reject_solver_canary_cleanup_mutation();
