import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  resolveProgressiveReportedPoint,
  sealProgressiveRemoteExecution,
  type ProgressiveRemoteReport,
} from "@aerodb/db";
import {
  OPENCFD_2606_ENGINE,
  type JobResult,
  type PolarPoint,
} from "@aerodb/engine-client";
import { progressiveRemotePointProjection } from "@aerodb/db";

function fixture(transient = false, localDensity = false) {
  const speed = localDensity ? 1020 : 30;
  const executionId = randomUUID();
  const token = randomUUID();
  const envelope = sealProgressiveRemoteExecution({
    solverId: randomUUID(),
    promiseId: randomUUID(),
    scope: {
      executionContract: "progressive-cfd-v1",
      executionId,
      epochId: randomUUID(),
      generationId: randomUUID(),
      targetId: "a".repeat(64),
      recipeId: "b".repeat(64),
      stage: 2,
      tokens: [token],
      units: [
        { unitId: randomUUID(), token, alpha: 0, activeBudgetSeconds: 900 },
      ],
    },
    request: {
      execution_id: executionId,
      expected_engine: { ...OPENCFD_2606_ENGINE },
      expected_execution_pool: "isolated-point-projection",
      expected_solver_budget_version: 2,
      expected_mesh_recovery_version: 1,
      airfoil: { name: "isolated-projection-fixture" },
      chord_lengths: [1],
      speeds: [speed],
      aoa: { angles: [0] },
      solver: {
        warm_start: true,
        flow_solver_family: localDensity
          ? "rhoCentralFoam"
          : transient
            ? "rhoPimpleFoam"
            : "rhoSimpleFoam",
        ...(localDensity
          ? { force_transient: false }
          : { urans_fidelity: "precalc" }),
      },
      resources: { case_concurrency: 1, case_solver_budget_seconds: 900 },
    },
  });
  const point: PolarPoint = {
    aoa_deg: 0,
    case_slug: "isolated-source-case",
    cl: 0.4,
    cd: 0.03,
    converged: false,
    unsteady: false,
    first_order_fallback: false,
    images: {},
    error: "isolated unconverged calculation",
    solver_active_seconds: 48,
    solver_budget: {
      version: 1,
      scope: "physical_case_v1",
      exhausted: false,
      limit_seconds: 900,
    },
  };
  const result: JobResult = {
    job_id: executionId,
    state: "running",
    execution_pool: "isolated-point-projection",
    engine: {
      ...OPENCFD_2606_ENGINE,
      build_id: "isolated-projection-build",
      application_source_sha256: "d".repeat(64),
    },
    mesh_recovery_version: 1,
    polars: [
      {
        speed,
        chord: 1,
        reynolds: 2000000,
        mach: localDensity ? 2.99698 : 0.1,
        points: [],
        attempts: [point],
      },
    ],
  };
  point.engine = result.engine;
  const report: ProgressiveRemoteReport = {
    version: 1,
    solverId: envelope.solverId,
    promiseId: envelope.promiseId,
    executionId,
    assignmentSignature: envelope.contentSignature,
    sequence: 1,
    status: {
      job_id: executionId,
      state: "running",
      completed_cases: 0,
      total_cases: 1,
      engine: result.engine,
    },
    result,
    stopProof: null,
  };
  const source = () => ({
    ...resolveProgressiveReportedPoint(result, {
      alpha: 0,
      speed,
      chord: 1,
      caseSlug: point.case_slug!,
    }),
    report,
    envelope,
  });
  return { point, result, source };
}

describe("progressive remote source projection", () => {
  it("keeps explicit local density iterations attributable to steady RANS", () => {
    const { source } = fixture(false, true);
    expect(progressiveRemotePointProjection(source())).toMatchObject({
      regime: "rans",
      fidelity: "rans",
      unsteady: false,
      speed: 1020,
    });
  });
  it("preserves unconverged coefficients, measured cost and physical setup without treating them as accepted evidence", () => {
    const { source, point, result } = fixture();
    const projection = progressiveRemotePointProjection(source());
    expect(projection).toMatchObject({
      cl: 0.4,
      cd: 0.03,
      cm: null,
      converged: false,
      stalled: true,
      status: "failed",
      source: "queued",
      regime: "rans",
      fidelity: "rans",
      reynolds: 2000000,
      speed: 30,
      chord: 1,
      mach: 0.1,
    });
    expect(projection.evidencePayload).toMatchObject({
      ...point,
      solver_active_seconds: 48,
      mesh_recovery_version: 1,
    });
    expect(projection.engine).toEqual(result.engine);
    expect(projection.forceHistory).toBeUndefined();
  });

  it("retains full correlated histories and source certificates rather than replacing them with one averaged point", () => {
    const { point, source } = fixture(true);
    point.fidelity = "urans_precalc";
    point.force_history = {
      t: [0, 0.2, 0.4],
      cl: [0.3, 0.5, 0.4],
      cd: [0.02, 0.04, 0.03],
      cm: [-0.1, -0.2, -0.15],
      samples: 300,
      shedding_freq_hz: 5,
    };
    point.aperiodic_mean_certificate = null;
    const original = structuredClone(point);
    const projection = progressiveRemotePointProjection(source());
    expect(projection.evidencePayload.force_history).toEqual(
      original.force_history,
    );
    expect(projection.evidencePayload.aperiodic_mean_certificate).toBeNull();
    expect(projection.forceHistory).toMatchObject({
      t: original.force_history!.t,
      cl: original.force_history!.cl,
      cd: original.force_history!.cd,
      sampleCount: 300,
      sheddingFreqHz: 5,
    });
    expect(point).toEqual(original);
  });

  it("keeps no-shedding URANS attributable to its actual requested method", () => {
    const { source, point } = fixture(true);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      delete point.error;
      point.converged = true;
      const projection = progressiveRemotePointProjection(source());
      expect(projection).toMatchObject({
        regime: "urans",
        fidelity: "urans_precalc",
        unsteady: false,
        status: "done",
      });
      expect(diagnostic).toHaveBeenCalled();
      expect(
        projection.evidencePayload.no_shedding_certificate,
      ).toBeUndefined();
    } finally {
      diagnostic.mockRestore();
    }
  });

  it("fails closed on missing unsteady certification and never invents a frame history", () => {
    const { source, point } = fixture(true);
    point.unsteady = true;
    point.fidelity = "urans_precalc";
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const projection = progressiveRemotePointProjection(source());
      expect(projection.frameTrack).toMatchObject({
        missing: true,
        stationary: false,
        periods_retained: null,
      });
      expect(projection.forceHistory).toBeUndefined();
      expect(projection.cl).toBe(point.cl);
      expect(projection.status).toBe("failed");
    } finally {
      diagnostic.mockRestore();
    }
  });
});
