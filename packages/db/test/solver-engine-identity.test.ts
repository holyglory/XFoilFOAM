import { describe, expect, it } from "vitest";

import { campaignBatchGroupKey } from "../src/campaign-execution";
import {
  methodCompatibilityHashForSnapshot,
  physicsHashForSnapshot,
  simulationSetupSignature,
  type SimulationSetupSnapshot,
} from "../src/simulation-setup";
import {
  FOUNDATION_14_SOLVER_IMPLEMENTATION_ID,
  FOUNDATION_14_SOLVER_IMPLEMENTATION_KEY,
  LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  OPENCFD_2406_SOLVER_IMPLEMENTATION_KEY,
  type SolverImplementationSnapshot,
} from "../src/solver-implementations";
import { solverRuntimeProvenanceKey } from "../src/solver-runtime-provenance";

const openCfd: SolverImplementationSnapshot = {
  implementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  key: OPENCFD_2406_SOLVER_IMPLEMENTATION_KEY,
  family: "openfoam",
  distribution: "opencfd",
  releaseVersion: "2406",
  methodFamily: "finite_volume_rans_urans",
  adapterContractVersion: 1,
  numericsRevision: "1",
};

const foundation: SolverImplementationSnapshot = {
  implementationId: FOUNDATION_14_SOLVER_IMPLEMENTATION_ID,
  key: FOUNDATION_14_SOLVER_IMPLEMENTATION_KEY,
  family: "openfoam",
  distribution: "foundation",
  releaseVersion: "14",
  methodFamily: "finite_volume_rans_urans",
  adapterContractVersion: 1,
  numericsRevision: "1",
};

const legacySnapshot: SimulationSetupSnapshot = {
  preset: {
    id: "preset",
    slug: "preset",
    name: "Preset",
    enabled: true,
    legacyBoundaryConditionId: null,
  },
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
    mach: 0.073,
  },
  referenceGeometry: {
    id: "geometry",
    slug: "geometry",
    name: "Geometry",
    geometryType: "airfoil_2d",
    referenceLengthKind: "chord",
    referenceLengthM: 0.1,
    spanM: 1,
    referenceAreaM2: 0.1,
  },
  derived: { reynolds: 171233, mach: 0.073 },
  boundary: {
    id: "boundary",
    slug: "boundary",
    name: "Boundary",
    turbulenceIntensity: 0.001,
    viscosityRatio: 10,
    sandGrainHeight: 0,
    roughnessConstant: 0.5,
  },
  mesh: {
    id: "mesh",
    slug: "mesh",
    name: "Mesh",
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
    id: "schedule",
    slug: "schedule",
    name: "Schedule",
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

describe("versioned solver-method compatibility", () => {
  it("keeps physical identity stable but separates legacy, OpenCFD 2406, and Foundation 14", () => {
    const openCfdSnapshot = { ...legacySnapshot, engine: openCfd };
    const foundationSnapshot = { ...legacySnapshot, engine: foundation };

    expect(physicsHashForSnapshot(openCfdSnapshot)).toBe(
      physicsHashForSnapshot(foundationSnapshot),
    );
    expect(physicsHashForSnapshot(legacySnapshot)).toBe(
      physicsHashForSnapshot(openCfdSnapshot),
    );

    const hashes = new Set([
      methodCompatibilityHashForSnapshot(legacySnapshot),
      methodCompatibilityHashForSnapshot(openCfdSnapshot),
      methodCompatibilityHashForSnapshot(foundationSnapshot),
    ]);
    expect(hashes.size).toBe(3);
    expect(legacySnapshot.engine).toBeUndefined();
    expect(LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID).not.toBe(
      OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
    );
  });

  it("does not split a polar for a wire-only adapter bump but does preserve the immutable snapshot revision", () => {
    const v1 = { ...legacySnapshot, engine: openCfd };
    const v2 = {
      ...legacySnapshot,
      engine: { ...openCfd, adapterContractVersion: 2 },
    };
    expect(methodCompatibilityHashForSnapshot(v2)).toBe(
      methodCompatibilityHashForSnapshot(v1),
    );
    expect(simulationSetupSignature(v2)).not.toBe(simulationSetupSignature(v1));
  });

  it("keeps different engine adapters out of one execution batch", () => {
    const common = {
      flowState: legacySnapshot.flowState,
      referenceGeometry: legacySnapshot.referenceGeometry,
      boundary: legacySnapshot.boundary,
      mesh: legacySnapshot.mesh,
      uransMesh: null,
      uransPrecalcMesh: null,
      solver: legacySnapshot.solver,
      output: legacySnapshot.output,
    };
    expect(campaignBatchGroupKey({ ...common, engine: openCfd })).not.toBe(
      campaignBatchGroupKey({ ...common, engine: foundation }),
    );
    expect(
      campaignBatchGroupKey({
        ...common,
        engine: { ...openCfd, adapterContractVersion: 2 },
      }),
    ).not.toBe(campaignBatchGroupKey({ ...common, engine: openCfd }));
  });
});

describe("exact runtime provenance", () => {
  it("does not collapse reused build labels with different images or packages", () => {
    const common = {
      solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
      buildId: "release",
      sourceRevision: "abc123",
      architecture: "amd64",
    };
    const imageA = solverRuntimeProvenanceKey({
      ...common,
      imageDigest: `sha256:${"a".repeat(64)}`,
      packageSha256: "c".repeat(64),
    });
    const imageB = solverRuntimeProvenanceKey({
      ...common,
      imageDigest: `sha256:${"b".repeat(64)}`,
      packageSha256: "c".repeat(64),
    });
    const packageB = solverRuntimeProvenanceKey({
      ...common,
      imageDigest: `sha256:${"a".repeat(64)}`,
      packageSha256: "d".repeat(64),
    });
    expect(new Set([imageA, imageB, packageB]).size).toBe(3);
    expect(imageA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes adapter source content and rejects label-only provenance", () => {
    const common = {
      solverImplementationId: FOUNDATION_14_SOLVER_IMPLEMENTATION_ID,
      buildId: "same-label",
      packageSha256: "e".repeat(64),
    };
    const sourceA = solverRuntimeProvenanceKey({
      ...common,
      applicationSourceSha256: "a".repeat(64),
    });
    const sourceB = solverRuntimeProvenanceKey({
      ...common,
      applicationSourceSha256: "b".repeat(64),
    });
    expect(sourceA).not.toBe(sourceB);
    expect(() =>
      solverRuntimeProvenanceKey({
        solverImplementationId: FOUNDATION_14_SOLVER_IMPLEMENTATION_ID,
        buildId: "mutable-label-only",
        sourceRevision: "main",
      }),
    ).toThrow(/content fingerprint/);
  });
});
