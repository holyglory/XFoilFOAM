// GET /api/admin/solved-points (Solver page solved-points viewer, screen 5):
// newest real solved results, keyset-paged on (solvedAt DESC, id DESC), with
// optional jobId scoping and an honest solvedToday count computed over the
// SAME scope as the listed rows (counts always accompany the rows they count).
//
// Shared-database integration test: the dev DB may contain real solved rows,
// so ordering/cursor/count assertions run under jobId scope (fully owned by
// this suite); the global path asserts shape + sort order only. Rows are
// cleaned up in afterAll (global test-hygiene rule).
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
  resultClassifications,
  results,
  schedulingProfiles,
  simJobs,
  simulationPresets,
  solverProfiles,
  sweepDefinitions,
} from "@aerodb/db";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, sql } from "../src/db";
import { buildServer } from "../src/server";
import { parseSolvedPointsCursor } from "../src/solved-points-routes";

const unique = `pw-solvedpts-${Date.now().toString(36)}`;

const cleanupClassificationIds = new Set<string>();
const cleanupResultIds = new Set<string>();
const cleanupSimJobIds = new Set<string>();
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
const cleanupAirfoilIds = new Set<string>();
const cleanupCategoryIds = new Set<string>();

let app: Awaited<ReturnType<typeof buildServer>>;
let jobAId = "";
let jobBId = "";
/** Seeded jobA rows newest-first (the expected API order). */
let jobARows: Array<{ id: string; aoaDeg: number; solvedAt: Date }> = [];

async function createTestChain() {
  const [air] = await db.select().from(mediums).where(eq(mediums.slug, "air")).limit(1);
  expect(air).toBeTruthy();
  const reynolds = 400000;
  const speed = Math.round(reynolds * air.kinematicViscosity * 1_000_000) / 1_000_000;
  const [bc] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${unique}-bc`,
      name: `${unique} BC`,
      mediumId: air.id,
      reynolds,
      referenceChordM: 1,
      temperatureK: air.refTemperatureK,
      pressurePa: air.refPressurePa,
      speedMps: speed,
    })
    .returning({ id: boundaryConditions.id });
  cleanupBoundaryConditionIds.add(bc.id);
  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${unique}-flow`,
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
    .values({ slug: `${unique}-refgeo`, name: `${unique} RefGeo`, geometryType: "airfoil_2d", referenceLengthKind: "chord", referenceLengthM: 1 })
    .returning({ id: referenceGeometryProfiles.id });
  cleanupReferenceGeometryIds.add(referenceGeometry.id);
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({ slug: `${unique}-boundary`, name: `${unique} Boundary`, turbulenceIntensity: 0.001, viscosityRatio: 10 })
    .returning({ id: boundaryProfiles.id });
  cleanupBoundaryProfileIds.add(boundary.id);
  const [mesh] = await db.insert(meshProfiles).values({ slug: `${unique}-mesh`, name: `${unique} Mesh` }).returning({ id: meshProfiles.id });
  cleanupMeshProfileIds.add(mesh.id);
  const [solver] = await db.insert(solverProfiles).values({ slug: `${unique}-solver`, name: `${unique} Solver` }).returning({ id: solverProfiles.id });
  cleanupSolverProfileIds.add(solver.id);
  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({ slug: `${unique}-sched`, name: `${unique} Sched` })
    .returning({ id: schedulingProfiles.id });
  cleanupSchedulingProfileIds.add(scheduling.id);
  const [output] = await db.insert(outputProfiles).values({ slug: `${unique}-output`, name: `${unique} Output` }).returning({ id: outputProfiles.id });
  cleanupOutputProfileIds.add(output.id);
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({ slug: `${unique}-sweep`, name: `${unique} Sweep`, aoaStart: -4, aoaStop: 12, aoaStep: 1 })
    .returning({ id: sweepDefinitions.id });
  cleanupSweepDefinitionIds.add(sweep.id);
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${unique}-preset`,
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
      enabled: false,
    })
    .returning({ id: simulationPresets.id });
  cleanupPresetIds.add(preset.id);
  const resolved = await ensureSimulationPresetRevision(db, preset.id);
  expect(resolved).toBeTruthy();
  return { bcId: bc.id, presetRevisionId: resolved!.revision.id, reynolds, speed };
}

beforeAll(async () => {
  app = await buildServer();
  const chain = await createTestChain();

  const [cat] = await db
    .insert(categories)
    .values({ slug: unique, name: `${unique} cat`, path: unique, depth: 0, sortOrder: 997 })
    .returning({ id: categories.id });
  cleanupCategoryIds.add(cat.id);
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: unique,
      name: `${unique} Airfoil`,
      categoryId: cat.id,
      source: "test",
      points: [
        { x: 1, y: 0 },
        { x: 0.5, y: 0.06 },
        { x: 0, y: 0 },
        { x: 0.5, y: -0.06 },
        { x: 1, y: 0 },
      ],
    })
    .returning({ id: airfoils.id });
  cleanupAirfoilIds.add(airfoil.id);

  const jobs = await db
    .insert(simJobs)
    .values([
      { airfoilId: airfoil.id, bcIds: [chain.bcId], referenceChordM: 1, status: "done", totalCases: 3 },
      { airfoilId: airfoil.id, bcIds: [chain.bcId], referenceChordM: 1, status: "done", totalCases: 2 },
    ])
    .returning({ id: simJobs.id });
  jobAId = jobs[0].id;
  jobBId = jobs[1].id;
  jobs.forEach((j) => cleanupSimJobIds.add(j.id));

  const now = Date.now();
  // jobA: two rows solved "today" (seconds ago) + one solved 30 h ago (must be
  // excluded from solvedToday but still listed). jobB: one row solved today.
  const spec = [
    { jobId: jobAId, aoa: 4, cl: 0.62, solvedAt: new Date(now - 1_000) },
    { jobId: jobAId, aoa: 2, cl: 0.41, solvedAt: new Date(now - 2_000) },
    { jobId: jobAId, aoa: 0, cl: 0.2, solvedAt: new Date(now - 30 * 3600 * 1000) },
    { jobId: jobBId, aoa: 6, cl: 0.8, solvedAt: new Date(now - 3_000) },
  ];
  const inserted = await db
    .insert(results)
    .values(
      spec.map((s) => ({
        airfoilId: airfoil.id,
        bcId: chain.bcId,
        simulationPresetRevisionId: chain.presetRevisionId,
        simJobId: s.jobId,
        aoaDeg: s.aoa,
        status: "done" as const,
        source: "solved" as const,
        regime: "rans" as const,
        reynolds: chain.reynolds,
        speed: chain.speed,
        cl: s.cl,
        cd: 0.02,
        clCd: s.cl / 0.02,
        converged: true,
        solvedAt: s.solvedAt,
      })),
    )
    .returning({ id: results.id, aoaDeg: results.aoaDeg, simJobId: results.simJobId, solvedAt: results.solvedAt });
  inserted.forEach((row) => cleanupResultIds.add(row.id));
  jobARows = inserted
    .filter((row) => row.simJobId === jobAId)
    .map((row) => ({ id: row.id, aoaDeg: row.aoaDeg, solvedAt: row.solvedAt! }))
    .sort((a, b) => b.solvedAt.getTime() - a.solvedAt.getTime() || (a.id < b.id ? 1 : -1));

  // Classify the two newest jobA rows with the same language the portal uses
  // everywhere (accepted / needs_urans); the oldest row stays unclassified.
  const classified = await db
    .insert(resultClassifications)
    .values([
      {
        resultId: jobARows[0].id,
        airfoilId: airfoil.id,
        simulationPresetRevisionId: chain.presetRevisionId,
        aoaDeg: jobARows[0].aoaDeg,
        regime: "rans" as const,
        classifierVersion: "test-v1",
        state: "accepted" as const,
      },
      {
        resultId: jobARows[1].id,
        airfoilId: airfoil.id,
        simulationPresetRevisionId: chain.presetRevisionId,
        aoaDeg: jobARows[1].aoaDeg,
        regime: "rans" as const,
        classifierVersion: "test-v1",
        state: "needs_urans" as const,
      },
    ])
    .returning({ id: resultClassifications.id });
  classified.forEach((row) => cleanupClassificationIds.add(row.id));
}, 30_000);

afterAll(async () => {
  if (cleanupClassificationIds.size) {
    await db.delete(resultClassifications).where(inArray(resultClassifications.id, Array.from(cleanupClassificationIds)));
  }
  if (cleanupResultIds.size) await db.delete(results).where(inArray(results.id, Array.from(cleanupResultIds)));
  if (cleanupSimJobIds.size) await db.delete(simJobs).where(inArray(simJobs.id, Array.from(cleanupSimJobIds)));
  if (cleanupPresetIds.size) await db.delete(simulationPresets).where(inArray(simulationPresets.id, Array.from(cleanupPresetIds)));
  if (cleanupBoundaryConditionIds.size) {
    await db.delete(boundaryConditions).where(inArray(boundaryConditions.id, Array.from(cleanupBoundaryConditionIds)));
  }
  if (cleanupFlowConditionIds.size) await db.delete(flowConditions).where(inArray(flowConditions.id, Array.from(cleanupFlowConditionIds)));
  if (cleanupReferenceGeometryIds.size) {
    await db.delete(referenceGeometryProfiles).where(inArray(referenceGeometryProfiles.id, Array.from(cleanupReferenceGeometryIds)));
  }
  if (cleanupBoundaryProfileIds.size) await db.delete(boundaryProfiles).where(inArray(boundaryProfiles.id, Array.from(cleanupBoundaryProfileIds)));
  if (cleanupMeshProfileIds.size) await db.delete(meshProfiles).where(inArray(meshProfiles.id, Array.from(cleanupMeshProfileIds)));
  if (cleanupSolverProfileIds.size) await db.delete(solverProfiles).where(inArray(solverProfiles.id, Array.from(cleanupSolverProfileIds)));
  if (cleanupSchedulingProfileIds.size) {
    await db.delete(schedulingProfiles).where(inArray(schedulingProfiles.id, Array.from(cleanupSchedulingProfileIds)));
  }
  if (cleanupOutputProfileIds.size) await db.delete(outputProfiles).where(inArray(outputProfiles.id, Array.from(cleanupOutputProfileIds)));
  if (cleanupSweepDefinitionIds.size) await db.delete(sweepDefinitions).where(inArray(sweepDefinitions.id, Array.from(cleanupSweepDefinitionIds)));
  if (cleanupAirfoilIds.size) await db.delete(airfoils).where(inArray(airfoils.id, Array.from(cleanupAirfoilIds)));
  if (cleanupCategoryIds.size) await db.delete(categories).where(inArray(categories.id, Array.from(cleanupCategoryIds)));
  await app?.close();
  await sql.end();
}, 30_000);

type SolvedPointsBody = {
  items: Array<{
    resultId: string;
    simJobId: string | null;
    airfoilSlug: string;
    airfoilName: string;
    aoaDeg: number;
    speed: number | null;
    reynolds: number | null;
    cl: number | null;
    cd: number | null;
    clCd: number | null;
    classificationState: string | null;
    solvedAt: string;
  }>;
  nextCursor: string | null;
  solvedToday: number;
};

async function getSolvedPoints(qs: string): Promise<SolvedPointsBody> {
  const res = await app.inject({ method: "GET", url: `/api/admin/solved-points${qs}` });
  expect(res.statusCode).toBe(200);
  return res.json() as SolvedPointsBody;
}

describe("GET /api/admin/solved-points", () => {
  it("scoped to a job: newest-first ordering, full row payload, honest scoped solvedToday", async () => {
    const body = await getSolvedPoints(`?jobId=${jobAId}`);
    expect(body.items.map((i) => i.resultId)).toEqual(jobARows.map((r) => r.id));
    // solvedAt strictly newest-first
    const times = body.items.map((i) => new Date(i.solvedAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // solvedToday counts ONLY today's rows in this scope (the 30 h old row is listed but not counted).
    expect(body.solvedToday).toBe(2);
    expect(body.nextCursor).toBeNull();
    const first = body.items[0];
    expect(first.airfoilSlug).toBe(unique);
    expect(first.airfoilName).toBe(`${unique} Airfoil`);
    expect(first.aoaDeg).toBe(4);
    expect(first.cl).toBeCloseTo(0.62, 6);
    expect(first.cd).toBeCloseTo(0.02, 6);
    expect(first.clCd).toBeCloseTo(31, 4);
    expect(first.reynolds).toBe(400000);
    expect(typeof first.speed).toBe("number");
    expect(first.classificationState).toBe("accepted");
    expect(body.items[1].classificationState).toBe("needs_urans");
    expect(body.items[2].classificationState).toBeNull();
  });

  it("keyset cursor pages without overlap and terminates", async () => {
    const page1 = await getSolvedPoints(`?jobId=${jobAId}&limit=2`);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    expect(parseSolvedPointsCursor(page1.nextCursor!)).not.toBeNull();
    const page2 = await getSolvedPoints(`?jobId=${jobAId}&limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`);
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const ids1 = new Set(page1.items.map((i) => i.resultId));
    for (const item of page2.items) expect(ids1.has(item.resultId)).toBe(false);
    expect([...page1.items, ...page2.items].map((i) => i.resultId)).toEqual(jobARows.map((r) => r.id));
    // The scoped count is page-independent: it always describes the scope, not the page.
    expect(page2.solvedToday).toBe(2);
  });

  it("jobId scoping separates jobs", async () => {
    const bodyB = await getSolvedPoints(`?jobId=${jobBId}`);
    expect(bodyB.items).toHaveLength(1);
    expect(bodyB.items[0].aoaDeg).toBe(6);
    expect(bodyB.solvedToday).toBe(1);
  });

  it("global list is sorted newest-first and includes the seeded rows within the global count", async () => {
    // Shared dev DB: other real solved rows may exist — assert shape + order +
    // that the global today-count is at least what this suite seeded today.
    const body = await getSolvedPoints(`?limit=50`);
    const times = body.items.map((i) => new Date(i.solvedAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(body.solvedToday).toBeGreaterThanOrEqual(3);
    for (const item of body.items) {
      expect(typeof item.resultId).toBe("string");
      expect(typeof item.airfoilSlug).toBe("string");
      expect(typeof item.solvedAt).toBe("string");
    }
  });

  it("rejects malformed cursors and limits with 400", async () => {
    const badCursor = await app.inject({ method: "GET", url: "/api/admin/solved-points?cursor=not-a-cursor" });
    expect(badCursor.statusCode).toBe(400);
    expect(String(badCursor.json().error)).toContain("cursor");
    const badLimit = await app.inject({ method: "GET", url: "/api/admin/solved-points?limit=500" });
    expect(badLimit.statusCode).toBe(400);
    const badJob = await app.inject({ method: "GET", url: "/api/admin/solved-points?jobId=nope" });
    expect(badJob.statusCode).toBe(400);
  });
});
