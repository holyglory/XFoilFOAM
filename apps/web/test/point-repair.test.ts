import { describe, expect, it } from "vitest";

import type { PointStoryPayload } from "../lib/point-history";
import { pointRepairEligibility } from "../lib/point-repair";

const correctionSetup = {
  mesh: {
    mesher: "blockmesh-cgrid",
    farfieldRadiusChords: 15,
    wakeLengthChords: 12,
    nSurface: 130,
    nRadial: 80,
    nWake: 60,
    targetYPlus: 1,
    spanChords: 0.1,
  },
  solver: {
    turbulenceModel: "kOmegaSST",
    nIterations: 3000,
    convergenceTolerance: 0.00001,
    momentumScheme: "linearUpwind",
    transientCycles: 10,
    transientDiscardFraction: 0.4,
    transientMaxCourant: 4,
  },
};

function story(point: Partial<PointStoryPayload["point"]>): PointStoryPayload {
  return {
    point: {
      status: "done",
      regime: "urans",
      fidelity: "urans_precalc",
      workDisposition: "blocked",
      classification: {
        state: "rejected",
        reasons: ["incomplete-averaging-window"],
        confidence: 1,
        classifierVersion: "test",
      },
      reviewBucket: "needs_review",
      continuable: false,
      continuationResultAttemptId: null,
      resultAttemptId: "attempt-id",
      correctionSetup,
      error: null,
      ...point,
    } as PointStoryPayload["point"],
    attempts: [],
    interruptions: [],
    corrections: [],
    closure: null,
  };
}

describe("point repair eligibility", () => {
  it("MUST-CATCH: exposes continuation only when the server certifies the exact saved attempt", () => {
    expect(
      pointRepairEligibility(
        story({
          continuable: true,
          continuationResultAttemptId: "restartable-attempt",
        }),
      ),
    ).toMatchObject({
      continueEligible: true,
      requeueEligible: false,
      correctionEligible: true,
    });

    expect(
      pointRepairEligibility(
        story({
          continuable: true,
          continuationResultAttemptId: null,
        }),
      ).continueEligible,
    ).toBe(false);
  });

  it("keeps rejected no-checkpoint evidence repairable through requeue and fresh recalculation", () => {
    expect(pointRepairEligibility(story({}))).toMatchObject({
      retryEligible: false,
      continueEligible: false,
      requeueRejectedEligible: true,
      requeueEligible: true,
      correctionEligible: true,
    });
  });

  it("MUST-CATCH: lets an exhausted campaign stage recalculate from its blocked retained source", () => {
    expect(
      pointRepairEligibility(
        story({
          status: "done",
          regime: "rans",
          fidelity: "rans",
          classification: {
            state: "needs_urans",
            reasons: ["missing-rans-hold-certificate"],
            confidence: 0.98,
            classifierVersion: "test",
          },
          reviewBucket: null,
          workDisposition: "blocked",
        }),
      ),
    ).toMatchObject({
      retryEligible: false,
      continueEligible: false,
      requeueEligible: false,
      correctionEligible: true,
    });
  });

  it("does not offer ordinary retry for a deterministic mesh failure", () => {
    expect(
      pointRepairEligibility(
        story({
          status: "failed",
          regime: "rans",
          fidelity: "rans",
          workDisposition: null,
          classification: null,
          reviewBucket: null,
          error:
            "mesh degenerate at this fidelity tier; max non-orthogonality exceeded",
        }),
      ),
    ).toMatchObject({
      retryEligible: false,
      requeueEligible: false,
      correctionEligible: true,
    });
  });
});
