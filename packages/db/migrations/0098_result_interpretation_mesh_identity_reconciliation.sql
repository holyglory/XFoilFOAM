-- An upgraded production database can already contain the unpublished
-- result_interpretations table shape that predates mesh identity ownership.
-- Migration 0096 used CREATE TABLE IF NOT EXISTS, which preserved that table
-- without adding its later mesh_identity_id column. Converge that one older
-- shape without disturbing existing interpretation rows.
--> statement-breakpoint

ALTER TABLE "result_interpretations"
  ADD COLUMN IF NOT EXISTS "mesh_identity_id" uuid;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.result_interpretations'::regclass
      AND conname = 'result_interpretations_mesh_owner_fk'
  ) THEN
    ALTER TABLE "result_interpretations"
      ADD CONSTRAINT "result_interpretations_mesh_owner_fk"
      FOREIGN KEY ("mesh_identity_id", "result_attempt_id")
      REFERENCES "result_attempt_mesh_identities"("id", "result_attempt_id")
      ON DELETE RESTRICT;
  END IF;
END $$;
