// FRAME-TRACK CONTRACT (pinned 2026-07-06, task #23/#24). The engine ships
// per URANS point in result.json: point.frame_track with EXACTLY this shape.
// The point-level cl/cd/cm/strouhal = frame_track.stats means / measured St
// (single source of truth). No-shedding steady points ship frame_track=null.
//
// Drift is a test failure on BOTH sides (same pattern as the orphan-message
// pin, WORKER_RESTART_ORPHAN_MESSAGE):
// - node:   apps/sweeper/test/frame-track-contract-pin.test.ts
//           (fixture: apps/sweeper/test/fixtures/frame-track-contract.json)
// - python: engine serialization test against the same shape.

/** Time-weighted trapezoidal stats over an INTEGER number of periods. */
export interface FrameTrackStats {
  mean: number;
  std: number;
  min: number;
  max: number;
}

/** One recorded frame: index, physical time, instantaneous coefficients. */
export interface FrameTrackFrame {
  i: number;
  t: number;
  cl: number;
  cd: number;
  cm: number;
}

export interface FrameTrack {
  period_s: number | null;
  periods_retained: number;
  stationary: boolean;
  drift_frac: number;
  window: { t_start: number; t_end: number };
  stats: { cl: FrameTrackStats; cd: FrameTrackStats; cm: FrameTrackStats };
  /** Frame-image fields (output-profile configurable; default these two). */
  fields: string[];
  /** <=120 frames, ~24/period over the last 2-3 periods. */
  frames: FrameTrackFrame[];
  /** 640px-wide PNGs under the case dir, shipped as evidence files. */
  image_pattern: string;
}

/** Hard payload bound pinned by the contract: frames.length <= 120. */
export const FRAME_TRACK_MAX_FRAMES = 120;

/** Evidence-artifact kind the engine stamps on per-frame PNGs so the node
 *  evidence sweep (solver_evidence_artifacts) can register and expose them.
 *  Pinned cross-runtime like the orphan message: engine must ship frames with
 *  exactly this kind literal. */
export const FRAME_IMAGE_ARTIFACT_KIND = "frame_image";

export type FrameTrackParseResult = { ok: true; value: FrameTrack } | { ok: false; errors: string[] };

const TOP_KEYS = [
  "period_s",
  "periods_retained",
  "stationary",
  "drift_frac",
  "window",
  "stats",
  "fields",
  "frames",
  "image_pattern",
] as const;
const WINDOW_KEYS = ["t_start", "t_end"] as const;
const STATS_KEYS = ["cl", "cd", "cm"] as const;
const STAT_KEYS = ["mean", "std", "min", "max"] as const;
const FRAME_KEYS = ["i", "t", "cl", "cd", "cm"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function checkExactKeys(obj: Record<string, unknown>, allowed: readonly string[], at: string, errors: string[]): void {
  for (const key of allowed) {
    if (!(key in obj)) errors.push(`${at}: missing key "${key}"`);
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${at}: unexpected key "${key}" (contract drift)`);
  }
}

/** Strict structural validator for the pinned frame_track contract shape.
 *  Accepts the exact shape only: any missing, extra, or wrongly-typed key is
 *  an error (drifted engine payloads must FAIL tests, never pass silently).
 *  `null` is a valid frame_track value only at the PolarPoint level (steady /
 *  no-shedding) — pass that case through before calling this. */
export function parseFrameTrack(value: unknown): FrameTrackParseResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: [`frame_track: expected object, got ${value === null ? "null" : typeof value}`] };
  }
  checkExactKeys(value, TOP_KEYS, "frame_track", errors);

  if ("period_s" in value && value.period_s !== null && !finiteNumber(value.period_s)) {
    errors.push("frame_track.period_s: expected finite number or null");
  }
  if ("periods_retained" in value && !finiteNumber(value.periods_retained)) {
    errors.push("frame_track.periods_retained: expected finite number");
  }
  if ("stationary" in value && typeof value.stationary !== "boolean") {
    errors.push("frame_track.stationary: expected boolean");
  }
  if ("drift_frac" in value && !finiteNumber(value.drift_frac)) {
    errors.push("frame_track.drift_frac: expected finite number");
  }

  if ("window" in value) {
    if (!isRecord(value.window)) {
      errors.push("frame_track.window: expected object");
    } else {
      checkExactKeys(value.window, WINDOW_KEYS, "frame_track.window", errors);
      for (const key of WINDOW_KEYS) {
        if (key in value.window && !finiteNumber(value.window[key])) {
          errors.push(`frame_track.window.${key}: expected finite number`);
        }
      }
    }
  }

  if ("stats" in value) {
    if (!isRecord(value.stats)) {
      errors.push("frame_track.stats: expected object");
    } else {
      checkExactKeys(value.stats, STATS_KEYS, "frame_track.stats", errors);
      for (const coeff of STATS_KEYS) {
        const stat = value.stats[coeff];
        if (!(coeff in value.stats)) continue;
        if (!isRecord(stat)) {
          errors.push(`frame_track.stats.${coeff}: expected object`);
          continue;
        }
        checkExactKeys(stat, STAT_KEYS, `frame_track.stats.${coeff}`, errors);
        for (const key of STAT_KEYS) {
          if (key in stat && !finiteNumber(stat[key])) {
            errors.push(`frame_track.stats.${coeff}.${key}: expected finite number`);
          }
        }
      }
    }
  }

  if ("fields" in value) {
    if (!Array.isArray(value.fields) || value.fields.some((f) => typeof f !== "string" || !f)) {
      errors.push("frame_track.fields: expected array of non-empty strings");
    }
  }

  if ("frames" in value) {
    if (!Array.isArray(value.frames)) {
      errors.push("frame_track.frames: expected array");
    } else {
      if (value.frames.length > FRAME_TRACK_MAX_FRAMES) {
        errors.push(`frame_track.frames: ${value.frames.length} frames exceeds contract cap of ${FRAME_TRACK_MAX_FRAMES}`);
      }
      value.frames.forEach((frame, index) => {
        if (!isRecord(frame)) {
          errors.push(`frame_track.frames[${index}]: expected object`);
          return;
        }
        checkExactKeys(frame, FRAME_KEYS, `frame_track.frames[${index}]`, errors);
        for (const key of FRAME_KEYS) {
          if (key in frame && !finiteNumber(frame[key])) {
            errors.push(`frame_track.frames[${index}].${key}: expected finite number`);
          }
        }
        if (finiteNumber(frame.i) && !Number.isInteger(frame.i)) {
          errors.push(`frame_track.frames[${index}].i: expected integer`);
        }
      });
    }
  }

  if ("image_pattern" in value && (typeof value.image_pattern !== "string" || !value.image_pattern)) {
    errors.push("frame_track.image_pattern: expected non-empty string");
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: value as unknown as FrameTrack };
}

/** Render the contract's image_pattern ("frames/{field}/f{i04}.png") for one
 *  (field, frame index). Only the two pinned placeholders are substituted. */
export function frameImageRelativePath(imagePattern: string, field: string, frameIndex: number): string {
  return imagePattern.replaceAll("{field}", field).replaceAll("{i04}", String(frameIndex).padStart(4, "0"));
}
