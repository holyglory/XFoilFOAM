import { describe, expect, it } from "vitest";

import {
  classifyPolarEvidence,
  type PolarEvidencePoint,
} from "../src/polar-fit";

const INTERPRETATION_ID = "11111111-1111-4111-8111-111111111111";
const ARCHIVE_ID = "22222222-2222-4222-8222-222222222222";

function staleAttempt(): PolarEvidencePoint {
  return {
    a: 12,
    cl: 0.88,
    cd: 0.071,
    cm: -0.11,
    status: "done",
    source: "solved",
    regime: "urans",
    fidelity: "urans_precalc",
    // Historical unsteady summary convergence is intentionally not the
    // archive reducer's acceptance criterion; its terminal clean cycles are.
    converged: false,
    stalled: true,
    unsteady: true,
    hasForceHistory: false,
    hasVideo: true,
    qualityWarnings: ["urans-continuation-required"],
    frameTrack: { stationary: false, periods_retained: 1 },
    uransCycleCertificate: null,
  };
}

function currentArchiveInterpretation() {
  return {
    id: INTERPRETATION_ID,
    source: "archive_backfill",
    state: "accepted",
    regime: "periodic",
    sourceArchiveId: ARCHIVE_ID,
    inputEvidenceSignature: "a".repeat(64),
  };
}

describe("selected archive interpretation projection", () => {
  it("uses a current accepted archive reduction rather than stale attempt summaries", () => {
    const classified = classifyPolarEvidence([
      {
        ...staleAttempt(),
        selectedArchiveInterpretation: currentArchiveInterpretation(),
      },
    ]);

    expect(classified.classifications[0]).toMatchObject({
      state: "accepted",
      reasons: [],
    });
  });

  it("fails closed if the archive-selection proof is malformed", () => {
    const classified = classifyPolarEvidence([
      {
        ...staleAttempt(),
        selectedArchiveInterpretation: {
          ...currentArchiveInterpretation(),
          sourceArchiveId: "not-an-archive-id",
        },
      },
    ]);

    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toEqual(
      expect.arrayContaining([
        "missing-force-history",
        "missing-clean-cycle-certificate",
      ]),
    );
  });

  it("does not fabricate a stored video when archive reduction is selected", () => {
    const classified = classifyPolarEvidence([
      {
        ...staleAttempt(),
        hasVideo: false,
        selectedArchiveInterpretation: currentArchiveInterpretation(),
      },
    ]);

    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toEqual([
      "missing-urans-video",
    ]);
  });
});
