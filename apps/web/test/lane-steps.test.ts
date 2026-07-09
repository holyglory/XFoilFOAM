/**
 * collapseLaneSteps — prod-shaped recall fixture: the clarky ld_max lane
 * (2026-07-09) carried 21 steps of which iterations 5–16 were TWELVE
 * identical 7.67° 'superseded' rows (one per best-fit refresh) and 19–20
 * a further same-α pair. The display must collapse those runs while never
 * merging solved steps, distinct angles, or non-superseded outcomes.
 */
import { describe, expect, it } from "vitest";

import { collapseLaneSteps } from "../lib/lane-steps";

const step = (iteration: number, predictedAlpha: number, outcome: string, solvedResultId: string | null = null) => ({
  iteration,
  predictedAlpha,
  outcome,
  solvedResultId,
});

describe("collapseLaneSteps", () => {
  it("collapses the prod-shaped 21-step lane to 9 readable rows", () => {
    const steps = [
      step(1, -15, "solved", "r1"),
      step(2, 5, "solved", "r2"),
      step(3, 6.63, "superseded"),
      step(4, 7.46, "superseded"),
      ...Array.from({ length: 12 }, (_, i) => step(5 + i, 7.67, "superseded")),
      step(17, 7.71, "superseded"),
      step(18, 6.8, "superseded"),
      step(19, 6.68, "superseded"),
      step(20, 6.68, "superseded"),
      step(21, 6.67, "predicted"),
    ];
    const rows = collapseLaneSteps(steps);
    expect(rows.map((r) => [r.firstIteration, r.step.iteration, r.step.predictedAlpha, r.repeats])).toEqual([
      [1, 1, -15, 1],
      [2, 2, 5, 1],
      [3, 3, 6.63, 1],
      [4, 4, 7.46, 1],
      [5, 16, 7.67, 12],
      [17, 17, 7.71, 1],
      [18, 18, 6.8, 1],
      [19, 20, 6.68, 2],
      [21, 21, 6.67, 1],
    ]);
  });

  it("never merges solved steps, distinct angles, or non-superseded outcomes", () => {
    // two solved at the same α (re-solve after release) stay separate
    expect(collapseLaneSteps([step(1, 5, "solved", "a"), step(2, 5, "solved", "b")])).toHaveLength(2);
    // superseded at DIFFERENT α stay separate
    expect(collapseLaneSteps([step(1, 5, "superseded"), step(2, 5.2, "superseded")])).toHaveLength(2);
    // superseded followed by predicted at same α stays separate
    expect(collapseLaneSteps([step(1, 5, "superseded"), step(2, 5, "predicted")])).toHaveLength(2);
    // a superseded step that carries a solved result is never absorbed
    expect(collapseLaneSteps([step(1, 5, "superseded"), step(2, 5, "superseded", "r")])).toHaveLength(2);
  });

  it("keeps empty and single-step lanes untouched", () => {
    expect(collapseLaneSteps([])).toEqual([]);
    const single = collapseLaneSteps([step(1, 3.2, "predicted")]);
    expect(single).toHaveLength(1);
    expect(single[0].repeats).toBe(1);
  });
});
