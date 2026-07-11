import { describe, expect, it } from "vitest";

import { projectChart, readoutAtX } from "../src/chart";
import type { PolarPointData, ProjectChartInput } from "../src";

function points(prefix: string, clOffset: number): PolarPointData[] {
  return [-1, 1].map((a) => ({
    a,
    cl: clOffset + a * 0.1,
    cd: 0.012 + Math.abs(a) * 0.001,
    cm: -0.02,
    ld: (clOffset + a * 0.1) / (0.012 + Math.abs(a) * 0.001),
    stalled: false,
    source: "solved",
    resultId: `${prefix}-${a}`,
    classificationState: "accepted",
  }));
}

const polars: ProjectChartInput["polars"] = [
  {
    seriesId: "physics-a",
    label: "Re 171k · condition 1",
    re: 171000,
    color: "#34d399",
    points: points("a", 0.2),
  },
  {
    seriesId: "physics-b",
    label: "Re 171k · condition 2",
    re: 171000,
    color: "#60a5fa",
    points: points("b", 0.5),
  },
];

describe("public polar series identity", () => {
  it("keeps same-Re series independently visible with stable point identities", () => {
    const both = projectChart({
      chartType: "cla",
      polars,
      visibleSeries: { "physics-a": true, "physics-b": true },
    });
    expect(new Set(both.points.map((point) => point.seriesId))).toEqual(
      new Set(["physics-a", "physics-b"]),
    );
    expect(new Set(both.points.map((point) => point.key)).size).toBe(
      both.points.length,
    );

    const onlyB = projectChart({
      chartType: "cla",
      polars,
      visibleSeries: { "physics-a": false, "physics-b": true },
    });
    expect(new Set(onlyB.points.map((point) => point.seriesId))).toEqual(
      new Set(["physics-b"]),
    );
    expect(new Set(onlyB.curves.map((curve) => curve.seriesId))).toEqual(
      new Set(["physics-b"]),
    );
  });

  it("keeps same-Re readouts separate and uses public labels only", () => {
    const rows = readoutAtX({
      chartType: "cla",
      polars,
      visibleSeries: { "physics-a": true, "physics-b": true },
      x: 0,
    });
    expect(
      rows.filter((row) => row.kind === "measured").map((row) => row.seriesId),
    ).toEqual(["physics-a", "physics-b"]);
    expect(rows.map((row) => row.label)).toEqual([
      "Re 171k · condition 1",
      "Re 171k · condition 2",
    ]);
    expect(rows.map((row) => row.label).join(" ")).not.toMatch(
      /setup|preset|revision|remote-validation|batch/i,
    );
  });

  it("keeps alternate/conflict result IDs reachable without putting them in measured curves", () => {
    const point = (
      resultId: string,
      a: number,
      cl: number,
      evidenceRole: PolarPointData["evidenceRole"],
    ): PolarPointData => ({
      a,
      cl,
      cd: 0.012 + Math.abs(a) * 0.001,
      cm: -0.02,
      ld: cl / (0.012 + Math.abs(a) * 0.001),
      stalled: false,
      source: "solved",
      resultId,
      classificationState: "accepted",
      evidenceRole,
    });
    const primaryMinusTwo = point("primary--2", -2, 0.2, "primary");
    const evidence = [
      point("primary--4", -4, 0, "primary"),
      primaryMinusTwo,
      {
        ...primaryMinusTwo,
        resultId: "alternate--2",
        evidenceRole: "alternate" as const,
      },
      point("conflict-a", 0, 0.35, "conflict"),
      point("conflict-b", 0, 0.55, "conflict"),
      point("primary-2", 2, 0.7, "primary"),
      point("primary-4", 4, 0.9, "primary"),
    ];
    const inputPolars: ProjectChartInput["polars"] = [
      {
        seriesId: "merged",
        label: "Re 171k",
        re: 171000,
        color: "#34d399",
        points: evidence,
        fit: {
          status: "final",
          confidence: 1,
          metrics: null,
          points: [-4, -2, 0, 2, 4].map((a) => ({
            a,
            cl: 0.1 * a + 0.4,
            cd: 0.013,
            cm: -0.02,
            ld: (0.1 * a + 0.4) / 0.013,
          })),
          acceptedPointCount: 4,
          provisionalPointCount: 0,
          rejectedPointCount: 0,
        },
      },
    ];
    const projection = projectChart({
      chartType: "cla",
      polars: inputPolars,
      visibleSeries: { merged: true },
    });

    expect(
      projection.curves.filter((curve) => curve.kind === "measured"),
    ).toHaveLength(2);
    expect(
      projection.curves.filter((curve) => curve.kind === "fit"),
    ).toHaveLength(2);
    const stacked = projection.points.find(
      (vm) => vm.resultChoices?.length === 2,
    );
    expect(stacked?.resultChoices?.map((choice) => choice.resultId)).toEqual([
      "primary--2",
      "alternate--2",
    ]);
    const reachableIds = projection.points.flatMap((vm) =>
      (vm.resultChoices ?? [vm.point]).map((choice) => choice.resultId),
    );
    expect(new Set(reachableIds)).toEqual(
      new Set(evidence.map((item) => item.resultId)),
    );
    expect(
      projection.points.filter((vm) => vm.point.evidenceRole === "conflict"),
    ).toHaveLength(2);
    expect(
      readoutAtX({
        chartType: "cla",
        polars: inputPolars,
        visibleSeries: { merged: true },
        x: 0,
      }),
    ).toEqual([]);
  });

  it("keeps missing measured Cm unavailable without hiding its result on other charts", () => {
    const cmPoints: PolarPointData[] = [-2, 0, 2].map((a) => ({
      a,
      cl: 0.4 + 0.1 * a,
      cd: 0.013,
      cm: a === 0 ? null : -0.02 + 0.001 * a,
      ld: (0.4 + 0.1 * a) / 0.013,
      stalled: false,
      source: "solved",
      resultId: `cm-${a}`,
      evidenceRole: "primary",
    }));
    const inputPolars: ProjectChartInput["polars"] = [
      {
        seriesId: "nullable-cm",
        label: "Re 171k",
        re: 171000,
        color: "#34d399",
        points: cmPoints,
      },
    ];
    const cmProjection = projectChart({
      chartType: "cma",
      polars: inputPolars,
      visibleSeries: { "nullable-cm": true },
    });
    expect(cmProjection.points.map((vm) => vm.point.resultId)).toEqual([
      "cm--2",
      "cm-2",
    ]);
    expect(
      cmProjection.curves.filter((curve) => curve.kind === "measured"),
    ).toHaveLength(0);
    expect(cmProjection.domain.yMin).toBeLessThan(cmProjection.domain.yMax);
    expect(
      readoutAtX({
        chartType: "cma",
        polars: inputPolars,
        visibleSeries: { "nullable-cm": true },
        x: 0,
      }),
    ).toEqual([]);

    const liftProjection = projectChart({
      chartType: "cla",
      polars: inputPolars,
      visibleSeries: { "nullable-cm": true },
    });
    expect(liftProjection.points.map((vm) => vm.point.resultId)).toContain(
      "cm-0",
    );
    expect(
      liftProjection.points.find((vm) => vm.point.resultId === "cm-0")?.point
        .cm,
    ).toBeNull();
  });
});
