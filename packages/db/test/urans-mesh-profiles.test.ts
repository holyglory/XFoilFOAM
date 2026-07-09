import { describe, expect, it } from "vitest";

import type { DB } from "../src/client";
import { CampaignError, loadNumericsRows, normalizeCampaignPlan, type CampaignPlanInput } from "../src/campaigns";
import { physicsHashForSnapshot, type SimulationSetupSnapshot } from "../src/simulation-setup";
import { boundaryProfiles, meshProfiles, outputProfiles, solverProfiles } from "../src/schema";

const baseMesh = {
  id: "mesh-base",
  slug: "mesh-base",
  name: "Base mesh",
  mesher: "blockmesh-cgrid",
  farfieldRadiusChords: 15,
  wakeLengthChords: 12,
  nSurface: 130,
  nRadial: 80,
  nWake: 60,
  targetYPlus: 1,
  spanChords: 0.1,
};

const baseSnapshot: SimulationSetupSnapshot = {
  preset: { id: "preset", slug: "preset", name: "Preset", enabled: true, legacyBoundaryConditionId: null },
  flowState: {
    id: "flow",
    slug: "flow",
    name: "Flow",
    mediumId: "medium",
    mediumSlug: "air",
    mediumName: "Air",
    temperatureK: 288.15,
    pressurePa: 101325,
    speedMps: 25,
    density: 1.225,
    dynamicViscosity: 1.789e-5,
    kinematicViscosity: 1.46e-5,
    mach: 0.07,
  },
  referenceGeometry: {
    id: "ref",
    slug: "ref",
    name: "Reference",
    geometryType: "airfoil_2d",
    referenceLengthKind: "chord",
    referenceLengthM: 1,
    spanM: null,
    referenceAreaM2: null,
  },
  derived: { reynolds: 1_712_329, mach: 0.07 },
  boundary: {
    id: "boundary",
    slug: "boundary",
    name: "Boundary",
    turbulenceIntensity: 0.001,
    viscosityRatio: 10,
    sandGrainHeight: 0,
    roughnessConstant: 0.5,
  },
  mesh: baseMesh,
  uransMesh: null,
  uransPrecalcMesh: null,
  solver: {
    id: "solver",
    slug: "solver",
    name: "Solver",
    turbulenceModel: "kOmegaSST",
    nIterations: 3000,
    convergenceTolerance: 1e-5,
    momentumScheme: "linearUpwind",
    transientCycles: 10,
    transientDiscardFraction: 0.4,
    transientMaxCourant: 4,
  },
  scheduling: {
    id: "sched",
    slug: "sched",
    name: "Scheduling",
    schedulingPolicy: "auto",
    cpuBudget: null,
    caseConcurrency: null,
    solverProcesses: null,
  },
  output: {
    id: "output",
    slug: "output",
    name: "Output",
    writeImages: [],
    imageZoomChords: 2,
  },
  sweep: {
    id: "sweep",
    slug: "sweep",
    name: "Sweep",
    aoaStart: -2,
    aoaStop: 2,
    aoaStep: 1,
    aoaList: null,
  },
};

const validPlanInput = (numerics: Partial<CampaignPlanInput["numerics"]> = {}): CampaignPlanInput => ({
  mediumId: "00000000-0000-0000-0000-000000000001",
  ambients: [[288.15, 101325]],
  speedsMps: [10],
  chordsM: [0.2],
  spanM: 1,
  areaMode: "derived",
  excludedConditions: [],
  baseSweep: { fromDeg: -2, toDeg: 2, stepDeg: 1, listDeg: null },
  objectives: {
    ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
    clZero: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
    clMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
  },
  numerics: {
    boundaryProfileId: "boundary-profile",
    meshProfileId: "mesh-profile",
    solverProfileId: "solver-profile",
    outputProfileId: "output-profile",
    ...numerics,
  },
});

describe("per-tier URANS mesh physics hashing", () => {
  it("keeps null/absent URANS mesh pins byte-identical and changes when a tier mesh is pinned", () => {
    const { uransMesh: _uransMesh, uransPrecalcMesh: _uransPrecalcMesh, ...legacySnapshot } = baseSnapshot;
    const legacyHash = physicsHashForSnapshot(legacySnapshot as unknown as SimulationSetupSnapshot);
    const nullHash = physicsHashForSnapshot(baseSnapshot);
    expect(nullHash).toBe(legacyHash);

    const pinnedHash = physicsHashForSnapshot({
      ...baseSnapshot,
      uransMesh: { ...baseMesh, id: "mesh-urans", slug: "mesh-urans", name: "URANS mesh", nSurface: 260 },
    });
    expect(pinnedHash).not.toBe(nullHash);
  });
});

describe("campaign plan numerics normalization", () => {
  it("defaults absent per-tier URANS mesh profile IDs to null", () => {
    const plan = normalizeCampaignPlan(validPlanInput());
    expect(plan.numerics.uransMeshProfileId).toBeNull();
    expect(plan.numerics.uransPrecalcMeshProfileId).toBeNull();
  });

  it("rejects non-string optional URANS mesh profile IDs", () => {
    const input = validPlanInput({ uransMeshProfileId: 42 as unknown as string });
    expect(() => normalizeCampaignPlan(input)).toThrow(CampaignError);
    try {
      normalizeCampaignPlan(input);
    } catch (e) {
      expect((e as CampaignError).details).toMatchObject({
        issues: [{ path: "numerics.uransMeshProfileId" }],
      });
    }
  });
});

describe("loadNumericsRows optional URANS mesh lookups", () => {
  it("errors clearly when an optional URANS mesh profile id is missing", async () => {
    let meshSelectCount = 0;
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === boundaryProfiles) return [{ id: "boundary-profile" }];
              if (table === solverProfiles) return [{ id: "solver-profile" }];
              if (table === outputProfiles) return [{ id: "output-profile" }];
              if (table === meshProfiles) {
                meshSelectCount += 1;
                return meshSelectCount === 1 ? [{ id: "mesh-profile" }] : [];
              }
              return [];
            },
          }),
        }),
      }),
    } as unknown as DB;

    await expect(
      loadNumericsRows(fakeDb, {
        boundaryProfileId: "boundary-profile",
        meshProfileId: "mesh-profile",
        uransMeshProfileId: "00000000-0000-0000-0000-000000000099",
        uransPrecalcMeshProfileId: null,
        solverProfileId: "solver-profile",
        outputProfileId: "output-profile",
      }),
    ).rejects.toMatchObject({ code: "not_found", message: "URANS mesh profile not found" });
  });
});
