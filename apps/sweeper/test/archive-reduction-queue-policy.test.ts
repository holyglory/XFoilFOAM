import { describe, expect, it } from "vitest";

import {
  archiveReductionRetryDelayMs,
  CLEAN_CYCLE_V5_SELECTION_COMPATIBILITY,
  CLEAN_CYCLE_V6_REDUCER_IDENTITY,
  mayRunArchiveReduction,
  mayPublishReducerVersion,
  reducerVersionIsNewer,
  selectArchiveReductionScanPage,
} from "../src/archive-reduction-queue-policy";

const OLD_REDUCER = "old-reducer";
const NEW_REDUCER = "new-reducer";
const OLD_TARGET = {
  id: OLD_REDUCER,
  reducerKey: "other-reducer",
  reducerVersion: "other-version",
  reducerBuildId: "other-build",
  createdAt: "2026-08-05T00:00:00.000Z",
};
const V6_TARGET = {
  id: NEW_REDUCER,
  ...CLEAN_CYCLE_V6_REDUCER_IDENTITY,
  createdAt: "2026-08-05T00:00:00.000Z",
};

function row(
  sourceArchiveId: string,
  overrides: Partial<{
    archivePointerValid: boolean;
    resultHasCurrentAttempt: boolean;
    hasExactLivePrecalcPublicationOwner: boolean;
    acceptedArchive: boolean;
    selectedArchiveId: string | null;
    selectedReducerVersionId: string | null;
    selectedReducerKey: string | null;
    selectedReducerVersion: string | null;
    selectedReducerBuildId: string | null;
    resultAttemptCreatedAt: Date | string | null;
    sourceArchiveCreatedAt: Date | string | null;
  }> = {},
) {
  return {
    sourceArchiveId,
    archivePointerValid: overrides.archivePointerValid ?? true,
    resultAttemptCreatedAt:
      overrides.resultAttemptCreatedAt ?? "2026-08-05T00:00:01.000Z",
    sourceArchiveCreatedAt:
      overrides.sourceArchiveCreatedAt ?? "2026-08-05T00:00:01.000Z",
    resultHasCurrentAttempt: overrides.resultHasCurrentAttempt ?? true,
    hasExactLivePrecalcPublicationOwner:
      overrides.hasExactLivePrecalcPublicationOwner ?? false,
    currentSelection: {
      acceptedArchive: overrides.acceptedArchive ?? false,
      sourceArchiveId: overrides.selectedArchiveId ?? null,
      reducerVersionId: overrides.selectedReducerVersionId ?? null,
      reducerKey: overrides.selectedReducerKey ?? null,
      reducerVersion: overrides.selectedReducerVersion ?? null,
      reducerBuildId: overrides.selectedReducerBuildId ?? null,
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
        V6_TARGET,
        1,
      ),
    ).toEqual([candidate]);
  });

  it("MUST-CATCH: preserves an accepted exact clean-cycle-v5 selection during routine clean-cycle-v6 scanning", () => {
    const v5Selection = row("same-archive", {
      acceptedArchive: true,
      selectedArchiveId: "same-archive",
      selectedReducerVersionId: OLD_REDUCER,
      selectedReducerKey: CLEAN_CYCLE_V5_SELECTION_COMPATIBILITY.reducerKey,
      selectedReducerVersion:
        CLEAN_CYCLE_V5_SELECTION_COMPATIBILITY.reducerVersion,
      selectedReducerBuildId:
        CLEAN_CYCLE_V5_SELECTION_COMPATIBILITY.reducerBuildId,
    });
    expect(selectArchiveReductionScanPage([v5Selection], V6_TARGET, 1)).toEqual(
      [],
    );
  });

  it("MUST-CATCH: a routine v6 scan is prospective, while an explicit exact scope may repair an older source", () => {
    const historicalNoSelection = row("pre-v6-archive", {
      resultAttemptCreatedAt: "2026-08-04T23:59:59.000Z",
      sourceArchiveCreatedAt: "2026-08-04T23:59:59.000Z",
    });
    const inFlightDeliveredAfterRelease = row("post-v6-archive", {
      // A solver started before the rollout but finalized its immutable GCS
      // archive afterward. Routine recovery must pick up this crashed ingest.
      resultAttemptCreatedAt: "2026-08-04T23:59:59.000Z",
      sourceArchiveCreatedAt: "2026-08-05T00:00:01.000Z",
    });
    expect(
      selectArchiveReductionScanPage(
        [historicalNoSelection, inFlightDeliveredAfterRelease],
        V6_TARGET,
        2,
      ),
    ).toEqual([inFlightDeliveredAfterRelease]);
    expect(
      selectArchiveReductionScanPage(
        [historicalNoSelection],
        V6_TARGET,
        1,
        "explicit_historical_repair",
      ),
    ).toEqual([historicalNoSelection]);
  });

  it("queues an old accepted reducer version exactly once for a new reducer policy", () => {
    const oldSelection = row("same-archive", {
      acceptedArchive: true,
      selectedArchiveId: "same-archive",
      selectedReducerVersionId: OLD_REDUCER,
    });
    expect(
      selectArchiveReductionScanPage([oldSelection], V6_TARGET, 1),
    ).toEqual([oldSelection]);
    expect(
      selectArchiveReductionScanPage([oldSelection], OLD_TARGET, 1),
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
    expect(
      mayRunArchiveReduction({
        sourceArchiveCurrent: true,
        targetAttemptCurrent: false,
        hasExactPrecalcRansLineage: false,
        hasExactLegacyRecoveryLineage: true,
      }),
    ).toBe(true);
  });

  it("MUST-CATCH: a released result generation cannot enter the live archive-publication queue without an exact live PRECALC owner", () => {
    expect(
      selectArchiveReductionScanPage(
        [row("released-immutable-gcs", { resultHasCurrentAttempt: false })],
        V6_TARGET,
        1,
      ),
    ).toEqual([]);
    const exactBlockedPrecalcOwner = row("exact-owner-archive", {
      resultHasCurrentAttempt: false,
      hasExactLivePrecalcPublicationOwner: true,
    });
    expect(
      selectArchiveReductionScanPage([exactBlockedPrecalcOwner], V6_TARGET, 1),
    ).toEqual([exactBlockedPrecalcOwner]);
  });

  it("MUST-CATCH: an older V1 completion cannot overwrite a newer V2 receipt for the same archive", () => {
    const v1 = {
      id: "00000000-0000-0000-0000-000000000001",
      createdAt: "2026-07-29T00:00:00.000Z",
    };
    const v2 = {
      id: "00000000-0000-0000-0000-000000000002",
      createdAt: "2026-07-29T00:00:01.000Z",
    };

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
