-- Engine-down backoff (docs/simulation-campaigns-spec.md §7): the sweeper
-- records when the engine first became unreachable so the Queue and campaign
-- pages can show one truthful "Engine unreachable since …" banner. Cleared on
-- the first successful probe/submit. Missed in 0025.
ALTER TABLE "sweeper_state" ADD COLUMN IF NOT EXISTS "engineUnreachableSince" timestamp with time zone;--> statement-breakpoint
