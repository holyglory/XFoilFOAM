import { describe, expect, it } from "vitest";

import {
  currentFastGenerationRecoveryState,
  legacyArchiveGapRouteDecision,
  normaliseLegacyUransArchiveGapRecoveryScope,
} from "../src/legacy-urans-archive-gap-recovery";
import { parseLegacyUransArchiveGapRecoveryArgs } from "../src/legacy-urans-archive-gap-recovery-cli";

const RESULT_A = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_A = "22222222-2222-4222-8222-222222222222";

const routable = {
  sourceIsExactFastUrans: true,
  archiveState: "absent" as const,
  targetPhysicalCell: true,
  targetImplementationId: "openfoam-2606",
  hasCurrentFastAwaitingReduction: false,
  hasAcceptedCurrentFast: false,
  hasOpenPrecalcOwner: false,
  withinFreshAttemptBudget: true,
};

describe("legacy URANS archive-gap recovery policy", () => {
  it("MUST-CATCH: routes a genuinely archive-less exact FAST attempt only as a fresh FAST generation", () => {
    expect(legacyArchiveGapRouteDecision(routable)).toBe("fresh_rerun");
  });

  it("MUST-CATCH: never treats a verified GCS archive as permission for a fresh rerun", () => {
    expect(
      legacyArchiveGapRouteDecision({
        ...routable,
        archiveState: "verified_gcs",
      }),
    ).toBe("cancelled");
  });

  it("MUST-CATCH: waits for a local or unverified archive migration instead of rerunning prematurely", () => {
    expect(
      legacyArchiveGapRouteDecision({
        ...routable,
        archiveState: "unverified_or_local",
      }),
    ).toBe("retry");
  });

  it("MUST-CATCH: does not spend a physical run when an exact current-generation FAST result already exists", () => {
    expect(
      legacyArchiveGapRouteDecision({
        ...routable,
        hasAcceptedCurrentFast: true,
      }),
    ).toBe("satisfied");
  });

  it("MUST-CATCH: an archive-less accepted classification cannot suppress the requested repair", () => {
    // A classification by itself is only attempt history. Without a current,
    // authenticated archive and selected archive-certified interpretation it
    // must not be mistaken for a repaired FAST generation.
    expect(
      currentFastGenerationRecoveryState({
        hasCurrentVerifiedGcsArchive: false,
        hasSelectedCurrentArchiveFastInterpretation: false,
      }),
    ).toBeNull();
    expect(
      legacyArchiveGapRouteDecision({
        ...routable,
        hasAcceptedCurrentFast: false,
      }),
    ).toBe("fresh_rerun");
  });

  it("MUST-CATCH: waits for a verified FAST archive's selected reduction instead of declaring it repaired", () => {
    expect(
      currentFastGenerationRecoveryState({
        hasCurrentVerifiedGcsArchive: true,
        hasSelectedCurrentArchiveFastInterpretation: false,
      }),
    ).toBe("awaiting_clean_cycle_reduction");
    expect(
      legacyArchiveGapRouteDecision({
        ...routable,
        hasCurrentFastAwaitingReduction: true,
      }),
    ).toBe("retry");
    expect(
      currentFastGenerationRecoveryState({
        hasCurrentVerifiedGcsArchive: true,
        hasSelectedCurrentArchiveFastInterpretation: true,
      }),
    ).toBe("accepted");
  });

  it("MUST-CATCH: respects the ordinary FAST ownership and physical-attempt budget", () => {
    expect(
      legacyArchiveGapRouteDecision({
        ...routable,
        hasOpenPrecalcOwner: true,
      }),
    ).toBe("retry");
    expect(
      legacyArchiveGapRouteDecision({
        ...routable,
        withinFreshAttemptBudget: false,
      }),
    ).toBe("blocked");
  });

  it("MUST-CATCH: forbids a rerun across a changed physical cell or missing solver identity", () => {
    expect(
      legacyArchiveGapRouteDecision({
        ...routable,
        targetPhysicalCell: false,
      }),
    ).toBe("blocked");
    expect(
      legacyArchiveGapRouteDecision({
        ...routable,
        targetImplementationId: null,
      }),
    ).toBe("blocked");
  });

  it("normalizes only a small explicit planning scope", () => {
    expect(
      normaliseLegacyUransArchiveGapRecoveryScope({
        resultIds: [RESULT_A, RESULT_A],
        resultAttemptIds: [ATTEMPT_A],
        limit: 26,
      }),
    ).toEqual({
      resultIds: [RESULT_A],
      resultAttemptIds: [ATTEMPT_A],
      limit: 26,
    });
    expect(() =>
      normaliseLegacyUransArchiveGapRecoveryScope({
        resultAttemptIds: ["not-an-attempt"],
      }),
    ).toThrow(/UUID/);
  });

  it("MUST-CATCH: requires a read-only plan's exact source attempt ids before execution", () => {
    expect(parseLegacyUransArchiveGapRecoveryArgs([]).execute).toBe(false);
    expect(() =>
      parseLegacyUransArchiveGapRecoveryArgs(["--execute", "--limit", "26"]),
    ).toThrow(/exact --result-attempt-id/);
    expect(
      parseLegacyUransArchiveGapRecoveryArgs([
        "--execute",
        "--result-attempt-id",
        ATTEMPT_A,
        "--created-by",
        "operator:legacy-gcs-gap",
      ]),
    ).toMatchObject({
      execute: true,
      scope: { resultAttemptIds: [ATTEMPT_A] },
    });
  });
});
