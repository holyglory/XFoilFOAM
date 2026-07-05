// Pure unit tests for the campaign scheduling/refinement decision logic
// (docs/simulation-campaigns-spec.md §7/§8): the one-total-order comparator,
// the oscillation-window convergence rule, the RANS→URANS retry scoping
// decision, and the batched-job grouping rules (per-airfoil-chord batching,
// 2026-07-04). No database — DB-dependent paths are covered in the
// integration test phase.

import {
  CAMPAIGN_MAX_CASES_PER_JOB,
  type CampaignBatchSnapshot,
  type CampaignConditionCandidate,
  campaignBatchGroupKey,
  chunkCampaignSpeeds,
  compareScheduleCandidates,
  groupCampaignBatchEntries,
  isOscillationConverged,
  type ScheduleCandidate,
} from "@aerodb/db";
import { describe, expect, it } from "vitest";

import { matchConditionEntryBySpeed, type ConditionMapEntry } from "../src/ingest";
import { decideRansRetry, type RetryEvidenceRow } from "../src/retry-plan";

function candidate(overrides: Partial<ScheduleCandidate>): ScheduleCandidate {
  return { effectivePriority: 0, reynolds: 500_000, slug: "naca-0012", aoa: 0, ...overrides };
}

describe("one total order (spec §7): effectivePriority DESC, reynolds ASC, slug ASC, aoa ASC", () => {
  it("public on-demand (10) always beats the campaign band cap (9)", () => {
    const publicHead = candidate({ effectivePriority: 10, reynolds: 9_000_000, slug: "zzz", aoa: 20 });
    const campaignHead = candidate({ effectivePriority: 9, reynolds: 100_000, slug: "aaa", aoa: -5 });
    expect(compareScheduleCandidates(publicHead, campaignHead)).toBeLessThan(0);
    expect(compareScheduleCandidates(campaignHead, publicHead)).toBeGreaterThan(0);
  });

  it("a campaign head outranks default-priority continuous gaps", () => {
    const continuous = candidate({ effectivePriority: 0, reynolds: 100_000 });
    const campaign = candidate({ effectivePriority: 5, reynolds: 5_000_000 });
    expect(compareScheduleCandidates(campaign, continuous)).toBeLessThan(0);
  });

  it("breaks priority ties by reynolds ASC, then slug ASC, then aoa ASC", () => {
    const a = candidate({ effectivePriority: 5, reynolds: 100_000 });
    const b = candidate({ effectivePriority: 5, reynolds: 200_000 });
    expect(compareScheduleCandidates(a, b)).toBeLessThan(0);

    const c = candidate({ effectivePriority: 5, slug: "ag24" });
    const d = candidate({ effectivePriority: 5, slug: "naca-0012" });
    expect(compareScheduleCandidates(c, d)).toBeLessThan(0);

    const e = candidate({ effectivePriority: 5, aoa: -8 });
    const f = candidate({ effectivePriority: 5, aoa: 12 });
    expect(compareScheduleCandidates(e, f)).toBeLessThan(0);
    expect(compareScheduleCandidates(f, f)).toBe(0);
  });
});

describe("oscillation window (spec §8 step 4): last 3 predictions within 2·tolerance", () => {
  it("converges when the last three predictions cluster inside the window", () => {
    expect(isOscillationConverged([5.2, 5.25, 5.3], 0.1)).toBe(true);
    // Only the LAST three matter — an early outlier does not block the window.
    expect(isOscillationConverged([2.0, 5.2, 5.25, 5.3], 0.1)).toBe(true);
    expect(isOscillationConverged([5.2, 5.3, 5.4], 0.1)).toBe(true); // exactly 2·tol
  });

  it("does not converge on wide oscillation or with fewer than 3 predictions", () => {
    expect(isOscillationConverged([5.0, 5.5, 6.0], 0.1)).toBe(false);
    expect(isOscillationConverged([5.2, 5.25], 0.1)).toBe(false);
    expect(isOscillationConverged([], 0.1)).toBe(false);
  });
});

describe("RANS→URANS retry scoping (spec §7): revision-wide heuristics, targeted isolation", () => {
  const healthyRevision: RetryEvidenceRow[] = Array.from({ length: 20 }, (_, i) => ({
    aoaDeg: i - 4,
    state: "accepted" as const,
  }));

  it("MUST-CATCH: a single-angle targeted job does NOT trigger whole-polar URANS when revision-wide evidence is healthy", () => {
    const decision = decideRansRetry({
      jobKind: "targeted",
      jobRows: [{ aoaDeg: 12.3, state: "rejected" }],
      revisionRows: healthyRevision,
    });
    expect(decision).not.toBeNull();
    expect(decision!.fullUrans).toBe(false);
    expect(decision!.retryMode).toBe("targeted-urans");
    expect(decision!.aoas).toEqual([12.3]);
    expect(decision!.queueCanonicalAoas).toEqual([12.3]);
  });

  it("MUST-CATCH: a single-angle SWEEP job on a healthy revision also stays targeted (the old job-local '<5 valid' rule would have whole-polar'd it)", () => {
    const decision = decideRansRetry({
      jobKind: "sweep",
      jobRows: [{ aoaDeg: 12.3, state: "rejected" }],
      revisionRows: healthyRevision,
    });
    expect(decision).not.toBeNull();
    expect(decision!.fullUrans).toBe(false);
    expect(decision!.retryMode).toBe("invalid-rans-points");
    expect(decision!.aoas).toEqual([12.3]);
  });

  it("promotes a sweep job to whole-polar URANS when the revision has fewer than 5 valid points", () => {
    const jobRows: RetryEvidenceRow[] = [
      { aoaDeg: 0, state: "accepted" },
      { aoaDeg: 1, state: "rejected" },
      { aoaDeg: 2, state: "rejected" },
      { aoaDeg: 3, state: "accepted" },
      { aoaDeg: 4, state: "rejected" },
    ];
    const decision = decideRansRetry({ jobKind: "sweep", jobRows, revisionRows: jobRows });
    expect(decision).not.toBeNull();
    expect(decision!.fullUrans).toBe(true);
    expect(decision!.retryMode).toBe("whole-polar-urans");
    expect(decision!.aoas).toEqual([0, 1, 2, 3, 4]);
    expect(decision!.queueCanonicalAoas).toEqual([0, 1, 2, 3, 4]);
  });

  it("applies the 0..5° whole-polar rule at revision scope for sweep jobs", () => {
    const decision = decideRansRetry({
      jobKind: "sweep",
      jobRows: [{ aoaDeg: 18, state: "rejected" }],
      revisionRows: [...healthyRevision.filter((r) => r.aoaDeg !== 2), { aoaDeg: 2, state: "rejected" }],
    });
    expect(decision).not.toBeNull();
    expect(decision!.fullUrans).toBe(true);
    expect(decision!.retryMode).toBe("whole-polar-urans");
  });

  it("targeted jobs escalate only their own angles even when the revision has a 0..5° rejection", () => {
    const decision = decideRansRetry({
      jobKind: "targeted",
      jobRows: [{ aoaDeg: 18, state: "rejected" }],
      revisionRows: [...healthyRevision.filter((r) => r.aoaDeg !== 2), { aoaDeg: 2, state: "rejected" }],
    });
    expect(decision).not.toBeNull();
    expect(decision!.fullUrans).toBe(false);
    expect(decision!.aoas).toEqual([18]);
  });

  it("false-positive guard: mixed refinement grids (fractional lane angles) do not shatter the longest-run detection", () => {
    // Base sweep 0..14 at 1° plus two fractional refinement angles: with a
    // min-diff step the 1° gaps would break every run; the median step keeps
    // the polar recognized as healthy.
    const revisionRows: RetryEvidenceRow[] = [
      ...Array.from({ length: 15 }, (_, i) => ({ aoaDeg: i, state: "accepted" as const })),
      { aoaDeg: 5.23, state: "accepted" },
      { aoaDeg: 5.31, state: "accepted" },
      { aoaDeg: 16, state: "rejected" },
    ];
    const decision = decideRansRetry({
      jobKind: "sweep",
      jobRows: [{ aoaDeg: 16, state: "rejected" }],
      revisionRows,
    });
    expect(decision).not.toBeNull();
    expect(decision!.fullUrans).toBe(false);
    expect(decision!.aoas).toEqual([16]);
  });

  it("false-positive guard: a fully valid job never retries, regardless of revision health", () => {
    const decision = decideRansRetry({
      jobKind: "sweep",
      jobRows: [
        { aoaDeg: 140.01, state: "accepted" },
        { aoaDeg: 141.01, state: "accepted" },
      ],
      revisionRows: [
        { aoaDeg: 0, state: "rejected" }, // unhealthy revision elsewhere
        { aoaDeg: 140.01, state: "accepted" },
        { aoaDeg: 141.01, state: "accepted" },
      ],
    });
    expect(decision).toBeNull();
  });

  it("keeps needs_urans confirmation angles alongside hard rejections for sweep jobs", () => {
    const revisionRows: RetryEvidenceRow[] = [
      ...Array.from({ length: 14 }, (_, i) => ({ aoaDeg: i, state: "accepted" as const })),
      { aoaDeg: 14, state: "needs_urans" },
      { aoaDeg: 15, state: "needs_urans" },
    ];
    const decision = decideRansRetry({
      jobKind: "sweep",
      jobRows: [
        { aoaDeg: 14, state: "needs_urans" },
        { aoaDeg: 15, state: "needs_urans" },
        { aoaDeg: 16, state: "rejected" },
      ],
      revisionRows,
    });
    expect(decision).not.toBeNull();
    expect(decision!.fullUrans).toBe(false);
    expect(decision!.retryMode).toBe("needs-urans-confirmation");
    expect(decision!.aoas).toEqual([14, 15, 16]);
    expect(decision!.queueCanonicalAoas).toEqual([16]);
  });
});

// ---------------------------------------------------------------------------
// Batched campaign jobs (execution-efficiency decision 2026-07-04): one job =
// (campaign, airfoil, chord, compatible physics group, identical open-angle
// set) × all its open speeds, with a 256-case budget.
// ---------------------------------------------------------------------------

function batchSnapshot(overrides: {
  speedMps: number;
  temperatureK?: number;
  pressurePa?: number;
  density?: number;
  dynamicViscosity?: number;
  chordM?: number;
  meshId?: string;
  nSurface?: number;
  solverId?: string;
  nIterations?: number;
  boundaryIntensity?: number;
  outputZoom?: number;
}): CampaignBatchSnapshot {
  return {
    preset: { legacyBoundaryConditionId: null },
    flowState: {
      mediumId: "medium-air",
      temperatureK: overrides.temperatureK ?? 288.15,
      pressurePa: overrides.pressurePa ?? 101325,
      speedMps: overrides.speedMps,
      density: overrides.density ?? 1.225,
      dynamicViscosity: overrides.dynamicViscosity ?? 1.789e-5,
      mach: null,
    },
    referenceGeometry: {
      geometryType: "airfoil_2d",
      referenceLengthKind: "chord",
      referenceLengthM: overrides.chordM ?? 0.2,
      spanM: 1,
      referenceAreaM2: null,
    },
    boundary: {
      turbulenceIntensity: overrides.boundaryIntensity ?? 0.05,
      viscosityRatio: 10,
      sandGrainHeight: 0,
      roughnessConstant: 0.5,
    },
    mesh: { id: overrides.meshId ?? "mesh-a", slug: "mesh-a", name: "Mesh A", nSurface: overrides.nSurface ?? 220, nRadial: 90 },
    solver: { id: overrides.solverId ?? "solver-a", slug: "solver-a", name: "Solver A", turbulenceModel: "kOmegaSST", nIterations: overrides.nIterations ?? 3000 },
    output: { id: "output-a", slug: "output-a", name: "Output A", imageZoomChords: overrides.outputZoom ?? 2 },
  };
}

function candidateFor(
  conditionId: string,
  speedMps: number,
  aoas: number[],
  snapshotOverrides: Parameters<typeof batchSnapshot>[0] = { speedMps },
): CampaignConditionCandidate {
  const chord = snapshotOverrides.chordM ?? 0.2;
  const nu = (snapshotOverrides.dynamicViscosity ?? 1.789e-5) / (snapshotOverrides.density ?? 1.225);
  return {
    conditionId,
    revisionId: `rev-${conditionId}`,
    presetId: `preset-${conditionId}`,
    reynolds: Math.round((speedMps * chord) / nu),
    aoas,
    snapshot: batchSnapshot({ ...snapshotOverrides, speedMps }),
  };
}

describe("batched campaign job grouping (binding rules 1–4)", () => {
  const angles = [0, 1, 2, 3];

  it("groups all open speeds of one ambient/chord/angle-set into one job, reynolds ASC", () => {
    const head = candidateFor("c10", 10, angles);
    const grouped = groupCampaignBatchEntries(head, [
      candidateFor("c30", 30, angles),
      head,
      candidateFor("c20", 20, angles),
    ]);
    expect(grouped.entries.map((e) => e.conditionId)).toEqual(["c10", "c20", "c30"]);
    expect(grouped.entries.map((e) => e.speed)).toEqual([10, 20, 30]);
    expect(grouped.entries[0].reynolds).toBeLessThan(grouped.entries[1].reynolds);
    expect(grouped.chord).toBe(0.2);
    expect(grouped.angles).toEqual(angles);
  });

  it("MUST-CATCH: different ambients never share a job (fluid state is per-request)", () => {
    const head = candidateFor("c10", 10, angles);
    const coldT = candidateFor("cT", 20, angles, { speedMps: 20, temperatureK: 255.65 });
    const lowP = candidateFor("cP", 20, angles, { speedMps: 20, pressurePa: 54050 });
    const denser = candidateFor("cRho", 20, angles, { speedMps: 20, density: 1.5 });
    const stickier = candidateFor("cMu", 20, angles, { speedMps: 20, dynamicViscosity: 2.1e-5 });
    const grouped = groupCampaignBatchEntries(head, [head, coldT, lowP, denser, stickier]);
    expect(grouped.entries.map((e) => e.conditionId)).toEqual(["c10"]);
  });

  it("MUST-CATCH: different open-angle sets never share a job (ONE aoa list per request)", () => {
    const head = candidateFor("c10", 10, angles);
    const partiallySolved = candidateFor("c20", 20, [1, 2, 3]); // 0° already solved
    const extraAngle = candidateFor("c30", 30, [...angles, 4]);
    const grouped = groupCampaignBatchEntries(head, [head, partiallySolved, extraAngle]);
    expect(grouped.entries.map((e) => e.conditionId)).toEqual(["c10"]);
  });

  it("MUST-CATCH: single chord per job — a different chord never shares the mesh group", () => {
    const head = candidateFor("c10", 10, angles);
    const otherChord = candidateFor("cChord", 20, angles, { speedMps: 20, chordM: 0.4 });
    const grouped = groupCampaignBatchEntries(head, [head, otherChord]);
    expect(grouped.entries.map((e) => e.conditionId)).toEqual(["c10"]);
  });

  it("different mesh/solver/boundary/output VALUES never share a job", () => {
    const head = candidateFor("c10", 10, angles);
    const mesh = candidateFor("cMesh", 20, angles, { speedMps: 20, nSurface: 300 });
    const solver = candidateFor("cSolver", 20, angles, { speedMps: 20, nIterations: 5000 });
    const boundary = candidateFor("cBc", 20, angles, { speedMps: 20, boundaryIntensity: 0.1 });
    const output = candidateFor("cOut", 20, angles, { speedMps: 20, outputZoom: 4 });
    const grouped = groupCampaignBatchEntries(head, [head, mesh, solver, boundary, output]);
    expect(grouped.entries.map((e) => e.conditionId)).toEqual(["c10"]);
  });

  it("false-positive guard: value-identical numerics with different profile row ids DO share (identity is excluded)", () => {
    const head = candidateFor("c10", 10, angles);
    const sameValuesOtherRows = candidateFor("c20", 20, angles, { speedMps: 20, meshId: "mesh-b", solverId: "solver-b" });
    expect(campaignBatchGroupKey(head.snapshot)).toBe(campaignBatchGroupKey(sameValuesOtherRows.snapshot));
    const grouped = groupCampaignBatchEntries(head, [head, sameValuesOtherRows]);
    expect(grouped.entries.map((e) => e.conditionId)).toEqual(["c10", "c20"]);
  });

  it("budget chunking: speeds × angles ≤ 256, greedy by reynolds ASC, min 1 speed", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      conditionId: `c${i}`,
      revisionId: `r${i}`,
      presetId: `p${i}`,
      speed: 5 + i,
      reynolds: 10_000 * (i + 1),
    }));
    // 10 angles → floor(256/10) = 25 speeds.
    const chunk = chunkCampaignSpeeds(entries, 10);
    expect(chunk.length).toBe(25);
    expect(chunk[0].conditionId).toBe("c0"); // min-Re anchor always in the head chunk
    expect(chunk.length * 10).toBeLessThanOrEqual(CAMPAIGN_MAX_CASES_PER_JOB);
    // A giant angle set still gets one speed (never zero).
    expect(chunkCampaignSpeeds(entries, 300).length).toBe(1);
    // Small groups are untouched.
    expect(chunkCampaignSpeeds(entries.slice(0, 3), 4).length).toBe(3);
  });
});

describe("batched ingest speed→condition mapping (canonical float equality)", () => {
  const entries: ConditionMapEntry[] = [
    { conditionId: "c10", revisionId: "r10", presetId: "p10", speed: 10, reynolds: 137_000, bcId: "bc10" },
    { conditionId: "c12", revisionId: "r12", presetId: "p12", speed: 12.345, reynolds: 169_000, bcId: "bc12" },
  ];

  it("maps a polar back to its condition by exact canonical speed", () => {
    expect(matchConditionEntryBySpeed(entries, 10)?.conditionId).toBe("c10");
    // float dust from the engine's JSON round trip canonicalizes away
    expect(matchConditionEntryBySpeed(entries, 12.345000000000002)?.conditionId).toBe("c12");
    expect(matchConditionEntryBySpeed(entries, 12.3450004)?.conditionId).toBe("c12"); // rounds to 12.345
  });

  it("MUST-CATCH: never nearest-guesses — an unmatched speed returns null", () => {
    expect(matchConditionEntryBySpeed(entries, 12.346)).toBeNull();
    expect(matchConditionEntryBySpeed(entries, 11)).toBeNull();
    expect(matchConditionEntryBySpeed([], 10)).toBeNull();
  });
});
