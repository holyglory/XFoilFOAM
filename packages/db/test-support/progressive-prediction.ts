import type { ProgressiveLease } from "../src/progressive-campaigns";

export function progressivePredictionFixture(
  lease: Pick<ProgressiveLease, "targetId" | "recipes" | "angles" | "physical">,
): Record<string, unknown> {
  return {
    kind: "prediction",
    method: "neuralfoil",
    cfd_evidence: false,
    prediction_id: "a".repeat(64),
    target_signature: lease.targetId,
    recipe: lease.recipes.neuralfoil,
    alpha: lease.angles,
    condition: {
      target_signature: lease.targetId,
      reynolds: lease.physical.derived.reynolds,
      mach: lease.physical.derived.mach,
      alpha: lease.angles,
      n_crit: lease.physical.transition.nCrit,
      transition_upper: lease.physical.transition.upper,
      transition_lower: lease.physical.transition.lower,
      roughness_height: lease.physical.boundary.sandGrainHeight,
    },
    coefficients: lease.angles.map((alpha) => [
      alpha * 0.1,
      0.01 + 0.0005 * alpha ** 2,
      -0.03,
    ]),
    analysis_confidence: lease.angles.map(() => 0.9),
    uncertainty_calibration: "unvalidated",
    model: {
      neuralfoil: "0.3.3",
      aerosandbox: "4.2.10",
      model_size: "large",
      weights_sha256: "b".repeat(64),
      training_distribution_sha256: "c".repeat(64),
    },
    geometry_provenance: { source: "isolated-test-fixture" },
    geometry_fit: { rms_chord: 0.001, maximum_chord: 0.004 },
  };
}
