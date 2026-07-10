import { describe, expect, it } from "vitest";

import { oscillatingSnapshotCaption, type SteadyWindowSummary } from "../lib/steady-history";

const summary: SteadyWindowSummary = {
  clMean: 1.6,
  cdMean: 0.28,
  cmMean: -0.3,
  clHalfAmplitude: 0.089,
  cdHalfAmplitude: 0.02,
  cmHalfAmplitude: 0.01,
  sampleCount: 400,
  iterCount: 399,
};

describe("oscillating-steady snapshot caption (S1223 α20 misread, 2026-07-10)", () => {
  // MUST-CATCH: an oscillating steady static image carries the time-accuracy
  // disclosure — the exact gap that made frozen shed vortices read as a mesh
  // defect.
  it("captions a static image from an oscillating steady solve", () => {
    const caption = oscillatingSnapshotCaption(summary, false);
    expect(caption).toMatch(/single solver snapshot/);
    expect(caption).toMatch(/not time-accurate/);
  });

  // FALSE-POSITIVE GUARDS: never caption real URANS frames, never caption a
  // cleanly converged steady solve (no oscillation summary).
  it("stays silent for URANS frame playback and for non-oscillating solves", () => {
    expect(oscillatingSnapshotCaption(summary, true)).toBeNull();
    expect(oscillatingSnapshotCaption(null, false)).toBeNull();
    expect(oscillatingSnapshotCaption(undefined, false)).toBeNull();
  });
});
