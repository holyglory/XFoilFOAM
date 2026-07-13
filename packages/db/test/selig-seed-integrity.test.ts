import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCoordinates } from "@aerodb/core";
import { describe, expect, it } from "vitest";

import {
  assertSeedCoordinateIntegrity,
  assertSingleContourProgression,
  seedSourceDisposition,
} from "../seed/coordinate-integrity";

const here = dirname(fileURLToPath(import.meta.url));
const seedDirectory = resolve(here, "../seed/selig-database");

describe("bundled UIUC/Selig coordinate integrity", () => {
  it.each([
    {
      file: "e850.dat",
      count: 67,
      sha256:
        "688568ac10ee0fa5075095d4d78682548004a80d254cd801199e28f73d35f04c",
      first: { x: 1, y: 0.00008 },
      leadingEdge: { x: 0, y: 0 },
      last: { x: 1, y: 0.00008 },
    },
    {
      file: "naca23015.dat",
      count: 35,
      sha256:
        "d3269d35d8fca5ea63b1e4e9bb7b6b3c4f86cea0c4d683ee119ae53b2a43fbd8",
      first: { x: 1, y: 0.0016 },
      leadingEdge: { x: 0, y: 0 },
      last: { x: 1, y: -0.0016 },
    },
  ])(
    "pins the authoritative $file source",
    ({ file, count, sha256, first, leadingEdge, last }) => {
      const source = readFileSync(join(seedDirectory, file), "utf8");
      const points = parseCoordinates(source).points;

      expect(createHash("sha256").update(source).digest("hex")).toBe(sha256);
      expect(points).toHaveLength(count);
      expect(points[0]).toEqual(first);
      expect(points.filter((point) => point.x === 0)).toEqual([leadingEdge]);
      expect(points.at(-1)).toEqual(last);
    },
  );

  it("MUST-CATCH: rejects a duplicated LE→TE→LE wrap", () => {
    const authoritative = parseCoordinates(
      readFileSync(join(seedDirectory, "e850.dat"), "utf8"),
    ).points;
    const minX = Math.min(...authoritative.map((point) => point.x));
    const leadingEdgeIndex = authoritative.findIndex(
      (point) => point.x === minX,
    );
    // Exact shape of the historical corruption: three records from the source
    // transform were spliced between E850's upper LE and true lower surface.
    const duplicatedWrap = [
      ...authoritative.slice(0, leadingEdgeIndex + 1),
      { x: 0.99672, y: 0.00077 },
      { x: 1, y: 0.00008 },
      { x: 0, y: 0 },
      ...authoritative.slice(leadingEdgeIndex + 1),
    ];

    expect(() =>
      assertSingleContourProgression(duplicatedWrap, "duplicate.dat"),
    ).toThrow("visits the leading edge in 2 separate runs");
  });

  it("MUST-CATCH: rejects a material wrong-way surface step", () => {
    const reversedSurface = [
      { x: 1, y: 0.001 },
      { x: 0.6, y: 0.08 },
      { x: 0.7, y: 0.07 },
      { x: 0, y: 0 },
      { x: 0.5, y: -0.04 },
      { x: 1, y: -0.001 },
    ];

    expect(() =>
      assertSingleContourProgression(reversedSurface, "reversed.dat"),
    ).toThrow("upper traversal reverses x");
  });

  it("MUST-CATCH: rejects malformed legacy numeric records", () => {
    const legacyNaca23015 = `NACA 23015
1.0000 ......
1.0000 (0.0016)
0.0000 0.0000
1.0000 (-0.0016)
100.00 0.0000
`;

    expect(() =>
      assertSeedCoordinateIntegrity(legacyNaca23015, "naca23015.dat"),
    ).toThrow("malformed numeric source record");
  });

  it("MUST-CATCH: rejects an isolated trailing source record", () => {
    const trailingOutlier = `CLEAN NUMERIC FIXTURE
1 0.01
0.5 0.08
0 0
0.5 -0.04
1 -0.01
100 0
`;

    expect(() =>
      assertSeedCoordinateIntegrity(trailingOutlier, "trailing.dat"),
    ).toThrow("isolated trailing source record");
  });

  it("does not mistake a blunt trailing edge for a duplicated wrap", () => {
    const bluntTrailingEdge = [
      { x: 1, y: 0.02 },
      { x: 0.5, y: 0.08 },
      { x: 0, y: 0 },
      { x: 0.5, y: -0.04 },
      { x: 1, y: -0.02 },
    ];

    expect(() =>
      assertSingleContourProgression(bluntTrailingEdge),
    ).not.toThrow();
  });

  it("accepts a Lednicer contour with consecutive duplicate LE points", () => {
    const source = `LEDNICER FIXTURE
3 3
0 0
0.5 0.08
1 0.01
0 0
0.5 -0.04
1 -0.01
`;
    const parsed = parseCoordinates(source);

    expect(parsed.format).toBe("lednicer");
    expect(() => assertSeedCoordinateIntegrity(source)).not.toThrow();
  });

  it("accepts a one-sided legacy count header without inventing a surface", () => {
    const oneSided = `ONE-SIDED COWL FIXTURE
4 0
0 0
0.3 0.2
0.7 0.7
1 1
`;

    expect(() => assertSeedCoordinateIntegrity(oneSided)).not.toThrow();
  });

  it("MUST-CATCH + FALSE-POSITIVE GUARD: only the two authoritative open components are excluded from airfoil campaigns", () => {
    const files = readdirSync(seedDirectory)
      .filter((file) => file.endsWith(".dat") && !file.startsWith("."))
      .sort();
    const excluded = files
      .map((file) => ({ file, ...seedSourceDisposition(file) }))
      .filter((entry) => !entry.catalogEligible);

    expect(excluded.map((entry) => entry.file)).toEqual([
      "naca1.dat",
      "ua79sfm.dat",
    ]);
    expect(excluded.every((entry) => Boolean(entry.reason))).toBe(true);
    expect(
      files.filter((file) => seedSourceDisposition(file).catalogEligible),
    ).toHaveLength(1619);
    expect(seedSourceDisposition("e850.dat")).toEqual({
      catalogEligible: true,
      reason: null,
    });
    expect(seedSourceDisposition("naca23015.dat")).toEqual({
      catalogEligible: true,
      reason: null,
    });
  });

  it("checks every bundled coordinate source", () => {
    const files = readdirSync(seedDirectory)
      .filter((file) => file.endsWith(".dat") && !file.startsWith("."))
      .sort();

    expect(files).toHaveLength(1621);
    for (const file of files) {
      const source = readFileSync(join(seedDirectory, file), "utf8");
      expect(() => parseCoordinates(source), file).not.toThrow();
      expect(
        () => assertSeedCoordinateIntegrity(source, file),
        file,
      ).not.toThrow();
    }
  });
});
