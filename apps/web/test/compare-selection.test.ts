import { describe, expect, it } from "vitest";
import {
  comparisonHref,
  parseCompareSelection,
} from "../lib/compare-selection";

describe("comparison selection", () => {
  it("distinguishes default selection from an explicitly cleared selection", () => {
    expect(parseCompareSelection(undefined)).toBeNull();
    expect(parseCompareSelection("")).toEqual([]);
    expect(comparisonHref([])).toBe("/compare?airfoil=");
  });

  it("preserves exact public slugs, order and bounded unique selection", () => {
    expect(
      parseCompareSelection([
        " ag24 ",
        "ag24",
        "naca0012",
        "clarky",
        "rae2822",
        "extra",
      ]),
    ).toEqual(["ag24", "naca0012", "clarky", "rae2822"]);
    const href = comparisonHref(
      ["profile ä", "ag24"],
      "chart=lift&airfoil=old",
    );
    const params = new URL(href, "http://localhost").searchParams;
    expect(params.get("chart")).toBe("lift");
    expect(parseCompareSelection(params.getAll("airfoil"))).toEqual([
      "profile ä",
      "ag24",
    ]);
  });

  it("does not turn path segments or invalid values into profile selections", () => {
    expect(
      parseCompareSelection([
        "..",
        ".",
        "../../admin",
        "folder\\profile",
        "\u0000",
        "a".repeat(201),
      ]),
    ).toEqual([]);
  });
});
