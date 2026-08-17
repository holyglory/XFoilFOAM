import { describe, expect, it } from "vitest";

import {
  archiveRecoveryAcceptedCandidateMatchesTarget,
  archiveRecoveryCorrectiveTailPeriods,
  archiveRecoveryFullRouteMode,
  archiveRecoveryPhysicalCellMatches,
  archiveRecoveryRemediationSourceRevision,
  archiveRecoveryRouteMode,
  archiveRecoverySourceGenerationState,
  archiveRecoveryVerifyQueueTargetReceipt,
} from "../src/archive-interpretation-recovery";

describe("archive interpretation recovery routing policy", () => {
  it("requires an exact promoted source revision before any extra physical recovery attempt", () => {
    const previous = process.env.AIRFOILFOAM_RECOVERY_SOURCE_REVISION;
    try {
      delete process.env.AIRFOILFOAM_RECOVERY_SOURCE_REVISION;
      expect(archiveRecoveryRemediationSourceRevision()).toBeNull();
      process.env.AIRFOILFOAM_RECOVERY_SOURCE_REVISION = "not-a-revision";
      expect(archiveRecoveryRemediationSourceRevision()).toBeNull();
      process.env.AIRFOILFOAM_RECOVERY_SOURCE_REVISION =
        "15872f4cb7fd204917a38606f87e78ee4de04f3f";
      expect(archiveRecoveryRemediationSourceRevision()).toBe(
        "15872f4cb7fd204917a38606f87e78ee4de04f3f",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.AIRFOILFOAM_RECOVERY_SOURCE_REVISION;
      } else {
        process.env.AIRFOILFOAM_RECOVERY_SOURCE_REVISION = previous;
      }
    }
  });

  it("MUST-CATCH: routes a proven FAST archive only as an exact continuation", () => {
    expect(
      archiveRecoveryRouteMode({
        fidelity: "urans_precalc",
        exactRestartProof: true,
      }),
    ).toBe("continue_exact_case");
  });

  it("MUST-CATCH: routes an unproven FAST archive as a fresh generation, never a continuation", () => {
    expect(
      archiveRecoveryRouteMode({
        fidelity: "urans_precalc",
        exactRestartProof: false,
      }),
    ).toBe("fresh_rerun");
  });

  it("MUST-CATCH: immutable-provenance rerun_required stays fresh even when the old checkpoint is restartable", () => {
    expect(
      archiveRecoveryRouteMode({
        fidelity: "urans_precalc",
        exactRestartProof: true,
        forceFreshRerun: true,
      }),
    ).toBe("fresh_rerun");
  });

  it("MUST-CATCH: makes FULL recovery wait for accepted FAST rather than directly running FINAL", () => {
    expect(
      archiveRecoveryRouteMode({
        fidelity: "urans_full",
        exactRestartProof: true,
        hasAcceptedPrecalcBaseline: false,
      }),
    ).toBe("wait_for_precalc");
    expect(
      archiveRecoveryRouteMode({
        fidelity: "urans_full",
        exactRestartProof: true,
        hasAcceptedPrecalcBaseline: true,
      }),
    ).toBe("continue_exact_case");
  });

  it("routes an unproven FULL archive through ordinary fresh FULL coverage", () => {
    expect(
      archiveRecoveryRouteMode({
        fidelity: "urans_full",
        exactRestartProof: false,
        hasAcceptedPrecalcBaseline: true,
      }),
    ).toBe("fresh_rerun");
  });

  it("accepts only the archive reducer's bounded one-to-three-period instruction", () => {
    expect(archiveRecoveryCorrectiveTailPeriods(null)).toBeNull();
    expect(archiveRecoveryCorrectiveTailPeriods(1)).toBe(1);
    expect(archiveRecoveryCorrectiveTailPeriods(3)).toBe(3);
    for (const invalid of [0, 4, 1.5, true, "3"]) {
      expect(() => archiveRecoveryCorrectiveTailPeriods(invalid)).toThrow(
        /integer from 1 through 3/,
      );
    }
  });

  it("MUST-CATCH: an accepted exact FINAL always satisfies archive recovery instead of creating another FULL owner", () => {
    expect(
      archiveRecoveryFullRouteMode({
        exactRestartProof: true,
        hasAcceptedFull: true,
        hasActiveFullRequest: true,
        hasTargetRequest: true,
      }),
    ).toBe("satisfied");
    expect(
      archiveRecoveryFullRouteMode({
        exactRestartProof: false,
        hasAcceptedFull: true,
        hasActiveFullRequest: false,
        hasTargetRequest: false,
      }),
    ).toBe("satisfied");
  });

  it("never duplicates an existing FULL owner while an archive action waits for its accepted FAST baseline", () => {
    expect(
      archiveRecoveryFullRouteMode({
        exactRestartProof: true,
        hasAcceptedFull: false,
        hasActiveFullRequest: false,
        hasTargetRequest: true,
      }),
    ).toBe("wait_for_precalc");
    expect(
      archiveRecoveryFullRouteMode({
        exactRestartProof: false,
        hasAcceptedFull: false,
        hasActiveFullRequest: true,
        hasTargetRequest: false,
      }),
    ).toBe("wait_for_precalc");
    expect(
      archiveRecoveryFullRouteMode({
        exactRestartProof: true,
        hasAcceptedFull: false,
        hasActiveFullRequest: false,
        hasTargetRequest: false,
      }),
    ).toBe("wait_for_precalc");
    expect(
      archiveRecoveryFullRouteMode({
        exactRestartProof: false,
        hasAcceptedFull: false,
        hasActiveFullRequest: false,
        hasTargetRequest: false,
      }),
    ).toBe("fresh_rerun");
  });

  it("MUST-CATCH: attaching a FINAL continuation to verify clears its temporary request receipt", () => {
    expect(archiveRecoveryVerifyQueueTargetReceipt("verify-queue-a")).toEqual({
      targetUransRequestId: null,
      targetVerifyQueueId: "verify-queue-a",
    });
    expect(() => archiveRecoveryVerifyQueueTargetReceipt("")).toThrow(
      /stable queue id/,
    );
  });

  it("MUST-CATCH: FINAL archive continuation is fenced to one exact physical cell, including its boundary condition", () => {
    const source = {
      sourceAirfoilId: "airfoil-a",
      sourceRevisionId: "revision-a",
      sourceBcId: "bc-a",
      sourceAoaDeg: 12,
    };
    expect(
      archiveRecoveryPhysicalCellMatches({
        ...source,
        targetAirfoilId: "airfoil-a",
        targetRevisionId: "revision-a",
        targetBcId: "bc-a",
        targetAoaDeg: 12,
      }),
    ).toBe(true);
    expect(
      archiveRecoveryPhysicalCellMatches({
        ...source,
        targetAirfoilId: "airfoil-other",
        targetRevisionId: "revision-a",
        targetBcId: "bc-a",
        targetAoaDeg: 12,
      }),
    ).toBe(false);
    expect(
      archiveRecoveryPhysicalCellMatches({
        ...source,
        targetAirfoilId: "airfoil-a",
        targetRevisionId: "revision-other",
        targetBcId: "bc-a",
        targetAoaDeg: 12,
      }),
    ).toBe(false);
    expect(
      archiveRecoveryPhysicalCellMatches({
        ...source,
        targetAirfoilId: "airfoil-a",
        targetRevisionId: "revision-a",
        targetBcId: "bc-other",
        targetAoaDeg: 12,
      }),
    ).toBe(false);
    expect(
      archiveRecoveryPhysicalCellMatches({
        ...source,
        targetAirfoilId: "airfoil-a",
        targetRevisionId: "revision-a",
        targetBcId: "bc-a",
        targetAoaDeg: 12.000_001,
      }),
    ).toBe(false);
  });

  it("MUST-CATCH: a later accepted result cannot satisfy archive recovery across an OpenFOAM cutover or multi-BC job", () => {
    const exact = {
      targetImplementationId: "openfoam-2606",
      targetBcId: "bc-a",
      candidateAttemptImplementationId: "openfoam-2606",
      candidateJobImplementationId: "openfoam-2606",
      candidateJobBoundaryConditionIds: ["bc-a"],
    };
    expect(archiveRecoveryAcceptedCandidateMatchesTarget(exact)).toBe(true);
    expect(
      archiveRecoveryAcceptedCandidateMatchesTarget({
        ...exact,
        candidateAttemptImplementationId: "openfoam-2406",
        candidateJobImplementationId: "openfoam-2406",
      }),
    ).toBe(false);
    expect(
      archiveRecoveryAcceptedCandidateMatchesTarget({
        ...exact,
        candidateJobBoundaryConditionIds: ["bc-a", "bc-b"],
      }),
    ).toBe(false);
    expect(
      archiveRecoveryAcceptedCandidateMatchesTarget({
        ...exact,
        candidateJobBoundaryConditionIds: ["bc-b"],
      }),
    ).toBe(false);
  });

  it("MUST-CATCH: released evidence never retains recovery scheduling authority, while an exact PRECALC child may remain behind its live RANS parent", () => {
    expect(
      archiveRecoverySourceGenerationState({
        currentResultAttemptId: null,
        sourceResultAttemptId: "attempt-a",
      }),
    ).toBe("released_historical");
    expect(
      archiveRecoverySourceGenerationState({
        currentResultAttemptId: null,
        sourceResultAttemptId: "attempt-a",
        sourceFidelity: "urans_precalc",
        hasExactLivePrecalcPublicationOwner: true,
      }),
    ).toBe("live_exact_precalc_owner");
    expect(
      archiveRecoverySourceGenerationState({
        currentResultAttemptId: "attempt-b",
        sourceResultAttemptId: "attempt-a",
        sourceFidelity: "urans_precalc",
        currentFidelity: "rans",
        hasExactPrecalcRansLineage: false,
      }),
    ).toBe("superseded");
    expect(
      archiveRecoverySourceGenerationState({
        currentResultAttemptId: "rans-parent",
        sourceResultAttemptId: "precalc-child",
        sourceFidelity: "urans_precalc",
        currentFidelity: "rans",
        hasExactPrecalcRansLineage: true,
      }),
    ).toBe("live_pinned_precalc_child");
    expect(
      archiveRecoverySourceGenerationState({
        currentResultAttemptId: "another-urans",
        sourceResultAttemptId: "precalc-child",
        sourceFidelity: "urans_precalc",
        currentFidelity: "urans_precalc",
        hasExactPrecalcRansLineage: true,
      }),
    ).toBe("superseded");
    expect(
      archiveRecoverySourceGenerationState({
        currentResultAttemptId: "attempt-a",
        sourceResultAttemptId: "attempt-a",
      }),
    ).toBe("live_exact");
  });
});
