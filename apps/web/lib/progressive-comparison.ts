import type { ProgressivePolarSeries } from "@aerodb/core";

export interface ProgressiveComparisonProfile {
  slug: string;
  name: string;
  color: string;
  series: ProgressivePolarSeries[];
}

export function progressiveComparisonConditions(
  profiles: ProgressiveComparisonProfile[],
) {
  const conditions = new Map<
    string,
    {
      key: string;
      re: number;
      mach: number;
      branch: string;
      profiles: Set<string>;
    }
  >();
  for (const profile of profiles) {
    for (const series of profile.series) {
      if (!series.conditionKey) continue;
      const condition = conditions.get(series.conditionKey) ?? {
        key: series.conditionKey,
        re: series.re,
        mach: series.mach,
        branch: series.branch,
        profiles: new Set<string>(),
      };
      condition.profiles.add(profile.slug);
      conditions.set(condition.key, condition);
    }
  }
  return [...conditions.values()]
    .map(({ profiles: available, ...condition }) => ({
      ...condition,
      availableProfiles: available.size,
    }))
    .sort(
      (left, right) =>
        right.availableProfiles - left.availableProfiles ||
        left.mach - right.mach ||
        left.re - right.re ||
        left.key.localeCompare(right.key),
    );
}

export function progressiveComparisonCurve(
  profile: ProgressiveComparisonProfile,
  conditionKey: string,
) {
  const matching = profile.series.filter(
    (series) => series.conditionKey === conditionKey,
  );
  if (matching.length !== 1) return null;
  const series = matching[0];
  const curve =
    series.curves.find((candidate) => candidate.method === "composite") ??
    series.curves.find(
      (candidate) => candidate.method === "openfoam_precise",
    ) ??
    series.curves.find((candidate) => candidate.method === "openfoam_fast") ??
    series.curves.find((candidate) => candidate.method === "neuralfoil");
  if (
    !curve ||
    curve.samples.length < 2 ||
    curve.samples.some(
      (sample, index) =>
        ![sample.alpha, sample.cl, sample.cd, sample.cm].every(
          Number.isFinite,
        ) ||
        sample.cd <= 0 ||
        !Number.isFinite(sample.cl / sample.cd) ||
        (index > 0 && sample.alpha <= curve.samples[index - 1].alpha),
    )
  )
    return null;
  return { series, curve };
}
