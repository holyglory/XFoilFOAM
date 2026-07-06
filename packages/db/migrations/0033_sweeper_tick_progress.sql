-- Liveness/progress split (2026-07-06 prod incident: a single hung engine HTTP
-- call inside tick work starved sweeper_state."heartbeatAt" >90 s and the web
-- truth gate derived a false red "PROCESS NOT RUNNING" for a live process).
-- "heartbeatAt" becomes pure LIVENESS, written by an independent 15 s timer in
-- the sweeper process; these two columns become pure TICK PROGRESS, stamped by
-- the loop at tick begin/end. A fresh heartbeat with lastTickStartedAt newer
-- than lastTickCompletedAt and older than 5 min derives the amber tick_stalled
-- state ("engine responding slowly") instead of process death.
ALTER TABLE "sweeper_state" ADD COLUMN IF NOT EXISTS "lastTickStartedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sweeper_state" ADD COLUMN IF NOT EXISTS "lastTickCompletedAt" timestamp with time zone;
