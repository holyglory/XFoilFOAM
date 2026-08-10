import { describe, expect, it } from "vitest";

import {
  archiveRecoveryAcceptedCandidateMatchesTarget,
  archiveRecoveryCorrectiveTailPeriods,
  archiveRecoveryFullRouteMode,
  archiveRecoveryPhysicalCellMatches,
  archiveRecoveryRouteMode,
  archiveRecoveryVerifyQueueTargetReceipt,
} from "../src/archive-interpretation-recovery";

describe("archive interpretation recovery routing policy", () => {
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
});
