import type { ProgressivePolarSeries } from "@aerodb/core";

export function progressiveRefinementProof(
  series: Pick<ProgressivePolarSeries, "curves" | "explanation">,
  evidenceAngles: ReadonlyMap<string, number>,
) {
  const contributors = (series.explanation.contributors ?? []).filter(
    (contributor) =>
      Number.isFinite(evidenceAngles.get(contributor.attemptId)) &&
      !(series.explanation.exclusions ?? []).some(
        (excluded) => excluded.observationId === contributor.observationId,
      ),
  );
  const contributorAttemptIds = [
    ...new Set(contributors.map((row) => row.attemptId)),
  ];
  const distinctCfdAngles = new Set(
    contributorAttemptIds.map((attemptId) => evidenceAngles.get(attemptId)),
  ).size;
  const baseline = series.curves.find((curve) => curve.method === "neuralfoil");
  const composite = series.curves.find((curve) => curve.method === "composite");
  const baselineByAngle = new Map(
    baseline?.samples.map((sample) => [sample.alpha, sample]),
  );
  const compatible = Boolean(
    baseline &&
    composite &&
    baseline.samples.length === composite.samples.length &&
    composite.samples.every(
      (sample) =>
        baselineByAngle.has(sample.alpha) &&
        [sample.cl, sample.cd, sample.cm].every(Number.isFinite),
    ),
  );
  const changedCoefficients =
    compatible &&
    composite!.samples.some((sample) => {
      const prior = baselineByAngle.get(sample.alpha)!;
      return (["cl", "cd", "cm"] as const).some(
        (channel) =>
          Number.isFinite(prior[channel]) &&
          Math.abs(sample[channel] - prior[channel]) > 1e-12,
      );
    });
  return {
    contributorAttemptIds,
    distinctCfdAngles,
    changedCoefficients,
    refined: distinctCfdAngles >= 2 && changedCoefficients,
  };
}
