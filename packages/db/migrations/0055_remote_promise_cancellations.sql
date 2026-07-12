CREATE TABLE sync_remote_promise_cancellations (
  promise_id uuid PRIMARY KEY NOT NULL,
  state text DEFAULT 'pending' NOT NULL,
  attempt_count integer DEFAULT 0 NOT NULL,
  next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
  last_http_status integer,
  last_error text,
  delivered_at timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT sync_remote_promise_cancellations_state_check
    CHECK (state IN ('pending', 'retry_wait', 'delivered')),
  CONSTRAINT sync_remote_promise_cancellations_attempt_check
    CHECK (attempt_count >= 0)
);
--> statement-breakpoint
ALTER TABLE sync_remote_promise_cancellations
  ADD CONSTRAINT sync_remote_promise_cancellations_promise_fk
  FOREIGN KEY (promise_id) REFERENCES sync_sweep_promises(id);
--> statement-breakpoint
CREATE INDEX sync_remote_promise_cancellations_ready_idx
  ON sync_remote_promise_cancellations (state, next_attempt_at);
--> statement-breakpoint
CREATE INDEX sync_remote_result_deliveries_result_attempt_idx
  ON sync_remote_result_deliveries (result_attempt_id);
--> statement-breakpoint
CREATE INDEX remote_asset_references_result_attempt_idx
  ON remote_asset_references (result_attempt_id);
--> statement-breakpoint
CREATE INDEX sim_precalc_obligations_source_result_attempt_idx
  ON sim_precalc_obligations (source_result_attempt_id);
--> statement-breakpoint
CREATE INDEX sim_precalc_obligation_attempts_result_attempt_idx
  ON sim_precalc_obligation_attempts (result_attempt_id);
--> statement-breakpoint
