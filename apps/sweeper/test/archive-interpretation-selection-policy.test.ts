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
  mayPromoteArchiveUransFromExactPrecalcRans,
} from "../src/result-interpretations";

const INTERPRETATION_ID = "11111111-1111-4111-8111-111111111111";
const ARCHIVE_ID = "22222222-2222-4222-8222-222222222222";

function cleanMetrics(overrides: Record<string, unknown> = {}) {
  return {
    phaseShiftBins: 1,
    cl: { shapeError: 0.02, amplitudeDeviation: 0.02, highFrequency: 0.01 },
    cd: { shapeError: 0.02, amplitudeDeviation: 0.02, highFrequency: 0.01 },
    cm: { shapeError: 0.02, amplitudeDeviation: 0.02, highFrequency: 0.01 },
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
      selectedWindow: {},
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
        disposition: "startup",
        coefficientSampleCount: 28,
        fieldFrameCount: 25,
        phaseMaxGapFraction: 0.1,
        metrics: cleanMetrics(),
      },
      {
        cycleIndex: 1,
        disposition: "selected",
        coefficientSampleCount: 28,
        fieldFrameCount: 25,
        phaseMaxGapFraction: 0.1,
        metrics: cleanMetrics(),
      },
      {
        cycleIndex: 2,
        disposition: "selected",
        coefficientSampleCount: 28,
        fieldFrameCount: 25,
        phaseMaxGapFraction: 0.1,
        metrics: cleanMetrics(),
      },
      {
        cycleIndex: 3,
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

  it("MUST-CATCH: refuses a stitched/non-terminal selection", () => {
    const candidate = input();
    candidate.cycles[0]!.disposition = "selected";
    candidate.cycles[3]!.disposition = "startup";

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
    ["a missing certificate", (candidate: ReturnType<typeof noSheddingInput>) => {
      candidate.interpretation.diagnostics = {};
    }],
    ["a missing archived URANS provenance marker", (candidate: ReturnType<typeof noSheddingInput>) => {
      delete (
        (candidate.interpretation.diagnostics as Record<string, unknown>)
          .archiveBackfill as Record<string, unknown>
      ).unsteadyEvidence;
    }],
    ["a mismatched selected observation window", (candidate: ReturnType<typeof noSheddingInput>) => {
      (candidate.interpretation.selectedWindow as Record<string, unknown>).observationEndTime =
        4.1;
    }],
    ["a mismatched persisted statistic", (candidate: ReturnType<typeof noSheddingInput>) => {
      ((candidate.interpretation.statistics as Record<string, unknown>).cm as Record<
        string,
        unknown
      >).rms = 0.02;
    }],
    ["a mismatched projected coefficient", (candidate: ReturnType<typeof noSheddingInput>) => {
      candidate.interpretation.cl = 0.82;
      candidate.interpretation.clCd = 0.82 / 0.031;
    }],
    ["a periodic cycle mixed into a steady-equivalent proof", (candidate: ReturnType<typeof noSheddingInput>) => {
      candidate.cycles = [input().cycles[0]!];
    }],
    ["a shedding attempt", (candidate: ReturnType<typeof noSheddingInput>) => {
      candidate.attempt.unsteady = true;
    }],
  ])("MUST-CATCH: refuses a no-shedding archive with %s", (_label, mutate) => {
    const candidate = noSheddingInput();
    mutate(candidate);
    expect(canSelectAcceptedArchiveInterpretation(candidate)).toBe(false);
  });

  it.each([
    ["a producer-reported corruption reason", { reasons: ["impulsive discontinuity"] }],
    ["a phase gap above 10%", null],
    ["a phase shift above four bins", { phaseShiftBins: 5 }],
    ["a shape error above the policy", { cl: { shapeError: 0.13, amplitudeDeviation: 0.02, highFrequency: 0.01 } }],
    ["an amplitude deviation above the policy", { cd: { shapeError: 0.02, amplitudeDeviation: 0.31, highFrequency: 0.01 } }],
  ])("MUST-CATCH: refuses archive selection with %s", (_label, metricsMutation) => {
    const candidate = input();
    if (metricsMutation == null) {
      candidate.cycles[1]!.phaseMaxGapFraction = 0.11;
    } else {
      candidate.cycles[1]!.metrics = cleanMetrics(metricsMutation);
    }

    expect(canSelectAcceptedArchiveInterpretation(candidate)).toBe(false);
  });
});
