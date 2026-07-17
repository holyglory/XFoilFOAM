import {
  precalcContinuationMadeProgress,
  precalcContinuationProgressFromEvidence,
} from "@aerodb/db";
import { describe, expect, it } from "vitest";

describe("preliminary URANS continuation progress extraction", () => {
  it("uses real force-history time when frame tracking is incomplete", () => {
    const baseline = precalcContinuationProgressFromEvidence({
      frame_track: {
        period_s: null,
        periods_retained: null,
        stationary: false,
        drift_frac: null,
        window: { t_start: null, t_end: null },
      },
      force_history: {
        period_s: 0.004,
        retained_cycles: 3,
        window_end: 0.06,
      },
    });
    const continued = precalcContinuationProgressFromEvidence({
      frame_track: {
        period_s: null,
        periods_retained: null,
        stationary: false,
        drift_frac: null,
        window: { t_start: null, t_end: null },
      },
      force_history: {
        period_s: 0.004,
        retained_cycles: 3,
        window_end: 0.064,
      },
    });

    expect(baseline).toMatchObject({
      periodsRetained: 3,
      simulatedTimeS: 0.06,
      periodS: 0.004,
    });
    expect(precalcContinuationMadeProgress(baseline, continued)).toBe(true);
    expect(precalcContinuationMadeProgress(baseline, baseline)).toBe(false);
  });

  it("keeps frame-track measurements authoritative", () => {
    expect(
      precalcContinuationProgressFromEvidence({
        frame_track: {
          period_s: 0.01,
          periods_retained: 2,
          stationary: false,
          drift_frac: 0.2,
          window: { t_start: 0.08, t_end: 0.1 },
        },
        force_history: {
          period_s: 99,
          retained_cycles: 99,
          window_end: 99,
        },
      }),
    ).toMatchObject({
      periodsRetained: 2,
      simulatedTimeS: 0.1,
      periodS: 0.01,
    });
  });

  it("does not treat malformed force-history fields as progress", () => {
    expect(
      precalcContinuationProgressFromEvidence({
        frame_track: null,
        force_history: {
          period_s: "0.01",
          retained_cycles: -1,
          window_end: Number.NaN,
        },
      }),
    ).toEqual({
      periodsRetained: null,
      simulatedTimeS: null,
      periodS: null,
      driftFrac: null,
      stationary: null,
    });
  });

  it("fails closed when simulated time regresses despite better-looking derived metrics", () => {
    const previous = {
      periodsRetained: 3,
      simulatedTimeS: 0.06,
      periodS: 0.004,
      driftFrac: 0.2,
      stationary: false,
    };
    const regressed = {
      periodsRetained: 3.5,
      simulatedTimeS: 0.01,
      periodS: 0.004,
      driftFrac: 0.01,
      stationary: true,
    };

    expect(precalcContinuationMadeProgress(previous, regressed)).toBe(false);
  });

  it("does not mint progress from period re-estimation over an unchanged window", () => {
    const previous = {
      periodsRetained: 3,
      simulatedTimeS: 0.06,
      periodS: 0.02,
      driftFrac: 0.2,
      stationary: false,
    };
    const reestimated = {
      periodsRetained: 4,
      simulatedTimeS: 0.06,
      periodS: 0.015,
      driftFrac: 0.1,
      stationary: true,
    };

    expect(precalcContinuationMadeProgress(previous, reestimated)).toBe(false);
    expect(
      precalcContinuationMadeProgress(previous, {
        ...reestimated,
        simulatedTimeS: 0.061,
        periodS: 0.001,
        driftFrac: previous.driftFrac,
        stationary: previous.stationary,
      }),
    ).toBe(false);
  });

  it("MUST-CATCH: keeps a stable-period trajectory alive across sub-quarter continuation segments", () => {
    const first = {
      periodsRetained: 1,
      simulatedTimeS: 1,
      periodS: 1,
      driftFrac: 0.2,
      stationary: false,
    };
    const second = {
      ...first,
      periodsRetained: 1.2,
      simulatedTimeS: 1.2,
    };
    const third = {
      ...second,
      periodsRetained: 1.4,
      simulatedTimeS: 1.4,
    };

    // The physical trajectory advanced in both immutable segments. Neither
    // segment may spend a no-progress strike merely because an interruption
    // split the next shedding period into pieces smaller than one quarter.
    expect(precalcContinuationMadeProgress(first, second)).toBe(true);
    expect(precalcContinuationMadeProgress(second, third)).toBe(true);
  });

  it("requires a prior immutable baseline and a positive period", () => {
    const current = precalcContinuationProgressFromEvidence({
      force_history: {
        period_s: 0,
        retained_cycles: 4,
        window_end: 0.08,
      },
    });
    expect(current.periodS).toBeNull();
    expect(precalcContinuationMadeProgress(null, current)).toBe(false);
  });

  it("uses compatible retained-cycle growth only when both window ends are absent", () => {
    const previous = {
      periodsRetained: 3,
      simulatedTimeS: null,
      periodS: 0.01,
      driftFrac: null,
      stationary: false,
    };
    expect(
      precalcContinuationMadeProgress(previous, {
        ...previous,
        periodsRetained: 3.3,
        periodS: 0.0102,
      }),
    ).toBe(true);
    expect(
      precalcContinuationMadeProgress(previous, {
        ...previous,
        periodsRetained: 3.3,
        periodS: 0.008,
      }),
    ).toBe(false);
  });
});
