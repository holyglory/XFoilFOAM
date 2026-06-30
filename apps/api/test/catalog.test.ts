import { type Point } from "@aerodb/core";
import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  flowConditions,
  forceHistory,
  mediums,
  meshProfiles,
  outputProfiles,
  polarFitSets,
  referenceGeometryProfiles,
  registeredRemoteSolvers,
  refreshPolarCacheForRevision,
  resultClassifications,
  resultMedia,
  results,
  simJobs,
  schedulingProfiles,
  simulationPresets,
  solverProfiles,
  syncApiPermissions,
  syncApiSettings,
  syncSweepPromises,
  sweepDefinitions,
} from "@aerodb/db";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, sql } from "../src/db";
import { buildServer } from "../src/server";
import { assembleDetail } from "../src/services/detail";
import { listAirfoils } from "../src/services/catalog";
import { assembleSim } from "../src/services/sim";

const cleanupResultIds = new Set<string>();
const cleanupClassificationIds = new Set<string>();
const cleanupFitSetIds = new Set<string>();
const cleanupPresetIds = new Set<string>();
const cleanupBoundaryConditionIds = new Set<string>();
const cleanupFlowConditionIds = new Set<string>();
const cleanupReferenceGeometryIds = new Set<string>();
const cleanupBoundaryProfileIds = new Set<string>();
const cleanupMeshProfileIds = new Set<string>();
const cleanupSolverProfileIds = new Set<string>();
const cleanupSchedulingProfileIds = new Set<string>();
const cleanupOutputProfileIds = new Set<string>();
const cleanupSweepDefinitionIds = new Set<string>();
const cleanupSimJobIds = new Set<string>();
const cleanupAirfoilIds = new Set<string>();
const cleanupCategoryIds = new Set<string>();
const cleanupSyncPromiseIds = new Set<string>();
const cleanupRegisteredSolverIds = new Set<string>();

const points: Point[] = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.05 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.05 },
  { x: 1, y: 0 },
];

async function createTestBoundaryCondition(unique: string, enabled = true, reynolds = 500000) {
  const [air] = await db.select().from(mediums).where(eq(mediums.slug, "air")).limit(1);
  expect(air).toBeTruthy();
  const speed = Math.round(reynolds * air.kinematicViscosity * 1_000_000) / 1_000_000;
  const suffix = enabled ? "" : "-disabled";
  const [bc] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${unique}-bc${suffix}`,
      name: `${unique} BC`,
      mediumId: air.id,
      reynolds,
      referenceChordM: 1,
      temperatureK: air.refTemperatureK,
      pressurePa: air.refPressurePa,
      speedMps: speed,
      density: air.density,
      dynamicViscosity: air.dynamicViscosity,
      kinematicViscosity: air.kinematicViscosity,
      mach: air.speedOfSound ? speed / air.speedOfSound : null,
      enabled,
    })
    .returning({
      id: boundaryConditions.id,
      mediumId: boundaryConditions.mediumId,
      reynolds: boundaryConditions.reynolds,
      speed: boundaryConditions.speedMps,
      chord: boundaryConditions.referenceChordM,
      mach: boundaryConditions.mach,
    });
  cleanupBoundaryConditionIds.add(bc.id);

  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${unique}-flow${suffix}`,
      name: `${unique} Flow`,
      mediumId: air.id,
      temperatureK: air.refTemperatureK,
      pressurePa: air.refPressurePa,
      speedMps: speed,
      density: air.density,
      dynamicViscosity: air.dynamicViscosity,
      kinematicViscosity: air.kinematicViscosity,
      mach: air.speedOfSound ? speed / air.speedOfSound : null,
    })
    .returning({ id: flowConditions.id });
  cleanupFlowConditionIds.add(flow.id);

  const [referenceGeometry] = await db
    .insert(referenceGeometryProfiles)
    .values({
      slug: `${unique}-reference-geometry${suffix}`,
      name: `${unique} Reference Geometry`,
      geometryType: "airfoil_2d",
      referenceLengthKind: "chord",
      referenceLengthM: 1,
    })
    .returning({ id: referenceGeometryProfiles.id });
  cleanupReferenceGeometryIds.add(referenceGeometry.id);

  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({
      slug: `${unique}-boundary${suffix}`,
      name: `${unique} Boundary`,
      turbulenceIntensity: 0.001,
      viscosityRatio: 10,
    })
    .returning({ id: boundaryProfiles.id });
  cleanupBoundaryProfileIds.add(boundary.id);

  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${unique}-mesh${suffix}`, name: `${unique} Mesh` })
    .returning({ id: meshProfiles.id });
  cleanupMeshProfileIds.add(mesh.id);

  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: `${unique}-solver${suffix}`, name: `${unique} Solver` })
    .returning({ id: solverProfiles.id });
  cleanupSolverProfileIds.add(solver.id);

  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({ slug: `${unique}-scheduling${suffix}`, name: `${unique} Scheduling` })
    .returning({ id: schedulingProfiles.id });
  cleanupSchedulingProfileIds.add(scheduling.id);

  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${unique}-output${suffix}`, name: `${unique} Output` })
    .returning({ id: outputProfiles.id });
  cleanupOutputProfileIds.add(output.id);

  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({ slug: `${unique}-sweep${suffix}`, name: `${unique} Sweep`, aoaStart: -8, aoaStop: 20, aoaStep: 1 })
    .returning({ id: sweepDefinitions.id });
  cleanupSweepDefinitionIds.add(sweep.id);

  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${unique}-preset${suffix}`,
      name: `${unique} Preset`,
      flowConditionId: flow.id,
      referenceGeometryProfileId: referenceGeometry.id,
      boundaryProfileId: boundary.id,
      meshProfileId: mesh.id,
      solverProfileId: solver.id,
      schedulingProfileId: scheduling.id,
      outputProfileId: output.id,
      sweepDefinitionId: sweep.id,
      legacyBoundaryConditionId: bc.id,
      enabled,
    })
    .returning({ id: simulationPresets.id });
  cleanupPresetIds.add(preset.id);

  const resolved = await ensureSimulationPresetRevision(db, preset.id);
  expect(resolved).toBeTruthy();
  expect(resolved!.snapshot.flowState.speedMps).toBe(speed);
  expect(resolved!.snapshot.referenceGeometry.referenceLengthM).toBe(1);
  expect(Math.abs(resolved!.snapshot.derived.reynolds - reynolds)).toBeLessThan(20);
  expect(Math.abs(resolved!.revision.reynolds - reynolds)).toBeLessThan(20);
  expect((resolved!.snapshot as unknown as { operating?: unknown }).operating).toBeUndefined();
  return { ...bc, presetId: preset.id, presetRevisionId: resolved!.revision.id };
}

afterAll(async () => {
  if (cleanupSyncPromiseIds.size) await db.delete(syncSweepPromises).where(inArray(syncSweepPromises.id, Array.from(cleanupSyncPromiseIds)));
  if (cleanupRegisteredSolverIds.size) await db.delete(registeredRemoteSolvers).where(inArray(registeredRemoteSolvers.id, Array.from(cleanupRegisteredSolverIds)));
  if (cleanupFitSetIds.size) await db.delete(polarFitSets).where(inArray(polarFitSets.id, Array.from(cleanupFitSetIds)));
  if (cleanupClassificationIds.size) {
    await db.delete(resultClassifications).where(inArray(resultClassifications.id, Array.from(cleanupClassificationIds)));
  }
  if (cleanupResultIds.size) await db.delete(results).where(inArray(results.id, Array.from(cleanupResultIds)));
  if (cleanupSimJobIds.size) await db.delete(simJobs).where(inArray(simJobs.id, Array.from(cleanupSimJobIds)));
  if (cleanupPresetIds.size) {
    await db.delete(simulationPresets).where(inArray(simulationPresets.id, Array.from(cleanupPresetIds)));
  }
  if (cleanupBoundaryConditionIds.size) {
    await db.delete(boundaryConditions).where(inArray(boundaryConditions.id, Array.from(cleanupBoundaryConditionIds)));
  }
  if (cleanupFlowConditionIds.size) {
    await db
      .delete(flowConditions)
      .where(inArray(flowConditions.id, Array.from(cleanupFlowConditionIds)));
  }
  if (cleanupReferenceGeometryIds.size) {
    await db
      .delete(referenceGeometryProfiles)
      .where(inArray(referenceGeometryProfiles.id, Array.from(cleanupReferenceGeometryIds)));
  }
  if (cleanupBoundaryProfileIds.size) {
    await db.delete(boundaryProfiles).where(inArray(boundaryProfiles.id, Array.from(cleanupBoundaryProfileIds)));
  }
  if (cleanupMeshProfileIds.size) {
    await db.delete(meshProfiles).where(inArray(meshProfiles.id, Array.from(cleanupMeshProfileIds)));
  }
  if (cleanupSolverProfileIds.size) {
    await db.delete(solverProfiles).where(inArray(solverProfiles.id, Array.from(cleanupSolverProfileIds)));
  }
  if (cleanupSchedulingProfileIds.size) {
    await db.delete(schedulingProfiles).where(inArray(schedulingProfiles.id, Array.from(cleanupSchedulingProfileIds)));
  }
  if (cleanupOutputProfileIds.size) {
    await db.delete(outputProfiles).where(inArray(outputProfiles.id, Array.from(cleanupOutputProfileIds)));
  }
  if (cleanupSweepDefinitionIds.size) {
    await db.delete(sweepDefinitions).where(inArray(sweepDefinitions.id, Array.from(cleanupSweepDefinitionIds)));
  }
  if (cleanupAirfoilIds.size) await db.delete(airfoils).where(inArray(airfoils.id, Array.from(cleanupAirfoilIds)));
  if (cleanupCategoryIds.size) await db.delete(categories).where(inArray(categories.id, Array.from(cleanupCategoryIds)));
  await sql.end();
});

describe("catalog solved-metric evidence", () => {
  it("gates sync API status and claims by enablement, secret, and permissions", async () => {
    const secret = `sync-api-test-${Date.now()}`;
    const sourceInstanceId = `sync-api-test-${process.pid}-${Date.now()}`;
    await db.insert(syncApiSettings).values({ id: 1 }).onConflictDoNothing();
    const [savedSettings] = await db.select().from(syncApiSettings).where(eq(syncApiSettings.id, 1)).limit(1);
    const savedPermissions = await db.select().from(syncApiPermissions);
    const app = await buildServer();
    try {
      await db
        .update(syncApiSettings)
        .set({ enabled: false, secret, defaultPromiseTtlHours: 24, updatedAt: new Date() })
        .where(eq(syncApiSettings.id, 1));

      const disabled = await app.inject({ method: "GET", url: "/api/sync/v1/status" });
      expect(disabled.statusCode).toBe(404);

      await db
        .update(syncApiSettings)
        .set({ enabled: true, secret, updatedAt: new Date() })
        .where(eq(syncApiSettings.id, 1));
      await db
        .insert(syncApiPermissions)
        .values({ dataType: "sweeps", canFetch: false, canPush: false })
        .onConflictDoUpdate({ target: syncApiPermissions.dataType, set: { canFetch: false, canPush: false, updatedAt: new Date() } });

      const unauthorized = await app.inject({ method: "GET", url: "/api/sync/v1/status" });
      expect(unauthorized.statusCode).toBe(401);

      const forbiddenClaim = await app.inject({
        method: "POST",
        url: "/api/sync/v1/sweeps/claim",
        headers: { "x-xfoilfoam-sync-secret": secret },
        payload: { limit: 1, sourceInstanceId },
      });
      expect(forbiddenClaim.statusCode).toBe(403);

      await db
        .insert(syncApiPermissions)
        .values({ dataType: "sweeps", canFetch: true, canPush: false })
        .onConflictDoUpdate({ target: syncApiPermissions.dataType, set: { canFetch: true, canPush: false, updatedAt: new Date() } });

      const status = await app.inject({ method: "GET", url: "/api/sync/v1/status", headers: { authorization: `Bearer ${secret}` } });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ ok: true, defaultPromiseTtlHours: 24 });

      const register = await app.inject({
        method: "POST",
        url: "/api/sync/v1/solvers/register",
        headers: { "x-xfoilfoam-sync-secret": secret },
        payload: {
          instanceId: `${sourceInstanceId}-solver`,
          instanceName: "sync api test solver",
          publicEndpoint: "http://solver.test/api/sync/v1",
          cpuCapacity: 4,
          cpuBudget: 2,
          buildVersion: "test-build",
        },
      });
      expect(register.statusCode).toBe(200);
      const registered = register.json() as { solver: { id: string; instanceId: string; cpuBudget: number; status: string } };
      cleanupRegisteredSolverIds.add(registered.solver.id);
      expect(registered.solver).toMatchObject({ instanceId: `${sourceInstanceId}-solver`, cpuBudget: 2, status: "idle" });

      const heartbeat = await app.inject({
        method: "POST",
        url: `/api/sync/v1/solvers/${registered.solver.id}/heartbeat`,
        headers: { "x-xfoilfoam-sync-secret": secret },
        payload: { status: "solving", activePromiseCount: 1, activeAoaCount: 36, cpuBudget: 2 },
      });
      expect(heartbeat.statusCode).toBe(200);
      expect(heartbeat.json()).toMatchObject({ ok: true, solver: { status: "solving", activePromiseCount: 1, activeAoaCount: 36 } });

      const progress = await app.inject({
        method: "POST",
        url: `/api/sync/v1/solvers/${registered.solver.id}/progress`,
        headers: { "x-xfoilfoam-sync-secret": secret },
        payload: { status: "pushing", solvedCountDelta: 2, pushedCountDelta: 1 },
      });
      expect(progress.statusCode).toBe(200);
      expect(progress.json()).toMatchObject({ ok: true, solver: { status: "pushing", solvedCount: 2, pushedCount: 1 } });

      const claim = await app.inject({
        method: "POST",
        url: "/api/sync/v1/sweeps/claim",
        headers: { "x-xfoilfoam-sync-secret": secret },
        payload: { limit: 1, solverId: registered.solver.id, sourceInstanceId, sourceInstanceName: "sync api test" },
      });
      expect(claim.statusCode).toBe(200);
      const body = claim.json() as { promise: null | { id: string; aoas: number[]; expiresAt: string } };
      if (body.promise) {
        expect(body.promise.aoas.length).toBe(1);
        cleanupSyncPromiseIds.add(body.promise.id);
      }
    } finally {
      await db.delete(syncSweepPromises).where(eq(syncSweepPromises.sourceInstanceId, sourceInstanceId));
      if (savedSettings) {
        await db
          .update(syncApiSettings)
          .set({
            enabled: savedSettings.enabled,
            secret: savedSettings.secret,
            instanceName: savedSettings.instanceName,
            publicEndpointOverride: savedSettings.publicEndpointOverride,
            defaultPromiseTtlHours: savedSettings.defaultPromiseTtlHours,
            updatedAt: new Date(),
          })
          .where(eq(syncApiSettings.id, 1));
      }
      for (const permission of savedPermissions) {
        await db
          .insert(syncApiPermissions)
          .values(permission)
          .onConflictDoUpdate({
            target: syncApiPermissions.dataType,
            set: { canFetch: permission.canFetch, canPush: permission.canPush, updatedAt: new Date() },
          });
      }
      await app.close();
    }
  }, 60000);

  it("does not expose seeded reference L/D as solved Browse metrics", async () => {
    const unique = `catalog-evidence-${Date.now()}`;
    const bc = await createTestBoundaryCondition(unique);

    const [cat] = await db
      .insert(categories)
      .values({ slug: unique, name: "Catalog Evidence Test", path: unique, depth: 0, sortOrder: 999 })
      .returning({ id: categories.id });
    cleanupCategoryIds.add(cat.id);

    const [airfoil] = await db
      .insert(airfoils)
      .values({
        slug: unique,
        name: `${unique} Airfoil`,
        categoryId: cat.id,
        source: "test",
        points,
        thicknessPct: 12,
        camberPct: 2,
        refLdmax: null,
        refClmax: null,
        refCdmin: null,
        refMetricsSource: "queued",
        tags: [],
      })
      .returning({ id: airfoils.id });
    cleanupAirfoilIds.add(airfoil.id);

    let [summary] = await listAirfoils({ q: `${unique} Airfoil`, sort: "ldmax", dir: "desc" });
    expect(summary.ldmax).toBeNull();
    expect(summary.clmax).toBeNull();
    expect(summary.cdmin).toBeNull();
    expect(summary.polarCount).toBe(0);
    expect(summary.metricsSource).toBe("queued");

    const validRansRows = await db
      .insert(results)
      .values(
        [2, 4, 6].map((aoa, i) => ({
          airfoilId: airfoil.id,
          bcId: bc.id,
          simulationPresetRevisionId: bc.presetRevisionId,
          aoaDeg: aoa,
          status: "done" as const,
          source: "solved" as const,
          regime: "rans" as const,
          cl: 0.4 + i * 0.2,
          cd: 0.02 - i * 0.002,
          cm: -0.02,
          clCd: (0.4 + i * 0.2) / (0.02 - i * 0.002),
          converged: true,
          solvedAt: new Date(),
        })),
      )
      .returning({ id: results.id });
    validRansRows.forEach((row) => cleanupResultIds.add(row.id));

    [summary] = await listAirfoils({ q: `${unique} Airfoil`, sort: "ldmax", dir: "desc" });
    expect(summary.ldmax).toBeNull();
    expect(summary.polarCount).toBe(0);
    expect(summary.metricsSource).toBe("queued");

    const refreshed = await refreshPolarCacheForRevision(db, airfoil.id, bc.presetRevisionId);
    if (refreshed.fitSetId) cleanupFitSetIds.add(refreshed.fitSetId);
    const cachedClassifications = await db
      .select({ id: resultClassifications.id })
      .from(resultClassifications)
      .where(eq(resultClassifications.airfoilId, airfoil.id));
    cachedClassifications.forEach((row) => cleanupClassificationIds.add(row.id));

    [summary] = await listAirfoils({ q: `${unique} Airfoil`, sort: "ldmax", dir: "desc" });
    expect(summary.ldmax).not.toBeNull();
    expect(summary.clmax).not.toBeNull();
    expect(summary.cdmin).not.toBeNull();
    expect(summary.polarCount).toBe(3);
    expect(summary.metricsSource).toBe("solved");
    expect(summary.fitStatus).toBe("final");
    let detail = await assembleDetail(unique);
    let detailPoints = detail?.polars.flatMap((p) => p.points) ?? [];
    expect(detailPoints).toHaveLength(3);
    expect(detail?.polars[0].fit?.status).toBe("final");
    expect(detail?.reList).toEqual([bc.reynolds]);

    const disabledBc = await createTestBoundaryCondition(`${unique}-disabled`, false, 500000);
    const [disabledResult] = await db
      .insert(results)
      .values({
        airfoilId: airfoil.id,
        bcId: disabledBc.id,
        simulationPresetRevisionId: disabledBc.presetRevisionId,
        aoaDeg: 2,
        status: "done",
        source: "solved",
        regime: "rans",
        cl: 9.99,
        cd: 0.01,
        cm: -0.02,
        clCd: 999,
        converged: true,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    cleanupResultIds.add(disabledResult.id);

    [summary] = await listAirfoils({ q: `${unique} Airfoil`, sort: "ldmax", dir: "desc" });
    expect(summary.ldmax).not.toBeNull();
    expect(summary.polarCount).toBe(3);
    detail = await assembleDetail(unique);
    detailPoints = detail?.polars.flatMap((p) => p.points) ?? [];
    expect(detailPoints).toHaveLength(3);
    expect(detail?.reList).toEqual([bc.reynolds]);

    const [invalidResult] = await db
      .insert(results)
      .values({
        airfoilId: airfoil.id,
        bcId: bc.id,
        simulationPresetRevisionId: bc.presetRevisionId,
        aoaDeg: 3,
        status: "done",
        source: "solved",
        regime: "rans",
        cl: 0.9,
        cd: 0.012,
        cm: -0.02,
        clCd: 75,
        converged: false,
        stalled: true,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    cleanupResultIds.add(invalidResult.id);

    const refreshedAfterLowAoaFailure = await refreshPolarCacheForRevision(db, airfoil.id, bc.presetRevisionId);
    if (refreshedAfterLowAoaFailure.fitSetId) cleanupFitSetIds.add(refreshedAfterLowAoaFailure.fitSetId);
    [summary] = await listAirfoils({ q: `${unique} Airfoil`, sort: "ldmax", dir: "desc" });
    expect(summary.polarCount).toBe(3);
    expect(summary.fitStatus).toBe("provisional");
    detail = await assembleDetail(unique);
    expect(detail?.polars[0].fit?.status).toBe("provisional");

    const [uransReplacement] = await db
      .insert(results)
      .values({
        airfoilId: airfoil.id,
        bcId: bc.id,
        simulationPresetRevisionId: bc.presetRevisionId,
        aoaDeg: 5,
        status: "done",
        source: "solved",
        regime: "urans",
        cl: 0.75,
        cd: 0.03,
        cm: -0.02,
        clCd: 25,
        unsteady: true,
        converged: true,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    cleanupResultIds.add(uransReplacement.id);
    await db.insert(forceHistory).values({
      resultId: uransReplacement.id,
      t: [0, 1],
      cl: [0.73, 0.77],
      cd: [0.029, 0.031],
      cm: [-0.02, -0.02],
      clMean: 0.75,
      clRms: 0.02,
      cdMean: 0.03,
      cdRms: 0.001,
      strouhal: 0.5,
      sheddingFreqHz: 1,
      sampleCount: 141,
    });
    await db.insert(resultMedia).values({
      resultId: uransReplacement.id,
      kind: "video",
      role: "instantaneous",
      field: "velocity_magnitude",
      storageKey: "jobs/test/cases/urans/images/velocity_magnitude.mp4",
      mimeType: "video/mp4",
      frameCount: 141,
      durationS: 7,
    });

    const refreshedAfterUrans = await refreshPolarCacheForRevision(db, airfoil.id, bc.presetRevisionId);
    if (refreshedAfterUrans.fitSetId) cleanupFitSetIds.add(refreshedAfterUrans.fitSetId);
    [summary] = await listAirfoils({ q: `${unique} Airfoil`, sort: "ldmax", dir: "desc" });
    expect(summary.ldmax).not.toBeNull();
    expect(summary.clmax).not.toBeNull();
    expect(summary.cdmin).not.toBeNull();
    expect(summary.polarCount).toBe(3);
    expect(summary.metricsSource).toBe("solved");
    expect(summary.fitStatus).toBe("provisional");
    detail = await assembleDetail(unique);
    detailPoints = detail?.polars.flatMap((p) => p.points) ?? [];
    expect(detailPoints.length).toBeGreaterThan(0);
    expect(detail?.polars[0].fit?.status).toBe("provisional");
  }, 15000);
});

describe("simulation media evidence", () => {
  it("opens solved-point evidence by result id and dynamic preset Reynolds", async () => {
    const unique = `sim-dynamic-re-${Date.now()}`;
    const dynamicRe = 1_985_174;
    const bc = await createTestBoundaryCondition(unique, true, dynamicRe);

    const [cat] = await db
      .insert(categories)
      .values({ slug: unique, name: "Dynamic Re Sim Test", path: unique, depth: 0, sortOrder: 999 })
      .returning({ id: categories.id });
    cleanupCategoryIds.add(cat.id);

    const [airfoil] = await db
      .insert(airfoils)
      .values({
        slug: unique,
        name: `${unique} Airfoil`,
        categoryId: cat.id,
        source: "test",
        points,
        thicknessPct: 8,
        camberPct: 2,
        tags: [],
      })
      .returning({ id: airfoils.id });
    cleanupAirfoilIds.add(airfoil.id);

    const [result] = await db
      .insert(results)
      .values({
        airfoilId: airfoil.id,
        bcId: bc.id,
        simulationPresetRevisionId: bc.presetRevisionId,
        aoaDeg: 7,
        status: "done",
        source: "solved",
        regime: "rans",
        reynolds: dynamicRe,
        speed: bc.speed,
        chord: bc.chord,
        mach: 0.1,
        cl: 0.86,
        cd: 0.017,
        cm: -0.02,
        clCd: 50.59,
        converged: true,
        stalled: false,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    cleanupResultIds.add(result.id);

    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: airfoil.id,
        bcIds: [bc.id],
        simulationPresetRevisionId: bc.presetRevisionId,
        referenceChordM: bc.chord,
        wave: 2,
        status: "running",
        totalCases: 2,
        completedCases: 0,
        requestPayload: {
          aoas: [19, 20],
          retryMode: "invalid-rans-points",
          setupSnapshot: {
            preset: { name: `${unique} Preset` },
            derived: { reynolds: dynamicRe },
            flowState: { mach: 0.1 },
          },
        },
      })
      .returning({ id: simJobs.id });
    cleanupSimJobIds.add(job.id);

    const detail = await assembleDetail(unique);
    const polar = detail?.polars.find((p) => Math.abs(p.re - dynamicRe) < 20);
    expect(polar?.points).toHaveLength(1);
    expect(polar?.points[0].resultId).toBe(result.id);
    expect(detail?.reList).toEqual([dynamicRe]);
    expect(detail?.mach).toBeCloseTo(bc.mach ?? 0);
    expect(detail?.simulationWorks.find((work) => work.id === job.id)).toMatchObject({
      kind: "urans-retry",
      status: "running",
      retryMode: "invalid-rans-points",
      aoas: [19, 20],
      totalCases: 2,
    });

    const simByDynamicRe = await assembleSim(unique, dynamicRe, 7);
    expect(simByDynamicRe?.status).toBe("solved");
    expect(simByDynamicRe?.re).toBe(dynamicRe);
    expect(simByDynamicRe?.alpha).toBe(7);

    const simByResultId = await assembleSim(unique, undefined, undefined, result.id);
    expect(simByResultId?.status).toBe("solved");
    expect(simByResultId?.re).toBe(dynamicRe);
    expect(simByResultId?.cl).toBeCloseTo(0.86);
  });

  it("uses URANS video for the live field and leaves static-only evidence readable", async () => {
    const unique = `sim-media-${Date.now()}`;
    const bc = await createTestBoundaryCondition(unique, true, 100000);

    const [cat] = await db
      .insert(categories)
      .values({ slug: unique, name: "Sim Media Test", path: unique, depth: 0, sortOrder: 999 })
      .returning({ id: categories.id });
    cleanupCategoryIds.add(cat.id);

    const [airfoil] = await db
      .insert(airfoils)
      .values({
        slug: unique,
        name: `${unique} Airfoil`,
        categoryId: cat.id,
        source: "test",
        points,
        thicknessPct: 12,
        camberPct: 0,
        tags: [],
      })
      .returning({ id: airfoils.id });
    cleanupAirfoilIds.add(airfoil.id);

    const st = 0.5;
    const period = bc.chord / (st * bc.speed);
    const [animated] = await db
      .insert(results)
      .values({
        airfoilId: airfoil.id,
        bcId: bc.id,
        simulationPresetRevisionId: bc.presetRevisionId,
        aoaDeg: 20,
        status: "done",
        source: "solved",
        regime: "urans",
        reynolds: bc.reynolds,
        speed: bc.speed,
        chord: bc.chord,
        cl: 0.7,
        cd: 0.3,
        cm: -0.1,
        clCd: 2.333,
        clStd: 0.04,
        cdStd: 0.01,
        unsteady: true,
        converged: true,
        strouhal: st,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    cleanupResultIds.add(animated.id);

    await db.insert(forceHistory).values({
      resultId: animated.id,
      t: [0, 7 * period],
      cl: [0.68, 0.72],
      cd: [0.29, 0.31],
      cm: [-0.1, -0.1],
      clMean: 0.7,
      clRms: 0.04,
      cdMean: 0.3,
      cdRms: 0.01,
      strouhal: st,
      sheddingFreqHz: st * bc.speed / bc.chord,
      sampleCount: 141,
    });
    await db.insert(resultMedia).values([
      {
        resultId: animated.id,
        kind: "image",
        role: "instantaneous",
        field: "velocity_magnitude",
        storageKey: "jobs/test/cases/a/images/velocity_magnitude.png",
        mimeType: "image/png",
      },
      {
        resultId: animated.id,
        kind: "image",
        role: "mean",
        field: "velocity_magnitude",
        storageKey: "jobs/test/cases/a/images/velocity_magnitude_mean.png",
        mimeType: "image/png",
      },
      {
        resultId: animated.id,
        kind: "video",
        role: "instantaneous",
        field: "velocity_magnitude",
        storageKey: "jobs/test/cases/a/images/velocity_magnitude.mp4",
        mimeType: "video/mp4",
        frameCount: 141,
        durationS: 7,
      },
    ]);

    const sim = await assembleSim(unique, bc.reynolds, 20);
    expect(sim?.media?.velocity_magnitude?.kind).toBe("video");
    expect(sim?.media?.velocity_magnitude?.url).toContain("velocity_magnitude.mp4");
    expect(sim?.media?.velocity_magnitude?.meanUrl).toContain("velocity_magnitude_mean.png");

    const [staticOnly] = await db
      .insert(results)
      .values({
        airfoilId: airfoil.id,
        bcId: bc.id,
        simulationPresetRevisionId: bc.presetRevisionId,
        aoaDeg: 21,
        status: "done",
        source: "solved",
        regime: "urans",
        reynolds: bc.reynolds,
        speed: bc.speed,
        chord: bc.chord,
        cl: 0.7,
        cd: 0.3,
        cm: -0.1,
        clCd: 2.333,
        unsteady: true,
        converged: true,
        strouhal: st,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    cleanupResultIds.add(staticOnly.id);
    await db.insert(resultMedia).values({
      resultId: staticOnly.id,
      kind: "image",
      role: "instantaneous",
      field: "velocity_magnitude",
      storageKey: "jobs/test/cases/b/images/velocity_magnitude.png",
      mimeType: "image/png",
    });

    const staticSim = await assembleSim(unique, bc.reynolds, 21);
    expect(staticSim?.status).toBe("solved");
    expect(staticSim?.media?.velocity_magnitude?.kind).toBe("image");
    const [stillDone] = await db.select().from(results).where(eq(results.id, staticOnly.id)).limit(1);
    expect(stillDone.status).toBe("done");
    expect(stillDone.error).toBeNull();
  });
});
