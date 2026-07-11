import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MEDIA_DIR = join(tmpdir(), `xff-sweeper-remote-${process.pid}-${Date.now().toString(36)}`);
mkdirSync(MEDIA_DIR, { recursive: true });
process.env.MEDIA_DIR = MEDIA_DIR;

const dbSchema = await import("@aerodb/db");
const { ensureSimulationPresetRevision } = await import("@aerodb/db/simulation-setup");
const { remoteSolverTick } = await import("../src/remote-solver");

const {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  createClient,
  flowConditions,
  mediums,
  meshProfiles,
  outputProfiles,
  polarFitSets,
  referenceGeometryProfiles,
  resultAttempts,
  resultMedia,
  results,
  schedulingProfiles,
  simJobs,
  simulationPresets,
  solverEvidenceArtifacts,
  solverProfiles,
  syncApiSettings,
  sweepDefinitions,
} = dbSchema;

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-remote-validation-${process.pid}-${Date.now().toString(36)}`;
const UPSTREAM = "http://hub.test/api/sync/v1";
const SECRET = `${PREFIX}-secret`;
const CHORD = 0.37;
const SPEED = 24.5;
const contour = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.06 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.05 },
  { x: 1, y: 0 },
];

let savedSettings: typeof syncApiSettings.$inferSelect | null = null;
let categoryId = "";
let airfoilId = "";
let airfoilSlug = "";
let mediumId = "";
let bcId = "";
let flowId = "";
let referenceGeometryId = "";
let presetId = "";
let revisionId = "";
let reynolds = 0;
let mach: number | null = null;
const profileIds = { boundary: "", mesh: "", solver: "", scheduling: "", output: "", sweep: "" };

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function deleteIds(table: any, column: any, ids: string[]) {
  if (ids.length) await db.delete(table).where(inArray(column, ids));
}

async function configureRemoteSolver() {
  await db.insert(syncApiSettings).values({ id: 1 }).onConflictDoNothing();
  const [settings] = await db.select().from(syncApiSettings).where(eq(syncApiSettings.id, 1)).limit(1);
  savedSettings = savedSettings ?? settings ?? null;
  await db
    .update(syncApiSettings)
    .set({
      enabled: true,
      secret: SECRET,
      upstreamBaseUrl: UPSTREAM,
      upstreamSecret: SECRET,
      remoteSolverEnabled: true,
      remoteSolverCpuBudget: 2,
      remoteSolverClaimSize: 3,
      remoteSolverRegisteredId: randomUUID(),
      remoteSolverLastStatus: "idle",
      remoteSolverLastError: null,
      remoteSolverLastPushAt: null,
      updatedAt: new Date(),
    })
    .where(eq(syncApiSettings.id, 1));
}

async function restoreRemoteSolver() {
  if (savedSettings) {
    const { id: _id, createdAt: _createdAt, ...rest } = savedSettings;
    await db
      .update(syncApiSettings)
      .set({ ...rest, updatedAt: new Date() })
      .where(eq(syncApiSettings.id, 1));
  } else {
    await db.delete(syncApiSettings).where(eq(syncApiSettings.id, 1));
  }
}

async function createFixture() {
  const [air] = await db.select().from(mediums).where(eq(mediums.slug, "air")).limit(1);
  if (!air) throw new Error("seeded air medium required");
  mediumId = air.id;
  reynolds = Math.round((SPEED * CHORD) / air.kinematicViscosity);
  mach = air.speedOfSound ? SPEED / air.speedOfSound : null;

  const [cat] = await db.insert(categories).values({ slug: `${PREFIX}-cat`, name: `${PREFIX} cat`, path: `${PREFIX}-cat`, depth: 0 }).returning();
  categoryId = cat.id;
  const [foil] = await db
    .insert(airfoils)
    .values({ slug: `${PREFIX}-foil`, name: `${PREFIX} foil`, categoryId, points: contour, pointFormat: "normalized", isSymmetric: false })
    .returning();
  airfoilId = foil.id;
  airfoilSlug = foil.slug;

  const [bc] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${PREFIX}-bc`,
      name: `${PREFIX} BC`,
      mediumId,
      reynolds,
      referenceChordM: CHORD,
      temperatureK: air.refTemperatureK,
      pressurePa: air.refPressurePa,
      speedMps: SPEED,
      density: air.density,
      dynamicViscosity: air.dynamicViscosity,
      kinematicViscosity: air.kinematicViscosity,
      mach,
      enabled: true,
    })
    .returning({ id: boundaryConditions.id });
  bcId = bc.id;
  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${PREFIX}-flow`,
      name: `${PREFIX} flow`,
      mediumId,
      temperatureK: air.refTemperatureK,
      pressurePa: air.refPressurePa,
      speedMps: SPEED,
      density: air.density,
      dynamicViscosity: air.dynamicViscosity,
      kinematicViscosity: air.kinematicViscosity,
      mach,
    })
    .returning();
  flowId = flow.id;
  const [reference] = await db
    .insert(referenceGeometryProfiles)
    .values({ slug: `${PREFIX}-reference`, name: `${PREFIX} reference`, geometryType: "airfoil_2d", referenceLengthKind: "chord", referenceLengthM: CHORD })
    .returning();
  referenceGeometryId = reference.id;
  const [boundary] = await db.insert(boundaryProfiles).values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` }).returning();
  const [mesh] = await db.insert(meshProfiles).values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` }).returning();
  const [solver] = await db.insert(solverProfiles).values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` }).returning();
  const [scheduling] = await db.insert(schedulingProfiles).values({ slug: `${PREFIX}-scheduling`, name: `${PREFIX} scheduling` }).returning();
  const [output] = await db.insert(outputProfiles).values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` }).returning();
  const [sweep] = await db.insert(sweepDefinitions).values({ slug: `${PREFIX}-sweep`, name: `${PREFIX} sweep`, aoaList: [810.001, 811.001, 812.001] }).returning();
  profileIds.boundary = boundary.id;
  profileIds.mesh = mesh.id;
  profileIds.solver = solver.id;
  profileIds.scheduling = scheduling.id;
  profileIds.output = output.id;
  profileIds.sweep = sweep.id;

  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${PREFIX}-preset`,
      name: `${PREFIX} preset`,
      flowConditionId: flowId,
      referenceGeometryProfileId: referenceGeometryId,
      boundaryProfileId: profileIds.boundary,
      meshProfileId: profileIds.mesh,
      solverProfileId: profileIds.solver,
      schedulingProfileId: profileIds.scheduling,
      outputProfileId: profileIds.output,
      sweepDefinitionId: profileIds.sweep,
      legacyBoundaryConditionId: bcId,
      enabled: false,
    })
    .returning({ id: simulationPresets.id });
  presetId = preset.id;
  const resolved = await ensureSimulationPresetRevision(db, presetId);
  if (!resolved) throw new Error("simulation preset revision required");
  revisionId = resolved.revision.id;
}

function writeMedia(storageKey: string, label: string) {
  const buf = Buffer.from(`${PREFIX}:${label}`);
  const full = join(MEDIA_DIR, storageKey);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, buf);
  return { storageKey, sha256: sha256(buf), byteSize: buf.byteLength };
}

async function cleanupRemoteRows() {
  if (!revisionId) return;
  await db.delete(solverEvidenceArtifacts).where(eq(solverEvidenceArtifacts.airfoilId, airfoilId));
  await db.delete(resultAttempts).where(eq(resultAttempts.simulationPresetRevisionId, revisionId));
  await db.delete(polarFitSets).where(eq(polarFitSets.simulationPresetRevisionId, revisionId));
  await db.delete(results).where(eq(results.simulationPresetRevisionId, revisionId));
  await db.delete(simJobs).where(eq(simJobs.simulationPresetRevisionId, revisionId));
}

async function seedDoneRemoteJob(label: string, aoas: number[], wave = 2) {
  const engineJobId = `${PREFIX}-${label}`;
  const promiseId = randomUUID();
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      referenceChordM: CHORD,
      wave,
      status: "done",
      engineJobId,
      totalCases: aoas.length,
      completedCases: aoas.length,
      ingestedAt: new Date(),
      finishedAt: new Date(),
      requestPayload: {
        syncPromiseId: promiseId,
        speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach }],
      },
    })
    .returning();

  for (const [idx, aoaDeg] of aoas.entries()) {
    const [row] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        status: "done",
        source: "solved",
        regime: "rans",
        reynolds,
        speed: SPEED,
        chord: CHORD,
        mach,
        cl: 0.5 + idx / 10,
        cd: 0.012 + idx / 1000,
        cm: -0.02,
        clCd: 40 + idx,
        stalled: false,
        unsteady: false,
        converged: true,
        simJobId: job.id,
        engineJobId,
        engineCaseSlug: `aoa_${idx}`,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    const stored = writeMedia(`jobs/${engineJobId}/cases/${idx}/pressure.png`, `${label}:${idx}`);
    await db.insert(resultMedia).values({
      resultId: row.id,
      kind: "image",
      field: `pressure_${idx}`,
      role: "instantaneous",
      storageKey: stored.storageKey,
      mimeType: "image/png",
      width: 4,
      height: 4,
    });
  }

  return job;
}

async function readJobPayload(jobId: string) {
  const [row] = await db.select({ requestPayload: simJobs.requestPayload }).from(simJobs).where(eq(simJobs.id, jobId)).limit(1);
  return (row?.requestPayload ?? {}) as { remotePushedAt?: string };
}

function stubFetch(opts: { failPolarIndex?: number; observeJobId?: string } = {}) {
  let polarIndex = 0;
  const pushedAtDuringPosts: (string | undefined)[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (opts.observeJobId && (url.endsWith("/polars") || url.includes("/complete"))) {
      pushedAtDuringPosts.push((await readJobPayload(opts.observeJobId)).remotePushedAt);
    }
    if (url.endsWith("/polars")) {
      polarIndex += 1;
      if (opts.failPolarIndex === polarIndex) return new Response(JSON.stringify({ error: "chunk failed" }), { status: 500 });
      return new Response(JSON.stringify({ imported: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/complete")) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/heartbeat")) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/solvers/register")) return new Response(JSON.stringify({ solver: { id: randomUUID() } }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/sweeps/claim")) return new Response(JSON.stringify({ promise: null }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, pushedAtDuringPosts };
}

function requests(fetchMock: ReturnType<typeof vi.fn>, suffix: string) {
  return fetchMock.mock.calls
    .map(([url, init]) => ({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null }))
    .filter((call) => call.url.endsWith(suffix));
}

beforeAll(async () => {
  await createFixture();
  await configureRemoteSolver();
});

beforeEach(async () => {
  await cleanupRemoteRows();
  await configureRemoteSolver();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await cleanupRemoteRows();
});

afterAll(async () => {
  await cleanupRemoteRows();
  await restoreRemoteSolver();
  await deleteIds(simulationPresets, simulationPresets.id, [presetId].filter(Boolean));
  await deleteIds(boundaryConditions, boundaryConditions.id, [bcId].filter(Boolean));
  await deleteIds(flowConditions, flowConditions.id, [flowId].filter(Boolean));
  await deleteIds(referenceGeometryProfiles, referenceGeometryProfiles.id, [referenceGeometryId].filter(Boolean));
  await deleteIds(boundaryProfiles, boundaryProfiles.id, [profileIds.boundary].filter(Boolean));
  await deleteIds(meshProfiles, meshProfiles.id, [profileIds.mesh].filter(Boolean));
  await deleteIds(solverProfiles, solverProfiles.id, [profileIds.solver].filter(Boolean));
  await deleteIds(schedulingProfiles, schedulingProfiles.id, [profileIds.scheduling].filter(Boolean));
  await deleteIds(outputProfiles, outputProfiles.id, [profileIds.output].filter(Boolean));
  await deleteIds(sweepDefinitions, sweepDefinitions.id, [profileIds.sweep].filter(Boolean));
  await deleteIds(airfoils, airfoils.id, [airfoilId].filter(Boolean));
  await deleteIds(categories, categories.id, [categoryId].filter(Boolean));
  await sql.end();
  rmSync(MEDIA_DIR, { recursive: true, force: true });
});

describe("remote solver push validation regressions", () => {
  it("MUST-CATCH: pushes one completed result per /polars request and stamps remotePushedAt only after /complete", async () => {
    const job = await seedDoneRemoteJob("chunking", [810.001, 811.001, 812.001]);
    const { fetchMock, pushedAtDuringPosts } = stubFetch({ observeJobId: job.id });

    await remoteSolverTick(db, {} as never);

    const polars = requests(fetchMock, "/polars");
    expect(polars).toHaveLength(3);
    expect(polars.map((call) => call.body.results.length)).toEqual([1, 1, 1]);
    expect(polars.map((call) => call.body.airfoilSlug)).toEqual([airfoilSlug, airfoilSlug, airfoilSlug]);
    expect(requests(fetchMock, `/sweeps/${(job.requestPayload as { syncPromiseId: string }).syncPromiseId}/complete`)).toHaveLength(1);
    expect(pushedAtDuringPosts.every((stamp) => stamp === undefined)).toBe(true);
    expect((await readJobPayload(job.id)).remotePushedAt).toEqual(expect.any(String));
  });

  it("leaves remotePushedAt unstamped on a mid-sequence chunk failure and retries the chunks on the next tick", async () => {
    const job = await seedDoneRemoteJob("chunk-retry", [820.001, 821.001, 822.001]);
    const failed = stubFetch({ failPolarIndex: 2 });

    await remoteSolverTick(db, {} as never);

    expect(requests(failed.fetchMock, "/polars")).toHaveLength(2);
    expect(requests(failed.fetchMock, `/sweeps/${(job.requestPayload as { syncPromiseId: string }).syncPromiseId}/complete`)).toHaveLength(0);
    expect((await readJobPayload(job.id)).remotePushedAt).toBeUndefined();
    const [settingsAfterFailure] = await db.select().from(syncApiSettings).where(eq(syncApiSettings.id, 1)).limit(1);
    expect(settingsAfterFailure.remoteSolverLastStatus).toBe("error");
    expect(settingsAfterFailure.remoteSolverLastError).toContain("remote polar push failed (500)");

    vi.unstubAllGlobals();
    const retried = stubFetch();
    await remoteSolverTick(db, {} as never);

    expect(requests(retried.fetchMock, "/polars")).toHaveLength(3);
    expect(requests(retried.fetchMock, `/sweeps/${(job.requestPayload as { syncPromiseId: string }).syncPromiseId}/complete`)).toHaveLength(1);
    expect((await readJobPayload(job.id)).remotePushedAt).toEqual(expect.any(String));
  });

  it("MUST-CATCH: terminal wave-2 children unblock a wave-1 parent push, while running children still delay it", async () => {
    const unblocked = await seedDoneRemoteJob("done-child-unblocks", [830.001], 1);
    await db.insert(simJobs).values({
      parentJobId: unblocked.id,
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      referenceChordM: CHORD,
      wave: 2,
      status: "done",
      engineJobId: `${PREFIX}-done-child`,
      totalCases: 1,
      completedCases: 1,
      finishedAt: new Date(),
    });
    const doneChildFetch = stubFetch();

    await remoteSolverTick(db, {} as never);

    expect(requests(doneChildFetch.fetchMock, "/polars")).toHaveLength(1);
    expect((await readJobPayload(unblocked.id)).remotePushedAt).toEqual(expect.any(String));

    vi.unstubAllGlobals();
    await cleanupRemoteRows();
    const blocked = await seedDoneRemoteJob("running-child-blocks", [831.001], 1);
    await db.insert(simJobs).values({
      parentJobId: blocked.id,
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      referenceChordM: CHORD,
      wave: 2,
      status: "running",
      engineJobId: `${PREFIX}-running-child`,
      totalCases: 1,
      completedCases: 0,
      submittedAt: new Date(),
    });
    const runningChildFetch = stubFetch();

    await remoteSolverTick(db, {} as never);

    expect(requests(runningChildFetch.fetchMock, "/polars")).toHaveLength(0);
    expect(requests(runningChildFetch.fetchMock, "/complete")).toHaveLength(0);
    expect((await readJobPayload(blocked.id)).remotePushedAt).toBeUndefined();
  });
});
