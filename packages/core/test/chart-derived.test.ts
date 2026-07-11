import { describe, expect, it } from "vitest";

import { derivedBySymmetryInfo, derivedBySymmetryNote, projectChart } from "../src/chart";
import type { PolarPointData } from "../src/types";

function solvedPoint(a: number, cl: number, resultId: string, extra: Partial<PolarPointData> & Record<string, unknown> = {}): PolarPointData {
  return {
    a,
    cl,
    cd: 0.01,
    cm: -0.02,
    ld: cl / 0.01,
    stalled: false,
    source: "solved",
    resultId,
    classificationState: "accepted",
    ...extra,
  } as PolarPointData;
}

describe("derived-by-symmetry chart styling (spec §9.3)", () => {
  const source = solvedPoint(4, 0.5, "res-1");
  const derived = solvedPoint(-4, -0.5, "res-1", {
    derived: true,
    derivedFromResultId: "res-1",
    derivedFromAoaDeg: 4,
  });

  const projection = projectChart({
    chartType: "cla",
    polars: [{ seriesId: "series-a", label: "Re 100k", re: 100000, color: "#f5a524", points: [derived, source], fit: null }],
    visibleSeries: { "series-a": true },
  });

  it("reads the payload marker fields structurally", () => {
    expect(derivedBySymmetryInfo(source)).toEqual({ derived: false, derivedFromResultId: null, derivedFromAoaDeg: null });
    expect(derivedBySymmetryInfo(derived)).toEqual({ derived: true, derivedFromResultId: "res-1", derivedFromAoaDeg: 4 });
    expect(derivedBySymmetryNote(derived)).toBe("derived by symmetry (from +4°)");
    expect(derivedBySymmetryNote(source)).toBeNull();
  });

  it("renders the mirror hollow in the curve colour with the §9.3 tooltip note", () => {
    const derivedVm = projection.points.find((p) => p.point.a === -4)!;
    const sourceVm = projection.points.find((p) => p.point.a === 4)!;
    // hollow marker: background fill + curve-colour stroke
    expect(derivedVm.fill).toBe("#0a0f15");
    expect(derivedVm.stroke).toBe("#f5a524");
    // tooltip head carries the provenance note verbatim
    expect(derivedVm.label).toContain("derived by symmetry (from +4°)");
    // the real solve keeps the existing solid styling
    expect(sourceVm.fill).toBe("#f5a524");
    expect(sourceVm.label).not.toContain("derived by symmetry");
  });

  it("keys mirror and source separately even though they share a resultId", () => {
    const keys = projection.points.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("must-catch: an unmarked mirror would render as a normal solved point (no silent derived styling)", () => {
    const unmarked = solvedPoint(-4, -0.5, "res-1");
    const plain = projectChart({
      chartType: "cla",
      polars: [{ seriesId: "series-a", label: "Re 100k", re: 100000, color: "#f5a524", points: [unmarked, source], fit: null }],
      visibleSeries: { "series-a": true },
    });
    const vm = plain.points.find((p) => p.point.a === -4)!;
    expect(vm.fill).toBe("#f5a524");
    expect(vm.label).not.toContain("derived by symmetry");
  });
});
