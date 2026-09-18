import { describe, expect, it } from "vitest";
import {
  conditionLabel,
  metricConditionParam,
  withMetricCondition,
} from "../lib/metric-condition";

describe("available metric condition navigation", () => {
  const key = "a".repeat(64);
  it("keeps a condition while retaining the selected comparison profiles", () => {
    expect(withMetricCondition("/compare?airfoil=ag24&airfoil=ag25", key)).toBe(
      `/compare?airfoil=ag24&airfoil=ag25&condition=${key}`,
    );
    expect(withMetricCondition(`/airfoils/ag24?condition=${key}`, "")).toBe(
      "/airfoils/ag24",
    );
    expect(metricConditionParam(key)).toBe(key);
    expect(metricConditionParam("rounded-Re-1m")).toBe("");
    expect(metricConditionParam([key])).toBe("");
  });
  it("shows compact physical choices instead of raw identifiers", () => {
    const condition = {
      key,
      re: 2e6,
      mach: 0.09,
      speedMps: 30,
      referenceLengthM: 1,
      temperatureK: 288.15,
      pressurePa: 101325,
      branch: "increasing",
    };
    expect(conditionLabel(condition)).toBe("30 m/s · 1 m chord");
    expect(
      conditionLabel({ ...condition, mach: 2.999995, speedMps: 1021.025 }),
    ).toBe("Mach 3 · 1 m chord");
  });
});
