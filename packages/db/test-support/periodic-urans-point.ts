import type { FrameTrack, PolarPoint } from "../../engine-client/src";

export function periodicPoint(
  alpha: number,
  cycles: number,
  certified: boolean,
): PolarPoint {
  const period = 0.02,
    cl = 0.81,
    cd = 0.031,
    cm = -0.09;
  const samples = (per: number) =>
    Array.from({ length: cycles * per }, (_, i) => {
      const phase = Math.sin((2 * Math.PI * (i % per)) / per);
      return {
        i,
        t: (i * period) / per,
        cl: cl + 0.014 * phase,
        cd: cd + 0.001 * phase,
        cm: cm + 0.003 * phase,
      };
    });
  const forces = samples(80),
    frames = samples(24);
  const stats = (mean: number, amplitude: number) => ({
    mean,
    std: amplitude / Math.sqrt(2),
    min: mean - amplitude,
    max: mean + amplitude,
  });
  const frameTrack: FrameTrack = {
    period_s: period,
    periods_retained: cycles,
    stationary: certified,
    drift_frac: 0,
    window: { t_start: 0, t_end: cycles * period },
    stats: { cl: stats(cl, 0.014), cd: stats(cd, 0.001), cm: stats(cm, 0.003) },
    fields: ["pressure"],
    frames,
    image_pattern: "frame-{i}.png",
  };
  return {
    aoa_deg: alpha,
    case_slug: `periodic-${alpha}`,
    cl,
    cd,
    cm,
    cl_cd: cl / cd,
    unsteady: true,
    converged: certified,
    first_order_fallback: false,
    images: {},
    solver_active_seconds: 15,
    frame_track: frameTrack,
    force_history: {
      t: forces.map((x) => x.t),
      cl: forces.map((x) => x.cl),
      cd: forces.map((x) => x.cd),
      cm: forces.map((x) => x.cm),
      window_start: 0,
      window_end: cycles * period,
      period_s: period,
      retained_cycles: cycles,
      samples: forces.length,
      source_start_time: 0,
    },
    urans_cycle_certificate: {
      reducer_version: "clean-cycle-v3",
      period_s: period,
      phase_samples: 96,
      required_clean_cycles: cycles,
      terminal_clean_cycles: certified ? cycles : 0,
      selected_cycle_start_index: certified ? 0 : null,
      certified,
      cadence_adjusted: false,
      cycles: Array.from({ length: cycles }, (_, index) => ({
        index,
        t_start: index * period,
        t_end: (index + 1) * period,
        coefficient_samples: 80,
        field_frames: 24,
        phase_max_gap: 1 / 24,
        phase_shift_bins: 0,
        cl_mean: cl,
        cd_mean: cd,
        cm_mean: cm,
        cl_shape_error: 0.01,
        cd_shape_error: 0.01,
        cm_shape_error: 0.01,
        cl_amplitude_deviation: 0.01,
        cd_amplitude_deviation: 0.01,
        cm_amplitude_deviation: 0.01,
        cl_high_frequency: 0.01,
        cd_high_frequency: 0.01,
        cm_high_frequency: 0.01,
        disposition: certified
          ? ("selected" as const)
          : ("settling_outlier" as const),
        reasons: certified ? [] : ["shape_drift"],
      })),
    },
  };
}
