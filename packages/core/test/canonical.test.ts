import { describe, expect, it } from "vitest";

import { canonicalAoa, canonicalSi, canonicalSiString, expandAngleGrid } from "../src/index";

describe("canonicalAoa round-half-even at 1e-4 deg", () => {
  it("rounds exact half ties to the even neighbour", () => {
    expect(canonicalAoa(0.00005)).toBe(0); // 0 is even → stays
    expect(canonicalAoa(0.00015)).toBe(0.0002); // 1 is odd → up
    expect(canonicalAoa(0.00025)).toBe(0.0002); // 2 is even → stays
    expect(canonicalAoa(0.00035)).toBe(0.0004);
    expect(canonicalAoa(-0.00015)).toBe(-0.0002);
    expect(canonicalAoa(-0.00025)).toBe(-0.0002);
  });

  it("rounds non-tie remainders to nearest", () => {
    expect(canonicalAoa(1.23456)).toBe(1.2346);
    expect(canonicalAoa(1.23454)).toBe(1.2345);
    expect(canonicalAoa(-7.000049)).toBe(-7);
    expect(canonicalAoa(0.000151)).toBe(0.0002); // 5 followed by nonzero → up
  });

  it("passes already-canonical values through unchanged", () => {
    for (const v of [-10, -0.5, 0, 0.1234, 25, 3.7]) {
      expect(canonicalAoa(v)).toBe(v);
    }
  });

  it("never produces negative zero", () => {
    expect(Object.is(canonicalAoa(-0.00001), 0)).toBe(true);
  });
});

describe("canonicalSi / canonicalSiString precisions", () => {
  it("temperature at 0.01 K with half-even ties", () => {
    expect(canonicalSi("temperatureK", 288.155)).toBe(288.16); // 5 odd → up
    expect(canonicalSi("temperatureK", 288.145)).toBe(288.14); // 4 even → stays
    expect(canonicalSiString("temperatureK", 288.15)).toBe("288.15");
  });

  it("pressure at 1 Pa (integer string, no decimal point)", () => {
    expect(canonicalSi("pressurePa", 101324.5)).toBe(101324); // 4 even → stays
    expect(canonicalSi("pressurePa", 101325.5)).toBe(101326); // 5 odd → up
    expect(canonicalSiString("pressurePa", 101325)).toBe("101325");
  });

  it("speed at 0.001 m/s, chord/span at 0.0001 m, area at 1e-6 m²", () => {
    expect(canonicalSi("speedMps", 0.0005)).toBe(0); // 0 even → stays
    expect(canonicalSiString("speedMps", 10)).toBe("10.000");
    expect(canonicalSiString("chordM", 0.15)).toBe("0.1500");
    expect(canonicalSiString("spanM", 1)).toBe("1.0000");
    expect(canonicalSiString("areaM2", 0.0375)).toBe("0.037500");
    expect(canonicalSi("areaM2", 1.5e-7)).toBe(0); // exponential input, below precision
    expect(canonicalSiString("areaM2", 1.5e-7)).toBe("0.000000");
  });

  it("strings are byte-stable across float-dust representations", () => {
    expect(canonicalSiString("speedMps", 0.1 + 0.2)).toBe("0.300");
    expect(canonicalSiString("chordM", 0.1 + 0.2)).toBe("0.3000");
  });

  it("rejects non-finite input", () => {
    expect(() => canonicalSi("temperatureK", Number.NaN)).toThrow();
    expect(() => canonicalAoa(Infinity)).toThrow();
  });
});

describe("expandAngleGrid", () => {
  it("a 0.5° grid is a byte-identical subset of the 0.1° grid", () => {
    const coarse = expandAngleGrid({ fromDeg: -10, toDeg: 25, stepDeg: 0.5 });
    const fine = expandAngleGrid({ fromDeg: -10, toDeg: 25, stepDeg: 0.1 });
    expect(coarse.length).toBe(71);
    expect(fine.length).toBe(351);
    const fineSet = new Set(fine);
    for (const v of coarse) expect(fineSet.has(v)).toBe(true);
    // byte equality, not just numeric closeness
    const fineJson = new Set(fine.map((v) => JSON.stringify(v)));
    for (const v of coarse) expect(fineJson.has(JSON.stringify(v))).toBe(true);
  });

  it("expands fractional steps like 0.7 over -10..25 without float drift", () => {
    const grid = expandAngleGrid({ fromDeg: -10, toDeg: 25, stepDeg: 0.7 });
    expect(grid.length).toBe(51);
    expect(grid[0]).toBe(-10);
    expect(grid[1]).toBe(-9.3);
    expect(grid[grid.length - 1]).toBe(25);
    for (const v of grid) expect(v).toBe(canonicalAoa(v));
    expect([...grid].sort((a, b) => a - b)).toEqual(grid);
  });

  it("list overrides range, canonicalized, sorted, deduped", () => {
    const grid = expandAngleGrid({
      fromDeg: 0,
      toDeg: 5,
      stepDeg: 1,
      listDeg: [4, -2, 4.00001, 0.00015],
    });
    expect(grid).toEqual([-2, 0.0002, 4]);
  });

  it("handles single-element lists and single-cell ranges", () => {
    expect(expandAngleGrid({ listDeg: [5] })).toEqual([5]);
    expect(expandAngleGrid({ fromDeg: 3, toDeg: 3, stepDeg: 0.5 })).toEqual([3]);
    expect(expandAngleGrid({ fromDeg: 3, toDeg: 2, stepDeg: 0.5 })).toEqual([]);
  });

  it("rejects unusable range specs", () => {
    expect(() => expandAngleGrid({ fromDeg: 0, toDeg: 10 })).toThrow();
    expect(() => expandAngleGrid({ fromDeg: 0, toDeg: 10, stepDeg: 0 })).toThrow();
    expect(() => expandAngleGrid({ fromDeg: 0, toDeg: 10, stepDeg: -1 })).toThrow();
    expect(() => expandAngleGrid({ fromDeg: 0, toDeg: 10, stepDeg: 0.00001 })).toThrow();
  });
});
