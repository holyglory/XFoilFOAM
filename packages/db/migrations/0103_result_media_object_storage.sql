CREATE TYPE "result_media_local_reclaim_state" AS ENUM(
  'pending',
  'running',
  'retry_wait',
  'reclaimed'
);
--> statement-breakpoint
CREATE TYPE "result_media_storage_upload_state" AS ENUM(
  'pending',
  'running',
  'retry_wait',
  'bound'
);
--> statement-breakpoint
CREATE UNIQUE INDEX "result_media_storage_key_uq"
  ON "result_media" ("storage_key");
--> statement-breakpoint
CREATE TABLE "result_media_blobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "backend" "solver_evidence_blob_backend" DEFAULT 'gcs' NOT NULL,
  "bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "generation" text NOT NULL,
  "mime_type" text NOT NULL,
  "sha256" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "crc32c" text NOT NULL,
  "verifiedAt" timestamp with time zone NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "result_media_blobs_gcs_identity_uq"
    UNIQUE("bucket", "object_key", "generation"),
  CONSTRAINT "result_media_blobs_content_uq" UNIQUE("sha256", "byte_size"),
  CONSTRAINT "result_media_blobs_backend_check" CHECK ("backend" = 'gcs'),
  CONSTRAINT "result_media_blobs_bucket_check" CHECK (btrim("bucket") <> ''),
  CONSTRAINT "result_media_blobs_object_key_check" CHECK (
    btrim("object_key") <> ''
    AND "object_key" NOT LIKE '/%'
    AND "object_key" !~ '(^|/)[.]{1,2}(/|$)'
    AND position(E'\\' in "object_key") = 0
  ),
  CONSTRAINT "result_media_blobs_generation_check"
    CHECK ("generation" ~ '^[1-9][0-9]{0,19}$'),
  CONSTRAINT "result_media_blobs_mime_type_check"
    CHECK (btrim("mime_type") <> ''),
  CONSTRAINT "result_media_blobs_sha256_check"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "result_media_blobs_byte_size_check" CHECK ("byte_size" > 0),
  CONSTRAINT "result_media_blobs_crc32c_check"
    CHECK ("crc32c" ~ '^[A-Za-z0-9+/]{6}==$')
);
--> statement-breakpoint
CREATE TABLE "result_media_storage_bindings" (
  "result_media_id" uuid PRIMARY KEY NOT NULL,
  "blob_id" uuid NOT NULL,
  "local_storage_key" text NOT NULL,
  "state" "result_media_local_reclaim_state" DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "claim_token" uuid,
  "claim_expires_at" timestamp with time zone,
  "error" text,
  "reclaimed_at" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "result_media_storage_bindings_result_media_fk"
    FOREIGN KEY ("result_media_id") REFERENCES "result_media"("id")
    ON DELETE CASCADE,
  CONSTRAINT "result_media_storage_bindings_blob_fk"
    FOREIGN KEY ("blob_id") REFERENCES "result_media_blobs"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "result_media_storage_bindings_local_key_check" CHECK (
    btrim("local_storage_key") <> ''
    AND "local_storage_key" NOT LIKE '/%'
    AND "local_storage_key" !~ '(^|/)[.]{1,2}(/|$)'
    AND position(E'\\' in "local_storage_key") = 0
  ),
  CONSTRAINT "result_media_storage_bindings_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "result_media_storage_bindings_state_shape_check" CHECK (
    ("state" = 'running' AND "claim_token" IS NOT NULL
      AND "claim_expires_at" IS NOT NULL AND "reclaimed_at" IS NULL)
    OR ("state" IN ('pending', 'retry_wait') AND "claim_token" IS NULL
      AND "claim_expires_at" IS NULL AND "reclaimed_at" IS NULL)
    OR ("state" = 'reclaimed' AND "claim_token" IS NULL
      AND "claim_expires_at" IS NULL AND "reclaimed_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "result_media_storage_bindings_blob_idx"
  ON "result_media_storage_bindings" ("blob_id");
--> statement-breakpoint
CREATE INDEX "result_media_storage_bindings_ready_idx"
  ON "result_media_storage_bindings" ("state", "next_attempt_at");
--> statement-breakpoint
CREATE TABLE "result_media_storage_uploads" (
  "result_media_id" uuid PRIMARY KEY NOT NULL,
  "state" "result_media_storage_upload_state" DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "claim_token" uuid,
  "claim_expires_at" timestamp with time zone,
  "error" text,
  "bound_at" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "result_media_storage_uploads_result_media_fk"
    FOREIGN KEY ("result_media_id") REFERENCES "result_media"("id")
    ON DELETE CASCADE,
  CONSTRAINT "result_media_storage_uploads_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "result_media_storage_uploads_state_shape_check" CHECK (
    ("state" = 'running' AND "claim_token" IS NOT NULL
      AND "claim_expires_at" IS NOT NULL AND "bound_at" IS NULL)
    OR ("state" IN ('pending', 'retry_wait') AND "claim_token" IS NULL
      AND "claim_expires_at" IS NULL AND "bound_at" IS NULL)
    OR ("state" = 'bound' AND "claim_token" IS NULL
      AND "claim_expires_at" IS NULL AND "bound_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "result_media_storage_uploads_ready_idx"
  ON "result_media_storage_uploads" ("state", "next_attempt_at");
