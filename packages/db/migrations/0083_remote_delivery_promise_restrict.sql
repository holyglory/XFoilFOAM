-- Remote delivery rows are durable audit ownership for one exact promised
-- result generation.  Migration 0052 originally cascaded them with the
-- promise, but the current ownership contract requires an explicit teardown.
-- Replace the legacy action in one transactional ALTER so a migrated database
-- matches the schema and cannot silently erase delivery evidence.
ALTER TABLE "sync_remote_result_deliveries"
  DROP CONSTRAINT "sync_remote_result_deliveries_promise_id_fk",
  ADD CONSTRAINT "sync_remote_result_deliveries_promise_id_fk"
    FOREIGN KEY ("promise_id") REFERENCES "sync_sweep_promises"("id")
    ON DELETE RESTRICT;
--> statement-breakpoint
