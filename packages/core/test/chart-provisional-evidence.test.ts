import { describe, expect, it } from "vitest";

import { measuredAlphas, measuredEvidenceSegments, projectChart } from "../src/chart";
import type { PolarPointData } from "../src/types";

function point(
  a: number,
  cl: number,
  classificationState: PolarPointData["classificationState"],
): PolarPointData {
  return {
    a,
    cl,
    cd: 0.012,
    cm: -0.02,
    ld: cl / 0.012,
    stalled: false,
    source: "solved",
    resultId: `result-${a}`,
    classificationState,
  };
}

describe("provisional polar evidence", () => {
  it("must-catch: keeps low-angle provisional evidence clickable but out of the solid curve", () => {
    // A18 regression shape: the two suspicious negative-angle RANS rows are
    // retained as needs_urans, while the accepted branch begins at −2°.
    const points = [
      point(-5, 0.256, "needs_urans"),
      point(-4, 0.241, "needs_urans"),
      point(-2, -0.394, "accepted"),
      point(-1, -0.2, "accepted"),
      point(0, 0, "accepted"),
      point(1, 0.2, "accepted"),
    ];

    expect(measuredEvidenceSegments(points).map((segment) => segment.map((p) => p.a))).toEqual([
      [-2, -1, 0, 1],
    ]);
    expect(measuredAlphas(points)).toEqual([-2, -1, 0, 1]);

    const projection = projectChart({
      chartType: "cla",
      polars: [
        {
          seriesId: "a18-re102",
          label: "Re 102k",
          re: 102_000,
          color: "#38bdf8",
          points,
        },
      ],
      visibleSeries: { "a18-re102": true },
    });

    // The provisional rows remain on the plot and preserve their explicit
    // amber affordance, but no measured polyline can include them.
    expect(projection.points.map((vm) => vm.point.a)).toEqual([-5, -4, -2, -1, 0, 1]);
    expect(projection.points.filter((vm) => vm.point.classificationState === "needs_urans").map((vm) => vm.stroke)).toEqual([
      "#f59e0b",
      "#f59e0b",
    ]);
    expect(projection.curves.filter((curve) => curve.kind === "measured")).toHaveLength(1);
  });

  it("keeps a healthy accepted negative-to-positive branch continuous", () => {
    const points = [-5, -4, -3, -2, -1, 0, 1].map((a) =>
      point(a, a * 0.1, "accepted"),
    );

    expect(measuredEvidenceSegments(points).map((segment) => segment.map((p) => p.a))).toEqual([
      [-5, -4, -3, -2, -1, 0, 1],
    ]);
  });

  it("does not promote an unclassified stored result into a public curve", () => {
    const points = [
      point(-1, -0.1, "accepted"),
      point(0, 0, undefined),
      point(1, 0.1, "accepted"),
    ];

    expect(measuredEvidenceSegments(points)).toEqual([
      [points[0]],
      [points[2]],
    ]);
  });
});
