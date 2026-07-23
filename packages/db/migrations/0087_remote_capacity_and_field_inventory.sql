-- Remote execution policy is separate from physical/numerical setup. Keep the
-- existing one-promise default until an administrator raises a solver cap.
ALTER TABLE registered_remote_solvers
  ADD COLUMN IF NOT EXISTS max_active_polar_promises integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE registered_remote_solvers
  ADD CONSTRAINT registered_remote_solvers_max_active_polar_promises_check
  CHECK (max_active_polar_promises BETWEEN 0 AND 1024);
--> statement-breakpoint

-- A submitted job carries its immutable scheduler admission weight. Existing
-- jobs are conservatively one slot; newly composed requests overwrite this
-- with their resolved maximum concurrent solver-process count.
ALTER TABLE sim_jobs
  ADD COLUMN IF NOT EXISTS admission_cpu_slots integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE sim_jobs
  ADD CONSTRAINT sim_jobs_admission_cpu_slots_check
  CHECK (admission_cpu_slots >= 1);
--> statement-breakpoint

ALTER TABLE sync_sweep_promises
  ADD COLUMN IF NOT EXISTS registered_solver_id uuid;
--> statement-breakpoint
ALTER TABLE sync_sweep_promises
  DROP CONSTRAINT IF EXISTS sync_sweep_promises_registered_solver_id_fkey;
--> statement-breakpoint
ALTER TABLE sync_sweep_promises
  ADD CONSTRAINT sync_sweep_promises_registered_solver_id_fkey
  FOREIGN KEY (registered_solver_id)
  REFERENCES registered_remote_solvers(id)
  ON DELETE RESTRICT;
--> statement-breakpoint

-- Backfill only an unambiguous UUID provenance marker. Shared-secret legacy
-- promises remain nullable and are intentionally outside per-solver policy.
UPDATE sync_sweep_promises promise
SET registered_solver_id = solver.id
FROM registered_remote_solvers solver
WHERE promise.registered_solver_id IS NULL
  AND promise.request_payload ->> 'solverId' ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  AND (promise.request_payload ->> 'solverId')::uuid = solver.id
  AND promise.source_instance_id IS NOT DISTINCT FROM solver.instance_id;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sync_sweep_promises_solver_status_idx
  ON sync_sweep_promises (registered_solver_id, status, "expiresAt");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS result_evidence_field_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id uuid NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  result_attempt_id uuid NOT NULL,
  airfoil_id uuid NOT NULL REFERENCES airfoils(id) ON DELETE CASCADE,
  simulation_preset_revision_id uuid NOT NULL
    REFERENCES simulation_preset_revisions(id) ON DELETE CASCADE,
  field text NOT NULL,
  roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_sha256 text NOT NULL,
  source text NOT NULL DEFAULT 'engine_manifest',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT result_evidence_field_inventory_attempt_owner_fk
    FOREIGN KEY (result_attempt_id, result_id)
    REFERENCES result_attempts(id, result_id)
    ON DELETE CASCADE,
  CONSTRAINT result_evidence_field_inventory_roles_array_check
    CHECK (jsonb_typeof(roles) = 'array'),
  CONSTRAINT result_evidence_field_inventory_source_check
  CHECK (btrim(source) <> '')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS result_evidence_field_inventory_result_idx
  ON result_evidence_field_inventory (result_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS result_evidence_field_inventory_attempt_idx
  ON result_evidence_field_inventory (result_attempt_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS
  result_evidence_field_inventory_attempt_field_uq
  ON result_evidence_field_inventory (result_attempt_id, field);
