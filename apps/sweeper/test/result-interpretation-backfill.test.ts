import { describe, expect, it, vi } from "vitest";

import {
  archiveBackfillFidelity,
  archiveBackfillRecoveryProgress,
  archiveBackfillRecoveryHandoff,
  ARCHIVE_INTERPRETATION_CLAIMABLE_RUN_STATES,
  archiveInterpretationBackfillSummaryState,
  archiveInterpretationBackfillRunMode,
  createHistoricalReleasedArchiveAuditRun,
  archiveRecoveryMayAdoptCorrectiveTail,
  archiveRecommendedAdditionalPeriods,
  archivePointerForBackfill,
  archiveReducerNeedsRecoveryHandoff,
  normaliseArchiveInterpretationBackfillScope,
  runArchiveInterpretationBackfill,
} from "../src/result-interpretation-backfill";
import {
  HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT,
  RESULT_INTERPRETATION_REDUCER_BUILD_ID,
  RESULT_INTERPRETATION_REDUCER_POLICY,
} from "../src/result-interpretations";
import { parseArchiveInterpretationBackfillArgs } from "../src/result-interpretation-backfill-cli";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function gcsBlob(overrides: Record<string, unknown> = {}) {
  return {
    backend: "gcs" as const,
    bucket: "airfoils-pro-storage-bucket",
    objectKey: `solver-evidence/v1/sha256/aa/${"a".repeat(64)}.tar.zst`,
    generation: "18446744073709551615",
    compression: "zstd" as const,
    mimeType: "application/zstd",
    sha256: "a".repeat(64),
    byteSize: 12_345,
    crc32c: "AAAAAA==",
    uncompressedTarSha256: "b".repeat(64),
    uncompressedTarByteSize: 54_321,
    metadata: { archiveFormat: "tar+zstd", zstdLevel: 10 },
    verifiedAt: new Date("2026-07-28T00:00:00.000Z"),
    ...overrides,
  };
}

describe("archive clean-cycle interpretation backfill", () => {
  it("MUST-CATCH: historical released-evidence audits cannot create new runtime work", async () => {
    await expect(
      createHistoricalReleasedArchiveAuditRun({
        db: {} as never,
        exactSource: {
          resultId: UUID_A,
          resultAttemptId: UUID_B,
          sourceArchiveId: "33333333-3333-4333-8333-333333333333",
        },
      }),
    ).rejects.toThrow(/audits are disabled/i);
  });

  it("MUST-CATCH: a persisted historical audit cannot execute reducer work", async () => {
    const reduceRemoteEvidenceCleanCycles = vi.fn();
    const historicalRun = {
      id: UUID_A,
      state: "running",
      reducerVersionId: UUID_B,
      scope: {
        contract: HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT,
        canonicalSelection: "forbidden",
        physicalRecovery: "record-only",
        campaignMutation: "forbidden",
        rawEvidenceImmutable: true,
        exactSource: {
          resultId: UUID_A,
          resultAttemptId: UUID_B,
          sourceArchiveId: "33333333-3333-4333-8333-333333333333",
        },
      },
    };
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [historicalRun],
          }),
        }),
      }),
    };

    await expect(
      runArchiveInterpretationBackfill({
        db: db as never,
        engine: { reduceRemoteEvidenceCleanCycles } as never,
        runId: UUID_A,
        historicalAuditExactSource: historicalRun.scope.exactSource,
      }),
    ).rejects.toThrow(/audits are disabled and cannot execute/i);
    expect(reduceRemoteEvidenceCleanCycles).not.toHaveBeenCalled();
  });

  it("pins integer-period boundary reductions to a new append-only build generation", () => {
    expect(RESULT_INTERPRETATION_REDUCER_BUILD_ID).toBe("clean-cycle-v6");
    expect(RESULT_INTERPRETATION_REDUCER_POLICY.urans.periodBoundaryUlps).toBe(
      4,
    );
  });

  it("MUST-CATCH: only a running parent may lease another archive receipt", () => {
    expect(ARCHIVE_INTERPRETATION_CLAIMABLE_RUN_STATES).toEqual(["running"]);
  });

  it("MUST-CATCH: summary refresh never resurrects a cancelled or failed audit run", () => {
    expect(
      archiveInterpretationBackfillSummaryState({
        terminalState: "cancelled",
        auditIncomplete: false,
        openItems: 0,
      }),
    ).toBe("cancelled");
    expect(
      archiveInterpretationBackfillSummaryState({
        terminalState: "failed",
        auditIncomplete: false,
        openItems: 3,
      }),
    ).toBe("failed");
    expect(
      archiveInterpretationBackfillSummaryState({
        auditIncomplete: true,
        openItems: 0,
      }),
    ).toBe("failed");
  });

  it("accepts only explicit FAST/FINAL provenance", () => {
    expect(archiveBackfillFidelity({ fidelity: "urans_precalc" })).toBe(
      "urans_precalc",
    );
    expect(archiveBackfillFidelity({ fidelity: "urans_full" })).toBe(
      "urans_full",
    );
    expect(archiveBackfillFidelity({ fidelity: "rans" })).toBeNull();
    expect(archiveBackfillFidelity({ unsteady: true })).toBeNull();
    expect(archiveBackfillFidelity(null)).toBeNull();
  });

  it("MUST-CATCH: creates only an exact generation-pinned GCS pointer", () => {
    const accepted = archivePointerForBackfill(gcsBlob());
    expect(accepted.reason).toBeNull();
    expect(accepted.pointer).toEqual({
      schemaVersion: 1,
      format: "tar+zstd",
      bucket: "airfoils-pro-storage-bucket",
      objectKey: `solver-evidence/v1/sha256/aa/${"a".repeat(64)}.tar.zst`,
      generation: "18446744073709551615",
      storedSha256: "a".repeat(64),
      storedSize: 12_345,
      tarSha256: "b".repeat(64),
      tarSize: 54_321,
      crc32c: "AAAAAA==",
      zstdLevel: 10,
      createdAt: "2026-07-28T00:00:00.000Z",
    });

    expect(
      archivePointerForBackfill(gcsBlob({ backend: "volume" as never })),
    ).toMatchObject({ pointer: null, reason: expect.stringContaining("GCS") });
    expect(
      archivePointerForBackfill(gcsBlob({ generation: null })),
    ).toMatchObject({
      pointer: null,
      reason: expect.stringContaining("generation"),
    });
    expect(
      archivePointerForBackfill(gcsBlob({ metadata: { zstdLevel: 99 } })),
    ).toMatchObject({
      pointer: null,
      reason: expect.stringContaining("Zstandard"),
    });
    expect(
      archivePointerForBackfill(
        gcsBlob({ objectKey: "solver-evidence/../other/evidence.tar.zst" }),
      ),
    ).toMatchObject({
      pointer: null,
      reason: expect.stringContaining("object key"),
    });
  });

  it("normalizes a bounded immutable scope and refuses unsafe identifiers", () => {
    expect(
      normaliseArchiveInterpretationBackfillScope({
        resultIds: [UUID_B, UUID_A, UUID_A],
        resultAttemptIds: [UUID_B],
        limit: 24,
      }),
    ).toEqual({
      resultIds: [UUID_A, UUID_B],
      resultAttemptIds: [UUID_B],
      limit: 24,
    });
    expect(() =>
      normaliseArchiveInterpretationBackfillScope({
        resultIds: ["not-a-uuid"],
      }),
    ).toThrow(/UUID/);
  });

  it("MUST-CATCH: a released-evidence audit needs all persisted no-publication fences", () => {
    expect(
      archiveInterpretationBackfillRunMode({
        contract: HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT,
        canonicalSelection: "forbidden",
        physicalRecovery: "record-only",
        campaignMutation: "forbidden",
        rawEvidenceImmutable: true,
        exactSource: {
          resultId: UUID_A,
          resultAttemptId: UUID_B,
          sourceArchiveId: "33333333-3333-4333-8333-333333333333",
        },
      }),
    ).toBe("historical_released_audit");
    expect(
      archiveInterpretationBackfillRunMode({
        contract: "archive-clean-cycle-backfill-v1",
      }),
    ).toBe("queue_publication");
    expect(() =>
      archiveInterpretationBackfillRunMode({
        contract: HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT,
        canonicalSelection: "forbidden",
        physicalRecovery: "record-only",
        campaignMutation: "forbidden",
      }),
    ).toThrow(/no-publication authority fence/);
    expect(() =>
      archiveInterpretationBackfillRunMode({
        contract: HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT,
        canonicalSelection: "forbidden",
        physicalRecovery: "record-only",
        campaignMutation: "forbidden",
        rawEvidenceImmutable: true,
      }),
    ).toThrow(/exactSource/);
  });

  it("keeps planning read-only and refuses standalone run resumption", () => {
    expect(parseArchiveInterpretationBackfillArgs([]).execute).toBe(false);
    expect(() =>
      parseArchiveInterpretationBackfillArgs(["--run-id", UUID_A]),
    ).toThrow(/global exact-source queue/);
    expect(
      parseArchiveInterpretationBackfillArgs([
        "--execute",
        "--result-id",
        UUID_A,
        "--limit",
        "8",
        "--max-items",
        "8",
      ]),
    ).toMatchObject({
      execute: true,
      scope: { resultIds: [UUID_A], limit: 8 },
    });
  });

  it("accepts exactly one conventional pnpm runner separator", () => {
    expect(
      parseArchiveInterpretationBackfillArgs([
        "--",
        "--execute",
        "--result-attempt-id",
        UUID_A,
        "--limit",
        "1",
        "--max-items",
        "1",
      ]),
    ).toMatchObject({
      execute: true,
      scope: { resultAttemptIds: [UUID_A], limit: 1 },
      maxItems: 1,
    });
    expect(() =>
      parseArchiveInterpretationBackfillArgs([
        "--",
        "--",
        "--execute",
        "--result-attempt-id",
        UUID_A,
      ]),
    ).toThrow(/-- requires a value/);
  });

  it("MUST-CATCH: requires an exact bounded scope before execution admission", () => {
    expect(() => parseArchiveInterpretationBackfillArgs(["--execute"])).toThrow(
      /requires at least one --result-id or --result-attempt-id/,
    );
    expect(() =>
      parseArchiveInterpretationBackfillArgs([
        "--execute",
        "--result-id",
        UUID_A,
        "--max-items",
        "9",
      ]),
    ).toThrow(/no greater than 8/);
    expect(() =>
      parseArchiveInterpretationBackfillArgs([
        "--execute",
        "--result-id",
        UUID_A,
        "--limit",
        "3",
        "--max-items",
        "2",
      ]),
    ).toThrow(/cannot exceed --max-items/);
  });

  it("builds an exact recovery action for the durable scheduler ledger instead of silently rerunning", () => {
    const handoff = archiveBackfillRecoveryHandoff({
      state: "continuation_required",
      fidelity: "urans_precalc",
      resultId: UUID_A,
      resultAttemptId: UUID_B,
      sourceArchiveId: "33333333-3333-4333-8333-333333333333",
      inputEvidenceSignature: "c".repeat(64),
      recommendedAdditionalPeriods: 3,
      sourceCleanCycleRecoveryPolicyVersion: null,
    });
    expect(handoff).toEqual({
      contract: "archive-clean-cycle-recovery-handoff-v1",
      action: "continue_exact_case",
      scheduled: false,
      reducerState: "continuation_required",
      fidelity: "urans_precalc",
      resultId: UUID_A,
      resultAttemptId: UUID_B,
      sourceArchiveId: "33333333-3333-4333-8333-333333333333",
      inputEvidenceSignature: "c".repeat(64),
      correctiveTailPeriods: 3,
      cleanCycleRecoveryPolicyVersion: null,
    });
    expect(
      archiveBackfillRecoveryHandoff({
        state: "rerun_required",
        fidelity: "urans_full",
        resultId: UUID_A,
        resultAttemptId: UUID_B,
        sourceArchiveId: "33333333-3333-4333-8333-333333333333",
        inputEvidenceSignature: "c".repeat(64),
        sourceCleanCycleRecoveryPolicyVersion: null,
      }),
    ).toMatchObject({
      action: "verify_restart_proof_then_rerun",
      scheduled: false,
      correctiveTailPeriods: null,
    });
  });

  it("fails closed when a continuation reducer omits or corrupts its bounded tail recommendation", () => {
    expect(archiveRecommendedAdditionalPeriods(1)).toBe(1);
    expect(archiveRecommendedAdditionalPeriods(3)).toBe(3);
    for (const invalid of [undefined, 0, 4, 1.5, true]) {
      expect(() => archiveRecommendedAdditionalPeriods(invalid)).toThrow(
        /integer from 1 through 3/,
      );
    }
    expect(() =>
      archiveBackfillRecoveryHandoff({
        state: "continuation_required",
        fidelity: "urans_precalc",
        resultId: UUID_A,
        resultAttemptId: UUID_B,
        sourceArchiveId: "33333333-3333-4333-8333-333333333333",
        inputEvidenceSignature: "c".repeat(64),
        sourceCleanCycleRecoveryPolicyVersion: null,
      }),
    ).toThrow(/recommendedAdditionalPeriods/);
  });

  it("MUST-CATCH: an adaptive reducer replay cannot widen a legacy source job", () => {
    const base = {
      state: "continuation_required" as const,
      fidelity: "urans_precalc" as const,
      resultId: UUID_A,
      resultAttemptId: UUID_B,
      sourceArchiveId: "33333333-3333-4333-8333-333333333333",
      inputEvidenceSignature: "c".repeat(64),
      recommendedAdditionalPeriods: 3,
      recoveryProgress: {
        policyVersion: "adaptive-clean-tail-v2" as const,
        measuredPeriods: 13,
        maxPeriods: 18,
        recommendedAdditionalPeriods: 3,
      },
    };
    // A v4 engine can replay a v1 archive, but the replay itself is not
    // authority to change that source's immutable cross-job cap.
    expect(
      archiveBackfillRecoveryHandoff({
        ...base,
        sourceCleanCycleRecoveryPolicyVersion: null,
      }).cleanCycleRecoveryPolicyVersion,
    ).toBeNull();
    expect(
      archiveBackfillRecoveryHandoff({
        ...base,
        sourceCleanCycleRecoveryPolicyVersion: "adaptive-clean-tail-v2",
      }).cleanCycleRecoveryPolicyVersion,
    ).toBe("adaptive-clean-tail-v2");
  });

  it("accepts legacy reducer diagnostics but strictly fences an opted-in recovery progress proof", () => {
    expect(
      archiveBackfillRecoveryProgress({
        state: "continuation_required",
        fidelity: "urans_precalc",
        diagnostics: { recommendedAdditionalPeriods: 3 },
      }),
    ).toBeNull();

    expect(
      archiveBackfillRecoveryProgress({
        state: "continuation_required",
        fidelity: "urans_precalc",
        diagnostics: {
          recoveryProgress: {
            measuredPeriods: 6,
            maxPeriods: 9,
            recommendedAdditionalPeriods: 3,
          },
        },
      }),
    ).toEqual({
      measuredPeriods: 6,
      maxPeriods: 9,
      recommendedAdditionalPeriods: 3,
    });

    expect(
      archiveBackfillRecoveryProgress({
        state: "recovery_exhausted",
        fidelity: "urans_full",
        diagnostics: {
          recoveryProgress: {
            measuredPeriods: 12,
            maxPeriods: 12,
          },
        },
      }),
    ).toEqual({ measuredPeriods: 12, maxPeriods: 12 });

    expect(
      archiveBackfillRecoveryProgress({
        state: "continuation_required",
        fidelity: "urans_precalc",
        diagnostics: {
          recoveryProgress: {
            policyVersion: "adaptive-clean-tail-v2",
            measuredPeriods: 13,
            maxPeriods: 18,
            recommendedAdditionalPeriods: 3,
          },
        },
      }),
    ).toEqual({
      policyVersion: "adaptive-clean-tail-v2",
      measuredPeriods: 13,
      maxPeriods: 18,
      recommendedAdditionalPeriods: 3,
    });

    expect(
      archiveBackfillRecoveryProgress({
        state: "recovery_exhausted",
        fidelity: "urans_full",
        diagnostics: {
          recoveryProgress: {
            policyVersion: "adaptive-clean-tail-v2",
            measuredPeriods: 29,
            maxPeriods: 27,
          },
        },
      }),
    ).toEqual({
      policyVersion: "adaptive-clean-tail-v2",
      measuredPeriods: 29,
      maxPeriods: 27,
    });
  });

  it("MUST-CATCH: refuses an over-cap or post-cap recovery handoff before it reaches the scheduler", () => {
    expect(() =>
      archiveBackfillRecoveryProgress({
        state: "continuation_required",
        fidelity: "urans_precalc",
        diagnostics: {
          recoveryProgress: {
            measuredPeriods: 9,
            maxPeriods: 9,
            recommendedAdditionalPeriods: 1,
          },
        },
      }),
    ).toThrow(/continuation must remain below maxPeriods/);
    expect(() =>
      archiveBackfillRecoveryProgress({
        state: "recovery_exhausted",
        fidelity: "urans_precalc",
        diagnostics: {
          recoveryProgress: {
            measuredPeriods: 9,
            maxPeriods: 9,
            recommendedAdditionalPeriods: 1,
          },
        },
      }),
    ).toThrow(/unexpected key "recommendedAdditionalPeriods"/);
    expect(() =>
      archiveBackfillRecoveryProgress({
        state: "continuation_required",
        fidelity: "urans_full",
        diagnostics: {
          recoveryProgress: {
            measuredPeriods: 11,
            maxPeriods: 12,
            recommendedAdditionalPeriods: 2,
          },
        },
      }),
    ).toThrow(/exceeds remaining physical-period budget/);
    expect(() =>
      archiveBackfillRecoveryProgress({
        state: "continuation_required",
        fidelity: "urans_precalc",
        diagnostics: {
          recoveryProgress: {
            measuredPeriods: 13,
            maxPeriods: 18,
            recommendedAdditionalPeriods: 1,
          },
        },
      }),
    ).toThrow(/expected 9 for urans_precalc/);
    expect(() =>
      archiveBackfillRecoveryProgress({
        state: "continuation_required",
        fidelity: "urans_precalc",
        diagnostics: {
          recoveryProgress: {
            policyVersion: "adaptive-clean-tail-v2",
            measuredPeriods: 13,
            maxPeriods: 21,
            recommendedAdditionalPeriods: 1,
          },
        },
      }),
    ).toThrow(/expected 18 for urans_precalc/);
    expect(() =>
      archiveBackfillRecoveryProgress({
        state: "recovery_exhausted",
        fidelity: "urans_precalc",
        diagnostics: {
          recoveryProgress: {
            policyVersion: "adaptive-clean-tail-v2",
            measuredPeriods: 17,
            maxPeriods: 18,
          },
        },
      }),
    ).toThrow(/adaptive exhausted recovery must reach maxPeriods/);
    expect(() =>
      archiveBackfillRecoveryProgress({
        state: "recovery_exhausted",
        fidelity: "urans_precalc",
        diagnostics: {
          recoveryProgress: {
            policyVersion: "adaptive-clean-tail-v2",
            measuredPeriods: 18,
            maxPeriods: 18,
            recommendedAdditionalPeriods: 1,
          },
        },
      }),
    ).toThrow(/unexpected key "recommendedAdditionalPeriods"/);
  });

  it("MUST-CATCH: a legacy pending recovery action may adopt an authenticated clean-tail instruction exactly once before routing", () => {
    for (const incomingCorrectiveTailPeriods of [1, 3]) {
      expect(
        archiveRecoveryMayAdoptCorrectiveTail({
          actionState: "pending",
          currentCorrectiveTailPeriods: null,
          incomingCorrectiveTailPeriods,
        }),
      ).toBe(true);
    }

    // A worker may enrich the migration-era NULL only while the action is
    // still unclaimed.  Altering a lease, a routed action, or a previously
    // authenticated instruction would misdescribe an already-owned physical
    // solve.
    for (const actionState of [
      "routing",
      "waiting_for_precalc",
      "continuation_routed",
      "fresh_rerun_routed",
      "satisfied",
      "blocked",
      "cancelled",
    ]) {
      expect(
        archiveRecoveryMayAdoptCorrectiveTail({
          actionState,
          currentCorrectiveTailPeriods: null,
          incomingCorrectiveTailPeriods: 2,
        }),
      ).toBe(false);
    }
    for (const currentCorrectiveTailPeriods of [1, 2, 3]) {
      expect(
        archiveRecoveryMayAdoptCorrectiveTail({
          actionState: "pending",
          currentCorrectiveTailPeriods,
          incomingCorrectiveTailPeriods: 3,
        }),
      ).toBe(false);
    }
    for (const incomingCorrectiveTailPeriods of [null, 0, 4, 1.5, true, "3"]) {
      expect(
        archiveRecoveryMayAdoptCorrectiveTail({
          actionState: "pending",
          currentCorrectiveTailPeriods: null,
          incomingCorrectiveTailPeriods,
        }),
      ).toBe(false);
    }
  });

  it("MUST-CATCH: never creates another recovery handoff after the physical clean-cycle cap", () => {
    expect(archiveReducerNeedsRecoveryHandoff("continuation_required")).toBe(
      true,
    );
    expect(archiveReducerNeedsRecoveryHandoff("rerun_required")).toBe(true);
    expect(archiveReducerNeedsRecoveryHandoff("recovery_exhausted")).toBe(
      false,
    );
  });
});
