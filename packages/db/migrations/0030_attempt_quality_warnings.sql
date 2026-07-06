-- Point History Explorer (approved 2026-07-06): persist the engine's per-point
-- non-fatal quality warnings (PolarPoint.quality_warnings, e.g. "URANS shedding
-- unmeasurable", "animation render failed") so the point-story timeline can
-- show the honest WHY behind escalations and rejections. Nullable, no
-- backfill: historical attempts stay NULL — unknown is shown as absent, never
-- invented. Stored on both the immutable attempt evidence row and the
-- canonical results row (same source field at the same ingest write).
ALTER TABLE "result_attempts" ADD COLUMN IF NOT EXISTS "quality_warnings" text[];--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN IF NOT EXISTS "quality_warnings" text[];--> statement-breakpoint
