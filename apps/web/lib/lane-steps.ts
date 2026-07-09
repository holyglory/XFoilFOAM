/** Lane-iteration display helpers (RefinementBoard). */

export interface LaneStepLike {
  iteration: number;
  predictedAlpha: number;
  outcome: string;
  solvedResultId?: string | null;
}

export interface CollapsedLaneStep<T extends LaneStepLike> {
  /** the LAST step of the collapsed run (its iteration/fit witnessed latest) */
  step: T;
  /** first iteration of the run (== step.iteration when nothing collapsed) */
  firstIteration: number;
  /** how many identical superseded steps this row represents */
  repeats: number;
}

/**
 * Collapse consecutive UNSOLVED 'superseded' steps at the same predicted α
 * into one display row. Historical artifact: the lane tick used to append a
 * step per best-fit refresh even when the predicted α did not move, so
 * tier-2 ingest flooded lanes with identical rows that were later swept to
 * 'superseded' in one go (prod 2026-07-09: twelve 7.67° rows on one clarky
 * ld_max lane). The tick no longer appends those; this keeps old lanes
 * readable without rewriting append-only step evidence.
 */
export function collapseLaneSteps<T extends LaneStepLike>(steps: T[]): CollapsedLaneStep<T>[] {
  const out: CollapsedLaneStep<T>[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.step.outcome === "superseded" &&
      step.outcome === "superseded" &&
      !prev.step.solvedResultId &&
      !step.solvedResultId &&
      Math.abs(prev.step.predictedAlpha - step.predictedAlpha) < 1e-9
    ) {
      out[out.length - 1] = { step, firstIteration: prev.firstIteration, repeats: prev.repeats + 1 };
    } else {
      out.push({ step, firstIteration: step.iteration, repeats: 1 });
    }
  }
  return out;
}
