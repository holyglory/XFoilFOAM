import { describe, expect, it } from "vitest";

import {
  planPrecalcRecovery,
  precalcRecoveryOutcome,
} from "../src/precalc-recovery-policy";
import { AUTO_PRECALC_CONTINUATION_BUDGET_S } from "../src/urans-quality";

const base = {
  status: "done",
  classificationReasons: ["invalid-clean-cycle-quality"],
  qualityWarnings: [],
  error: null,
  hasRestartableEvidence: true,
  forceSampleCount: 800,
  fieldFrameCount: 80,
};

describe("preliminary URANS recovery policy", () => {
  it("pins one quality-gated exact continuation to eight hours", () => {
    expect(AUTO_PRECALC_CONTINUATION_BUDGET_S).toBe(8 * 60 * 60);
  });

  it("does not spend a physical attempt on infrastructure", () => {
    const plan = planPrecalcRecovery({
      ...base,
      status: "failed",
      failureDisposition: "infrastructure",
    });
    expect(plan).toMatchObject({
      failureType: "infrastructure_interruption",
      action: "retry_infrastructure",
      consumesSolverAttempt: false,
    });
  });

  it("continues only incomplete exact saved evidence", () => {
    const plan = planPrecalcRecovery({
      ...base,
      classificationReasons: ["insufficient-periods"],
      observationProgress: 0.72,
    });
    expect(plan).toMatchObject({
      failureType: "incomplete_observation",
      action: "continue_exact_case",
      consumesSolverAttempt: false,
      evidenceCompleteness: 1,
    });
  });

  it("MUST-CATCH: changes execution after a complete horizon with no clean terminal cycle", () => {
    const plan = planPrecalcRecovery({
      ...base,
      status: "failed",
      classificationReasons: [
        "incomplete-urans-integration",
        "insufficient-periods",
        "non-stationary",
      ],
      observationProgress: 1,
      continuationProgressed: false,
    });
    expect(plan).toMatchObject({
      failureType: "numerical_instability",
      action: "rerun_conservative_numerics",
      consumesSolverAttempt: true,
    });
  });

  it("continues a complete horizon while its terminal clean suffix is forming", () => {
    const plan = planPrecalcRecovery({
      ...base,
      classificationReasons: ["insufficient-clean-cycle-evidence"],
      observationProgress: 1,
      continuationProgressed: true,
    });
    expect(plan).toMatchObject({
      failureType: "incomplete_observation",
      action: "continue_exact_case",
      consumesSolverAttempt: false,
    });
  });

  it("routes a retrospective aperiodic candidate to the new contract", () => {
    const plan = planPrecalcRecovery({ ...base, statisticalMeanScore: 0.83 });
    expect(plan).toMatchObject({
      failureType: "stationary_aperiodic_candidate",
      action: "rerun_statistical_mean_contract",
      statisticalMeanScore: 0.83,
    });
    expect(precalcRecoveryOutcome(plan, false)).toBe(
      "aperiodic_contract_retry_pending",
    );
  });

  it("routes a complete statistical certificate before generic continuation markers", () => {
    const plan = planPrecalcRecovery({
      ...base,
      classificationReasons: ["insufficient-periods"],
      observationProgress: 0.8,
      statisticalMeanScore: 0.9,
    });
    expect(plan).toMatchObject({
      failureType: "stationary_aperiodic_candidate",
      action: "rerun_statistical_mean_contract",
      consumesSolverAttempt: true,
    });
  });

  it("changes execution for numerical contamination", () => {
    const plan = planPrecalcRecovery({
      ...base,
      qualityWarnings: ["terminal Cl high-frequency burst"],
    });
    expect(plan).toMatchObject({
      failureType: "numerical_instability",
      action: "rerun_conservative_numerics",
      consumesSolverAttempt: true,
    });
  });

  it("repairs media without rerunning usable coefficients", () => {
    const plan = planPrecalcRecovery({
      ...base,
      classificationReasons: ["missing-urans-video"],
    });
    expect(plan).toMatchObject({
      failureType: "missing_derived_media",
      action: "repair_media",
      consumesSolverAttempt: false,
    });
  });

  it("responds monotonically to continuous evidence features", () => {
    const low = planPrecalcRecovery({
      ...base,
      forceSampleCount: 100,
      fieldFrameCount: 10,
      statisticalMeanScore: 0.2,
    });
    const high = planPrecalcRecovery({
      ...base,
      forceSampleCount: 300,
      fieldFrameCount: 30,
      statisticalMeanScore: 0.8,
    });
    expect(high.evidenceCompleteness).toBeGreaterThan(low.evidenceCompleteness);
    expect(high.statisticalMeanScore).toBeGreaterThan(low.statisticalMeanScore);
  });
});
