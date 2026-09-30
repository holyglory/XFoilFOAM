import type {
  ProgressivePolarEstimate,
  ProgressivePolarFitRequest,
} from "../../engine-client/src/progressive-polar";

export function validatePolarConflictDiagnostics(
  request: ProgressivePolarFitRequest,
  estimate: ProgressivePolarEstimate,
) {
  const probability = request.policy.lineage_conflict_probability;
  const diagnostic = estimate.conflict_diagnostics;
  if (probability == null) {
    if (diagnostic !== undefined)
      throw new Error("Unrequested polar conflict diagnostics");
    return;
  }
  const invalid = () => {
    throw new Error(
      "Polar conflict diagnostics differ from their source or policy",
    );
  };
  const sameNumber = (actual: number, expected: number) =>
    Number.isFinite(actual) &&
    Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected));
  if (
    !Number.isFinite(probability) ||
    probability <= 0 ||
    probability > 0.05 ||
    request.policy.calibration_status !== "unvalidated" ||
    !diagnostic ||
    diagnostic.version !== "conditional-lineage-subspaces-v1" ||
    diagnostic.interpretation !==
      "fixed_gaussian_model_not_physical_validation" ||
    diagnostic.model_family_tail_probability !== probability ||
    !Array.isArray(diagnostic.groups) ||
    diagnostic.groups.length > 128
  )
    return invalid();
  const perTest = probability / (6 * Math.max(1, diagnostic.groups.length));
  if (!sameNumber(diagnostic.per_test_tail_probability, perTest))
    return invalid();
  const cutoff = (dimension: number) =>
    dimension +
    2 * Math.sqrt(dimension * -Math.log(perTest)) -
    2 * Math.log(perTest);
  const seen = new Set<string>();
  const groups = new Set<string>();
  for (const group of diagnostic.groups) {
    const key = JSON.stringify([group.method, group.lineage_id]);
    if (
      groups.has(key) ||
      !Array.isArray(group.observation_ids) ||
      !Array.isArray(group.alpha) ||
      group.window_count !== group.observation_ids.length ||
      group.alpha.length !== group.window_count ||
      group.window_count < 1 ||
      group.window_count > 128 ||
      !Array.isArray(group.coefficients) ||
      group.coefficients.length !== 3
    )
      return invalid();
    groups.add(key);
    for (const [index, observationId] of group.observation_ids.entries()) {
      const contributor = estimate.contributors.find(
        (row) => row.observation_id === observationId,
      );
      const original =
        request.observations.find(
          (row) => row.observation_id === observationId,
        ) ??
        request.histories.find(
          (history) =>
            history.observation.attempt_id === contributor?.attempt_id &&
            history.observation.method === contributor?.method,
        )?.observation;
      if (
        seen.has(observationId) ||
        !contributor ||
        !original?.eligible ||
        original.lineage_id !== group.lineage_id ||
        original.method !== group.method ||
        original.alpha !== group.alpha[index]
      )
        return invalid();
      seen.add(observationId);
    }
    const dimension = new Set(group.alpha).size;
    const contrastDimension = group.window_count - dimension;
    for (const [index, channel] of group.coefficients.entries()) {
      if (
        channel.coefficient !== ["cl", "log_cd", "cm"][index] ||
        channel.mean_dimension !== dimension ||
        channel.contrast_dimension !== contrastDimension ||
        !sameNumber(channel.mean_cutoff, cutoff(dimension)) ||
        (contrastDimension
          ? !sameNumber(channel.contrast_cutoff!, cutoff(contrastDimension))
          : channel.contrast_cutoff !== null) ||
        [
          channel.mean_score,
          channel.contrast_score,
          channel.total_score,
          channel.variance_multiplier,
          channel.shared_variance,
          channel.independent_variance,
        ].some((value) => !Number.isFinite(value) || value < 0) ||
        (!contrastDimension && channel.contrast_score !== 0) ||
        !sameNumber(
          channel.total_score,
          channel.mean_score + channel.contrast_score,
        )
      )
        return invalid();
      const scale = (
        group.method === "openfoam_fast"
          ? request.policy.fast_discrepancy_std
          : request.policy.precise_discrepancy_std
      )[index];
      const sharedVariance =
        channel.mean_score > channel.mean_cutoff
          ? Math.max(0, channel.mean_score / dimension - 1) * scale ** 2
          : 0;
      const independentVariance =
        contrastDimension && channel.contrast_score > channel.contrast_cutoff!
          ? Math.max(0, channel.contrast_score / contrastDimension - 1) *
            scale ** 2
          : 0;
      const multiplier = Math.max(
        0,
        channel.mean_score / channel.mean_cutoff - 1,
        contrastDimension
          ? channel.contrast_score / channel.contrast_cutoff! - 1
          : 0,
      );
      if (
        !sameNumber(channel.shared_variance, sharedVariance) ||
        !sameNumber(channel.independent_variance, independentVariance) ||
        !sameNumber(channel.variance_multiplier, multiplier)
      )
        return invalid();
    }
  }
  if (seen.size !== estimate.contributors.length) return invalid();
}
