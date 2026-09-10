import type { ProgressivePolarSeries } from "@aerodb/core";

export function progressiveUransHistoryProof(
  contributorIds: readonly string[],
  histories: unknown,
  evidence: ReadonlyMap<
    string,
    { alpha: number; regime: string; converged: boolean | null }
  >,
  minimumSamples: number,
) {
  const retained = new Map<
    string,
    {
      attemptId: string;
      alpha: number;
      samples: number;
      artifactSha256: string;
      converged: boolean | null;
    }
  >();
  if (
    Array.isArray(histories) &&
    Number.isSafeInteger(minimumSamples) &&
    minimumSamples >= 2
  ) {
    for (const history of histories) {
      const observation = history?.observation;
      const source = evidence.get(observation?.attempt_id);
      if (
        history?.coordinate_kind !== "physical_time" ||
        !source ||
        source.regime !== "urans" ||
        !Number.isFinite(source.alpha) ||
        observation?.alpha !== source.alpha ||
        observation?.eligible !== true ||
        !contributorIds.includes(observation.attempt_id) ||
        !Number.isSafeInteger(history.sample_count) ||
        history.sample_count < minimumSamples ||
        typeof history.artifact_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(history.artifact_sha256)
      )
        continue;
      retained.set(observation.attempt_id, {
        attemptId: observation.attempt_id,
        alpha: source.alpha,
        samples: history.sample_count,
        artifactSha256: history.artifact_sha256,
        converged: source.converged,
      });
    }
  }
  const sources = [...retained.values()];
  const distinctAngles = new Set(sources.map((source) => source.alpha)).size;
  return {
    sources,
    distinctAngles,
    unconvergedHistories: sources.filter((source) => source.converged === false)
      .length,
    joint: distinctAngles >= 2,
  };
}

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
