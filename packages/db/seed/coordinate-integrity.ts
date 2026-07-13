import type { Point } from "@aerodb/core";

// cap21c.dat contains the largest legitimate x-order excursion in the bundled
// UIUC corpus (0.0011 chord). Keep a small margin above that source precision
// while rejecting a material reversal of either surface traversal.
const MAX_WRONG_WAY_STEP_FRACTION = 0.002;
const LEADING_EDGE_TOLERANCE_FRACTION = 1e-6;
const ISOLATED_ENDPOINT_OUTLIER_SCALE = 4;
const SOURCE_NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const SOURCE_PAIR = new RegExp(
  `^(${SOURCE_NUMBER})\\s*(?:,|\\s)\\s*(${SOURCE_NUMBER})$`,
);

const NON_AIRFOIL_SOURCE_COMPONENTS = new Map<string, string>([
  [
    "naca1.dat",
    "authoritative one-sided cowl curve; no closed exterior airfoil surface is present",
  ],
  [
    "ua79sfm.dat",
    "authoritative isolated multi-element component; the complete closed airfoil system is not present",
  ],
]);

export interface SeedSourceDisposition {
  catalogEligible: boolean;
  reason: string | null;
}

/**
 * Classify source semantics independently from numeric integrity. A source can
 * be byte-valid yet still not describe the closed exterior surface required by
 * the 2-D airfoil solver. Exact source names are pinned because inventing a
 * missing surface from heuristics would violate evidence provenance.
 */
export function seedSourceDisposition(fileName: string): SeedSourceDisposition {
  const reason =
    NON_AIRFOIL_SOURCE_COMPONENTS.get(fileName.toLowerCase()) ?? null;
  return { catalogEligible: reason == null, reason };
}

/**
 * Require one TE→LE→TE-style traversal without requiring coincident trailing
 * edge endpoints. That distinction preserves blunt trailing edges and the
 * authoritative open UIUC component/cowl records while catching duplicated
 * wraps such as LE→TE→LE spliced into the middle of an otherwise valid file.
 */
export function assertSingleContourProgression(
  points: readonly Point[],
  label = "coordinate set",
): void {
  if (points.length < 3) {
    throw new Error(`${label}: expected at least 3 coordinate points`);
  }
  if (
    points.some(
      (point) => !Number.isFinite(point.x) || !Number.isFinite(point.y),
    )
  ) {
    throw new Error(`${label}: coordinates must be finite`);
  }

  const xs = points.map((point) => point.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const chord = maxX - minX;
  if (!(chord > 0) || !Number.isFinite(chord)) {
    throw new Error(`${label}: coordinate chord must be finite and positive`);
  }

  const leadingEdgeTolerance = Math.max(
    1e-12,
    chord * LEADING_EDGE_TOLERANCE_FRACTION,
  );
  const leadingEdgeIndices = xs.flatMap((x, index) =>
    x - minX <= leadingEdgeTolerance ? [index] : [],
  );

  let leadingEdgeRuns = 0;
  for (let index = 0; index < leadingEdgeIndices.length; index += 1) {
    if (
      index === 0 ||
      leadingEdgeIndices[index] !== leadingEdgeIndices[index - 1] + 1
    ) {
      leadingEdgeRuns += 1;
    }
  }
  if (leadingEdgeRuns !== 1) {
    throw new Error(
      `${label}: contour visits the leading edge in ${leadingEdgeRuns} separate runs`,
    );
  }

  const firstLeadingEdge = leadingEdgeIndices[0];
  const lastLeadingEdge = leadingEdgeIndices[leadingEdgeIndices.length - 1];
  const wrongWayTolerance = chord * MAX_WRONG_WAY_STEP_FRACTION;

  for (let index = 0; index < firstLeadingEdge; index += 1) {
    const wrongWayStep = xs[index + 1] - xs[index];
    if (wrongWayStep > wrongWayTolerance) {
      throw new Error(
        `${label}: upper traversal reverses x by ${(wrongWayStep / chord).toFixed(6)} chord`,
      );
    }
  }
  for (let index = lastLeadingEdge; index < xs.length - 1; index += 1) {
    const wrongWayStep = xs[index] - xs[index + 1];
    if (wrongWayStep > wrongWayTolerance) {
      throw new Error(
        `${label}: lower traversal reverses x by ${(wrongWayStep / chord).toFixed(6)} chord`,
      );
    }
  }
}

function sourceContour(text: string, label: string): Point[] {
  const pairs: Point[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(SOURCE_PAIR);
    if (match) {
      pairs.push({ x: Number(match[1]), y: Number(match[2]) });
      continue;
    }
    // Titles and prose comments may contain arbitrary punctuation and numbers.
    if (/[A-Za-z]/.test(line) || !/\d/.test(line)) continue;
    throw new Error(
      `${label}: malformed numeric source record at line ${index + 1}`,
    );
  }
  if (pairs.length < 3) {
    throw new Error(`${label}: expected at least 3 coordinate points`);
  }

  const [header, ...body] = pairs;
  const nUpper = header.x;
  const nLower = header.y;
  const isCountHeader =
    Number.isInteger(nUpper) &&
    Number.isInteger(nLower) &&
    nUpper >= 0 &&
    nLower >= 0 &&
    nUpper + nLower > 2 &&
    nUpper + nLower === body.length;
  if (!isCountHeader) return pairs;

  // Lednicer surfaces are LE→TE. One-sided source records such as the
  // authoritative NACA-1 cowl use the same count header with a zero lower
  // count; recognizing that source variant does not invent the absent side.
  const upper = body.slice(0, nUpper).reverse();
  const lower = body.slice(nUpper, nUpper + nLower);
  return [...upper, ...lower];
}

function assertNoIsolatedEndpointOutlier(
  points: readonly Point[],
  label: string,
): void {
  for (const endpointIndex of [0, points.length - 1]) {
    const endpoint = points[endpointIndex];
    const body = points.filter((_, index) => index !== endpointIndex);
    const xs = body.map((point) => point.x);
    const ys = body.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const bodyScale = Math.max(maxX - minX, maxY - minY);
    if (!(bodyScale > 0)) continue;
    const excessX = Math.max(minX - endpoint.x, endpoint.x - maxX, 0);
    const excessY = Math.max(minY - endpoint.y, endpoint.y - maxY, 0);
    if (
      Math.hypot(excessX, excessY) >
      bodyScale * ISOLATED_ENDPOINT_OUTLIER_SCALE
    ) {
      throw new Error(
        `${label}: isolated ${endpointIndex === 0 ? "leading" : "trailing"} source record lies outside the coordinate body`,
      );
    }
  }
}

/** Validate a bundled source without requiring a closed exterior airfoil. */
export function assertSeedCoordinateIntegrity(
  text: string,
  label = "coordinate source",
): void {
  const points = sourceContour(text, label);
  assertSingleContourProgression(points, label);
  assertNoIsolatedEndpointOutlier(points, label);
}
