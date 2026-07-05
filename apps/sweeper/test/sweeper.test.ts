import {
  airfoils,
  boundaryProfiles,
  boundaryConditions,
  createClient,
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
  mediums,
  resultMedia,
  results,
  schedulingProfiles,
  simJobs,
  simulationPresetAirfoilTargets,
  simulationPresets,
  solverProfiles,
  syncSweepPromises,
  syncSweepPromisePoints,
  sweeperState,
  sweepDefinitions,
} from "@aerodb/db";
import { EngineClient, EngineError, type EngineQueueState, type JobResult, type JobStatus } from "@aerodb/engine-client";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPolarRequest } from "../src/build-request";
import { claimAoas } from "../src/claim";
import { findGaps, firstBatch } from "../src/gaps";
import { touchHeartbeat } from "../src/heartbeat";
import { ingestResult } from "../src/ingest";
import { reconcile, resetOrphans } from "../src/reconcile";

const { db, sql } = createClient({ max: 2 });
const engine = new EngineClient("http://engine.test");
const testRunSlug = `sweeper-test-${process.pid}-${Date.now()}`;

let airfoilId = "";
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
let restoreSweeperEnabled: boolean | null = null;

function emptyQueue(jobIds: string[] = []): EngineQueueState {
  return {
    queue_depth: 0,
    active: jobIds.map((job_id) => ({ worker: "test", task_id: `task-${job_id}`, name: "airfoilfoam.run_polar", job_id, redelivered: false })),
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

async function firstAirfoilBc() {
  const [a] = airfoilId ? await db.select().from(airfoils).where(eq(airfoils.id, airfoilId)).limit(1) : await db.select().from(airfoils).limit(1);
  const [bc] = await db.select().from(boundaryConditions).where(eq(boundaryConditions.id, testBcId())).limit(1);
  if (!a || !bc) throw new Error("seeded airfoil and boundary condition required");
  return { a, bc, presetId: testPresetId, presetRevisionId: testPresetRevisionId };
}

function testBcId(): string {
  if (!bcId) throw new Error("test boundary condition not initialized");
  return bcId;
}

async function testGaps(limit = 10000) {
  return (await findGaps(db, limit)).filter((gap) => gap.presetRevisionId === testPresetRevisionId);
}

async function testBatch(limit = 500) {
  return firstBatch(await testGaps(limit));
}

async function ensureTestSetup() {
  const [medium] = await db.select().from(mediums).where(eq(mediums.slug, "air")).limit(1);
  if (!medium) throw new Error("seeded air medium required");
  const [targetAirfoil] = await db.select({ id: airfoils.id }).from(airfoils).limit(1);
  if (!targetAirfoil) throw new Error("seeded airfoil required");
  airfoilId = targetAirfoil.id;
  const reynolds = 500_000;
  const chord = 1;
  const speed = reynolds * medium.kinematicViscosity / chord;
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
  const [boundary] = await db.insert(boundaryProfiles).values({ slug: `${testRunSlug}-boundary`, name: `${testRunSlug} boundary` }).returning();
  const [mesh] = await db.insert(meshProfiles).values({ slug: `${testRunSlug}-mesh`, name: `${testRunSlug} mesh` }).returning();
  const [solver] = await db.insert(solverProfiles).values({ slug: `${testRunSlug}-solver`, name: `${testRunSlug} solver` }).returning();
  const [scheduling] = await db.insert(schedulingProfiles).values({ slug: `${testRunSlug}-scheduling`, name: `${testRunSlug} scheduling` }).returning();
  const [output] = await db.insert(outputProfiles).values({ slug: `${testRunSlug}-output`, name: `${testRunSlug} output` }).returning();
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({ slug: `${testRunSlug}-sweep`, name: `${testRunSlug} sweep`, aoaList: [81.001, 82.001, 83.001, 91.001, 92.001, 93.001] })
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
  await db.insert(simulationPresetAirfoilTargets).values({ presetId: preset.id, airfoilId });
  testPresetId = preset.id;
  const resolved = await ensureSimulationPresetRevision(db, preset.id);
  if (!resolved) throw new Error("test setup revision required");
  testPresetRevisionId = resolved.revision.id;
}

beforeAll(async () => {
  const [state] = await db.select({ enabled: sweeperState.enabled }).from(sweeperState).where(eq(sweeperState.id, 1)).limit(1);
  restoreSweeperEnabled = state?.enabled ?? false;
  await db
    .insert(sweeperState)
    .values({ id: 1, enabled: false })
    .onConflictDoUpdate({ target: sweeperState.id, set: { enabled: false } });
  await ensureTestSetup();
});

afterAll(async () => {
  if (cleanupSyncPromiseIds.size) await db.delete(syncSweepPromises).where(inArray(syncSweepPromises.id, Array.from(cleanupSyncPromiseIds)));
  if (testPresetRevisionId) {
    await db.delete(polarFitSets).where(eq(polarFitSets.simulationPresetRevisionId, testPresetRevisionId));
    await db.delete(resultClassifications).where(eq(resultClassifications.simulationPresetRevisionId, testPresetRevisionId));
    await db.delete(resultAttempts).where(eq(resultAttempts.simulationPresetRevisionId, testPresetRevisionId));
    await db.delete(results).where(eq(results.simulationPresetRevisionId, testPresetRevisionId));
    await db.delete(simJobs).where(eq(simJobs.simulationPresetRevisionId, testPresetRevisionId));
  }
  if (cleanupAttemptIds.size) await db.delete(resultAttempts).where(inArray(resultAttempts.id, Array.from(cleanupAttemptIds)));
  if (cleanupResultIds.size) await db.delete(results).where(inArray(results.id, Array.from(cleanupResultIds)));
  if (cleanupJobIds.size) await db.delete(simJobs).where(inArray(simJobs.id, Array.from(cleanupJobIds)));
  if (cleanupPresetIds.size) await db.delete(simulationPresets).where(inArray(simulationPresets.id, Array.from(cleanupPresetIds)));
  if (cleanupLegacyBcIds.size) await db.delete(boundaryConditions).where(inArray(boundaryConditions.id, Array.from(cleanupLegacyBcIds)));
  if (cleanupFlowIds.size) await db.delete(flowConditions).where(inArray(flowConditions.id, Array.from(cleanupFlowIds)));
  if (cleanupReferenceGeometryIds.size) await db.delete(referenceGeometryProfiles).where(inArray(referenceGeometryProfiles.id, Array.from(cleanupReferenceGeometryIds)));
  if (cleanupBoundaryProfileIds.size) await db.delete(boundaryProfiles).where(inArray(boundaryProfiles.id, Array.from(cleanupBoundaryProfileIds)));
  if (cleanupMeshProfileIds.size) await db.delete(meshProfiles).where(inArray(meshProfiles.id, Array.from(cleanupMeshProfileIds)));
  if (cleanupSolverProfileIds.size) await db.delete(solverProfiles).where(inArray(solverProfiles.id, Array.from(cleanupSolverProfileIds)));
  if (cleanupSchedulingProfileIds.size) await db.delete(schedulingProfiles).where(inArray(schedulingProfiles.id, Array.from(cleanupSchedulingProfileIds)));
  if (cleanupOutputProfileIds.size) await db.delete(outputProfiles).where(inArray(outputProfiles.id, Array.from(cleanupOutputProfileIds)));
  if (cleanupSweepIds.size) await db.delete(sweepDefinitions).where(inArray(sweepDefinitions.id, Array.from(cleanupSweepIds)));
  if (restoreSweeperEnabled !== null) {
    await db
      .insert(sweeperState)
      .values({ id: 1, enabled: restoreSweeperEnabled })
      .onConflictDoUpdate({ target: sweeperState.id, set: { enabled: restoreSweeperEnabled } });
  }
  await sql.end();
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
    const [target, excluded] = await db.select({ id: airfoils.id }).from(airfoils).limit(2);
    expect(target?.id).toBeTruthy();
    expect(excluded?.id).toBeTruthy();
    await db.delete(results).where(and(eq(results.airfoilId, target.id), eq(results.simulationPresetRevisionId, testPresetRevisionId)));
    await db.delete(simulationPresetAirfoilTargets).where(eq(simulationPresetAirfoilTargets.presetId, testPresetId));
    await db.update(simulationPresets).set({ targetScope: "airfoils" }).where(eq(simulationPresets.id, testPresetId));
    await db.insert(simulationPresetAirfoilTargets).values({ presetId: testPresetId, airfoilId: target.id });
    try {
      const gaps = await testGaps(10000);
      expect(gaps.length).toBeGreaterThan(0);
      expect(new Set(gaps.map((gap) => gap.airfoilId))).toEqual(new Set([target.id]));
      expect(gaps.some((gap) => gap.airfoilId === excluded.id)).toBe(false);
    } finally {
      await db.delete(simulationPresetAirfoilTargets).where(eq(simulationPresetAirfoilTargets.presetId, testPresetId));
      await db.insert(simulationPresetAirfoilTargets).values({ presetId: testPresetId, airfoilId });
      await db.update(simulationPresets).set({ targetScope: "airfoils" }).where(eq(simulationPresets.id, testPresetId));
    }
  }, 60000);

  it("excludes active external sync promises and releases them after expiry", async () => {
    const gaps = await testGaps(10000);
    expect(gaps.length).toBeGreaterThan(1);
    const first = gaps[0];
    const promised = gaps
      .filter((gap) => gap.airfoilId === first.airfoilId && gap.presetRevisionId === first.presetRevisionId)
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
      expect(hidden.some((candidate) => candidate.airfoilId === gap.airfoilId && candidate.presetRevisionId === gap.presetRevisionId && candidate.aoaDeg === gap.aoaDeg)).toBe(false);
    }

    await db.update(syncSweepPromises).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(syncSweepPromises.id, promise.id));
    const released = await testGaps(10000);
    for (const gap of promised) {
      expect(released.some((candidate) => candidate.airfoilId === gap.airfoilId && candidate.presetRevisionId === gap.presetRevisionId && candidate.aoaDeg === gap.aoaDeg)).toBe(true);
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
      .where(and(eq(results.airfoilId, batch!.airfoilId), eq(results.simulationPresetRevisionId, batch!.presetRevisionId), inArray(results.aoaDeg, some)));
    const first = await claimAoas(db, batch!.airfoilId, batch!.bcId, batch!.presetRevisionId, some, job.id);
    expect(first.length).toBe(3);
    const claimedRows = await db
      .select({ id: results.id, source: results.source, status: results.status })
      .from(results)
      .where(and(eq(results.airfoilId, batch!.airfoilId), eq(results.simulationPresetRevisionId, batch!.presetRevisionId), inArray(results.aoaDeg, some)));
    claimedRows.forEach((r) => cleanupResultIds.add(r.id));
    expect(claimedRows.every((r) => r.source === "queued" && r.status === "queued")).toBe(true);
    const again = await claimAoas(db, batch!.airfoilId, batch!.bcId, batch!.presetRevisionId, some, job.id);
    expect(again.length).toBe(0);
    await db
      .delete(results)
      .where(and(eq(results.airfoilId, batch!.airfoilId), eq(results.simulationPresetRevisionId, batch!.presetRevisionId), inArray(results.aoaDeg, some)));
  }, 60000);

  it("ingests a JobResult idempotently and registers media", async () => {
    const batch = (await testBatch(500))!;
    const [a] = await db.select().from(airfoils).where(eq(airfoils.id, batch.airfoilId)).limit(1);
    const [bc] = await db.select().from(boundaryConditions).where(eq(boundaryConditions.id, batch.bcId)).limit(1);
    const setup = await ensureSimulationPresetRevision(db, batch.presetId);
    airfoilId = a.id;
    bcId = bc.id;
    if (!setup) throw new Error("simulation preset revision required");
    const steadyAoa = 81.001;
    const uransAoa = 82.001;
    await db
      .delete(results)
      .where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, batch.presetRevisionId), inArray(results.aoaDeg, [steadyAoa, uransAoa])));

    const { request, speed } = buildPolarRequest({ airfoil: a, setup: setup.snapshot, aoaList: [steadyAoa, uransAoa], wave: 1 });
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
        status: "ingesting",
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
    const mediaEngine = {
      baseUrl: "http://engine.test",
      computeFieldExtents: async (_jobId: string, request: { case_slug: string }) => ({
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
      }),
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
          images: fields.map((field) => ({
            kind: "image" as const,
            field,
            role: "instantaneous" as const,
            path: `${base}/${field}.png`,
            url: `${base}/${field}.png`,
            mime_type: "image/png",
            sha256: `media-${request.case_slug}-${field}-instant-v${version}`,
            byte_size: 256,
          })),
          mean_images: request.unsteady
            ? fields.map((field) => ({
                kind: "image" as const,
                field,
                role: "mean" as const,
                path: `${base}/${field}_mean.png`,
                url: `${base}/${field}_mean.png`,
                mime_type: "image/png",
                sha256: `media-${request.case_slug}-${field}-mean-v${version}`,
                byte_size: 256,
              }))
            : [],
          videos: request.unsteady
            ? fields.map((field) => ({
                kind: "video" as const,
                field,
                role: "instantaneous" as const,
                path: `${base}/${field}.mp4`,
                url: `${base}/${field}.mp4`,
                mime_type: "video/mp4",
                sha256: `media-${request.case_slug}-${field}-video-v${version}`,
                byte_size: 1024,
              }))
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
                velocity_magnitude: "/jobs/testjob/files/cases/c1/images/velocity_magnitude.png",
                pressure: "/jobs/testjob/files/cases/c1/images/pressure.png",
              },
              evidence_artifacts: [manifestArtifact("c1")],
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
              converged: false,
              first_order_fallback: false,
              images: { velocity_magnitude: "/jobs/testjob/files/cases/c2/images/velocity_magnitude.png" },
              evidence_artifacts: [manifestArtifact("c2")],
              strouhal: 0.21,
              mean_images: { velocity_magnitude: "/jobs/testjob/files/cases/c2/images/velocity_magnitude_mean.png" },
              video: { velocity_magnitude: "/jobs/testjob/files/cases/c2/images/velocity_magnitude.mp4" },
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
      speedMap: [{ speed, bcId: bc.id, presetRevisionId: batch.presetRevisionId }],
      result,
    });
    expect(r1.points).toBe(2);
    // Engine-shipped media register at ingest (steady: 2 images; URANS: 1
    // image + 1 mean + 1 video = 5) and the scaled-render pass upserts the
    // same 5 (result, kind, field, role) tuples with scale info = 10 writes.
    expect(r1.media).toBe(10);

    const rows = await db
      .select()
      .from(results)
      .where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, batch.presetRevisionId), inArray(results.aoaDeg, [steadyAoa, uransAoa])));
    rows.forEach((r) => cleanupResultIds.add(r.id));
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.source === "solved" && r.status === "done")).toBe(true);
    expect(rows.find((r) => r.aoaDeg === uransAoa)?.regime).toBe("urans");
    expect(rows.find((r) => r.aoaDeg === uransAoa)?.stalled).toBe(true);
    expect(rows.find((r) => r.aoaDeg === steadyAoa)?.regime).toBe("rans");
    const attempts = await db
      .select()
      .from(resultAttempts)
      .where(and(eq(resultAttempts.simJobId, job.id), inArray(resultAttempts.aoaDeg, [steadyAoa, uransAoa])));
    expect(attempts.length).toBe(3);
    expect(attempts.filter((a) => a.validForPolar).length).toBe(2);
    expect(attempts.some((a) => a.regime === "rans" && a.validForPolar === false)).toBe(true);

    const r0 = rows.find((r) => r.aoaDeg === steadyAoa)!;
    const media = await db.select().from(resultMedia).where(eq(resultMedia.resultId, r0.id));
    expect(media.length).toBe(2);
    expect(media.every((mm) => mm.storageKey.startsWith("jobs/testjob/"))).toBe(true);
    expect(media.every((mm) => mm.colorScaleVersion === 1)).toBe(true);
    expect(media.find((mm) => mm.field === "velocity_magnitude")?.scaleVmax).toBeCloseTo(55, 8);
    expect(media.find((mm) => mm.field === "pressure")?.scaleVmin).toBeCloseTo(-4, 8);

    // URANS point: Strouhal + animation video + time-averaged image + force history
    const r16 = rows.find((r) => r.aoaDeg === uransAoa)!;
    expect(r16.strouhal).toBeCloseTo(0.21, 5);
    const m16 = await db.select().from(resultMedia).where(eq(resultMedia.resultId, r16.id));
    expect(m16.some((mm) => mm.kind === "video" && mm.role === "instantaneous")).toBe(true);
    expect(m16.some((mm) => mm.kind === "image" && mm.role === "mean")).toBe(true);
    expect(m16.every((mm) => mm.field === "velocity_magnitude" && mm.scaleVmax === 55)).toBe(true);
    const fh = await db.select().from(forceHistory).where(eq(forceHistory.resultId, r16.id));
    expect(fh.length).toBe(1);
    expect(fh[0].cl.length).toBe(4);
    expect(fh[0].strouhal).toBeCloseTo(0.21, 5);
    const extents = await db
      .select()
      .from(resultFieldExtents)
      .where(and(eq(resultFieldExtents.airfoilId, a.id), eq(resultFieldExtents.simulationPresetRevisionId, batch.presetRevisionId)));
    expect(extents.length).toBeGreaterThanOrEqual(3);
    const scales = await db
      .select()
      .from(fieldColorScales)
      .where(and(eq(fieldColorScales.airfoilId, a.id), eq(fieldColorScales.simulationPresetRevisionId, batch.presetRevisionId), eq(fieldColorScales.active, true)));
    expect(scales.find((scale) => scale.field === "velocity_magnitude")?.vmax).toBeCloseTo(55, 8);
    expect(scales.find((scale) => scale.field === "pressure")?.vmin).toBeCloseTo(-4, 8);

    // idempotent: re-ingest produces no duplicates
    await ingestResult({
      db,
      engine: mediaEngine,
      engineJobId: "testjob",
      simJobId: job.id,
      airfoilId: a.id,
      speedMap: [{ speed, bcId: bc.id, presetRevisionId: batch.presetRevisionId }],
      result,
    });
    const rowsAfter = await db
      .select()
      .from(results)
      .where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, batch.presetRevisionId), inArray(results.aoaDeg, [steadyAoa, uransAoa])));
    expect(rowsAfter.length).toBe(2);
    const mediaAfter = await db.select().from(resultMedia).where(eq(resultMedia.resultId, r0.id));
    expect(mediaAfter.length).toBe(2);
    const attemptsAfter = await db
      .select()
      .from(resultAttempts)
      .where(and(eq(resultAttempts.simJobId, job.id), inArray(resultAttempts.aoaDeg, [steadyAoa, uransAoa])));
    expect(attemptsAfter.length).toBe(3);
  }, 60000);

  // MUST-CATCH (prod "missing-urans-video" regression): engine-shipped media
  // must land in result_media at ingest even when the scaled-render chain
  // (extents + render) fails — previously those failures were swallowed and
  // NO video row ever registered, so every URANS point stayed rejected.
  it("registers engine-shipped URANS media even when the scaled-render chain fails", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 83.001;
    await db.delete(results).where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), eq(results.aoaDeg, aoa)));
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 2,
        status: "ingesting",
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
              images: { velocity_magnitude: "/jobs/shipped-media-job/files/cases/cs1/images/velocity_magnitude.png" },
              mean_images: { velocity_magnitude: "/jobs/shipped-media-job/files/cases/cs1/images/velocity_magnitude_mean.png" },
              video: { velocity_magnitude: "/jobs/shipped-media-job/files/cases/cs1/images/velocity_magnitude.mp4" },
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
      result,
    });
    expect(r.points).toBe(1);
    expect(r.media).toBe(3); // shipped image + mean image + video, no scaled renders

    const [row] = await db
      .select()
      .from(results)
      .where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), eq(results.aoaDeg, aoa)));
    cleanupResultIds.add(row.id);
    const media = await db.select().from(resultMedia).where(eq(resultMedia.resultId, row.id));
    expect(media.length).toBe(3);
    const video = media.find((m) => m.kind === "video" && m.role === "instantaneous");
    expect(video?.storageKey).toBe("jobs/shipped-media-job/cases/cs1/images/velocity_magnitude.mp4");
    expect(video?.mimeType).toBe("video/mp4");
    expect(media.some((m) => m.kind === "image" && m.role === "mean")).toBe(true);

    // End-to-end D3 unlock: the ingest-shaped URANS row (stalled=true because
    // unsteady, converged, with force history + video) classifies ACCEPTED.
    await refreshPolarCacheForRevision(db, a.id, presetRevisionId);
    const [rc] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, row.id));
    expect(rc?.state).toBe("accepted");

    // Idempotent re-ingest: still exactly 3 media rows.
    await ingestResult({
      db,
      engine: failingEngine,
      engineJobId: "shipped-media-job",
      simJobId: job.id,
      airfoilId: a.id,
      speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId }],
      result,
    });
    const mediaAfter = await db.select().from(resultMedia).where(eq(resultMedia.resultId, row.id));
    expect(mediaAfter.length).toBe(3);

    // MUST-CATCH (review F3): a wave-2 re-solve shipping NO video (video:{})
    // must not leave the wave-1 video row satisfying the classifier's
    // hasVideo gate for the NEW coefficients — ingest reconciles kind='video'
    // rows to the current shipment, and the classification honestly drops to
    // rejected missing-urans-video.
    const noVideoResult: JobResult = JSON.parse(JSON.stringify(result));
    noVideoResult.polars[0].points[0].video = {};
    await ingestResult({
      db,
      engine: failingEngine,
      engineJobId: "shipped-media-job",
      simJobId: job.id,
      airfoilId: a.id,
      speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId }],
      result: noVideoResult,
    });
    const mediaNoVideo = await db.select().from(resultMedia).where(eq(resultMedia.resultId, row.id));
    expect(mediaNoVideo.some((m) => m.kind === "video")).toBe(false); // stale wave-1 video row is GONE
    expect(mediaNoVideo.length).toBe(2); // shipped image + mean image survive
    await refreshPolarCacheForRevision(db, a.id, presetRevisionId);
    const [rcNoVideo] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, row.id));
    expect(rcNoVideo?.state).toBe("rejected");
    expect(rcNoVideo?.reasons).toContain("missing-urans-video");
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
      .where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, aoas)));
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: presetRevisionId,
        referenceChordM: bc.referenceChordM,
        wave: 1,
        status: "ingesting",
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
      .onConflictDoUpdate({ target: sweeperState.id, set: { heartbeatAt: before } });
    const observed: number[] = [];
    const r = await ingestResult({
      db,
      engine: slowEngine,
      engineJobId: "heartbeat-job",
      simJobId: job.id,
      airfoilId: a.id,
      speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId }],
      result,
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
      .where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, aoas)));
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

  it("promotes an unreliable RANS sweep to one whole-polar URANS retry", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoas = [130.01, 131.01, 132.01, 133.01, 134.01, 135.01];
    await db.delete(results).where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, aoas)));
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
        requestPayload: { speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId, mach: bc.mach }], aoas },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(parent.id);
    for (const aoa of aoas) {
      const [row] = await db
        .insert(results)
        .values({ airfoilId: a.id, bcId: bc.id, simulationPresetRevisionId: presetRevisionId, aoaDeg: aoa, status: "queued", source: "queued", simJobId: parent.id })
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
      getResult: async () => unreliableResult,
      submitPolar: async (request: unknown): Promise<JobStatus> => {
        submittedRequest = request;
        return { job_id: "whole-urans-child", state: "pending", total_cases: aoas.length, completed_cases: 0 };
      },
      fileUrl: (jobId: string, relPath: string) => `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, retryEngine, { jobIds: [parent.id], skipFailedRecovery: true });

    const [child] = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)))
      .limit(1);
    expect(child).toBeTruthy();
    cleanupJobIds.add(child.id);
    expect(child.totalCases).toBe(aoas.length);
    expect((child.requestPayload as { retryMode?: string })?.retryMode).toBe("whole-polar-urans");
    expect((submittedRequest as { solver?: { force_transient?: boolean }; aoa?: { angles?: number[] } })?.solver?.force_transient).toBe(true);
    expect((submittedRequest as { aoa?: { angles?: number[] } })?.aoa?.angles).toEqual(aoas);

    const claimed = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, aoas)));
    expect(claimed.every((r) => r.status === "queued" && r.simJobId === child.id)).toBe(true);
    const attempts = await db
      .select()
      .from(resultAttempts)
      .where(and(eq(resultAttempts.simJobId, parent.id), inArray(resultAttempts.aoaDeg, aoas)));
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
    await db.delete(results).where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, aoas)));
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
        requestPayload: { speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId, mach: bc.mach }], aoas },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(parent.id);
    for (const aoa of aoas) {
      const [row] = await db
        .insert(results)
        .values({ airfoilId: a.id, bcId: bc.id, simulationPresetRevisionId: presetRevisionId, aoaDeg: aoa, status: "queued", source: "queued", simJobId: parent.id })
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
      getResult: async () => completedResult,
      submitPolar: async (request: unknown): Promise<JobStatus> => {
        submittedRequest = request;
        return { job_id: "attempt-only-urans-child", state: "pending", total_cases: rejectedAoas.length, completed_cases: 0 };
      },
      fileUrl: (jobId: string, relPath: string) => `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, retryEngine, { jobIds: [parent.id], skipFailedRecovery: true });

    const [child] = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)))
      .limit(1);
    expect(child).toBeTruthy();
    cleanupJobIds.add(child.id);
    expect(child.totalCases).toBe(rejectedAoas.length);
    expect((child.requestPayload as { retryMode?: string })?.retryMode).toBe("invalid-rans-points");
    expect((submittedRequest as { solver?: { force_transient?: boolean }; aoa?: { angles?: number[] } })?.solver?.force_transient).toBe(true);
    expect((submittedRequest as { aoa?: { angles?: number[] } })?.aoa?.angles).toEqual(rejectedAoas);

    const claimed = await db
      .select({ aoaDeg: results.aoaDeg, status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, rejectedAoas)));
    expect(claimed.every((r) => r.status === "queued" && r.simJobId === child.id)).toBe(true);
    const attempts = await db
      .select({ id: resultAttempts.id, validForPolar: resultAttempts.validForPolar })
      .from(resultAttempts)
      .where(and(eq(resultAttempts.simJobId, parent.id), inArray(resultAttempts.aoaDeg, aoas)));
    attempts.forEach((attempt) => cleanupAttemptIds.add(attempt.id));
    expect(attempts.length).toBe(aoas.length);
    expect(attempts.filter((attempt) => !attempt.validForPolar).length).toBe(rejectedAoas.length);
  }, 60000);

  it("marks suspicious post-stall RANS rows needs_urans and keeps them visible until URANS arrives", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const ransAoas = Array.from({ length: 19 }, (_, i) => i + 0.021);
    const rejectedAoas = [19.021, 20.021];
    const allAoas = [...ransAoas, ...rejectedAoas];
    await db.delete(results).where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, allAoas)));
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
        requestPayload: { speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId, mach: bc.mach }], aoas: allAoas },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(parent.id);
    for (const aoa of allAoas) {
      const [row] = await db
        .insert(results)
        .values({ airfoilId: a.id, bcId: bc.id, simulationPresetRevisionId: presetRevisionId, aoaDeg: aoa, status: "queued", source: "queued", simJobId: parent.id })
        .returning({ id: results.id });
      cleanupResultIds.add(row.id);
    }

    let submittedRequest: unknown = null;
    const clCdByAoa = new Map(
      [
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
      ] as [number, [number, number]][],
    );
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
      getResult: async () => completedResult,
      submitPolar: async (request: unknown): Promise<JobStatus> => {
        submittedRequest = request;
        return { job_id: "ag24-like-urans-child", state: "pending", total_cases: 7, completed_cases: 0 };
      },
      fileUrl: (jobId: string, relPath: string) => `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, retryEngine, { jobIds: [parent.id], skipFailedRecovery: true });

    const [child] = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)))
      .limit(1);
    expect(child).toBeTruthy();
    cleanupJobIds.add(child.id);
    expect(child.totalCases).toBe(7);
    expect((child.requestPayload as { retryMode?: string })?.retryMode).toBe("needs-urans-confirmation");
    expect((submittedRequest as { aoa?: { angles?: number[] } })?.aoa?.angles).toEqual([14.021, 15.021, 16.021, 17.021, 18.021, 19.021, 20.021]);

    const classified = await db
      .select({ aoaDeg: resultClassifications.aoaDeg, state: resultClassifications.state })
      .from(resultClassifications)
      .where(
        and(
          eq(resultClassifications.simulationPresetRevisionId, presetRevisionId),
          isNotNull(resultClassifications.resultId),
          inArray(resultClassifications.aoaDeg, [14.021, 15.021, 16.021, 17.021, 18.021]),
        ),
      );
    expect(classified.map((row) => row.state).sort()).toEqual(["needs_urans", "needs_urans", "needs_urans", "needs_urans", "needs_urans"]);

    const provisionalRows = await db
      .select({ aoaDeg: results.aoaDeg, status: results.status, source: results.source, simJobId: results.simJobId })
      .from(results)
      .where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, [14.021, 15.021, 16.021, 17.021, 18.021])));
    expect(provisionalRows.every((row) => row.status === "done" && row.source === "solved" && row.simJobId === parent.id)).toBe(true);

    const claimedHardRejected = await db
      .select({ aoaDeg: results.aoaDeg, simJobId: results.simJobId })
      .from(results)
      .where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, rejectedAoas)));
    expect(claimedHardRejected.every((row) => row.simJobId === child.id)).toBe(true);
  }, 60000);

  it("does not submit a URANS retry when all RANS points are valid", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoas = [140.01, 141.01];
    await db.delete(results).where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, aoas)));
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
        requestPayload: { speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId, mach: bc.mach }], aoas },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(parent.id);
    for (const aoa of aoas) {
      const [row] = await db
        .insert(results)
        .values({ airfoilId: a.id, bcId: bc.id, simulationPresetRevisionId: presetRevisionId, aoaDeg: aoa, status: "queued", source: "queued", simJobId: parent.id })
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
      getResult: async () => validResult,
      submitPolar: async (): Promise<JobStatus> => {
        submittedRetry = true;
        return { job_id: "unexpected-child", state: "pending", total_cases: aoas.length, completed_cases: 0 };
      },
      fileUrl: (jobId: string, relPath: string) => `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, validEngine, { jobIds: [parent.id], skipFailedRecovery: true });

    expect(submittedRetry).toBe(false);
    const children = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
    expect(children.length).toBe(0);
    const solved = await db
      .select({ status: results.status, source: results.source, simJobId: results.simJobId, converged: results.converged })
      .from(results)
      .where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, aoas)));
    expect(solved.length).toBe(2);
    expect(solved.every((r) => r.status === "done" && r.source === "solved" && r.simJobId === parent.id && r.converged)).toBe(true);
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
        target: [results.airfoilId, results.simulationPresetRevisionId, results.aoaDeg],
        set: { status: "queued", source: "queued", simJobId: null },
      })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    await resetOrphans(db);

    const [got] = await db.select({ status: results.status, simJobId: results.simJobId }).from(results).where(eq(results.id, row.id));
    expect(got.status).toBe("pending");
    expect(got.simJobId).toBeNull();
    await db.delete(results).where(eq(results.id, row.id));
  });

  it("keeps an engine-visible job active when a status poll briefly misses it", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 124.456;
    await db.delete(results).where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, [aoa])));
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
      .values({ airfoilId: a.id, bcId: bc.id, simulationPresetRevisionId: presetRevisionId, aoaDeg: aoa, status: "queued", source: "queued", simJobId: job.id })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    const transientMissEngine = {
      getJob: async () => {
        throw new EngineError("GET /jobs/engine-visible-after-404 -> 404", 404);
      },
      getQueue: async () => emptyQueue(["engine-visible-after-404"]),
    } as unknown as EngineClient;

    await reconcile(db, transientMissEngine, { jobIds: [job.id], skipFailedRecovery: true });

    const [got] = await db.select({ status: simJobs.status, engineState: simJobs.engineState, error: simJobs.error }).from(simJobs).where(eq(simJobs.id, job.id));
    expect(got.status).toBe("running");
    expect(got.engineState).toBe("running");
    expect(got.error).toBeNull();
  });

  it("keeps a detached worker heartbeat active even when Celery no longer lists the task", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 124.956;
    await db.delete(results).where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, [aoa])));
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
      .values({ airfoilId: a.id, bcId: bc.id, simulationPresetRevisionId: presetRevisionId, aoaDeg: aoa, status: "running", source: "queued", simJobId: job.id })
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
        throw new EngineError("GET /jobs/detached-process-after-celery-loss -> 409", 409);
      },
    } as unknown as EngineClient;

    await reconcile(db, detachedEngine, { jobIds: [job.id], skipFailedRecovery: true });

    const [got] = await db.select({ status: simJobs.status, engineState: simJobs.engineState, error: simJobs.error }).from(simJobs).where(eq(simJobs.id, job.id));
    const [gotResult] = await db.select({ status: results.status, simJobId: results.simJobId }).from(results).where(eq(results.id, row.id));
    expect(got.status).toBe("running");
    expect(got.engineState).toBe("running");
    expect(got.error).toContain("heartbeat");
    expect(gotResult.status).toBe("running");
    expect(gotResult.simJobId).toBe(job.id);
  });

  it("ingests a completed result file even when Celery no longer sees the task", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 125.156;
    await db.delete(results).where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, [aoa])));
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
        requestPayload: { speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId, mach: bc.mach }] },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const [row] = await db
      .insert(results)
      .values({ airfoilId: a.id, bcId: bc.id, simulationPresetRevisionId: presetRevisionId, aoaDeg: aoa, status: "running", source: "queued", simJobId: job.id })
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
        throw new EngineError("GET /jobs/completed-runtime-result-no-celery -> 409", 409);
      },
      getResult: async () => result,
      fileUrl: (jobId: string, relPath: string) => `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, resultReadyEngine, { jobIds: [job.id], skipFailedRecovery: true });

    const [gotJob] = await db.select({ status: simJobs.status, error: simJobs.error }).from(simJobs).where(eq(simJobs.id, job.id));
    const [gotResult] = await db.select({ status: results.status, source: results.source, cl: results.cl }).from(results).where(eq(results.id, row.id));
    expect(gotJob.status).toBe("done");
    expect(gotJob.error).toBeNull();
    expect(gotResult.status).toBe("done");
    expect(gotResult.source).toBe("solved");
    expect(gotResult.cl).toBeCloseTo(0.61, 6);
  }, 60000);

  it("ingests a running partial result without marking the sweep done", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 125.256;
    await db.delete(results).where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, [aoa])));
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
        requestPayload: { speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId, mach: bc.mach }] },
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const [row] = await db
      .insert(results)
      .values({ airfoilId: a.id, bcId: bc.id, simulationPresetRevisionId: presetRevisionId, aoaDeg: aoa, status: "running", source: "queued", simJobId: job.id })
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
      getResult: async () => partialResult,
      fileUrl: (jobId: string, relPath: string) => `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, partialEngine, { jobIds: [job.id], skipFailedRecovery: true });

    const [gotJob] = await db
      .select({ status: simJobs.status, engineState: simJobs.engineState, completedCases: simJobs.completedCases, finishedAt: simJobs.finishedAt })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    const [gotResult] = await db.select({ status: results.status, source: results.source, cl: results.cl }).from(results).where(eq(results.id, row.id));
    expect(gotJob.status).toBe("running");
    expect(gotJob.engineState).toBe("running");
    expect(gotJob.completedCases).toBe(1);
    expect(gotJob.finishedAt).toBeNull();
    expect(gotResult.status).toBe("done");
    expect(gotResult.source).toBe("solved");
    expect(gotResult.cl).toBeCloseTo(0.67, 6);
    const attempts = await db.select({ id: resultAttempts.id }).from(resultAttempts).where(and(eq(resultAttempts.simJobId, job.id), eq(resultAttempts.aoaDeg, aoa)));
    attempts.forEach((attempt) => cleanupAttemptIds.add(attempt.id));
    expect(attempts.length).toBe(1);
  }, 60000);

  it("re-ingests a completed engine result after a prior ingest failure", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 125.456;
    await db.delete(results).where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, [aoa])));
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
        requestPayload: { speedMap: [{ speed: bc.speedMps, bcId: bc.id, presetRevisionId, mach: bc.mach }] },
        error: 'ingest failed: column "scheduling_policy" does not exist',
        finishedAt: new Date(),
      })
      .returning({ id: simJobs.id });
    cleanupJobIds.add(job.id);
    const [row] = await db
      .insert(results)
      .values({ airfoilId: a.id, bcId: bc.id, simulationPresetRevisionId: presetRevisionId, aoaDeg: aoa, status: "failed", source: "queued", simJobId: job.id })
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
      getResult: async () => result,
      fileUrl: (jobId: string, relPath: string) => `http://engine.test/jobs/${jobId}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, recoveredEngine, { jobIds: [job.id], recoverFailedJobIds: [job.id] });

    const [gotJob] = await db.select({ status: simJobs.status, error: simJobs.error }).from(simJobs).where(eq(simJobs.id, job.id));
    const [gotResult] = await db
      .select({ status: results.status, source: results.source, cl: results.cl, cd: results.cd })
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
    await db.delete(results).where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), inArray(results.aoaDeg, [aoa])));
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
      .values({ airfoilId: a.id, bcId: bc.id, simulationPresetRevisionId: presetRevisionId, aoaDeg: aoa, status: "failed", source: "queued", simJobId: job.id })
      .returning({ id: results.id });
    cleanupResultIds.add(row.id);

    const missingEngine = {
      getJob: async () => {
        throw new EngineError("GET /jobs/really-missing-engine-job -> 404", 404);
      },
      getQueue: async () => emptyQueue(),
    } as unknown as EngineClient;

    await reconcile(db, missingEngine, { jobIds: [job.id], recoverFailedJobIds: [job.id] });

    const [gotJob] = await db.select({ status: simJobs.status, engineState: simJobs.engineState }).from(simJobs).where(eq(simJobs.id, job.id));
    const [gotResult] = await db.select({ status: results.status, simJobId: results.simJobId }).from(results).where(eq(results.id, row.id));
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

    const activeTask = { worker: "test", task_id: engineJobId, name: "airfoilfoam.run_polar", job_id: engineJobId, redelivered: true };
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

    await reconcile(db, redeliveredEngine, { jobIds: [job.id], skipFailedRecovery: true });

    const [gotJob] = await db.select({ status: simJobs.status, engineState: simJobs.engineState, error: simJobs.error }).from(simJobs).where(eq(simJobs.id, job.id));
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
    await db.delete(results).where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), eq(results.aoaDeg, aoa)));
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
      .values({ airfoilId: a.id, bcId: bc.id, simulationPresetRevisionId: presetRevisionId, aoaDeg: aoa, status: "running", source: "queued", simJobId: job.id })
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

    await reconcile(db, cancelledEngine, { jobIds: [job.id], skipFailedRecovery: true });

    const [gotJob] = await db
      .select({ status: simJobs.status, engineState: simJobs.engineState, finishedAt: simJobs.finishedAt })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    const [gotResult] = await db
      .select({ status: results.status, simJobId: results.simJobId, engineJobId: results.engineJobId, cl: results.cl })
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
    expect(gaps.some((gap) => gap.airfoilId === a.id && gap.presetRevisionId === presetRevisionId && gap.aoaDeg === aoa)).toBe(true);
    await db.delete(results).where(eq(results.id, row.id));
  }, 60000);

  // MUST-CATCH (G3, incident 2026-07-05): a force-recreated worker killed the
  // celery tasks, but the engine's persisted status store kept returning
  // state=running (active_pids [], last_progress_at hours stale) — zombies the
  // sweeper polled for ~2.3 h. Shape: running + zero processes + stale worker
  // heartbeat + absent from Celery + last progress beyond the 30 min grace.
  it("cancels and requeues a lost engine job that reports running with no processes and stale progress", async () => {
    const { a, bc, presetRevisionId } = await firstAirfoilBc();
    const aoa = 129.456;
    await db.delete(results).where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), eq(results.aoaDeg, aoa)));
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
      .values({ airfoilId: a.id, bcId: bc.id, simulationPresetRevisionId: presetRevisionId, aoaDeg: aoa, status: "running", source: "queued", simJobId: job.id })
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

    await reconcile(db, zombieEngine, { jobIds: [job.id], skipFailedRecovery: true });

    const [gotJob] = await db
      .select({ status: simJobs.status, engineState: simJobs.engineState, error: simJobs.error, finishedAt: simJobs.finishedAt })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    const [gotResult] = await db.select({ status: results.status, simJobId: results.simJobId }).from(results).where(eq(results.id, row.id));
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
    await db.delete(results).where(and(eq(results.airfoilId, a.id), eq(results.simulationPresetRevisionId, presetRevisionId), eq(results.aoaDeg, aoa)));
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
      .values({ airfoilId: a.id, bcId: bc.id, simulationPresetRevisionId: presetRevisionId, aoaDeg: aoa, status: "running", source: "queued", simJobId: job.id })
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

    await reconcile(db, quietEngine, { jobIds: [job.id], skipFailedRecovery: true });

    const [gotJob] = await db.select({ status: simJobs.status, engineState: simJobs.engineState }).from(simJobs).where(eq(simJobs.id, job.id));
    const [gotResult] = await db.select({ status: results.status, simJobId: results.simJobId }).from(results).where(eq(results.id, row.id));
    expect(engineCancels).toEqual([]);
    expect(gotJob.status).toBe("running");
    expect(gotJob.engineState).toBe("running");
    expect(gotResult.status).toBe("running");
    expect(gotResult.simJobId).toBe(job.id);
    await db.delete(results).where(eq(results.id, row.id));
  }, 60000);
});
