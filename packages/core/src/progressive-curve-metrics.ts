export interface ProgressiveCurveSample {
  alpha: number;
  cl: number;
  cd: number;
  cm: number;
}

export interface ProgressiveCurveMetrics {
  alphaMinimum: number;
  alphaMaximum: number;
  liftToDragMaximum: number | null;
  alphaAtLiftToDragMaximum: number | null;
  dragMinimum: number;
  liftMaximum: number;
  alphaAtLiftMaximum: number;
  dragAtZeroLift: number | null;
  momentAtZeroAlpha: number | null;
}

export function progressiveCurveMetrics(
  samples: readonly ProgressiveCurveSample[],
): ProgressiveCurveMetrics | null {
  if (
    samples.length < 2 ||
    samples.some(
      (sample, index) =>
        ![sample.alpha, sample.cl, sample.cd, sample.cm].every(
          Number.isFinite,
        ) ||
        sample.cd <= 0 ||
        (index > 0 && sample.alpha <= samples[index - 1].alpha),
    )
  )
    return null;
  let liftToDragMaximum: number | null = null;
  let alphaAtLiftToDragMaximum: number | null = null;
  let dragMinimum = samples[0].cd;
  let liftMaximum = samples[0].cl;
  let alphaAtLiftMaximum = samples[0].alpha;
  let momentAtZeroAlpha: number | null = null;
  const zeroLiftDrag: number[] = [];
  for (const [index, sample] of samples.entries()) {
    const ratio = sample.cl / sample.cd;
    if (
      sample.cl > 0 &&
      Number.isFinite(ratio) &&
      (liftToDragMaximum === null || ratio > liftToDragMaximum)
    ) {
      liftToDragMaximum = ratio;
      alphaAtLiftToDragMaximum = sample.alpha;
    }
    dragMinimum = Math.min(dragMinimum, sample.cd);
    if (sample.cl > liftMaximum) {
      liftMaximum = sample.cl;
      alphaAtLiftMaximum = sample.alpha;
    }
    if (sample.alpha === 0) momentAtZeroAlpha = sample.cm;
    if (sample.cl === 0) zeroLiftDrag.push(sample.cd);
    if (index === 0) continue;
    const previous = samples[index - 1];
    if (previous.alpha < 0 && sample.alpha > 0) {
      const fraction = -previous.alpha / (sample.alpha - previous.alpha);
      momentAtZeroAlpha = previous.cm * (1 - fraction) + sample.cm * fraction;
    }
    if (
      (previous.cl < 0 && sample.cl > 0) ||
      (previous.cl > 0 && sample.cl < 0)
    ) {
      const fraction = -previous.cl / (sample.cl - previous.cl);
      zeroLiftDrag.push(previous.cd * (1 - fraction) + sample.cd * fraction);
    }
  }
  return {
    alphaMinimum: samples[0].alpha,
    alphaMaximum: samples.at(-1)!.alpha,
    liftToDragMaximum,
    alphaAtLiftToDragMaximum,
    dragMinimum,
    liftMaximum,
    alphaAtLiftMaximum,
    dragAtZeroLift: zeroLiftDrag.length === 1 ? zeroLiftDrag[0] : null,
    momentAtZeroAlpha,
  };
}
