-- Archive recovery is mutable maintenance work, not solver evidence. An
-- operator running under the disposable-CFD policy may stop a preservation
-- path that no longer beats recomputation. Keep that decision distinct from
-- failed scientific reduction and terminal for the exact attempt/reducer pair.
--> statement-breakpoint

ALTER TABLE "result_interpretation_backfill_items"
  DROP CONSTRAINT "result_interpretation_backfill_items_state_check";
--> statement-breakpoint

ALTER TABLE "result_interpretation_backfill_items"
  ADD CONSTRAINT "result_interpretation_backfill_items_state_check"
  CHECK ("state" IN (
    'pending',
    'hydrating',
    'reduced',
    'missing_evidence',
    'continuation_required',
    'rerun_required',
    'terminal_failure',
    'failed',
    'abandoned'
  ));
