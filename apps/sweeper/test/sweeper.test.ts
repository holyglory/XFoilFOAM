import "./enabled-engine-pool-fixture";

import {
  airfoils,
  boundaryProfiles,
  boundaryConditions,
  categories,
  claimSimJobCancellation,
  createClient,
  ensurePrecalcObligations,
  fieldColorScales,
  flowConditions,
  forceHistory,
  meshProfiles,
  outputProfiles,
  polarFitSets,
  refreshPolarCacheForRevision,
  referenceGeometryProfiles,
  resultClassifications,
  resultAttempts,
  resultFieldExtents,
  resultMediaRepairs,
  mediums,
  lockPrecalcCells,
  resultMedia,
  results,
  requeueSinglePoint,
  schedulingProfiles,
  simJobs,
  simCampaigns,
  simCampaignConditions,
  simCampaignPlanRevisions,
  simCampaignPoints,
  simPrecalcObligationAttempts,
  simPrecalcObligationCampaigns,
  simPrecalcObligations,
  simRansPolarPromotionPoints,
  simRansPolarPromotions,
  simUransVerifyQueue,
  simulationPresetAirfoilTargets,
  simulationPresets,
  solverEvidenceArtifacts,
  solverProfiles,
  syncSweepPromises,
  syncSweepPromisePoints,
  syncRemotePromiseCancellations,
  sweeperState,
  sweepDefinitions,
  discoverMissingResultMediaRepairs,
} from "@aerodb/db";
import {
  EngineClient,
  EngineError,
  WORKER_RESTART_ORPHAN_MESSAGE,
  type EngineQueueState,
  type JobResult,
  type JobStatus,
} from "@aerodb/engine-client";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import { and, asc, eq, inArray, isNotNull, notIlike } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildPolarRequest } from "../src/build-request";
import { claimAoas } from "../src/claim";
import { findGaps, firstBatch } from "../src/gaps";
import { touchHeartbeat } from "../src/heartbeat";
import {
  ingestResult,
  repairDefaultMediaForStoredResult,
  retryFailedScaleRenders,
} from "../src/ingest";
import {
  reconcile,
  resetOrphans,
  submitUransRetryForJob,
} from "../src/reconcile";
import { solverQueuePressure } from "../src/submit-lifecycle";
import { withExactManifestEvidence } from "./exact-result-fixture";

const { db, sql } = createClient({ max: 4 });
const engine = new EngineClient("http://engine.test");
const testRunSlug = `sweeper-test-${process.pid}-${Date.now()}`;
const mediaRoot = resolve("/tmp", testRunSlug);
const previousMediaDir = process.env.MEDIA_DIR;
process.env.MEDIA_DIR = mediaRoot;

let airfoilId = "";
let categoryId = "";
let bcId = "";
let testPresetId = "";
let testPresetRevisionId = "";
const cleanupResultIds = new Set<string>();
const cleanupAttemptIds = new Set<string>();
const cleanupJobIds = new Set<string>();
const cleanupPresetIds = new Set<string>();
const cleanupLegacyBcIds = new Set<string>();
const cleanupFlowIds = new Set<string>();
const cleanupReferenceGeometryIds = new Set<string>();
const cleanupBoundaryProfileIds = new Set<string>();
const cleanupMeshProfileIds = new Set<string>();
const cleanupSolverProfileIds = new Set<string>();
const cleanupSchedulingProfileIds = new Set<string>();
const cleanupOutputProfileIds = new Set<string>();
const cleanupSweepIds = new Set<string>();
const cleanupSyncPromiseIds = new Set<string>();
const cleanupAirfoilIds = new Set<string>();
let restoreSweeperEnabled: boolean | null = null;

async function createTestAirfoil(label: string) {
  if (!categoryId) {
    const [category] = await db
      .insert(categories)
      .values({
        slug: `${testRunSlug}-category`,
        name: `${testRunSlug} category`,
        path: `${testRunSlug}-category`,
        depth: 0,
      })
      .returning({ id: categories.id });
    categoryId = category.id;
  }
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${testRunSlug}-${label}`,
      name: `${testRunSlug} ${label}`,
      categoryId,
      source: "test-fixture",
      pointFormat: "normalized",
      points: [
        { x: 1, y: 0 },
        { x: 0.5, y: 0.08 },
        { x: 0, y: 0 },
        { x: 0.5, y: -0.04 },
        { x: 1, y: 0 },
      ],
      isSymmetric: false,
    })
    .returning();
  cleanupAirfoilIds.add(airfoil.id);
  return airfoil;
}

function renderedMediaArtifact(args: {
  jobId: string;
  path: string;
  field: string;
  kind: "image" | "video";
  role: "instantaneous" | "mean";
}) {
  const cleanPath = args.path.replace(/^\/+/, "");
  const jobPrefix = `jobs/${args.jobId}/files/`;
  const storageKey = cleanPath.startsWith(jobPrefix)
    ? `jobs/${args.jobId}/${cleanPath.slice(jobPrefix.length)}`
    : cleanPath;
  const bytes = Buffer.from(`${testRunSlug}:${storageKey}`, "utf8");
  const fullPath = resolve(mediaRoot, storageKey);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, bytes);
  return {
    kind: args.kind,
    field: args.field,
    role: args.role,
    path: args.path,
    url: args.path,
    mime_type: args.kind === "video" ? "video/mp4" : "image/png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byte_size: bytes.byteLength,
  };
}

function emptyQueue(jobIds: string[] = []): EngineQueueState {
  return {
    queue_depth: 0,
    active: jobIds.map((job_id) => ({
      worker: "test",
      task_id: `task-${job_id}`,
      name: "airfoilfoam.run_polar",
      job_id,
      redelivered: false,
    })),
    reserved: [],
    scheduled: [],
    active_count: jobIds.length,
    reserved_count: 0,
    scheduled_count: 0,
    job_ids: jobIds,
    duplicates: {},
    redelivered: [],
  };
}

/** Assert the 0047 physical-work contract for an accepted automatic PRECALC
 * submission. The canonical RANS row is deliberately outside this helper:
 * it remains immutable evidence (or its original wave-1 claim), while this
 * exact cell ledger owns the forced-transient work. */
async function expectBackgroundPrecalcSubmission(
  child: typeof simJobs.$inferSelect,
  expectedAoas: number[],
) {
  expect(child.campaignId).toBeNull();
  expect(child.status).toBe("submitted");
  expect(child.engineJobId).not.toBeNull();
  const obligationIds = (
    child.requestPayload as { precalcObligationIds?: string[] }
  ).precalcObligationIds;
  expect(obligationIds).toHaveLength(expectedAoas.length);
  expect(new Set(obligationIds).size).toBe(expectedAoas.length);

  const obligations = await db
    .select()
    .from(simPrecalcObligations)
    .where(inArray(simPrecalcObligations.id, obligationIds!))
    .orderBy(asc(simPrecalcObligations.aoaDeg));
  expect(obligations.map((row) => row.aoaDeg)).toEqual(
    [...expectedAoas].sort((a, b) => a - b),
  );
  expect(
    obligations.every(
      (row) =>
        row.state === "running" &&
        row.attemptCount === 1 &&
        row.latestSimJobId === child.id &&
        row.backgroundOwner,
    ),
  ).toBe(true);

  const attempts = await db
    .select({
      obligationId: simPrecalcObligationAttempts.obligationId,
      simJobId: simPrecalcObligationAttempts.simJobId,
      attemptNumber: simPrecalcObligationAttempts.attemptNumber,
      state: simPrecalcObligationAttempts.state,
    })
    .from(simPrecalcObligationAttempts)
    .where(inArray(simPrecalcObligationAttempts.obligationId, obligationIds!));
  expect(attempts).toHaveLength(expectedAoas.length);
  expect(
    attempts.every(
      (attempt) =>
        attempt.simJobId === child.id &&
        attempt.attemptNumber === 1 &&
        attempt.state === "submitted",
    ),
  ).toBe(true);
  expect(
    await db
      .select({ campaignId: simPrecalcObligationCampaigns.campaignId })
      .from(simPrecalcObligationCampaigns)
      .where(
        inArray(simPrecalcObligationCampaigns.obligationId, obligationIds!),
      ),
  ).toEqual([]);
  return obligations;
}

async function firstAirfoilBc() {
  const [a] = airfoilId
    ? await db
        .select()
        .from(airfoils)
        .where(eq(airfoils.id, airfoilId))
        .limit(1)
    : await db.select().from(airfoils).limit(1);
  const [bc] = await db
    .select()
    .from(boundaryConditions)
    .where(eq(boundaryConditions.id, testBcId()))
    .limit(1);
  if (!a || !bc)
    throw new Error("seeded airfoil and boundary condition required");
  return {
    a,
    bc,
    presetId: testPresetId,
    presetRevisionId: testPresetRevisionId,
  };
}

/** Production-shaped owner handoff: immutable RANS attempt/classification
 * evidence created a precalc child, and that child currently owns the
 * canonical result row. Engine cancellation/loss must release this row as a
 * queued/no-owner wave-2 obligation, not a generic pending RANS gap. */
async function evidenceBackedWave2Fixture(
  label: string,
  aoa: number,
  childState: "running" | "failed",
) {
  const { a, bc, presetRevisionId } = await firstAirfoilBc();
  await db
    .delete(results)
    .where(
      and(
        eq(results.airfoilId, a.id),
        eq(results.simulationPresetRevisionId, presetRevisionId),
        eq(results.aoaDeg, aoa),
      ),
    );
  const [parent] = await db
    .insert(simJobs)
    .values({
      airfoilId: a.id,
      bcIds: [bc.id],
      simulationPresetRevisionId: presetRevisionId,
      referenceChordM: bc.referenceChordM,
      wave: 1,
      status: "done",
      jobKind: "targeted",
      engineJobId: `${label}-parent`,
      totalCases: 1,
      completedCases: 1,
      requestPayload: {
        speedMap: [
          { speed: bc.speedMps, bcId: bc.id, presetRevisionId, mach: bc.mach },
        ],
        aoas: [aoa],
      },
      ingestedAt: new Date(),
      finishedAt: new Date(),
    })
    .returning();
  const [obligation] = await ensurePrecalcObligations(
    db,
    [{ airfoilId: a.id, revisionId: presetRevisionId, aoaDeg: aoa }],
    { backgroundOwner: true },
  );
  const [child] = await db
    .insert(simJobs)
    .values({
      parentJobId: parent.id,
      airfoilId: a.id,
      bcIds: [bc.id],
      simulationPresetRevisionId: presetRevisionId,
      referenceChordM: bc.referenceChordM,
      wave: 2,
      status: childState,
      jobKind: "targeted",
      engineJobId: `${label}-child`,
      engineState: childState === "failed" ? "missing" : "running",
      error: childState === "failed" ? "engine job not found (lost)" : null,
      totalCases: 1,
      requestPayload: {
        speedMap: [
          { speed: bc.speedMps, bcId: bc.id, presetRevisionId, mach: bc.mach },
        ],
        aoas: [aoa],
        parentJobId: parent.id,
        uransFidelity: "precalc",
        precalcObligationIds: [obligation.id],
      },
    })
    .returning();
  await db
    .update(simPrecalcObligations)
    .set({
      state: "running",
      attemptCount: 1,
      latestSimJobId: child.id,
      lastOutcome: "submitted",
      lastAttemptAt: new Date(),
    })
    .where(eq(simPrecalcObligations.id, obligation.id));
  await db.insert(simPrecalcObligationAttempts).values({
    obligationId: obligation.id,
    simJobId: child.id,
    attemptNumber: 1,
    state: "submitted",
  });
  const [row] = await db
    .insert(results)
    .values({
      airfoilId: a.id,
      bcId: bc.id,
      simulationPresetRevisionId: presetRevisionId,
      aoaDeg: aoa,
      status: childState,
      source: "queued",
      regime: "rans",
      fidelity: "rans",
      simJobId: child.id,
      engineJobId: child.engineJobId,
      converged: false,
      stalled: true,
      error: "RANS did not converge; precalc evidence is still owed",
    })
    .returning();
  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: row.id,
      airfoilId: a.id,
      bcId: bc.id,
      simulationPresetRevisionId: presetRevisionId,
      aoaDeg: aoa,
      simJobId: parent.id,
      engineJobId: parent.engineJobId,
      status: "failed",
      source: "queued",
      regime: "rans",
      validForPolar: false,
      converged: false,
      stalled: true,
      unsteady: false,
      error: "RANS did not converge",
      evidencePayload: { failure_disposition: "hard_solver" },
      solvedAt: new Date(),
    })
    .returning();
  await db.insert(resultClassifications).values([
    {
      resultId: row.id,
      airfoilId: a.id,
      simulationPresetRevisionId: presetRevisionId,
      aoaDeg: aoa,
      regime: "rans",
      classifierVersion: "scheduler-release-test-v1",
      state: "rejected",
      reasons: ["RANS did not converge"],
    },
    {
      resultAttemptId: attempt.id,
      airfoilId: a.id,
      simulationPresetRevisionId: presetRevisionId,
      aoaDeg: aoa,
      regime: "rans",
      classifierVersion: "scheduler-release-test-v1",
      state: "rejected",
      reasons: ["RANS did not converge"],
    },
  ]);
  cleanupJobIds.add(parent.id);
  cleanupJobIds.add(child.id);
  cleanupResultIds.add(row.id);
  cleanupAttemptIds.add(attempt.id);
  return { parent, child, row, obligation };
}

function testBcId(): string {
  if (!bcId) throw new Error("test boundary condition not initialized");
  return bcId;
}

async function testGaps(limit = 10000) {
  return (await findGaps(db, limit)).filter(
    (gap) => gap.presetRevisionId === testPresetRevisionId,
  );
}

async function testBatch(limit = 500) {
  return firstBatch(await testGaps(limit));
}

async function ensureTestSetup() {
  const [medium] = await db
    .select()
    .from(mediums)
    .where(eq(mediums.slug, "air"))
    .limit(1);
  if (!medium) throw new Error("seeded air medium required");
  // This file owns its airfoil. Binding a long suite to a catalog row or to an
  // unordered fixture from another parallel file makes cascade cleanup in the
  // other owner capable of deleting this suite's results mid-run.
  airfoilId = (await createTestAirfoil("main-airfoil")).id;
  const reynolds = 500_000;
  const chord = 1;
  const speed = (reynolds * medium.kinematicViscosity) / chord;
  const mach = medium.speedOfSound ? speed / medium.speedOfSound : null;
  const [legacy] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${testRunSlug}-air-re-500k`,
      name: `${testRunSlug} Air Re 500k`,
      mediumId: medium.id,
      reynolds,
      referenceChordM: chord,
      temperatureK: medium.refTemperatureK,
      pressurePa: medium.refPressurePa,
      speedMps: speed,
      density: medium.density,
      dynamicViscosity: medium.dynamicViscosity,
      kinematicViscosity: medium.kinematicViscosity,
      mach,
      enabled: true,
    })
    .returning();
  cleanupLegacyBcIds.add(legacy.id);
  bcId = legacy.id;
  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${testRunSlug}-flow`,
      name: `${testRunSlug} flow`,
      mediumId: medium.id,
      temperatureK: medium.refTemperatureK,
      pressurePa: medium.refPressurePa,
      speedMps: speed,
      density: medium.density,
      dynamicViscosity: medium.dynamicViscosity,
      kinematicViscosity: medium.kinematicViscosity,
      mach,
    })
    .returning();
  cleanupFlowIds.add(flow.id);
  const [referenceGeometry] = await db
    .insert(referenceGeometryProfiles)
    .values({
      slug: `${testRunSlug}-reference-geometry`,
      name: `${testRunSlug} reference geometry`,
      geometryType: "airfoil_2d",
      referenceLengthKind: "chord",
      referenceLengthM: chord,
    })
    .returning();
  cleanupReferenceGeometryIds.add(referenceGeometry.id);
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({
      slug: `${testRunSlug}-boundary`,
      name: `${testRunSlug} boundary`,
    })
    .returning();
  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${testRunSlug}-mesh`, name: `${testRunSlug} mesh` })
    .returning();
  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: `${testRunSlug}-solver`, name: `${testRunSlug} solver` })
    .returning();
  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({
      slug: `${testRunSlug}-scheduling`,
      name: `${testRunSlug} scheduling`,
    })
    .returning();
  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${testRunSlug}-output`, name: `${testRunSlug} output` })
    .returning();
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({
      slug: `${testRunSlug}-sweep`,
      name: `${testRunSlug} sweep`,
      aoaList: [81.001, 82.001, 83.001, 91.001, 92.001, 93.001],
    })
    .returning();
  cleanupBoundaryProfileIds.add(boundary.id);
  cleanupMeshProfileIds.add(mesh.id);
  cleanupSolverProfileIds.add(solver.id);
  cleanupSchedulingProfileIds.add(scheduling.id);
  cleanupOutputProfileIds.add(output.id);
  cleanupSweepIds.add(sweep.id);
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${testRunSlug}-preset`,
      name: `${testRunSlug} preset`,
      flowConditionId: flow.id,
      referenceGeometryProfileId: referenceGeometry.id,
      boundaryProfileId: boundary.id,
      meshProfileId: mesh.id,
      solverProfileId: solver.id,
      schedulingProfileId: scheduling.id,
      outputProfileId: output.id,
      sweepDefinitionId: sweep.id,
      legacyBoundaryConditionId: legacy.id,
      enabled: true,
      targetScope: "airfoils",
    })
    .returning();
  cleanupPresetIds.add(preset.id);
  await db
    .insert(simulationPresetAirfoilTargets)
    .values({ presetId: preset.id, airfoilId });
  testPresetId = preset.id;
  const resolved = await ensureSimulationPresetRevision(db, preset.id);
  if (!resolved) throw new Error("test setup revision required");
  testPresetRevisionId = resolved.revision.id;
}

beforeAll(async () => {
  const [state] = await db
    .select({ enabled: sweeperState.enabled })
    .from(sweeperState)
    .where(eq(sweeperState.id, 1))
    .limit(1);
  restoreSweeperEnabled = state?.enabled ?? false;
  await db
    .insert(sweeperState)
    .values({ id: 1, enabled: false })
    .onConflictDoUpdate({ target: sweeperState.id, set: { enabled: false } });
  await ensureTestSetup();
});

afterAll(async () => {
  if (cleanupSyncPromiseIds.size) {
    await db
      .delete(syncRemotePromiseCancellations)
      .where(
        inArray(
          syncRemotePromiseCancellations.promiseId,
          Array.from(cleanupSyncPromiseIds),
        ),
      );
    await db
      .delete(syncSweepPromises)
      .where(inArray(syncSweepPromises.id, Array.from(cleanupSyncPromiseIds)));
  }
  if (testPresetRevisionId) {
    await db
      .delete(polarFitSets)
      .where(eq(polarFitSets.simulationPresetRevisionId, testPresetRevisionId));
    await db
      .delete(resultClassifications)
      .where(
        eq(
          resultClassifications.simulationPresetRevisionId,
          testPresetRevisionId,
        ),
      );
    await db
      .delete(results)
      .where(eq(results.simulationPresetRevisionId, testPresetRevisionId));
    await db
      .delete(resultAttempts)
      .where(
        eq(resultAttempts.simulationPresetRevisionId, testPresetRevisionId),
      );
    await db
      .delete(simJobs)
      .where(eq(simJobs.simulationPresetRevisionId, testPresetRevisionId));
  }
  if (cleanupAttemptIds.size)
    await db
      .delete(resultAttempts)
      .where(inArray(resultAttempts.id, Array.from(cleanupAttemptIds)));
  if (cleanupResultIds.size)
    await db
      .delete(results)
      .where(inArray(results.id, Array.from(cleanupResultIds)));
  if (cleanupJobIds.size)
    await db
      .delete(simJobs)
      .where(inArray(simJobs.id, Array.from(cleanupJobIds)));
  if (cleanupPresetIds.size)
    await db
      .delete(simulationPresets)
      .where(inArray(simulationPresets.id, Array.from(cleanupPresetIds)));
  if (cleanupLegacyBcIds.size)
    await db
      .delete(boundaryConditions)
      .where(inArray(boundaryConditions.id, Array.from(cleanupLegacyBcIds)));
  if (cleanupFlowIds.size)
    await db
      .delete(flowConditions)
      .where(inArray(flowConditions.id, Array.from(cleanupFlowIds)));
  if (cleanupReferenceGeometryIds.size)
    await db
      .delete(referenceGeometryProfiles)
      .where(
        inArray(
          referenceGeometryProfiles.id,
          Array.from(cleanupReferenceGeometryIds),
        ),
      );
  if (cleanupBoundaryProfileIds.size)
    await db
      .delete(boundaryProfiles)
      .where(
        inArray(boundaryProfiles.id, Array.from(cleanupBoundaryProfileIds)),
      );
  if (cleanupMeshProfileIds.size)
    await db
      .delete(meshProfiles)
      .where(inArray(meshProfiles.id, Array.from(cleanupMeshProfileIds)));
  if (cleanupSolverProfileIds.size)
    await db
      .delete(solverProfiles)
      .where(inArray(solverProfiles.id, Array.from(cleanupSolverProfileIds)));
  if (cleanupSchedulingProfileIds.size)
    await db
      .delete(schedulingProfiles)
      .where(
        inArray(schedulingProfiles.id, Array.from(cleanupSchedulingProfileIds)),
      );
  if (cleanupOutputProfileIds.size)
    await db
      .delete(outputProfiles)
      .where(inArray(outputProfiles.id, Array.from(cleanupOutputProfileIds)));
  if (cleanupSweepIds.size)
    await db
      .delete(sweepDefinitions)
      .where(inArray(sweepDefinitions.id, Array.from(cleanupSweepIds)));
  if (cleanupAirfoilIds.size)
    await db
      .delete(airfoils)
      .where(inArray(airfoils.id, Array.from(cleanupAirfoilIds)));
  if (categoryId)
    await db.delete(categories).where(eq(categories.id, categoryId));
  if (restoreSweeperEnabled !== null) {
    await db
      .insert(sweeperState)
      .values({ id: 1, enabled: restoreSweeperEnabled })
      .onConflictDoUpdate({
        target: sweeperState.id,
        set: { enabled: restoreSweeperEnabled },
      });
  }
  await sql.end();
  rmSync(mediaRoot, { recursive: true, force: true });
  if (previousMediaDir == null) delete process.env.MEDIA_DIR;
  else process.env.MEDIA_DIR = previousMediaDir;
});

describe("sweeper: gap → claim → ingest", () => {
  it("finds gaps across the seeded catalog", async () => {
    const gaps = await findGaps(db, 500);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0]).toHaveProperty("airfoilId");
    expect(gaps[0]).toHaveProperty("bcId");
    expect(typeof gaps[0].aoaDeg).toBe("number");
  }, 60000);

  it("scopes preset gaps to selected airfoils", async () => {
    // Same stable non-fixture pick as ensureTestSetup (cross-file race guard).
    const [target, excluded] = await db
      .select({ id: airfoils.id })
      .from(airfoils)
      .where(notIlike(airfoils.slug, "sw-%"))
      .orderBy(asc(airfoils.slug))
      .limit(2);
    expect(target?.id).toBeTruthy();
    expect(excluded?.id).toBeTruthy();
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, target.id),
          eq(results.simulationPresetRevisionId, testPresetRevisionId),
        ),
      );
    await db
      .delete(simulationPresetAirfoilTargets)
      .where(eq(simulationPresetAirfoilTargets.presetId, testPresetId));
    await db
      .update(simulationPresets)
      .set({ targetScope: "airfoils" })
      .where(eq(simulationPresets.id, testPresetId));
    await db
      .insert(simulationPresetAirfoilTargets)
      .values({ presetId: testPresetId, airfoilId: target.id });
    try {
      const gaps = await testGaps(10000);
      expect(gaps.length).toBeGreaterThan(0);
      expect(new Set(gaps.map((gap) => gap.airfoilId))).toEqual(
        new Set([target.id]),
      );
      expect(gaps.some((gap) => gap.airfoilId === excluded.id)).toBe(false);
    } finally {
      await db
        .delete(simulationPresetAirfoilTargets)
        .where(eq(simulationPresetAirfoilTargets.presetId, testPresetId));
      await db
        .insert(simulationPresetAirfoilTargets)
        .values({ presetId: testPresetId, airfoilId });
      await db
        .update(simulationPresets)
        .set({ targetScope: "airfoils" })
        .where(eq(simulationPresets.id, testPresetId));
    }
  }, 60000);

  it("excludes active external sync promises and releases them after expiry", async () => {
    const gaps = await testGaps(10000);
    expect(gaps.length).toBeGreaterThan(1);
    const first = gaps[0];
    const promised = gaps
      .filter(
        (gap) =>
          gap.airfoilId === first.airfoilId &&
          gap.presetRevisionId === first.presetRevisionId,
      )
      .slice(0, 2);
    expect(promised.length).toBe(2);

    const [promise] = await db
      .insert(syncSweepPromises)
      .values({
        sourceInstanceId: "remote-test",
        sourceInstanceName: "remote test",
        airfoilId: first.airfoilId,
        simulationPresetRevisionId: first.presetRevisionId,
        aoaCount: promised.length,
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning({ id: syncSweepPromises.id });
    cleanupSyncPromiseIds.add(promise.id);
    await db.insert(syncSweepPromisePoints).values(
      promised.map((gap) => ({
        promiseId: promise.id,
        airfoilId: gap.airfoilId,
        simulationPresetRevisionId: gap.presetRevisionId,
        aoaDeg: gap.aoaDeg,
      })),
    );

    const hidden = await testGaps(10000);
    for (const gap of promised) {
      expect(
        hidden.some(
          (candidate) =>
            candidate.airfoilId === gap.airfoilId &&
            candidate.presetRevisionId === gap.presetRevisionId &&
            candidate.aoaDeg === gap.aoaDeg,
        ),
      ).toBe(false);
    }

    await db
      .update(syncSweepPromises)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(syncSweepPromises.id, promise.id));
    const released = await testGaps(10000);
    for (const gap of promised) {
      expect(
        released.some(
          (candidate) =>
            candidate.airfoilId === gap.airfoilId &&
            candidate.presetRevisionId === gap.presetRevisionId &&
            candidate.aoaDeg === gap.aoaDeg,
        ),
      ).toBe(true);
    }
  }, 60000);

  it("claims a batch, then refuses to re-claim queued rows", async () => {
    const batch = await testBatch(500);
    expect(batch).not.toBeNull();
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: batch!.airfoilId,
        bcIds: [batch!.bcId],
        simulationPresetRevisionId: batch!.presetRevisionId,
        referenceChordM: 1,
        wave: 1,
        status: "pending",
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const some = [91.001, 92.001, 93.001];
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, batch!.airfoilId),
          eq(results.simulationPresetRevisionId, batch!.presetRevisionId),
          inArray(results.aoaDeg, some),
        ),
      );
    const first = await claimAoas(
      db,
      batch!.airfoilId,
      batch!.bcId,
      batch!.presetRevisionId,
      some,
      job.id,
    );
    expect(first.length).toBe(3);
    const claimedRows = await db
      .select({
        id: results.id,
        source: results.source,
        status: results.status,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, batch!.airfoilId),
          eq(results.simulationPresetRevisionId, batch!.presetRevisionId),
          inArray(results.aoaDeg, some),
        ),
      );
    claimedRows.forEach((r) => cleanupResultIds.add(r.id));
    expect(
      claimedRows.every((r) => r.source === "queued" && r.status === "queued"),
    ).toBe(true);
    const again = await claimAoas(
      db,
      batch!.airfoilId,
      batch!.bcId,
      batch!.presetRevisionId,
      some,
      job.id,
    );
    expect(again.length).toBe(0);
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, batch!.airfoilId),
          eq(results.simulationPresetRevisionId, batch!.presetRevisionId),
          inArray(results.aoaDeg, some),
        ),
      );
  }, 60000);

  it("refuses ledger-owned cells at the continuous and campaign claim boundaries", async () => {
    const batch = await testBatch(500);
    expect(batch).not.toBeNull();
    const freshAoa = 94.001;
    const existingAoa = 95.001;
    await db
      .delete(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, batch!.airfoilId),
          eq(simPrecalcObligations.revisionId, batch!.presetRevisionId),
          inArray(simPrecalcObligations.aoaDeg, [freshAoa, existingAoa]),
        ),
      );
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, batch!.airfoilId),
          eq(results.simulationPresetRevisionId, batch!.presetRevisionId),
          inArray(results.aoaDeg, [freshAoa, existingAoa]),
        ),
      );
    const obligations = await ensurePrecalcObligations(
      db,
      [freshAoa, existingAoa].map((aoaDeg) => ({
        airfoilId: batch!.airfoilId,
        revisionId: batch!.presetRevisionId,
        aoaDeg,
      })),
      { backgroundOwner: true },
    );
    expect(obligations).toHaveLength(2);
    const [pending] = await db
      .insert(results)
      .values({
        airfoilId: batch!.airfoilId,
        bcId: batch!.bcId,
        simulationPresetRevisionId: batch!.presetRevisionId,
        aoaDeg: existingAoa,
        status: "pending",
        source: "queued",
      })
      .returning({ id: results.id });
    cleanupResultIds.add(pending.id);
    const [campaign] = await db
      .insert(simCampaigns)
      .values({
        slug: `${testRunSlug}-claim-lock`,
        name: `${testRunSlug} claim lock`,
        status: "active",
        priority: 5,
        idempotencyKey: `${testRunSlug}-claim-lock`,
      })
      .returning({ id: simCampaigns.id });
    const jobs = await db
      .insert(simJobs)
      .values([
        {
          airfoilId: batch!.airfoilId,
          bcIds: [batch!.bcId],
          simulationPresetRevisionId: batch!.presetRevisionId,
          referenceChordM: 1,
          wave: 1,
          status: "pending",
        },
        {
          airfoilId: batch!.airfoilId,
          bcIds: [batch!.bcId],
          simulationPresetRevisionId: batch!.presetRevisionId,
          campaignId: campaign.id,
          referenceChordM: 1,
          wave: 1,
          status: "pending",
        },
      ])
      .returning({ id: simJobs.id });
    jobs.forEach((job) => cleanupJobIds.add(job.id));

    expect(
      await claimAoas(
        db,
        batch!.airfoilId,
        batch!.bcId,
        batch!.presetRevisionId,
        [freshAoa],
        jobs[0].id,
      ),
    ).toEqual([]);
    const campaignClaim = await db.transaction(async (tx) => {
      await tx
        .select({ id: simCampaigns.id })
        .from(simCampaigns)
        .where(eq(simCampaigns.id, campaign.id))
        .for("update");
      return claimAoas(
        tx,
        batch!.airfoilId,
        batch!.bcId,
        batch!.presetRevisionId,
        [existingAoa],
        jobs[1].id,
      );
    });
    expect(campaignClaim).toEqual([]);
    const [unchanged] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, pending.id));
    expect(unchanged).toEqual({ status: "pending", simJobId: null });
    expect(
      await db
        .select({ id: results.id })
        .from(results)
        .where(
          and(
            eq(results.airfoilId, batch!.airfoilId),
            eq(results.simulationPresetRevisionId, batch!.presetRevisionId),
            eq(results.aoaDeg, freshAoa),
          ),
        ),
    ).toHaveLength(0);

    await db.delete(simJobs).where(
      inArray(
        simJobs.id,
        jobs.map((job) => job.id),
      ),
    );
    jobs.forEach((job) => cleanupJobIds.delete(job.id));
    await db.delete(simCampaigns).where(eq(simCampaigns.id, campaign.id));
    await db.delete(simPrecalcObligations).where(
      inArray(
        simPrecalcObligations.id,
        obligations.map((obligation) => obligation.id),
      ),
    );
  }, 60_000);

  it("serializes obligation creation against generic requeue with no ledger-owned pending loser", async () => {
    const batch = await testBatch(500);
    expect(batch).not.toBeNull();
    const aoa = 96.001;
    await db
      .delete(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, batch!.airfoilId),
          eq(simPrecalcObligations.revisionId, batch!.presetRevisionId),
          eq(simPrecalcObligations.aoaDeg, aoa),
        ),
      );
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, batch!.airfoilId),
          eq(results.simulationPresetRevisionId, batch!.presetRevisionId),
          eq(results.aoaDeg, aoa),
        ),
      );
    const [failed] = await db
      .insert(results)
      .values({
        airfoilId: batch!.airfoilId,
        bcId: batch!.bcId,
        simulationPresetRevisionId: batch!.presetRevisionId,
        aoaDeg: aoa,
        status: "failed",
        source: "queued",
        regime: "rans",
        error: "transient simpleFoam failure",
      })
      .returning({ id: results.id });
    cleanupResultIds.add(failed.id);
    const [campaign] = await db
      .insert(simCampaigns)
      .values({
        slug: `${testRunSlug}-requeue-lock-order`,
        name: `${testRunSlug} requeue lock order`,
        status: "active",
        priority: 5,
        idempotencyKey: `${testRunSlug}-requeue-lock-order`,
      })
      .returning({ id: simCampaigns.id });
    const [plan] = await db
      .insert(simCampaignPlanRevisions)
      .values({
        campaignId: campaign.id,
        revisionNumber: 1,
        kind: "initial",
        plan: {},
        summary: {},
      })
      .returning({ id: simCampaignPlanRevisions.id });
    await db
      .update(simCampaigns)
      .set({ currentPlanRevisionId: plan.id })
      .where(eq(simCampaigns.id, campaign.id));
    const [preset] = await db
      .select({
        flowConditionId: simulationPresets.flowConditionId,
        referenceGeometryProfileId:
          simulationPresets.referenceGeometryProfileId,
      })
      .from(simulationPresets)
      .where(eq(simulationPresets.id, testPresetId));
    const [condition] = await db
      .insert(simCampaignConditions)
      .values({
        campaignId: campaign.id,
        ord: 0,
        flowConditionId: preset.flowConditionId,
        referenceGeometryProfileId: preset.referenceGeometryProfileId,
        presetId: testPresetId,
        simulationPresetRevisionId: batch!.presetRevisionId,
        reynolds: 500_000,
        status: "active",
        introducedInPlanRevisionId: plan.id,
      })
      .returning({ id: simCampaignConditions.id });
    await db.insert(simCampaignPoints).values({
      campaignId: campaign.id,
      conditionId: condition.id,
      airfoilId: batch!.airfoilId,
      aoaDeg: aoa,
      revisionId: batch!.presetRevisionId,
      planRevisionNumber: 1,
      state: "terminal",
      resultId: failed.id,
      derivedBySymmetry: false,
    });

    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockedPromise = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = db.transaction(async (tx) => {
      await tx
        .select({ id: simCampaigns.id })
        .from(simCampaigns)
        .where(eq(simCampaigns.id, campaign.id))
        .for("update");
      await lockPrecalcCells(tx, [
        {
          airfoilId: batch!.airfoilId,
          revisionId: batch!.presetRevisionId,
          aoaDeg: aoa,
        },
      ]);
      locked();
      await releasePromise;
    });
    await lockedPromise;
    const obligationPromise = ensurePrecalcObligations(
      db,
      [
        {
          airfoilId: batch!.airfoilId,
          revisionId: batch!.presetRevisionId,
          aoaDeg: aoa,
          sourceResultId: failed.id,
        },
      ],
      { campaignIds: [campaign.id] },
    );
    const requeuePromise = requeueSinglePoint(db, failed.id);
    release();
    await blocker;
    const [obligationOutcome, requeueOutcome] = await Promise.allSettled([
      obligationPromise,
      requeuePromise,
    ]);
    const [result] = await db
      .select({ status: results.status })
      .from(results)
      .where(eq(results.id, failed.id));
    const obligationRows = await db
      .select({ id: simPrecalcObligations.id })
      .from(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, batch!.airfoilId),
          eq(simPrecalcObligations.revisionId, batch!.presetRevisionId),
          eq(simPrecalcObligations.aoaDeg, aoa),
        ),
      );
    expect(obligationRows.length === 1 || result.status === "pending").toBe(
      true,
    );
    expect(obligationRows.length === 1 && result.status === "pending").toBe(
      false,
    );
    if (obligationRows.length === 1) {
      expect(result.status).toBe("failed");
      expect(requeueOutcome.status).toBe("rejected");
    } else {
      expect(result.status).toBe("pending");
      expect(obligationOutcome).toMatchObject({
        status: "fulfilled",
        value: [],
      });
    }
    if (obligationRows.length)
      await db
        .delete(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligationRows[0].id));
    await db.delete(simCampaigns).where(eq(simCampaigns.id, campaign.id));
  }, 60_000);

  it("ingests a JobResult idempotently and registers media", async () => {
    const batch = (await testBatch(500))!;
    const [a] = await db
      .select()
      .from(airfoils)
      .where(eq(airfoils.id, batch.airfoilId))
      .limit(1);
    const [bc] = await db
      .select()
      .from(boundaryConditions)
      .where(eq(boundaryConditions.id, batch.bcId))
      .limit(1);
    const setup = await ensureSimulationPresetRevision(db, batch.presetId);
    airfoilId = a.id;
    bcId = bc.id;
    if (!setup) throw new Error("simulation preset revision required");
    const steadyAoa = 81.001;
    const uransAoa = 82.001;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, batch.presetRevisionId),
          inArray(results.aoaDeg, [steadyAoa, uransAoa]),
        ),
      );

    const { request, speed } = buildPolarRequest({
      airfoil: a,
      setup: setup.snapshot,
      aoaList: [steadyAoa, uransAoa],
      wave: 1,
    });
    expect(speed).toBeCloseTo(bc.speedMps, 8);
    expect(request.resources?.policy).toBe(bc.schedulingPolicy ?? "auto");
    expect(request.solver?.warm_start).toBe(true);
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: batch.presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "running",
        engineJobId: "testjob",
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);

    const manifestArtifact = (caseSlug: string) => ({
      kind: "manifest",
      path: `/jobs/testjob/files/evidence/${caseSlug}/evidence_manifest.json`,
      url: `/jobs/testjob/files/evidence/${caseSlug}/evidence_manifest.json`,
      mime_type: "application/json",
      sha256: `sha-${caseSlug}`,
      byte_size: 128,
      metadata: { evidenceBase: `/tmp/evidence/${caseSlug}` },
    });
    let extentCalls = 0;
    let defaultRenderCalls = 0;
    const mediaEngine = {
      baseUrl: "http://engine.test",
      computeFieldExtents: async (
        _jobId: string,
        request: { case_slug: string },
      ) => {
        extentCalls++;
        return {
          fields:
            request.case_slug === "c1"
              ? {
                  velocity_magnitude: { min: 0, max: 42, finite_count: 100 },
                  pressure: { min: -2, max: 4, finite_count: 100 },
                }
              : {
                  velocity_magnitude: { min: 0, max: 55, finite_count: 100 },
                },
          window_start: null,
          window_end: null,
        };
      },
      renderDefaultMedia: async (
        jobId: string,
        request: {
          case_slug: string;
          fields?: string[];
          unsteady?: boolean;
          scale_version?: number;
          render_profile_key?: string;
        },
      ) => {
        defaultRenderCalls++;
        const version = request.scale_version ?? 1;
        const profile = request.render_profile_key ?? "default:v1:zoom2";
        const base = `/jobs/${jobId}/files/evidence/scaled_media/${profile}/v${version}/${request.case_slug}`;
        const fields = request.fields ?? [];
        return {
          images: fields.map((field) =>
            renderedMediaArtifact({
              jobId,
              path: `${base}/${field}.png`,
              field,
              kind: "image",
              role: "instantaneous",
            }),
          ),
          mean_images: request.unsteady
            ? fields.map((field) =>
                renderedMediaArtifact({
                  jobId,
                  path: `${base}/${field}_mean.png`,
                  field,
                  kind: "image",
                  role: "mean",
                }),
              )
            : [],
          videos: request.unsteady
            ? fields.map((field) =>
                renderedMediaArtifact({
                  jobId,
                  path: `${base}/${field}.mp4`,
                  field,
                  kind: "video",
                  role: "instantaneous",
                }),
              )
            : [],
          window_start: null,
          window_end: null,
          scale_version: version,
          render_profile_key: profile,
        };
      },
    } as unknown as EngineClient;

    const result: JobResult = {
      job_id: "testjob",
      state: "completed",
      polars: [
        {
          speed,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: 0.1,
          points: [
            {
              case_slug: "c1",
              aoa_deg: steadyAoa,
              cl: 0.41,
              cd: 0.009,
              cm: -0.01,
              cl_cd: 45.5,
              unsteady: false,
              converged: true,
              first_order_fallback: false,
              images: {
                velocity_magnitude:
                  "/jobs/testjob/files/cases/c1/images/velocity_magnitude.png",
                pressure: "/jobs/testjob/files/cases/c1/images/pressure.png",
              },
              evidence_artifacts: [
                manifestArtifact("c1"),
                {
                  // Engine shared-mesh evidence has a more specific wire kind
                  // than the current DB enum. Ingest must retain it as mesh
                  // evidence with its original kind in provenance, never skip
                  // an immutable artifact because the enum is coarser.
                  kind: "mesh_evidence",
                  path: "/jobs/testjob/files/evidence/c1/openfoam/mesh_evidence/manifest.json",
                  url: "/jobs/testjob/files/evidence/c1/openfoam/mesh_evidence/manifest.json",
                  mime_type: "application/json",
                  sha256: "f".repeat(64),
                  byte_size: 128,
                  metadata: { topology: "shared-cgrid" },
                },
              ],
            },
            {
              case_slug: "c2",
              aoa_deg: uransAoa,
              cl: 1.2,
              cd: 0.18,
              cm: -0.04,
              cl_cd: 6.7,
              cl_std: 0.08,
              cd_std: 0.02,
              unsteady: true,
              converged: true,
              first_order_fallback: false,
              images: {
                velocity_magnitude:
                  "/jobs/testjob/files/cases/c2/images/velocity_magnitude.png",
              },
              evidence_artifacts: [
                manifestArtifact("c2"),
                // Frame-track contract: per-frame PNG shipped as an evidence
                // file with the pinned 'frame_image' kind (migration 0032).
                {
                  kind: "frame_image",
                  path: "/jobs/testjob/files/cases/c2/frames/vorticity/f0000.png",
                  url: "/jobs/testjob/files/cases/c2/frames/vorticity/f0000.png",
                  mime_type: "image/png",
                  sha256: "sha-c2-frame-0",
                  byte_size: 4096,
                  field: "vorticity",
                  role: "instantaneous",
                  metadata: { frameIndex: 0 },
                },
              ],
              // Engine non-fatal quality warnings (0030): ingest must persist
              // them verbatim on the results row AND the attempt evidence row.
              quality_warnings: [
                "URANS window shorter than 3 shedding periods",
              ],
              // Frame-track contract payload (0032): must land VERBATIM on
              // results.frame_track.
              frame_track: {
                period_s: 0.238,
                periods_retained: 6,
                stationary: true,
                drift_frac: 0.011,
                window: { t_start: 0.05, t_end: 0.3 },
                stats: {
                  cl: { mean: 1.2, std: 0.08, min: 1.05, max: 1.34 },
                  cd: { mean: 0.18, std: 0.02, min: 0.15, max: 0.21 },
                  cm: { mean: -0.04, std: 0.005, min: -0.05, max: -0.03 },
                },
                fields: ["vorticity", "velocity_magnitude"],
                frames: [{ i: 0, t: 0.25, cl: 1.21, cd: 0.18, cm: -0.04 }],
                image_pattern: "frames/{field}/f{i04}.png",
              },
              strouhal: 0.21,
              mean_images: {
                velocity_magnitude:
                  "/jobs/testjob/files/cases/c2/images/velocity_magnitude_mean.png",
              },
              video: {
                velocity_magnitude:
                  "/jobs/testjob/files/cases/c2/images/velocity_magnitude.mp4",
              },
              force_history: {
                t: [0, 0.1, 0.2, 0.3],
                cl: [1.1, 1.3, 1.2, 1.25],
                cd: [0.17, 0.19, 0.18, 0.18],
                cm: [-0.04, -0.04, -0.04, -0.04],
                shedding_freq_hz: 4.2,
                samples: 360,
              },
            },
          ],
          attempts: [
            {
              aoa_deg: uransAoa,
              cl: 5,
              cd: -0.01,
              cm: 0,
              cl_cd: -500,
              unsteady: false,
              converged: false,
              first_order_fallback: false,
              images: {},
              error: "RANS rejected before URANS replacement",
            },
          ],
        },
      ],
    };

    const r1 = await ingestResult({
      db,
      engine: mediaEngine,
      engineJobId: "testjob",
      simJobId: job.id,
      airfoilId: a.id,
      speedMap: [
        { speed, bcId: bc.id, presetRevisionId: batch.presetRevisionId },
      ],
      result: withExactManifestEvidence(result),
    });
    expect(r1.points).toBe(2);
    // Completed-job ingestion preserves engine-shipped media but never blocks
    // scheduler capacity on full default-media rendering. The bounded repair
    // queue owns scaled rendering after the job is terminal.
    expect(r1.media).toBe(5);
    expect(extentCalls).toBe(0);
    expect(defaultRenderCalls).toBe(0);

    const rows = await db
      .select()
      .from(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, batch.presetRevisionId),
          inArray(results.aoaDeg, [steadyAoa, uransAoa]),
        ),
      );
    rows.forEach((r) => cleanupResultIds.add(r.id));
    expect(rows.length).toBe(2);
    expect(
      rows.every((r) => r.source === "solved" && r.status === "done"),
    ).toBe(true);
    expect(rows.find((r) => r.aoaDeg === uransAoa)?.regime).toBe("urans");
    expect(rows.find((r) => r.aoaDeg === uransAoa)?.stalled).toBe(true);
    expect(rows.find((r) => r.aoaDeg === steadyAoa)?.regime).toBe("rans");
    const attempts = await db
      .select()
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.simJobId, job.id),
          inArray(resultAttempts.aoaDeg, [steadyAoa, uransAoa]),
        ),
      );
    expect(attempts.length).toBe(3);
    expect(attempts.filter((a) => a.validForPolar).length).toBe(2);
    expect(
      attempts.some((a) => a.regime === "rans" && a.validForPolar === false),
    ).toBe(true);
    // Quality warnings (0030) persisted verbatim on both evidence layers; the
    // steady point shipped none → honest NULL, not [].
    expect(rows.find((r) => r.aoaDeg === uransAoa)?.qualityWarnings).toEqual([
      "URANS window shorter than 3 shedding periods",
    ]);
    expect(
      rows.find((r) => r.aoaDeg === steadyAoa)?.qualityWarnings,
    ).toBeNull();
    const uransAttempt = attempts.find(
      (a) => a.regime === "urans" && a.aoaDeg === uransAoa,
    );
    expect(uransAttempt?.qualityWarnings).toEqual([
      "URANS window shorter than 3 shedding periods",
    ]);

    const r0 = rows.find((r) => r.aoaDeg === steadyAoa)!;
    const media = await db
      .select()
      .from(resultMedia)
      .where(eq(resultMedia.resultId, r0.id));
    expect(media.length).toBe(2);
    expect(media.every((mm) => mm.storageKey.startsWith("jobs/testjob/"))).toBe(
      true,
    );

    // URANS point: Strouhal + animation video + time-averaged image + force history
    const r16 = rows.find((r) => r.aoaDeg === uransAoa)!;
    expect(r16.strouhal).toBeCloseTo(0.21, 5);
    // Frame-track contract (0032): the engine payload lands VERBATIM on the
    // results row; the steady point (no shedding → no frame_track) stays NULL.
    expect(r16.frameTrack).toMatchObject({
      periods_retained: 6,
      stationary: true,
      image_pattern: "frames/{field}/f{i04}.png",
    });
    expect((r16.frameTrack as { frames: unknown[] }).frames).toHaveLength(1);
    expect(rows.find((r) => r.aoaDeg === steadyAoa)?.frameTrack).toBeNull();
    // The frame PNG registered through the existing evidence sweep with the
    // pinned 'frame_image' kind + field + frameIndex metadata.
    const frameEvidence = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultId, r16.id),
          eq(solverEvidenceArtifacts.kind, "frame_image"),
        ),
      );
    expect(frameEvidence).toHaveLength(1);
    expect(frameEvidence[0].field).toBe("vorticity");
    expect(frameEvidence[0].storageKey).toBe(
      "jobs/testjob/cases/c2/frames/vorticity/f0000.png",
    );
    expect(frameEvidence[0].metadata).toMatchObject({ frameIndex: 0 });
    const meshEvidence = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultId, r0.id),
          eq(solverEvidenceArtifacts.kind, "mesh"),
        ),
      );
    expect(meshEvidence).toHaveLength(1);
    expect(meshEvidence[0].storageKey).toBe(
      "jobs/testjob/evidence/c1/openfoam/mesh_evidence/manifest.json",
    );
    expect(meshEvidence[0].metadata).toMatchObject({
      topology: "shared-cgrid",
      engineArtifactKind: "mesh_evidence",
    });
    const m16 = await db
      .select()
      .from(resultMedia)
      .where(eq(resultMedia.resultId, r16.id));
    expect(
      m16.some((mm) => mm.kind === "video" && mm.role === "instantaneous"),
    ).toBe(true);
    expect(m16.some((mm) => mm.kind === "image" && mm.role === "mean")).toBe(
      true,
    );
    expect(m16.every((mm) => mm.field === "velocity_magnitude")).toBe(true);
    const fh = await db
      .select()
      .from(forceHistory)
      .where(eq(forceHistory.resultId, r16.id));
    expect(fh.length).toBe(1);
    expect(fh[0].cl.length).toBe(4);
    expect(fh[0].strouhal).toBeCloseTo(0.21, 5);
    const extents = await db
      .select()
      .from(resultFieldExtents)
      .where(
        and(
          eq(resultFieldExtents.airfoilId, a.id),
          eq(
            resultFieldExtents.simulationPresetRevisionId,
            batch.presetRevisionId,
          ),
        ),
      );
    // Ingest never performs VTK extent scans. Those CPU/I/O-heavy derived
    // media operations are owned by the independent durable repair service,
    // so partial solver progress cannot stall scheduling.
    expect(extents).toHaveLength(0);
    // idempotent: re-ingest produces no duplicates
    await ingestResult({
      db,
      engine: mediaEngine,
      engineJobId: "testjob",
      simJobId: job.id,
      airfoilId: a.id,
      speedMap: [
        { speed, bcId: bc.id, presetRevisionId: batch.presetRevisionId },
      ],
      result: withExactManifestEvidence(result),
    });
    const rowsAfter = await db
      .select()
      .from(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, batch.presetRevisionId),
          inArray(results.aoaDeg, [steadyAoa, uransAoa]),
        ),
      );
    expect(rowsAfter.length).toBe(2);
    const mediaAfter = await db
      .select()
      .from(resultMedia)
      .where(eq(resultMedia.resultId, r0.id));
    expect(mediaAfter.length).toBe(2);
    const attemptsAfter = await db
      .select()
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.simJobId, job.id),
          inArray(resultAttempts.aoaDeg, [steadyAoa, uransAoa]),
        ),
      );
    expect(attemptsAfter.length).toBe(3);
    const steadyAttempt = attemptsAfter.find(
      (attempt) => attempt.aoaDeg === steadyAoa && attempt.regime === "rans",
    );
    expect(steadyAttempt).toBeDefined();
    expect(
      Object.hasOwn(
        steadyAttempt!.evidencePayload as Record<string, unknown>,
        "mesh_recovery_version",
      ),
    ).toBe(false);

    // MUST-CATCH (production rolling deploy 2026-07-16): legacy attempts
    // predate the optional mesh-recovery acknowledgement and therefore omit
    // its JSON key. A short-lived writer compared that payload with a newly
    // constructed `mesh_recovery_version: null` payload and blocked every
    // otherwise exact partial replay as changed immutable evidence. Explicit
    // null and absence mean the same "not acknowledged" state.
    await db
      .update(resultAttempts)
      .set({
        evidencePayload: {
          ...(steadyAttempt!.evidencePayload as Record<string, unknown>),
          mesh_recovery_version: null,
        },
      })
      .where(eq(resultAttempts.id, steadyAttempt!.id));
    await ingestResult({
      db,
      engine: mediaEngine,
      engineJobId: "testjob",
      simJobId: job.id,
      airfoilId: a.id,
      speedMap: [
        { speed, bcId: bc.id, presetRevisionId: batch.presetRevisionId },
      ],
      result: withExactManifestEvidence(result),
    });

    // A real acknowledged version remains immutable evidence: equal numeric
    // versions replay, while a different numeric acknowledgement must fail.
    for (const attempt of attemptsAfter) {
      await db
        .update(resultAttempts)
        .set({
          evidencePayload: {
            ...(attempt.evidencePayload as Record<string, unknown>),
            mesh_recovery_version: 1,
          },
        })
        .where(eq(resultAttempts.id, attempt.id));
    }
    const recoveredV1 = JSON.parse(JSON.stringify(result)) as JobResult;
    recoveredV1.mesh_recovery_version = 1;
    await ingestResult({
      db,
      engine: mediaEngine,
      engineJobId: "testjob",
      simJobId: job.id,
      airfoilId: a.id,
      speedMap: [
        { speed, bcId: bc.id, presetRevisionId: batch.presetRevisionId },
      ],
      result: withExactManifestEvidence(recoveredV1),
    });
    const changedRecoveryVersion = JSON.parse(
      JSON.stringify(recoveredV1),
    ) as JobResult;
    changedRecoveryVersion.mesh_recovery_version = 2;
    await expect(
      ingestResult({
        db,
        engine: mediaEngine,
        engineJobId: "testjob",
        simJobId: job.id,
        airfoilId: a.id,
        speedMap: [
          { speed, bcId: bc.id, presetRevisionId: batch.presetRevisionId },
        ],
        result: withExactManifestEvidence(changedRecoveryVersion),
      }),
    ).rejects.toThrow("result attempt replay changed immutable evidence");
    expect(extentCalls).toBe(0);
    expect(defaultRenderCalls).toBe(0);
  }, 60000);

  // MUST-CATCH (prod "missing-urans-video" regression): engine-shipped media
  // must land in result_media at ingest even when the scaled-render chain
  // (extents + render) fails — previously those failures were swallowed and
  // NO video row ever registered, so every URANS point stayed rejected.
  it("registers engine-shipped URANS media even when the scaled-render chain fails", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 83.001;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          eq(results.aoaDeg, aoa),
        ),
    );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 2,
        status: "running",
        engineJobId: "shipped-media-job",
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);

    const failingEngine = {
      baseUrl: "http://engine.test",
      computeFieldExtents: async () => {
        throw new Error("render backend down");
      },
      renderDefaultMedia: async () => {
        throw new Error("render backend down");
      },
    } as unknown as EngineClient;

    const result: JobResult = {
      job_id: "shipped-media-job",
      state: "completed",
      polars: [
        {
          speed: bc.speedMps,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: 0.1,
          points: [
            {
              case_slug: "cs1",
              aoa_deg: aoa,
              cl: 1.05,
              cd: 0.19,
              cm: -0.05,
              cl_cd: 5.5,
              cl_std: 0.07,
              cd_std: 0.02,
              unsteady: true,
              converged: true,
              first_order_fallback: false,
              strouhal: 0.19,
              // Post-contract engines ship frame_track on every shedding
              // point; without it ingest persists a fail-closed sentinel and
              // the classifier rejects (see frame-track-contract-pin tests).
              frame_track: {
                period_s: 0.27,
                periods_retained: 6.2,
                stationary: true,
                drift_frac: 0.01,
                window: { t_start: 1.0, t_end: 2.62 },
                stats: {
                  cl: { mean: 1.05, std: 0.07, min: 0.9, max: 1.2 },
                  cd: { mean: 0.19, std: 0.02, min: 0.16, max: 0.22 },
                  cm: { mean: -0.05, std: 0.004, min: -0.06, max: -0.04 },
                },
                fields: [],
                frames: [],
                image_pattern: "frames/{field}/f{i04}.png",
              },
              evidence_artifacts: [
                {
                  kind: "manifest",
                  path: "/jobs/shipped-media-job/files/evidence/cs1/evidence_manifest.json",
                  url: "/jobs/shipped-media-job/files/evidence/cs1/evidence_manifest.json",
                  mime_type: "application/json",
                  sha256: "sha-shipped-cs1",
                  byte_size: 128,
                  metadata: { evidenceBase: "/tmp/evidence/cs1" },
                },
              ],
              images: {
                velocity_magnitude:
                  "/jobs/shipped-media-job/files/cases/cs1/images/velocity_magnitude.png",
              },
              mean_images: {
                velocity_magnitude:
                  "/jobs/shipped-media-job/files/cases/cs1/images/velocity_magnitude_mean.png",
              },
              video: {
                velocity_magnitude:
                  "/jobs/shipped-media-job/files/cases/cs1/images/velocity_magnitude.mp4",
              },
              force_history: {
                t: [0, 0.1, 0.2, 0.3],
                cl: [1.0, 1.1, 1.05, 1.06],
                cd: [0.18, 0.2, 0.19, 0.19],
                cm: [-0.05, -0.05, -0.05, -0.05],
                shedding_freq_hz: 3.7,
                samples: 240,
              },
            },
          ],
        },
      ],
    };

    const r = await ingestResult({
      db,
      engine: failingEngine,
      engineJobId: "shipped-media-job",
      simJobId: job.id,
      airfoilId: a.id,
      speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId }],
      result: withExactManifestEvidence(result),
    });
    expect(r.points).toBe(1);
    expect(r.media).toBe(3); // shipped image + mean image + video, no scaled renders

    const [row] = await db
      .select()
      .from(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          eq(results.aoaDeg, aoa),
        ),
      );
    cleanupResultIds.add(row.id);
    const media = await db
      .select()
      .from(resultMedia)
      .where(eq(resultMedia.resultId, row.id));
    expect(media.length).toBe(3);
    const video = media.find(
      (m) => m.kind === "video" && m.role === "instantaneous",
    );
    expect(video?.storageKey).toBe(
      "jobs/shipped-media-job/cases/cs1/images/velocity_magnitude.mp4",
    );
    expect(video?.mimeType).toBe("video/mp4");
    expect(media.some((m) => m.kind === "image" && m.role === "mean")).toBe(
      true,
    );

    // End-to-end D3 unlock: the ingest-shaped URANS row (stalled=true because
    // unsteady, converged, with force history + video) classifies ACCEPTED.
    await refreshPolarCacheForRevision(db, a.id, presetRevisionId);
    const [rc] = await db
      .select()
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, row.id));
    expect(rc?.state).toBe("accepted");

    // Idempotent re-ingest: still exactly 3 media rows.
    await ingestResult({
      db,
      engine: failingEngine,
      engineJobId: "shipped-media-job",
      simJobId: job.id,
      airfoilId: a.id,
      speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId }],
      result: withExactManifestEvidence(result),
    });
    const mediaAfter = await db
      .select()
      .from(resultMedia)
      .where(eq(resultMedia.resultId, row.id));
    expect(mediaAfter.length).toBe(3);

    // The same engine attempt identity is immutable. A changed replay is not
    // a correction generation and must fail before it can remove media from
    // the accepted attempt (new solves use a new sim/engine job identity;
    // their replacement precedence is covered by replace-guard.test.ts).
    const noVideoResult: JobResult = JSON.parse(JSON.stringify(result));
    noVideoResult.polars[0].points[0].video = {};
    await expect(
      ingestResult({
        db,
        engine: failingEngine,
        engineJobId: "shipped-media-job",
        simJobId: job.id,
        airfoilId: a.id,
        speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId }],
        result: noVideoResult,
      }),
    ).rejects.toThrow("result attempt replay changed immutable evidence");
    const mediaGuarded = await db
      .select()
      .from(resultMedia)
      .where(eq(resultMedia.resultId, row.id));
    expect(mediaGuarded.some((m) => m.kind === "video")).toBe(true);
    expect(mediaGuarded.length).toBe(3);
  }, 60000);

  // MUST-CATCH (live proof 2026-07-05): "[sweeper] scaled-media render FAILED
  // (field vorticity, scale v1): fetch failed" — ONE transient engine fetch
  // failure during the shared-scale re-render marked the scale row failed
  // PERMANENTLY; no code path ever re-attempted it. The reconcile retry pass
  // must (a) record each failed attempt on the row, (b) recover the SAME
  // version row once the engine responds, and (c) stop retrying at
  // MAX_SCALE_RENDER_ATTEMPTS and skip rows a newer version obsoleted.
  it("retries a failed scaled-media render (bounded) and activates the scale on recovery", async () => {
    const { bc, presetRevisionId } = await firstAirfoilBc();
    // Color scales are polar-wide (airfoil + revision + field + profile), so
    // this retry test owns a separate airfoil instead of depending on scales
    // left by the earlier ingest test in this file.
    const a = await createTestAirfoil("scale-retry-airfoil");
    const aoa = 87.001;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          eq(results.aoaDeg, aoa),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "running",
        engineJobId: "scale-retry-job",
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);

    const scaleScope = and(
      eq(fieldColorScales.airfoilId, a.id),
      eq(fieldColorScales.simulationPresetRevisionId, presetRevisionId),
      eq(fieldColorScales.field, "velocity_magnitude"),
    );
    await db.insert(fieldColorScales).values({
      airfoilId: a.id,
      simulationPresetRevisionId: presetRevisionId,
      field: "velocity_magnitude",
      renderProfileKey: "default:v1:zoom2",
      scalePolicy: "sequential_zero",
      vmin: 0,
      vmax: 40,
      evidenceSignature: `${testRunSlug}-scale-retry-baseline`,
      status: "active",
      version: 1,
      active: true,
    });

    // Extents compute fine; every render fetch fails — the exact transient
    // failure shape from the live campaign.
    let renderCalls = 0;
    const renderDownEngine = {
      baseUrl: "http://engine.test",
      computeFieldExtents: async () => ({
        fields: { velocity_magnitude: { min: 0, max: 90, finite_count: 100 } },
        window_start: null,
        window_end: null,
      }),
      renderDefaultMedia: async () => {
        renderCalls++;
        throw new Error("fetch failed");
      },
    } as unknown as EngineClient;

    const result: JobResult = {
      job_id: "scale-retry-job",
      state: "completed",
      polars: [
        {
          speed: bc.speedMps,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: 0.1,
          points: [
            {
              case_slug: "srt1",
              aoa_deg: aoa,
              cl: 0.5,
              cd: 0.011,
              cm: -0.02,
              cl_cd: 45,
              unsteady: true,
              converged: true,
              first_order_fallback: false,
              fidelity: "urans_precalc",
              frame_track: {
                period_s: 0.25,
                periods_retained: 3.5,
                stationary: true,
                drift_frac: 0.01,
                window: { t_start: 1, t_end: 1.875 },
                stats: {
                  cl: { mean: 0.5, std: 0.03, min: 0.45, max: 0.55 },
                  cd: { mean: 0.011, std: 0.001, min: 0.01, max: 0.012 },
                  cm: { mean: -0.02, std: 0.002, min: -0.023, max: -0.017 },
                },
                fields: [],
                frames: [],
                image_pattern: "frames/{field}/f{i04}.png",
              },
              force_history: {
                t: [0, 0.25, 0.5, 0.75],
                cl: [0.48, 0.52, 0.49, 0.51],
                cd: [0.01, 0.012, 0.011, 0.011],
                cm: [-0.02, -0.019, -0.021, -0.02],
                shedding_freq_hz: 4,
                samples: 240,
              },
              images: {
                velocity_magnitude:
                  "/jobs/scale-retry-job/files/cases/srt1/images/velocity_magnitude.png",
              },
              mean_images: {
                velocity_magnitude:
                  "/jobs/scale-retry-job/files/cases/srt1/images/velocity_magnitude_mean.png",
              },
              video: {
                velocity_magnitude:
                  "/jobs/scale-retry-job/files/cases/srt1/images/velocity_magnitude.mp4",
              },
              evidence_artifacts: [
                {
                  kind: "manifest",
                  path: "/jobs/scale-retry-job/files/evidence/srt1/evidence_manifest.json",
                  url: "/jobs/scale-retry-job/files/evidence/srt1/evidence_manifest.json",
                  mime_type: "application/json",
                  sha256: "sha-srt1",
                  byte_size: 128,
                  metadata: { evidenceBase: "/tmp/evidence/srt1" },
                },
              ],
            },
          ],
        },
      ],
    };
    await ingestResult({
      db,
      engine: renderDownEngine,
      engineJobId: "scale-retry-job",
      simJobId: job.id,
      airfoilId: a.id,
      speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId }],
      uransFidelity: "precalc",
      result: withExactManifestEvidence(result),
    });
    const [row] = await db
      .select()
      .from(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          eq(results.aoaDeg, aoa),
        ),
      );
    cleanupResultIds.add(row.id);
    const [sourceAttempt] = await db
      .select({ id: resultAttempts.id })
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.resultId, row.id),
          eq(resultAttempts.simJobId, job.id),
        ),
      );

    // The engine job must settle before the durable media worker starts its
    // expensive extent/render pass. Exercise that production path explicitly
    // instead of expecting ingest to render partial evidence inline.
    await db
      .update(simJobs)
      .set({ status: "done", engineState: "completed", finishedAt: new Date() })
      .where(eq(simJobs.id, job.id));
    expect(
      await discoverMissingResultMediaRepairs(db, { resultId: row.id }),
    ).toBe(1);
    await expect(
      repairDefaultMediaForStoredResult({
        db,
        engine: renderDownEngine,
        resultId: row.id,
        resultAttemptId: sourceAttempt.id,
      }),
    ).rejects.toThrow("fetch failed");

    // Complete engine-shipped URANS media makes the preliminary point
    // publishable immediately. A transient failure in the optional shared
    // color-scale render remains a retryable presentation-artifact problem;
    // it must not demote accepted CFD evidence or create human review work.
    await refreshPolarCacheForRevision(db, a.id, presetRevisionId);
    expect(row.currentResultAttemptId).toBe(sourceAttempt.id);
    const [beforeScaleRepair] = await db
      .select()
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, row.id));
    expect(beforeScaleRepair).toMatchObject({ state: "accepted", reasons: [] });

    // (a) the failed render lands on the scale row with the attempt recorded.
    const failedScales = await db
      .select()
      .from(fieldColorScales)
      .where(and(scaleScope, eq(fieldColorScales.status, "failed")));
    expect(failedScales.length).toBe(1);
    const failedScale = failedScales[0];
    expect(failedScale.renderAttempts).toBe(1);
    expect(failedScale.failureReason).toContain("fetch failed");
    expect(failedScale.active).toBe(false);

    // Engine still down on the next pass: the attempt advances, row stays failed.
    await retryFailedScaleRenders(db, renderDownEngine, {
      scaleIds: [failedScale.id],
    });
    const [stillFailed] = await db
      .select()
      .from(fieldColorScales)
      .where(eq(fieldColorScales.id, failedScale.id));
    expect(stillFailed.status).toBe("failed");
    expect(stillFailed.renderAttempts).toBe(2);

    // (b) engine recovers: the SAME version row re-renders, activates, and the
    // media registers stamped with this scale.
    const healthyEngine = {
      baseUrl: "http://engine.test",
      computeFieldExtents: (
        renderDownEngine as unknown as { computeFieldExtents: unknown }
      ).computeFieldExtents,
      renderDefaultMedia: async (
        jobId: string,
        request: {
          case_slug: string;
          fields?: string[];
          unsteady?: boolean;
          scale_version?: number;
          render_profile_key?: string;
        },
      ) => {
        const version = request.scale_version ?? 1;
        const profile = request.render_profile_key ?? "default:v1:zoom2";
        const base = `/jobs/${jobId}/files/evidence/scaled_media/${profile}/v${version}/${request.case_slug}`;
        const fields = request.fields ?? [];
        return {
          images: fields.map((field) =>
            renderedMediaArtifact({
              jobId,
              path: `${base}/${field}.png`,
              field,
              kind: "image",
              role: "instantaneous",
            }),
          ),
          mean_images: request.unsteady
            ? fields.map((field) =>
                renderedMediaArtifact({
                  jobId,
                  path: `${base}/${field}_mean.png`,
                  field,
                  kind: "image",
                  role: "mean",
                }),
              )
            : [],
          videos: request.unsteady
            ? fields.map((field) =>
                renderedMediaArtifact({
                  jobId,
                  path: `${base}/${field}.mp4`,
                  field,
                  kind: "video",
                  role: "instantaneous",
                }),
              )
            : [],
          window_start: null,
          window_end: null,
          scale_version: version,
          render_profile_key: profile,
        };
      },
    } as unknown as EngineClient;
    const recovered = await retryFailedScaleRenders(db, healthyEngine, {
      scaleIds: [failedScale.id],
    });
    expect(recovered.mediaCount).toBeGreaterThan(0);
    const [afterRecover] = await db
      .select()
      .from(fieldColorScales)
      .where(eq(fieldColorScales.id, failedScale.id));
    expect(afterRecover.status).toBe("active");
    expect(afterRecover.active).toBe(true);
    expect(afterRecover.failureReason).toBeNull();
    expect(afterRecover.version).toBe(failedScale.version); // no version churn on retry
    const activeRows = await db
      .select()
      .from(fieldColorScales)
      .where(and(scaleScope, eq(fieldColorScales.active, true)));
    expect(activeRows.length).toBe(1); // the old active scale was deactivated
    const media = await db
      .select()
      .from(resultMedia)
      .where(eq(resultMedia.resultId, row.id));
    expect(
      media.some(
        (m) =>
          m.colorScaleId === failedScale.id &&
          m.colorScaleVersion === failedScale.version,
      ),
    ).toBe(true);
    expect(
      media.some((m) => m.kind === "video" && m.role === "instantaneous"),
    ).toBe(true);
    const [afterRepair] = await db
      .select()
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, row.id));
    expect(afterRepair).toMatchObject({ state: "accepted", reasons: [] });
    const [publishedRepair] = await db
      .select({ currentResultAttemptId: results.currentResultAttemptId })
      .from(results)
      .where(eq(results.id, row.id));
    expect(publishedRepair.currentResultAttemptId).toBe(sourceAttempt.id);
    let verifyItems = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.precalcResultId, row.id));
    expect(verifyItems).toHaveLength(1);
    expect(verifyItems[0].state).toBe("pending");

    // Re-running the repair pass is idempotent: contract-4 owns exactly one
    // open verification item per physical cell.
    await retryFailedScaleRenders(db, healthyEngine, {
      scaleIds: [failedScale.id],
    });
    verifyItems = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.precalcResultId, row.id));
    expect(verifyItems).toHaveLength(1);

    // (c) bounded: a row at the attempt cap is never re-attempted…
    await db
      .update(fieldColorScales)
      .set({
        status: "failed",
        active: false,
        renderAttempts: 3,
        failureReason: "fetch failed",
      })
      .where(eq(fieldColorScales.id, failedScale.id));
    const callsAtCap = renderCalls;
    await retryFailedScaleRenders(db, renderDownEngine, {
      scaleIds: [failedScale.id],
    });
    expect(renderCalls).toBe(callsAtCap);
    const [exhausted] = await db
      .select()
      .from(fieldColorScales)
      .where(eq(fieldColorScales.id, failedScale.id));
    expect(exhausted.status).toBe("failed");
    expect(exhausted.renderAttempts).toBe(3);

    // …and a failed row obsoleted by a NEWER version is dead history, skipped
    // even with attempts remaining.
    await db
      .update(fieldColorScales)
      .set({ renderAttempts: 0 })
      .where(eq(fieldColorScales.id, failedScale.id));
    await db.insert(fieldColorScales).values({
      airfoilId: a.id,
      simulationPresetRevisionId: presetRevisionId,
      field: "velocity_magnitude",
      renderProfileKey: failedScale.renderProfileKey,
      scalePolicy: "sequential_zero",
      vmin: 0,
      vmax: 90,
      evidenceSignature: "sig-newer-version",
      status: "active",
      version: failedScale.version + 1,
      active: true,
    });
    await retryFailedScaleRenders(db, renderDownEngine, {
      scaleIds: [failedScale.id],
    });
    expect(renderCalls).toBe(callsAtCap); // still zero re-attempts
    const [obsolete] = await db
      .select()
      .from(fieldColorScales)
      .where(eq(fieldColorScales.id, failedScale.id));
    expect(obsolete.status).toBe("failed");

    // Remove this test-owned polar before later revision-wide heuristics run.
    await db.delete(results).where(eq(results.id, row.id));
    cleanupResultIds.delete(row.id);
    await db.delete(fieldColorScales).where(scaleScope);
  }, 60000);

  // MUST-CATCH (prod 2026-07-06 heartbeat-under-load regression): with 7 jobs
  // in flight, a multi-minute per-point ingest left sweeper_state.heartbeatAt
  // 204 s stale MID-TICK, so the Solver page's >90 s truth gate honestly
  // reported PROCESS NOT RUNNING on a healthy process. The invariant is one
  // heartbeat touch per ingested point (plus per scaled-render batch) — never
  // a single touch bracketing the whole ingest.
  it("touches the heartbeat per point during a slow multi-point ingest", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoas = [84.001, 85.001, 86.001];
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, aoas),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "running",
        engineJobId: "heartbeat-job",
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);

    // Slow fake engine, shaped like real saturation: every per-point extents
    // round-trip crawls (120 ms here, seconds-to-minutes in prod). It returns
    // no extents so the scaled-render chain (which has its own per-result
    // touch) stays out of this measurement.
    const slowEngine = {
      baseUrl: "http://engine.test",
      computeFieldExtents: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { fields: {}, window_start: null, window_end: null };
      },
    } as unknown as EngineClient;

    const result: JobResult = {
      job_id: "heartbeat-job",
      state: "completed",
      polars: [
        {
          speed: bc.speedMps,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: 0.1,
          points: aoas.map((aoa, i) => ({
            case_slug: `hb${i}`,
            aoa_deg: aoa,
            cl: 0.3 + i * 0.1,
            cd: 0.01,
            cm: -0.01,
            cl_cd: 30,
            unsteady: false,
            converged: true,
            first_order_fallback: false,
            images: {},
            evidence_artifacts: [
              {
                kind: "manifest",
                path: `/jobs/heartbeat-job/files/evidence/hb${i}/evidence_manifest.json`,
                url: `/jobs/heartbeat-job/files/evidence/hb${i}/evidence_manifest.json`,
                mime_type: "application/json",
                sha256: `sha-hb${i}`,
                byte_size: 128,
                metadata: { evidenceBase: `/tmp/evidence/hb${i}` },
              },
            ],
          })),
        },
      ],
    };

    // Age the heartbeat far past the web's 90 s stale gate, then observe REAL
    // sweeper_state updates through the injected spy (count + DB truth).
    const before = new Date(Date.now() - 10 * 60_000);
    await db
      .insert(sweeperState)
      .values({ id: 1, heartbeatAt: before })
      .onConflictDoUpdate({
        target: sweeperState.id,
        set: { heartbeatAt: before },
      });
    const observed: number[] = [];
    const r = await ingestResult({
      db,
      engine: slowEngine,
      engineJobId: "heartbeat-job",
      simJobId: job.id,
      airfoilId: a.id,
      speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId }],
      result: withExactManifestEvidence(result),
      heartbeat: async () => {
        await touchHeartbeat(db);
        const [row] = await db
          .select({ heartbeatAt: sweeperState.heartbeatAt })
          .from(sweeperState)
          .where(eq(sweeperState.id, 1))
          .limit(1);
        if (row?.heartbeatAt) observed.push(row.heartbeatAt.getTime());
      },
    });
    expect(r.points).toBe(3);
    const rows = await db
      .select({ id: results.id })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, aoas),
        ),
      );
    rows.forEach((row) => cleanupResultIds.add(row.id));
    // At least one touch per point — the coverage that keeps a long ingest
    // from starving the heartbeat.
    expect(observed.length).toBeGreaterThanOrEqual(3);
    // heartbeatAt genuinely ADVANCED during the ingest: >=3 distinct values
    // (points are separated by the slow engine call), all newer than the aged
    // pre-ingest timestamp.
    expect(new Set(observed).size).toBeGreaterThanOrEqual(3);
    expect(Math.min(...observed)).toBeGreaterThan(before.getTime());
  }, 60000);

  // MUST-CATCH (ladder R2 whole-polar kill): this exact input — an unreliable
  // sweep with only 2 of 6 points converged — WHOLE-POLAR'd under the pre-R2
  // heuristics (retryMode whole-polar-urans, all 6 angles re-queued, accepted
  // evidence re-solved). The ladder retry must stay scoped to the 4 rejected
  // angles at PRECALC fidelity and must never touch the accepted rows.
  it("retries only the rejected angles of an unreliable RANS sweep (no whole-polar escalation)", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoas = [130.01, 131.01, 132.01, 133.01, 134.01, 135.01];
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, aoas),
        ),
      );
    const [parent] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "submitted",
        engineJobId: "unreliable-rans-parent",
        totalCases: aoas.length,
        completedCases: aoas.length,
        requestPayload: {
          speedMap: [
            {
              speed: bc.speedMps,
              bcId: bc.id,
              presetRevisionId,
              mach: bc.mach,
            },
          ],
          aoas,
          ransRetryScope: {
            origin: "continuous-polar",
            requestedAoas: aoas,
          },
        },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(parent.id);
    for (const aoa of aoas) {
      const [row] = await db
        .insert(results)
        .values({
          airfoilId: a.id,
          bcId: bc.id,
          simulationPresetRevisionId: presetRevisionId,
          aoaDeg: aoa,
          status: "queued",
          source: "queued",
          simJobId: parent.id,
        })
        .returning({ id: results.id });
      cleanupResultIds.add(row.id);
    }

    let submittedRequest: unknown = null;
    const unreliableResult: JobResult = {
      job_id: "unreliable-rans-parent",
      state: "completed",
      polars: [
        {
          speed: bc.speedMps,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: bc.mach,
          points: aoas.map((aoa, i) => ({
            aoa_deg: aoa,
            cl: 0.2 + i * 0.1,
            cd: 0.02 + i * 0.01,
            cm: -0.01,
            cl_cd: 10,
            unsteady: false,
            converged: i === 1 || i === 4,
            first_order_fallback: false,
            images: {},
          })),
        },
      ],
    };
    const retryEngine = {
      getJob: async (): Promise<JobStatus> => ({
        job_id: "unreliable-rans-parent",
        state: "completed",
        total_cases: aoas.length,
        completed_cases: aoas.length,
      }),
      getResult: async () => withExactManifestEvidence(unreliableResult),
      submitPolar: async (request: unknown): Promise<JobStatus> => {
        submittedRequest = request;
        // Echo the REQUEST's case count (the engine's behavior) — a hardcoded
        // count would mask a wrongly-scoped retry via the post-submit stamp.
        const angles =
          (request as { aoa?: { angles?: number[] } }).aoa?.angles ?? [];
        return {
          job_id: "targeted-urans-child",
          state: "pending",
          total_cases: angles.length,
          completed_cases: 0,
        };
      },
      fileUrl: (jobId: string, relPath: string) =>
        `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, retryEngine, {
      jobIds: [parent.id],
      skipFailedRecovery: true,
    });

    const [child] = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)))
      .limit(1);
    expect(child).toBeTruthy();
    cleanupJobIds.add(child.id);
    // Only the 4 rejected angles (i=1 and i=4 converged/accepted) retry.
    const rejectedAoas = [130.01, 132.01, 133.01, 135.01];
    expect(child.totalCases).toBe(rejectedAoas.length);
    expect(child.jobKind).toBe("targeted");
    expect((child.requestPayload as { retryMode?: string })?.retryMode).toBe(
      "invalid-rans-points",
    );
    // Fidelity ladder contract 1: automatic wave-2 retries run at PRECALC.
    expect(
      (child.requestPayload as { uransFidelity?: string })?.uransFidelity,
    ).toBe("precalc");
    expect(
      (
        submittedRequest as {
          solver?: { force_transient?: boolean; urans_fidelity?: string };
        }
      )?.solver?.force_transient,
    ).toBe(true);
    expect(
      (submittedRequest as { solver?: { urans_fidelity?: string } })?.solver
        ?.urans_fidelity,
    ).toBe("precalc");
    expect(
      (submittedRequest as { aoa?: { angles?: number[] } })?.aoa?.angles,
    ).toEqual(rejectedAoas);
    await expectBackgroundPrecalcSubmission(child, rejectedAoas);

    const retained = await db
      .select({
        aoaDeg: results.aoaDeg,
        status: results.status,
        simJobId: results.simJobId,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, aoas),
        ),
      );
    // Accepted RANS generations remain selected. Rejected generations stay
    // as immutable attempts and their canonical scheduling shells fail
    // closed; only the exact obligations run under the preliminary child.
    const rejectedSet = new Set(rejectedAoas);
    for (const row of retained) {
      expect(row.status).toBe(rejectedSet.has(row.aoaDeg) ? "failed" : "done");
      expect(row.simJobId).toBe(parent.id);
    }
    const attempts = await db
      .select()
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.simJobId, parent.id),
          inArray(resultAttempts.aoaDeg, aoas),
        ),
      );
    expect(attempts.length).toBe(aoas.length);
    expect(attempts.filter((a) => a.validForPolar).length).toBe(2);
    // 120 s: the FIRST reconcile() in the process pays the one-shot lane
    // safety sweep + campaign reconciler against the shared dev DB (~57 s at
    // current data volume, measured 2026-07-06) — over the old 60 s cap when
    // vitest runs the other DB-heavy test files in parallel.
  }, 120000);

  it("submits one URANS retry for rejected RANS attempts stored outside canonical results", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const validAoas = [0.011, 1.011, 2.011, 3.011, 4.011, 5.011];
    const rejectedAoas = [18.011, 19.011];
    const aoas = [...validAoas, ...rejectedAoas];
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, aoas),
        ),
      );
    const [parent] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "submitted",
        engineJobId: "attempt-only-rans-parent",
        totalCases: aoas.length,
        completedCases: aoas.length,
        requestPayload: {
          speedMap: [
            {
              speed: bc.speedMps,
              bcId: bc.id,
              presetRevisionId,
              mach: bc.mach,
            },
          ],
          aoas,
          ransRetryScope: {
            origin: "continuous-polar",
            requestedAoas: aoas,
          },
        },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(parent.id);
    for (const aoa of aoas) {
      const [row] = await db
        .insert(results)
        .values({
          airfoilId: a.id,
          bcId: bc.id,
          simulationPresetRevisionId: presetRevisionId,
          aoaDeg: aoa,
          status: "queued",
          source: "queued",
          simJobId: parent.id,
        })
        .returning({ id: results.id });
      cleanupResultIds.add(row.id);
    }

    let submittedRequest: unknown = null;
    const completedResult: JobResult = {
      job_id: "attempt-only-rans-parent",
      state: "completed",
      polars: [
        {
          speed: bc.speedMps,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: bc.mach,
          points: validAoas.map((aoa, i) => ({
            aoa_deg: aoa,
            cl: 0.25 + i * 0.08,
            cd: 0.02 + i * 0.001,
            cm: -0.01,
            cl_cd: 12.5,
            unsteady: false,
            converged: true,
            first_order_fallback: false,
            images: {},
          })),
          attempts: rejectedAoas.map((aoa, i) => ({
            aoa_deg: aoa,
            cl: 0.8 - i * 0.02,
            cd: 0.22 + i * 0.02,
            cm: -0.06,
            cl_cd: 3.6,
            unsteady: false,
            converged: false,
            first_order_fallback: false,
            images: {},
          })),
        },
      ],
    };
    const retryEngine = {
      getJob: async (): Promise<JobStatus> => ({
        job_id: "attempt-only-rans-parent",
        state: "completed",
        total_cases: aoas.length,
        completed_cases: aoas.length,
      }),
      getResult: async () => withExactManifestEvidence(completedResult),
      submitPolar: async (request: unknown): Promise<JobStatus> => {
        submittedRequest = request;
        return {
          job_id: "attempt-only-urans-child",
          state: "pending",
          total_cases: rejectedAoas.length,
          completed_cases: 0,
        };
      },
      fileUrl: (jobId: string, relPath: string) =>
        `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, retryEngine, {
      jobIds: [parent.id],
      skipFailedRecovery: true,
    });

    const [child] = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)))
      .limit(1);
    expect(child).toBeTruthy();
    cleanupJobIds.add(child.id);
    expect(child.totalCases).toBe(rejectedAoas.length);
    expect((child.requestPayload as { retryMode?: string })?.retryMode).toBe(
      "invalid-rans-points",
    );
    expect(
      (
        submittedRequest as {
          solver?: { force_transient?: boolean };
          aoa?: { angles?: number[] };
        }
      )?.solver?.force_transient,
    ).toBe(true);
    expect(
      (submittedRequest as { aoa?: { angles?: number[] } })?.aoa?.angles,
    ).toEqual(rejectedAoas);
    await expectBackgroundPrecalcSubmission(child, rejectedAoas);

    const retained = await db
      .select({
        aoaDeg: results.aoaDeg,
        status: results.status,
        simJobId: results.simJobId,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, rejectedAoas),
        ),
      );
    expect(
      retained.every(
        (row) => row.status === "failed" && row.simJobId === parent.id,
      ),
    ).toBe(true);
    const attempts = await db
      .select({
        id: resultAttempts.id,
        validForPolar: resultAttempts.validForPolar,
      })
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.simJobId, parent.id),
          inArray(resultAttempts.aoaDeg, aoas),
        ),
      );
    attempts.forEach((attempt) => cleanupAttemptIds.add(attempt.id));
    expect(attempts.length).toBe(aoas.length);
    expect(attempts.filter((attempt) => !attempt.validForPolar).length).toBe(
      rejectedAoas.length,
    );
  }, 60000);

  it("marks suspicious post-stall RANS rows needs_urans and keeps them visible until URANS arrives", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const ransAoas = Array.from({ length: 19 }, (_, i) => i + 0.021);
    const rejectedAoas = [19.021, 20.021];
    const allAoas = [...ransAoas, ...rejectedAoas];
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, allAoas),
        ),
      );
    const [parent] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "submitted",
        engineJobId: "ag24-like-rans-parent",
        totalCases: allAoas.length,
        completedCases: allAoas.length,
        requestPayload: {
          speedMap: [
            {
              speed: bc.speedMps,
              bcId: bc.id,
              presetRevisionId,
              mach: bc.mach,
            },
          ],
          aoas: allAoas,
          ransRetryScope: {
            origin: "continuous-polar",
            requestedAoas: allAoas,
          },
        },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(parent.id);
    for (const aoa of allAoas) {
      const [row] = await db
        .insert(results)
        .values({
          airfoilId: a.id,
          bcId: bc.id,
          simulationPresetRevisionId: presetRevisionId,
          aoaDeg: aoa,
          status: "queued",
          source: "queued",
          simJobId: parent.id,
        })
        .returning({ id: results.id });
      cleanupResultIds.add(row.id);
    }

    let submittedRequest: unknown = null;
    const clCdByAoa = new Map([
      [0.021, [0.3, 0.0102]],
      [1.021, [0.41, 0.0104]],
      [2.021, [0.51, 0.011]],
      [3.021, [0.62, 0.012]],
      [4.021, [0.73, 0.014]],
      [5.021, [0.84, 0.017]],
      [6.021, [0.95, 0.021]],
      [7.021, [1.04, 0.027]],
      [8.021, [1.12, 0.034]],
      [9.021, [1.2, 0.043]],
      [10.021, [1.27, 0.054]],
      [11.021, [1.32, 0.066]],
      [12.021, [1.34, 0.078]],
      [13.021, [1.32, 0.092]],
      [14.021, [1.19, 0.08]],
      [15.021, [0.9, 0.145]],
      [16.021, [0.82, 0.182]],
      [17.021, [0.79, 0.21]],
      [18.021, [0.78, 0.239]],
    ] as [number, [number, number]][]);
    const completedResult: JobResult = {
      job_id: "ag24-like-rans-parent",
      state: "completed",
      polars: [
        {
          speed: bc.speedMps,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: bc.mach,
          points: ransAoas.map((aoa) => {
            const [cl, cd] = clCdByAoa.get(aoa)!;
            return {
              aoa_deg: aoa,
              cl,
              cd,
              cm: -0.05,
              cl_cd: cl / cd,
              unsteady: false,
              converged: true,
              first_order_fallback: false,
              images: {},
            };
          }),
          attempts: rejectedAoas.map((aoa, i) => ({
            aoa_deg: aoa,
            cl: 0.7 - i * 0.05,
            cd: 0.28 + i * 0.02,
            cm: -0.08,
            cl_cd: 2.5,
            unsteady: false,
            converged: false,
            first_order_fallback: false,
            images: {},
            failure_disposition: "hard_solver",
            error: "RANS did not converge",
          })),
        },
      ],
    };
    const retryEngine = {
      getJob: async (): Promise<JobStatus> => ({
        job_id: "ag24-like-rans-parent",
        state: "completed",
        total_cases: allAoas.length,
        completed_cases: allAoas.length,
      }),
      getResult: async () => withExactManifestEvidence(completedResult),
      submitPolar: async (request: unknown): Promise<JobStatus> => {
        submittedRequest = request;
        return {
          job_id: "ag24-like-urans-child",
          state: "pending",
          total_cases: 7,
          completed_cases: 0,
        };
      },
      fileUrl: (jobId: string, relPath: string) =>
        `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, retryEngine, {
      jobIds: [parent.id],
      skipFailedRecovery: true,
    });

    const [child] = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)))
      .limit(1);
    expect(child).toBeTruthy();
    cleanupJobIds.add(child.id);
    expect(child.totalCases).toBe(7);
    expect((child.requestPayload as { retryMode?: string })?.retryMode).toBe(
      "needs-urans-confirmation",
    );
    expect(
      (submittedRequest as { aoa?: { angles?: number[] } })?.aoa?.angles,
    ).toEqual([14.021, 15.021, 16.021, 17.021, 18.021, 19.021, 20.021]);
    await expectBackgroundPrecalcSubmission(
      child,
      [14.021, 15.021, 16.021, 17.021, 18.021, 19.021, 20.021],
    );

    const classified = await db
      .select({
        aoaDeg: resultClassifications.aoaDeg,
        state: resultClassifications.state,
      })
      .from(resultClassifications)
      .where(
        and(
          eq(
            resultClassifications.simulationPresetRevisionId,
            presetRevisionId,
          ),
          isNotNull(resultClassifications.resultId),
          inArray(
            resultClassifications.aoaDeg,
            [14.021, 15.021, 16.021, 17.021, 18.021],
          ),
        ),
      );
    expect(classified.map((row) => row.state).sort()).toEqual([
      "needs_urans",
      "needs_urans",
      "needs_urans",
      "needs_urans",
      "needs_urans",
    ]);

    const provisionalRows = await db
      .select({
        aoaDeg: results.aoaDeg,
        status: results.status,
        source: results.source,
        simJobId: results.simJobId,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, [14.021, 15.021, 16.021, 17.021, 18.021]),
        ),
      );
    expect(
      provisionalRows.every(
        (row) =>
          row.status === "done" &&
          row.source === "solved" &&
          row.simJobId === parent.id,
      ),
    ).toBe(true);

    const retainedHardRejected = await db
      .select({
        aoaDeg: results.aoaDeg,
        status: results.status,
        simJobId: results.simJobId,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, rejectedAoas),
        ),
      );
    expect(
      retainedHardRejected.every(
        (row) => row.status === "failed" && row.simJobId === parent.id,
      ),
    ).toBe(true);
  }, 60000);

  it("does not submit a URANS retry when all RANS points are valid", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoas = [140.01, 141.01];
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, aoas),
        ),
      );
    const [parent] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "submitted",
        engineJobId: "valid-rans-parent",
        totalCases: aoas.length,
        completedCases: aoas.length,
        requestPayload: {
          speedMap: [
            {
              speed: bc.speedMps,
              bcId: bc.id,
              presetRevisionId,
              mach: bc.mach,
            },
          ],
          aoas,
        },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(parent.id);
    for (const aoa of aoas) {
      const [row] = await db
        .insert(results)
        .values({
          airfoilId: a.id,
          bcId: bc.id,
          simulationPresetRevisionId: presetRevisionId,
          aoaDeg: aoa,
          status: "queued",
          source: "queued",
          simJobId: parent.id,
        })
        .returning({ id: results.id });
      cleanupResultIds.add(row.id);
    }

    let submittedRetry = false;
    const validResult: JobResult = {
      job_id: "valid-rans-parent",
      state: "completed",
      polars: [
        {
          speed: bc.speedMps,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: bc.mach,
          points: aoas.map((aoa, i) => ({
            aoa_deg: aoa,
            cl: 0.25 + i * 0.1,
            cd: 0.02,
            cm: -0.01,
            cl_cd: 12.5 + i * 5,
            unsteady: false,
            converged: true,
            first_order_fallback: false,
            images: {},
          })),
        },
      ],
    };
    const validEngine = {
      getJob: async (): Promise<JobStatus> => ({
        job_id: "valid-rans-parent",
        state: "completed",
        total_cases: aoas.length,
        completed_cases: aoas.length,
      }),
      getResult: async () => withExactManifestEvidence(validResult),
      submitPolar: async (): Promise<JobStatus> => {
        submittedRetry = true;
        return {
          job_id: "unexpected-child",
          state: "pending",
          total_cases: aoas.length,
          completed_cases: 0,
        };
      },
      fileUrl: (jobId: string, relPath: string) =>
        `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, validEngine, {
      jobIds: [parent.id],
      skipFailedRecovery: true,
    });

    expect(submittedRetry).toBe(false);
    const children = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
    expect(children.length).toBe(0);
    const solved = await db
      .select({
        status: results.status,
        source: results.source,
        simJobId: results.simJobId,
        converged: results.converged,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, aoas),
        ),
      );
    expect(solved.length).toBe(2);
    expect(
      solved.every(
        (r) =>
          r.status === "done" &&
          r.source === "solved" &&
          r.simJobId === parent.id &&
          r.converged,
      ),
    ).toBe(true);
  }, 60000);

  it("solved points are no longer reported as gaps", async () => {
    const gaps = await findGaps(db, 3000);
    const solvedStillGap = gaps.filter(
      (g) =>
        g.airfoilId === airfoilId &&
        g.bcId === bcId &&
        g.presetRevisionId === testPresetRevisionId &&
        (g.aoaDeg === 81.001 || g.aoaDeg === 82.001),
    );
    expect(solvedStillGap.length).toBe(0);
  }, 60000);

  it("resets queued rows that lost their sim job link", async () => {
    const batch = await testBatch(500);
    expect(batch).not.toBeNull();
    const [parallelOwner] = await db
      .insert(simJobs)
      .values({
        airfoilId: batch!.airfoilId,
        bcIds: [batch!.bcId],
        simulationPresetRevisionId: batch!.presetRevisionId,
        referenceChordM: 1,
        status: "pending",
        totalCases: 1,
        requestPayload: { aoas: [123.457], fixture: "parallel-owner" },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(parallelOwner.id);
    const [row] = await db
      .insert(results)
      .values({
        airfoilId: batch!.airfoilId,
        bcId: batch!.bcId,
        simulationPresetRevisionId: batch!.presetRevisionId,
        aoaDeg: 123.456,
        status: "queued",
        source: "queued",
        simJobId: null,
      })
      .onConflictDoUpdate({
        target: [
          results.airfoilId,
          results.simulationPresetRevisionId,
          results.aoaDeg,
        ],
        set: { status: "queued", source: "queued", simJobId: null },
      })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    // This fixture exercises only the detached result-row repair. Supply an
    // impossible job scope as well as the exact result id so parallel test
    // files keep ownership of their own pending submit compositions.
    await resetOrphans(db, {
      jobIds: [randomUUID()],
      resultIds: [row.id],
    });

    const [got] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, row.id));
    expect(got.status).toBe("pending");
    expect(got.simJobId).toBeNull();
    expect(
      await db
        .select({ status: simJobs.status })
        .from(simJobs)
        .where(eq(simJobs.id, parallelOwner.id)),
    ).toEqual([{ status: "pending" }]);
    await db.delete(results).where(eq(results.id, row.id));
    await db.delete(simJobs).where(eq(simJobs.id, parallelOwner.id));
    cleanupJobIds.delete(parallelOwner.id);
  });

  it("startup recovery terminalizes an orphan pre-boundary composition so it no longer inflates solver queue pressure", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 2,
        status: "pending",
        engineState: "submitting",
        totalCases: 1,
        requestPayload: { aoas: [124.123], uransFidelity: "precalc" },
      })
      .returning();
    cleanupJobIds.add(job.id);
    const [claim] = await db
      .insert(results)
      .values({
        airfoilId: a.id,
        bcId: bc.id,
        simulationPresetRevisionId: presetRevisionId,
        aoaDeg: 124.123,
        status: "queued",
        source: "queued",
        simJobId: job.id,
      })
      .onConflictDoUpdate({
        target: [
          results.airfoilId,
          results.simulationPresetRevisionId,
          results.aoaDeg,
        ],
        set: { status: "queued", source: "queued", simJobId: job.id },
      })
      .returning({ id: results.id });
    cleanupResultIds.add(claim.id);

    expect(await solverQueuePressure(db, { jobIds: [job.id] })).toBe(1);
    await resetOrphans(db, { jobIds: [job.id] });
    expect(await solverQueuePressure(db, { jobIds: [job.id] })).toBe(0);
    const [afterJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    const [afterClaim] = await db
      .select()
      .from(results)
      .where(eq(results.id, claim.id));
    expect(afterJob).toMatchObject({
      status: "cancelled",
      engineState: "cancelled",
    });
    expect(afterClaim).toMatchObject({ status: "pending", simJobId: null });

    const resolved = await ensureSimulationPresetRevision(db, testPresetId);
    if (!resolved) throw new Error("test setup revision required");
    const { request } = buildPolarRequest({
      airfoil: a,
      setup: resolved.revision.snapshot as never,
      aoaList: [124.124],
      wave: 2,
      uransFidelity: "precalc",
      cpuSlots: 0,
    });
    expect(request.resources).not.toHaveProperty("queue_pressure");
  }, 60000);

  it("keeps an engine-visible job active when a status poll briefly misses it", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 124.456;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, [aoa]),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "submitted",
        engineJobId: "engine-visible-after-404",
        submittedAt: new Date(),
        totalCases: 1,
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const [row] = await db
      .insert(results)
      .values({
        airfoilId: a.id,
        bcId: bc.id,
        simulationPresetRevisionId: presetRevisionId,
        aoaDeg: aoa,
        status: "queued",
        source: "queued",
        simJobId: job.id,
      })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    const transientMissEngine = {
      getJob: async () => {
        throw new EngineError("GET /jobs/engine-visible-after-404 -> 404", 404);
      },
      getQueue: async () => emptyQueue(["engine-visible-after-404"]),
    } as unknown as EngineClient;

    await reconcile(db, transientMissEngine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });

    const [got] = await db
      .select({
        status: simJobs.status,
        engineState: simJobs.engineState,
        error: simJobs.error,
      })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(got.status).toBe("running");
    expect(got.engineState).toBe("running");
    expect(got.error).toBeNull();
  });

  it("keeps a detached worker heartbeat active even when Celery no longer lists the task", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 124.956;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, [aoa]),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "running",
        engineJobId: "detached-process-after-celery-loss",
        submittedAt: new Date(Date.now() - 60 * 60 * 1000),
        totalCases: 36,
        completedCases: 8,
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const [row] = await db
      .insert(results)
      .values({
        airfoilId: a.id,
        bcId: bc.id,
        simulationPresetRevisionId: presetRevisionId,
        aoaDeg: aoa,
        status: "running",
        source: "queued",
        simJobId: job.id,
      })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    const detachedEngine = {
      getQueue: async () => emptyQueue(),
      getJobRuntimes: async () => ({
        jobs: [
          {
            job_id: "detached-process-after-celery-loss",
            exists: true,
            cancelled: false,
            process_count: 0,
            direct_process_count: 0,
            heartbeat_process_count: 0,
            runtime_heartbeat_age_sec: 5,
            runtime_heartbeat_at: new Date().toISOString(),
            status_readable: false,
            status_error: "empty JSON file",
            status_state: null,
            status_total_cases: null,
            status_completed_cases: null,
            result_readable: false,
            result_error: null,
            has_result: false,
            result_state: null,
          },
        ],
      }),
      getJob: async () => {
        throw new EngineError(
          "GET /jobs/detached-process-after-celery-loss -> 409",
          409,
        );
      },
    } as unknown as EngineClient;

    await reconcile(db, detachedEngine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });

    const [got] = await db
      .select({
        status: simJobs.status,
        engineState: simJobs.engineState,
        error: simJobs.error,
      })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    const [gotResult] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, row.id));
    expect(got.status).toBe("running");
    expect(got.engineState).toBe("running");
    expect(got.error).toContain("heartbeat");
    expect(gotResult.status).toBe("running");
    expect(gotResult.simJobId).toBe(job.id);
  });

  it("ingests a completed result file even when Celery no longer sees the task", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 125.156;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, [aoa]),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "running",
        engineJobId: "completed-runtime-result-no-celery",
        submittedAt: new Date(Date.now() - 60 * 60 * 1000),
        totalCases: 1,
        completedCases: 0,
        requestPayload: {
          speedMap: [
            {
              speed: bc.speedMps,
              bcId: bc.id,
              presetRevisionId,
              mach: bc.mach,
            },
          ],
        },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const [row] = await db
      .insert(results)
      .values({
        airfoilId: a.id,
        bcId: bc.id,
        simulationPresetRevisionId: presetRevisionId,
        aoaDeg: aoa,
        status: "running",
        source: "queued",
        simJobId: job.id,
      })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    const result: JobResult = {
      job_id: "completed-runtime-result-no-celery",
      state: "completed",
      polars: [
        {
          speed: bc.speedMps,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: bc.mach,
          points: [
            {
              aoa_deg: aoa,
              cl: 0.61,
              cd: 0.013,
              cm: -0.03,
              cl_cd: 46.9,
              unsteady: false,
              converged: true,
              first_order_fallback: false,
              images: {},
            },
          ],
        },
      ],
    };
    const resultReadyEngine = {
      getQueue: async () => emptyQueue(),
      getJobRuntimes: async () => ({
        jobs: [
          {
            job_id: "completed-runtime-result-no-celery",
            exists: true,
            cancelled: false,
            process_count: 0,
            status_readable: false,
            status_error: "empty JSON file",
            status_state: null,
            status_total_cases: null,
            status_completed_cases: null,
            result_readable: true,
            result_error: null,
            has_result: true,
            result_state: "completed",
          },
        ],
      }),
      getJob: async () => {
        throw new EngineError(
          "GET /jobs/completed-runtime-result-no-celery -> 409",
          409,
        );
      },
      getResult: async () => withExactManifestEvidence(result),
      fileUrl: (jobId: string, relPath: string) =>
        `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, resultReadyEngine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });

    const [gotJob] = await db
      .select({
        status: simJobs.status,
        error: simJobs.error,
        completedCases: simJobs.completedCases,
      })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    const [gotResult] = await db
      .select({
        status: results.status,
        source: results.source,
        cl: results.cl,
      })
      .from(results)
      .where(eq(results.id, row.id));
    expect(gotJob.status).toBe("done");
    expect(gotJob.error).toBeNull();
    expect(gotJob.completedCases).toBe(1);
    expect(gotResult.status).toBe("done");
    expect(gotResult.source).toBe("solved");
    expect(gotResult.cl).toBeCloseTo(0.61, 6);
  }, 60000);

  it("terminalizes completed URANS evidence when default media is incomplete and defers only the bounded repair", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 125.181;
    const engineJobId = `completed-urans-missing-video-${testRunSlug}`;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          eq(results.aoaDeg, aoa),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 2,
        status: "running",
        engineJobId,
        submittedAt: new Date(Date.now() - 60 * 60 * 1000),
        totalCases: 1,
        requestPayload: {
          uransFidelity: "precalc",
          speedMap: [
            {
              speed: bc.speedMps,
              bcId: bc.id,
              presetRevisionId,
              mach: bc.mach,
            },
          ],
        },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const [row] = await db
      .insert(results)
      .values({
        airfoilId: a.id,
        bcId: bc.id,
        simulationPresetRevisionId: presetRevisionId,
        aoaDeg: aoa,
        status: "running",
        source: "queued",
        simJobId: job.id,
        engineJobId,
      })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    const result: JobResult = {
      job_id: engineJobId,
      state: "completed",
      polars: [
        {
          speed: bc.speedMps,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: bc.mach,
          points: [
            {
              case_slug: "urans-missing-video",
              aoa_deg: aoa,
              cl: 0.72,
              cd: 0.028,
              cm: -0.035,
              cl_cd: 25.7,
              cl_std: 0.03,
              cd_std: 0.002,
              unsteady: true,
              converged: true,
              first_order_fallback: false,
              fidelity: "urans_precalc",
              frame_track: {
                period_s: 0.25,
                periods_retained: 4,
                stationary: true,
                drift_frac: 0.01,
                window: { t_start: 1, t_end: 2 },
                stats: {
                  cl: { mean: 0.72, std: 0.03, min: 0.67, max: 0.77 },
                  cd: { mean: 0.028, std: 0.002, min: 0.025, max: 0.031 },
                  cm: {
                    mean: -0.035,
                    std: 0.002,
                    min: -0.038,
                    max: -0.032,
                  },
                },
                fields: ["velocity_magnitude"],
                frames: [],
                image_pattern: "frames/{field}/f{i04}.png",
              },
              force_history: {
                t: [1, 1.25, 1.5, 1.75, 2],
                cl: [0.7, 0.74, 0.71, 0.73, 0.72],
                cd: [0.027, 0.029, 0.028, 0.028, 0.028],
                cm: [-0.034, -0.036, -0.035, -0.035, -0.035],
                shedding_freq_hz: 4,
                samples: 200,
              },
              images: {
                velocity_magnitude: `/jobs/${engineJobId}/files/cases/urans-missing-video/images/velocity_magnitude.png`,
              },
              mean_images: {
                velocity_magnitude: `/jobs/${engineJobId}/files/cases/urans-missing-video/images/velocity_magnitude_mean.png`,
              },
              // Intentionally no video: only a durable repair may attempt to
              // create it; it cannot hold this completed engine job open.
              video: {},
            },
          ],
        },
      ],
    };
    const incompleteMediaEngine = {
      getQueue: async () => emptyQueue(),
      getJobRuntimes: async () => ({
        jobs: [
          {
            job_id: engineJobId,
            exists: true,
            cancelled: false,
            process_count: 0,
            status_readable: true,
            status_state: "completed",
            status_total_cases: 1,
            status_completed_cases: 1,
            result_readable: true,
            has_result: true,
            result_state: "completed",
          },
        ],
      }),
      getJob: async (): Promise<JobStatus> => ({
        job_id: engineJobId,
        state: "completed",
        total_cases: 1,
        completed_cases: 1,
      }),
      getResult: async () => withExactManifestEvidence(result),
      computeFieldExtents: async () => {
        throw new Error("scheduler ingest must not calculate field extents");
      },
      renderDefaultMedia: async () => {
        throw new Error("scheduler ingest must not render default media");
      },
      fileUrl: (id: string, relPath: string) =>
        `http://engine.test/jobs/${id}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, incompleteMediaEngine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });

    const [completedJob] = await db
      .select({ status: simJobs.status, error: simJobs.error })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(completedJob).toEqual({ status: "done", error: null });
    const [completedResult] = await db
      .select({
        status: results.status,
        simJobId: results.simJobId,
        autoRetriedAt: results.autoRetriedAt,
      })
      .from(results)
      .where(eq(results.id, row.id));
    // Missing only default media is an output-repair obligation. It must not
    // be requeued as another OpenFOAM solve by the generic failed-result path.
    expect(completedResult).toEqual({
      status: "failed",
      simJobId: job.id,
      autoRetriedAt: null,
    });
    const [classification] = await db
      .select({
        state: resultClassifications.state,
        reasons: resultClassifications.reasons,
      })
      .from(resultClassifications)
      .innerJoin(
        resultAttempts,
        eq(resultClassifications.resultAttemptId, resultAttempts.id),
      )
      .where(
        and(
          eq(resultAttempts.resultId, row.id),
          eq(resultAttempts.simJobId, job.id),
        ),
      );
    expect(classification).toEqual({
      state: "rejected",
      reasons: ["missing-urans-video"],
    });

    await discoverMissingResultMediaRepairs(db, { resultId: row.id });
    const [repair] = await db
      .select({
        state: resultMediaRepairs.state,
        resultAttemptId: resultMediaRepairs.resultAttemptId,
      })
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, row.id));
    expect(repair?.resultAttemptId).toBeTruthy();
    expect(["pending", "retry_wait", "blocked"]).toContain(repair?.state);
  }, 60000);

  it("gives cancel-versus-ingest exactly one owner so no evidence lands under cancelled ownership", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 125.206;
    const engineJobId = `cancel-ingest-owner-${testRunSlug}`;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          eq(results.aoaDeg, aoa),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "running",
        engineJobId,
        submittedAt: new Date(),
        totalCases: 1,
        requestPayload: {
          speedMap: [
            {
              speed: bc.speedMps,
              bcId: bc.id,
              presetRevisionId,
              mach: bc.mach,
            },
          ],
        },
      })
      .returning();
    cleanupJobIds.add(job.id);
    const [row] = await db
      .insert(results)
      .values({
        airfoilId: a.id,
        bcId: bc.id,
        simulationPresetRevisionId: presetRevisionId,
        aoaDeg: aoa,
        status: "running",
        source: "queued",
        simJobId: job.id,
        engineJobId,
      })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);
    const completed: JobResult = {
      job_id: engineJobId,
      state: "completed",
      polars: [
        {
          speed: bc.speedMps,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: bc.mach,
          points: [
            {
              aoa_deg: aoa,
              cl: 0.64,
              cd: 0.0135,
              cm: -0.03,
              cl_cd: 47.4,
              unsteady: false,
              converged: true,
              first_order_fallback: false,
              images: {},
            },
          ],
        },
      ],
    };
    let cancellation: Awaited<
      ReturnType<typeof claimSimJobCancellation>
    > | null = null;
    const racingEngine = {
      getQueue: async () => emptyQueue(),
      getJobRuntimes: async () => ({
        jobs: [
          {
            job_id: engineJobId,
            exists: true,
            cancelled: false,
            process_count: 0,
            status_readable: true,
            status_state: "completed",
            status_total_cases: 1,
            status_completed_cases: 1,
            result_readable: true,
            has_result: true,
            result_state: "completed",
          },
        ],
      }),
      getResult: async () => {
        // Deterministic interleaving: reconciliation selected the stale active
        // row, then admin cancellation arrives exactly after ingest claims its
        // boundary but before evidence/media writes begin.
        cancellation = await claimSimJobCancellation(
          db,
          job.id,
          "cancelled by admin",
        );
        return withExactManifestEvidence(completed);
      },
      fileUrl: (id: string, relPath: string) =>
        `http://engine.test/jobs/${id}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, racingEngine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });
    expect(cancellation).toMatchObject({
      kind: "not_cancellable",
      status: "ingesting",
    });
    const [afterJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    const [afterResult] = await db
      .select()
      .from(results)
      .where(eq(results.id, row.id));
    expect(afterJob.status).toBe("done");
    expect(afterResult).toMatchObject({
      status: "done",
      simJobId: job.id,
      cl: 0.64,
    });
  }, 60000);

  it("ingests a running partial result without marking the sweep done", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 125.256;
    const stalledAoa = 126.256;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, [aoa]),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "running",
        engineJobId: "running-partial-result",
        submittedAt: new Date(Date.now() - 60 * 60 * 1000),
        totalCases: 3,
        completedCases: 0,
        requestPayload: {
          speedMap: [
            {
              speed: bc.speedMps,
              bcId: bc.id,
              presetRevisionId,
              mach: bc.mach,
            },
          ],
          aoas: [aoa, stalledAoa],
          ransRetryScope: {
            origin: "continuous-polar",
            requestedAoas: [aoa, stalledAoa],
          },
        },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const [row] = await db
      .insert(results)
      .values({
        airfoilId: a.id,
        bcId: bc.id,
        simulationPresetRevisionId: presetRevisionId,
        aoaDeg: aoa,
        status: "running",
        source: "queued",
        simJobId: job.id,
      })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    const partialResult: JobResult = {
      job_id: "running-partial-result",
      state: "running",
      polars: [
        {
          speed: bc.speedMps,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: bc.mach,
          points: [
            {
              aoa_deg: aoa,
              cl: 0.67,
              cd: 0.014,
              cm: -0.025,
              cl_cd: 47.9,
              unsteady: false,
              converged: true,
              first_order_fallback: false,
              images: {},
            },
          ],
          attempts: [
            {
              aoa_deg: stalledAoa,
              cl: null,
              cd: null,
              cm: null,
              cl_cd: null,
              unsteady: false,
              converged: false,
              first_order_fallback: false,
              failure_disposition: "hard_solver",
              error: "RANS residuals remained stalled",
              images: {},
            },
          ],
        },
      ],
    };
    const partialEngine = {
      getQueue: async () => emptyQueue(["running-partial-result"]),
      getJobRuntimes: async () => ({
        jobs: [
          {
            job_id: "running-partial-result",
            exists: true,
            cancelled: false,
            process_count: 1,
            status_readable: true,
            status_error: null,
            status_state: "running",
            status_total_cases: 3,
            status_completed_cases: 1,
            result_readable: true,
            result_error: null,
            has_result: true,
            result_state: "running",
          },
        ],
      }),
      getJob: async (): Promise<JobStatus> => ({
        job_id: "running-partial-result",
        state: "running",
        total_cases: 3,
        completed_cases: 1,
      }),
      getResult: async () => withExactManifestEvidence(partialResult),
      fileUrl: (jobId: string, relPath: string) =>
        `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, partialEngine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });

    const [gotJob] = await db
      .select({
        status: simJobs.status,
        engineState: simJobs.engineState,
        completedCases: simJobs.completedCases,
        finishedAt: simJobs.finishedAt,
      })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    const [gotResult] = await db
      .select({
        status: results.status,
        source: results.source,
        cl: results.cl,
      })
      .from(results)
      .where(eq(results.id, row.id));
    expect(gotJob.status).toBe("running");
    expect(gotJob.engineState).toBe("running");
    expect(gotJob.completedCases).toBe(1);
    expect(gotJob.finishedAt).toBeNull();
    expect(gotResult.status).toBe("done");
    expect(gotResult.source).toBe("solved");
    expect(gotResult.cl).toBeCloseTo(0.67, 6);
    const attempts = await db
      .select({ id: resultAttempts.id })
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.simJobId, job.id),
          eq(resultAttempts.aoaDeg, aoa),
        ),
      );
    attempts.forEach((attempt) => cleanupAttemptIds.add(attempt.id));
    expect(attempts.length).toBe(1);
    const [precalcRoute] = await db
      .select({
        state: simPrecalcObligations.state,
        backgroundOwner: simPrecalcObligations.backgroundOwner,
      })
      .from(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, a.id),
          eq(simPrecalcObligations.revisionId, presetRevisionId),
          eq(simPrecalcObligations.aoaDeg, stalledAoa),
        ),
      );
    // MUST-CATCH: partial RANS failure owns a real preliminary-URANS route
    // immediately, but partial ingest does not submit outside scheduler limits.
    expect(precalcRoute).toMatchObject({
      state: "pending",
      backgroundOwner: true,
    });
    expect(
      await db
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(and(eq(simJobs.parentJobId, job.id), eq(simJobs.wave, 2))),
    ).toHaveLength(0);
  }, 60000);

  it("MUST-CATCH: running partial ingest durably records a typed whole-polar promotion before terminal sibling work", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoas = [0.125, 2.125, 4.125];
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, aoas),
        ),
      );
    const engineJobId = "running-partial-rans-promotion";
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "running",
        engineJobId,
        submittedAt: new Date(Date.now() - 60 * 60 * 1000),
        totalCases: aoas.length,
        completedCases: 0,
        requestPayload: {
          speedMap: [
            {
              speed: bc.speedMps,
              bcId: bc.id,
              presetRevisionId,
              mach: bc.mach,
            },
          ],
          aoas,
          ransRetryScope: {
            origin: "continuous-polar",
            requestedAoas: aoas,
          },
        },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const seededResults = await db
      .insert(results)
      .values(
        aoas.map((aoaDeg) => ({
          airfoilId: a.id,
          bcId: bc.id,
          simulationPresetRevisionId: presetRevisionId,
          aoaDeg,
          status: "running" as const,
          source: "queued" as const,
          regime: "rans" as const,
          simJobId: job.id,
          engineJobId,
        })),
      )
      .returning({ id: results.id, aoaDeg: results.aoaDeg });
    seededResults.forEach((row) => cleanupResultIds.add(row.id));

    const accepted = {
      aoa_deg: aoas[0],
      cl: 0.02,
      cd: 0.014,
      cm: -0.01,
      cl_cd: 0.02 / 0.014,
      unsteady: false,
      converged: true,
      first_order_fallback: false,
      failure_disposition: "none" as const,
      images: {},
    };
    const hardFailure = {
      aoa_deg: aoas[1],
      cl: null,
      cd: null,
      cm: null,
      cl_cd: null,
      unsteady: false,
      converged: false,
      first_order_fallback: false,
      failure_disposition: "hard_solver" as const,
      error: "HardSolverError: divergence watchdog condemned RANS",
      images: {},
    };
    const partialResult: JobResult = {
      job_id: engineJobId,
      state: "running",
      polars: [
        {
          speed: bc.speedMps,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: bc.mach,
          points: [accepted],
          attempts: [accepted, hardFailure],
          rans_precalc_promotion: {
            trigger_aoa_deg: aoas[1],
            failure_disposition: "hard_solver",
            attempted_aoas: aoas.slice(0, 2),
            intentionally_omitted_aoas: [aoas[2]],
          },
        },
      ],
    };
    const partialEngine = {
      getQueue: async () => emptyQueue([engineJobId]),
      getJobRuntimes: async () => ({
        jobs: [
          {
            job_id: engineJobId,
            exists: true,
            cancelled: false,
            process_count: 1,
            status_readable: true,
            status_state: "running",
            status_total_cases: aoas.length,
            status_completed_cases: 2,
            result_readable: true,
            has_result: true,
            result_state: "running",
          },
        ],
      }),
      getJob: async (): Promise<JobStatus> => ({
        job_id: engineJobId,
        state: "running",
        total_cases: aoas.length,
        completed_cases: 2,
      }),
      getResult: async () => partialResult,
      fileUrl: (jobId: string, relPath: string) =>
        `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, partialEngine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });

    const [promotion] = await db
      .select()
      .from(simRansPolarPromotions)
      .where(eq(simRansPolarPromotions.parentJobId, job.id));
    expect(promotion).toMatchObject({
      revisionId: presetRevisionId,
      triggerAoaDeg: aoas[1],
      failureDisposition: "hard_solver",
      requestOrigin: "continuous-polar",
    });
    const promotionPoints = await db
      .select({
        aoaDeg: simRansPolarPromotionPoints.aoaDeg,
        omitted: simRansPolarPromotionPoints.intentionallyOmittedByRans,
      })
      .from(simRansPolarPromotionPoints)
      .where(eq(simRansPolarPromotionPoints.promotionId, promotion.id));
    expect(
      promotionPoints.sort((left, right) => left.aoaDeg - right.aoaDeg),
    ).toEqual([
      { aoaDeg: aoas[0], omitted: false },
      { aoaDeg: aoas[1], omitted: false },
      { aoaDeg: aoas[2], omitted: true },
    ]);
    expect(
      await db
        .select({ id: simPrecalcObligations.id })
        .from(simPrecalcObligations)
        .where(
          and(
            eq(simPrecalcObligations.airfoilId, a.id),
            eq(simPrecalcObligations.revisionId, presetRevisionId),
            inArray(simPrecalcObligations.aoaDeg, aoas),
          ),
        ),
    ).toHaveLength(3);
    expect(
      await db
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(and(eq(simJobs.parentJobId, job.id), eq(simJobs.wave, 2))),
    ).toHaveLength(0);
    const [parentAfter] = await db
      .select({ status: simJobs.status })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(parentAfter.status).toBe("running");
    const hardAfter = (
      await db
        .select({
          status: results.status,
          simJobId: results.simJobId,
          currentAttemptId: results.currentResultAttemptId,
        })
        .from(results)
        .where(
          and(
            eq(results.airfoilId, a.id),
            eq(results.simulationPresetRevisionId, presetRevisionId),
            eq(results.aoaDeg, aoas[1]),
          ),
        )
    )[0];
    expect(hardAfter).toMatchObject({ status: "failed", simJobId: job.id });
    expect(hardAfter.currentAttemptId).toBeNull();
    const omittedAfter = (
      await db
        .select({
          status: results.status,
          simJobId: results.simJobId,
          currentAttemptId: results.currentResultAttemptId,
        })
        .from(results)
        .where(
          and(
            eq(results.airfoilId, a.id),
            eq(results.simulationPresetRevisionId, presetRevisionId),
            eq(results.aoaDeg, aoas[2]),
          ),
        )
    )[0];
    expect(omittedAfter).toEqual({
      status: "queued",
      simJobId: null,
      currentAttemptId: null,
    });
  }, 60000);

  it("re-ingests a completed engine result after a prior ingest failure", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 125.456;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, [aoa]),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "failed",
        engineJobId: "completed-after-ingest-failure",
        totalCases: 1,
        completedCases: 1,
        requestPayload: {
          speedMap: [
            {
              speed: bc.speedMps,
              bcId: bc.id,
              presetRevisionId,
              mach: bc.mach,
            },
          ],
        },
        error: 'ingest failed: column "scheduling_policy" does not exist',
        finishedAt: new Date(),
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const [row] = await db
      .insert(results)
      .values({
        airfoilId: a.id,
        bcId: bc.id,
        simulationPresetRevisionId: presetRevisionId,
        aoaDeg: aoa,
        status: "failed",
        source: "queued",
        simJobId: job.id,
      })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    const status: JobStatus = {
      job_id: "completed-after-ingest-failure",
      state: "completed",
      total_cases: 1,
      completed_cases: 1,
    };
    const result: JobResult = {
      job_id: "completed-after-ingest-failure",
      state: "completed",
      polars: [
        {
          speed: bc.speedMps,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: bc.mach,
          points: [
            {
              aoa_deg: aoa,
              cl: 0.51,
              cd: 0.012,
              cm: -0.02,
              cl_cd: 42.5,
              unsteady: false,
              converged: true,
              first_order_fallback: false,
              images: {},
            },
          ],
        },
      ],
    };
    const recoveredEngine = {
      getJob: async () => status,
      getResult: async () => withExactManifestEvidence(result),
      fileUrl: (jobId: string, relPath: string) =>
        `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, recoveredEngine, {
      jobIds: [job.id],
      recoverFailedJobIds: [job.id],
    });

    const [gotJob] = await db
      .select({ status: simJobs.status, error: simJobs.error })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    const [gotResult] = await db
      .select({
        status: results.status,
        source: results.source,
        cl: results.cl,
        cd: results.cd,
      })
      .from(results)
      .where(eq(results.id, row.id));
    expect(gotJob.status).toBe("done");
    expect(gotJob.error).toBeNull();
    expect(gotResult.status).toBe("done");
    expect(gotResult.source).toBe("solved");
    expect(gotResult.cl).toBeCloseTo(0.51, 6);
    expect(gotResult.cd).toBeCloseTo(0.012, 6);
  }, 60000);

  it("requeues a recoverable failed job when the engine no longer has it", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 126.456;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, [aoa]),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "failed",
        engineJobId: "really-missing-engine-job",
        totalCases: 1,
        error: "engine job not found (lost)",
        finishedAt: new Date(),
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const [row] = await db
      .insert(results)
      .values({
        airfoilId: a.id,
        bcId: bc.id,
        simulationPresetRevisionId: presetRevisionId,
        aoaDeg: aoa,
        status: "failed",
        source: "queued",
        simJobId: job.id,
      })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    const missingEngine = {
      getJob: async () => {
        throw new EngineError(
          "GET /jobs/really-missing-engine-job -> 404",
          404,
        );
      },
      getQueue: async () => emptyQueue(),
    } as unknown as EngineClient;

    await reconcile(db, missingEngine, {
      jobIds: [job.id],
      recoverFailedJobIds: [job.id],
    });

    const [gotJob] = await db
      .select({ status: simJobs.status, engineState: simJobs.engineState })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    const [gotResult] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, row.id));
    expect(gotJob.status).toBe("cancelled");
    expect(gotJob.engineState).toBe("missing");
    expect(gotResult.status).toBe("pending");
    expect(gotResult.simJobId).toBeNull();
  });

  it("cancels redelivered engine work for a terminal DB job", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const engineJobId = `obsolete-redelivered-${testRunSlug}`;
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "cancelled",
        engineState: "missing",
        engineJobId,
        totalCases: 1,
        completedCases: 0,
        error: "engine job is absent from visible work",
        finishedAt: new Date(),
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);

    const activeTask = {
      worker: "test",
      task_id: engineJobId,
      name: "airfoilfoam.run_polar",
      job_id: engineJobId,
      redelivered: true,
    };
    const cancelled: string[] = [];
    const redeliveredEngine = {
      getQueue: async () => ({
        ...emptyQueue(),
        active: [activeTask],
        active_count: 1,
        job_ids: [engineJobId],
        redelivered: [activeTask],
      }),
      cancelJob: async (jobId: string) => {
        cancelled.push(jobId);
        return { job_id: jobId, cancelled: true };
      },
    } as unknown as EngineClient;

    await reconcile(db, redeliveredEngine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });

    const [gotJob] = await db
      .select({
        status: simJobs.status,
        engineState: simJobs.engineState,
        error: simJobs.error,
      })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(cancelled).toEqual([engineJobId]);
    expect(gotJob.status).toBe("cancelled");
    expect(gotJob.engineState).toBe("cancelled");
    expect(gotJob.error).toContain("engine job is absent");
  });

  // MUST-CATCH (G2, incident 2026-07-05): the engine cancelled 4 zombie jobs
  // via POST /jobs/<id>/cancel, but the sweeper's status mapping had no
  // 'cancelled' branch — the state fell through to "running" and the sweeper
  // polled the dead jobs forever while their claimed points stayed queued.
  it("releases claims and marks the job cancelled when the engine reports state=cancelled", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 91.001; // in the test sweep definition, so findGaps can re-pick it
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          eq(results.aoaDeg, aoa),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "running",
        engineJobId: "engine-side-cancelled-job",
        submittedAt: new Date(Date.now() - 60 * 60 * 1000),
        totalCases: 1,
        completedCases: 0,
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const [row] = await db
      .insert(results)
      .values({
        airfoilId: a.id,
        bcId: bc.id,
        simulationPresetRevisionId: presetRevisionId,
        aoaDeg: aoa,
        status: "running",
        source: "queued",
        simJobId: job.id,
      })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    let fetchedResult = false;
    const cancelledEngine = {
      getQueue: async () => emptyQueue(),
      getJob: async (): Promise<JobStatus> => ({
        job_id: "engine-side-cancelled-job",
        state: "cancelled",
        total_cases: 1,
        completed_cases: 0,
        message: "cancelled via engine API",
      }),
      getResult: async (): Promise<JobResult> => {
        fetchedResult = true;
        throw new Error("must not ingest a cancelled job");
      },
    } as unknown as EngineClient;

    await reconcile(db, cancelledEngine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });

    const [gotJob] = await db
      .select({
        status: simJobs.status,
        engineState: simJobs.engineState,
        finishedAt: simJobs.finishedAt,
      })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    const [gotResult] = await db
      .select({
        status: results.status,
        simJobId: results.simJobId,
        engineJobId: results.engineJobId,
        cl: results.cl,
      })
      .from(results)
      .where(eq(results.id, row.id));
    expect(gotJob.status).toBe("cancelled");
    expect(gotJob.engineState).toBe("cancelled");
    expect(gotJob.finishedAt).not.toBeNull();
    expect(gotResult.status).toBe("pending");
    expect(gotResult.simJobId).toBeNull();
    expect(gotResult.engineJobId).toBeNull();
    expect(gotResult.cl).toBeNull(); // no coefficient ingest from a cancelled job
    expect(fetchedResult).toBe(false);

    // The released point is a re-claimable gap again for the next tick.
    const gaps = await testGaps(10000);
    expect(
      gaps.some(
        (gap) =>
          gap.airfoilId === a.id &&
          gap.presetRevisionId === presetRevisionId &&
          gap.aoaDeg === aoa,
      ),
    ).toBe(true);
    await db.delete(results).where(eq(results.id, row.id));
  }, 60000);

  it("keeps an engine-cancelled evidence-backed wave-2 point on the outgoing precalc route", async () => {
    const aoa = 191.001;
    const fixture = await evidenceBackedWave2Fixture(
      `wave2-engine-cancelled-${testRunSlug}`,
      aoa,
      "running",
    );
    const cancelledEngine = {
      getQueue: async () => emptyQueue(),
      getJob: async (): Promise<JobStatus> => ({
        job_id: fixture.child.engineJobId!,
        state: "cancelled",
        total_cases: 1,
        completed_cases: 0,
        message: "engine cancelled transient child",
      }),
    } as unknown as EngineClient;

    await reconcile(db, cancelledEngine, {
      jobIds: [fixture.child.id],
      skipFailedRecovery: true,
    });
    const [released] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, fixture.row.id));
    expect(released).toEqual({ status: "queued", simJobId: null });
    const [releasedObligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, fixture.obligation.id));
    expect(releasedObligation).toMatchObject({
      state: "pending",
      attemptCount: 0,
      latestSimJobId: fixture.child.id,
      lastOutcome: "infrastructure_retry_wait",
    });
    await db
      .update(simPrecalcObligations)
      .set({ nextSubmitAt: new Date(0) })
      .where(eq(simPrecalcObligations.id, fixture.obligation.id));

    const requests: Parameters<EngineClient["submitPolar"]>[0][] = [];
    const outgoingEngine = {
      submitPolar: async (
        request: Parameters<EngineClient["submitPolar"]>[0],
      ): Promise<JobStatus> => {
        requests.push(request);
        return {
          job_id: `wave2-engine-cancelled-retry-${testRunSlug}`,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        };
      },
    } as unknown as EngineClient;
    await submitUransRetryForJob(db, outgoingEngine, fixture.parent);

    expect(requests).toHaveLength(1);
    expect(requests[0].aoa?.angles).toEqual([aoa]);
    expect(requests[0].solver).toMatchObject({
      force_transient: true,
      urans_fidelity: "precalc",
    });
    const children = await db
      .select({
        id: simJobs.id,
        status: simJobs.status,
        requestPayload: simJobs.requestPayload,
      })
      .from(simJobs)
      .where(
        and(eq(simJobs.parentJobId, fixture.parent.id), eq(simJobs.wave, 2)),
      );
    expect(children).toHaveLength(2);
    expect(
      children.filter((child) => child.status === "submitted"),
    ).toHaveLength(1);
    const [retriedObligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, fixture.obligation.id));
    expect(retriedObligation).toMatchObject({
      state: "running",
      attemptCount: 1,
    });
  }, 60000);

  it("keeps a lost evidence-backed wave-2 point on the outgoing precalc route", async () => {
    const aoa = 192.001;
    const fixture = await evidenceBackedWave2Fixture(
      `wave2-lost-${testRunSlug}`,
      aoa,
      "failed",
    );
    const missingEngine = {
      getQueue: async () => emptyQueue(),
      getJob: async () => {
        throw new EngineError(
          `GET /jobs/${fixture.child.engineJobId} -> 404`,
          404,
        );
      },
    } as unknown as EngineClient;

    await reconcile(db, missingEngine, {
      jobIds: [fixture.child.id],
      recoverFailedJobIds: [fixture.child.id],
    });
    const [released] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, fixture.row.id));
    expect(released).toEqual({ status: "queued", simJobId: null });
    const [releasedObligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, fixture.obligation.id));
    expect(releasedObligation).toMatchObject({
      state: "pending",
      attemptCount: 0,
      latestSimJobId: fixture.child.id,
      lastOutcome: "infrastructure_retry_wait",
    });
    await db
      .update(simPrecalcObligations)
      .set({ nextSubmitAt: new Date(0) })
      .where(eq(simPrecalcObligations.id, fixture.obligation.id));

    const requests: Parameters<EngineClient["submitPolar"]>[0][] = [];
    const outgoingEngine = {
      submitPolar: async (
        request: Parameters<EngineClient["submitPolar"]>[0],
      ): Promise<JobStatus> => {
        requests.push(request);
        return {
          job_id: `wave2-lost-retry-${testRunSlug}`,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        };
      },
    } as unknown as EngineClient;
    await submitUransRetryForJob(db, outgoingEngine, fixture.parent);

    expect(requests).toHaveLength(1);
    expect(requests[0].aoa?.angles).toEqual([aoa]);
    expect(requests[0].solver).toMatchObject({
      force_transient: true,
      urans_fidelity: "precalc",
    });
    const [retriedObligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, fixture.obligation.id));
    expect(retriedObligation).toMatchObject({
      state: "running",
      attemptCount: 1,
    });
  }, 60000);

  it("returns an accepted PRECALC attempt to pending after a worker-restart orphan", async () => {
    const aoa = 193.001;
    const fixture = await evidenceBackedWave2Fixture(
      `wave2-worker-restart-${testRunSlug}`,
      aoa,
      "running",
    );
    const orphanEngine = {
      getQueue: async () => emptyQueue(),
      getJob: async (): Promise<JobStatus> => ({
        job_id: fixture.child.engineJobId!,
        state: "failed",
        total_cases: 1,
        completed_cases: 0,
        message: WORKER_RESTART_ORPHAN_MESSAGE,
      }),
      getResult: async (): Promise<JobResult> => ({
        job_id: fixture.child.engineJobId!,
        state: "failed",
        message: WORKER_RESTART_ORPHAN_MESSAGE,
        polars: [],
      }),
    } as unknown as EngineClient;

    await reconcile(db, orphanEngine, {
      jobIds: [fixture.child.id],
      skipFailedRecovery: true,
    });
    const [afterJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, fixture.child.id));
    const [afterObligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, fixture.obligation.id));
    const [afterAttempt] = await db
      .select()
      .from(simPrecalcObligationAttempts)
      .where(
        eq(simPrecalcObligationAttempts.obligationId, fixture.obligation.id),
      );
    expect(afterJob).toMatchObject({
      status: "cancelled",
      engineState: "cancelled",
    });
    expect(afterObligation).toMatchObject({
      state: "pending",
      attemptCount: 0,
      lastOutcome: "infrastructure_retry_wait",
    });
    expect(afterAttempt).toMatchObject({
      state: "cancelled",
      outcome: "infrastructure_retry_wait",
      consumesSolverAttempt: false,
      solverAttemptNumber: null,
    });
  }, 60000);

  // MUST-CATCH (G3, incident 2026-07-05): a force-recreated worker killed the
  // celery tasks, but the engine's persisted status store kept returning
  // state=running (active_pids [], last_progress_at hours stale) — zombies the
  // sweeper polled for ~2.3 h. Shape: running + zero processes + stale worker
  // heartbeat + absent from Celery + last progress beyond the 30 min grace.
  it("cancels and requeues a lost engine job that reports running with no processes and stale progress", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 129.456;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          eq(results.aoaDeg, aoa),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "running",
        engineJobId: "zombie-after-worker-restart",
        submittedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        totalCases: 4,
        completedCases: 1,
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const [row] = await db
      .insert(results)
      .values({
        airfoilId: a.id,
        bcId: bc.id,
        simulationPresetRevisionId: presetRevisionId,
        aoaDeg: aoa,
        status: "running",
        source: "queued",
        simJobId: job.id,
      })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    const engineCancels: string[] = [];
    const zombieEngine = {
      getQueue: async () => emptyQueue(),
      getJobRuntimes: async () => ({
        jobs: [
          {
            job_id: "zombie-after-worker-restart",
            exists: true,
            cancelled: false,
            process_count: 0,
            active_pids: [],
            runtime_heartbeat_age_sec: 9000,
            status_readable: true,
            status_error: null,
            status_state: "running",
            status_total_cases: 4,
            status_completed_cases: 1,
            result_readable: false,
            result_error: null,
            has_result: false,
            result_state: null,
          },
        ],
      }),
      getJob: async (): Promise<JobStatus> => ({
        job_id: "zombie-after-worker-restart",
        state: "running",
        total_cases: 4,
        completed_cases: 1,
        active_pids: [],
        last_progress_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      }),
      cancelJob: async (jobId: string) => {
        engineCancels.push(jobId);
        return { job_id: jobId, cancelled: true };
      },
    } as unknown as EngineClient;

    await reconcile(db, zombieEngine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });

    const [gotJob] = await db
      .select({
        status: simJobs.status,
        engineState: simJobs.engineState,
        error: simJobs.error,
        finishedAt: simJobs.finishedAt,
      })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    const [gotResult] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, row.id));
    expect(engineCancels).toEqual(["zombie-after-worker-restart"]);
    expect(gotJob.status).toBe("cancelled");
    expect(gotJob.engineState).toBe("cancelled");
    expect(gotJob.error).toContain("task lost");
    expect(gotJob.finishedAt).not.toBeNull();
    expect(gotResult.status).toBe("pending");
    expect(gotResult.simJobId).toBeNull();
    await db.delete(results).where(eq(results.id, row.id));
  }, 60000);

  // FALSE-POSITIVE GUARD (G3): the identical zombie shape but with recent
  // progress (5 min < 30 min grace) is a legitimately quiet job — e.g. a long
  // single case between completed_cases bumps — and must be left untouched.
  it("keeps a quiet-but-recent running job untouched (lost-job grace not exceeded)", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 129.856;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          eq(results.aoaDeg, aoa),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "running",
        engineJobId: "quiet-but-alive-job",
        submittedAt: new Date(Date.now() - 60 * 60 * 1000),
        totalCases: 4,
        completedCases: 1,
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const [row] = await db
      .insert(results)
      .values({
        airfoilId: a.id,
        bcId: bc.id,
        simulationPresetRevisionId: presetRevisionId,
        aoaDeg: aoa,
        status: "running",
        source: "queued",
        simJobId: job.id,
      })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    const engineCancels: string[] = [];
    const quietEngine = {
      getQueue: async () => emptyQueue(),
      getJobRuntimes: async () => ({
        jobs: [
          {
            job_id: "quiet-but-alive-job",
            exists: true,
            cancelled: false,
            process_count: 0,
            active_pids: [],
            runtime_heartbeat_age_sec: 9000,
            status_readable: true,
            status_error: null,
            status_state: "running",
            status_total_cases: 4,
            status_completed_cases: 1,
            result_readable: false,
            result_error: null,
            has_result: false,
            result_state: null,
          },
        ],
      }),
      getJob: async (): Promise<JobStatus> => ({
        job_id: "quiet-but-alive-job",
        state: "running",
        total_cases: 4,
        completed_cases: 1,
        active_pids: [],
        last_progress_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      }),
      cancelJob: async (jobId: string) => {
        engineCancels.push(jobId);
        return { job_id: jobId, cancelled: true };
      },
    } as unknown as EngineClient;

    await reconcile(db, quietEngine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });

    const [gotJob] = await db
      .select({ status: simJobs.status, engineState: simJobs.engineState })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    const [gotResult] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, row.id));
    expect(engineCancels).toEqual([]);
    expect(gotJob.status).toBe("running");
    expect(gotJob.engineState).toBe("running");
    expect(gotResult.status).toBe("running");
    expect(gotResult.simJobId).toBe(job.id);
    await db.delete(results).where(eq(results.id, row.id));
  }, 60000);

  // MUST-CATCH (incident 2026-07-04, empty-error class): a genuinely failed
  // engine job (total failure — the engine writes a failed result with a
  // message and NO polars, exactly tasks.py's exception path) must stamp the
  // job-level failure message onto EVERY failed evidence row. Before the fix,
  // failJob flipped rows to status='failed' without touching results.error,
  // so the failures endpoint bucketed them errorClass='unknown' with no error
  // text anywhere.
  it("stamps the engine failure message onto failed rows (genuine failure, no partial result)", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const MSG = "MeshError: blockMesh exited 1 (boundary layer collapse)";
    const aoas = [131.101, 132.101, 133.101];
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, aoas),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "running",
        engineJobId: "genuine-total-failure",
        submittedAt: new Date(Date.now() - 10 * 60 * 1000),
        totalCases: aoas.length,
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const rowIds: string[] = [];
    for (const aoa of aoas) {
      const [row] = await db
        .insert(results)
        .values({
          airfoilId: a.id,
          bcId: bc.id,
          simulationPresetRevisionId: presetRevisionId,
          aoaDeg: aoa,
          status: "queued",
          source: "queued",
          simJobId: job.id,
        })
        .returning({ id: results.id });
      cleanupResultIds.add(row.id);
      rowIds.push(row.id);
    }

    const failedEngine = {
      getQueue: async () => emptyQueue(),
      getJob: async (): Promise<JobStatus> => ({
        job_id: "genuine-total-failure",
        state: "failed",
        total_cases: aoas.length,
        completed_cases: 0,
        message: MSG,
      }),
      // tasks.py exception path: JobResult(state=failed, message=..., polars=[]).
      getResult: async (): Promise<JobResult> => ({
        job_id: "genuine-total-failure",
        state: "failed",
        message: MSG,
        polars: [],
      }),
    } as unknown as EngineClient;

    await reconcile(db, failedEngine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });

    const rows = await db
      .select({
        status: results.status,
        error: results.error,
        autoRetriedAt: results.autoRetriedAt,
      })
      .from(results)
      .where(inArray(results.id, rowIds));
    expect(rows.length).toBe(aoas.length);
    for (const row of rows) {
      // Amendment B (auto-retry-once): a first crash requeues the cell — the
      // row returns to pending WITH the marker and the exact engine message
      // kept as crash evidence (never empty, never 'unknown'-classed).
      expect(row.status).toBe("pending");
      expect(row.autoRetriedAt).not.toBeNull();
      expect(row.error).toBe(MSG);
      expect((row.error ?? "").trim().length).toBeGreaterThan(0);
    }
    const [gotJob] = await db
      .select({ status: simJobs.status, error: simJobs.error })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(gotJob.status).toBe("failed");
    expect(gotJob.error).toBe(MSG);
    // FALSE-POSITIVE GUARD for the all-rejected escalation path (gate incident
    // 2026-07-07): a TRUE crash — empty payload, zero points AND zero shipped
    // attempts — must keep the original terminal behavior: no attempt-evidence
    // rows and no wave-2 URANS retry child materialize out of nothing.
    const crashAttempts = await db
      .select({ id: resultAttempts.id })
      .from(resultAttempts)
      .where(eq(resultAttempts.simJobId, job.id));
    expect(crashAttempts.length).toBe(0);
    const crashChildren = await db
      .select({ id: simJobs.id })
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, job.id), eq(simJobs.wave, 2)));
    expect(crashChildren.length).toBe(0);
    await db.delete(results).where(inArray(results.id, rowIds));
  }, 60000);

  // MUST-CATCH (incident 2026-07-04, propagation half): when a genuinely
  // failed job DOES ship a partial result, a failed point whose own p.error is
  // null (the engine recorded no per-case error) must inherit the job-level
  // failure message — the solved point still ingests as real evidence.
  it("propagates the job-level message to failed partial-result points with no per-point error", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const MSG = "SolverCrash: pimpleFoam terminated by signal 9";
    const solvedAoa = 134.101;
    const erroredAoa = 135.101;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          inArray(results.aoaDeg, [solvedAoa, erroredAoa]),
        ),
      );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        // wave 2: a failed URANS retry is the realistic partial-failure shape
        // AND keeps this test off the wave-2 composer (bounded retry chain).
        wave: 2,
        status: "running",
        engineJobId: "genuine-partial-failure",
        submittedAt: new Date(Date.now() - 10 * 60 * 1000),
        totalCases: 2,
        requestPayload: {
          speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId }],
        },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const rowIds: string[] = [];
    for (const aoa of [solvedAoa, erroredAoa]) {
      const [row] = await db
        .insert(results)
        .values({
          airfoilId: a.id,
          bcId: bc.id,
          simulationPresetRevisionId: presetRevisionId,
          aoaDeg: aoa,
          status: "running",
          source: "queued",
          simJobId: job.id,
        })
        .returning({ id: results.id });
      cleanupResultIds.add(row.id);
      rowIds.push(row.id);
    }

    const partialFailureResult: JobResult = {
      job_id: "genuine-partial-failure",
      state: "failed",
      message: MSG,
      polars: [
        {
          speed: bc.speedMps,
          chord: 1,
          reynolds: 500000,
          points: [
            {
              case_slug: "genuine-partial-solved",
              aoa_deg: solvedAoa,
              cl: 0.42,
              cd: 0.021,
              cm: -0.03,
              cl_cd: 20,
              // Valid oscillating-steady evidence. The terminal failed-job
              // context belongs to the crashed sibling, not this mean-stable
              // attempt; converged=false is deliberately waived by the exact
              // steady_history verdict.
              unsteady: false,
              converged: false,
              first_order_fallback: false,
              fidelity: "rans",
              images: {},
              steady_history: {
                iterations: [100, 200, 300, 400, 500, 600],
                cl: [0.4, 0.44, 0.41, 0.43, 0.415, 0.425],
                cd: [0.02, 0.022, 0.021, 0.021, 0.0205, 0.0215],
                cm: [-0.03, -0.029, -0.031, -0.03, -0.0305, -0.0295],
                window: { start_iter: 300, end_iter: 600 },
                mean_stable: true,
                note: "bounded oscillation with stable half-window means",
              },
            },
            // The worker died before this case wrote coefficients or an error:
            // p.error is null — exactly the shape that used to ingest as a
            // failed row with EMPTY error text.
            {
              aoa_deg: erroredAoa,
              cl: null,
              cd: null,
              cm: null,
              unsteady: true,
              converged: false,
              first_order_fallback: false,
              images: {},
              error: null,
            },
          ],
        },
      ],
    };
    const partialFailureEngine = {
      getQueue: async () => emptyQueue(),
      getJob: async (): Promise<JobStatus> => ({
        job_id: "genuine-partial-failure",
        state: "failed",
        total_cases: 2,
        completed_cases: 1,
        message: MSG,
      }),
      getResult: async () => withExactManifestEvidence(partialFailureResult),
    } as unknown as EngineClient;

    await reconcile(db, partialFailureEngine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });

    const [solvedRow] = await db
      .select({
        status: results.status,
        cl: results.cl,
        error: results.error,
        currentAttemptId: results.currentResultAttemptId,
      })
      .from(results)
      .where(eq(results.id, rowIds[0]));
    expect(solvedRow.status).toBe("done"); // real partial evidence survives the failure
    expect(solvedRow.cl).toBeCloseTo(0.42, 8);
    expect(solvedRow.error).toBeNull();
    expect(solvedRow.currentAttemptId).toBeTruthy();
    const [meanStableAttempt] = await db
      .select({
        error: resultAttempts.error,
        state: resultClassifications.state,
        reasons: resultClassifications.reasons,
      })
      .from(resultAttempts)
      .innerJoin(
        resultClassifications,
        eq(resultClassifications.resultAttemptId, resultAttempts.id),
      )
      .where(eq(resultAttempts.id, solvedRow.currentAttemptId!));
    expect(meanStableAttempt).toMatchObject({
      error: null,
      state: "accepted",
      reasons: [],
    });
    const [failedRow] = await db
      .select({
        status: results.status,
        error: results.error,
        autoRetriedAt: results.autoRetriedAt,
      })
      .from(results)
      .where(eq(results.id, rowIds[1]));
    // Amendment B: the crashed point requeues once — pending with the marker;
    // the propagated job-level message stays on the row (never empty).
    expect(failedRow.status).toBe("pending");
    expect(failedRow.autoRetriedAt).not.toBeNull();
    expect(failedRow.error).toBe(MSG); // job-level message propagated — never empty
    const [gotJob] = await db
      .select({ status: simJobs.status, error: simJobs.error })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(gotJob.status).toBe("failed");
    expect(gotJob.error).toBe(MSG);
    await db.delete(results).where(inArray(results.id, rowIds));
  }, 60000);

  // MUST-CATCH (gate incident 2026-07-07, prod job a2379532 / campaign
  // a1802299): the ladder engine fails a job whose ONLY steady rejected
  // (state=failed, "All cases failed" on the STATUS, result.message null,
  // points: []) while polars[].attempts ships the REAL solver evidence
  // (forces, iterations, steady_history, evidence manifest). Before the fix:
  // zero result_attempts ingested, results.error stamped with the generic
  // "engine job failed" (the runtime-probe dispatch's fallback), and
  // ingestFailedEngineJob returned BEFORE submitUransRetryForJob — a
  // fully-rejected campaign job could never escalate to URANS. Pinned here:
  // attempts + evidence + steady_history ingested, the engine's real message
  // stamped, the wave-2 precalc retry enqueued, and both transitions loud.
  it("ingests shipped attempt evidence and enqueues the URANS retry when a failed job ships zero points", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const REAL_MSG = "All cases failed";
    const aoa = 150.201;
    await db
      .delete(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, presetRevisionId),
          eq(results.aoaDeg, aoa),
        ),
      );
    const [parent] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "running",
        engineJobId: "all-rejected-failfast",
        submittedAt: new Date(Date.now() - 5 * 60 * 1000),
        totalCases: 1,
        requestPayload: {
          speedMap: [
            {
              speed: bc.speedMps,
              bcId: bc.id,
              presetRevisionId,
              mach: bc.mach,
            },
          ],
          aoas: [aoa],
        },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(parent.id);
    const [row] = await db
      .insert(results)
      .values({
        airfoilId: a.id,
        bcId: bc.id,
        simulationPresetRevisionId: presetRevisionId,
        aoaDeg: aoa,
        status: "queued",
        source: "queued",
        simJobId: parent.id,
      })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    // The honest rejection evidence the engine recorded (600 steady samples in
    // prod; 6 here — same pinned steady_history shape).
    const steadyHistory = {
      iterations: [100, 200, 300, 400, 500, 600],
      cl: [0.31, 0.62, 0.44, 0.71, 0.39, 0.66],
      cd: [0.09, 0.12, 0.1, 0.11, 0.1, 0.1],
      cm: [-0.03, -0.05, -0.04, -0.04, -0.04, -0.04],
      window: { start_iter: 300, end_iter: 600 },
      mean_stable: false,
      note: "Cl half-window means differ by 29.8%",
    };
    const failedResult: JobResult = {
      job_id: "all-rejected-failfast",
      state: "failed",
      // The engine's run_polar_job writes NO result.message (the real message
      // lives on the STATUS) — the exact prod shape that lost "All cases
      // failed" to the generic runtime-dispatch fallback.
      message: null,
      polars: [
        {
          speed: bc.speedMps,
          chord: bc.referenceChordM,
          reynolds: bc.reynolds,
          mach: bc.mach,
          points: [],
          attempts: [
            {
              case_slug: "aoa_150p201",
              aoa_deg: aoa,
              cl: 0.5174,
              cd: 0.1032,
              cm: -0.0412,
              cl_cd: 5.01,
              unsteady: false,
              converged: false,
              iterations: 600,
              first_order_fallback: false,
              images: {},
              failure_disposition: "hard_solver",
              steady_history: steadyHistory,
              evidence_artifacts: [
                {
                  kind: "manifest",
                  path: "/jobs/all-rejected-failfast/files/evidence/aoa_150p201/evidence_manifest.json",
                  url: "/jobs/all-rejected-failfast/files/evidence/aoa_150p201/evidence_manifest.json",
                  mime_type: "application/json",
                  sha256: "sha-all-rejected-manifest",
                  byte_size: 64,
                  metadata: { evidenceBase: "/tmp/evidence/aoa_150p201" },
                },
              ],
            },
          ],
        },
      ],
    };
    let submittedRequest: unknown = null;
    const failFastEngine = {
      baseUrl: "http://engine.test",
      getQueue: async () => emptyQueue(),
      // Runtime-probe dispatch (the prod path): result readable + failed, but
      // result_message is NULL — the real message only on status_message.
      getJobRuntimes: async () => ({
        jobs: [
          {
            job_id: "all-rejected-failfast",
            exists: true,
            cancelled: false,
            process_count: 0,
            active_pids: [],
            status_readable: true,
            status_error: null,
            status_state: "failed",
            status_message: REAL_MSG,
            status_total_cases: 1,
            status_completed_cases: 0,
            result_readable: true,
            result_error: null,
            has_result: true,
            result_state: "failed",
            result_message: null,
          },
        ],
      }),
      getResult: async () => withExactManifestEvidence(failedResult),
      submitPolar: async (request: unknown): Promise<JobStatus> => {
        submittedRequest = request;
        const angles =
          (request as { aoa?: { angles?: number[] } }).aoa?.angles ?? [];
        return {
          job_id: "all-rejected-urans-child",
          state: "pending",
          total_cases: angles.length,
          completed_cases: 0,
        };
      },
      fileUrl: (jobId: string, relPath: string) =>
        `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    const errorSpy = vi.spyOn(console, "error");
    const logSpy = vi.spyOn(console, "log");
    try {
      await reconcile(db, failFastEngine, {
        jobIds: [parent.id],
        skipFailedRecovery: true,
      });

      // 1. The shipped attempt ingested with its REAL force data + steady_history.
      const attempts = await db
        .select()
        .from(resultAttempts)
        .where(
          and(
            eq(resultAttempts.simJobId, parent.id),
            eq(resultAttempts.aoaDeg, aoa),
          ),
        );
      attempts.forEach((attempt) => cleanupAttemptIds.add(attempt.id));
      expect(attempts.length).toBe(1);
      expect(attempts[0].cl).toBeCloseTo(0.5174, 8);
      expect(attempts[0].cd).toBeCloseTo(0.1032, 8);
      expect(attempts[0].iterations).toBe(600);
      expect(attempts[0].converged).toBe(false);
      expect(attempts[0].validForPolar).toBe(false);
      expect(
        (attempts[0].evidencePayload as { steady_history?: { note?: string } })
          ?.steady_history?.note,
      ).toBe("Cl half-window means differ by 29.8%");
      // 2. Evidence artifacts registered against the attempt.
      const evidence = await db
        .select()
        .from(solverEvidenceArtifacts)
        .where(
          and(
            eq(solverEvidenceArtifacts.simJobId, parent.id),
            eq(solverEvidenceArtifacts.aoaDeg, aoa),
          ),
        );
      expect(evidence.length).toBe(1);
      expect(evidence[0].kind).toBe("manifest");
      expect(evidence[0].resultAttemptId).toBe(attempts[0].id);
      // 3. The ENGINE's real message stamped — never the generic fallback.
      const [gotRow] = await db
        .select({
          status: results.status,
          error: results.error,
          simJobId: results.simJobId,
        })
        .from(results)
        .where(eq(results.id, row.id));
      expect(gotRow.error).toBe(REAL_MSG);
      // 4. Parent terminal-failed WITH the evidence-ingest stamp (the gated
      //    ladder rescan requires status='failed' AND ingested_at NOT NULL).
      const [gotParent] = await db
        .select({
          status: simJobs.status,
          error: simJobs.error,
          engineState: simJobs.engineState,
          ingestedAt: simJobs.ingestedAt,
        })
        .from(simJobs)
        .where(eq(simJobs.id, parent.id));
      expect(gotParent.status).toBe("failed");
      expect(gotParent.error).toBe(REAL_MSG);
      expect(gotParent.engineState).toBe("failed");
      expect(gotParent.ingestedAt).not.toBeNull();
      // 5. The gated wave-2 PRECALC retry enqueued for the hard-rejected angle
      //    (before the fix: unreachable — points===0 returned first).
      const [child] = await db
        .select()
        .from(simJobs)
        .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)))
        .limit(1);
      expect(child).toBeTruthy();
      cleanupJobIds.add(child.id);
      expect(child.status).toBe("submitted");
      expect(child.totalCases).toBe(1);
      expect(
        (child.requestPayload as { uransFidelity?: string })?.uransFidelity,
      ).toBe("precalc");
      expect(
        (submittedRequest as { solver?: { force_transient?: boolean } })?.solver
          ?.force_transient,
      ).toBe(true);
      expect(
        (submittedRequest as { aoa?: { angles?: number[] } })?.aoa?.angles,
      ).toEqual([aoa]);
      await expectBackgroundPrecalcSubmission(child, [aoa]);
      // The rejected wave-1 generation remains attached to its producing
      // job as immutable failure evidence. The exact PRECALC obligation owns
      // the retry independently and must not rewrite this row into a gap.
      expect(gotRow.status).toBe("failed");
      expect(gotRow.simJobId).toBe(parent.id);
      // 6. Loud transitions: one job-failed event with the real message +
      //    verdict, one retry-submit event (the gate run logged NOTHING).
      const failLine = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("engine job FAILED"));
      expect(failLine).toBeTruthy();
      expect(failLine).toContain(REAL_MSG);
      expect(failLine).toContain(parent.id);
      expect(failLine).toContain("gated URANS retry evaluated");
      const submitLine = logSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("URANS retry submitted"));
      expect(submitLine).toBeTruthy();
      expect(submitLine).toContain("all-rejected-urans-child");
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  }, 120000);
});
