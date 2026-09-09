import { describe, expect, it } from "vitest";
import { polarAxisLayout } from "../lib/polar-axis";

describe("polar axis margins", () => {
  it.each([258, 312, 840])(
    "contains small signed CFD ticks at width %s",
    (width) => {
      const axis = polarAxisLayout(-0.004993, 0.7955, width);
      expect(axis.ticks[0].label).toBe("-0.004993");
      expect(axis.left).toBeGreaterThan(58);
      expect(axis.left + axis.plotWidth).toBe(width - 24);
      for (const tick of axis.ticks)
        expect(axis.left - 8 - tick.label.length * 8).toBeGreaterThanOrEqual(8);
    },
  );

  it("keeps ordinary labels compact and changes only space, not values", () => {
    const axis = polarAxisLayout(-1, 2, 320);
    expect(axis.left).toBe(58);
    expect(axis.ticks.map((tick) => tick.label)).toEqual(["-1", "0", "1", "2"]);
    expect(polarAxisLayout(-1, 2, 1440).ticks).toHaveLength(6);
  });

  it("retains readable exponent labels and a nonempty plot", () => {
    const axis = polarAxisLayout(-1e30, 1e30, 258);
    expect(axis.plotWidth).toBeGreaterThan(100);
    expect(axis.ticks[0].label).toBe("-1e+30");
  });
});
