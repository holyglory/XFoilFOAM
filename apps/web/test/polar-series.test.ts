import type { AirfoilDetailPayload, Polar, PolarPointData } from "@aerodb/core";
import { describe, expect, it } from "vitest";

import {
  activePolarSeriesId,
  initialSeriesVisibility,
  polarLegendItems,
  polarSeriesOptions,
  formatPolarAoa,
  primaryPolarEvidencePoints,
  publicSolvedPointCount,
  storedResultsHeading,
  toggleSeriesVisibility,
  visibleMachDisplay,
} from "../lib/polar-series";

function point(resultId: string, a: number): PolarPointData {
  return {
    a,
    cl: 0.2 + a * 0.1,
    cd: 0.012,
    cm: -0.02,
    ld: (0.2 + a * 0.1) / 0.012,
    stalled: false,
    source: "solved",
    resultId,
    classificationState: "accepted",
  };
}

const sameRePolars: Polar[] = [
  {
    seriesId: "physics-a",
    label: "Re 171k · M 0.07 · condition 1",
    re: 171000,
    mach: 0.07,
    color: "#34d399",
    source: "solved",
    points: [point("result-a", -4)],
  },
  {
    seriesId: "physics-b",
    label: "Re 171k · M 0.07 · condition 2",
    re: 171000,
    mach: 0.07,
    color: "#60a5fa",
    source: "solved",
    points: [point("result-b", 4)],
  },
];

const detail = (polars: Polar[]) => ({ polars }) as AirfoilDetailPayload;

describe("public polar-series UI model", () => {
  it("starts every emitted public series visible and toggles same-Re series independently", () => {
    const initial = initialSeriesVisibility(sameRePolars);
    expect(initial).toEqual({ "physics-a": true, "physics-b": true });

    // Recall guard: the retired Reynolds defaults hid 200k and 1M even when
    // real solved series were present.
    const formerlyHiddenPolars: Polar[] = [
      { ...sameRePolars[0], seriesId: "physics-200k", re: 200000 },
      { ...sameRePolars[1], seriesId: "physics-1m", re: 1000000 },
    ];
    expect(initialSeriesVisibility(formerlyHiddenPolars)).toEqual({
      "physics-200k": true,
      "physics-1m": true,
    });

    const toggled = toggleSeriesVisibility(initial, "physics-a");
    expect(toggled).toEqual({ "physics-a": false, "physics-b": true });
  });

  it("builds legend rows from public labels and API-assigned series colors", () => {
    const items = polarLegendItems(sameRePolars, {
      "physics-a": true,
      "physics-b": false,
    });
    expect(
      items.map(({ seriesId, label, color, visible }) => ({
        seriesId,
        label,
        color,
        visible,
      })),
    ).toEqual([
      {
        seriesId: "physics-a",
        label: "Re 171k · M 0.07 · condition 1",
        color: "#34d399",
        visible: true,
      },
      {
        seriesId: "physics-b",
        label: "Re 171k · M 0.07 · condition 2",
        color: "#60a5fa",
        visible: false,
      },
    ]);
    expect(items.map((item) => item.label).join(" ")).not.toMatch(
      /setup|preset|revision|remote-validation|batch/i,
    );
  });

  it("counts unique non-alternate real AoAs without inflating repeated evidence", () => {
    const primary = {
      ...point("primary", 0),
      evidenceRole: "primary" as const,
    };
    const alternate = {
      ...primary,
      resultId: "alternate",
      evidenceRole: "alternate" as const,
    };
    const conflict = {
      ...point("conflict", 2),
      evidenceRole: "conflict" as const,
    };
    const repeatedConflict = {
      ...conflict,
      resultId: "conflict-repeat",
      cl: conflict.cl + 0.02,
    };
    const alternateOnly = {
      ...point("alternate-only", 4),
      evidenceRole: "alternate" as const,
    };
    const derived = {
      ...point("primary", -0),
      evidenceRole: "primary" as const,
      derived: true,
      derivedFromResultId: "primary",
      derivedFromAoaDeg: 0,
    };
    expect(
      publicSolvedPointCount([
        primary,
        alternate,
        conflict,
        repeatedConflict,
        alternateOnly,
        derived,
      ]),
    ).toBe(2);
    const legend = polarLegendItems(
      [
        {
          ...sameRePolars[0],
          points: [
            primary,
            alternate,
            conflict,
            repeatedConflict,
            alternateOnly,
            derived,
          ],
        },
      ],
      { "physics-a": true },
    );
    expect(legend[0].pointCount).toBe(2);
    expect(
      primaryPolarEvidencePoints([
        primary,
        alternate,
        conflict,
        repeatedConflict,
      ]).map((item) => item.resultId),
    ).toEqual(["primary"]);
  });

  it("labels a stacked result chooser honestly for one or several AoAs", () => {
    expect(formatPolarAoa(4.25)).toBe("4.25");
    expect(storedResultsHeading([point("a", 4.25), point("b", 4.25)])).toBe(
      "Stored results at α 4.25°",
    );
    expect(storedResultsHeading([point("a", -2), point("b", 4.25)])).toBe(
      "Stored results at this chart point",
    );
  });

  it("disambiguates same-Re/Mach labels across the selected-airfoil union", () => {
    const isolatedA = { ...sameRePolars[0], label: "Re 171k · M 0.07" };
    const isolatedB = { ...sameRePolars[1], label: "Re 171k · M 0.07" };
    const options = polarSeriesOptions([
      detail([isolatedA]),
      detail([isolatedB]),
    ]);
    expect(options.map((option) => option.seriesId)).toEqual([
      "physics-a",
      "physics-b",
    ]);
    expect(options.map((option) => option.label)).toEqual([
      "Re 171k · M 0.07 · condition 1",
      "Re 171k · M 0.07 · condition 2",
    ]);
    expect(new Set(options.map((option) => option.label)).size).toBe(2);
  });

  it("automatically maximizes selected-airfoil coverage before preferring Re 300k", () => {
    const preferred300k: Polar = {
      ...sameRePolars[1],
      seriesId: "physics-300k",
      label: "Re 300k",
      re: 300000,
    };
    const coverageWins = polarSeriesOptions([
      detail([sameRePolars[0], preferred300k]),
      detail([{ ...sameRePolars[0], points: [point("result-a-2", 0)] }]),
    ]);
    expect(
      coverageWins.find((option) => option.seriesId === "physics-a")?.coverage,
    ).toBe(2);
    expect(activePolarSeriesId(coverageWins, null)).toBe("physics-a");

    const preferredBreaksTie = polarSeriesOptions([
      detail([sameRePolars[0], preferred300k]),
    ]);
    expect(activePolarSeriesId(preferredBreaksTie, null)).toBe("physics-300k");
    expect(activePolarSeriesId(preferredBreaksTie, "physics-a")).toBe(
      "physics-a",
    );
  });

  it("shows one visible Mach or an honest range for mixed visible series", () => {
    expect(
      visibleMachDisplay(sameRePolars, {
        "physics-a": true,
        "physics-b": false,
      }),
    ).toBe("0.07");
    expect(
      visibleMachDisplay(
        [
          { ...sameRePolars[0], mach: 0.05 },
          { ...sameRePolars[1], mach: 0.12 },
        ],
        { "physics-a": true, "physics-b": true },
      ),
    ).toBe("0.05–0.12");
    expect(
      visibleMachDisplay(sameRePolars, {
        "physics-a": false,
        "physics-b": false,
      }),
    ).toBe("—");
  });
});
