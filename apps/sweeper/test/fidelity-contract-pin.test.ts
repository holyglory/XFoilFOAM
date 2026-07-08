// URANS FIDELITY LADDER CONTRACT PIN (same cross-runtime pattern as
// frame-track-contract-pin.test.ts / orphan-message-pin.test.ts). Contracts:
//   1. request solver.urans_fidelity 'precalc' | 'full' + engine-derived
//      values (min periods 3/7, budget 14400/43200 s, precalc mesh scale 0.5)
//      + PolarPoint.fidelity echo 'rans' | 'urans_precalc' | 'urans_full';
//   2. PolarPoint.steady_history EXACT shape (<=2000 samples) —
//      fixtures/steady-history-contract.json;
//   4. verify disagreement bounds |dCl| > 0.05 OR |dCd| > 0.01.
// Drift is a test failure on BOTH sides — python twin: engine fidelity
// contract test against the same literals/values.

import type { Airfoil } from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import {
  parsePointFidelity,
  parseSteadyHistory,
  POINT_FIDELITY_VALUES,
  type PolarPoint,
  STEADY_HISTORY_MAX_SAMPLES,
  URANS_FIDELITY_VALUES,
  URANS_FULL_MIN_PERIODS,
  URANS_FULL_SOLVER_BUDGET_S,
  URANS_PRECALC_MESH_SCALE,
  URANS_PRECALC_MIN_PERIODS,
  URANS_PRECALC_SOLVER_BUDGET_S,
  URANS_VERIFY_DELTA_CD_LIMIT,
  URANS_VERIFY_DELTA_CL_LIMIT,
} from "@aerodb/engine-client";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPolarRequest } from "../src/build-request";
import { fidelityForPoint, qualityWarningsForPoint, STEADY_OSCILLATING_MARKER, steadyHistoryForPoint } from "../src/ingest";

const here = dirname(fileURLToPath(import.meta.url));
const contractFixture = (): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(here, "fixtures/steady-history-contract.json"), "utf8"));

describe("fidelity ladder literals + engine-derived values (contract 1, cross-runtime pin)", () => {
  it("pins the request/echo literal sets", () => {
    expect(URANS_FIDELITY_VALUES).toEqual(["precalc", "full"]);
    expect(POINT_FIDELITY_VALUES).toEqual(["rans", "urans_precalc", "urans_full"]);
  });

  it("pins the engine-derived per-fidelity values (parity with models.py)", () => {
    expect(URANS_PRECALC_MIN_PERIODS).toBe(3);
    expect(URANS_FULL_MIN_PERIODS).toBe(7);
    // Precalc raised 2026-07-09 (3600 → 7200 → 14400 s): prod runs showed 9/9
    // precalc points budget-stopped at 7200 s — the NACA 4412 class projected
    // up to ~3.1 h of continuation beyond the stop point; 14400 s absorbs it.
    // Full stays 43200 s: ~2 h/period on the full mesh → 7 periods under the
    // 80% wall-guard fraction (see models.py + fidelity.ts).
    expect(URANS_PRECALC_SOLVER_BUDGET_S).toBe(14400);
    expect(URANS_FULL_SOLVER_BUDGET_S).toBe(43200);
    expect(URANS_PRECALC_MESH_SCALE).toBe(0.5);
  });

  it("pins the verify-queue disagreement bounds (contract 4)", () => {
    expect(URANS_VERIFY_DELTA_CL_LIMIT).toBe(0.05);
    expect(URANS_VERIFY_DELTA_CD_LIMIT).toBe(0.01);
  });

  it("parsePointFidelity accepts exactly the pinned literals and nothing else", () => {
    expect(parsePointFidelity("rans")).toBe("rans");
    expect(parsePointFidelity("urans_precalc")).toBe("urans_precalc");
    expect(parsePointFidelity("urans_full")).toBe("urans_full");
    for (const bad of ["precalc", "full", "URANS_FULL", "", null, undefined, 3, {}]) {
      expect(parsePointFidelity(bad)).toBeNull();
    }
  });
});

describe("build-request: solver.urans_fidelity (contract 1 — node sends ONLY the literal)", () => {
  const airfoil = {
    id: "a",
    name: "pin airfoil",
    pointFormat: "selig",
    points: [
      { x: 1, y: 0 },
      { x: 0.5, y: 0.08 },
      { x: 0, y: 0 },
      { x: 0.5, y: -0.02 },
      { x: 1, y: 0 },
    ],
  } as unknown as Airfoil;
  const setup = {
    preset: { legacyBoundaryConditionId: null },
    flowState: { mediumId: "m", temperatureK: 288.15, pressurePa: 101325, speedMps: 30, density: 1.225, dynamicViscosity: 1.789e-5, kinematicViscosity: 1.46e-5, mach: 0.09 },
    referenceGeometry: { geometryType: "airfoil_2d", referenceLengthKind: "chord", referenceLengthM: 1, spanM: null, referenceAreaM2: null },
    boundary: { turbulenceIntensity: 0.001, viscosityRatio: 10, sandGrainHeight: 0, roughnessConstant: 0.5 },
    mesh: { mesher: "blockmesh-cgrid", farfieldRadiusChords: 15, wakeLengthChords: 12, nSurface: 130, nRadial: 80, nWake: 60, targetYPlus: 1, spanChords: 0.1 },
    solver: { turbulenceModel: "kOmegaSST", nIterations: 3000, convergenceTolerance: 1e-5, momentumScheme: "linearUpwind", transientCycles: 10, transientDiscardFraction: 0.4, transientMaxCourant: 4 },
    scheduling: { schedulingPolicy: "auto", cpuBudget: null, caseConcurrency: null, solverProcesses: null },
    output: { writeImages: [], imageZoomChords: 2 },
    sweep: { aoaStart: -8, aoaStop: 20, aoaStep: 1, aoaList: null },
  } as unknown as SimulationSetupSnapshot;

  it("wave 2 defaults to 'precalc' and sends ONLY the literal (no derived numbers)", () => {
    const { request } = buildPolarRequest({ airfoil, setup, aoaList: [12], wave: 2 });
    expect(request.solver?.urans_fidelity).toBe("precalc");
    expect(request.solver?.force_transient).toBe(true);
    // The node must NOT ship derived values — the engine owns the derivation.
    expect(request.solver).not.toHaveProperty("urans_min_periods");
    expect(request.mesh).not.toHaveProperty("mesh_scale");
  });

  it("wave 2 passes 'full' through for verify/admin-full jobs", () => {
    const { request } = buildPolarRequest({ airfoil, setup, aoaList: [12], wave: 2, uransFidelity: "full" });
    expect(request.solver?.urans_fidelity).toBe("full");
  });

  it("wave 1 (steady) never carries a urans_fidelity", () => {
    const { request } = buildPolarRequest({ airfoil, setup, aoaList: [0, 1, 2], wave: 1, uransFidelity: "full" });
    expect(request.solver).not.toHaveProperty("urans_fidelity");
  });
});

describe("steady_history contract pin (fixture JSON, contract 2)", () => {
  it("accepts the exact pinned contract shape", () => {
    const parsed = parseSteadyHistory(contractFixture());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.mean_stable).toBe(true);
    expect(parsed.value.window).toEqual({ start_iter: 1000, end_iter: 2000 });
    expect(parsed.value.iterations.length).toBe(parsed.value.cl.length);
  });

  it("rejects an ADDED top-level key (engine grew the payload silently)", () => {
    const drifted = { ...contractFixture(), residuals: [1e-5] };
    const parsed = parseSteadyHistory(drifted);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain('unexpected key "residuals"');
  });

  it("rejects a REMOVED key (missing mean_stable verdict)", () => {
    const drifted = contractFixture();
    delete drifted.mean_stable;
    const parsed = parseSteadyHistory(drifted);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain('missing key "mean_stable"');
  });

  it("rejects a RENAMED key (mean_stable → meanStable)", () => {
    const drifted = contractFixture();
    drifted.meanStable = drifted.mean_stable;
    delete drifted.mean_stable;
    const parsed = parseSteadyHistory(drifted);
    expect(parsed.ok).toBe(false);
  });

  it("rejects RETYPED keys (mean_stable as string, note as number, non-integer window)", () => {
    expect(parseSteadyHistory({ ...contractFixture(), mean_stable: "true" }).ok).toBe(false);
    expect(parseSteadyHistory({ ...contractFixture(), note: 7 }).ok).toBe(false);
    const windowDrift = contractFixture();
    (windowDrift.window as Record<string, unknown>).start_iter = 1000.5;
    expect(parseSteadyHistory(windowDrift).ok).toBe(false);
  });

  it("rejects series drift: non-numeric samples, length mismatch, > 2000 samples", () => {
    expect(parseSteadyHistory({ ...contractFixture(), cl: ["0.8"] }).ok).toBe(false);
    const mismatch = contractFixture();
    (mismatch.cd as number[]).push(0.019);
    expect(parseSteadyHistory(mismatch).ok).toBe(false);
    const oversized = contractFixture();
    const n = STEADY_HISTORY_MAX_SAMPLES + 1;
    oversized.iterations = Array.from({ length: n }, (_, i) => i + 1);
    oversized.cl = Array.from({ length: n }, () => 0.84);
    oversized.cd = Array.from({ length: n }, () => 0.019);
    oversized.cm = Array.from({ length: n }, () => -0.052);
    const parsed = parseSteadyHistory(oversized);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("exceeds contract cap of 2000");
  });

  it("rejects non-object payloads (arrays, strings, null)", () => {
    expect(parseSteadyHistory([contractFixture()]).ok).toBe(false);
    expect(parseSteadyHistory("steady").ok).toBe(false);
    expect(parseSteadyHistory(null).ok).toBe(false);
  });
});

describe("ingest fidelity/steady-history persistence helpers", () => {
  const base = { aoa_deg: 8, unsteady: false, converged: true, first_order_fallback: false, images: {} } as PolarPoint;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fidelityForPoint: a valid engine echo always wins", () => {
    expect(fidelityForPoint({ ...base, fidelity: "urans_precalc", unsteady: true } as PolarPoint, "full", "t")).toBe("urans_precalc");
    expect(fidelityForPoint({ ...base, fidelity: "rans" } as PolarPoint, undefined, "t")).toBe("rans");
  });

  it("fidelityForPoint: missing echo on a fidelity-requesting URANS job falls back to the REQUESTED tier with a loud drift log", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(fidelityForPoint({ ...base, unsteady: true } as PolarPoint, "precalc", "t")).toBe("urans_precalc");
    expect(fidelityForPoint({ ...base, unsteady: true } as PolarPoint, "full", "t")).toBe("urans_full");
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(String(errorSpy.mock.calls[0][0])).toContain("fidelity echo MISSING");
  });

  it("fidelityForPoint: legacy engines (no echo, no request) grade by regime — the 0034 backfill semantics", () => {
    expect(fidelityForPoint({ ...base, unsteady: true } as PolarPoint, undefined, "t")).toBe("urans_full");
    expect(fidelityForPoint(base, undefined, "t")).toBe("rans");
  });

  it("steadyHistoryForPoint: persists a contract-valid payload verbatim; null passes through", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = contractFixture();
    expect(steadyHistoryForPoint({ ...base, steady_history: fixture as never }, "t")).toBe(fixture);
    expect(steadyHistoryForPoint({ ...base, steady_history: null }, "t")).toBeNull();
    expect(steadyHistoryForPoint(base, "t")).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("steadyHistoryForPoint: persists a DRIFTED payload verbatim but logs the contract drift loudly", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const drifted = { ...contractFixture(), mean_stable: "yes" };
    expect(steadyHistoryForPoint({ ...base, steady_history: drifted as never }, "t")).toBe(drifted);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("steady_history CONTRACT DRIFT");
  });

  it("qualityWarningsForPoint: appends the oscillating-steady marker with the engine note (mean_stable true, steady rows only)", () => {
    const withHistory = { ...base, steady_history: contractFixture() as never, quality_warnings: ["engine-warning"] } as PolarPoint;
    const warnings = qualityWarningsForPoint(withHistory);
    expect(warnings).not.toBeNull();
    expect(warnings![0]).toBe("engine-warning");
    expect(warnings![1].startsWith(`${STEADY_OSCILLATING_MARKER}: `)).toBe(true);
    expect(warnings![1]).toContain("bounded oscillation");
  });

  it("qualityWarningsForPoint: NO marker for mean_stable false, unsteady rows, or absent history (fail closed)", () => {
    const unstable = { ...contractFixture(), mean_stable: false };
    expect(qualityWarningsForPoint({ ...base, steady_history: unstable as never })).toBeNull();
    expect(qualityWarningsForPoint({ ...base, unsteady: true, steady_history: contractFixture() as never })).toBeNull();
    expect(qualityWarningsForPoint(base)).toBeNull();
  });
});
