import type { ProgressivePolarSeries } from "@aerodb/core";
import { describe, expect, it } from "vitest";
import { progressiveRefinementProof } from "../src/progressive-refinement-proof";

function fixture(contributingIds: string[], changed = true) {
  const series: Pick<ProgressivePolarSeries, "curves" | "explanation"> = {
    curves: ["neuralfoil", "composite"].map((method) => ({
      method: method as "neuralfoil" | "composite",
      metrics: null,
      samples: [-2, 4].map((alpha) => ({
        alpha,
        cl: alpha * 0.1 + (method === "composite" && changed ? 0.2 : 0),
        cd: 0.02,
        cm: -0.01,
      })),
    })),
    explanation: {
      calibration: "unvalidated",
      modelVersions: {},
      geometryRms: 0,
      geometryMaximumError: 0,
      contributors: contributingIds.map((attemptId) => ({
        attemptId,
        observationId: `attempt-${attemptId}`,
        resultId: `result-${attemptId}`,
        method: "openfoam_fast",
        window: null,
        numericalConvergence: "unconverged",
        statisticalCertification: "informative_uncertified",
      })),
    },
  };
  return series;
}

const angles = new Map([
  ["first", -2],
  ["second", 4],
  ["repeat", -2],
]);

describe("real progressive refinement proof", () => {
  it("requires included contributors, not retained excluded model associations", () => {
    const series = fixture([]);
    series.explanation.exclusions = [
      { observationId: "attempt-first", reason: "failure_material_domain" },
      {
        observationId: "attempt-second",
        reason: "insufficient_informative_evidence",
      },
    ];
    expect(progressiveRefinementProof(series, angles)).toMatchObject({
      refined: false,
      distinctCfdAngles: 0,
    });
  });

  it("accepts real changes from two informative nonconverged angles", () => {
    expect(
      progressiveRefinementProof(fixture(["first", "second"]), angles),
    ).toMatchObject({ refined: true, distinctCfdAngles: 2 });
  });

  it.each([["first"], ["first", "repeat"], ["first", "missing"]])(
    "refuses sparse, repeated or unknown evidence %j",
    (...attemptIds) => {
      expect(
        progressiveRefinementProof(fixture(attemptIds), angles).refined,
      ).toBe(false);
    },
  );

  it("refuses an unchanged prior even with two stored contributors", () => {
    expect(
      progressiveRefinementProof(fixture(["first", "second"], false), angles)
        .refined,
    ).toBe(false);
  });

  it("refuses a contradictory excluded contributor", () => {
    const series = fixture(["first", "second"]);
    series.explanation.exclusions = [
      { observationId: "attempt-second", reason: "divergent" },
    ];
    expect(progressiveRefinementProof(series, angles).refined).toBe(false);
  });

  it("refuses nonfinite or mismatched curve samples", () => {
    const series = fixture(["first", "second"]);
    series.curves[1].samples[0].cl = NaN;
    expect(progressiveRefinementProof(series, angles).refined).toBe(false);
    series.curves[1].samples[0].cl = 0.2;
    series.curves[1].samples[0].alpha = 99;
    expect(progressiveRefinementProof(series, angles).refined).toBe(false);
  });
});
