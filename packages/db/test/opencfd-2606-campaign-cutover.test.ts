import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq, sql } from "drizzle-orm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  completeOpenCfd2606Cutover,
  finalizeOpenCfd2606Cutover,
  inspectOpenCfd2606CutoverReadiness,
  prepareOpenCfd2606Cutover,
} from "../src/campaign-solver-cutover";
import {
  campaignFailures,
  campaignLaneDetail,
  campaignLanes,
  campaignRejected,
  campaignSummary,
  continueLane,
  recomputeCampaignProgress,
  requeueCampaignFailed,
} from "../src/campaigns";
import type { DB } from "../src/client";
import { databaseUrl } from "../src/env";
import { probeCampaignCompletion } from "../src/campaign-execution";
import {
  inspectOpenCfd2606Continuation,
  persistOpenCfd2606CanaryAttestation,
} from "../src/solver-cutover-attestation";
import { solverRuntimeProvenanceKey } from "../src/solver-runtime-provenance";
import * as schema from "../src/schema";
import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  flowConditions,
  mediums,
  meshProfiles,
  outputProfiles,
  referenceGeometryProfiles,
  resultAttempts,
  resultClassifications,
  results,
  schedulingProfiles,
  simCampaignAirfoils,
  simCampaignConditions,
  simCampaignLanes,
  simCampaignPlanRevisions,
  simCampaignPoints,
  simCampaignSolverCutoverPoints,
  simCampaignSolverCutovers,
  simCampaigns,
  simJobs,
  simPrecalcObligations,
  simUransRequests,
  simulationPresetRevisions,
  simulationPresets,
  solverEvidenceArtifacts,
  solverExecutionPools,
  solverCutoverContinuationChecks,
  solverEngineCanaryAttestations,
  solverImplementations,
  solverProfiles,
  solverRuntimeBuilds,
  sweepDefinitions,
} from "../src/schema";
import {
  methodCompatibilityHashForSnapshot,
  physicsHashForSnapshot,
  simulationSetupSignature,
  type SimulationSetupSnapshot,
} from "../src/simulation-setup";
import {
  LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
  OPENCFD_2406_EXECUTION_POOL_ID,
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  OPENCFD_2606_EXECUTION_POOL_ID,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
} from "../src/solver-implementations";
import { campaignReviewBuckets } from "../src/urans-ladder";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, "../migrations");
const dbName = `aerodb_cutover_2606_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

const IDS = {
  category: "66000000-0000-0000-0000-000000000001",
  airfoil: "66000000-0000-0000-0000-000000000002",
  medium: "66000000-0000-0000-0000-000000000003",
  flow: "66000000-0000-0000-0000-000000000004",
  geometry: "66000000-0000-0000-0000-000000000005",
  boundaryProfile: "66000000-0000-0000-0000-000000000006",
  mesh: "66000000-0000-0000-0000-000000000007",
  solver: "66000000-0000-0000-0000-000000000008",
  scheduling: "66000000-0000-0000-0000-000000000009",
  output: "66000000-0000-0000-0000-00000000000a",
  sweep: "66000000-0000-0000-0000-00000000000b",
  boundaryCondition: "66000000-0000-0000-0000-00000000000c",
  preset: "66000000-0000-0000-0000-00000000000d",
  sourceRevision: "66000000-0000-0000-0000-00000000000e",
  campaign: "66000000-0000-0000-0000-00000000000f",
  sourcePlan: "66000000-0000-0000-0000-000000000010",
  sourceCondition: "66000000-0000-0000-0000-000000000011",
  failedResult: "66000000-0000-0000-0000-000000000012",
  failedAttempt: "66000000-0000-0000-0000-000000000013",
  rejectedResult: "66000000-0000-0000-0000-000000000014",
  rejectedAttempt: "66000000-0000-0000-0000-000000000015",
  evidenceArtifact: "66000000-0000-0000-0000-000000000016",
  legacyRevision: "66000000-0000-0000-0000-000000000017",
  pausedCampaign: "66000000-0000-0000-0000-000000000018",
  pausedSourcePlan: "66000000-0000-0000-0000-000000000019",
  pausedSourceCondition: "66000000-0000-0000-0000-00000000001a",
  legacyNullJob: "66000000-0000-0000-0000-00000000001b",
  targetPolicyCollisionRevision: "66000000-0000-0000-0000-00000000001c",
  invalidCampaign: "66000000-0000-0000-0000-00000000001d",
  invalidPlan: "66000000-0000-0000-0000-00000000001e",
  invalidOldCondition: "66000000-0000-0000-0000-00000000001f",
  invalidMixedCondition: "66000000-0000-0000-0000-000000000020",
  extraGeometry: "66000000-0000-0000-0000-000000000021",
} as const;

const OLD_ARTIFACT_SHA256 = "a".repeat(64);

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let db: DB;
let sourceSnapshot: SimulationSetupSnapshot;

function campaignPlan() {
  return {
    mediumId: IDS.medium,
    ambients: [["288.15", "101325"]],
    speedsMps: ["20"],
    chordsM: ["1"],
    spanM: "1",
    areaMode: "derived",
    areaM2: null,
    excludedConditions: [],
    baseSweep: {
      fromDeg: null,
      toDeg: null,
      stepDeg: null,
      listDeg: ["0", "1"],
    },
    objectives: {
      ldMax: { enabled: false, toleranceDeg: "0.10", maxRounds: 4 },
      clZero: { enabled: false, toleranceDeg: "0.10", maxRounds: 4 },
      clMax: { enabled: false, toleranceDeg: "0.10", maxRounds: 4 },
    },
    numerics: {
      boundaryProfileId: IDS.boundaryProfile,
      meshProfileId: IDS.mesh,
      uransMeshProfileId: IDS.mesh,
      uransPrecalcMeshProfileId: IDS.mesh,
      solverProfileId: IDS.solver,
      outputProfileId: IDS.output,
    },
  };
}

function legacyCampaignPlanWithoutClMax() {
  const plan = campaignPlan();
  const { clMax: _clMax, ...legacyObjectives } = plan.objectives;
  return { ...plan, objectives: legacyObjectives };
}

async function seedCampaignFixture() {
  await db.insert(categories).values({
    id: IDS.category,
    slug: "cutover-2606",
    name: "Cutover 2606",
    path: "cutover-2606",
  });
  await db.insert(airfoils).values({
    id: IDS.airfoil,
    slug: "cutover-foil",
    name: "Cutover foil",
    categoryId: IDS.category,
    source: "test-coordinates",
    points: [
      { x: 1, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ],
    isSymmetric: false,
  });
  await db.insert(mediums).values({
    id: IDS.medium,
    slug: "cutover-air",
    name: "Cutover air",
    phase: "gas",
    density: 1.225,
    viscosityModel: "constant",
    constantDynamicViscosity: 1.789e-5,
    dynamicViscosity: 1.789e-5,
    kinematicViscosity: 1.4604e-5,
    speedOfSound: 340,
  });
  await db.insert(flowConditions).values({
    id: IDS.flow,
    slug: "cutover-flow",
    name: "Cutover flow",
    mediumId: IDS.medium,
    temperatureK: 288.15,
    pressurePa: 101325,
    speedMps: 20,
    density: 1.225,
    dynamicViscosity: 1.789e-5,
    kinematicViscosity: 1.4604e-5,
    mach: 20 / 340,
  });
  await db.insert(referenceGeometryProfiles).values({
    id: IDS.geometry,
    slug: "cutover-geometry",
    name: "Cutover geometry",
    referenceLengthM: 1,
    spanM: 1,
  });
  await db.insert(boundaryProfiles).values({
    id: IDS.boundaryProfile,
    slug: "cutover-boundary",
    name: "Cutover boundary",
  });
  await db.insert(meshProfiles).values({
    id: IDS.mesh,
    slug: "cutover-mesh",
    name: "Cutover mesh",
  });
  await db.insert(solverProfiles).values({
    id: IDS.solver,
    slug: "cutover-solver",
    name: "Cutover solver",
    solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  });
  await db.insert(schedulingProfiles).values({
    id: IDS.scheduling,
    slug: "cutover-scheduling",
    name: "Cutover scheduling",
  });
  await db.insert(outputProfiles).values({
    id: IDS.output,
    slug: "cutover-output",
    name: "Cutover output",
    writeImages: [],
  });
  await db.insert(sweepDefinitions).values({
    id: IDS.sweep,
    slug: "cutover-sweep",
    name: "Cutover sweep",
    aoaList: [0, 1],
  });
  await db.insert(boundaryConditions).values({
    id: IDS.boundaryCondition,
    slug: "cutover-legacy-bc",
    name: "Cutover legacy BC",
    mediumId: IDS.medium,
    reynolds: 1_369_488,
  });
  await db.insert(simulationPresets).values({
    id: IDS.preset,
    slug: "cutover-preset",
    name: "Cutover preset",
    flowConditionId: IDS.flow,
    referenceGeometryProfileId: IDS.geometry,
    boundaryProfileId: IDS.boundaryProfile,
    meshProfileId: IDS.mesh,
    uransMeshProfileId: IDS.mesh,
    uransPrecalcMeshProfileId: IDS.mesh,
    solverProfileId: IDS.solver,
    schedulingProfileId: IDS.scheduling,
    outputProfileId: IDS.output,
    sweepDefinitionId: IDS.sweep,
    legacyBoundaryConditionId: IDS.boundaryCondition,
    origin: "campaign",
    enabled: false,
  });

  sourceSnapshot = {
    preset: {
      id: IDS.preset,
      slug: "cutover-preset",
      name: "Cutover preset",
      enabled: false,
      legacyBoundaryConditionId: IDS.boundaryCondition,
    },
    engine: {
      implementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
      key: "openfoam:opencfd:2406:adapter-v1:numerics-v1",
      family: "openfoam",
      distribution: "opencfd",
      releaseVersion: "2406",
      methodFamily: "finite_volume_rans_urans",
      adapterContractVersion: 1,
      numericsRevision: "1",
    },
    flowState: {
      id: IDS.flow,
      slug: "cutover-flow",
      name: "Cutover flow",
      mediumId: IDS.medium,
      mediumSlug: "cutover-air",
      mediumName: "Cutover air",
      temperatureK: 288.15,
      pressurePa: 101325,
      speedMps: 20,
      density: 1.225,
      dynamicViscosity: 1.789e-5,
      kinematicViscosity: 1.4604e-5,
      mach: 20 / 340,
    },
    referenceGeometry: {
      id: IDS.geometry,
      slug: "cutover-geometry",
      name: "Cutover geometry",
      geometryType: "airfoil_2d",
      referenceLengthKind: "chord",
      referenceLengthM: 1,
      spanM: 1,
      referenceAreaM2: null,
    },
    derived: { reynolds: 1_369_488, mach: 20 / 340 },
    boundary: {
      id: IDS.boundaryProfile,
      slug: "cutover-boundary",
      name: "Cutover boundary",
      turbulenceIntensity: 0.001,
      viscosityRatio: 10,
      sandGrainHeight: 0,
      roughnessConstant: 0.5,
    },
    mesh: {
      id: IDS.mesh,
      slug: "cutover-mesh",
      name: "Cutover mesh",
      mesher: "blockmesh-cgrid",
      farfieldRadiusChords: 15,
      wakeLengthChords: 12,
      nSurface: 130,
      nRadial: 80,
      nWake: 60,
      targetYPlus: 1,
      spanChords: 0.1,
    },
    uransMesh: {
      id: IDS.mesh,
      slug: "cutover-mesh",
      name: "Cutover mesh",
      mesher: "blockmesh-cgrid",
      farfieldRadiusChords: 15,
      wakeLengthChords: 12,
      nSurface: 130,
      nRadial: 80,
      nWake: 60,
      targetYPlus: 1,
      spanChords: 0.1,
    },
    uransPrecalcMesh: {
      id: IDS.mesh,
      slug: "cutover-mesh",
      name: "Cutover mesh",
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
      id: IDS.solver,
      slug: "cutover-solver",
      name: "Cutover solver",
      turbulenceModel: "kOmegaSST",
      nIterations: 3000,
      convergenceTolerance: 1e-5,
      momentumScheme: "linearUpwind",
      transientCycles: 10,
      transientDiscardFraction: 0.4,
      transientMaxCourant: 1,
    },
    scheduling: {
      id: IDS.scheduling,
      slug: "cutover-scheduling",
      name: "Cutover scheduling",
      schedulingPolicy: "auto",
      cpuBudget: null,
      caseConcurrency: null,
      solverProcesses: null,
    },
    output: {
      id: IDS.output,
      slug: "cutover-output",
      name: "Cutover output",
      writeImages: [],
      imageZoomChords: 2,
    },
    sweep: {
      id: IDS.sweep,
      slug: "cutover-sweep",
      name: "Cutover sweep",
      aoaStart: -8,
      aoaStop: 20,
      aoaStep: 1,
      aoaList: [0, 1],
    },
  };
  await db.insert(simulationPresetRevisions).values({
    id: IDS.sourceRevision,
    presetId: IDS.preset,
    revisionNumber: 1,
    signatureHash: simulationSetupSignature(sourceSnapshot),
    reynolds: sourceSnapshot.derived.reynolds,
    mach: sourceSnapshot.derived.mach,
    referenceLengthM: 1,
    snapshot: sourceSnapshot as unknown as Record<string, unknown>,
    solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
    physicsHash: physicsHashForSnapshot(sourceSnapshot),
    methodCompatibilityHashVersion: 1,
    methodCompatibilityHash: methodCompatibilityHashForSnapshot(sourceSnapshot),
    isCanonicalPhysics: true,
    isCanonicalMethod: true,
  });
  const targetPolicyCollisionSnapshot = JSON.parse(
    JSON.stringify(sourceSnapshot),
  ) as SimulationSetupSnapshot;
  targetPolicyCollisionSnapshot.engine = {
    implementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    key: "openfoam:opencfd:2606:adapter-v1:numerics-v1",
    family: "openfoam",
    distribution: "opencfd",
    releaseVersion: "2606",
    methodFamily: "finite_volume_rans_urans",
    adapterContractVersion: 1,
    numericsRevision: "1",
  };
  targetPolicyCollisionSnapshot.scheduling.cpuBudget = 99;
  targetPolicyCollisionSnapshot.output.writeImages = ["pressure"];
  await db.insert(simulationPresetRevisions).values({
    id: IDS.targetPolicyCollisionRevision,
    presetId: IDS.preset,
    revisionNumber: 3,
    signatureHash: simulationSetupSignature(targetPolicyCollisionSnapshot),
    reynolds: targetPolicyCollisionSnapshot.derived.reynolds,
    mach: targetPolicyCollisionSnapshot.derived.mach,
    referenceLengthM: 1,
    snapshot: targetPolicyCollisionSnapshot as unknown as Record<
      string,
      unknown
    >,
    solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    physicsHash: physicsHashForSnapshot(targetPolicyCollisionSnapshot),
    methodCompatibilityHashVersion: 1,
    methodCompatibilityHash: methodCompatibilityHashForSnapshot(
      targetPolicyCollisionSnapshot,
    ),
    isCanonicalPhysics: false,
    isCanonicalMethod: true,
  });
  const legacySnapshot = JSON.parse(
    JSON.stringify(sourceSnapshot),
  ) as SimulationSetupSnapshot;
  delete legacySnapshot.engine;
  await db.insert(simulationPresetRevisions).values({
    id: IDS.legacyRevision,
    presetId: IDS.preset,
    revisionNumber: 2,
    signatureHash: simulationSetupSignature(legacySnapshot),
    reynolds: legacySnapshot.derived.reynolds,
    mach: legacySnapshot.derived.mach,
    referenceLengthM: 1,
    snapshot: legacySnapshot as unknown as Record<string, unknown>,
    solverImplementationId: LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
    physicsHash: physicsHashForSnapshot(legacySnapshot),
    methodCompatibilityHashVersion: 1,
    methodCompatibilityHash: methodCompatibilityHashForSnapshot(legacySnapshot),
    isCanonicalPhysics: false,
    isCanonicalMethod: true,
  });
  await db.insert(simCampaigns).values({
    id: IDS.campaign,
    slug: "cutover-campaign",
    name: "Cutover campaign",
    status: "active",
    priority: 5,
    idempotencyKey: "cutover-campaign-idempotency",
  });
  await db.insert(simCampaignPlanRevisions).values({
    id: IDS.sourcePlan,
    campaignId: IDS.campaign,
    revisionNumber: 1,
    kind: "initial",
    plan: campaignPlan() as unknown as Record<string, unknown>,
    summary: {},
  });
  await db
    .update(simCampaigns)
    .set({ currentPlanRevisionId: IDS.sourcePlan })
    .where(eq(simCampaigns.id, IDS.campaign));
  await db.insert(simCampaignAirfoils).values({
    campaignId: IDS.campaign,
    airfoilId: IDS.airfoil,
  });
  await db.insert(simCampaignConditions).values({
    id: IDS.sourceCondition,
    campaignId: IDS.campaign,
    ord: 0,
    generation: 1,
    flowConditionId: IDS.flow,
    referenceGeometryProfileId: IDS.geometry,
    presetId: IDS.preset,
    simulationPresetRevisionId: IDS.sourceRevision,
    reynolds: sourceSnapshot.derived.reynolds,
    mach: sourceSnapshot.derived.mach,
    status: "active",
    introducedInPlanRevisionId: IDS.sourcePlan,
  });
  await db.insert(simCampaigns).values({
    id: IDS.pausedCampaign,
    slug: "cutover-paused-legacy-campaign",
    name: "Cutover paused legacy campaign",
    status: "paused",
    priority: 5,
    idempotencyKey: "cutover-paused-legacy-campaign-idempotency",
  });
  await db.insert(simCampaignPlanRevisions).values({
    id: IDS.pausedSourcePlan,
    campaignId: IDS.pausedCampaign,
    revisionNumber: 1,
    kind: "initial",
    plan: legacyCampaignPlanWithoutClMax() as unknown as Record<
      string,
      unknown
    >,
    summary: {},
  });
  await db
    .update(simCampaigns)
    .set({ currentPlanRevisionId: IDS.pausedSourcePlan })
    .where(eq(simCampaigns.id, IDS.pausedCampaign));
  await db.insert(simCampaignAirfoils).values({
    campaignId: IDS.pausedCampaign,
    airfoilId: IDS.airfoil,
  });
  await db.insert(simCampaignConditions).values({
    id: IDS.pausedSourceCondition,
    campaignId: IDS.pausedCampaign,
    ord: 0,
    generation: 1,
    flowConditionId: IDS.flow,
    referenceGeometryProfileId: IDS.geometry,
    presetId: IDS.preset,
    simulationPresetRevisionId: IDS.legacyRevision,
    reynolds: sourceSnapshot.derived.reynolds,
    mach: sourceSnapshot.derived.mach,
    status: "active",
    introducedInPlanRevisionId: IDS.pausedSourcePlan,
  });
  await db.insert(simCampaignPoints).values({
    campaignId: IDS.pausedCampaign,
    conditionId: IDS.pausedSourceCondition,
    airfoilId: IDS.airfoil,
    aoaDeg: 0,
    revisionId: IDS.legacyRevision,
    planRevisionNumber: 1,
    state: "requested",
  });
  await db.insert(simJobs).values({
    id: IDS.legacyNullJob,
    airfoilId: IDS.airfoil,
    bcIds: [IDS.boundaryCondition],
    simulationPresetRevisionId: IDS.legacyRevision,
    campaignId: IDS.pausedCampaign,
    referenceChordM: 1,
    status: "running",
    totalCases: 1,
    completedCases: 0,
    // Pre-0065 jobs have neither exact implementation nor pool identity. They
    // still belong to the sole old operational route and must drain globally.
    solverImplementationId: null,
    solverExecutionPoolId: null,
  });

  const [failedResult, rejectedResult] = await db
    .insert(results)
    .values([
      {
        id: IDS.failedResult,
        airfoilId: IDS.airfoil,
        bcId: IDS.boundaryCondition,
        simulationPresetRevisionId: IDS.sourceRevision,
        aoaDeg: 0,
        status: "failed",
        source: "solved",
        regime: "rans",
        fidelity: "rans",
        error: "solver diverged",
        solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
        solvedAt: new Date(),
      },
      {
        id: IDS.rejectedResult,
        airfoilId: IDS.airfoil,
        bcId: IDS.boundaryCondition,
        simulationPresetRevisionId: IDS.sourceRevision,
        aoaDeg: 1,
        status: "done",
        source: "solved",
        regime: "rans",
        fidelity: "rans",
        cl: 0.1,
        cd: 0.2,
        converged: false,
        solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
        solvedAt: new Date(),
      },
    ])
    .returning();
  const attempts = await db
    .insert(resultAttempts)
    .values([
      {
        id: IDS.failedAttempt,
        resultId: failedResult.id,
        airfoilId: IDS.airfoil,
        bcId: IDS.boundaryCondition,
        simulationPresetRevisionId: IDS.sourceRevision,
        aoaDeg: 0,
        status: "failed",
        source: "solved",
        regime: "rans",
        error: "solver diverged",
        solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
      },
      {
        id: IDS.rejectedAttempt,
        resultId: rejectedResult.id,
        airfoilId: IDS.airfoil,
        bcId: IDS.boundaryCondition,
        simulationPresetRevisionId: IDS.sourceRevision,
        aoaDeg: 1,
        status: "done",
        source: "solved",
        regime: "rans",
        cl: 0.1,
        cd: 0.2,
        solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
      },
    ])
    .returning();
  await db
    .update(results)
    .set({ currentResultAttemptId: attempts[0].id })
    .where(eq(results.id, IDS.failedResult));
  await db
    .update(results)
    .set({ currentResultAttemptId: attempts[1].id })
    .where(eq(results.id, IDS.rejectedResult));
  await db.insert(resultClassifications).values({
    resultId: IDS.rejectedResult,
    resultAttemptId: IDS.rejectedAttempt,
    airfoilId: IDS.airfoil,
    simulationPresetRevisionId: IDS.sourceRevision,
    aoaDeg: 1,
    regime: "rans",
    classifierVersion: "cutover-test",
    state: "rejected",
    confidence: 1,
    reasons: ["non-converged"],
  });
  await db.insert(solverEvidenceArtifacts).values({
    id: IDS.evidenceArtifact,
    resultId: IDS.failedResult,
    resultAttemptId: IDS.failedAttempt,
    airfoilId: IDS.airfoil,
    methodKey: "openfoam:opencfd:2406:adapter-v1:numerics-v1",
    solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
    aoaDeg: 0,
    kind: "manifest",
    storageKey: "cutover/2406/evidence-manifest.json",
    mimeType: "application/json",
    sha256: OLD_ARTIFACT_SHA256,
    byteSize: 1234,
    metadata: { immutableFixture: true },
  });
  await db.insert(simCampaignPoints).values([
    {
      campaignId: IDS.campaign,
      conditionId: IDS.sourceCondition,
      airfoilId: IDS.airfoil,
      aoaDeg: 0,
      revisionId: IDS.sourceRevision,
      planRevisionNumber: 1,
      state: "terminal",
      resultId: IDS.failedResult,
      resultAttemptId: IDS.failedAttempt,
    },
    {
      campaignId: IDS.campaign,
      conditionId: IDS.sourceCondition,
      airfoilId: IDS.airfoil,
      aoaDeg: 1,
      revisionId: IDS.sourceRevision,
      planRevisionNumber: 1,
      state: "terminal",
      resultId: IDS.rejectedResult,
      resultAttemptId: IDS.rejectedAttempt,
    },
  ]);
  await db.insert(simCampaignLanes).values({
    campaignId: IDS.campaign,
    airfoilId: IDS.airfoil,
    conditionId: IDS.sourceCondition,
    objective: "ld_max",
    state: "awaiting_seed",
  });
  await recomputeCampaignProgress(db as never, IDS.campaign);
  await recomputeCampaignProgress(db as never, IDS.pausedCampaign);
}

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  client = postgres(targetUrl.toString(), { max: 1 });
  db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db, { migrationsFolder: migrations });
  await seedCampaignFixture();
}, 120_000);

afterAll(async () => {
  await client?.end();
  if (admin) {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}'`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  }
});

describe("0066 OpenCFD 2606 campaign cutover", () => {
  it("seeds a disabled distinct 2606 route and generation-aware campaign schema", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const [implementation] = await client<
      Array<{ release: string; upstream: string }>
    >`
      SELECT release_version AS release, upstream_url AS upstream
      FROM solver_implementations
      WHERE id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
    `;
    expect(implementation).toEqual({
      release: "2606",
      upstream:
        "https://gitlab.com/openfoam/core/openfoam/-/tree/OpenFOAM-v2606",
    });
    const [pool] = await client<Array<{ route: string; enabled: boolean }>>`
      SELECT routing_key AS route, enabled
      FROM solver_execution_pools
      WHERE id = ${OPENCFD_2606_EXECUTION_POOL_ID}
    `;
    expect(pool).toEqual({
      route: "openfoam-opencfd-2606",
      enabled: false,
    });
    const [defaultRow] = await client<Array<{ value: string }>>`
      SELECT column_default AS value
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'solver_profiles'
        AND column_name = 'solver_implementation_id'
    `;
    expect(defaultRow?.value).toContain(OPENCFD_2606_SOLVER_IMPLEMENTATION_ID);
    const [generation] = await client<Array<{ value: number }>>`
      SELECT current_condition_generation AS value
      FROM sim_campaigns WHERE id = ${IDS.campaign}
    `;
    expect(generation?.value).toBe(1);
  });

  it("preflights legacy plans and every source revision before retiring 2406", async () => {
    await db.insert(referenceGeometryProfiles).values({
      id: IDS.extraGeometry,
      slug: "cutover-preflight-extra-geometry",
      name: "Cutover preflight extra geometry",
      referenceLengthM: 1,
      spanM: 1,
    });
    await db.insert(simCampaigns).values({
      id: IDS.invalidCampaign,
      slug: "cutover-preflight-invalid",
      name: "Cutover preflight invalid",
      status: "active",
      priority: 5,
      idempotencyKey: "cutover-preflight-invalid-idempotency",
    });
    await db.insert(simCampaignPlanRevisions).values({
      id: IDS.invalidPlan,
      campaignId: IDS.invalidCampaign,
      revisionNumber: 1,
      kind: "initial",
      plan: {
        ...legacyCampaignPlanWithoutClMax(),
        mediumId: "",
      } as unknown as Record<string, unknown>,
      summary: {},
    });
    await db
      .update(simCampaigns)
      .set({ currentPlanRevisionId: IDS.invalidPlan })
      .where(eq(simCampaigns.id, IDS.invalidCampaign));
    await db.insert(simCampaignAirfoils).values({
      campaignId: IDS.invalidCampaign,
      airfoilId: IDS.airfoil,
    });
    await db.insert(simCampaignConditions).values([
      {
        id: IDS.invalidOldCondition,
        campaignId: IDS.invalidCampaign,
        ord: 0,
        generation: 1,
        flowConditionId: IDS.flow,
        referenceGeometryProfileId: IDS.geometry,
        presetId: IDS.preset,
        simulationPresetRevisionId: IDS.sourceRevision,
        reynolds: sourceSnapshot.derived.reynolds,
        mach: sourceSnapshot.derived.mach,
        status: "active",
        introducedInPlanRevisionId: IDS.invalidPlan,
      },
      {
        id: IDS.invalidMixedCondition,
        campaignId: IDS.invalidCampaign,
        ord: 1,
        generation: 1,
        flowConditionId: IDS.flow,
        referenceGeometryProfileId: IDS.extraGeometry,
        presetId: IDS.preset,
        simulationPresetRevisionId: IDS.targetPolicyCollisionRevision,
        reynolds: sourceSnapshot.derived.reynolds,
        mach: sourceSnapshot.derived.mach,
        status: "active",
        introducedInPlanRevisionId: IDS.invalidPlan,
      },
    ]);
    await db.insert(simCampaignPoints).values([
      {
        campaignId: IDS.invalidCampaign,
        conditionId: IDS.invalidOldCondition,
        airfoilId: IDS.airfoil,
        aoaDeg: 0,
        revisionId: IDS.sourceRevision,
        planRevisionNumber: 1,
        state: "requested",
      },
      {
        campaignId: IDS.invalidCampaign,
        conditionId: IDS.invalidMixedCondition,
        airfoilId: IDS.airfoil,
        aoaDeg: 0,
        revisionId: IDS.targetPolicyCollisionRevision,
        planRevisionNumber: 1,
        state: "requested",
      },
    ]);

    await expect(prepareOpenCfd2606Cutover(db)).rejects.toThrow(
      /plan cannot be replayed/,
    );
    const assertOldAdmissionUntouched = async () => {
      const [pool] = await db
        .select({ enabled: solverExecutionPools.enabled })
        .from(solverExecutionPools)
        .where(eq(solverExecutionPools.id, OPENCFD_2406_EXECUTION_POOL_ID));
      const [implementation] = await db
        .select({ retiredAt: solverImplementations.retiredAt })
        .from(solverImplementations)
        .where(
          eq(solverImplementations.id, OPENCFD_2406_SOLVER_IMPLEMENTATION_ID),
        );
      const [profile] = await db
        .select({ implementationId: solverProfiles.solverImplementationId })
        .from(solverProfiles)
        .where(eq(solverProfiles.id, IDS.solver));
      const [campaign] = await db
        .select({ status: simCampaigns.status })
        .from(simCampaigns)
        .where(eq(simCampaigns.id, IDS.campaign));
      expect(pool.enabled).toBe(true);
      expect(implementation.retiredAt).toBeNull();
      expect(profile.implementationId).toBe(
        OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
      );
      expect(campaign.status).toBe("active");
    };
    await assertOldAdmissionUntouched();

    // A pre-clMax plan is valid and normalizable, so the next preflight reaches
    // the mixed 2606 source revision and rejects that uncloneable generation.
    await db
      .update(simCampaignPlanRevisions)
      .set({
        plan: legacyCampaignPlanWithoutClMax() as unknown as Record<
          string,
          unknown
        >,
      })
      .where(eq(simCampaignPlanRevisions.id, IDS.invalidPlan));
    await expect(prepareOpenCfd2606Cutover(db)).rejects.toThrow(
      /is not a 2406\/legacy cutover revision/,
    );
    await assertOldAdmissionUntouched();

    await db
      .delete(simCampaigns)
      .where(eq(simCampaigns.id, IDS.invalidCampaign));
    await db
      .delete(referenceGeometryProfiles)
      .where(eq(referenceGeometryProfiles.id, IDS.extraGeometry));
  });

  it("preserves old evidence and replaces the full campaign grid with a fresh 2606 generation", async () => {
    const loadOldEvidence = async () => {
      const [row] = await db
        .select({
          resultId: results.id,
          resultStatus: results.status,
          resultSolverImplementationId: results.solverImplementationId,
          attemptId: solverEvidenceArtifacts.resultAttemptId,
          artifactId: solverEvidenceArtifacts.id,
          storageKey: solverEvidenceArtifacts.storageKey,
          sha256: solverEvidenceArtifacts.sha256,
          byteSize: solverEvidenceArtifacts.byteSize,
          artifactSolverImplementationId:
            solverEvidenceArtifacts.solverImplementationId,
          metadata: solverEvidenceArtifacts.metadata,
          createdAt: solverEvidenceArtifacts.createdAt,
        })
        .from(solverEvidenceArtifacts)
        .innerJoin(results, eq(results.id, solverEvidenceArtifacts.resultId))
        .where(eq(solverEvidenceArtifacts.id, IDS.evidenceArtifact));
      return row;
    };
    const oldEvidenceBefore = await loadOldEvidence();
    expect(oldEvidenceBefore).toMatchObject({
      resultId: IDS.failedResult,
      resultStatus: "failed",
      resultSolverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
      attemptId: IDS.failedAttempt,
      artifactId: IDS.evidenceArtifact,
      sha256: OLD_ARTIFACT_SHA256,
      artifactSolverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
    });
    expect((await campaignFailures(db, IDS.campaign)).total).toBe(1);
    expect((await campaignRejected(db, IDS.campaign)).total).toBe(1);

    const prepared = await prepareOpenCfd2606Cutover(db, {
      actor: "cutover-test",
    });
    expect(prepared).toMatchObject({
      status: "prepared",
      campaignsPrepared: 2,
      campaignsPaused: 1,
      solverProfilesMigrated: 1,
      sourcePoolDisabled: true,
      sourceImplementationRetired: true,
    });
    // An interrupted prior attempt may have enabled the target before the
    // operator replays stage 1. Preparation must re-close that admission
    // fence transactionally instead of trusting its prior state.
    await db
      .update(solverExecutionPools)
      .set({ enabled: true })
      .where(eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID));
    const preparedReplay = await prepareOpenCfd2606Cutover(db, {
      actor: "cutover-test-replay",
    });
    expect(preparedReplay).toMatchObject({
      status: "prepared",
      campaignsPrepared: 0,
      campaignsAlreadyPrepared: 2,
      campaignsPaused: 0,
      solverProfilesMigrated: 0,
      pendingJobsCancelled: 0,
      pendingLadderItemsCancelled: 0,
    });
    expect([...preparedReplay.cutoverIds].sort()).toEqual(
      [...prepared.cutoverIds].sort(),
    );
    const [targetPoolAfterReplay] = await db
      .select({ enabled: solverExecutionPools.enabled })
      .from(solverExecutionPools)
      .where(eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID));
    expect(targetPoolAfterReplay.enabled).toBe(false);

    const blockedReadiness = await inspectOpenCfd2606CutoverReadiness(db);
    expect(blockedReadiness).toMatchObject({
      status: "blocked",
      ready: false,
      targetPoolEnabled: false,
    });
    expect(blockedReadiness.blockers).toContainEqual(
      expect.objectContaining({
        kind: "source_job_running",
        ids: [IDS.legacyNullJob],
      }),
    );
    await db
      .update(simJobs)
      .set({ status: "done", completedCases: 1, finishedAt: new Date() })
      .where(eq(simJobs.id, IDS.legacyNullJob));

    const drainedReadiness = await inspectOpenCfd2606CutoverReadiness(db);
    expect(drainedReadiness).toMatchObject({
      status: "ready",
      ready: true,
      targetPoolEnabled: false,
      blockers: [],
    });
    // Deployment activates and canaries the distinct live 2606 route before
    // full-grid finalization. Pool state is orthogonal to the old-job drain.
    await db
      .update(solverExecutionPools)
      .set({ enabled: true })
      .where(eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID));
    expect(await inspectOpenCfd2606CutoverReadiness(db)).toMatchObject({
      ready: true,
      targetPoolEnabled: true,
      blockers: [],
    });

    // Direct finalization cannot substitute "the pool was enabled" for a
    // successful immutable canary receipt.
    await expect(
      finalizeOpenCfd2606Cutover(db, { actor: "direct-bypass-test" }),
    ).rejects.toThrow(/canary attestation/i);
    expect(await db.select().from(solverEngineCanaryAttestations)).toEqual([]);

    const runtimeProvenance = {
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      buildId: "cutover-openfoam-2606-runtime",
      sourceRevision: "481094fdf34f11ed6d0d603ee59a858a0124236d",
      imageDigest: null,
      applicationSourceSha256: "1".repeat(64),
      packageSha256:
        "aa20712a33e41ad7cbe5ee895355aedd7fcbdaf456ae1d4f33db3135827bc07d",
      binarySha256: "2".repeat(64),
      architecture: "x86_64",
    };
    const [runtimeBuild] = await db
      .insert(solverRuntimeBuilds)
      .values({
        ...runtimeProvenance,
        provenanceKey: solverRuntimeProvenanceKey(runtimeProvenance),
        metadata: { source: "cutover-test-canary" },
      })
      .returning();
    const receiptSha256 = "3".repeat(64);
    const attestation = await persistOpenCfd2606CanaryAttestation(db, {
      solverRuntimeBuildId: runtimeBuild.id,
      receiptSha256,
      receipt: { schemaVersion: 1, fixture: "successful-canary" },
      actor: "cutover-test",
    });
    expect(attestation.replayed).toBe(false);
    const attestationReplay = await persistOpenCfd2606CanaryAttestation(db, {
      solverRuntimeBuildId: runtimeBuild.id,
      receiptSha256,
      receipt: { schemaVersion: 1, fixture: "successful-canary" },
      actor: "cutover-test-replay",
    });
    expect(attestationReplay).toMatchObject({
      id: attestation.id,
      solverRuntimeBuildId: runtimeBuild.id,
      replayed: true,
    });

    // Model the late-ingest race: terminal 2406 evidence creates new pending
    // background ladder work after preparation but before finalization.
    await db.insert(simUransRequests).values({
      airfoilId: IDS.airfoil,
      revisionId: IDS.sourceRevision,
      aoaDeg: 1,
      fidelity: "precalc",
      state: "pending",
      requestedBy: "late-ingest-test",
      backgroundOwner: true,
    });
    await db.insert(simPrecalcObligations).values({
      airfoilId: IDS.airfoil,
      revisionId: IDS.sourceRevision,
      aoaDeg: 1,
      sourceResultId: IDS.rejectedResult,
      sourceResultAttemptId: IDS.rejectedAttempt,
      state: "pending",
      backgroundOwner: true,
    });

    const finalized = await finalizeOpenCfd2606Cutover(db, {
      actor: "cutover-test",
      canaryAttestationId: attestation.id,
    });
    expect(finalized).toMatchObject({
      status: "finalized",
      campaignsFinalized: 2,
      sourceConditionsSuperseded: 2,
      targetConditionsCreated: 2,
      targetPointsCreated: 3,
      latePendingLadderItemsCancelled: 2,
    });
    const finalizedReplay = await finalizeOpenCfd2606Cutover(db, {
      actor: "cutover-test-replay",
      canaryAttestationId: attestation.id,
    });
    expect(finalizedReplay).toMatchObject({
      status: "finalized",
      campaignsFinalized: 0,
      campaignsAlreadyFinalized: 2,
      sourceConditionsSuperseded: 0,
      targetConditionsCreated: 0,
      targetPointsCreated: 0,
      latePendingLadderItemsCancelled: 0,
    });
    const differentAttestation = await persistOpenCfd2606CanaryAttestation(db, {
      solverRuntimeBuildId: runtimeBuild.id,
      receiptSha256: "4".repeat(64),
      receipt: { schemaVersion: 1, fixture: "different-canary" },
      actor: "cutover-test",
    });
    await expect(
      finalizeOpenCfd2606Cutover(db, {
        actor: "cutover-conflicting-replay",
        canaryAttestationId: differentAttestation.id,
      }),
    ).rejects.toThrow(/different canary attestation/);

    const conditionRows = (await db.execute(sql`
      SELECT condition.id, condition.generation, condition.status,
             condition.simulation_preset_revision_id AS revision_id,
             revision.solver_implementation_id AS implementation_id
      FROM sim_campaign_conditions condition
      JOIN simulation_preset_revisions revision
        ON revision.id = condition.simulation_preset_revision_id
      WHERE condition.campaign_id = ${IDS.campaign}
      ORDER BY condition.generation
    `)) as unknown as Array<{
      id: string;
      generation: number;
      status: string;
      revision_id: string;
      implementation_id: string;
    }>;
    expect(conditionRows).toHaveLength(2);
    expect(conditionRows[0]).toMatchObject({
      id: IDS.sourceCondition,
      generation: 1,
      status: "superseded",
      revision_id: IDS.sourceRevision,
      implementation_id: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
    });
    expect(conditionRows[1]).toMatchObject({
      generation: 2,
      status: "active",
      implementation_id: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    });
    const pausedConditionRows = (await db.execute(sql`
      SELECT condition.id, condition.generation, condition.status,
             condition.simulation_preset_revision_id AS revision_id,
             revision.solver_implementation_id AS implementation_id
      FROM sim_campaign_conditions condition
      JOIN simulation_preset_revisions revision
        ON revision.id = condition.simulation_preset_revision_id
      WHERE condition.campaign_id = ${IDS.pausedCampaign}
      ORDER BY condition.generation
    `)) as unknown as Array<{
      id: string;
      generation: number;
      status: string;
      revision_id: string;
      implementation_id: string;
    }>;
    expect(pausedConditionRows).toHaveLength(2);
    expect(pausedConditionRows[0]).toMatchObject({
      id: IDS.pausedSourceCondition,
      generation: 1,
      status: "superseded",
      revision_id: IDS.legacyRevision,
      implementation_id: LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
    });
    expect(pausedConditionRows[1]).toMatchObject({
      generation: 2,
      status: "active",
      implementation_id: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    });
    const targetCondition = conditionRows[1];
    const pointRows = (await db.execute(sql`
      SELECT condition_id, state, result_id, result_attempt_id,
             revision_id, plan_revision_number, aoa_deg::float8 AS aoa
      FROM sim_campaign_points
      WHERE campaign_id = ${IDS.campaign}
      ORDER BY condition_id, aoa_deg
    `)) as unknown as Array<{
      condition_id: string;
      state: string;
      result_id: string | null;
      result_attempt_id: string | null;
      revision_id: string;
      plan_revision_number: number;
      aoa: number;
    }>;
    const sourcePoints = pointRows.filter(
      (point) => point.condition_id === IDS.sourceCondition,
    );
    const targetPoints = pointRows.filter(
      (point) => point.condition_id === targetCondition.id,
    );
    expect(sourcePoints.map((point) => point.state)).toEqual([
      "released",
      "released",
    ]);
    expect(sourcePoints.map((point) => point.result_id)).toEqual([
      IDS.failedResult,
      IDS.rejectedResult,
    ]);
    expect(targetPoints).toHaveLength(2);
    expect(targetPoints.every((point) => point.state === "requested")).toBe(
      true,
    );
    expect(targetPoints.every((point) => point.result_id === null)).toBe(true);

    const [targetRevision] = await db
      .select()
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, targetCondition.revision_id))
      .limit(1);
    const targetSnapshot =
      targetRevision.snapshot as unknown as SimulationSetupSnapshot;
    const expectedTargetSnapshot = JSON.parse(
      JSON.stringify(sourceSnapshot),
    ) as SimulationSetupSnapshot;
    expectedTargetSnapshot.engine = targetSnapshot.engine;
    expect(targetRevision.id).not.toBe(IDS.targetPolicyCollisionRevision);
    expect(targetRevision.signatureHash).toBe(
      simulationSetupSignature(expectedTargetSnapshot),
    );
    expect(targetSnapshot.scheduling).toEqual(sourceSnapshot.scheduling);
    expect(targetSnapshot.output).toEqual(sourceSnapshot.output);
    expect(targetSnapshot.sweep).toEqual(sourceSnapshot.sweep);
    expect(targetRevision.isCanonicalMethod).toBe(false);
    expect(targetRevision.physicsHash).toBe(
      physicsHashForSnapshot(sourceSnapshot),
    );
    expect(targetRevision.methodCompatibilityHash).not.toBe(
      methodCompatibilityHashForSnapshot(sourceSnapshot),
    );
    const [policyCollision] = await db
      .select()
      .from(simulationPresetRevisions)
      .where(
        eq(simulationPresetRevisions.id, IDS.targetPolicyCollisionRevision),
      );
    expect(policyCollision.methodCompatibilityHash).toBe(
      targetRevision.methodCompatibilityHash,
    );
    expect(policyCollision.signatureHash).not.toBe(
      targetRevision.signatureHash,
    );

    const [pausedTargetPlan] = await db
      .select({ plan: simCampaignPlanRevisions.plan })
      .from(simCampaigns)
      .innerJoin(
        simCampaignPlanRevisions,
        eq(simCampaignPlanRevisions.id, simCampaigns.currentPlanRevisionId),
      )
      .where(eq(simCampaigns.id, IDS.pausedCampaign));
    expect(
      (pausedTargetPlan.plan as unknown as ReturnType<typeof campaignPlan>)
        .objectives.clMax,
    ).toEqual({ enabled: false, toleranceDeg: "0.10", maxRounds: 8 });

    expect((await campaignFailures(db, IDS.campaign)).total).toBe(0);
    expect((await campaignRejected(db, IDS.campaign)).total).toBe(0);
    const noRequeue = await requeueCampaignFailed(db, IDS.campaign, {
      expectedCount: 0,
      includeRejected: true,
      expectedRejectedCount: 0,
    });
    expect(noRequeue.requeued).toBe(0);
    const [oldResults] = (await db.execute(sql`
      SELECT
        (SELECT status FROM results WHERE id = ${IDS.failedResult}) AS failed_status,
        (SELECT status FROM results WHERE id = ${IDS.rejectedResult}) AS rejected_status,
        (SELECT count(*)::int FROM result_attempts
          WHERE id IN (${IDS.failedAttempt}, ${IDS.rejectedAttempt})) AS attempts
    `)) as unknown as Array<{
      failed_status: string;
      rejected_status: string;
      attempts: number;
    }>;
    expect(oldResults).toEqual({
      failed_status: "failed",
      rejected_status: "done",
      attempts: 2,
    });
    expect(await loadOldEvidence()).toEqual(oldEvidenceBefore);
    const [legacyJob] = await db
      .select({
        status: simJobs.status,
        solverImplementationId: simJobs.solverImplementationId,
        solverExecutionPoolId: simJobs.solverExecutionPoolId,
      })
      .from(simJobs)
      .where(eq(simJobs.id, IDS.legacyNullJob));
    expect(legacyJob).toEqual({
      status: "done",
      solverImplementationId: null,
      solverExecutionPoolId: null,
    });
    expect(await campaignReviewBuckets(db, IDS.campaign)).toEqual({
      awaitingUrans: 0,
      needsReview: 0,
    });
    expect((await campaignSummary(db, IDS.campaign)).conditions).toHaveLength(
      1,
    );
    expect((await campaignLanes(db, IDS.campaign)).items).toEqual([]);
    await expect(
      campaignLaneDetail(db, IDS.campaign, {
        airfoilId: IDS.airfoil,
        conditionId: IDS.sourceCondition,
        objective: "ld_max",
      }),
    ).rejects.toThrow(/lane not found/);
    await expect(
      continueLane(
        db,
        IDS.campaign,
        {
          airfoilId: IDS.airfoil,
          conditionId: IDS.sourceCondition,
          objective: "ld_max",
        },
        1,
      ),
    ).rejects.toThrow(/not actionable/);

    // Stage 3 also fails closed if the canaried target route regresses between
    // finalization and campaign resumption.
    await db
      .update(solverExecutionPools)
      .set({ enabled: false })
      .where(eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID));
    await expect(
      completeOpenCfd2606Cutover(db, {
        actor: "cutover-test",
        canaryAttestationId: attestation.id,
      }),
    ).rejects.toThrow(/must be enabled/);
    await expect(
      persistOpenCfd2606CanaryAttestation(db, {
        solverRuntimeBuildId: runtimeBuild.id,
        receiptSha256: "5".repeat(64),
        receipt: { fixture: "must-rollback-while-pool-disabled" },
      }),
    ).rejects.toThrow(/must remain enabled/);
    expect(
      await db
        .select({ id: solverEngineCanaryAttestations.id })
        .from(solverEngineCanaryAttestations)
        .where(
          eq(solverEngineCanaryAttestations.receiptSha256, "5".repeat(64)),
        ),
    ).toEqual([]);
    await db
      .update(solverExecutionPools)
      .set({ enabled: true })
      .where(eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID));
    const completed = await completeOpenCfd2606Cutover(db, {
      actor: "cutover-test",
      canaryAttestationId: attestation.id,
    });
    expect(completed).toMatchObject({
      status: "completed",
      campaignsCompleted: 2,
      campaignsResumed: 1,
      campaignsLeftPaused: 1,
      sourcePoolDisabled: true,
      sourceImplementationRetired: true,
    });
    const completedReplay = await completeOpenCfd2606Cutover(db, {
      actor: "cutover-test-replay",
      canaryAttestationId: attestation.id,
    });
    expect(completedReplay).toMatchObject({
      status: "completed",
      campaignsCompleted: 0,
      campaignsAlreadyCompleted: 2,
      campaignsResumed: 0,
      campaignsLeftPaused: 0,
    });
    const campaignStatuses = await db
      .select({ id: simCampaigns.id, status: simCampaigns.status })
      .from(simCampaigns)
      .where(
        sql`${simCampaigns.id} IN (${IDS.campaign}, ${IDS.pausedCampaign})`,
      );
    expect(
      Object.fromEntries(
        campaignStatuses.map((campaign) => [campaign.id, campaign.status]),
      ),
    ).toEqual({
      [IDS.campaign]: "active",
      [IDS.pausedCampaign]: "paused",
    });
    expect(await loadOldEvidence()).toEqual(oldEvidenceBefore);

    // A successor job with missing implementation/pool stamps is a visible
    // route defect, not a pending success. Remove the isolated bad fixture,
    // then prove pending -> routed -> partial-running evidence progression.
    const cancelledUnsubmittedJobId = randomUUID();
    await db.insert(simJobs).values({
      id: cancelledUnsubmittedJobId,
      airfoilId: IDS.airfoil,
      bcIds: [IDS.boundaryCondition],
      simulationPresetRevisionId: targetCondition.revision_id,
      campaignId: IDS.campaign,
      methodKey: "openfoam.rans",
      referenceChordM: 1,
      status: "cancelled",
      solverImplementationId: null,
      solverExecutionPoolId: null,
    });
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({
      status: "pending",
      simJobId: null,
      lastError: null,
      requiredCampaigns: 1,
      campaigns: [
        expect.objectContaining({
          campaignId: IDS.campaign,
          status: "pending",
        }),
      ],
    });

    const assertAggregateSharedAndPausedOnly = async (
      evidenceTargetPoint: (typeof targetPoints)[number],
      validEvidenceResultId: string,
      evidenceJobId: string,
    ) => {
      // One exact solve may legitimately settle matching target points in more
      // than one campaign. The second campaign proves continuation through its
      // linked point/result/current-attempt lineage even though the producing
      // job remains owned by the first campaign.
      const sharedCampaignId = randomUUID();
      const sharedSourcePlanId = randomUUID();
      const sharedTargetPlanId = randomUUID();
      const sharedSourceConditionId = randomUUID();
      const sharedTargetConditionId = randomUUID();
      const sharedCutoverId = randomUUID();
      await db.insert(simCampaigns).values({
        id: sharedCampaignId,
        slug: `shared-cutover-${sharedCampaignId}`,
        name: "Shared cutover evidence campaign",
        status: "active",
        priority: 5,
        idempotencyKey: `shared-cutover-${sharedCampaignId}`,
        currentConditionGeneration: 2,
        currentPlanRevisionId: null,
      });
      await db.insert(simCampaignPlanRevisions).values([
        {
          id: sharedSourcePlanId,
          campaignId: sharedCampaignId,
          revisionNumber: 1,
          kind: "initial",
          plan: campaignPlan() as unknown as Record<string, unknown>,
          summary: {},
        },
        {
          id: sharedTargetPlanId,
          campaignId: sharedCampaignId,
          revisionNumber: 2,
          kind: "engine_cutover",
          plan: campaignPlan() as unknown as Record<string, unknown>,
          summary: {},
        },
      ]);
      await db
        .update(simCampaigns)
        .set({ currentPlanRevisionId: sharedTargetPlanId })
        .where(eq(simCampaigns.id, sharedCampaignId));
      await db.insert(simCampaignAirfoils).values({
        campaignId: sharedCampaignId,
        airfoilId: IDS.airfoil,
      });
      await db.insert(simCampaignConditions).values([
        {
          id: sharedSourceConditionId,
          campaignId: sharedCampaignId,
          ord: 0,
          generation: 1,
          flowConditionId: IDS.flow,
          referenceGeometryProfileId: IDS.geometry,
          presetId: IDS.preset,
          simulationPresetRevisionId: IDS.sourceRevision,
          reynolds: sourceSnapshot.derived.reynolds,
          mach: sourceSnapshot.derived.mach,
          status: "superseded",
          supersededAt: new Date(),
          introducedInPlanRevisionId: sharedSourcePlanId,
          statusChangedInPlanRevisionId: sharedTargetPlanId,
        },
        {
          id: sharedTargetConditionId,
          campaignId: sharedCampaignId,
          ord: 0,
          generation: 2,
          flowConditionId: IDS.flow,
          referenceGeometryProfileId: IDS.geometry,
          presetId: IDS.preset,
          simulationPresetRevisionId: targetCondition.revision_id,
          reynolds: sourceSnapshot.derived.reynolds,
          mach: sourceSnapshot.derived.mach,
          status: "active",
          supersedesConditionId: sharedSourceConditionId,
          introducedInPlanRevisionId: sharedTargetPlanId,
        },
      ]);
      await db.insert(simCampaignPoints).values([
        {
          campaignId: sharedCampaignId,
          conditionId: sharedSourceConditionId,
          airfoilId: IDS.airfoil,
          aoaDeg: evidenceTargetPoint.aoa,
          revisionId: IDS.sourceRevision,
          planRevisionNumber: 1,
          state: "released",
        },
        {
          campaignId: sharedCampaignId,
          conditionId: sharedTargetConditionId,
          airfoilId: IDS.airfoil,
          aoaDeg: evidenceTargetPoint.aoa,
          revisionId: targetCondition.revision_id,
          planRevisionNumber: 2,
          state: "terminal",
          resultId: validEvidenceResultId,
          // Normal campaign evidence linking does not need to duplicate the
          // result's authoritative current attempt on the point row.
          resultAttemptId: null,
        },
      ]);
      const beforeSharedJob = new Date(Date.now() - 60_000);
      await db.insert(simCampaignSolverCutovers).values({
        id: sharedCutoverId,
        campaignId: sharedCampaignId,
        fromSolverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
        toSolverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        canaryAttestationId: attestation.id,
        sourcePlanRevisionId: sharedSourcePlanId,
        targetPlanRevisionId: sharedTargetPlanId,
        sourceGeneration: 1,
        targetGeneration: 2,
        priorCampaignStatus: "active",
        status: "completed",
        sourceConditionCount: 1,
        targetConditionCount: 1,
        targetPointCount: 1,
        finalizedAt: beforeSharedJob,
        completedAt: beforeSharedJob,
      });
      await db.insert(simCampaignSolverCutoverPoints).values({
        cutoverId: sharedCutoverId,
        campaignId: sharedCampaignId,
        sourceConditionId: sharedSourceConditionId,
        targetConditionId: sharedTargetConditionId,
        airfoilId: IDS.airfoil,
        aoaDeg: evidenceTargetPoint.aoa,
        targetRevisionId: targetCondition.revision_id,
      });
      const aggregateSharedProof = await inspectOpenCfd2606Continuation(
        db,
        attestation.id,
      );
      expect(aggregateSharedProof).toMatchObject({
        status: "evidence",
        requiredCampaigns: 2,
        lastError: null,
      });
      expect(aggregateSharedProof.campaigns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            campaignId: IDS.campaign,
            status: "evidence",
          }),
          expect.objectContaining({
            campaignId: sharedCampaignId,
            status: "evidence",
            simJobId: evidenceJobId,
            evidenceResultId: validEvidenceResultId,
          }),
        ]),
      );

      const pausedOnlyCampaignId = randomUUID();
      const pausedOnlySourcePlanId = randomUUID();
      const pausedOnlyTargetPlanId = randomUUID();
      await db.insert(simCampaigns).values({
        id: pausedOnlyCampaignId,
        slug: `paused-only-${pausedOnlyCampaignId}`,
        name: "Paused-only cutover",
        status: "paused",
        priority: 5,
        idempotencyKey: `paused-only-${pausedOnlyCampaignId}`,
        currentConditionGeneration: 2,
      });
      await db.insert(simCampaignPlanRevisions).values([
        {
          id: pausedOnlySourcePlanId,
          campaignId: pausedOnlyCampaignId,
          revisionNumber: 1,
          kind: "initial",
          plan: campaignPlan() as unknown as Record<string, unknown>,
          summary: {},
        },
        {
          id: pausedOnlyTargetPlanId,
          campaignId: pausedOnlyCampaignId,
          revisionNumber: 2,
          kind: "engine_cutover",
          plan: campaignPlan() as unknown as Record<string, unknown>,
          summary: {},
        },
      ]);
      await db
        .update(simCampaigns)
        .set({ currentPlanRevisionId: pausedOnlyTargetPlanId })
        .where(eq(simCampaigns.id, pausedOnlyCampaignId));
      await db.insert(simCampaignSolverCutovers).values({
        campaignId: pausedOnlyCampaignId,
        fromSolverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
        toSolverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        canaryAttestationId: differentAttestation.id,
        sourcePlanRevisionId: pausedOnlySourcePlanId,
        targetPlanRevisionId: pausedOnlyTargetPlanId,
        sourceGeneration: 1,
        targetGeneration: 2,
        priorCampaignStatus: "paused",
        status: "completed",
        sourceConditionCount: 0,
        targetConditionCount: 0,
        targetPointCount: 0,
        finalizedAt: new Date(),
        completedAt: new Date(),
      });
      expect(
        await inspectOpenCfd2606Continuation(db, differentAttestation.id),
      ).toMatchObject({
        status: "not_required",
        requiredCampaigns: 0,
        campaigns: [],
        simJobId: null,
        evidenceResultId: null,
        lastError: null,
      });
    };
    await db.delete(simJobs).where(eq(simJobs.id, cancelledUnsubmittedJobId));

    const failedBeforeAcceptanceJobId = randomUUID();
    await db.insert(simJobs).values({
      id: failedBeforeAcceptanceJobId,
      airfoilId: IDS.airfoil,
      bcIds: [IDS.boundaryCondition],
      simulationPresetRevisionId: targetCondition.revision_id,
      campaignId: IDS.campaign,
      methodKey: "openfoam.rans",
      referenceChordM: 1,
      status: "failed",
      error: "transient submit failed before engine acceptance",
      solverImplementationId: null,
      solverExecutionPoolId: null,
    });
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({ status: "pending", lastError: null });
    await db.delete(simJobs).where(eq(simJobs.id, failedBeforeAcceptanceJobId));

    // Every original source cell must remain represented in the exact target
    // generation. A missing row cannot be hidden by a healthy job from the
    // remaining subset.
    const temporarilyMissingPoint = targetPoints[1];
    await db
      .delete(simCampaignPoints)
      .where(
        and(
          eq(simCampaignPoints.campaignId, IDS.campaign),
          eq(simCampaignPoints.conditionId, targetCondition.id),
          eq(simCampaignPoints.aoaDeg, temporarilyMissingPoint.aoa),
        ),
      );
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({
      status: "pending",
      lastError: expect.stringContaining("point coverage"),
      requiredCampaigns: 1,
    });
    await db.insert(simCampaignPoints).values({
      campaignId: IDS.campaign,
      conditionId: targetCondition.id,
      airfoilId: IDS.airfoil,
      aoaDeg: temporarilyMissingPoint.aoa,
      revisionId: temporarilyMissingPoint.revision_id,
      planRevisionNumber: temporarilyMissingPoint.plan_revision_number,
      state: "requested",
    });
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({ status: "pending", lastError: null });

    const pendingWrongSuccessorJobId = randomUUID();
    await db.insert(simJobs).values({
      id: pendingWrongSuccessorJobId,
      airfoilId: IDS.airfoil,
      bcIds: [IDS.boundaryCondition],
      simulationPresetRevisionId: targetCondition.revision_id,
      campaignId: IDS.campaign,
      methodKey: "openfoam.rans",
      referenceChordM: 1,
      status: "pending",
      solverImplementationId: null,
      solverExecutionPoolId: null,
    });
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({
      status: "pending",
      lastError: expect.stringContaining(pendingWrongSuccessorJobId),
    });
    await db.delete(simJobs).where(eq(simJobs.id, pendingWrongSuccessorJobId));

    const wrongSuccessorJobId = randomUUID();
    await db.insert(simJobs).values({
      id: wrongSuccessorJobId,
      engineJobId: "wrong-successor-engine-job",
      airfoilId: IDS.airfoil,
      bcIds: [IDS.boundaryCondition],
      simulationPresetRevisionId: targetCondition.revision_id,
      campaignId: IDS.campaign,
      methodKey: "openfoam.rans",
      referenceChordM: 1,
      status: "running",
      solverImplementationId: null,
      solverExecutionPoolId: null,
    });
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({
      status: "pending",
      simJobId: null,
      lastError: expect.stringContaining("non-attested route"),
    });
    await db.delete(simJobs).where(eq(simJobs.id, wrongSuccessorJobId));

    const successorJobId = randomUUID();
    await db.insert(simJobs).values({
      id: successorJobId,
      engineJobId: "successor-engine-job",
      airfoilId: IDS.airfoil,
      bcIds: [IDS.boundaryCondition],
      simulationPresetRevisionId: targetCondition.revision_id,
      campaignId: IDS.campaign,
      methodKey: "openfoam.rans",
      referenceChordM: 1,
      status: "running",
      submittedAt: new Date(),
      totalCases: 2,
      completedCases: 1,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverRuntimeBuildId: runtimeBuild.id,
      solverExecutionPoolId: OPENCFD_2606_EXECUTION_POOL_ID,
    });
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({
      status: "routed",
      simJobId: successorJobId,
      evidenceResultId: null,
      lastError: null,
    });
    const mixedWrongJobId = randomUUID();
    await db.insert(simJobs).values({
      id: mixedWrongJobId,
      engineJobId: "mixed-wrong-engine-job",
      airfoilId: IDS.airfoil,
      bcIds: [IDS.boundaryCondition],
      simulationPresetRevisionId: targetCondition.revision_id,
      campaignId: IDS.campaign,
      methodKey: "openfoam.rans",
      referenceChordM: 1,
      status: "running",
      solverImplementationId: null,
      solverExecutionPoolId: null,
    });
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({
      status: "routed",
      simJobId: successorJobId,
      lastError: expect.stringContaining(mixedWrongJobId),
    });
    await db.delete(simJobs).where(eq(simJobs.id, mixedWrongJobId));
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({ status: "routed", lastError: null });

    const otherRuntimeProvenance = {
      ...runtimeProvenance,
      buildId: "cutover-openfoam-2606-other-runtime",
      applicationSourceSha256: "6".repeat(64),
    };
    const [otherRuntime] = await db
      .insert(solverRuntimeBuilds)
      .values({
        ...otherRuntimeProvenance,
        provenanceKey: solverRuntimeProvenanceKey(otherRuntimeProvenance),
        metadata: { source: "cutover-wrong-runtime-test" },
      })
      .returning();
    const mixedRuntimeJobId = randomUUID();
    await db.insert(simJobs).values({
      id: mixedRuntimeJobId,
      engineJobId: "mixed-runtime-engine-job",
      airfoilId: IDS.airfoil,
      bcIds: [IDS.boundaryCondition],
      simulationPresetRevisionId: targetCondition.revision_id,
      campaignId: IDS.campaign,
      methodKey: "openfoam.rans",
      referenceChordM: 1,
      status: "running",
      submittedAt: new Date(),
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverRuntimeBuildId: otherRuntime.id,
      solverExecutionPoolId: OPENCFD_2606_EXECUTION_POOL_ID,
    });
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({
      status: "routed",
      simJobId: successorJobId,
      lastError: expect.stringContaining("non-attested runtime"),
    });
    await db.delete(simJobs).where(eq(simJobs.id, mixedRuntimeJobId));
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({ status: "routed", lastError: null });

    // DB-level false-positive guard: evidence status cannot exist without an
    // exact evidence result id.
    await expect(
      db
        .update(solverCutoverContinuationChecks)
        .set({ status: "evidence", evidenceAt: new Date() })
        .where(
          eq(
            solverCutoverContinuationChecks.canaryAttestationId,
            attestation.id,
          ),
        ),
    ).rejects.toThrow();

    const evidenceJobId = randomUUID();
    await db.insert(simJobs).values({
      id: evidenceJobId,
      engineJobId: "successor-evidence-engine-job",
      airfoilId: IDS.airfoil,
      bcIds: [IDS.boundaryCondition],
      simulationPresetRevisionId: targetCondition.revision_id,
      campaignId: IDS.campaign,
      methodKey: "openfoam.rans",
      referenceChordM: 1,
      status: "running",
      submittedAt: new Date(),
      totalCases: 2,
      completedCases: 1,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverRuntimeBuildId: runtimeBuild.id,
      solverExecutionPoolId: OPENCFD_2606_EXECUTION_POOL_ID,
    });
    const partialResultId = randomUUID();
    const partialAttemptId = randomUUID();
    await db.insert(results).values({
      id: partialResultId,
      airfoilId: IDS.airfoil,
      bcId: IDS.boundaryCondition,
      simulationPresetRevisionId: targetCondition.revision_id,
      aoaDeg: 42,
      status: "done",
      source: "solved",
      regime: "rans",
      fidelity: "rans",
      simJobId: evidenceJobId,
      engineJobId: "successor-evidence-engine-job",
      methodKey: "openfoam.rans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverRuntimeBuildId: runtimeBuild.id,
      converged: true,
      cl: 0.3,
      cd: 0.03,
      solvedAt: new Date(),
    });
    await db.insert(resultAttempts).values({
      id: partialAttemptId,
      resultId: partialResultId,
      airfoilId: IDS.airfoil,
      bcId: IDS.boundaryCondition,
      simulationPresetRevisionId: targetCondition.revision_id,
      aoaDeg: 42,
      simJobId: evidenceJobId,
      engineJobId: "successor-evidence-engine-job",
      methodKey: "openfoam.rans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverRuntimeBuildId: runtimeBuild.id,
      status: "done",
      source: "solved",
      regime: "rans",
      converged: true,
      cl: 0.3,
      cd: 0.03,
      evidencePayload: { evidence_artifacts: [{ kind: "manifest" }] },
      solvedAt: new Date(),
    });
    await db
      .update(results)
      .set({ currentResultAttemptId: partialAttemptId })
      .where(eq(results.id, partialResultId));
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({
      status: "routed",
      evidenceResultId: null,
      lastError: null,
    });

    const evidenceTargetPoint = targetPoints[0];
    const validEvidenceResultId = randomUUID();
    const validEvidenceAttemptId = randomUUID();
    await db.insert(results).values({
      id: validEvidenceResultId,
      airfoilId: IDS.airfoil,
      bcId: IDS.boundaryCondition,
      simulationPresetRevisionId: targetCondition.revision_id,
      aoaDeg: evidenceTargetPoint.aoa,
      status: "done",
      source: "solved",
      regime: "rans",
      fidelity: "rans",
      simJobId: evidenceJobId,
      engineJobId: "successor-evidence-engine-job",
      methodKey: "openfoam.rans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverRuntimeBuildId: runtimeBuild.id,
      converged: true,
      cl: 0.2,
      cd: 0.02,
      solvedAt: new Date(),
    });
    await db.insert(resultAttempts).values({
      id: validEvidenceAttemptId,
      resultId: validEvidenceResultId,
      airfoilId: IDS.airfoil,
      bcId: IDS.boundaryCondition,
      simulationPresetRevisionId: targetCondition.revision_id,
      aoaDeg: evidenceTargetPoint.aoa,
      simJobId: evidenceJobId,
      engineJobId: "successor-evidence-engine-job",
      methodKey: "openfoam.rans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverRuntimeBuildId: runtimeBuild.id,
      status: "done",
      source: "solved",
      regime: "rans",
      converged: true,
      cl: 0.2,
      cd: 0.02,
      solvedAt: new Date(),
    });
    await db
      .update(results)
      .set({ currentResultAttemptId: validEvidenceAttemptId })
      .where(eq(results.id, validEvidenceResultId));
    await db
      .update(simCampaignPoints)
      .set({
        state: "terminal",
        resultId: validEvidenceResultId,
        resultAttemptId: validEvidenceAttemptId,
      })
      .where(
        and(
          eq(simCampaignPoints.campaignId, IDS.campaign),
          eq(simCampaignPoints.conditionId, targetCondition.id),
          eq(simCampaignPoints.aoaDeg, evidenceTargetPoint.aoa),
        ),
      );
    await db.insert(resultClassifications).values({
      resultId: validEvidenceResultId,
      resultAttemptId: validEvidenceAttemptId,
      airfoilId: IDS.airfoil,
      simulationPresetRevisionId: targetCondition.revision_id,
      aoaDeg: evidenceTargetPoint.aoa,
      regime: "rans",
      classifierVersion: "cutover-test",
      state: "accepted",
      confidence: 1,
    });

    const invalidManifestId = randomUUID();
    await db.insert(solverEvidenceArtifacts).values({
      id: invalidManifestId,
      resultId: validEvidenceResultId,
      resultAttemptId: validEvidenceAttemptId,
      airfoilId: IDS.airfoil,
      simJobId: evidenceJobId,
      engineJobId: "successor-evidence-engine-job",
      methodKey: "openfoam.rans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverRuntimeBuildId: runtimeBuild.id,
      aoaDeg: evidenceTargetPoint.aoa,
      kind: "manifest",
      storageKey: "",
      mimeType: "",
      sha256: "7".repeat(64),
      byteSize: 123,
    });
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({ status: "routed", evidenceResultId: null });
    await db
      .delete(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.id, invalidManifestId));
    const mismatchedCaseManifestId = randomUUID();
    await db.insert(solverEvidenceArtifacts).values({
      id: mismatchedCaseManifestId,
      resultId: validEvidenceResultId,
      resultAttemptId: validEvidenceAttemptId,
      airfoilId: IDS.airfoil,
      simJobId: evidenceJobId,
      engineJobId: "successor-evidence-engine-job",
      engineCaseSlug: "wrong-case",
      methodKey: "openfoam.rans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverRuntimeBuildId: runtimeBuild.id,
      aoaDeg: evidenceTargetPoint.aoa,
      kind: "manifest",
      storageKey: "cutover/2606/wrong-case-manifest.json",
      mimeType: "application/json",
      sha256: "9".repeat(64),
      byteSize: 456,
    });
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({ status: "routed", evidenceResultId: null });
    await db
      .delete(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.id, mismatchedCaseManifestId));
    await db.insert(solverEvidenceArtifacts).values({
      resultId: validEvidenceResultId,
      resultAttemptId: validEvidenceAttemptId,
      airfoilId: IDS.airfoil,
      simJobId: evidenceJobId,
      engineJobId: "successor-evidence-engine-job",
      methodKey: "openfoam.rans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverRuntimeBuildId: runtimeBuild.id,
      aoaDeg: evidenceTargetPoint.aoa,
      kind: "manifest",
      storageKey: "cutover/2606/valid-manifest.json",
      mimeType: "application/json",
      sha256: "8".repeat(64),
      byteSize: 456,
    });
    expect(
      await inspectOpenCfd2606Continuation(db, attestation.id),
    ).toMatchObject({
      status: "evidence",
      simJobId: evidenceJobId,
      evidenceResultId: validEvidenceResultId,
      lastError: null,
      requiredCampaigns: 1,
      campaigns: [
        expect.objectContaining({
          campaignId: IDS.campaign,
          status: "evidence",
          evidenceResultId: validEvidenceResultId,
        }),
      ],
    });
    await assertAggregateSharedAndPausedOnly(
      evidenceTargetPoint,
      validEvidenceResultId,
      evidenceJobId,
    );
    const [successorJob] = await db
      .select({ status: simJobs.status, ingestedAt: simJobs.ingestedAt })
      .from(simJobs)
      .where(eq(simJobs.id, evidenceJobId));
    expect(successorJob).toEqual({ status: "running", ingestedAt: null });

    // Settle the fresh target grid with accepted 2606 evidence. The old
    // awaiting lane remains stored but must not prevent current-generation
    // completion.
    for (const targetPoint of targetPoints) {
      if (targetPoint.aoa === evidenceTargetPoint.aoa) continue;
      const resultId = randomUUID();
      await db.insert(results).values({
        id: resultId,
        airfoilId: IDS.airfoil,
        bcId: IDS.boundaryCondition,
        simulationPresetRevisionId: targetCondition.revision_id,
        aoaDeg: targetPoint.aoa,
        status: "done",
        source: "solved",
        regime: "rans",
        fidelity: "rans",
        cl: 0.2 + targetPoint.aoa,
        cd: 0.02,
        converged: true,
        solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        solvedAt: new Date(),
      });
      await db.insert(resultClassifications).values({
        resultId,
        airfoilId: IDS.airfoil,
        simulationPresetRevisionId: targetCondition.revision_id,
        aoaDeg: targetPoint.aoa,
        regime: "rans",
        classifierVersion: "cutover-test",
        state: "accepted",
        confidence: 1,
      });
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal", resultId })
        .where(
          and(
            eq(simCampaignPoints.campaignId, IDS.campaign),
            eq(simCampaignPoints.conditionId, targetCondition.id),
            eq(simCampaignPoints.aoaDeg, targetPoint.aoa),
          ),
        );
    }
    await recomputeCampaignProgress(db as never, IDS.campaign);
    await probeCampaignCompletion(db, IDS.campaign);
    const [campaign] = await db
      .select({ status: simCampaigns.status })
      .from(simCampaigns)
      .where(eq(simCampaigns.id, IDS.campaign));
    expect(campaign.status).toBe("completed");
  }, 120_000);
});
