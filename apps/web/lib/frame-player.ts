// Pure math + assembly helpers for the URANS frame-synced player in the
// solver-results modal (SimModal). No DOM, no React — everything here is
// exercised by node vitest (test/frame-player.test.ts).
//
// The player has ONE piece of truth: the current frame index into the
// engine-recorded frame track (results.frame_track → SimulationDetail.frameTrack).
// Every surface — scrub bar, Cl(t) window chart cursor, frame image, overlay
// readout — derives from that index through these helpers. Legacy points
// (frameTrack null/absent: steady, no-shedding, or pre-contract evidence)
// yield a null model and the modal falls back to the stored mp4 loop with an
// explicit "legacy evidence" note — frames are never invented.

import type { FrameTrackDetail, FrameTrackFrameDetail } from "@aerodb/core";

export interface FramePlayerModel {
  /** Frames sorted ascending by simulation time. */
  frames: FrameTrackFrameDetail[];
  /** frames[].t (same order) — the domain for all time↔index mapping. */
  times: number[];
  /** Recording window (period-locked, integer number of periods). */
  tStart: number;
  tEnd: number;
  /** tEnd - tStart, always >= 0. */
  durationS: number;
  periodS: number | null;
  periodsRetained: number;
  stationary: boolean;
  driftFrac: number;
  /** Time-weighted trapezoidal stats over the integer-period window. */
  stats: FrameTrackDetail["stats"];
  /** Frame-image fields in engine contract order (output-profile order). */
  fields: string[];
  /** Subset of fields with at least one registered frame image. */
  imageFields: string[];
  /** Registered frame-image count per field (honest preload denominator). */
  frameImageCounts: Record<string, number>;
}

/** Wall-clock seconds one shedding period takes at 1× speed. The engine ships
 *  ~24 frames per period, so 1 s/period plays at ~24 fps (0.5× → ~12 fps). */
export const WALL_SECONDS_PER_PERIOD = 1;

export const PLAYBACK_SPEEDS = [1, 0.5] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/** Chart plot-area geometry in canvas pixel space; the draw code and the
 *  pointer→frame mapping must share one instance or cursors drift off-click. */
export interface ChartGeometry {
  width: number;
  padLeft: number;
  padRight: number;
}

export const PLAYER_CHART_GEOMETRY: Omit<ChartGeometry, "width"> = { padLeft: 44, padRight: 10 };

/** Assemble the player model from the API payload. Returns null for legacy
 *  evidence (no frame track, or an empty frame list) — the caller must fall
 *  back to the stored mp4 loop, never synthesize frames. */
export function buildFramePlayerModel(frameTrack: FrameTrackDetail | null | undefined): FramePlayerModel | null {
  if (!frameTrack) return null;
  const frames = frameTrack.frames
    .filter((f) => Number.isFinite(f.t))
    .slice()
    .sort((a, b) => a.t - b.t);
  if (frames.length === 0) return null;
  const times = frames.map((f) => f.t);
  let tStart = frameTrack.window.tStart;
  let tEnd = frameTrack.window.tEnd;
  if (!Number.isFinite(tStart) || !Number.isFinite(tEnd) || tEnd <= tStart) {
    // Degenerate window metadata: fall back to the actual frame span.
    tStart = times[0];
    tEnd = times[times.length - 1];
  }
  // The stats window spans K whole periods but frames cover only the LAST
  // min(3, K) of them (engine frame-export contract). The playback / scrub /
  // chart domain must be the frame-COVERED span — with the full window most
  // of every loop froze on frame 0 and the left half of the scrub bar and
  // Cl(t) chart mapped to a single frame. The window STATS still describe the
  // full integer-period window and are displayed unchanged. The first frame
  // sits one export step AFTER the coverage start (the contract excludes the
  // span start for uniform phase coverage), so coverage begins one mean step
  // before frames[0].
  if (times.length >= 2) {
    const step = (times[times.length - 1] - times[0]) / (times.length - 1);
    tStart = Math.max(tStart, times[0] - step);
  } else {
    tStart = Math.max(tStart, times[0]);
  }
  tEnd = Math.min(tEnd, times[times.length - 1]);
  if (!(tEnd > tStart)) {
    tStart = times[0];
    tEnd = times[times.length - 1];
  }
  const frameImageCounts: Record<string, number> = {};
  for (const field of frameTrack.fields) frameImageCounts[field] = 0;
  for (const frame of frames) {
    for (const field of Object.keys(frame.imageUrls)) {
      frameImageCounts[field] = (frameImageCounts[field] ?? 0) + 1;
    }
  }
  const imageFields = frameTrack.fields.filter((field) => (frameImageCounts[field] ?? 0) > 0);
  const periodS = frameTrack.periodS != null && Number.isFinite(frameTrack.periodS) && frameTrack.periodS > 0 ? frameTrack.periodS : null;
  return {
    frames,
    times,
    tStart,
    tEnd,
    durationS: Math.max(0, tEnd - tStart),
    periodS,
    periodsRetained: frameTrack.periodsRetained,
    stationary: frameTrack.stationary,
    driftFrac: frameTrack.driftFrac,
    stats: frameTrack.stats,
    fields: frameTrack.fields,
    imageFields,
    frameImageCounts,
  };
}

export function clampFrameIndex(frameCount: number, index: number): number {
  if (frameCount <= 0) return -1;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(frameCount - 1, Math.round(index)));
}

/** Nearest frame index for a simulation time (binary search; ties → earlier
 *  frame). Empty time list → -1. */
export function frameIndexForTime(times: number[], t: number): number {
  const n = times.length;
  if (n === 0) return -1;
  if (!Number.isFinite(t) || t <= times[0]) return 0;
  if (t >= times[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return t - times[lo] <= times[hi] - t ? lo : hi;
}

export function timeForFrameIndex(model: FramePlayerModel, index: number): number {
  const idx = clampFrameIndex(model.frames.length, index);
  return idx < 0 ? model.tStart : model.times[idx];
}

/** Scrub-bar position (0..1 within the recording window) for a frame. */
export function scrubFracForFrame(model: FramePlayerModel, index: number): number {
  if (model.durationS <= 0) return 0;
  const t = timeForFrameIndex(model, index);
  return Math.max(0, Math.min(1, (t - model.tStart) / model.durationS));
}

/** Nearest frame for a scrub-bar position (0..1). */
export function frameForScrubFrac(model: FramePlayerModel, frac: number): number {
  const f = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0;
  return frameIndexForTime(model.times, model.tStart + f * model.durationS);
}

/** Canvas x (pixel) where a simulation time falls in the window chart. */
export function chartXForTime(t: number, model: FramePlayerModel, geom: ChartGeometry): number {
  const plotW = Math.max(1, geom.width - geom.padLeft - geom.padRight);
  if (model.durationS <= 0) return geom.padLeft;
  const frac = Math.max(0, Math.min(1, (t - model.tStart) / model.durationS));
  return geom.padLeft + frac * plotW;
}

/** Nearest frame for a canvas x (pixel) — the chart click/drag → frame map.
 *  X outside the plot area clamps to the first/last frame. */
export function frameForChartX(x: number, model: FramePlayerModel, geom: ChartGeometry): number {
  const plotW = Math.max(1, geom.width - geom.padLeft - geom.padRight);
  const frac = Math.max(0, Math.min(1, (x - geom.padLeft) / plotW));
  return frameForScrubFrac(model, frac);
}

/** Simulation seconds advanced per wall-clock second at the given speed:
 *  one shedding period per WALL_SECONDS_PER_PERIOD at 1×. When the engine
 *  shipped no usable period (period_s null), the window length divided by the
 *  recorded period count stands in so playback still paces per-period. */
export function playbackSimRate(model: FramePlayerModel, speed: PlaybackSpeed): number {
  const period = model.periodS ?? (model.durationS > 0 ? model.durationS / Math.max(1, windowPeriodCount(model) ?? 1) : 0);
  if (period <= 0) return 0;
  return (period / WALL_SECONDS_PER_PERIOD) * speed;
}

/** Advance the playback clock by a wall-clock dt, looping inside the
 *  recording window. Degenerate windows stay pinned at tStart. */
export function advancePlayback(simTime: number, wallDtSeconds: number, speed: PlaybackSpeed, model: FramePlayerModel): number {
  if (model.durationS <= 0) return model.tStart;
  const rate = playbackSimRate(model, speed);
  const base = Number.isFinite(simTime) ? simTime : model.tStart;
  const dt = Number.isFinite(wallDtSeconds) && wallDtSeconds > 0 ? wallDtSeconds : 0;
  const advanced = base - model.tStart + dt * rate;
  const wrapped = ((advanced % model.durationS) + model.durationS) % model.durationS;
  return model.tStart + wrapped;
}

/** Number of shedding periods inside the recording window (contract: an
 *  integer count, typically 2–3). null when no period was measured. */
export function windowPeriodCount(model: FramePlayerModel): number | null {
  if (model.periodS == null || model.durationS <= 0) return null;
  return Math.max(1, Math.round(model.durationS / model.periodS));
}

/** 1-based period ordinal of a frame within the recording window, for the
 *  image overlay readout ("period 2/3"). null when no period was measured. */
export function periodOrdinal(model: FramePlayerModel, index: number): { ordinal: number; total: number } | null {
  const total = windowPeriodCount(model);
  if (total == null || model.periodS == null) return null;
  const t = timeForFrameIndex(model, index);
  const ordinal = Math.min(total, Math.max(1, Math.floor((t - model.tStart) / model.periodS + 1e-9) + 1));
  return { ordinal, total };
}

/** Frame PNG URL for a field at a frame — null when that frame's image
 *  evidence is not registered (absence stays absence; no invented URL). */
export function frameImageUrl(model: FramePlayerModel, index: number, field: string | null): string | null {
  if (!field) return null;
  const idx = clampFrameIndex(model.frames.length, index);
  if (idx < 0) return null;
  return model.frames[idx].imageUrls[field] ?? null;
}

/** Default frame field: first contract-ordered field with registered images,
 *  else the first contract field (its pane shows the honest missing state). */
export function defaultFrameField(model: FramePlayerModel): string | null {
  return model.imageFields[0] ?? model.fields[0] ?? null;
}

/** Cursor position (0..1) in the FULL force-history charts for a frame time,
 *  so the secondary Cl/Cd/LD monitors stay synced to the player. Nearest
 *  history sample wins; an empty history maps to 0. */
export function historyFracForTime(historyT: number[], t: number): number {
  if (historyT.length < 2) return 0;
  const idx = frameIndexForTime(historyT, t);
  return idx <= 0 ? 0 : idx / (historyT.length - 1);
}
