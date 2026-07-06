-- Bounded retry for failed shared-scale re-renders (live proof 2026-07-05:
-- one transient engine fetch failure during the vorticity scale re-render
-- marked the scale row failed PERMANENTLY — no re-attempt path existed).
-- render_attempts counts FAILED render attempts; the sweeper's reconcile
-- retry pass re-runs failed rows while render_attempts stays under its cap.
-- Existing failed rows backfill to 0 attempts so the first retry pass after
-- deploy picks them up.
ALTER TABLE "field_color_scales" ADD COLUMN IF NOT EXISTS "render_attempts" integer NOT NULL DEFAULT 0;--> statement-breakpoint
