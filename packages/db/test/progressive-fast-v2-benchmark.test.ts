import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { DB } from "../src/client";
import { progressiveGenerationStages } from "../src/progressive-campaigns";
import {
  buildFastV2BenchmarkReport,
  FAST_V2_BENCHMARK_SCHEMA,
  fastV2BenchmarkPriority,
  readFastV2BenchmarkReport,
  type FastV2BenchmarkPlan,
  type FastV2BenchmarkRun,
} from "../src/progressive-fast-v2-benchmark";

function observation(
  variant: "current-fast" | "fast-v2",
  alpha: number,
  overrides: Record<string, unknown> = {},
) {
  const identity = `${variant}-${alpha}`;
  return {
    scope_key: `fast-v2-benchmark:fixture:${variant}`,
    target_id: "target-a",
    work_state: "complete",
    unit_id: `unit-${identity}`,
    aoa_deg: alpha,
    purpose: "initial",
    unit_state: "complete",
    active_seconds: variant === "current-fast" ? 100 : 20,
    attempt_token: `attempt-${identity}`,
    attempt_started_at: "2026-11-01T00:00:00Z",
    attempt_finished_at: "2026-11-01T00:02:00Z",
    attempt_outcome: "complete",
    attempt_active_seconds: variant === "current-fast" ? 100 : 20,
    result_attempt_id: `raw-${identity}`,
    result_id: `result-${identity}`,
    evidence_signature: "a".repeat(64),
    evidence_aoa_deg: alpha,
    evidence_regime: "rans",
    result_created_at: "2026-11-01T00:02:00Z",
    accepted: true,
    cl: 0.7,
    cd: 0.02,
    cm: -0.01,
    ...overrides,
  };
}

async function reportFromRows(rows: unknown[]) {
  const execute = vi
    .fn()
    .mockResolvedValueOnce(
      ["current-fast", "fast-v2"].map((variant) => ({
        id: `generation-${variant}`,
        scope_key: `fast-v2-benchmark:fixture:${variant}`,
        benchmark_only: true,
      })),
    )
    .mockResolvedValueOnce([{ count: 0 }])
    .mockResolvedValueOnce(rows);
  const report = await readFastV2BenchmarkReport(
    { execute } as unknown as DB,
    "benchmark-campaign",
  );
  const queries = execute.mock.calls.map(
    ([query]) => new PgDialect().sqlToQuery(query).sql,
  );
  expect(queries).toHaveLength(3);
  expect(queries.every((query) => /^\s*SELECT\b/u.test(query))).toBe(true);
  expect(queries[2]).toContain("JOIN progressive_generation_targets");
  expect(queries[2]).toContain("LEFT JOIN progressive_work");
  expect(queries[2]).toContain("LEFT JOIN progressive_cfd_units");
  expect(queries[2]).toContain("work.stage=2");
  return report;
}

describe("fast-v2 benchmark stage barrier", () => {
  it("creates only baseline and fast stages for benchmark generations", () => {
    expect(progressiveGenerationStages(true)).toEqual([1, 2]);
    expect(progressiveGenerationStages(false)).toEqual([1, 2, 3]);
  });

  it("places the benchmark below the source campaign priority", () => {
    expect(fastV2BenchmarkPriority(9)).toBe(8);
    expect(fastV2BenchmarkPriority(1)).toBe(0);
    expect(fastV2BenchmarkPriority(0)).toBe(0);
  });
});

describe("fast-v2 retained benchmark reports", () => {
  it("separates same-angle first-pass cost from failed URANS retries and unfinished adaptive work", async () => {
    const report = await reportFromRows([
      observation("current-fast", 0, {
        active_seconds: 900,
        attempt_active_seconds: 100,
        attempt_outcome: "failed",
        accepted: false,
        unit_state: "gap",
        work_state: "gap",
      }),
      observation("current-fast", 0, {
        active_seconds: 900,
        attempt_active_seconds: 800,
        attempt_token: "failed-urans-retry",
        attempt_outcome: "failed",
        attempt_started_at: "2026-11-02T00:00:00Z",
        attempt_finished_at: "2026-11-02T00:15:00Z",
        result_attempt_id: "failed-urans-raw",
        evidence_regime: "urans",
        accepted: false,
        unit_state: "gap",
        work_state: "gap",
      }),
      observation("fast-v2", 0, { work_state: "pending" }),
      observation("fast-v2", 14, {
        purpose: "adaptive",
        work_state: "pending",
        unit_state: "leased",
        active_seconds: 0,
        attempt_active_seconds: 0,
        attempt_outcome: "running",
        attempt_finished_at: null,
        result_attempt_id: null,
        accepted: null,
      }),
    ]);
    const comparison = report.cases[0]!;
    expect(report.status).toBe("running");
    expect(comparison.speedup).toBeNull();
    expect(comparison.allAttemptCost).toMatchObject({
      currentFastActiveSeconds: 900,
      fastV2ActiveSeconds: 20,
      settled: false,
    });
    expect(comparison.firstPassTiming.initial).toMatchObject({
      status: "available",
      matchedPoints: 1,
      currentFastActiveSeconds: 100,
      fastV2ActiveSeconds: 20,
      costRatio: 5,
      acceptedPairs: { matchedPoints: 0, costRatio: null },
    });
    expect(
      comparison.firstPassTiming.initial.pairs[0]!.currentFast,
    ).toMatchObject({
      attemptToken: "attempt-current-fast-0",
      resultAttemptId: "raw-current-fast-0",
      outcome: "failed",
      eligible: false,
    });
    expect(comparison.currentFast.counts).toMatchObject({
      failedPoints: 1,
      failedAttempts: 2,
      totalAttempts: 2,
      missingEvidencePoints: 1,
    });
    expect(comparison.fastV2.counts).toMatchObject({
      initialPoints: 1,
      adaptivePoints: 1,
      unfinishedPoints: 1,
      runningAttempts: 1,
    });
    expect(comparison.firstPassTiming.adaptive).toMatchObject({
      status: "unavailable",
      unmatchedAngles: [14],
      costRatio: null,
    });
    expect(comparison.coefficientDeltas).toEqual([]);
    expect(report.summary.finalComparison).toMatchObject({
      status: "unavailable",
      speedup: null,
    });
  });

  it("retains accepted evidence ids and coefficient differences without certifying equal accuracy", async () => {
    const report = await reportFromRows([
      observation("current-fast", 7, {
        attempt_active_seconds: 17.217393023893237,
      }),
      observation("fast-v2", 7, {
        attempt_active_seconds: 16.728055080398917,
        cd: 0.0303144,
      }),
    ]);
    const comparison = report.cases[0]!;
    expect(report.status).toBe("complete");
    expect(
      comparison.firstPassTiming.initial.acceptedPairs.costRatio,
    ).toBeCloseTo(1.02925, 5);
    expect(comparison.coefficientDeltas[0]).toMatchObject({
      alpha: 7,
      currentFastEvidence: {
        resultId: "result-current-fast-7",
        resultAttemptId: "raw-current-fast-7",
        attemptToken: "attempt-current-fast-7",
        purpose: "initial",
      },
      fastV2Evidence: {
        resultId: "result-fast-v2-7",
        resultAttemptId: "raw-fast-v2-7",
        attemptToken: "attempt-fast-v2-7",
        purpose: "initial",
      },
    });
    expect(comparison.coefficientDeltas[0]!.deltaCdPercent).toBeCloseTo(
      51.572,
      5,
    );
    expect(comparison.accuracy).toMatchObject({
      physicalTruthCertified: false,
      matchedPoints: 1,
    });
    expect(comparison.speedup).toBeNull();
    expect(report.summary.finalComparison).toMatchObject({
      status: "available",
      speedup: null,
    });
  });

  it("does not substitute a later accepted attempt for the first failed pass or double-charge evidence rows", async () => {
    const first = observation("current-fast", 0, {
      active_seconds: 150,
      attempt_active_seconds: 100,
      attempt_outcome: "failed",
      accepted: false,
    });
    const retry = observation("current-fast", 0, {
      active_seconds: 150,
      attempt_active_seconds: 50,
      attempt_token: "later-accepted",
      attempt_started_at: "2026-11-02T00:00:00Z",
      attempt_finished_at: "2026-11-02T00:01:00Z",
      result_attempt_id: "later-accepted-raw",
      result_created_at: "2026-11-02T00:01:00Z",
    });
    const report = await reportFromRows([
      retry,
      {
        ...retry,
        result_attempt_id: "later-accepted-raw-second",
        result_created_at: "2026-11-02T00:01:01Z",
      },
      first,
      observation("fast-v2", 0),
    ]);
    const comparison = report.cases[0]!;
    expect(comparison.currentFast).toMatchObject({
      totalPoints: 1,
      activeSeconds: 150,
      acceptedPoints: 1,
      counts: { totalAttempts: 2 },
    });
    expect(comparison.firstPassTiming.initial).toMatchObject({
      currentFastActiveSeconds: 100,
      costRatio: 5,
      acceptedPairs: { matchedPoints: 0 },
    });
    expect(
      comparison.coefficientDeltas[0]!.currentFastEvidence.resultAttemptId,
    ).toBe("later-accepted-raw-second");
    expect(
      comparison.currentFast.units[0]!.attempts[1]!.resultAttemptIds,
    ).toEqual(["later-accepted-raw", "later-accepted-raw-second"]);
  });

  it("keeps missing variants, uninitialized targets and empty campaigns unavailable", async () => {
    const missing = await reportFromRows([observation("current-fast", 0)]);
    expect(missing.summary).toMatchObject({
      missingTargets: 1,
      unfinishedCases: 1,
      finalComparison: { status: "unavailable" },
    });
    expect(missing.cases[0]!.fastV2).toMatchObject({
      complete: false,
      activeSeconds: null,
      totalPoints: 0,
    });
    const uninitialized = await reportFromRows([
      observation("current-fast", 0, { unit_id: null, work_state: "pending" }),
    ]);
    expect(uninitialized.summary).toMatchObject({
      uninitializedTargets: 1,
      finalComparison: { status: "unavailable" },
    });
    const empty = await reportFromRows([]);
    expect(empty).toMatchObject({
      status: "unavailable",
      cases: [],
      summary: {
        totalCases: 0,
        finalComparison: { status: "unavailable", speedup: null },
      },
    });
  });

  it("never pairs rounded angles, different targets, different regimes or initial and adaptive timings", async () => {
    const report = await reportFromRows([
      observation("current-fast", 7),
      observation("fast-v2", 7, { target_id: "target-b" }),
      observation("fast-v2", 7.000001),
      observation("current-fast", 3),
      observation("fast-v2", 3, { purpose: "adaptive" }),
      observation("current-fast", 4),
      observation("fast-v2", 4, { evidence_regime: "urans" }),
    ]);
    expect(report.summary.firstPassTiming.initial.matchedPoints).toBe(0);
    expect(report.summary.firstPassTiming.adaptive.matchedPoints).toBe(0);
    expect(
      report.cases
        .find((item) => item.targetId === "target-a")!
        .coefficientDeltas.map((item) => item.alpha),
    ).toEqual([3, 4]);
    expect(
      report.cases.find((item) => item.targetId === "target-b")!
        .coefficientDeltas,
    ).toEqual([]);
    expect(report.summary.finalComparison.speedup).toBeNull();
  });

  it.each([
    { accepted: false },
    { evidence_aoa_deg: 0.000001 },
    { cd: 0 },
    { cd: -0.1 },
    { cl: NaN },
    { cm: Infinity },
    { result_attempt_id: null },
  ])(
    "excludes ineligible or incompatible coefficient evidence: %j",
    async (overrides) => {
      const report = await reportFromRows([
        observation("current-fast", 0),
        observation("fast-v2", 0, overrides),
      ]);
      expect(report.cases[0]!.coefficientDeltas).toEqual([]);
      expect(report.cases[0]!.fastV2.counts.missingEvidencePoints).toBe(1);
      expect(report.summary.finalComparison.status).toBe("inconclusive");
    },
  );

  it.each([
    { attempt_active_seconds: 0 },
    { attempt_active_seconds: null },
    { attempt_active_seconds: Infinity },
    { attempt_outcome: "running", attempt_finished_at: null },
    { attempt_finished_at: null },
    { result_attempt_id: null },
  ])(
    "does not time a missing, running or unmeasured first attempt: %j",
    async (overrides) => {
      const report = await reportFromRows([
        observation("current-fast", 0),
        observation("fast-v2", 0, overrides),
      ]);
      expect(report.cases[0]!.firstPassTiming.initial).toMatchObject({
        matchedPoints: 0,
        costRatio: null,
      });
      expect(report.summary.finalComparison.speedup).toBeNull();
    },
  );
});

describe("fast-v2 imported measurement reports", () => {
  const plan: FastV2BenchmarkPlan = {
    schema: FAST_V2_BENCHMARK_SCHEMA,
    benchmarkId: "fixture",
    cohort: "low-mach",
    generatedAt: "2026-11-01T00:00:00Z",
    cases: [
      {
        caseId: "case-a",
        mach: 0.1,
        angles: [0],
        airfoilId: null,
        revisionId: null,
        targetId: "target-a",
        setupSignature: "setup",
        recipes: { currentFast: {}, fastV2: {}, precise: {} },
      },
    ],
  };
  const measuredRun = (): FastV2BenchmarkRun => ({
    elapsedSeconds: 100,
    acceptedAngles: [0],
    coefficients: [{ alpha: 0, cl: 0.7, cd: 0.02, cm: null }],
  });

  it("does not turn scalar elapsed totals or unidentified coefficients into timing or accuracy claims", () => {
    const report = buildFastV2BenchmarkReport(plan, {
      schema: FAST_V2_BENCHMARK_SCHEMA,
      benchmarkId: "fixture",
      cases: [
        {
          caseId: "case-a",
          currentFast: measuredRun(),
          fastV2: { ...measuredRun(), elapsedSeconds: 4 },
          preciseReference: measuredRun(),
        },
      ],
    });
    expect(report).toMatchObject({
      status: "inconclusive",
      summary: { measuredCases: 1, medianSpeedup: null },
    });
    expect(report.comparisons[0]).toMatchObject({
      comparison: {
        speedup: null,
        timing: { status: "unavailable" },
        currentFastAgainstPrecise: null,
        fastV2AgainstPrecise: null,
      },
    });
    expect(buildFastV2BenchmarkReport(plan)).toMatchObject({
      status: "plan_only",
      summary: { missingCases: 1, medianSpeedup: null },
    });
  });

  it("compares only eligible retained evidence at the plan's exact physical target and angle", () => {
    const identifiedRun = (attemptToken: string): FastV2BenchmarkRun => ({
      ...measuredRun(),
      targetId: "target-a",
      coefficients: [
        {
          alpha: 0,
          cl: 0.7,
          cd: 0.02,
          cm: null,
          eligible: true,
          resultAttemptId: `raw-${attemptToken}`,
          attemptToken,
          evidenceSignature: "a".repeat(64),
        },
      ],
    });
    const current = identifiedRun("current");
    const reference = identifiedRun("reference");
    const measurement = {
      caseId: "case-a",
      currentFast: current,
      fastV2: identifiedRun("candidate"),
      preciseReference: reference,
    };
    const report = buildFastV2BenchmarkReport(plan, {
      schema: FAST_V2_BENCHMARK_SCHEMA,
      benchmarkId: "fixture",
      cases: [measurement],
    });
    expect(report.comparisons[0]).toMatchObject({
      comparison: {
        currentFastAgainstPrecise: {
          matchedAngles: 1,
          clRmse: 0,
          cmRmse: null,
          physicalTruthCertified: false,
          evidencePairs: [
            {
              resultAttemptId: "raw-current",
              referenceResultAttemptId: "raw-reference",
            },
          ],
        },
      },
    });
    for (const preciseReference of [
      { ...reference, targetId: "different-target" },
      { ...reference, acceptedAngles: [] },
      {
        ...reference,
        coefficients: reference.coefficients.map((coefficient) => ({
          ...coefficient,
          alpha: 0.000001,
        })),
      },
    ]) {
      const mismatched = buildFastV2BenchmarkReport(plan, {
        schema: FAST_V2_BENCHMARK_SCHEMA,
        benchmarkId: "fixture",
        cases: [{ ...measurement, preciseReference }],
      });
      expect(mismatched.comparisons[0]).toMatchObject({
        comparison: { currentFastAgainstPrecise: null },
      });
    }
  });
});
