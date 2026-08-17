import { describe, expect, it, vi } from "vitest";

vi.mock("@aerodb/db", () => ({
  resultAttempts: {},
  resultCanonicalSelections: {},
  resultInterpretationCycles: {},
  resultInterpretations: {},
  resultReducerVersions: {},
  results: {},
  solverEvidenceArchives: {},
}));

import {
  canSelectAcceptedArchiveInterpretation,
  HistoricalArchiveAuditClaimLostError,
  HISTORICAL_ARCHIVE_AUDIT_INTERPRETATION_SOURCE,
  historicalReleasedArchiveAuditScopeMatchesExactSource,
  isHistoricalReleasedArchiveAuditSourceEligible,
  mayPromoteArchiveUransFromExactPrecalcRans,
  stageArchiveResultInterpretation,
  validateHistoricalReleasedArchiveAuditExactSource,
  validateHistoricalReleasedArchiveAuditScope,
} from "../src/result-interpretations";

const INTERPRETATION_ID = "11111111-1111-4111-8111-111111111111";
const ARCHIVE_ID = "22222222-2222-4222-8222-222222222222";
const AUDIT_RESULT_ID = "33333333-3333-4333-8333-333333333333";
const AUDIT_ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";

function historicalAuditScope(overrides: Record<string, unknown> = {}) {
  return {
    contract: "archive-clean-cycle-historical-released-audit-v1",
    canonicalSelection: "forbidden",
    physicalRecovery: "record-only",
    campaignMutation: "forbidden",
    rawEvidenceImmutable: true,
    exactSource: {
      resultId: AUDIT_RESULT_ID,
      resultAttemptId: AUDIT_ATTEMPT_ID,
      sourceArchiveId: ARCHIVE_ID,
    },
    ...overrides,
  };
}

function cleanMetrics(overrides: Record<string, unknown> = {}) {
  return {
    phaseShiftBins: 1,
    cl: {
      mean: 0.81,
      shapeError: 0.02,
      amplitudeDeviation: 0.02,
      highFrequency: 0.01,
    },
    cd: {
      mean: 0.031,
      shapeError: 0.02,
      amplitudeDeviation: 0.02,
      highFrequency: 0.01,
    },
    cm: {
      mean: -0.09,
      shapeError: 0.02,
      amplitudeDeviation: 0.02,
      highFrequency: 0.01,
    },
    reasons: [] as string[],
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    interpretation: {
      id: INTERPRETATION_ID,
      state: "accepted",
      source: "archive_backfill",
      regime: "periodic",
      sourceArchiveId: ARCHIVE_ID,
      inputEvidenceSignature: "a".repeat(64),
      cl: 0.81,
      cd: 0.031,
      cm: -0.09,
      clCd: 0.81 / 0.031,
      selectedWindow: {
        periodS: 0.02,
        phaseSamples: 96,
        requiredCleanCycles: 3,
        terminalCleanCycles: 3,
        selectedCycleStartIndex: 1,
        selectedCycleIndexes: [1, 2, 3],
        cadenceAdjusted: false,
      },
      statistics: {},
      diagnostics: {},
    },
    expectedSourceArchiveId: ARCHIVE_ID,
    archive: {
      id: ARCHIVE_ID,
      state: "current",
      backend: "gcs",
      compression: "zstd",
      mimeType: "application/zstd",
      bucket: "airfoils-pro-storage-bucket",
      generation: "18446744073709551615",
      verifiedAt: new Date("2026-07-28T00:00:00.000Z"),
    },
    attempt: {
      status: "done",
      source: "solved",
      regime: "urans",
      unsteady: true,
      error: null,
      fidelity: "urans_precalc",
    },
    cycles: [
      {
        cycleIndex: 0,
        startTimeS: 0,
        endTimeS: 0.02,
        periodS: 0.02,
        disposition: "startup",
        coefficientSampleCount: 28,
        fieldFrameCount: 25,
        phaseMaxGapFraction: 0.1,
        metrics: cleanMetrics(),
      },
      {
        cycleIndex: 1,
        startTimeS: 0.02,
        endTimeS: 0.04,
        periodS: 0.02,
        disposition: "selected",
        coefficientSampleCount: 28,
        fieldFrameCount: 25,
        phaseMaxGapFraction: 0.1,
        metrics: cleanMetrics(),
      },
      {
        cycleIndex: 2,
        startTimeS: 0.04,
        endTimeS: 0.06,
        periodS: 0.02,
        disposition: "selected",
        coefficientSampleCount: 28,
        fieldFrameCount: 25,
        phaseMaxGapFraction: 0.1,
        metrics: cleanMetrics(),
      },
      {
        cycleIndex: 3,
        startTimeS: 0.06,
        endTimeS: 0.08,
        periodS: 0.02,
        disposition: "selected",
        coefficientSampleCount: 28,
        fieldFrameCount: 25,
        phaseMaxGapFraction: 0.1,
        metrics: cleanMetrics(),
      },
    ],
    ...overrides,
  };
}

function noSheddingInput(overrides: Record<string, unknown> = {}) {
  const certificate = {
    reducer_version: "no-shedding-v1",
    certified: true,
    required_observation_s: 4.2,
    observation_start_time: 0,
    observation_end_time: 4.2,
    observed_observation_s: 4.2,
    source_sample_count: 420,
    transport_sample_count: 20,
    relative_tolerance: 0.005,
    absolute_floor: 0.001,
    cl_mean: 0.81,
    cd_mean: 0.031,
    cm_mean: -0.09,
    cl_rms: 0.0002,
    cd_rms: 0.00002,
    cm_rms: 0.00002,
    transport_cl_mean: 0.81,
    transport_cd_mean: 0.031,
    transport_cm_mean: -0.09,
    transport_cl_rms: 0.0002,
    transport_cd_rms: 0.00002,
    transport_cm_rms: 0.00002,
  };
  return input({
    interpretation: {
      ...input().interpretation,
      regime: "steady_equivalent",
      selectedWindow: {
        kind: "steady_equivalent",
        reducerVersion: certificate.reducer_version,
        observationStartTime: certificate.observation_start_time,
        observationEndTime: certificate.observation_end_time,
        requiredObservationS: certificate.required_observation_s,
        observedObservationS: certificate.observed_observation_s,
        sourceSampleCount: certificate.source_sample_count,
        transportSampleCount: certificate.transport_sample_count,
      },
      statistics: {
        cl: { mean: certificate.cl_mean, rms: certificate.cl_rms },
        cd: { mean: certificate.cd_mean, rms: certificate.cd_rms },
        cm: { mean: certificate.cm_mean, rms: certificate.cm_rms },
      },
      diagnostics: {
        noSheddingCertificate: certificate,
        archiveBackfill: { unsteadyEvidence: true },
      },
    },
    attempt: {
      status: "done",
      source: "solved",
      regime: "urans",
      unsteady: false,
      error: null,
      fidelity: "urans_precalc",
    },
    cycles: [],
    ...overrides,
  });
}

type HistoricalAuditProof = Parameters<
  typeof isHistoricalReleasedArchiveAuditSourceEligible
>[0];

function historicalAuditProof(): HistoricalAuditProof {
  return {
    expectedFidelity: "urans_precalc",
    attempt: {
      status: "done",
      source: "solved",
      regime: "urans",
      unsteady: true,
      fidelity: "urans_precalc",
    },
    blob: {
      backend: "gcs",
      bucket: "airfoils-pro-storage-bucket",
      objectKey: "evidence/2026/07/audit.tar.zst",
      generation: "18446744073709551615",
      compression: "zstd",
      mimeType: "application/zstd",
      sha256: "a".repeat(64),
      byteSize: 12_345,
      crc32c: "AAAAAA==",
      uncompressedTarSha256: "b".repeat(64),
      uncompressedTarByteSize: 54_321,
      verifiedAt: new Date("2026-07-28T00:00:00.000Z"),
      metadata: {
        archiveFormat: "tar+zstd",
        zstdLevel: 10,
      },
    },
  };
}

describe("accepted archive interpretation selection", () => {
  it("promotes URANS from a RANS handoff only through exact PRECALC lineage", () => {
    expect(
      mayPromoteArchiveUransFromExactPrecalcRans({
        targetFidelity: "urans_precalc",
        currentFidelity: "rans",
        hasExactPrecalcLineage: true,
      }),
    ).toBe(true);
    expect(
      mayPromoteArchiveUransFromExactPrecalcRans({
        targetFidelity: "urans_precalc",
        currentFidelity: "rans",
        hasExactPrecalcLineage: false,
      }),
    ).toBe(false);
    expect(
      mayPromoteArchiveUransFromExactPrecalcRans({
        targetFidelity: "urans_full",
        currentFidelity: "urans_precalc",
        hasExactPrecalcLineage: true,
      }),
    ).toBe(false);
  });

  it("selects only a current exact archive with the FAST terminal clean suffix", () => {
    expect(canSelectAcceptedArchiveInterpretation(input())).toBe(true);
  });

  it("MUST-CATCH: never selects a released-history audit as canonical output", () => {
    expect(
      canSelectAcceptedArchiveInterpretation(
        input({
          interpretation: {
            ...input().interpretation,
            source: HISTORICAL_ARCHIVE_AUDIT_INTERPRETATION_SOURCE,
          },
        }),
      ),
    ).toBe(false);
  });

  it("MUST-CATCH: an audit run has one canonical exact source at every runtime gate", () => {
    expect(
      validateHistoricalReleasedArchiveAuditScope(
        historicalAuditScope({
          exactSource: {
            resultId: AUDIT_RESULT_ID.toUpperCase(),
            resultAttemptId: AUDIT_ATTEMPT_ID.toUpperCase(),
            sourceArchiveId: ARCHIVE_ID.toUpperCase(),
          },
        }),
      ),
    ).toEqual({
      resultId: AUDIT_RESULT_ID,
      resultAttemptId: AUDIT_ATTEMPT_ID,
      sourceArchiveId: ARCHIVE_ID,
    });
    expect(
      historicalReleasedArchiveAuditScopeMatchesExactSource({
        scope: historicalAuditScope(),
        exactSource: {
          resultId: AUDIT_RESULT_ID,
          resultAttemptId: AUDIT_ATTEMPT_ID,
          sourceArchiveId: ARCHIVE_ID,
        },
      }),
    ).toBe(true);
    expect(
      historicalReleasedArchiveAuditScopeMatchesExactSource({
        scope: historicalAuditScope(),
        exactSource: {
          resultId: AUDIT_RESULT_ID,
          resultAttemptId: AUDIT_ATTEMPT_ID,
          sourceArchiveId: INTERPRETATION_ID,
        },
      }),
    ).toBe(false);

    for (const scope of [
      historicalAuditScope({ exactSource: null }),
      historicalAuditScope({
        exactSource: {
          resultId: AUDIT_RESULT_ID,
          resultAttemptId: AUDIT_ATTEMPT_ID,
          sourceArchiveId: "not-a-uuid",
        },
      }),
      historicalAuditScope({ rawEvidenceImmutable: false }),
      historicalAuditScope({
        canonicalSelection: "accepted-current-archive-only",
      }),
      historicalAuditScope({ resultIds: [AUDIT_RESULT_ID] }),
      historicalAuditScope({
        exactSource: {
          resultId: AUDIT_RESULT_ID,
          resultAttemptId: AUDIT_ATTEMPT_ID,
          sourceArchiveId: ARCHIVE_ID,
          broadFallback: true,
        },
      }),
    ]) {
      expect(() =>
        validateHistoricalReleasedArchiveAuditScope(scope),
      ).toThrow();
    }
    expect(() =>
      validateHistoricalReleasedArchiveAuditExactSource({
        resultId: AUDIT_RESULT_ID,
        resultAttemptId: AUDIT_ATTEMPT_ID,
      }),
    ).toThrow(/sourceArchiveId/);
  });

  it("MUST-CATCH: historical staging requires its atomic non-publication decision receipt", async () => {
    const base = {
      db: {} as never,
      resultId: "33333333-3333-4333-8333-333333333333",
      resultAttemptId: "44444444-4444-4444-8444-444444444444",
      sourceArchiveId: ARCHIVE_ID,
      reducerVersionId: "55555555-5555-4555-8555-555555555555",
      backfillRunId: "66666666-6666-4666-8666-666666666666",
      authority: {
        kind: "historical_released_audit" as const,
        auditClaim: {
          backfillItemId: "77777777-7777-4777-8777-777777777777",
          backfillClaimToken: "audit-claim",
        },
      },
      inputEvidenceSignature: "a".repeat(64),
      point: {} as never,
      fidelity: "urans_precalc" as const,
      diagnostics: {},
    };

    await expect(stageArchiveResultInterpretation(base)).rejects.toBeInstanceOf(
      HistoricalArchiveAuditClaimLostError,
    );
    await expect(
      stageArchiveResultInterpretation({
        ...base,
      historicalAuditDecision: {
        inputEvidenceSignature: "b".repeat(64),
        reducerState: "accepted",
        advisoryContinuationAction: null,
        advisoryTailPeriods: null,
        diagnostics: {},
      },
      // Supply the required finalizer so this assertion reaches the
      // decision-signature guard rather than failing earlier on the missing
      // atomic receipt callback.
      historicalAuditFinalize: async () => true,
    }),
    ).rejects.toThrow(/exact reducer evidence signature/);
    await expect(
      stageArchiveResultInterpretation({
        ...base,
        sourceArchiveId: "not-a-uuid",
        historicalAuditDecision: {
          inputEvidenceSignature: "a".repeat(64),
          reducerState: "accepted",
          advisoryContinuationAction: null,
          advisoryTailPeriods: null,
          diagnostics: {},
        },
      }),
    ).rejects.toThrow(/exactSource.sourceArchiveId/);
  });

  it("requires a current, completed exact URANS GCS/Zstandard proof before a released-history audit can stage", () => {
    expect(
      isHistoricalReleasedArchiveAuditSourceEligible(historicalAuditProof()),
    ).toBe(true);
  });

  it.each([
    [
      "an unfinished attempt",
      (candidate: HistoricalAuditProof) => {
        candidate.attempt.status = "running";
      },
    ],
    [
      "a non-solver attempt source",
      (candidate: HistoricalAuditProof) => {
        candidate.attempt.source = "imported";
      },
    ],
    [
      "a fidelity mismatch",
      (candidate: HistoricalAuditProof) => {
        candidate.attempt.fidelity = "rans";
      },
    ],
    [
      "a local or mutable archive backend",
      (candidate: HistoricalAuditProof) => {
        candidate.blob.backend = "volume";
      },
    ],
    [
      "an unpinned archive key",
      (candidate: HistoricalAuditProof) => {
        candidate.blob.objectKey = "../released/audit.tar.zst";
      },
    ],
    [
      "a whitespace-padded archive object key",
      (candidate: HistoricalAuditProof) => {
        candidate.blob.objectKey = " evidence/2026/07/audit.tar.zst ";
      },
    ],
    [
      "a malformed GCS generation",
      (candidate: HistoricalAuditProof) => {
        candidate.blob.generation = "0";
      },
    ],
    [
      "an unverified archive",
      (candidate: HistoricalAuditProof) => {
        candidate.blob.verifiedAt = new Date("not-a-date");
      },
    ],
    [
      "an invalid Zstandard level",
      (candidate: HistoricalAuditProof) => {
        candidate.blob.metadata = {
          archiveFormat: "tar+zstd",
          zstdLevel: 23,
        };
      },
    ],
  ])(
    "MUST-CATCH: refuses released-history audit staging with %s",
    (_label, mutate) => {
      const candidate = historicalAuditProof();
      mutate(candidate);
      expect(isHistoricalReleasedArchiveAuditSourceEligible(candidate)).toBe(
        false,
      );
    },
  );

  it("MUST-CATCH: refuses a stitched/non-terminal selection", () => {
    const candidate = input();
    candidate.cycles[0]!.disposition = "selected";
    candidate.cycles[3]!.disposition = "startup";

    expect(canSelectAcceptedArchiveInterpretation(candidate)).toBe(false);
  });

  it("MUST-CATCH: refuses archive coefficients that differ from the exact selected-cycle means", () => {
    const candidate = input();
    candidate.interpretation.cl = 0.82;
    candidate.interpretation.clCd = 0.82 / candidate.interpretation.cd!;

    expect(canSelectAcceptedArchiveInterpretation(candidate)).toBe(false);
  });

  it("MUST-CATCH: refuses a selected suffix with a physical time gap", () => {
    const candidate = input();
    candidate.cycles[2]!.startTimeS = 0.041;
    candidate.cycles[2]!.endTimeS = 0.061;

    expect(canSelectAcceptedArchiveInterpretation(candidate)).toBe(false);
  });

  it("MUST-CATCH: refuses stale/local archives and a source-attempt mismatch", () => {
    expect(
      canSelectAcceptedArchiveInterpretation(
        input({
          archive: {
            ...input().archive,
            state: "superseded",
          },
        }),
      ),
    ).toBe(false);
    expect(
      canSelectAcceptedArchiveInterpretation(
        input({
          archive: {
            ...input().archive,
            backend: "volume",
          },
        }),
      ),
    ).toBe(false);
    expect(
      canSelectAcceptedArchiveInterpretation(
        input({
          expectedSourceArchiveId: "33333333-3333-4333-8333-333333333333",
        }),
      ),
    ).toBe(false);
  });

  it("demands five exact terminal cycles for FINAL URANS", () => {
    const candidate = input({
      attempt: {
        status: "done",
        source: "solved",
        regime: "urans",
        unsteady: true,
        error: null,
        fidelity: "urans_full",
      },
    });
    expect(canSelectAcceptedArchiveInterpretation(candidate)).toBe(false);
  });

  it("selects a no-shedding URANS archive only with its exact physical observation proof", () => {
    expect(canSelectAcceptedArchiveInterpretation(noSheddingInput())).toBe(
      true,
    );
    // The pre-fidelity mapper recorded early no-shedding URANS attempts as
    // RANS. The strict certificate/window/statistics contract is the only
    // compatibility route; no ordinary RANS attempt gains this privilege.
    expect(
      canSelectAcceptedArchiveInterpretation(
        noSheddingInput({
          attempt: {
            ...noSheddingInput().attempt,
            regime: "rans",
          },
        }),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "a missing certificate",
      (candidate: ReturnType<typeof noSheddingInput>) => {
        candidate.interpretation.diagnostics = {};
      },
    ],
    [
      "a missing archived URANS provenance marker",
      (candidate: ReturnType<typeof noSheddingInput>) => {
        delete (
          (candidate.interpretation.diagnostics as Record<string, unknown>)
            .archiveBackfill as Record<string, unknown>
        ).unsteadyEvidence;
      },
    ],
    [
      "a mismatched selected observation window",
      (candidate: ReturnType<typeof noSheddingInput>) => {
        (
          candidate.interpretation.selectedWindow as Record<string, unknown>
        ).observationEndTime = 4.1;
      },
    ],
    [
      "a mismatched persisted statistic",
      (candidate: ReturnType<typeof noSheddingInput>) => {
        (
          (candidate.interpretation.statistics as Record<string, unknown>)
            .cm as Record<string, unknown>
        ).rms = 0.02;
      },
    ],
    [
      "a mismatched projected coefficient",
      (candidate: ReturnType<typeof noSheddingInput>) => {
        candidate.interpretation.cl = 0.82;
        candidate.interpretation.clCd = 0.82 / 0.031;
      },
    ],
    [
      "a periodic cycle mixed into a steady-equivalent proof",
      (candidate: ReturnType<typeof noSheddingInput>) => {
        candidate.cycles = [input().cycles[0]!];
      },
    ],
    [
      "a shedding attempt",
      (candidate: ReturnType<typeof noSheddingInput>) => {
        candidate.attempt.unsteady = true;
      },
    ],
  ])("MUST-CATCH: refuses a no-shedding archive with %s", (_label, mutate) => {
    const candidate = noSheddingInput();
    mutate(candidate);
    expect(canSelectAcceptedArchiveInterpretation(candidate)).toBe(false);
  });

  it.each([
    [
      "a producer-reported corruption reason",
      { reasons: ["impulsive discontinuity"] },
    ],
    ["a phase gap above 10%", null],
    ["a phase shift above four bins", { phaseShiftBins: 5 }],
    [
      "a shape error above the policy",
      {
        cl: {
          mean: 0.81,
          shapeError: 0.13,
          amplitudeDeviation: 0.02,
          highFrequency: 0.01,
        },
      },
    ],
    [
      "an amplitude deviation above the policy",
      {
        cd: {
          mean: 0.031,
          shapeError: 0.02,
          amplitudeDeviation: 0.31,
          highFrequency: 0.01,
        },
      },
    ],
  ])(
    "MUST-CATCH: refuses archive selection with %s",
    (_label, metricsMutation) => {
      const candidate = input();
      if (metricsMutation == null) {
        candidate.cycles[1]!.phaseMaxGapFraction = 0.11;
      } else {
        candidate.cycles[1]!.metrics = cleanMetrics(metricsMutation);
      }

      expect(canSelectAcceptedArchiveInterpretation(candidate)).toBe(false);
    },
  );
});
