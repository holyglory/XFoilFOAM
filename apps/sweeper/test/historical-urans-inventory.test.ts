import { describe, expect, it } from "vitest";

import {
  encodeHistoricalUransInventoryCursor,
  historicalUransArchiveState,
  historicalUransExecutionState,
  historicalUransInventoryPlan,
  historicalUransPublicationState,
  historicalUransProvenanceState,
  historicalUransStage,
  normaliseHistoricalUransInventoryScope,
  parseHistoricalUransInventoryCursor,
  summarizeHistoricalUransInventory,
  type HistoricalUransInventoryCandidate,
} from "../src/historical-urans-inventory";
import { parseHistoricalUransInventoryArgs } from "../src/historical-urans-inventory-cli";

const RESULT_A = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_A = "22222222-2222-4222-8222-222222222222";
const ARCHIVE_A = "33333333-3333-4333-8333-333333333333";

type InventoryBlob = NonNullable<
  Parameters<typeof historicalUransArchiveState>[0]["blob"]
>;

function gcsBlob(overrides: Partial<InventoryBlob> = {}): InventoryBlob {
  return {
    backend: "gcs",
    bucket: "airfoils-pro-storage-bucket",
    objectKey: `solver-evidence/v1/sha256/aa/${"a".repeat(64)}.tar.zst`,
    generation: "18446744073709551615",
    compression: "zstd",
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

function candidate(input: {
  fidelity: "urans_precalc" | "urans_full";
  archiveState: HistoricalUransInventoryCandidate["archiveState"];
  plan: HistoricalUransInventoryCandidate["plan"];
}): HistoricalUransInventoryCandidate {
  return {
    resultId: RESULT_A,
    resultAttemptId: ATTEMPT_A,
    sourceArchiveId: ARCHIVE_A,
    createdAt: "2026-07-30T12:00:00.123456Z",
    fidelity: input.fidelity,
    stage: historicalUransStage(input.fidelity),
    attemptStatus: "done",
    attemptSource: "solved",
    executionState: "completed_solved",
    regime: "urans",
    unsteady: true,
    provenanceState: "eligible_for_existing_handoffs",
    archiveState: input.archiveState,
    archiveReason: null,
    publicationState: "current_attempt",
    plan: input.plan,
  };
}

describe("historical URANS inventory", () => {
  it("MUST-CATCH: retains no-archive, local, malformed-GCS, and valid-GCS sources as distinct states", () => {
    expect(
      historicalUransArchiveState({ sourceArchiveId: null, blob: null }),
    ).toMatchObject({ state: "no_current_archive" });
    expect(
      historicalUransArchiveState({
        sourceArchiveId: ARCHIVE_A,
        blob: gcsBlob({ backend: "volume", bucket: null, generation: null }),
      }),
    ).toMatchObject({ state: "current_local_archive" });
    expect(
      historicalUransArchiveState({
        sourceArchiveId: ARCHIVE_A,
        blob: gcsBlob({ metadata: { zstdLevel: 99 } }),
      }),
    ).toMatchObject({
      state: "malformed_current_archive",
      reason: expect.stringContaining("Zstandard"),
    });
    expect(
      historicalUransArchiveState({
        sourceArchiveId: ARCHIVE_A,
        blob: gcsBlob(),
      }),
    ).toEqual({ state: "verified_gcs_archive", reason: null });
  });

  it("MUST-CATCH: keeps FAST and FINAL partitions separate and does not send FINAL evidence into FAST recovery", () => {
    const summary = summarizeHistoricalUransInventory([
      candidate({
        fidelity: "urans_precalc",
        archiveState: "no_current_archive",
        plan: "fast_archive_gap_recovery_plan",
      }),
      candidate({
        fidelity: "urans_precalc",
        archiveState: "current_local_archive",
        plan: "wait_for_archive_migration",
      }),
      candidate({
        fidelity: "urans_full",
        archiveState: "no_current_archive",
        plan: "final_archive_gap_manual_review",
      }),
      candidate({
        fidelity: "urans_full",
        archiveState: "malformed_current_archive",
        plan: "investigate_archive_integrity",
      }),
      candidate({
        fidelity: "urans_full",
        archiveState: "verified_gcs_archive",
        plan: "archive_interpretation_backfill_plan",
      }),
    ]);

    expect(summary.FAST).toMatchObject({
      total: 2,
      byArchiveState: {
        no_current_archive: 1,
        current_local_archive: 1,
      },
      byPlan: { fast_archive_gap_recovery_plan: 1 },
    });
    expect(summary.FINAL).toMatchObject({
      total: 3,
      byArchiveState: {
        no_current_archive: 1,
        malformed_current_archive: 1,
        verified_gcs_archive: 1,
      },
      byPlan: { final_archive_gap_manual_review: 1 },
    });
    expect(
      historicalUransInventoryPlan({
        fidelity: "urans_full",
        provenanceState: "eligible_for_existing_handoffs",
        archiveState: "no_current_archive",
        executionState: "completed_solved",
        publicationState: "current_attempt",
      }),
    ).toBe("final_archive_gap_manual_review");
  });

  it("MUST-CATCH: fails closed on rows that cannot prove the existing publication contract", () => {
    expect(
      historicalUransProvenanceState({
        resultId: RESULT_A,
        regime: "rans",
        unsteady: false,
      }),
    ).toBe("eligible_for_existing_handoffs");
    expect(
      historicalUransProvenanceState({
        resultId: RESULT_A,
        regime: "rans",
        unsteady: true,
      }),
    ).toBe("incompatible_runtime_provenance");
    expect(
      historicalUransInventoryPlan({
        fidelity: "urans_precalc",
        provenanceState: "missing_result_owner",
        archiveState: "no_current_archive",
        executionState: "completed_solved",
        publicationState: "no_result_owner",
      }),
    ).toBe("investigate_attempt_provenance");
  });

  it("MUST-CATCH: inventories failed and queued explicit-fidelity attempts but never routes them to automatic recovery", () => {
    const failed = historicalUransExecutionState({
      status: "failed",
      source: "queued",
    });
    expect(failed).toBe("terminal_failed");
    expect(
      historicalUransProvenanceState({
        resultId: RESULT_A,
        regime: "urans",
        unsteady: true,
        executionState: failed,
      }),
    ).toBe("non_publishable_execution");
    expect(
      historicalUransInventoryPlan({
        fidelity: "urans_precalc",
        provenanceState: "non_publishable_execution",
        archiveState: "verified_gcs_archive",
        executionState: failed,
        publicationState: "current_attempt",
      }),
    ).toBe("investigate_terminal_failure");

    const queued = historicalUransExecutionState({
      status: "queued",
      source: "queued",
    });
    expect(queued).toBe("queued_or_running");
    expect(
      historicalUransInventoryPlan({
        fidelity: "urans_precalc",
        provenanceState: "non_publishable_execution",
        archiveState: "no_current_archive",
        executionState: queued,
        publicationState: "current_attempt",
      }),
    ).toBe("await_execution");
    expect(
      historicalUransInventoryPlan({
        fidelity: "urans_full",
        provenanceState: "non_publishable_execution",
        archiveState: "no_current_archive",
        executionState: "awaiting_result_publication",
        publicationState: "current_attempt",
      }),
    ).toBe("await_result_publication");
    expect(
      historicalUransExecutionState({ status: "running", source: "solved" }),
    ).toBe("queued_or_running");
    expect(
      historicalUransInventoryPlan({
        fidelity: "urans_full",
        provenanceState: "non_publishable_execution",
        archiveState: "verified_gcs_archive",
        executionState: "stale_execution",
        publicationState: "current_attempt",
      }),
    ).toBe("investigate_stale_execution");
  });

  it("MUST-CATCH: a completed authenticated GCS source with no current result generation is historical evidence, never automatic publication work", () => {
    expect(
      historicalUransPublicationState({
        resultId: RESULT_A,
        resultAttemptId: ATTEMPT_A,
        currentResultAttemptId: null,
      }),
    ).toBe("historical_released");
    expect(
      historicalUransInventoryPlan({
        fidelity: "urans_precalc",
        provenanceState: "eligible_for_existing_handoffs",
        archiveState: "verified_gcs_archive",
        executionState: "completed_solved",
        publicationState: "historical_released",
      }),
    ).toBe("ineligible_released_evidence");
    expect(
      historicalUransPublicationState({
        resultId: RESULT_A,
        resultAttemptId: ATTEMPT_A,
        currentResultAttemptId: ATTEMPT_A,
      }),
    ).toBe("current_attempt");
    expect(
      historicalUransPublicationState({
        resultId: RESULT_A,
        resultAttemptId: ATTEMPT_A,
        currentResultAttemptId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toBe("other_current_attempt");
    expect(
      historicalUransPublicationState({
        resultId: null,
        resultAttemptId: ATTEMPT_A,
        currentResultAttemptId: null,
      }),
    ).toBe("no_result_owner");
    expect(
      historicalUransInventoryPlan({
        fidelity: "urans_precalc",
        // Defend the planner itself as well as the normal query mapper: a
        // malformed caller cannot turn ownerless GCS bytes into an audit or
        // automatic publication candidate by mislabelling provenance.
        provenanceState: "eligible_for_existing_handoffs",
        archiveState: "verified_gcs_archive",
        executionState: "completed_solved",
        publicationState: "no_result_owner",
      }),
    ).toBe("investigate_attempt_provenance");
  });

  it("preserves microsecond keysets and rejects invalid scopes", () => {
    const cursor = encodeHistoricalUransInventoryCursor({
      createdAt: "2026-07-30T12:00:00.123456Z",
      resultAttemptId: ATTEMPT_A,
    });
    expect(parseHistoricalUransInventoryCursor(cursor)).toEqual({
      createdAt: "2026-07-30T12:00:00.123456Z",
      resultAttemptId: ATTEMPT_A,
    });
    expect(parseHistoricalUransInventoryCursor("invalid")).toBeNull();
    expect(
      normaliseHistoricalUransInventoryScope({
        resultIds: [RESULT_A, RESULT_A],
        resultAttemptIds: [ATTEMPT_A],
        cursor,
        limit: 26,
      }),
    ).toMatchObject({
      resultIds: [RESULT_A],
      resultAttemptIds: [ATTEMPT_A],
      limit: 26,
    });
  });

  it("MUST-CATCH: exposes no execution path from the inventory command", () => {
    expect(() => parseHistoricalUransInventoryArgs(["--execute"])).toThrow(
      /read-only/,
    );
    expect(() =>
      parseHistoricalUransInventoryArgs(["--", "--execute"]),
    ).toThrow(/read-only/);
    expect(() =>
      parseHistoricalUransInventoryArgs(["--", "--", "--limit", "1"]),
    ).toThrow(/requires a value/);
    expect(parseHistoricalUransInventoryArgs(["--", "--limit", "1"])).toEqual({
      scope: { resultIds: [], resultAttemptIds: [], limit: 1 },
    });
    expect(() =>
      parseHistoricalUransInventoryArgs(["--limit", "2oops"]),
    ).toThrow(/positive integer/);
  });
});
