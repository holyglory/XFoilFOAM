import { describe, expect, it } from "vitest";

import {
  POLAR_COMPATIBILITY_VERSION,
  compatibilityClassificationWithQualityGate,
  polarCompatibilitySelectionRank,
  resolvePolarCompatibilityMembers,
  type PolarCompatibilityCandidate,
} from "../src/polar-compatibility-cache";
import {
  INCOMPLETE_URANS_INTEGRATION_REASON,
  URANS_BUDGET_STOP_MARKER,
  URANS_CONTINUATION_REQUIRED_MARKER,
} from "@aerodb/core";
import {
  physicsHashForSnapshot,
  type SimulationSetupSnapshot,
} from "../src/simulation-setup";

function candidate(
  id: string,
  overrides: Partial<PolarCompatibilityCandidate> = {},
): PolarCompatibilityCandidate {
  const base = {
    resultId: id,
    simulationPresetRevisionId: `revision-${id}`,
    aoaDeg: 2,
    state: "accepted" as const,
    region: "attached" as const,
    reasons: [],
    confidence: 1,
    regime: "rans" as const,
    fidelity: "rans",
    cl: 0.4,
    cd: 0.012,
    cm: -0.02,
    clCd: 0.4 / 0.012,
    clStd: null,
    cdStd: null,
    cmStd: null,
    status: "done",
    source: "solved",
    converged: true,
    stalled: false,
    unsteady: false,
    error: null,
    finalResidual: 1e-6,
    iterations: 800,
    firstOrderFallback: false,
    resultUpdatedAt: new Date("2026-07-11T00:00:00Z"),
    solvedAt: new Date("2026-07-11T00:00:00Z"),
    qualityWarnings: null,
    reviewVerdict: null,
  };
  const row = { ...base, ...overrides } as PolarCompatibilityCandidate;
  return {
    ...row,
    selectionRank: polarCompatibilitySelectionRank(row),
  };
}

describe("public polar compatibility evidence resolution", () => {
  it("invalidates caches built before incomplete-URANS quality gating", () => {
    expect(POLAR_COMPATIBILITY_VERSION).toBe("polar-compat-v6");
  });

  it.each([URANS_BUDGET_STOP_MARKER, URANS_CONTINUATION_REQUIRED_MARKER])(
    "fails closed on legacy accepted compatibility evidence carrying %s",
    (marker) => {
      expect(
        compatibilityClassificationWithQualityGate({
          state: "accepted",
          region: "attached",
          reasons: [],
          regime: "urans",
          qualityWarnings: [`partial result ${marker}`],
        }),
      ).toEqual({
        state: "rejected",
        region: "unknown",
        reasons: [INCOMPLETE_URANS_INTEGRATION_REASON],
      });
    },
  );

  it("ranks classification before fidelity and full URANS before precalc before RANS", () => {
    const acceptedRans = candidate("accepted-rans");
    const provisionalFull = candidate("provisional-full", {
      state: "needs_urans",
      regime: "urans",
      fidelity: "urans_full",
    });
    expect(acceptedRans.selectionRank).toBeGreaterThan(
      provisionalFull.selectionRank,
    );

    const full = candidate("full", { regime: "urans", fidelity: "urans_full" });
    const precalc = candidate("precalc", {
      regime: "urans",
      fidelity: "urans_precalc",
    });
    expect(full.selectionRank).toBeGreaterThan(precalc.selectionRank);
    expect(precalc.selectionRank).toBeGreaterThan(acceptedRans.selectionRank);
  });

  it("shadows exact-equal top-ranked duplicates deterministically", () => {
    const older = candidate("older", {
      regime: "urans",
      fidelity: "urans_full",
      solvedAt: new Date("2026-07-10T00:00:00Z"),
    });
    const newer = candidate("newer", {
      regime: "urans",
      fidelity: "urans_full",
      solvedAt: new Date("2026-07-11T00:00:00Z"),
    });
    const resolved = resolvePolarCompatibilityMembers([older, newer]);
    expect(resolved.conflictAoas).toEqual([]);
    expect(resolved.selected.map((row) => row.resultId)).toEqual(["newer"]);
    expect(resolved.members.find((row) => row.resultId === "older")?.role).toBe(
      "shadowed",
    );
  });

  it("keeps numerically repeatable equal-ranked solves as one selected angle", () => {
    const older = candidate("older", {
      regime: "urans",
      fidelity: "urans_full",
      solvedAt: new Date("2026-07-10T00:00:00Z"),
    });
    const newer = candidate("newer", {
      regime: "urans",
      fidelity: "urans_full",
      cl: 0.405,
      cd: 0.0124,
      cm: -0.0205,
      clCd: 0.405 / 0.0124,
      solvedAt: new Date("2026-07-11T00:00:00Z"),
    });
    const resolved = resolvePolarCompatibilityMembers([older, newer]);
    expect(resolved.conflictAoas).toEqual([]);
    expect(resolved.selected.map((row) => row.resultId)).toEqual(["newer"]);
    expect(
      resolved.members.find((row) => row.resultId === "older"),
    ).toMatchObject({
      role: "shadowed",
      selectionReason:
        "repeat measurement agrees with selected top-ranked evidence",
    });
  });

  it("audits material equal-ranked coefficient disagreement and excludes the angle", () => {
    const a = candidate("a", { regime: "urans", fidelity: "urans_full" });
    const b = candidate("b", {
      regime: "urans",
      fidelity: "urans_full",
      cl: 0.48,
      clCd: 0.48 / 0.012,
    });
    const resolved = resolvePolarCompatibilityMembers([a, b]);
    expect(resolved.conflictAoas).toEqual([2]);
    expect(resolved.selected).toEqual([]);
    expect(resolved.members.map((row) => row.role)).toEqual([
      "conflict",
      "conflict",
    ]);
  });

  it("keeps missing Cm as real nullable evidence rather than inventing zero", () => {
    const resolved = resolvePolarCompatibilityMembers([
      candidate("missing-cm", { cm: null }),
    ]);
    expect(resolved.selected).toHaveLength(1);
    expect(resolved.selected[0].cm).toBeNull();
  });
});

const snapshot: SimulationSetupSnapshot = {
  preset: {
    id: "preset-a",
    slug: "preset-a",
    name: "Preset A",
    enabled: true,
    legacyBoundaryConditionId: null,
  },
  flowState: {
    id: "flow-a",
    slug: "flow-a",
    name: "Flow A",
    mediumId: "medium-air",
    mediumSlug: "air",
    mediumName: "Air",
    temperatureK: 288.15,
    pressurePa: 101325,
    speedMps: 25,
    density: 1.225,
    dynamicViscosity: 1.789e-5,
    kinematicViscosity: 1.46e-5,
    mach: 0.073,
  },
  referenceGeometry: {
    id: "geometry-a",
    slug: "geometry-a",
    name: "Geometry A",
    geometryType: "airfoil_2d",
    referenceLengthKind: "chord",
    referenceLengthM: 0.1,
    spanM: 1,
    referenceAreaM2: 0.1,
  },
  derived: { reynolds: 171233, mach: 0.073 },
  boundary: {
    id: "boundary-a",
    slug: "boundary-a",
    name: "Boundary A",
    turbulenceIntensity: 0.001,
    viscosityRatio: 10,
    sandGrainHeight: 0,
    roughnessConstant: 0.5,
  },
  mesh: {
    id: "mesh-a",
    slug: "mesh-a",
    name: "Mesh A",
    mesher: "blockmesh-cgrid",
    farfieldRadiusChords: 15,
    wakeLengthChords: 12,
    nSurface: 130,
    nRadial: 80,
    nWake: 60,
    targetYPlus: 1,
    spanChords: 0.1,
  },
  uransMesh: null,
  uransPrecalcMesh: null,
  solver: {
    id: "solver-a",
    slug: "solver-a",
    name: "Solver A",
    turbulenceModel: "kOmegaSST",
    nIterations: 3000,
    convergenceTolerance: 1e-5,
    momentumScheme: "linearUpwind",
    transientCycles: 10,
    transientDiscardFraction: 0.4,
    transientMaxCourant: 15,
  },
  scheduling: {
    id: "schedule-a",
    slug: "schedule-a",
    name: "Schedule A",
    schedulingPolicy: "auto",
    cpuBudget: 8,
    caseConcurrency: 2,
    solverProcesses: 4,
  },
  output: {
    id: "output-a",
    slug: "output-a",
    name: "Output A",
    writeImages: ["pressure"],
    imageZoomChords: 2,
  },
  sweep: {
    id: "sweep-a",
    slug: "sweep-a",
    name: "Sweep A",
    aoaStart: -8,
    aoaStop: 6,
    aoaStep: 2,
    aoaList: [-8, -2, 2, 6],
  },
};

describe("physics compatibility hash contract", () => {
  it("ignores batch/preset metadata, sweep, scheduling, and output policy", () => {
    const changed: SimulationSetupSnapshot = {
      ...snapshot,
      preset: {
        ...snapshot.preset,
        id: "preset-b",
        slug: "batch-b",
        name: "Batch B",
      },
      scheduling: {
        ...snapshot.scheduling,
        cpuBudget: 64,
        caseConcurrency: 16,
      },
      output: {
        ...snapshot.output,
        writeImages: ["vorticity"],
        imageZoomChords: 8,
      },
      sweep: { ...snapshot.sweep, aoaList: [-4, 0, 4] },
    };
    expect(physicsHashForSnapshot(changed)).toBe(
      physicsHashForSnapshot(snapshot),
    );
  });

  it("separates same-Re evidence when physical or numerical setup changes", () => {
    expect(
      physicsHashForSnapshot({
        ...snapshot,
        mesh: { ...snapshot.mesh, nSurface: snapshot.mesh.nSurface + 1 },
      }),
    ).not.toBe(physicsHashForSnapshot(snapshot));
    expect(
      physicsHashForSnapshot({
        ...snapshot,
        solver: { ...snapshot.solver, nIterations: 4000 },
      }),
    ).not.toBe(physicsHashForSnapshot(snapshot));
    expect(
      physicsHashForSnapshot({
        ...snapshot,
        boundary: { ...snapshot.boundary, turbulenceIntensity: 0.01 },
      }),
    ).not.toBe(physicsHashForSnapshot(snapshot));
    expect(
      physicsHashForSnapshot({
        ...snapshot,
        flowState: { ...snapshot.flowState, mach: 0.08 },
        derived: { ...snapshot.derived, mach: 0.08 },
      }),
    ).not.toBe(physicsHashForSnapshot(snapshot));
  });
});
