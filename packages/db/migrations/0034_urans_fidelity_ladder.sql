-- URANS fidelity ladder (pinned cross-runtime contracts, 2026-07-07):
--   contract 1: request solver.urans_fidelity 'precalc' | 'full' (engine derives
--               min periods 3/7, budget 3600/21600 s, mesh scale 0.5/full);
--   contract 3: results.fidelity 'rans' | 'urans_precalc' | 'urans_full';
--   contract 2: results.steady_history — oscillating-averaged steady solves
--               (iterations/cl/cd/cm columns, window, mean_stable, note;
--               <=2000 samples, downsampled engine-side). NULL = classic
--               pointwise convergence or legacy pre-contract evidence.
--               result_attempts need no column: evidence_payload persists the
--               whole engine PolarPoint verbatim, steady_history included.
--   contract 4: sim_urans_verify_queue — precalc-accepted points re-solved at
--               full fidelity at the LOWEST scheduler priority; deltas recorded;
--               |dCl| > 0.05 OR |dCd| > 0.01 => disagreed (surfaced, never
--               silently swapped).
--   contract 6: sim_urans_requests — admin request-URANS work items at precalc
--               rank, idempotent per (cell, fidelity).
ALTER TABLE "results" ADD COLUMN IF NOT EXISTS "fidelity" text;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN IF NOT EXISTS "steady_history" jsonb;--> statement-breakpoint
-- Backfill (contract 3): every pre-ladder URANS row was solved at what the
-- ladder now calls FULL fidelity (7+ periods, full mesh); steady solved rows
-- are 'rans'. Unsolved rows (regime NULL) stay NULL — honest absence.
UPDATE "results" SET "fidelity" = 'urans_full' WHERE "regime" = 'urans' AND "fidelity" IS NULL;--> statement-breakpoint
UPDATE "results" SET "fidelity" = 'rans' WHERE "regime" = 'rans' AND "fidelity" IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sim_urans_verify_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "airfoil_id" uuid NOT NULL REFERENCES "airfoils"("id") ON DELETE CASCADE,
  "revision_id" uuid NOT NULL REFERENCES "simulation_preset_revisions"("id") ON DELETE CASCADE,
  "aoa_deg" double precision NOT NULL,
  "campaign_id" uuid REFERENCES "sim_campaigns"("id") ON DELETE SET NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "precalc_result_id" uuid NOT NULL REFERENCES "results"("id") ON DELETE CASCADE,
  "verify_result_id" uuid REFERENCES "results"("id") ON DELETE SET NULL,
  "delta_cl" double precision,
  "delta_cd" double precision,
  "delta_cm" double precision,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
-- Idempotent enqueue: one open (pending/running) item per cell.
CREATE UNIQUE INDEX IF NOT EXISTS "sim_urans_verify_queue_open_cell_uq"
  ON "sim_urans_verify_queue" ("airfoil_id", "revision_id", "aoa_deg")
  WHERE "state" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_urans_verify_queue_state_idx" ON "sim_urans_verify_queue" ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_urans_verify_queue_campaign_idx" ON "sim_urans_verify_queue" ("campaign_id", "state");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sim_urans_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "airfoil_id" uuid NOT NULL REFERENCES "airfoils"("id") ON DELETE CASCADE,
  "revision_id" uuid NOT NULL REFERENCES "simulation_preset_revisions"("id") ON DELETE CASCADE,
  "aoa_deg" double precision,
  "fidelity" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "sim_job_id" uuid REFERENCES "sim_jobs"("id") ON DELETE SET NULL,
  "requested_by" text,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
-- Idempotent per (cell, fidelity); NULL aoa_deg = whole polar (NaN sentinel —
-- btree treats NaN as equal to itself, so two whole-polar requests collide).
CREATE UNIQUE INDEX IF NOT EXISTS "sim_urans_requests_open_cell_uq"
  ON "sim_urans_requests" ("airfoil_id", "revision_id", COALESCE("aoa_deg", 'NaN'::float8), "fidelity")
  WHERE "state" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_urans_requests_state_idx" ON "sim_urans_requests" ("state");
