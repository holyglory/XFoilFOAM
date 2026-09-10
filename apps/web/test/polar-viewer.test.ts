import { describe, expect, it } from "vitest";
import { CHART_VIEW, projectChart } from "@aerodb/core";

import { containedBadgePosition } from "../lib/polar-badge";
import {
  nearestProjectedPoint,
  POLAR_POINT_TARGET_RADIUS,
  responsivePolarProjection,
} from "../lib/polar-chart-layout";

const original = projectChart({
  chartType: "cla",
  visibleSeries: { owned: true },
  polars: [
    {
      seriesId: "owned",
      label: "Re 171k",
      re: 171234,
      color: "#38bdf8",
      points: [-2, 0, 2].map((alpha, index) => ({
        a: alpha,
        cl: 0.5 + alpha * 0.2,
        cd: 0.02,
        cm: -0.03,
        ld: (0.5 + alpha * 0.2) / 0.02,
        stalled: false,
        source: "solved" as const,
        resultId: `fixture-${index}`,
        classificationState: "accepted" as const,
      })),
    },
  ],
});

describe("viewport-native CFD geometry", () => {
  it.each([230, 300, 684, 1188])(
    "keeps axes and evidence intact at width %s",
    (width) => {
      const { projection, view } = responsivePolarProjection(original, width);
      expect(view.w).toBe(width);
      expect(view.h).toBeGreaterThanOrEqual(240);
      expect(projection.domain).toBe(original.domain);
      expect(projection.curves.map((curve) => curve.key)).toEqual(
        original.curves.map((curve) => curve.key),
      );
      for (const [index, point] of projection.points.entries()) {
        expect(point.point).toBe(original.points[index].point);
        expect((point.cx - view.PX0) / (view.PX1 - view.PX0)).toBeCloseTo(
          (original.points[index].cx - CHART_VIEW.PX0) /
            (CHART_VIEW.PX1 - CHART_VIEW.PX0),
          10,
        );
        expect((point.cy - view.PY0) / (view.PY1 - view.PY0)).toBeCloseTo(
          (original.points[index].cy - CHART_VIEW.PY0) /
            (CHART_VIEW.PY1 - CHART_VIEW.PY0),
          10,
        );
        expect(point.cx - POLAR_POINT_TARGET_RADIUS).toBeGreaterThanOrEqual(0);
        expect(point.cx + POLAR_POINT_TARGET_RADIUS).toBeLessThanOrEqual(width);
      }
      for (const tick of projection.yTicks)
        expect(view.PX0 - 8 - tick.label.length * 6).toBeGreaterThanOrEqual(8);
      for (const tick of projection.xTicks) {
        expect(tick.pos - tick.label.length * 3).toBeGreaterThanOrEqual(0);
        expect(tick.pos + tick.label.length * 3).toBeLessThanOrEqual(width);
      }
      expect(POLAR_POINT_TARGET_RADIUS * 2).toBeGreaterThanOrEqual(44);
    },
  );

  it("resolves overlapping touch targets by the actual nearest point", () => {
    const points = [
      { ...original.points[0], cx: 50, cy: 50 },
      { ...original.points[1], cx: 60, cy: 50 },
    ];
    expect(nearestProjectedPoint(points, 52, 50)).toBe(points[0]);
    expect(nearestProjectedPoint(points, 59, 50)).toBe(points[1]);
    expect(nearestProjectedPoint(points, 55, 50)).toBe(points[0]);
    expect(nearestProjectedPoint([], 50, 50)).toBeUndefined();
  });

  it.each([0, -1, NaN, Infinity])(
    "rejects invalid layout width %s",
    (width) => {
      expect(() => responsivePolarProjection(original, width)).toThrow("width");
    },
  );
});

describe("polar floating badge containment", () => {
  it("flips left and clamps inside a narrow chart when the cursor is at the right edge", () => {
    expect(
      containedBadgePosition({
        anchorX: 460,
        anchorY: 130,
        badgeWidth: 238,
        badgeHeight: 180,
        containerWidth: 478,
        containerHeight: 260,
      }),
    ).toEqual({ left: 210, top: 40 });
  });

  it("clamps oversized badge geometry to the inset rather than allowing negative coordinates", () => {
    expect(
      containedBadgePosition({
        anchorX: 6,
        anchorY: 4,
        badgeWidth: 520,
        badgeHeight: 300,
        containerWidth: 478,
        containerHeight: 260,
      }),
    ).toEqual({ left: 8, top: 8 });
  });
});
