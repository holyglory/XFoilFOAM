-- Exhausted non-aerodynamic steady-RANS recovery is a solver reliability
-- incident, not a normal RANS -> preliminary-URANS handoff and not a human
-- coefficient-review task. Own those immutable occurrences by the exact
-- result cell that exhausted its one automatic retry.
ALTER TABLE "sim_solver_incidents"
  ADD COLUMN "result_id" uuid
    REFERENCES "results"("id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "sim_solver_incidents"
  DROP CONSTRAINT "sim_solver_incidents_owner_xor_check";
--> statement-breakpoint

ALTER TABLE "sim_solver_incidents"
  ADD CONSTRAINT "sim_solver_incidents_owner_xor_check"
  CHECK (
    num_nonnulls(
      "result_id",
      "precalc_obligation_id",
      "verify_queue_id",
      "urans_request_id"
    ) = 1
  );
--> statement-breakpoint

ALTER TABLE "sim_solver_incidents"
  DROP CONSTRAINT "sim_solver_incidents_stage_check";
--> statement-breakpoint

ALTER TABLE "sim_solver_incidents"
  ADD CONSTRAINT "sim_solver_incidents_stage_check"
  CHECK ("stage" IN ('rans', 'preliminary', 'final'));
--> statement-breakpoint

-- MATCH SIMPLE deliberately leaves PRELIMINARY/FINAL owner rows valid when
-- result_id is NULL, while a result-owned RANS incident can reference only an
-- attempt from that exact canonical result. The existing id-only FK keeps its
-- ON DELETE SET NULL behavior for immutable incident history.
ALTER TABLE "sim_solver_incidents"
  ADD CONSTRAINT "sim_solver_incidents_result_attempt_owner_fk"
  FOREIGN KEY ("result_attempt_id", "result_id")
  REFERENCES "result_attempts"("id", "result_id")
  MATCH SIMPLE;
--> statement-breakpoint

CREATE INDEX "sim_solver_incidents_result_owner_idx"
  ON "sim_solver_incidents" ("result_id", "status");
