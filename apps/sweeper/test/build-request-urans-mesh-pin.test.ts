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

const baseMesh = {
  mesher: "blockmesh-cgrid",
  farfieldRadiusChords: 15,
  wakeLengthChords: 12,
  nSurface: 130,
  nRadial: 80,
  nWake: 60,
  targetYPlus: 1,
  spanChords: 0.1,
};

const setup = {
  preset: { legacyBoundaryConditionId: null },
  flowState: { mediumId: "m", temperatureK: 288.15, pressurePa: 101325, speedMps: 25, density: 1.225, dynamicViscosity: 1.789e-5, kinematicViscosity: 1.46e-5, mach: 0.07 },
  referenceGeometry: { geometryType: "airfoil_2d", referenceLengthKind: "chord", referenceLengthM: 1, spanM: null, referenceAreaM2: null },
  boundary: { turbulenceIntensity: 0.001, viscosityRatio: 10, sandGrainHeight: 0, roughnessConstant: 0.5 },
  mesh: baseMesh,
  uransMesh: null,
  uransPrecalcMesh: null,
  solver: { turbulenceModel: "kOmegaSST", nIterations: 3000, convergenceTolerance: 1e-5, momentumScheme: "linearUpwind", transientCycles: 10, transientDiscardFraction: 0.4, transientMaxCourant: 4 },
  scheduling: { schedulingPolicy: "auto", cpuBudget: null, caseConcurrency: null, solverProcesses: null },
  output: { writeImages: [], imageZoomChords: 2 },
  sweep: { aoaStart: -8, aoaStop: 20, aoaStep: 1, aoaList: null },
} as unknown as SimulationSetupSnapshot;

const expectedMeshBlock = {
  mesher: "blockmesh-cgrid",
  farfield_radius_chords: 15,
  wake_length_chords: 12,
  n_surface: 260,
  n_radial: 140,
  n_wake: 90,
  target_y_plus: 0.8,
  span_chords: 0.2,
};

const expectedPrecalcMeshBlock = {
  mesher: "blockmesh-cgrid",
  farfield_radius_chords: 12,
  wake_length_chords: 9,
  n_surface: 90,
  n_radial: 45,
  n_wake: 35,
  target_y_plus: 40,
  span_chords: 0.1,
};

describe("build-request per-tier URANS mesh pins", () => {
  it("keeps null tier mesh pins byte-identical to the legacy payload shape", () => {
    const { uransMesh: _uransMesh, uransPrecalcMesh: _uransPrecalcMesh, ...legacySetup } = setup as unknown as Record<string, unknown>;
    const legacy = buildPolarRequest({ airfoil, setup: legacySetup as unknown as SimulationSetupSnapshot, aoaList: [0, 4, 8], wave: 1 }).request;
    const withNulls = buildPolarRequest({ airfoil, setup, aoaList: [0, 4, 8], wave: 1 }).request;

    expect(JSON.stringify(withNulls)).toBe(JSON.stringify(legacy));
    expect(withNulls).not.toHaveProperty("urans_mesh");
    expect(withNulls).not.toHaveProperty("urans_precalc_mesh");
  });

  it("ships URANS full and precalc mesh blocks with the same mapping as mesh on wave 1 and wave 2", () => {
    const pinnedSetup = {
      ...setup,
      uransMesh: {
        ...baseMesh,
        farfieldRadiusChords: 15,
        wakeLengthChords: 12,
        nSurface: 260,
        nRadial: 140,
        nWake: 90,
        targetYPlus: 0.8,
        spanChords: 0.2,
      },
      uransPrecalcMesh: {
        ...baseMesh,
        farfieldRadiusChords: 12,
        wakeLengthChords: 9,
        nSurface: 90,
        nRadial: 45,
        nWake: 35,
        targetYPlus: 40,
        spanChords: 0.1,
      },
    } as unknown as SimulationSetupSnapshot;

    for (const wave of [1, 2] as const) {
      const { request } = buildPolarRequest({ airfoil, setup: pinnedSetup, aoaList: [12], wave });
      expect(request.urans_mesh).toEqual(expectedMeshBlock);
      expect(request.urans_precalc_mesh).toEqual(expectedPrecalcMeshBlock);
    }
  });
});
