-- Bind default presentation media to the immutable solver manifest that
-- produced it. Legacy rows remain NULL and are therefore discovered for a
-- byte-verified rebuild; no migration guesses provenance from filenames.
ALTER TABLE "result_media"
  ADD COLUMN IF NOT EXISTS "evidence_sha256" text;
--> statement-breakpoint
ALTER TABLE "result_media"
  ADD COLUMN IF NOT EXISTS "sha256" text;
--> statement-breakpoint
ALTER TABLE "result_media"
  ADD COLUMN IF NOT EXISTS "byte_size" bigint;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_media_result_profile_evidence_idx"
  ON "result_media" ("result_id", "render_profile_key", "evidence_sha256");
--> statement-breakpoint
ALTER TABLE "result_media_repairs"
  ADD COLUMN IF NOT EXISTS "downstream_finalized_at" timestamptz;
--> statement-breakpoint

-- Human review history remains immutable audit evidence, but an old waiver
-- may no longer override the machine classifier or fitted polar.
UPDATE "result_review_verdicts"
SET "revokedAt" = now(),
    "revoked_by" = 'system:machine-evidence-required-v1'
WHERE "verdict" = 'waive'
  AND "revokedAt" IS NULL;
--> statement-breakpoint

-- Request ownership is current mutable lifecycle state; requested_by is only
-- immutable creator provenance. Legacy manual/admin rows were independent by
-- construction, while system-created rows were campaign-owned unless a later
-- admin reuse explicitly promotes them through the application transaction.
ALTER TABLE "sim_urans_requests"
  ADD COLUMN IF NOT EXISTS "background_owner" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "sim_urans_requests"
SET "background_owner" = true
WHERE "requested_by" IS DISTINCT FROM 'system:precalc-continuation-v1';
--> statement-breakpoint

-- Now that current independent ownership is explicit, terminalize only truly
-- ownerless pre-submit work. Running work already crossed the solver boundary
-- and remains eligible to finish and ingest its immutable evidence.
UPDATE "sim_urans_requests" req
SET "state" = 'cancelled', "updatedAt" = now()
WHERE req."state" = 'pending'
  AND req."background_owner" = false
  AND NOT EXISTS (
    SELECT 1
    FROM "sim_urans_request_campaigns" owner
    WHERE owner."request_id" = req."id" AND owner."state" = 'active'
  );
