import { describe, expect, it } from "vitest";
import { progressiveCurveMetrics } from "../src/progressive-curve-metrics";

const samples = [
  { alpha: -2, cl: -0.2, cd: 0.03, cm: -0.04 },
  { alpha: 2, cl: 0.6, cd: 0.01, cm: -0.02 },
  { alpha: 8, cl: 1.2, cd: 0.04, cm: -0.05 },
];

describe("cached progressive curve metrics", () => {
  it("derives bounded extrema and bracketed zero values from the exact curve", () => {
    const result = progressiveCurveMetrics(samples)!;
    expect(result).toMatchObject({
      alphaMinimum: -2,
      alphaMaximum: 8,
      liftToDragMaximum: 60,
      alphaAtLiftToDragMaximum: 2,
      dragMinimum: 0.01,
      liftMaximum: 1.2,
      alphaAtLiftMaximum: 8,
      momentAtZeroAlpha: -0.03,
    });
    expect(result.dragAtZeroLift).toBeCloseTo(0.025);
  });

  it("does not invent zero-lift drag or extrapolate pitching moment", () => {
    expect(progressiveCurveMetrics(samples.slice(1))).toMatchObject({
      dragAtZeroLift: null,
      momentAtZeroAlpha: null,
    });
  });

  it("keeps nonpositive-lift efficiency unavailable without sentinel maxima", () => {
    expect(
      progressiveCurveMetrics(samples.map((sample) => ({ ...sample, cl: -1 }))),
    ).toMatchObject({
      liftToDragMaximum: null,
      alphaAtLiftToDragMaximum: null,
      liftMaximum: -1,
      alphaAtLiftMaximum: -2,
    });
  });

  it("uses an exact zero sample once and rejects ambiguous zero crossings", () => {
    const exact = [
      samples[0],
      { alpha: 0, cl: 0, cd: 0.02, cm: 0.05 },
      samples[1],
    ];
    expect(progressiveCurveMetrics(exact)).toMatchObject({
      dragAtZeroLift: 0.02,
      momentAtZeroAlpha: 0.05,
    });
    expect(
      progressiveCurveMetrics([
        ...samples,
        { alpha: 12, cl: -0.1, cd: 0.1, cm: 0 },
      ])?.dragAtZeroLift,
    ).toBeNull();
    expect(
      progressiveCurveMetrics(exact.map((sample) => ({ ...sample, cl: 0 })))
        ?.dragAtZeroLift,
    ).toBeNull();
  });

  it.each(
    [
      [],
      [samples[0]],
      [...samples].reverse(),
      [samples[0], samples[0]],
      samples.map((sample) => ({ ...sample, cd: 0 })),
      samples.map((sample) => ({ ...sample, cm: NaN })),
      samples.map((sample) => ({ ...sample, cl: Infinity })),
    ].map((invalid) => ({ invalid })),
  )("refuses invalid or insufficient cached samples %#", ({ invalid }) => {
    expect(progressiveCurveMetrics(invalid)).toBeNull();
  });

  it("does not mutate the cached source or conflate methods", () => {
    const source = structuredClone(samples);
    const corrected = samples.map((sample) => ({
      ...sample,
      cd: sample.cd * 2,
    }));
    expect(progressiveCurveMetrics(corrected)?.liftToDragMaximum).toBe(30);
    expect(progressiveCurveMetrics(samples)?.liftToDragMaximum).toBe(60);
    expect(samples).toEqual(source);
  });
});
