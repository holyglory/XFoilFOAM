// WAVE-1 TRANSIENT-FLAG PAYLOAD-SHAPE PIN (incident: prod wave-1 sweep job
// 20b67295, s1223 -5deg/25ms/1.0m — an engine-side in-job transient escalation
// ran WITHOUT tier fidelity/budget and diverged; watchdog killed 3 attempts).
// Contract: EVERY wave-1 request (batched campaign jobs, continuous/public
// sweeps, remote-solver claims — all built by buildPolarRequest with wave:1)
// carries transient_fallback:false and force_transient:false as EXPLICIT keys.
// The engine defaults transient_fallback to TRUE when the key is ABSENT
// (src/airfoilfoam/models.py SolverParams), so "key missing" is a regression,
// not a neutral state — the pins below assert key PRESENCE + value.
// Conditional escalation is a separate explicit key: continuous multi-angle
// work uses abort_for_precalc so the engine stops RANS but never starts URANS
// in-job; explicit targeted work uses continue. Node then owns durable wave-2
// preliminary composition.

import type { Airfoil } from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import { describe, expect, it } from "vitest";

import { buildPolarRequest } from "../src/build-request";

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
  flowState: {
    mediumId: "m",
    temperatureK: 288.15,
    pressurePa: 101325,
    speedMps: 25,
    density: 1.225,
    dynamicViscosity: 1.789e-5,
    kinematicViscosity: 1.46e-5,
    mach: 0.07,
  },
  referenceGeometry: {
    geometryType: "airfoil_2d",
    referenceLengthKind: "chord",
    referenceLengthM: 1,
    spanM: null,
    referenceAreaM2: null,
  },
  boundary: {
    turbulenceIntensity: 0.001,
    viscosityRatio: 10,
    sandGrainHeight: 0,
    roughnessConstant: 0.5,
  },
  mesh: {
    mesher: "blockmesh-cgrid",
    farfieldRadiusChords: 15,
    wakeLengthChords: 12,
    nSurface: 130,
    nRadial: 80,
    nWake: 60,
    targetYPlus: 1,
    spanChords: 0.1,
  },
  solver: {
    turbulenceModel: "kOmegaSST",
    nIterations: 3000,
    convergenceTolerance: 1e-5,
    momentumScheme: "linearUpwind",
    transientCycles: 10,
    transientDiscardFraction: 0.4,
    transientMaxCourant: 4,
  },
  scheduling: {
    schedulingPolicy: "auto",
    cpuBudget: null,
    caseConcurrency: null,
    solverProcesses: null,
  },
  output: { writeImages: [], imageZoomChords: 2 },
  sweep: { aoaStart: -8, aoaStop: 20, aoaStep: 1, aoaList: null },
} as unknown as SimulationSetupSnapshot;

describe("wave-1 transient flags (in-job escalation OFF — payload-shape pin)", () => {
  it("batched CAMPAIGN wave-1 job (speeds[] + cpuSlots, the loop.ts submitCampaignBatch shape) ships transient_fallback:false and force_transient:false as present keys", () => {
    const { request } = buildPolarRequest({
      airfoil,
      setup,
      aoaList: [-5, 0, 5, 10],
      wave: 1,
      ransFailurePolicy: "abort_for_precalc",
      queuePressure: 2,
      cpuSlots: 8,
      speeds: [10, 25],
    });
    // Key PRESENCE first: an absent transient_fallback is engine-default TRUE.
    expect(
      Object.prototype.hasOwnProperty.call(
        request.solver,
        "transient_fallback",
      ),
    ).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(request.solver, "force_transient"),
    ).toBe(true);
    expect(request.solver?.transient_fallback).toBe(false);
    expect(request.solver?.force_transient).toBe(false);
    expect(request.solver?.rans_failure_policy).toBe("abort_for_precalc");
    expect(request.solver).not.toHaveProperty("urans_fidelity");
    // The flags must SURVIVE JSON serialization (what the engine receives).
    const wire = JSON.parse(JSON.stringify(request)) as {
      solver: Record<string, unknown>;
    };
    expect(wire.solver.transient_fallback).toBe(false);
    expect(wire.solver.force_transient).toBe(false);
    expect(wire.solver.rans_failure_policy).toBe("abort_for_precalc");
  });

  it("continuous/public (non-campaign) wave-1 sweep shape ships the same flags — it shares the gated-ladder escalation path (targeted wave-2 retry in reconcile.ts)", () => {
    const { request } = buildPolarRequest({
      airfoil,
      setup,
      aoaList: [0, 4, 8],
      wave: 1,
      ransFailurePolicy: "abort_for_precalc",
      queuePressure: 0,
    });
    expect(request.solver?.transient_fallback).toBe(false);
    expect(request.solver?.force_transient).toBe(false);
    expect(request.solver?.rans_failure_policy).toBe("abort_for_precalc");
    expect(request.solver).not.toHaveProperty("urans_fidelity");
    expect(request.solver?.warm_start).toBe(true);
  });

  it("explicit single-angle wave-1 work cannot widen and ships continue", () => {
    const { request } = buildPolarRequest({
      airfoil,
      setup,
      aoaList: [2],
      wave: 1,
      ransFailurePolicy: "continue",
    });
    expect(request.solver?.transient_fallback).toBe(false);
    expect(request.solver?.force_transient).toBe(false);
    expect(request.solver?.rans_failure_policy).toBe("continue");
  });

  it("wave-2 ladder jobs keep the transient flags ON (inversion guard — full pins in fidelity-contract-pin.test.ts / urans-ladder.test.ts)", () => {
    const { request } = buildPolarRequest({
      airfoil,
      setup,
      aoaList: [12],
      wave: 2,
    });
    expect(request.solver?.transient_fallback).toBe(true);
    expect(request.solver?.force_transient).toBe(true);
    expect(request.solver?.rans_failure_policy).toBe("continue");
    expect(request.solver?.urans_fidelity).toBe("precalc");
  });
});
