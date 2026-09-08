import { describe, expect, it } from "vitest";
import {
  progressiveCurveMetrics,
  type ProgressivePolarSeries,
} from "@aerodb/core";
import {
  progressiveComparisonConditions,
  progressiveComparisonCurve,
  type ProgressiveComparisonProfile,
} from "../lib/progressive-comparison";

function series(
  key: string,
  method: "neuralfoil" | "composite" = "neuralfoil",
): ProgressivePolarSeries {
  const samples = [
    { alpha: -1, cl: -0.1, cd: 0.02, cm: -0.02 },
    { alpha: 1, cl: 0.2, cd: 0.01, cm: -0.02 },
  ];
  return {
    targetId: `target-${key}`,
    conditionKey: key,
    modelId: `model-${key}`,
    kind: method === "neuralfoil" ? "prediction" : "estimate",
    re: 200000,
    mach: 0.2,
    branch: "increasing",
    updatedAt: "2026-09-07T00:00:00Z",
    curves: [{ method, samples, metrics: progressiveCurveMetrics(samples) }],
    explanation: {
      calibration: "unvalidated",
      modelVersions: { fixture: "test" },
      geometryRms: 0,
      geometryMaximumError: 0,
    },
  };
}

const profile = (
  slug: string,
  curves: ProgressivePolarSeries[],
): ProgressiveComparisonProfile => ({
  slug,
  name: slug,
  color: "#ffffff",
  series: curves,
});

describe("progressive comparison read model", () => {
  it("matches exact conditions and prefers shared availability without matching rounded labels", () => {
    const profiles = [
      profile("first", [series("same"), series("different")]),
      profile("second", [series("same")]),
    ];
    expect(
      progressiveComparisonConditions(profiles).map((condition) => [
        condition.key,
        condition.availableProfiles,
      ]),
    ).toEqual([
      ["same", 2],
      ["different", 1],
    ]);
    expect(progressiveComparisonCurve(profiles[1], "different")).toBeNull();
  });

  it("uses the cached composite and its own metrics instead of lower-method values", () => {
    const cached = series("same", "composite");
    cached.curves.unshift(series("same").curves[0]);
    const selected = progressiveComparisonCurve(
      profile("first", [cached]),
      "same",
    )!;
    expect(selected.curve.method).toBe("composite");
    expect(selected.curve.metrics).toBe(cached.curves[1].metrics);
    expect(selected.series.modelId).toBe(cached.modelId);
  });

  it("does not silently choose between competing geometry targets for one profile", () => {
    const original = series("same");
    const changed = { ...series("same"), targetId: "another-geometry" };
    expect(
      progressiveComparisonCurve(profile("first", [original, changed]), "same"),
    ).toBeNull();
    expect(
      progressiveComparisonConditions([
        profile("first", [original, changed]),
      ])[0].availableProfiles,
    ).toBe(1);
  });

  it.each(["cd", "cl", "cm", "alpha"] as const)(
    "does not draw a curve with nonfinite %s",
    (coefficient) => {
      const cached = series("same");
      cached.curves[0].samples[0][coefficient] = NaN;
      expect(
        progressiveComparisonCurve(profile("first", [cached]), "same"),
      ).toBeNull();
    },
  );

  it("does not bridge invalid drag or a reversed angle list", () => {
    const cached = series("same");
    cached.curves[0].samples.reverse();
    expect(
      progressiveComparisonCurve(profile("first", [cached]), "same"),
    ).toBeNull();
    cached.curves[0].samples.reverse();
    cached.curves[0].samples[0].cd = 0;
    expect(
      progressiveComparisonCurve(profile("first", [cached]), "same"),
    ).toBeNull();
  });
});
