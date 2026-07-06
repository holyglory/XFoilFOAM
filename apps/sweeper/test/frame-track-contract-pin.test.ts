// FRAME-TRACK CONTRACT PIN (task #23/#24, same cross-runtime pattern as
// orphan-message-pin.test.ts). The engine ships per URANS point
// result.json → point.frame_track with EXACTLY the shape in
// fixtures/frame-track-contract.json; the node parser must accept that exact
// shape and REJECT any drifted key (added, removed, renamed, retyped). If
// either side changes the shape, that side's pin test fails — drift can never
// silently ship un-gated URANS evidence.
// Python twin: engine frame_track serialization test against the same shape.

import {
  FRAME_IMAGE_ARTIFACT_KIND,
  FRAME_TRACK_MAX_FRAMES,
  frameImageRelativePath,
  parseFrameTrack,
  type PolarPoint,
} from "@aerodb/engine-client";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { frameTrackForPoint } from "../src/ingest";

const here = dirname(fileURLToPath(import.meta.url));
const contractFixture = (): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(here, "fixtures/frame-track-contract.json"), "utf8"));

describe("frame-track contract pin (fixture JSON)", () => {
  it("accepts the exact pinned contract shape", () => {
    const parsed = parseFrameTrack(contractFixture());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.periods_retained).toBe(6);
    expect(parsed.value.stationary).toBe(true);
    expect(parsed.value.stats.cl.mean).toBeCloseTo(1.1142, 6);
    expect(parsed.value.fields).toEqual(["vorticity", "velocity_magnitude"]);
    expect(parsed.value.image_pattern).toBe("frames/{field}/f{i04}.png");
  });

  it("rejects an ADDED top-level key (engine grew the payload silently)", () => {
    const drifted = { ...contractFixture(), shedding_freq_hz: 7.3 };
    const parsed = parseFrameTrack(drifted);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain('unexpected key "shedding_freq_hz"');
  });

  it("rejects a REMOVED top-level key (missing stationary verdict)", () => {
    const drifted = contractFixture();
    delete drifted.stationary;
    const parsed = parseFrameTrack(drifted);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain('missing key "stationary"');
  });

  it("rejects a RENAMED key (periods_retained → periodsRetained)", () => {
    const drifted = contractFixture();
    drifted.periodsRetained = drifted.periods_retained;
    delete drifted.periods_retained;
    const parsed = parseFrameTrack(drifted);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain('missing key "periods_retained"');
    expect(parsed.errors.join(" ")).toContain('unexpected key "periodsRetained"');
  });

  it("rejects a RETYPED key (stationary as string)", () => {
    const drifted = { ...contractFixture(), stationary: "true" };
    const parsed = parseFrameTrack(drifted);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("frame_track.stationary: expected boolean");
  });

  it("rejects drift inside nested window / stats / frames objects", () => {
    const windowDrift = contractFixture();
    (windowDrift.window as Record<string, unknown>).duration = 0.8;
    expect(parseFrameTrack(windowDrift).ok).toBe(false);

    const statsDrift = contractFixture();
    delete (statsDrift.stats as Record<string, unknown>).cm;
    expect(parseFrameTrack(statsDrift).ok).toBe(false);

    const frameDrift = contractFixture();
    (frameDrift.frames as Record<string, unknown>[])[0].strouhal = 0.21;
    expect(parseFrameTrack(frameDrift).ok).toBe(false);

    const frameMissing = contractFixture();
    delete (frameMissing.frames as Record<string, unknown>[])[0].cm;
    expect(parseFrameTrack(frameMissing).ok).toBe(false);
  });

  it("rejects a frames array beyond the pinned <=120 cap", () => {
    const drifted = contractFixture();
    const frame = (drifted.frames as Record<string, unknown>[])[0];
    drifted.frames = Array.from({ length: FRAME_TRACK_MAX_FRAMES + 1 }, (_, i) => ({ ...frame, i, t: 10 + i * 0.005 }));
    const parsed = parseFrameTrack(drifted);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("exceeds contract cap of 120");
  });

  it("rejects non-object payloads (arrays, strings, null)", () => {
    expect(parseFrameTrack([contractFixture()]).ok).toBe(false);
    expect(parseFrameTrack("frame_track").ok).toBe(false);
    expect(parseFrameTrack(null).ok).toBe(false);
  });

  it("pins the frame image artifact kind and image_pattern rendering", () => {
    expect(FRAME_IMAGE_ARTIFACT_KIND).toBe("frame_image");
    expect(frameImageRelativePath("frames/{field}/f{i04}.png", "vorticity", 7)).toBe("frames/vorticity/f0007.png");
    expect(frameImageRelativePath("frames/{field}/f{i04}.png", "velocity_magnitude", 119)).toBe(
      "frames/velocity_magnitude/f0119.png",
    );
  });

  it("pins the PRODUCTION multi-AoA image_pattern (a{i}/ case namespace)", () => {
    // Multi-AoA polar jobs namespace each case under a{i}/ (engine pipeline
    // image_subdir), so the production payload ships a prefixed pattern —
    // the parser and renderer must accept it, not only the bare literal.
    const prefixed = { ...contractFixture(), image_pattern: "a2/frames/{field}/f{i04}.png" };
    const parsed = parseFrameTrack(prefixed);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.image_pattern).toBe("a2/frames/{field}/f{i04}.png");
    expect(frameImageRelativePath("a2/frames/{field}/f{i04}.png", "vorticity", 7)).toBe("a2/frames/vorticity/f0007.png");
  });
});

describe("ingest frame_track persistence (frameTrackForPoint)", () => {
  const basePoint = { aoa_deg: 16, unsteady: true, converged: true, first_order_fallback: false, images: {} } as PolarPoint;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists NULL for steady/no-shedding points (unsteady=false, frame_track null/absent)", () => {
    const steady = { ...basePoint, unsteady: false } as PolarPoint;
    expect(frameTrackForPoint({ ...steady, frame_track: null }, "test")).toBeNull();
    expect(frameTrackForPoint(steady, "test")).toBeNull();
  });

  it("persists a FAIL-CLOSED sentinel for a SHEDDING point missing frame_track (never null)", () => {
    // F3 regression: a shedding URANS point without frame_track has zero
    // stationarity evidence. Persisting null would masquerade as legacy
    // pre-contract evidence and skip the classifier gate entirely.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const point of [{ ...basePoint, frame_track: null }, basePoint]) {
      const persisted = frameTrackForPoint(point, "job j1, case c1, aoa 16") as Record<string, unknown>;
      expect(persisted).toMatchObject({ missing: true, stationary: false });
      expect(persisted.periods_retained).toBeNull();
      // The sentinel must FAIL the classifier gate reads: stationary !== true
      // and periods_retained is not a finite number >= 5.
      expect(persisted.stationary).not.toBe(true);
      expect(typeof persisted.periods_retained).not.toBe("number");
    }
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(String(errorSpy.mock.calls[0][0])).toContain("frame_track MISSING");
  });

  it("persists a contract-valid frame_track verbatim without warnings", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = contractFixture();
    const persisted = frameTrackForPoint({ ...basePoint, frame_track: fixture as never }, "test");
    expect(persisted).toBe(fixture);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("persists a DRIFTED frame_track verbatim but logs the contract drift loudly", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const drifted = { ...contractFixture(), stationary: "yes" };
    const persisted = frameTrackForPoint({ ...basePoint, frame_track: drifted as never }, "job j1, case c1, aoa 16");
    // Evidence is preserved verbatim — the classifier gate fails closed on it.
    expect(persisted).toBe(drifted);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("frame_track CONTRACT DRIFT");
  });
});
