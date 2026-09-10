import {
  CHART_VIEW,
  type ChartPointVM,
  type ChartProjection,
  type ChartTick,
} from "@aerodb/core";

export type PolarChartView = Record<keyof typeof CHART_VIEW, number>;
export const POLAR_POINT_TARGET_RADIUS = 22;

function spacedTicks(ticks: ChartTick[], maximum: number): ChartTick[] {
  if (ticks.length <= maximum) return ticks;
  const stride = Math.ceil((ticks.length - 1) / (Math.max(2, maximum) - 1));
  return ticks.filter(
    (_, index) => index % stride === 0 || index === ticks.length - 1,
  );
}

export function responsivePolarProjection(
  projection: ChartProjection,
  width: number,
) {
  if (!Number.isFinite(width) || width <= 0)
    throw new RangeError("Chart width must be positive and finite");
  const height = Math.max(
    240,
    Math.round((width * CHART_VIEW.h) / CHART_VIEW.w),
  );
  const view: PolarChartView = {
    w: width,
    h: height,
    PX0: Math.max(
      58,
      ...projection.yTicks.map((tick) => tick.label.length * 6 + 16),
    ),
    PX1:
      width -
      Math.max(
        24,
        ...projection.xTicks.map((tick) => tick.label.length * 3 + 8),
      ),
    PY0: 28,
    PY1: height - 48,
  };
  const horizontal = (value: number) =>
    view.PX0 +
    ((value - CHART_VIEW.PX0) / (CHART_VIEW.PX1 - CHART_VIEW.PX0)) *
      (view.PX1 - view.PX0);
  const vertical = (value: number) =>
    view.PY0 +
    ((value - CHART_VIEW.PY0) / (CHART_VIEW.PY1 - CHART_VIEW.PY0)) *
      (view.PY1 - view.PY0);
  const labelWidth = Math.max(
    42,
    ...projection.xTicks.map((tick) => tick.label.length * 6 + 14),
  );
  const projected: ChartProjection = {
    ...projection,
    points: projection.points.map((point) => ({
      ...point,
      cx: horizontal(point.cx),
      cy: vertical(point.cy),
    })),
    curves: projection.curves.map((curve) => ({
      ...curve,
      points: curve.points
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((pair) => {
          const coordinates = pair.split(",").map(Number);
          if (coordinates.length !== 2 || !coordinates.every(Number.isFinite))
            throw new Error("Invalid projected curve coordinates");
          return `${horizontal(coordinates[0]).toFixed(3)},${vertical(coordinates[1]).toFixed(3)}`;
        })
        .join(" "),
    })),
    xTicks: spacedTicks(
      projection.xTicks,
      Math.max(2, Math.floor((view.PX1 - view.PX0) / labelWidth)),
    ).map((tick) => ({
      ...tick,
      pos: horizontal(tick.pos),
      labelPos: horizontal(tick.pos),
    })),
    yTicks: spacedTicks(
      projection.yTicks,
      Math.max(2, Math.floor((view.PY1 - view.PY0) / 22)),
    ).map((tick) => ({
      ...tick,
      pos: vertical(tick.pos),
      labelPos: vertical(tick.pos) + 3,
    })),
  };
  return { projection: projected, view };
}

export function nearestProjectedPoint(
  points: ChartPointVM[],
  horizontal: number,
  vertical: number,
) {
  return points.reduce<ChartPointVM | undefined>(
    (nearest, point) =>
      !nearest ||
      Math.hypot(point.cx - horizontal, point.cy - vertical) <
        Math.hypot(nearest.cx - horizontal, nearest.cy - vertical)
        ? point
        : nearest,
    undefined,
  );
}
