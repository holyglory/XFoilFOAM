import type { Point } from "@aerodb/core";

import { airfoilGlyphPath } from "@/lib/airfoil-glyph";
import { C } from "@/lib/tokens";

/** A tiny airfoil silhouette glyph rendered from a contour. Themed teal line art. */
export function AirfoilGlyph({
  points,
  outline,
  width = 40,
  height = 18,
}:
  | { points: Point[]; outline?: never; width?: number; height?: number }
  | { outline: string | null; points?: never; width?: never; height?: never }) {
  const d = points ? airfoilGlyphPath(points, width, height) : outline;
  if (!d) {
    return (
      <span style={{ width, height, flex: "none", display: "inline-block" }} />
    );
  }
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ flex: "none", display: "block" }}
      aria-hidden="true"
    >
      <path
        d={d}
        fill="rgba(45,212,191,0.12)"
        style={{ stroke: C.teal }}
        strokeWidth={1}
        strokeLinejoin="round"
      />
    </svg>
  );
}
