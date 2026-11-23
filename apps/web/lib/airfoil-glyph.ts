import { makePath, type Point } from "@aerodb/core";

export function airfoilGlyphPath(
  points: Point[] | null | undefined,
  width = 40,
  height = 18,
) {
  return !points || points.length < 3
    ? null
    : makePath(points, 5, Math.round(height * 0.56), width - 10, true);
}
