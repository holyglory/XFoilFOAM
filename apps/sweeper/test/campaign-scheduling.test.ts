// Pure unit tests for the campaign scheduling/refinement decision logic
// (docs/simulation-campaigns-spec.md §7/§8): the one-total-order comparator,
// the oscillation-window convergence rule, the RANS→URANS retry scoping
// decision, and the batched-job grouping rules (per-airfoil-chord batching,
// 2026-07-04). No database — DB-dependent paths are covered in the
// integration test phase.

import {
  CAMPAIGN_MAX_CASES_PER_JOB,
  deriveCampaignPhase,
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

import {
  matchConditionEntryBySpeed,
  type ConditionMapEntry,
  validateRansPrecalcPromotionSignal,
} from "../src/ingest";
import {
  decideRansRetry,
  parseRansRetryScope,
  type RetryEvidenceRow,
} from "../src/retry-plan";

function candidate(overrides: Partial<ScheduleCandidate>): ScheduleCandidate {
  return {
    effectivePriority: 0,
    reynolds: 500_000,
    slug: "naca-0012",
    aoa: 0,
    ...overrides,
  };
}

describe("one total order (spec §7): effectivePriority DESC, reynolds ASC, slug ASC, aoa ASC", () => {
  it("public on-demand (10) always beats the campaign band cap (9)", () => {
    const publicHead = candidate({
      effectivePriority: 10,
      reynolds: 9_000_000,
      slug: "zzz",
      aoa: 20,
    });
    const campaignHead = candidate({
      effectivePriority: 9,
      reynolds: 100_000,
      slug: "aaa",
      aoa: -5,
    });
    expect(compareScheduleCandidates(publicHead, campaignHead)).toBeLessThan(0);
    expect(compareScheduleCandidates(campaignHead, publicHead)).toBeGreaterThan(
      0,
    );
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

describe("RANS→URANS retry scoping: conditional whole-polar preliminary URANS", () => {
  it("MUST-CATCH: an explicit single-angle request remains targeted inside the attached range", () => {
    const decision = decideRansRetry({
      scope: { origin: "explicit-targeted", requestedAoas: [2] },
      jobRows: [
        {
          aoaDeg: 2,
          state: "rejected",
          failureDisposition: "hard_solver",
        },
      ],
    });
    expect(decision).not.toBeNull();
    expect(decision!.retryMode).toBe("targeted-urans");
    expect(decision!.aoas).toEqual([2]);
    expect(decision!.queueCanonicalAoas).toEqual([2]);
  });

  it("MUST-CATCH: a job-local hard rejection in 0..5 promotes the immutable full requested polar", () => {
    const jobRows: RetryEvidenceRow[] = [
      { aoaDeg: 0, state: "accepted" },
      {
        aoaDeg: 2,
        state: "rejected",
        failureDisposition: "hard_solver",
      },
      { aoaDeg: 3, state: "accepted" },
    ];
    const decision = decideRansRetry({
      scope: {
        origin: "continuous-polar",
        requestedAoas: [-4, 0, 2, 3, 6, 12],
      },
      jobRows,
    });
    expect(decision).not.toBeNull();
    expect(decision!.retryMode).toBe("whole-polar-urans");
    expect(decision!.aoas).toEqual([-4, 0, 2, 3, 6, 12]);
    expect(decision!.queueCanonicalAoas).toEqual([2]);
  });

  it.each([0, 5])(
    "includes the %s° boundary in conditional promotion",
    (triggerAoa) => {
      const decision = decideRansRetry({
        scope: { origin: "continuous-polar", requestedAoas: [0, 2, 5, 8] },
        jobRows: [
          {
            aoaDeg: triggerAoa,
            state: "rejected",
            failureDisposition: "hard_solver",
          },
        ],
      });
      expect(decision?.retryMode).toBe("whole-polar-urans");
      expect(decision?.aoas).toEqual([0, 2, 5, 8]);
    },
  );

  it.each([-1, 5.000001, 18])(
    "keeps a hard solver failure at %s° targeted outside inclusive 0..5",
    (triggerAoa) => {
      const decision = decideRansRetry({
        scope: {
          origin: "continuous-polar",
          requestedAoas: [-4, 0, 2, 5, 8, 18],
        },
        jobRows: [
          {
            aoaDeg: triggerAoa,
            state: "rejected",
            failureDisposition: "hard_solver",
          },
        ],
      });
      expect(decision?.retryMode).toBe("invalid-rans-points");
      expect(decision?.aoas).toEqual([triggerAoa]);
    },
  );

  it("does not mistake a three-case scheduler label for explicit single-angle intent", () => {
    const decision = decideRansRetry({
      scope: { origin: "continuous-polar", requestedAoas: [0, 2, 4] },
      jobRows: [
        {
          aoaDeg: 2,
          state: "rejected",
          failureDisposition: "hard_solver",
        },
      ],
    });
    expect(decision?.retryMode).toBe("whole-polar-urans");
    expect(decision?.aoas).toEqual([0, 2, 4]);
  });

  it.each([undefined, {}, { origin: "continuous-polar", requestedAoas: [] }])(
    "FALSE-POSITIVE GUARD: missing or malformed pinned scope fails closed to targeted repair",
    (raw) => {
      const scope = parseRansRetryScope(raw, [0, 2, 4]);
      expect(scope).toEqual({
        origin: "explicit-targeted",
        requestedAoas: [0, 2, 4],
      });
      const decision = decideRansRetry({
        scope,
        jobRows: [
          {
            aoaDeg: 2,
            state: "rejected",
            failureDisposition: "hard_solver",
          },
        ],
      });
      expect(decision?.retryMode).toBe("targeted-urans");
      expect(decision?.aoas).toEqual([2]);
    },
  );

  it("false-positive guard: a fully valid job never retries", () => {
    const decision = decideRansRetry({
      scope: { origin: "continuous-polar", requestedAoas: [0, 2] },
      jobRows: [
        { aoaDeg: 140.01, state: "accepted" },
        { aoaDeg: 141.01, state: "accepted" },
      ],
    });
    expect(decision).toBeNull();
  });

  it("keeps needs_urans-only evidence targeted", () => {
    const decision = decideRansRetry({
      scope: {
        origin: "continuous-polar",
        requestedAoas: [0, 2, 14, 15],
      },
      jobRows: [
        { aoaDeg: 14, state: "needs_urans" },
        { aoaDeg: 15, state: "needs_urans" },
      ],
    });
    expect(decision).not.toBeNull();
    expect(decision!.retryMode).toBe("needs-urans-confirmation");
    expect(decision!.aoas).toEqual([14, 15]);
    expect(decision!.queueCanonicalAoas).toEqual([]);
  });

  it("MUST-CATCH: low-angle alternate-branch confirmations remain exact-angle work", () => {
    const decision = decideRansRetry({
      scope: {
        origin: "continuous-polar",
        requestedAoas: [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5],
      },
      jobRows: [
        { aoaDeg: -5, state: "needs_urans" },
        { aoaDeg: -4, state: "needs_urans" },
        { aoaDeg: -3, state: "accepted" },
        { aoaDeg: 0, state: "accepted" },
        { aoaDeg: 5, state: "accepted" },
      ],
    });
    expect(decision).not.toBeNull();
    expect(decision!.retryMode).toBe("needs-urans-confirmation");
    expect(decision!.aoas).toEqual([-5, -4]);
    expect(decision!.queueCanonicalAoas).toEqual([]);
  });

  it.each(["infrastructure", "deterministic_mesh"] as const)(
    "FALSE-POSITIVE GUARD: %s rejection neither promotes nor routes to URANS",
    (failureDisposition) => {
      const decision = decideRansRetry({
        scope: { origin: "continuous-polar", requestedAoas: [0, 2, 4, 8] },
        jobRows: [
          {
            aoaDeg: 2,
            state: "rejected",
            failureDisposition,
          },
          { aoaDeg: 4, state: "accepted" },
        ],
      });
      expect(decision).toBeNull();
    },
  );

  it("FALSE-POSITIVE GUARD: legacy error-free rejected evidence stays targeted and cannot widen the polar", () => {
    const decision = decideRansRetry({
      scope: { origin: "continuous-polar", requestedAoas: [0, 2, 4, 8] },
      jobRows: [
        {
          aoaDeg: 2,
          state: "rejected",
          reasons: ["not-converged", "solver-stalled"],
          error: null,
        },
      ],
    });
    expect(decision?.retryMode).toBe("invalid-rans-points");
    expect(decision?.aoas).toEqual([2]);
    expect(decision?.queueCanonicalAoas).toEqual([2]);
    expect(decision?.hardRejectedCount).toBe(0);
  });

  it.each([
    {
      label: "untyped mesh-shaped rejection",
      failureDisposition: null,
      reasons: ["missing-coefficients"],
      error: "mesh failed before coefficients were available",
    },
    {
      label: "untyped infrastructure-shaped rejection",
      failureDisposition: null,
      reasons: ["missing-coefficients"],
      error: "engine connection lost before coefficients were available",
    },
    {
      label: "typed deterministic mesh rejection",
      failureDisposition: "deterministic_mesh" as const,
      reasons: ["not-converged", "solver-stalled"],
      error: null,
    },
    {
      label: "typed infrastructure rejection",
      failureDisposition: "infrastructure" as const,
      reasons: ["not-converged", "solver-stalled"],
      error: null,
    },
  ])(
    "FALSE-POSITIVE GUARD: $label does not enter the RANS→PRECALC route",
    ({ failureDisposition, reasons, error }) => {
      expect(
        decideRansRetry({
          scope: {
            origin: "continuous-polar",
            requestedAoas: [0, 2, 4, 8],
          },
          jobRows: [
            {
              aoaDeg: 2,
              state: "rejected",
              failureDisposition,
              reasons,
              error,
            },
          ],
        }),
      ).toBeNull();
    },
  );

  it("FALSE-POSITIVE GUARD: sparse/tiny evidence alone never widens a high-angle retry", () => {
    const decision = decideRansRetry({
      scope: {
        origin: "continuous-polar",
        requestedAoas: [-4, 0, 4, 8, 12, 16],
      },
      jobRows: [
        { aoaDeg: 0, state: "accepted" },
        {
          aoaDeg: 12,
          state: "rejected",
          failureDisposition: "hard_solver",
        },
      ],
    });
    expect(decision?.retryMode).toBe("invalid-rans-points");
    expect(decision?.aoas).toEqual([12]);
  });

  it("superseded_by_urans angles never retry (the URANS replacement already landed)", () => {
    const decision = decideRansRetry({
      scope: { origin: "continuous-polar", requestedAoas: [14, 15] },
      jobRows: [
        { aoaDeg: 14, state: "superseded_by_urans" },
        { aoaDeg: 15, state: "accepted" },
      ],
    });
    expect(decision).toBeNull();
  });
});

describe("engine early-abort accounting", () => {
  const valid = {
    trigger_aoa_deg: 2,
    failure_disposition: "hard_solver" as const,
    attempted_aoas: [0, 2],
    intentionally_omitted_aoas: [4, 8],
  };

  it("accepts an exact partition of the engine job's requested angles", () => {
    expect(
      validateRansPrecalcPromotionSignal({
        promotion: valid,
        stagedAttemptAoas: [0, 2],
        triggerFailureDisposition: "hard_solver",
        jobAoas: [0, 2, 4, 8],
      }),
    ).toEqual({ attemptedAoas: [0, 2], intentionallyOmittedAoas: [4, 8] });
  });

  it("MUST-CATCH: accepts the production zero-anchored 0..5 abort before the negative branch", () => {
    const jobAoas = Array.from({ length: 26 }, (_, index) => index - 5);
    const attemptedAoas = [0, 1, 2, 3, 4, 5];
    const intentionallyOmittedAoas = [
      -5, -4, -3, -2, -1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
      19, 20,
    ];
    expect(
      validateRansPrecalcPromotionSignal({
        promotion: {
          trigger_aoa_deg: 5,
          failure_disposition: "hard_solver",
          attempted_aoas: attemptedAoas,
          intentionally_omitted_aoas: intentionallyOmittedAoas,
        },
        stagedAttemptAoas: attemptedAoas,
        triggerFailureDisposition: "hard_solver",
        jobAoas,
      }),
    ).toEqual({ attemptedAoas, intentionallyOmittedAoas });
  });

  it("FALSE-POSITIVE GUARD: rejects numerically sorted attempts that contradict the zero-anchored marcher", () => {
    const jobAoas = Array.from({ length: 26 }, (_, index) => index - 5);
    expect(
      validateRansPrecalcPromotionSignal({
        promotion: {
          trigger_aoa_deg: 5,
          failure_disposition: "hard_solver",
          attempted_aoas: [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5],
          intentionally_omitted_aoas: [
            6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
          ],
        },
        stagedAttemptAoas: [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5],
        triggerFailureDisposition: "hard_solver",
        jobAoas,
      }),
    ).toBeNull();
  });

  it.each([
    {
      name: "missing staged attempt",
      stagedAttemptAoas: [2],
      jobAoas: [0, 2, 4, 8],
    },
    {
      name: "invented omitted angle",
      stagedAttemptAoas: [0, 2],
      jobAoas: [0, 2, 4],
    },
    {
      name: "missing omitted angle",
      stagedAttemptAoas: [0, 2],
      jobAoas: [0, 2, 4, 8, 10],
    },
  ])(
    "FALSE-POSITIVE GUARD: rejects $name",
    ({ stagedAttemptAoas, jobAoas }) => {
      expect(
        validateRansPrecalcPromotionSignal({
          promotion: valid,
          stagedAttemptAoas,
          triggerFailureDisposition: "hard_solver",
          jobAoas,
        }),
      ).toBeNull();
    },
  );

  it("MUST-CATCH: rejects a non-contiguous attempted set before the trigger", () => {
    expect(
      validateRansPrecalcPromotionSignal({
        promotion: {
          trigger_aoa_deg: 0,
          failure_disposition: "hard_solver",
          attempted_aoas: [0, 4],
          intentionally_omitted_aoas: [2, 8],
        },
        stagedAttemptAoas: [0, 4],
        triggerFailureDisposition: "hard_solver",
        jobAoas: [0, 2, 4, 8],
      }),
    ).toBeNull();
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
  uransMeshId?: string;
  uransMeshSurface?: number;
  uransPrecalcMeshId?: string;
  uransPrecalcMeshSurface?: number;
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
    mesh: {
      id: overrides.meshId ?? "mesh-a",
      slug: "mesh-a",
      name: "Mesh A",
      nSurface: overrides.nSurface ?? 220,
      nRadial: 90,
    },
    uransMesh:
      overrides.uransMeshSurface == null
        ? null
        : {
            id: overrides.uransMeshId ?? "urans-mesh-a",
            slug: "urans-mesh-a",
            name: "URANS Mesh A",
            nSurface: overrides.uransMeshSurface,
            nRadial: 120,
          },
    uransPrecalcMesh:
      overrides.uransPrecalcMeshSurface == null
        ? null
        : {
            id: overrides.uransPrecalcMeshId ?? "urans-precalc-mesh-a",
            slug: "urans-precalc-mesh-a",
            name: "URANS Precalc Mesh A",
            nSurface: overrides.uransPrecalcMeshSurface,
            nRadial: 45,
          },
    solver: {
      id: overrides.solverId ?? "solver-a",
      slug: "solver-a",
      name: "Solver A",
      turbulenceModel: "kOmegaSST",
      nIterations: overrides.nIterations ?? 3000,
    },
    output: {
      id: "output-a",
      slug: "output-a",
      name: "Output A",
      imageZoomChords: overrides.outputZoom ?? 2,
    },
  };
}

function candidateFor(
  conditionId: string,
  speedMps: number,
  aoas: number[],
  snapshotOverrides: Parameters<typeof batchSnapshot>[0] = { speedMps },
): CampaignConditionCandidate {
  const chord = snapshotOverrides.chordM ?? 0.2;
  const nu =
    (snapshotOverrides.dynamicViscosity ?? 1.789e-5) /
    (snapshotOverrides.density ?? 1.225);
  return {
    conditionId,
    revisionId: `rev-${conditionId}`,
    presetId: `preset-${conditionId}`,
    reynolds: Math.round((speedMps * chord) / nu),
    aoas,
    requestedPolarAoas: aoas,
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
    expect(grouped.entries.map((e) => e.conditionId)).toEqual([
      "c10",
      "c20",
      "c30",
    ]);
    expect(grouped.entries.map((e) => e.speed)).toEqual([10, 20, 30]);
    expect(grouped.entries[0].reynolds).toBeLessThan(
      grouped.entries[1].reynolds,
    );
    expect(grouped.chord).toBe(0.2);
    expect(grouped.angles).toEqual(angles);
  });

  it("MUST-CATCH: different ambients never share a job (fluid state is per-request)", () => {
    const head = candidateFor("c10", 10, angles);
    const coldT = candidateFor("cT", 20, angles, {
      speedMps: 20,
      temperatureK: 255.65,
    });
    const lowP = candidateFor("cP", 20, angles, {
      speedMps: 20,
      pressurePa: 54050,
    });
    const denser = candidateFor("cRho", 20, angles, {
      speedMps: 20,
      density: 1.5,
    });
    const stickier = candidateFor("cMu", 20, angles, {
      speedMps: 20,
      dynamicViscosity: 2.1e-5,
    });
    const grouped = groupCampaignBatchEntries(head, [
      head,
      coldT,
      lowP,
      denser,
      stickier,
    ]);
    expect(grouped.entries.map((e) => e.conditionId)).toEqual(["c10"]);
  });

  it("MUST-CATCH: different open-angle sets never share a job (ONE aoa list per request)", () => {
    const head = candidateFor("c10", 10, angles);
    const partiallySolved = candidateFor("c20", 20, [1, 2, 3]); // 0° already solved
    const extraAngle = candidateFor("c30", 30, [...angles, 4]);
    const grouped = groupCampaignBatchEntries(head, [
      head,
      partiallySolved,
      extraAngle,
    ]);
    expect(grouped.entries.map((e) => e.conditionId)).toEqual(["c10"]);
  });

  it("MUST-CATCH: single chord per job — a different chord never shares the mesh group", () => {
    const head = candidateFor("c10", 10, angles);
    const otherChord = candidateFor("cChord", 20, angles, {
      speedMps: 20,
      chordM: 0.4,
    });
    const grouped = groupCampaignBatchEntries(head, [head, otherChord]);
    expect(grouped.entries.map((e) => e.conditionId)).toEqual(["c10"]);
  });

  it("different mesh/solver/boundary/output VALUES never share a job", () => {
    const head = candidateFor("c10", 10, angles);
    const mesh = candidateFor("cMesh", 20, angles, {
      speedMps: 20,
      nSurface: 300,
    });
    const uransMesh = candidateFor("cUransMesh", 20, angles, {
      speedMps: 20,
      uransMeshSurface: 300,
    });
    const uransPrecalcMesh = candidateFor("cUransPrecalcMesh", 20, angles, {
      speedMps: 20,
      uransPrecalcMeshSurface: 80,
    });
    const solver = candidateFor("cSolver", 20, angles, {
      speedMps: 20,
      nIterations: 5000,
    });
    const boundary = candidateFor("cBc", 20, angles, {
      speedMps: 20,
      boundaryIntensity: 0.1,
    });
    const output = candidateFor("cOut", 20, angles, {
      speedMps: 20,
      outputZoom: 4,
    });
    const grouped = groupCampaignBatchEntries(head, [
      head,
      mesh,
      uransMesh,
      uransPrecalcMesh,
      solver,
      boundary,
      output,
    ]);
    expect(grouped.entries.map((e) => e.conditionId)).toEqual(["c10"]);
  });

  it("false-positive guard: value-identical numerics with different profile row ids DO share (identity is excluded)", () => {
    const head = candidateFor("c10", 10, angles);
    const sameValuesOtherRows = candidateFor("c20", 20, angles, {
      speedMps: 20,
      meshId: "mesh-b",
      solverId: "solver-b",
    });
    expect(campaignBatchGroupKey(head.snapshot)).toBe(
      campaignBatchGroupKey(sameValuesOtherRows.snapshot),
    );
    const grouped = groupCampaignBatchEntries(head, [
      head,
      sameValuesOtherRows,
    ]);
    expect(grouped.entries.map((e) => e.conditionId)).toEqual(["c10", "c20"]);
  });

  it("false-positive guard: value-identical per-tier URANS mesh pins with different row ids DO share", () => {
    const head = candidateFor("c10", 10, angles, {
      speedMps: 10,
      uransMeshSurface: 260,
      uransPrecalcMeshSurface: 90,
    });
    const sameValuesOtherRows = candidateFor("c20", 20, angles, {
      speedMps: 20,
      uransMeshId: "urans-mesh-b",
      uransMeshSurface: 260,
      uransPrecalcMeshId: "urans-precalc-mesh-b",
      uransPrecalcMeshSurface: 90,
    });
    expect(campaignBatchGroupKey(head.snapshot)).toBe(
      campaignBatchGroupKey(sameValuesOtherRows.snapshot),
    );
    const grouped = groupCampaignBatchEntries(head, [
      head,
      sameValuesOtherRows,
    ]);
    expect(grouped.entries.map((e) => e.conditionId)).toEqual(["c10", "c20"]);
  });

  it("budget chunking: speeds × angles ≤ 256, greedy by reynolds ASC, min 1 speed", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      conditionId: `c${i}`,
      revisionId: `r${i}`,
      presetId: `p${i}`,
      speed: 5 + i,
      reynolds: 10_000 * (i + 1),
      requestedPolarAoas: angles,
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
    {
      conditionId: "c10",
      revisionId: "r10",
      presetId: "p10",
      speed: 10,
      reynolds: 137_000,
      bcId: "bc10",
    },
    {
      conditionId: "c12",
      revisionId: "r12",
      presetId: "p12",
      speed: 12.345,
      reynolds: 169_000,
      bcId: "bc12",
    },
  ];

  it("maps a polar back to its condition by exact canonical speed", () => {
    expect(matchConditionEntryBySpeed(entries, 10)?.conditionId).toBe("c10");
    // float dust from the engine's JSON round trip canonicalizes away
    expect(
      matchConditionEntryBySpeed(entries, 12.345000000000002)?.conditionId,
    ).toBe("c12");
    expect(matchConditionEntryBySpeed(entries, 12.3450004)?.conditionId).toBe(
      "c12",
    ); // rounds to 12.345
  });

  it("MUST-CATCH: never nearest-guesses — an unmatched speed returns null", () => {
    expect(matchConditionEntryBySpeed(entries, 12.346)).toBeNull();
    expect(matchConditionEntryBySpeed(entries, 11)).toBeNull();
    expect(matchConditionEntryBySpeed([], 10)).toBeNull();
  });
});

describe("campaign phase derivation (fidelity ladder contract 7 — derived, no stored enum)", () => {
  const tiers = (
    ransOpen: number,
    precalcOpen: number,
    verifyOpen: number,
  ) => ({ ransOpen, precalcOpen, verifyOpen });

  it("walks running_rans → running_precalc → running_refinement → completed as tiers drain", () => {
    expect(deriveCampaignPhase("active", tiers(5, 2, 1))).toBe("running_rans");
    expect(deriveCampaignPhase("active", tiers(0, 2, 1))).toBe(
      "running_precalc",
    );
    expect(deriveCampaignPhase("active", tiers(0, 0, 1))).toBe(
      "running_refinement",
    );
    expect(deriveCampaignPhase("active", tiers(0, 0, 0))).toBe("completed");
    expect(deriveCampaignPhase("completed", tiers(0, 0, 0))).toBe("completed");
  });

  it("non-running statuses carry no ladder phase; attention reports open tiers honestly", () => {
    expect(deriveCampaignPhase("paused", tiers(3, 0, 0))).toBeNull();
    expect(deriveCampaignPhase("cancelled", tiers(0, 0, 0))).toBeNull();
    expect(deriveCampaignPhase("archived", tiers(0, 0, 0))).toBeNull();
    expect(deriveCampaignPhase("attention", tiers(0, 0, 2))).toBe(
      "running_refinement",
    );
    expect(deriveCampaignPhase("attention", tiers(0, 0, 0))).toBeNull();
  });
});
