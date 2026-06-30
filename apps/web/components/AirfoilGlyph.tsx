import { makePath, type Point } from "@aerodb/core";

import { C } from "@/lib/tokens";

/** A tiny airfoil silhouette glyph rendered from a contour. Themed teal line art. */
export function AirfoilGlyph({
  points,
  width = 40,
  height = 18,
}: {
  points: Point[];
  width?: number;
  height?: number;
}) {
  if (!points || points.length < 3) {
    return <span style={{ width, height, flex: "none", display: "inline-block" }} />;
  }
  const d = makePath(points, 5, Math.round(height * 0.56), width - 10, true);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ flex: "none", display: "block" }} aria-hidden="true">
      <path d={d} fill="rgba(45,212,191,0.12)" style={{ stroke: C.teal }} strokeWidth={1} strokeLinejoin="round" />
    </svg>
  );
}
