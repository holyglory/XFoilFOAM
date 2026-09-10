import type { Point } from "./types";

export const FAST_WALL_SPACING_POLICY = "curvature-guarded-wall-v1";
export const WALL_FUNCTION_CONCAVITY_LIMIT = 2.5;

export function airfoilConcaveCurvature(
  input: readonly Point[],
): number | null {
  if (
    !Array.isArray(input) ||
    input.length < 5 ||
    input.length > 4096 ||
    input.some(
      (point) =>
        !point || !Number.isFinite(point.x) || !Number.isFinite(point.y),
    )
  )
    return null;
  const leading = input.reduce((minimum, point) =>
    point.x < minimum.x ? point : minimum,
  );
  const trailing = {
    x: (input[0].x + input.at(-1)!.x) / 2,
    y: (input[0].y + input.at(-1)!.y) / 2,
  };
  const angle = -Math.atan2(trailing.y - leading.y, trailing.x - leading.x);
  const cosine = Math.cos(angle),
    sine = Math.sin(angle);
  const chord =
    (trailing.x - leading.x) * cosine - (trailing.y - leading.y) * sine;
  if (!(chord > 0) || !Number.isFinite(chord)) return null;
  const normalized = input.map((point) => ({
    x: ((point.x - leading.x) * cosine - (point.y - leading.y) * sine) / chord,
    y: ((point.x - leading.x) * sine + (point.y - leading.y) * cosine) / chord,
  }));
  normalized[0] = { x: 1, y: 0 };
  normalized[normalized.length - 1] = { x: 1, y: 0 };
  const leadingIndex = normalized.reduce(
    (minimum, point, index) =>
      point.x < normalized[minimum].x ? index : minimum,
    0,
  );
  normalized[leadingIndex] = { x: 0, y: 0 };
  const extent =
    Math.max(...normalized.map((point) => point.x)) -
    Math.min(...normalized.map((point) => point.x));
  if (!(extent > 0) || !Number.isFinite(extent)) return null;
  const points: Point[] = [];
  for (const point of normalized) {
    const scaled = { x: point.x / extent, y: point.y / extent };
    const previous = points.at(-1);
    if (
      !previous ||
      Math.hypot(scaled.x - previous.x, scaled.y - previous.y) > 1e-10
    )
      points.push(scaled);
  }
  if (
    points.length > 1 &&
    Math.hypot(
      points[0].x - points.at(-1)!.x,
      points[0].y - points.at(-1)!.y,
    ) <= 1e-10
  )
    points.pop();
  if (points.length < 5) return null;
  let area = 0;
  const cumulative = [0];
  for (const [index, point] of points.entries()) {
    const next = points[(index + 1) % points.length];
    area += point.x * next.y - next.x * point.y;
    cumulative.push(
      cumulative.at(-1)! + Math.hypot(next.x - point.x, next.y - point.y),
    );
  }
  const total = cumulative.at(-1)!;
  if (Math.abs(area / 2) <= 1e-12 || !(total > 0) || !Number.isFinite(total))
    return null;
  const window = Math.min(0.025, 0.2 * total);
  const pointAt = (distance: number): Point => {
    const wrapped = ((distance % total) + total) % total;
    let lower = 0,
      upper = points.length;
    while (lower + 1 < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (cumulative[middle] <= wrapped) lower = middle;
      else upper = middle;
    }
    const length = cumulative[lower + 1] - cumulative[lower];
    if (length <= 1e-12) return points[lower];
    const fraction = (wrapped - cumulative[lower]) / length;
    const next = points[(lower + 1) % points.length];
    return {
      x: (1 - fraction) * points[lower].x + fraction * next.x,
      y: (1 - fraction) * points[lower].y + fraction * next.y,
    };
  };
  const concaveSign = area > 0 ? -1 : 1;
  let maximum = 0;
  for (const [index, point] of points.entries()) {
    const previous = pointAt(cumulative[index] - window),
      next = pointAt(cumulative[index] + window);
    const incoming = { x: point.x - previous.x, y: point.y - previous.y };
    const outgoing = { x: next.x - point.x, y: next.y - point.y };
    if (
      Math.hypot(incoming.x, incoming.y) <= 1e-12 ||
      Math.hypot(outgoing.x, outgoing.y) <= 1e-12
    )
      continue;
    const curvature =
      Math.atan2(
        incoming.x * outgoing.y - incoming.y * outgoing.x,
        incoming.x * outgoing.x + incoming.y * outgoing.y,
      ) / window;
    if (curvature * concaveSign > 0)
      maximum = Math.max(maximum, Math.abs(curvature));
  }
  return Number.isFinite(maximum) ? maximum : null;
}

export function fastWallSpacing(
  requested: number,
  maximumConcaveCurvature: number | null,
) {
  if (!Number.isFinite(requested) || requested <= 0)
    throw new RangeError("Requested wall spacing must be positive and finite");
  const measured =
    maximumConcaveCurvature !== null &&
    Number.isFinite(maximumConcaveCurvature) &&
    maximumConcaveCurvature >= 0;
  return {
    policy: FAST_WALL_SPACING_POLICY,
    maximumConcaveCurvature: measured ? maximumConcaveCurvature : null,
    concavityLimit: WALL_FUNCTION_CONCAVITY_LIMIT,
    targetYPlus:
      measured && maximumConcaveCurvature <= WALL_FUNCTION_CONCAVITY_LIMIT
        ? 40
        : requested,
    selection:
      measured && maximumConcaveCurvature <= WALL_FUNCTION_CONCAVITY_LIMIT
        ? "wall_function"
        : "requested",
  };
}
