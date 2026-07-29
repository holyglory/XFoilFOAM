import { describe, expect, it, vi } from "vitest";

// This file exercises the pure reducer only.  The staging module imports its
// database symbols for the persistence functions below the reducer, so mock
// those symbols before the module is evaluated rather than opening a shared
// PostgreSQL connection for a coefficient-contract test.
vi.mock("@aerodb/db", () => ({
  resultCanonicalSelections: {},
  resultInterpretationCycles: {},
  resultInterpretations: {},
  resultReducerVersions: {},
  results: {},
}));

import type { PolarPoint } from "@aerodb/engine-client";

import {
  canSelectImmediateEngineInterpretation,
  draftResultInterpretationForPoint,
} from "../src/result-interpretations";

function channel(mean: number, span: number) {
  const min_value = mean - span / 2;
  const max_value = mean + span / 2;
  return {
    mean,
    min_value,
    max_value,
    peak_to_peak: max_value - min_value,
    relative_spread: (max_value - min_value) / (Math.abs(mean) + 1e-3),
  };
}

function point(): PolarPoint {
  return {
    aoa_deg: 4,
    cl: 0.62,
    cd: 0.021,
    cm: -0.071,
    cl_cd: 0.62 / 0.021,
    unsteady: false,
    converged: true,
    first_order_fallback: false,
    images: {},
    rans_hold_certificate: {
      reducer_version: "rans-hold-v1",
      sample_count: 200,
      required_sample_count: 200,
      start_iteration: 801,
      end_iteration: 1000,
      relative_tolerance: 0.002,
      absolute_floor: 1e-3,
      certified: true,
      cl: channel(0.62, 0.0002),
      cd: channel(0.021, 0.00002),
      cm: channel(-0.071, 0.00002),
    },
  };
}

function certifiedFastUransPoint(): PolarPoint {
  return {
    aoa_deg: 12,
    cl: 0.81,
    cd: 0.031,
    cm: -0.09,
    cl_cd: 0.81 / 0.031,
    unsteady: true,
    converged: true,
    first_order_fallback: false,
    images: {},
    urans_cycle_certificate: {
      reducer_version: "clean-cycle-v3",
      period_s: 0.02,
      phase_samples: 96,
      required_clean_cycles: 3,
      terminal_clean_cycles: 3,
      selected_cycle_start_index: 0,
      certified: true,
      cadence_adjusted: false,
      cycles: [0, 1, 2].map((index) => ({
        index,
        t_start: index * 0.02,
        t_end: (index + 1) * 0.02,
        coefficient_samples: 24,
        field_frames: 24,
        phase_max_gap: 0.02,
        phase_shift_bins: 1,
        cl_mean: 0.81,
        cd_mean: 0.031,
        cm_mean: -0.09,
        cl_shape_error: 0.02,
        cd_shape_error: 0.02,
        cm_shape_error: 0.02,
        cl_amplitude_deviation: 0.02,
        cd_amplitude_deviation: 0.02,
        cm_amplitude_deviation: 0.02,
        cl_high_frequency: 0.01,
        cd_high_frequency: 0.01,
        cm_high_frequency: 0.01,
        disposition: "selected",
        reasons: [],
      })),
    },
  };
}

function attachNoSheddingProof(target: PolarPoint): PolarPoint {
  // A physical no-shedding certificate transports a real observation window,
  // not a two-point summary. Keep this at the contract minimum so the test
  // catches a future accidental weakening of the 20-sample gate.
  const t = Array.from({ length: 20 }, (_, index) => (4.2 * index) / 19);
  target.force_history = {
    t,
    cl: t.map(() => target.cl!),
    cd: t.map(() => target.cd!),
    cm: t.map(() => target.cm!),
    samples: 420,
    window_start: 0,
    window_end: 4.2,
  };
  target.no_shedding_certificate = {
    reducer_version: "no-shedding-v1",
    certified: true,
    required_observation_s: 4.2,
    observation_start_time: 0,
    observation_end_time: 4.2,
    observed_observation_s: 4.2,
    source_sample_count: 420,
    transport_sample_count: t.length,
    relative_tolerance: 0.005,
    absolute_floor: 0.001,
    cl_mean: target.cl!,
    cd_mean: target.cd!,
    cm_mean: target.cm!,
    cl_rms: 0,
    cd_rms: 0,
    cm_rms: 0,
    transport_cl_mean: target.cl!,
    transport_cd_mean: target.cd!,
    transport_cm_mean: target.cm!,
    transport_cl_rms: 0,
    transport_cd_rms: 0,
    transport_cm_rms: 0,
  };
  return target;
}

describe("current RANS interpretation reducer", () => {
  it("MUST-CATCH: periodic URANS cannot become canonical from an engine summary before its GCS archive reduction", () => {
    expect(
      canSelectImmediateEngineInterpretation({
        state: "accepted",
        source: "engine_reported",
        regime: "periodic",
      }),
    ).toBe(false);
    expect(
      canSelectImmediateEngineInterpretation({
        state: "accepted",
        source: "archive_backfill",
        regime: "periodic",
      }),
    ).toBe(false);
  });

  it("permits only proven RANS holds to publish before archive reduction", () => {
    expect(
      canSelectImmediateEngineInterpretation({
        state: "accepted",
        source: "engine_reported",
        regime: "rans_hold",
      }),
    ).toBe(true);
    expect(
      canSelectImmediateEngineInterpretation({
        state: "accepted",
        source: "engine_reported",
        regime: "steady_equivalent",
      }),
    ).toBe(false);
    // Even a genuine no-shedding summary is only staging evidence until the
    // archive reducer selects its authenticated observation window.
    expect(
      canSelectImmediateEngineInterpretation({
        state: "accepted",
        source: "engine_reported",
        regime: "no_shedding",
      }),
    ).toBe(false);
  });

  it("accepts only the exact proven raw window as rans_hold", () => {
    const { draft, certificate } = draftResultInterpretationForPoint(
      point(),
      "rans",
    );

    expect(certificate).toBeNull();
    expect(draft).toMatchObject({
      state: "accepted",
      regime: "rans_hold",
      cl: 0.62,
      cd: 0.021,
      cm: -0.071,
      selectedWindow: {
        sampleCount: 200,
        startIteration: 801,
        endIteration: 1000,
      },
    });
  });

  it("turns an explicit current lack of proof into a durable continuation", () => {
    const current = point();
    current.rans_hold_certificate = null;

    const { draft } = draftResultInterpretationForPoint(current, "rans");

    expect(draft).toMatchObject({
      state: "continuation_required",
      regime: "trending_unresolved",
      cl: null,
      cd: null,
      cm: null,
    });
    expect(draft.continuationReason).toContain("FAST URANS");
  });

  it("does not relabel a legacy omitted proof as a current failure", () => {
    const current = point();
    delete current.rans_hold_certificate;

    const { draft } = draftResultInterpretationForPoint(current, "rans");

    expect(draft).toMatchObject({
      state: "legacy_uncertified",
      regime: "legacy_engine_reported",
    });
  });

  it("refuses a point whose displayed coefficients differ from the certified window", () => {
    const current = point();
    current.cl = 0.621;

    const { draft } = draftResultInterpretationForPoint(current, "rans");

    expect(draft).toMatchObject({
      state: "continuation_required",
      regime: "trending_unresolved",
    });
    expect(draft.continuationReason).toContain("do not equal");
  });

  it("accepts only a certified physical no-shedding URANS observation as steady-equivalent", () => {
    const noShedding = point();
    delete noShedding.rans_hold_certificate;
    noShedding.fidelity = "urans_precalc";
    noShedding.frame_track = null;
    noShedding.urans_cycle_certificate = null;
    attachNoSheddingProof(noShedding);

    const { draft } = draftResultInterpretationForPoint(
      noShedding,
      "urans_precalc",
    );

    expect(draft).toMatchObject({
      state: "accepted",
      regime: "steady_equivalent",
      cl: 0.62,
      cd: 0.021,
      cm: -0.071,
    });
  });

  it("MUST-CATCH: a current no-shedding URANS summary without its observation proof routes to FAST", () => {
    const noShedding = point();
    delete noShedding.rans_hold_certificate;
    noShedding.fidelity = "urans_precalc";
    noShedding.frame_track = null;
    noShedding.urans_cycle_certificate = null;
    noShedding.no_shedding_certificate = null;

    const { draft } = draftResultInterpretationForPoint(
      noShedding,
      "urans_precalc",
    );

    expect(draft).toMatchObject({
      state: "continuation_required",
      regime: "trending_unresolved",
    });
    expect(draft.continuationReason).toContain("physical observation");
  });

  it("MUST-CATCH: a no-shedding certificate cannot hide a corrupt terminal force sample", () => {
    const noShedding = point();
    delete noShedding.rans_hold_certificate;
    noShedding.fidelity = "urans_precalc";
    noShedding.frame_track = null;
    noShedding.urans_cycle_certificate = null;
    attachNoSheddingProof(noShedding);
    noShedding.force_history!.cd[3] = Number.NaN;

    const { draft } = draftResultInterpretationForPoint(
      noShedding,
      "urans_precalc",
    );

    expect(draft).toMatchObject({
      state: "continuation_required",
      regime: "trending_unresolved",
    });
    expect(draft.continuationReason).toContain("non-finite");
  });

  it("MUST-CATCH: a finite altered force-history witness cannot reuse a no-shedding certificate", () => {
    const noShedding = point();
    delete noShedding.rans_hold_certificate;
    noShedding.fidelity = "urans_precalc";
    noShedding.frame_track = null;
    noShedding.urans_cycle_certificate = null;
    attachNoSheddingProof(noShedding);
    // Keep the payload finite and ordered.  The certificate is still a valid
    // wire object, so only the control-plane transport remeasurement can
    // detect this distortion.
    noShedding.force_history!.cl[3] += 0.1;

    const { draft } = draftResultInterpretationForPoint(
      noShedding,
      "urans_precalc",
    );

    expect(draft).toMatchObject({
      state: "continuation_required",
      regime: "trending_unresolved",
      cl: null,
      cd: null,
      cm: null,
    });
    expect(draft.continuationReason).toContain("transport does not match");
  });

  it("MUST-CATCH: an explicit missing shedding certificate routes to FAST, never legacy acceptance", () => {
    const shedding = point();
    delete shedding.rans_hold_certificate;
    shedding.fidelity = "urans_precalc";
    shedding.unsteady = true;
    shedding.converged = false;
    shedding.frame_track = {
      period_s: 0.02,
      periods_retained: 2,
      stationary: false,
      drift_frac: 0.2,
      window: { t_start: 0, t_end: 0.04 },
      stats: {
        cl: { mean: 0.62, std: 0.01, min: 0.6, max: 0.64 },
        cd: { mean: 0.021, std: 0.001, min: 0.02, max: 0.022 },
        cm: { mean: -0.071, std: 0.001, min: -0.072, max: -0.07 },
      },
      fields: ["velocity"],
      frames: [],
      image_pattern: "frames/velocity/f{index:04d}.png",
    };
    shedding.urans_cycle_certificate = null;

    const { draft } = draftResultInterpretationForPoint(
      shedding,
      "urans_precalc",
    );

    expect(draft).toMatchObject({
      state: "continuation_required",
      regime: "trending_unresolved",
      cl: null,
      cd: null,
      cm: null,
    });
    expect(draft.continuationReason).toContain("no clean-cycle certificate");
  });

  it("routes a certified-but-nonstationary archive reduction to continuation instead of drifting from the reducer state", () => {
    const archived = certifiedFastUransPoint();
    archived.converged = false;

    const { draft } = draftResultInterpretationForPoint(
      archived,
      "urans_precalc",
    );

    expect(draft).toMatchObject({
      state: "continuation_required",
      regime: "trending_unresolved",
      cl: null,
      cd: null,
      cm: null,
    });
    expect(draft.continuationReason).toContain("stationary statistics");
  });
});
