// Integration flow for batched campaign jobs (execution-efficiency decision
// 2026-07-04): launch a small multi-speed campaign via materializeCampaignLaunch,
// compose ONE batched job (single mesh chord, all speeds, shared angle list,
// conditionMap), ingest a fake-engine multi-polar result, and verify every
// point lands terminal under the RIGHT pinned revision with correct progress
// counters — plus the per-condition wave-2 targeted child when a point is
// rejected. Follows the sweeper.test.ts live-DB pattern (scoped rows, full
// cleanup in afterAll).

import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  createClient,
  findCampaignGapBatch,
  flowConditions,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  outputProfiles,
  polarFitSets,
  referenceGeometryProfiles,
  resultAttempts,
  resultClassifications,
  results,
  simCampaignPoints,
  simCampaignProgress,
  simCampaigns,
  simJobs,
  simulationPresetRevisions,
  simulationPresets,
  solverProfiles,
  sweepDefinitions,
  sweeperState,
} from "@aerodb/db";
import { type EngineClient, type JobResult, type JobStatus, type PolarRequest } from "@aerodb/engine-client";
import { and, asc, eq, inArray, like, sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConditionMapEntry } from "../src/ingest";
import { submitCampaignBatch } from "../src/loop";
import { reconcile, submitUransRetryForJob } from "../src/reconcile";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-batch-${process.pid}-${Date.now().toString(36)}`;

const ANGLES = [6, 7, 8, 9, 10, 11];
const SPEEDS = [10, 20, 30];
const CHORD = 0.2;
const REJECTED_AOA = 11;

let campaignId = "";
let airfoilId = "";
let categoryId = "";
let mediumId = "";
const profileIds = { boundary: "", mesh: "", solver: "", output: "" };
let restoreSweeperEnabled: boolean | null = null;

const camberedPoints = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

beforeAll(async () => {
  const [state] = await db.select({ enabled: sweeperState.enabled }).from(sweeperState).where(eq(sweeperState.id, 1)).limit(1);
  restoreSweeperEnabled = state?.enabled ?? false;
  await db
    .insert(sweeperState)
    .values({ id: 1, enabled: false })
    .onConflictDoUpdate({ target: sweeperState.id, set: { enabled: false } });

  const [cat] = await db
    .insert(categories)
    .values({ slug: `${PREFIX}-cat`, name: `${PREFIX} cat`, path: `${PREFIX}-cat`, depth: 0 })
    .returning();
  categoryId = cat.id;
  const [airfoil] = await db
    .insert(airfoils)
    .values({ slug: `${PREFIX}-cambered`, name: `${PREFIX} cambered`, categoryId: cat.id, points: camberedPoints, isSymmetric: false })
    .returning();
  airfoilId = airfoil.id;
  const [medium] = await db
    .insert(mediums)
    .values({
      slug: `${PREFIX}-air`,
      name: `${PREFIX} air`,
      phase: "gas",
      density: 1.225,
      viscosityModel: "constant",
      constantDynamicViscosity: 1.789e-5,
      dynamicViscosity: 1.789e-5,
      kinematicViscosity: 1.789e-5 / 1.225,
      speedOfSound: 340.3,
    })
    .returning();
  mediumId = medium.id;
  const [boundary] = await db.insert(boundaryProfiles).values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` }).returning();
  const [mesh] = await db.insert(meshProfiles).values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` }).returning();
  const [solver] = await db.insert(solverProfiles).values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` }).returning();
  const [output] = await db.insert(outputProfiles).values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` }).returning();
  profileIds.boundary = boundary.id;
  profileIds.mesh = mesh.id;
  profileIds.solver = solver.id;
  profileIds.output = output.id;
});

afterAll(async () => {
  // Order matters: evidence → results → jobs → campaign-created registry rows
  // → campaign (cascades points/conditions/progress) → presets/support rows.
  const campaignPresets = campaignId
    ? await db
        .select({ id: simulationPresets.id, legacyId: simulationPresets.legacyBoundaryConditionId })
        .from(simulationPresets)
        .where(like(simulationPresets.slug, `campaign-${PREFIX.toLowerCase()}%`))
    : [];
  const revisionRows = campaignPresets.length
    ? await db
        .select({ id: simulationPresetRevisions.id })
        .from(simulationPresetRevisions)
        .where(inArray(simulationPresetRevisions.presetId, campaignPresets.map((p) => p.id)))
    : [];
  const revisionIds = revisionRows.map((r) => r.id);
  if (revisionIds.length) {
    await db.delete(polarFitSets).where(inArray(polarFitSets.simulationPresetRevisionId, revisionIds));
    await db.delete(resultClassifications).where(inArray(resultClassifications.simulationPresetRevisionId, revisionIds));
    await db.delete(resultAttempts).where(inArray(resultAttempts.simulationPresetRevisionId, revisionIds));
    await db.delete(results).where(inArray(results.simulationPresetRevisionId, revisionIds));
    await db.delete(simJobs).where(inArray(simJobs.simulationPresetRevisionId, revisionIds));
  }
  // Capture campaign-created registry rows BEFORE the campaign delete nulls
  // their created_by_campaign_id (ON DELETE SET NULL).
  const campaignFlowIds = campaignId
    ? (await db.select({ id: flowConditions.id }).from(flowConditions).where(eq(flowConditions.createdByCampaignId, campaignId))).map((r) => r.id)
    : [];
  const campaignGeoIds = campaignId
    ? ((await db.execute(dsql`SELECT id FROM reference_geometry_profiles WHERE created_by_campaign_id = ${campaignId}`)) as unknown as { id: string }[]).map((r) => r.id)
    : [];
  if (campaignId) {
    await db.delete(simJobs).where(eq(simJobs.campaignId, campaignId));
    await db.delete(simCampaigns).where(eq(simCampaigns.id, campaignId));
  }
  if (campaignPresets.length) {
    await db.delete(simulationPresets).where(inArray(simulationPresets.id, campaignPresets.map((p) => p.id)));
    const legacyIds = campaignPresets.map((p) => p.legacyId).filter((x): x is string => Boolean(x));
    if (legacyIds.length) await db.delete(boundaryConditions).where(inArray(boundaryConditions.id, legacyIds));
  }
  if (campaignFlowIds.length) await db.delete(flowConditions).where(inArray(flowConditions.id, campaignFlowIds));
  if (campaignGeoIds.length) {
    await db.execute(dsql`DELETE FROM reference_geometry_profiles WHERE id = ANY(ARRAY[${dsql.join(campaignGeoIds.map((id) => dsql`${id}::uuid`), dsql`, `)}])`);
  }
  await db.delete(sweepDefinitions).where(like(sweepDefinitions.slug, `campaign-${PREFIX.toLowerCase()}%`));
  if (profileIds.boundary) await db.delete(boundaryProfiles).where(eq(boundaryProfiles.id, profileIds.boundary));
  if (profileIds.mesh) await db.delete(meshProfiles).where(eq(meshProfiles.id, profileIds.mesh));
  if (profileIds.solver) await db.delete(solverProfiles).where(eq(solverProfiles.id, profileIds.solver));
  if (profileIds.output) await db.delete(outputProfiles).where(eq(outputProfiles.id, profileIds.output));
  if (mediumId) await db.delete(mediums).where(eq(mediums.id, mediumId));
  if (airfoilId) await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
  if (categoryId) await db.delete(categories).where(eq(categories.id, categoryId));
  if (restoreSweeperEnabled !== null) {
    await db
      .insert(sweeperState)
      .values({ id: 1, enabled: restoreSweeperEnabled })
      .onConflictDoUpdate({ target: sweeperState.id, set: { enabled: restoreSweeperEnabled } });
  }
  await sql.end();
});

function conditionMapOf(payload: unknown): ConditionMapEntry[] {
  return ((payload as { conditionMap?: ConditionMapEntry[] })?.conditionMap ?? []) as ConditionMapEntry[];
}

describe("batched campaign jobs: one mesh per airfoil-chord, all speeds warm-started", () => {
  let jobId = "";
  let entries: ConditionMapEntry[] = [];
  let submittedRequests: PolarRequest[] = [];

  it("launches a multi-speed campaign and finds ONE batched head group", async () => {
    const launch = await materializeCampaignLaunch(db, {
      name: `${PREFIX} batch campaign`,
      priority: 9,
      idempotencyKey: `${PREFIX}-idem-key`,
      airfoilIds: [airfoilId],
      plan: {
        mediumId,
        ambients: [[288.15, 101325]],
        speedsMps: SPEEDS,
        chordsM: [CHORD],
        spanM: 1,
        areaMode: "derived",
        excludedConditions: [],
        baseSweep: { fromDeg: null, toDeg: null, stepDeg: null, listDeg: ANGLES },
        objectives: {
          ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
          clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
        },
        numerics: {
          boundaryProfileId: profileIds.boundary,
          meshProfileId: profileIds.mesh,
          solverProfileId: profileIds.solver,
          outputProfileId: profileIds.output,
        },
      },
    });
    campaignId = launch.campaign.id;
    expect(launch.replayed).toBe(false);
    expect(launch.conditionCount).toBe(SPEEDS.length);

    const batch = await findCampaignGapBatch(db, { limit: 500, campaignIds: [campaignId] });
    expect(batch).not.toBeNull();
    expect(batch!.campaignId).toBe(campaignId);
    expect(batch!.airfoilId).toBe(airfoilId);
    expect(batch!.chord).toBe(CHORD);
    expect(batch!.angles).toEqual(ANGLES);
    // All three speeds of the one ambient/chord/angle-set group, reynolds ASC.
    expect(batch!.entries.length).toBe(SPEEDS.length);
    expect(batch!.entries.map((e) => e.speed)).toEqual(SPEEDS);
    expect(batch!.entries[0].reynolds).toBeLessThan(batch!.entries[1].reynolds);
    expect(batch!.entries[1].reynolds).toBeLessThan(batch!.entries[2].reynolds);
    expect(new Set(batch!.entries.map((e) => e.revisionId)).size).toBe(SPEEDS.length);
    expect(batch!.reynolds).toBe(batch!.entries[0].reynolds);
    expect(batch!.effectivePriority).toBe(9);
  }, 60000);

  it("composes + claims + submits ONE batched job with a correct conditionMap", async () => {
    const batch = (await findCampaignGapBatch(db, { limit: 500, campaignIds: [campaignId] }))!;
    submittedRequests = [];
    const composeEngine = {
      submitPolar: async (request: PolarRequest): Promise<JobStatus> => {
        submittedRequests.push(request);
        return { job_id: `${PREFIX}-engine-parent`, state: "pending", total_cases: SPEEDS.length * ANGLES.length, completed_cases: 0 };
      },
    } as unknown as EngineClient;

    const submitted = await submitCampaignBatch(db, composeEngine, batch, 0, 0);
    expect(submitted).toBe(true);
    expect(submittedRequests.length).toBe(1);
    const request = submittedRequests[0];
    // One mesh (single chord), all speeds, ONE shared angle list, warm-started wave 1.
    expect(request.chord_lengths).toEqual([CHORD]);
    expect(request.speeds).toEqual(SPEEDS);
    expect(request.aoa?.angles).toEqual(ANGLES);
    expect(request.solver?.warm_start).toBe(true);
    expect(request.solver?.force_transient).toBe(false);

    const jobs = await db.select().from(simJobs).where(eq(simJobs.campaignId, campaignId));
    expect(jobs.length).toBe(1);
    const job = jobs[0];
    jobId = job.id;
    expect(job.jobKind).toBe("sweep");
    expect(job.totalCases).toBe(SPEEDS.length * ANGLES.length);
    entries = conditionMapOf(job.requestPayload);
    expect(entries.length).toBe(SPEEDS.length);
    expect(entries.map((e) => e.speed)).toEqual(SPEEDS);
    expect(new Set(entries.map((e) => e.conditionId)).size).toBe(SPEEDS.length);
    // Compat anchor: job revision = min-Re entry revision.
    expect(job.simulationPresetRevisionId).toBe(entries[0].revisionId);

    // Claims: every entry's angles queued under its OWN revision + bc, with
    // the campaign priority band stamped.
    for (const entry of entries) {
      const claimed = await db
        .select({ status: results.status, simJobId: results.simJobId, bcId: results.bcId, priority: results.priority })
        .from(results)
        .where(and(eq(results.airfoilId, airfoilId), eq(results.simulationPresetRevisionId, entry.revisionId)));
      expect(claimed.length).toBe(ANGLES.length);
      expect(claimed.every((r) => r.status === "queued" && r.simJobId === job.id && r.bcId === entry.bcId)).toBe(true);
      expect(claimed.every((r) => r.priority === 9)).toBe(true);
    }
  }, 60000);

  it("ingests a multi-polar result: points terminal under the RIGHT revisions, counters correct", async () => {
    const nu = 1.789e-5 / 1.225;
    const result: JobResult = {
      job_id: `${PREFIX}-engine-parent`,
      state: "completed",
      polars: SPEEDS.map((speed) => {
        const solvedAngles = speed === 30 ? ANGLES.filter((a) => a !== REJECTED_AOA) : ANGLES;
        return {
          speed,
          chord: CHORD,
          reynolds: Math.round((speed * CHORD) / nu),
          mach: speed / 340.3,
          points: solvedAngles.map((aoa, i) => ({
            aoa_deg: aoa,
            cl: 0.5 + i * 0.05,
            cd: 0.02 + i * 0.002,
            cm: -0.02,
            cl_cd: (0.5 + i * 0.05) / (0.02 + i * 0.002),
            unsteady: false,
            converged: true,
            first_order_fallback: false,
            images: {},
          })),
          attempts:
            speed === 30
              ? [
                  {
                    aoa_deg: REJECTED_AOA,
                    cl: 0.4,
                    cd: 0.3,
                    cm: -0.1,
                    cl_cd: 1.3,
                    unsteady: false,
                    converged: false,
                    first_order_fallback: false,
                    images: {},
                    error: "RANS did not converge",
                  },
                ]
              : [],
        };
      }),
    };
    const childRequests: PolarRequest[] = [];
    const ingestEngine = {
      getQueue: async () => {
        throw new Error("queue unavailable in test");
      },
      getJob: async (): Promise<JobStatus> => ({
        job_id: `${PREFIX}-engine-parent`,
        state: "completed",
        total_cases: SPEEDS.length * ANGLES.length,
        completed_cases: SPEEDS.length * ANGLES.length,
      }),
      getResult: async () => result,
      submitPolar: async (request: PolarRequest): Promise<JobStatus> => {
        childRequests.push(request);
        return { job_id: `${PREFIX}-engine-child`, state: "pending", total_cases: request.aoa?.angles?.length ?? 0, completed_cases: 0 };
      },
      fileUrl: (id: string, relPath: string) => `http://engine.test/jobs/${id}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, ingestEngine, { jobIds: [jobId], skipFailedRecovery: true });

    const [job] = await db.select().from(simJobs).where(eq(simJobs.id, jobId));
    expect(job.status).toBe("done");

    // Every solved polar point landed under its OWN pinned revision.
    for (const entry of entries) {
      const solvedAngles = entry.speed === 30 ? ANGLES.filter((a) => a !== REJECTED_AOA) : ANGLES;
      const rows = await db
        .select({ aoaDeg: results.aoaDeg, status: results.status, speed: results.speed, bcId: results.bcId })
        .from(results)
        .where(
          and(
            eq(results.airfoilId, airfoilId),
            eq(results.simulationPresetRevisionId, entry.revisionId),
            eq(results.status, "done"),
          ),
        )
        .orderBy(asc(results.aoaDeg));
      expect(rows.map((r) => r.aoaDeg)).toEqual(solvedAngles);
      expect(rows.every((r) => r.speed === entry.speed && r.bcId === entry.bcId)).toBe(true);

      const points = await db
        .select({ aoaDeg: simCampaignPoints.aoaDeg, state: simCampaignPoints.state, resultId: simCampaignPoints.resultId })
        .from(simCampaignPoints)
        .where(and(eq(simCampaignPoints.campaignId, campaignId), eq(simCampaignPoints.conditionId, entry.conditionId)))
        .orderBy(asc(simCampaignPoints.aoaDeg));
      expect(points.length).toBe(ANGLES.length);
      for (const point of points) {
        if (entry.speed === 30 && point.aoaDeg === REJECTED_AOA) {
          expect(point.state).toBe("requested");
        } else {
          expect(point.state).toBe("terminal");
          expect(point.resultId).not.toBeNull();
        }
      }

      const [progress] = await db
        .select()
        .from(simCampaignProgress)
        .where(
          and(
            eq(simCampaignProgress.campaignId, campaignId),
            eq(simCampaignProgress.conditionId, entry.conditionId),
            eq(simCampaignProgress.airfoilId, airfoilId),
          ),
        );
      expect(progress).toBeTruthy();
      expect(progress.solved).toBe(solvedAngles.length);
      expect(progress.requested).toBe(entry.speed === 30 ? 1 : 0);
      expect(progress.failed).toBe(0);
    }

    // Wave-2: exactly ONE per-condition single-revision targeted child for the
    // rejected point — never one per healthy condition, never whole-polar.
    const children = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, jobId), eq(simJobs.wave, 2)));
    expect(children.length).toBe(1);
    const child = children[0];
    const rejectedEntry = entries.find((e) => e.speed === 30)!;
    expect(child.simulationPresetRevisionId).toBe(rejectedEntry.revisionId);
    expect(child.jobKind).toBe("targeted");
    expect(child.campaignId).toBe(campaignId);
    expect(child.totalCases).toBe(1);
    // MUST-CATCH: the post-submit stamp has to reach the freshly composed
    // (pending) child — a child stuck `pending` with no engineJobId would
    // never be polled or ingested.
    expect(child.status).toBe("submitted");
    expect(child.engineJobId).toBe(`${PREFIX}-engine-child`);
    expect((child.requestPayload as { conditionId?: string }).conditionId).toBe(rejectedEntry.conditionId);
    expect((child.requestPayload as { retryMode?: string }).retryMode).toBe("invalid-rans-points");
    expect(childRequests.length).toBe(1);
    expect(childRequests[0].speeds).toEqual([30]);
    expect(childRequests[0].aoa?.angles).toEqual([REJECTED_AOA]);
    expect(childRequests[0].solver?.force_transient).toBe(true);

    // The rejected point's results row is re-claimed by the child under the
    // SAME revision.
    const [requeued] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, rejectedEntry.revisionId),
          eq(results.aoaDeg, REJECTED_AOA),
        ),
      );
    expect(requeued.status).toBe("queued");
    expect(requeued.simJobId).toBe(child.id);

    // Dedupe per (parent, conditionId): re-running the retry pass creates no
    // second child.
    await submitUransRetryForJob(db, ingestEngine, job);
    const childrenAfter = await db
      .select({ id: simJobs.id })
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, jobId), eq(simJobs.wave, 2)));
    expect(childrenAfter.length).toBe(1);
  }, 120000);
});
