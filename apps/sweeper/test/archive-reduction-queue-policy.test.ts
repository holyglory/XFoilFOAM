import { describe, expect, it } from "vitest";

import {
  archiveReductionRetryDelayMs,
  mayRunArchiveReduction,
  mayPublishReducerVersion,
  reducerVersionIsNewer,
  selectArchiveReductionScanPage,
} from "../src/archive-reduction-queue-policy";

const OLD_REDUCER = "old-reducer";
const NEW_REDUCER = "new-reducer";

function row(
  sourceArchiveId: string,
  overrides: Partial<{
    archivePointerValid: boolean;
    acceptedArchive: boolean;
    selectedArchiveId: string | null;
    selectedReducerVersionId: string | null;
  }> = {},
) {
  return {
    sourceArchiveId,
    archivePointerValid: overrides.archivePointerValid ?? true,
    currentSelection: {
      acceptedArchive: overrides.acceptedArchive ?? false,
      sourceArchiveId: overrides.selectedArchiveId ?? null,
      reducerVersionId: overrides.selectedReducerVersionId ?? null,
    },
  };
}

describe("archive publication queue policy", () => {
  it("MUST-CATCH: filters a 64-item accepted prefix before applying the bounded scanner limit", () => {
    const selectedPrefix = Array.from({ length: 64 }, (_, index) =>
      row(`archive-${index}`, {
        acceptedArchive: true,
        selectedArchiveId: `archive-${index}`,
        selectedReducerVersionId: NEW_REDUCER,
      }),
    );
    const candidate = row("newly-uploaded-archive");
    expect(
      selectArchiveReductionScanPage(
        [...selectedPrefix, candidate],
        NEW_REDUCER,
        1,
      ),
    ).toEqual([candidate]);
  });

  it("queues an old accepted reducer version exactly once for a new reducer policy", () => {
    const oldSelection = row("same-archive", {
      acceptedArchive: true,
      selectedArchiveId: "same-archive",
      selectedReducerVersionId: OLD_REDUCER,
    });
    expect(
      selectArchiveReductionScanPage([oldSelection], NEW_REDUCER, 1),
    ).toEqual([oldSelection]);
    expect(
      selectArchiveReductionScanPage([oldSelection], OLD_REDUCER, 1),
    ).toEqual([]);
  });

  it("MUST-CATCH: never reduces a stale archive and only permits a non-current URANS through exact PRECALC lineage", () => {
    expect(
      mayRunArchiveReduction({
        sourceArchiveCurrent: false,
        targetAttemptCurrent: true,
        hasExactPrecalcRansLineage: true,
      }),
    ).toBe(false);
    expect(
      mayRunArchiveReduction({
        sourceArchiveCurrent: true,
        targetAttemptCurrent: false,
        hasExactPrecalcRansLineage: false,
      }),
    ).toBe(false);
    expect(
      mayRunArchiveReduction({
        sourceArchiveCurrent: true,
        targetAttemptCurrent: false,
        hasExactPrecalcRansLineage: true,
      }),
    ).toBe(true);
  });

  it("MUST-CATCH: an older V1 completion cannot overwrite a newer V2 receipt for the same archive", () => {
    const v1 = { id: "00000000-0000-0000-0000-000000000001", createdAt: "2026-07-29T00:00:00.000Z" };
    const v2 = { id: "00000000-0000-0000-0000-000000000002", createdAt: "2026-07-29T00:00:01.000Z" };

    expect(reducerVersionIsNewer(v2, v1)).toBe(true);
    expect(reducerVersionIsNewer(v1, v2)).toBe(false);
    expect(
      mayPublishReducerVersion({ candidate: v1, admittedOrSelected: [v2] }),
    ).toBe(false);
    expect(
      mayPublishReducerVersion({ candidate: v2, admittedOrSelected: [v1] }),
    ).toBe(true);
  });

  it("backs off unexpected queue errors without an unbounded stranded lease", () => {
    expect(archiveReductionRetryDelayMs(1)).toBe(60_000);
    expect(archiveReductionRetryDelayMs(2)).toBe(120_000);
    expect(archiveReductionRetryDelayMs(100)).toBe(30 * 60_000);
  });
});
