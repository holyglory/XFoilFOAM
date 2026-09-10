import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCoordinates } from "../src/geometry";
import { airfoilConcaveCurvature, fastWallSpacing } from "../src/wall-spacing";

const load = (slug: string) =>
  parseCoordinates(
    readFileSync(
      new URL(`../../db/seed/selig-database/${slug}.dat`, import.meta.url),
      "utf8",
    ),
  ).points;

describe("geometry-aware fast wall spacing", () => {
  it.each(["ag24", "clarky", "sd8020", "n0012"])(
    "allows normal profile %s without changing its coordinates",
    (slug) => {
      const points = load(slug),
        original = structuredClone(points);
      const curvature = airfoilConcaveCurvature(points);
      expect(curvature).not.toBeNull();
      expect(curvature!).toBeLessThan(2.5);
      expect(fastWallSpacing(1, curvature)).toMatchObject({
        targetYPlus: 40,
        selection: "wall_function",
      });
      expect(points).toEqual(original);
    },
  );
  it("preserves the requested spacing for a strongly concave real profile", () => {
    const curvature = airfoilConcaveCurvature(load("s1223"));
    expect(curvature!).toBeGreaterThan(2.5);
    expect(fastWallSpacing(1, curvature)).toMatchObject({
      targetYPlus: 1,
      selection: "requested",
    });
  });
  it.each(["ag24", "s1223"])(
    "keeps %s invariant under winding, unit changes and repeated neighbors",
    (slug) => {
      const points = load(slug);
      const expected = airfoilConcaveCurvature(points)!;
      expect(airfoilConcaveCurvature([...points].reverse())!).toBeCloseTo(
        expected,
        8,
      );
      expect(
        airfoilConcaveCurvature(
          points.map((point) => ({ x: point.x * 7 + 30, y: point.y * 7 - 4 })),
        )!,
      ).toBeCloseTo(expected, 7);
      expect(
        airfoilConcaveCurvature(
          points.flatMap((point) => [point, { ...point }]),
        )!,
      ).toBeCloseTo(expected, 7);
    },
  );
  it("never authorizes coarsening from missing or invalid geometry", () => {
    for (const points of [
      [],
      [{ x: 0, y: 0 }],
      Array.from({ length: 6 }, () => ({ x: 0, y: 0 })),
      [...load("ag24"), { x: NaN, y: 0 }],
    ])
      expect(airfoilConcaveCurvature(points)).toBeNull();
    for (const curvature of [null, NaN, Infinity, -1])
      expect(fastWallSpacing(2, curvature)).toMatchObject({
        targetYPlus: 2,
        selection: "requested",
        maximumConcaveCurvature: null,
      });
    expect(fastWallSpacing(1, 2.5).targetYPlus).toBe(40);
    expect(fastWallSpacing(1, 2.50001).targetYPlus).toBe(1);
  });
});
