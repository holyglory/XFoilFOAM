-- URANS frame-track contract (task #23/#24, pinned 2026-07-06): the engine
-- ships per URANS point a period-locked recording window with time-weighted
-- trapezoidal stats over an integer number of periods, <=120 frame samples
-- (~24/period over the last 2-3 periods), the frame-image field list, and the
-- frame PNG image_pattern. Persisted verbatim (snake_case engine shape) so it
-- stays byte-honest evidence.
--
-- NULL semantics (backward compatible, no backfill): NULL = steady /
-- no-shedding point OR legacy pre-contract evidence. The classifier's
-- stationarity gate ("non-stationary" / "insufficient-periods") applies ONLY
-- to non-NULL frame_track, so deploying this migration cannot mass-reject
-- historical accepted URANS rows.
ALTER TABLE "results" ADD COLUMN IF NOT EXISTS "frame_track" jsonb;--> statement-breakpoint
-- Per-frame PNGs ship as evidence files with kind 'frame_image' (pinned as
-- FRAME_IMAGE_ARTIFACT_KIND in @aerodb/engine-client): registered by the
-- existing ingest evidence sweep into solver_evidence_artifacts and resolved
-- to /api/media URLs by the sim payload.
ALTER TYPE "public"."evidence_artifact_kind" ADD VALUE IF NOT EXISTS 'frame_image';--> statement-breakpoint
