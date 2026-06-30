import { describe, expect, it } from "vitest";

import type { AirfoilSummary } from "@aerodb/core";

import { rankSearchItems } from "../components/search/ranking";

function airfoil(overrides: Partial<AirfoilSummary>): AirfoilSummary {
  return {
    id: overrides.slug ?? "id",
    slug: overrides.slug ?? "test",
    name: overrides.name ?? "Test",
    categoryId: "category",
    categorySlug: "category",
    categoryPath: "Category",
    family: "Test",
    tags: [],
    hashtags: [],
    points: [],
    thicknessPct: 12,
    areaProfile: 0.06,
    areaUpper: 0.03,
    areaLower: -0.03,
    areaCamber: 0,
    areaUpperPositive: 0.03,
    areaUpperNegative: 0,
    areaLowerPositive: 0,
    areaLowerNegative: -0.03,
    areaCamberPositive: 0,
    areaCamberNegative: 0,
    camberPct: 0,
    camberPosPct: 0,
    reMin: 0,
    reMax: 0,
    polarCount: 0,
    ldmax: null,
    clmax: null,
    cdmin: null,
    metricsSource: "queued",
    ...overrides,
  };
}

describe("search ranking evidence contract", () => {
  it("does not rank airfoils that only have geometry/reference data", () => {
    const ranked = rankSearchItems(
      [
        airfoil({ slug: "s1223", name: "S1223", thicknessPct: 12.1, camberPct: 8.7 }),
        airfoil({ slug: "ag24", name: "AG24", thicknessPct: 8.4, camberPct: 2.2 }),
      ],
      "maxLD",
      { clmaxOn: false, clmaxMin: 1, cdminOn: false, cdminMax: 0.012, tcOn: false, tcMax: 15 },
    );

    expect(ranked).toEqual([]);
  });

  it("ranks only accepted solved summary metrics", () => {
    const ranked = rankSearchItems(
      [
        airfoil({ slug: "empty", name: "No Evidence", polarCount: 0, ldmax: null }),
        airfoil({ slug: "solved-a", name: "Solved A", polarCount: 8, ldmax: 21.2, clmax: 0.9, cdmin: 0.012 }),
        airfoil({ slug: "solved-b", name: "Solved B", polarCount: 9, ldmax: 18.5, clmax: 1.2, cdmin: 0.01 }),
      ],
      "maxLD",
      { clmaxOn: false, clmaxMin: 1, cdminOn: false, cdminMax: 0.012, tcOn: false, tcMax: 15 },
    );

    expect(ranked.map((item) => item.airfoil.slug)).toEqual(["solved-a", "solved-b"]);
  });
});
