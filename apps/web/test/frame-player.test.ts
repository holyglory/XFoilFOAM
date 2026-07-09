// Frame-player math pins for the URANS solver-results modal (task #25).
// Shapes mirror the real API payload (SimulationDetail.frameTrack from
// apps/api frameTrackDetailOf): camelCase stats/window, <=120 frames,
// per-frame imageUrls keyed by field with honest gaps for unregistered PNGs.

import { describe, expect, it } from "vitest";

import {
  advancePlayback,
  buildFramePlayerModel,
  chartXForTime,
  clampFrameIndex,
  defaultFrameField,
  frameForChartX,
  frameForScrubFrac,
  frameImageUrl,
  frameIndexForTime,
  historyFracForTime,
  PLAYER_CHART_GEOMETRY,
  periodTickFractions,
  periodOrdinal,
  playbackSimRate,
  scrubFracForFrame,
  timeForFrameIndex,
  WALL_SECONDS_PER_PERIOD,
  windowPeriodCount,
  type FramePlayerModel,
} from "../lib/frame-player";

type FrameTrackDetail = NonNullable<Parameters<typeof buildFramePlayerModel>[0]>;

const STATS = {
  cl: { mean: 0.912, std: 0.148, min: 0.61, max: 1.19 },
  cd: { mean: 0.0421, std: 0.0063, min: 0.031, max: 0.055 },
  cm: { mean: -0.0318, std: 0.0045, min: -0.041, max: -0.02 },
};

/** Real-shaped track: 48 frames over 2 periods of 0.5 s (24/period), both
 *  contract fields, one frame missing its velocity PNG (evidence gap). */
function realTrack(overrides: Partial<FrameTrackDetail> = {}): FrameTrackDetail {
  const frames = Array.from({ length: 48 }, (_, k) => {
    const stamp = `f${String(72 + k).padStart(4, "0")}.png`;
    const imageUrls: Record<string, string> = { vorticity: `/api/media/results/r1/frames/vorticity/${stamp}` };
    if (k !== 5) imageUrls.velocity_magnitude = `/api/media/results/r1/frames/velocity_magnitude/${stamp}`;
    return {
      i: 72 + k,
      t: 3.0 + (k * 1.0) / 47,
      cl: 0.912 + 0.148 * Math.sin((2 * Math.PI * k) / 24),
      cd: 0.0421 + 0.0063 * Math.sin((2 * Math.PI * k) / 24 + 0.7),
      cm: -0.0318 + 0.0045 * Math.cos((2 * Math.PI * k) / 24),
      imageUrls,
    };
  });
  return {
    periodS: 0.5,
    periodsRetained: 6,
    stationary: true,
    driftFrac: 0.012,
    window: { tStart: 3.0, tEnd: 4.0 },
    stats: STATS,
    fields: ["vorticity", "velocity_magnitude"],
    frames,
    ...overrides,
  };
}

function model(overrides: Partial<FrameTrackDetail> = {}): FramePlayerModel {
  const m = buildFramePlayerModel(realTrack(overrides));
  if (!m) throw new Error("expected a player model");
  return m;
}

describe("buildFramePlayerModel — payload → player model incl. legacy fallback", () => {
  it("legacy evidence (frameTrack null/undefined) yields null → mp4 fallback", () => {
    expect(buildFramePlayerModel(null)).toBeNull();
    expect(buildFramePlayerModel(undefined)).toBeNull();
  });

  it("an empty frame list is legacy too — never a fake single-frame player", () => {
    expect(buildFramePlayerModel(realTrack({ frames: [] }))).toBeNull();
  });

  it("assembles window, duration, stats and fields verbatim", () => {
    const m = model();
    expect(m.frames).toHaveLength(48);
    expect(m.tStart).toBe(3.0);
    expect(m.tEnd).toBe(4.0);
    expect(m.durationS).toBeCloseTo(1.0, 12);
    expect(m.periodS).toBe(0.5);
    expect(m.periodsRetained).toBe(6);
    expect(m.stationary).toBe(true);
    expect(m.driftFrac).toBeCloseTo(0.012);
    expect(m.stats).toEqual(STATS);
    expect(m.fields).toEqual(["vorticity", "velocity_magnitude"]);
  });

  it("sorts frames by time even if the payload arrives shuffled", () => {
    const track = realTrack();
    const shuffled = { ...track, frames: [...track.frames].reverse() };
    const m = buildFramePlayerModel(shuffled);
    expect(m).not.toBeNull();
    for (let k = 1; k < m!.times.length; k++) expect(m!.times[k]).toBeGreaterThanOrEqual(m!.times[k - 1]);
  });

  it("counts registered frame images per field — gaps stay gaps", () => {
    const m = model();
    expect(m.frameImageCounts.vorticity).toBe(48);
    expect(m.frameImageCounts.velocity_magnitude).toBe(47); // one PNG never registered
    expect(m.imageFields).toEqual(["vorticity", "velocity_magnitude"]);
  });

  it("a field with zero registered images is excluded from imageFields but kept in fields", () => {
    const track = realTrack();
    const stripped = {
      ...track,
      frames: track.frames.map((f) => ({ ...f, imageUrls: { vorticity: f.imageUrls.vorticity! } })),
    };
    const m = buildFramePlayerModel(stripped)!;
    expect(m.fields).toEqual(["vorticity", "velocity_magnitude"]);
    expect(m.imageFields).toEqual(["vorticity"]);
    expect(m.frameImageCounts.velocity_magnitude).toBe(0);
  });

  it("clamps the playback domain to the frame-COVERED span when the stats window is wider (F4: no frozen left half)", () => {
    // Shipped-fixture shape: stats window spans K=7 periods but frames cover
    // only the last ~2 (engine exports min(3, K) periods of frames). The old
    // full-window domain froze >half of every loop on frame 0 and mapped the
    // left half of the scrub bar / Cl(t) chart to a single frame.
    const m = model({ window: { tStart: 1.0, tEnd: 4.0 }, periodsRetained: 7 });
    const step = 1.0 / 47;
    expect(m.tStart).toBeCloseTo(3.0 - step, 9);
    expect(m.tEnd).toBe(4.0);
    expect(m.durationS).toBeCloseTo(1.0 + step, 9);
    // Frame 0 sits at the very start of the scrub bar, not 2/3 across.
    expect(scrubFracForFrame(m, 0)).toBeLessThan(0.05);
    // The stats stay the full-window truth (displayed unchanged).
    expect(m.periodsRetained).toBe(7);
    expect(m.stats).toEqual(STATS);
    // Every scrub position maps to a distinct region of frames — the first
    // 40% of the bar is no longer a single frozen frame.
    expect(frameForScrubFrac(m, 0.4)).toBeGreaterThan(10);
  });

  it("degenerate window metadata falls back to the actual frame span", () => {
    const m = model({ window: { tStart: 9, tEnd: 9 } });
    expect(m.tStart).toBeCloseTo(3.0);
    expect(m.tEnd).toBeCloseTo(4.0);
    expect(m.durationS).toBeGreaterThan(0);
  });

  it("non-positive or null period_s normalizes to null", () => {
    expect(model({ periodS: null }).periodS).toBeNull();
    expect(model({ periodS: 0 }).periodS).toBeNull();
    expect(model({ periodS: -1 }).periodS).toBeNull();
  });
});

describe("frame index ↔ time mapping", () => {
  it("maps exact frame times to their indices", () => {
    const m = model();
    expect(frameIndexForTime(m.times, m.times[0])).toBe(0);
    expect(frameIndexForTime(m.times, m.times[20])).toBe(20);
    expect(frameIndexForTime(m.times, m.times[47])).toBe(47);
  });

  it("picks the NEAREST frame between samples, earlier frame on an exact tie", () => {
    const times = [0, 1, 2, 3];
    expect(frameIndexForTime(times, 0.4)).toBe(0);
    expect(frameIndexForTime(times, 0.6)).toBe(1);
    expect(frameIndexForTime(times, 1.5)).toBe(1); // tie → earlier
    expect(frameIndexForTime(times, 2.51)).toBe(3);
  });

  it("clamps outside the window and survives junk input", () => {
    const times = [2, 3, 4];
    expect(frameIndexForTime(times, -100)).toBe(0);
    expect(frameIndexForTime(times, 100)).toBe(2);
    expect(frameIndexForTime(times, Number.NaN)).toBe(0);
    expect(frameIndexForTime([], 1)).toBe(-1);
    expect(frameIndexForTime([7], 99)).toBe(0);
  });

  it("timeForFrameIndex clamps the index into range", () => {
    const m = model();
    expect(timeForFrameIndex(m, -5)).toBe(m.times[0]);
    expect(timeForFrameIndex(m, 47)).toBe(m.times[47]);
    expect(timeForFrameIndex(m, 400)).toBe(m.times[47]);
  });

  it("clampFrameIndex handles empty and non-finite", () => {
    expect(clampFrameIndex(0, 3)).toBe(-1);
    expect(clampFrameIndex(10, Number.NaN)).toBe(0);
    expect(clampFrameIndex(10, 9.6)).toBe(9);
    expect(clampFrameIndex(10, -2)).toBe(0);
  });
});

describe("scrub bar mapping", () => {
  it("frame → frac → frame round-trips for every frame", () => {
    const m = model();
    for (let k = 0; k < m.frames.length; k++) {
      expect(frameForScrubFrac(m, scrubFracForFrame(m, k))).toBe(k);
    }
  });

  it("frac endpoints hit the first/last frame; junk fracs clamp", () => {
    const m = model();
    expect(frameForScrubFrac(m, 0)).toBe(0);
    expect(frameForScrubFrac(m, 1)).toBe(47);
    expect(frameForScrubFrac(m, -3)).toBe(0);
    expect(frameForScrubFrac(m, 7)).toBe(47);
    expect(frameForScrubFrac(m, Number.NaN)).toBe(0);
  });

  it("a single-frame track pins the scrub to 0 without dividing by zero", () => {
    const track = realTrack();
    const single = buildFramePlayerModel({ ...track, frames: [track.frames[0]], window: { tStart: 3, tEnd: 3 } })!;
    expect(single.durationS).toBe(0);
    expect(scrubFracForFrame(single, 0)).toBe(0);
    expect(frameForScrubFrac(single, 0.7)).toBe(0);
  });
});

describe("chart x ↔ frame mapping (shared geometry)", () => {
  const geom = { width: 520, ...PLAYER_CHART_GEOMETRY };

  it("chartXForTime and frameForChartX are inverse over the plot area", () => {
    const m = model();
    for (const k of [0, 7, 23, 40, 47]) {
      const x = chartXForTime(m.times[k], m, geom);
      expect(frameForChartX(x, m, geom)).toBe(k);
    }
  });

  it("clicks left of / right of the plot clamp to the first/last frame", () => {
    const m = model();
    expect(frameForChartX(0, m, geom)).toBe(0);
    expect(frameForChartX(geom.padLeft - 1, m, geom)).toBe(0);
    expect(frameForChartX(geom.width + 50, m, geom)).toBe(47);
  });

  it("window edges land on the plot edges", () => {
    const m = model();
    expect(chartXForTime(m.tStart, m, geom)).toBe(geom.padLeft);
    expect(chartXForTime(m.tEnd, m, geom)).toBe(geom.width - geom.padRight);
  });
});

describe("play cadence math", () => {
  it("1× advances exactly one period of sim time per WALL_SECONDS_PER_PERIOD", () => {
    const m = model();
    expect(playbackSimRate(m, 1)).toBeCloseTo(0.5 / WALL_SECONDS_PER_PERIOD, 12);
    const after = advancePlayback(m.tStart, WALL_SECONDS_PER_PERIOD, 1, m);
    expect(after).toBeCloseTo(m.tStart + 0.5, 9);
  });

  it("0.5× advances half a period in the same wall time", () => {
    const m = model();
    const after = advancePlayback(m.tStart, WALL_SECONDS_PER_PERIOD, 0.5, m);
    expect(after).toBeCloseTo(m.tStart + 0.25, 9);
  });

  it("loops back inside the window instead of running off the end", () => {
    const m = model(); // window = 2 periods = 2 wall-seconds at 1×
    const after = advancePlayback(m.tStart, 2.5 * WALL_SECONDS_PER_PERIOD, 1, m);
    expect(after).toBeCloseTo(m.tStart + 0.25, 9);
    expect(after).toBeGreaterThanOrEqual(m.tStart);
    expect(after).toBeLessThan(m.tEnd);
  });

  it("accumulates fine rAF deltas the same as one big step", () => {
    const m = model();
    let t = m.tStart;
    for (let step = 0; step < 60; step++) t = advancePlayback(t, 1 / 60, 1, m);
    expect(t).toBeCloseTo(advancePlayback(m.tStart, 1, 1, m), 6);
  });

  it("no measured period → paces by the window's recorded period count fallback", () => {
    const m = model({ periodS: null });
    // Fallback: duration / periodsRetained-normalized count is finite and > 0.
    expect(playbackSimRate(m, 1)).toBeGreaterThan(0);
    const after = advancePlayback(m.tStart, 0.5, 1, m);
    expect(after).toBeGreaterThan(m.tStart);
    expect(after).toBeLessThanOrEqual(m.tEnd);
  });

  it("degenerate window stays pinned at tStart (no NaN drift)", () => {
    const track = realTrack();
    const single = buildFramePlayerModel({ ...track, frames: [track.frames[0]], window: { tStart: 3, tEnd: 3 } })!;
    expect(single.durationS).toBe(0);
    expect(advancePlayback(3, 1, 1, single)).toBe(3);
    const noPeriod = buildFramePlayerModel({ ...track, periodS: null, frames: [track.frames[0]], window: { tStart: 3, tEnd: 3 } })!;
    expect(playbackSimRate(noPeriod, 1)).toBe(0);
    expect(advancePlayback(3, 1, 1, noPeriod)).toBe(3);
  });

  it("junk sim time / dt inputs stay inside the window", () => {
    const m = model();
    expect(advancePlayback(Number.NaN, 0.1, 1, m)).toBeGreaterThanOrEqual(m.tStart);
    expect(advancePlayback(m.tStart, Number.NaN, 1, m)).toBe(m.tStart);
    expect(advancePlayback(m.tStart, -5, 1, m)).toBe(m.tStart);
  });
});

describe("period ordinal overlay", () => {
  it("labels frames with their 1-based period within the recorded window", () => {
    const m = model(); // 2 periods of 0.5 s
    expect(windowPeriodCount(m)).toBe(2);
    expect(periodOrdinal(m, 0)).toEqual({ ordinal: 1, total: 2 });
    expect(periodOrdinal(m, 10)).toEqual({ ordinal: 1, total: 2 }); // t≈3.21
    expect(periodOrdinal(m, 30)).toEqual({ ordinal: 2, total: 2 }); // t≈3.64
    expect(periodOrdinal(m, 47)).toEqual({ ordinal: 2, total: 2 }); // t=4.0 clamps into last period
  });

  it("no measured period → no ordinal (shown as absent, not invented)", () => {
    expect(periodOrdinal(model({ periodS: null }), 10)).toBeNull();
    expect(windowPeriodCount(model({ periodS: null }))).toBeNull();
  });
});

describe("period tick fractions", () => {
  it("returns interior whole-period boundaries for the scrubber", () => {
    const m = model(); // tStart 3.0, tEnd 4.0, period 0.5 → one interior boundary
    expect(periodTickFractions(m)).toEqual([0.5]);
  });

  it("returns no visual ticks when no measured period/window exists", () => {
    expect(periodTickFractions(model({ periodS: null }))).toEqual([]);
    const single = buildFramePlayerModel({ ...realTrack(), frames: [realTrack().frames[0]], window: { tStart: 3, tEnd: 3 } })!;
    expect(periodTickFractions(single)).toEqual([]);
  });
});

describe("frame image resolution", () => {
  it("returns the registered URL for field+frame and null for gaps", () => {
    const m = model();
    expect(frameImageUrl(m, 0, "vorticity")).toContain("/frames/vorticity/f0072.png");
    expect(frameImageUrl(m, 5, "velocity_magnitude")).toBeNull(); // the unregistered PNG
    expect(frameImageUrl(m, 5, "vorticity")).toContain("f0077.png");
    expect(frameImageUrl(m, 0, "pressure")).toBeNull(); // field not in the track
    expect(frameImageUrl(m, 0, null)).toBeNull();
  });

  it("defaultFrameField prefers the first contract field with images", () => {
    const m = model();
    expect(defaultFrameField(m)).toBe("vorticity");
    const track = realTrack();
    const noImages = buildFramePlayerModel({
      ...track,
      frames: track.frames.map((f) => ({ ...f, imageUrls: {} })),
    })!;
    // No images at all: still surfaces the contract field so the pane can say
    // "no frame images registered" honestly.
    expect(noImages.imageFields).toEqual([]);
    expect(defaultFrameField(noImages)).toBe("vorticity");
  });
});

describe("history cursor sync", () => {
  it("maps a frame time to the nearest full-history sample fraction", () => {
    const historyT = Array.from({ length: 101 }, (_, k) => k * 0.04); // 0..4 s
    expect(historyFracForTime(historyT, 0)).toBe(0);
    expect(historyFracForTime(historyT, 4)).toBe(1);
    expect(historyFracForTime(historyT, 2)).toBeCloseTo(0.5, 12);
    // 3.5 s falls exactly between samples 87 and 88 — the tie resolves to the
    // earlier sample, same rule as frameIndexForTime.
    expect(historyFracForTime(historyT, 3.5)).toBeCloseTo(0.87, 6);
  });

  it("empty or single-sample histories map to 0", () => {
    expect(historyFracForTime([], 2)).toBe(0);
    expect(historyFracForTime([1], 2)).toBe(0);
  });
});
