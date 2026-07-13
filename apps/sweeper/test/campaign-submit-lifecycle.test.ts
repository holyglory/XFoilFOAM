// Campaign compose→submit lifecycle MUST-CATCH coverage. A selected batch is
// only a proposal: pause/cancel may commit while the sweeper composes or while
// the engine HTTP request is in flight. Work that had not durably crossed the
// DB submission boundary must leave no lasting engine task and no claimed cell.

import {
  AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
  airfoils,
  autoRetryCrashedResultsForJob,
  boundaryProfiles,
  campaignHasOpenRansGaps,
  campaignOpenTierCounts,
  cancelCampaign,
  categories,
  claimNextPendingUransRequest,
  createClient,
  createUransRequest,
  discoverMissingResultMediaRepairs,
  ensurePrecalcObligations,
  findCampaignGapBatch,
  forceHistory,
  healOrphanedUransRequests,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  outputProfiles,
  pauseCampaign,
  probeCampaignCompletion,
  recordPrecalcObligationSubmission,
  refreshPolarCacheForRevision,
  releaseClaimedUransRequest,
  releaseClaimedVerifyItem,
  resumeCampaign,
  resultAttempts,
  resultClassifications,
  resultMedia,
  resultMediaRepairs,
  results,
  schedulingProfiles,
  simCampaignConditions,
  simCampaignPoints,
  simCampaignProgress,
  simCampaigns,
  simJobs,
  simPrecalcObligationCampaigns,
  simPrecalcObligationAttempts,
  simPrecalcObligations,
  simResultSubmitRetries,
  simUransRequestCampaigns,
  simUransRequests,
  simUransVerifyQueue,
  simUransVerifyQueueCampaigns,
  simulationPresets,
  settlePrecalcObligationsForJob,
  solverProfiles,
  solverEvidenceArtifacts,
  sweeperState,
} from "@aerodb/db";
import { URANS_BUDGET_STOP_MARKER } from "@aerodb/core";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import {
  EngineError,
  MESH_RECOVERY_CAPABILITY_MISMATCH_CODE,
  type EngineClient,
  type JobStatus,
  type PolarRequest,
} from "@aerodb/engine-client";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  clearEngineUnreachable,
  currentBackoffMs,
  resetEngineBackoffForTests,
} from "../src/engine-backoff";
import { submitCampaignBatch } from "../src/loop";
import {
  enqueueVerificationsForJob,
  reconcile,
  resetOrphans,
  settleCampaignAfterRefresh,
  submitUransRetryForJob,
} from "../src/reconcile";
import { submitPendingJobWithLifecycleGuard } from "../src/submit-lifecycle";
import { resetUransLadderMemory, uransLadderTick } from "../src/urans-ladder";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-submit-life-${process.pid}-${Date.now().toString(36)}`;
const CHORD = 0.348271;
const ANGLES = [0, 6];
const profileIds = {
  boundary: "",
  mesh: "",
  solver: "",
  scheduling: "",
  output: "",
};
const campaignIds: string[] = [];

let categoryId = "";
let airfoilId = "";
let mediumId = "";
let restoreSweeperEnabled: boolean | null = null;

const points = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

async function launch(label: string, speed: number) {
  const launched = await materializeCampaignLaunch(db, {
    name: `${PREFIX} ${label}`,
    priority: 8,
    idempotencyKey: `${PREFIX}-${label}-key`,
    airfoilIds: [airfoilId],
    schedulingProfileId: profileIds.scheduling,
    plan: {
      mediumId,
      ambients: [[288.15, 101325]],
      speedsMps: [speed],
      chordsM: [CHORD],
      spanM: 1,
      areaMode: "derived",
      excludedConditions: [],
      baseSweep: {
        fromDeg: null,
        toDeg: null,
        stepDeg: null,
        listDeg: ANGLES,
      },
      objectives: {
        ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
        clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
        clMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
      },
      numerics: {
        boundaryProfileId: profileIds.boundary,
        meshProfileId: profileIds.mesh,
        solverProfileId: profileIds.solver,
        outputProfileId: profileIds.output,
      },
    },
  });
  campaignIds.push(launched.campaign.id);
  return launched.campaign.id;
}

async function setupFor(campaignId: string) {
  const [condition] = await db
    .select({
      id: simCampaignConditions.id,
      revisionId: simCampaignConditions.simulationPresetRevisionId,
      presetId: simCampaignConditions.presetId,
    })
    .from(simCampaignConditions)
    .where(eq(simCampaignConditions.campaignId, campaignId));
  const [preset] = await db
    .select({ bcId: simulationPresets.legacyBoundaryConditionId })
    .from(simulationPresets)
    .where(eq(simulationPresets.id, condition.presetId));
  if (!preset.bcId)
    throw new Error("campaign preset has no legacy boundary condition");
  return {
    conditionId: condition.id,
    revisionId: condition.revisionId,
    bcId: preset.bcId,
  };
}

async function requestedFailedOrphans(campaignId: string) {
  return db
    .select({
      resultId: results.id,
      aoaDeg: simCampaignPoints.aoaDeg,
    })
    .from(simCampaignPoints)
    .innerJoin(
      results,
      and(
        eq(results.airfoilId, simCampaignPoints.airfoilId),
        eq(results.simulationPresetRevisionId, simCampaignPoints.revisionId),
        eq(results.aoaDeg, simCampaignPoints.aoaDeg),
      ),
    )
    .where(
      and(
        eq(simCampaignPoints.campaignId, campaignId),
        eq(simCampaignPoints.state, "requested"),
        eq(results.status, "failed"),
      ),
    );
}

beforeAll(async () => {
  const [state] = await db
    .select({ enabled: sweeperState.enabled })
    .from(sweeperState)
    .where(eq(sweeperState.id, 1));
  restoreSweeperEnabled = state?.enabled ?? false;
  await db
    .insert(sweeperState)
    .values({ id: 1, enabled: false })
    .onConflictDoUpdate({ target: sweeperState.id, set: { enabled: false } });

  const [category] = await db
    .insert(categories)
    .values({
      slug: `${PREFIX}-cat`,
      name: `${PREFIX} cat`,
      path: `${PREFIX}-cat`,
      depth: 0,
    })
    .returning();
  categoryId = category.id;
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-foil`,
      name: `${PREFIX} foil`,
      categoryId,
      points,
      isSymmetric: false,
    })
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
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` })
    .returning();
  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` })
    .returning();
  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` })
    .returning();
  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` })
    .returning();
  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({
      slug: `${PREFIX}-scheduling`,
      name: `${PREFIX} scheduling`,
      schedulingPolicy: "auto",
    })
    .returning();
  profileIds.boundary = boundary.id;
  profileIds.mesh = mesh.id;
  profileIds.solver = solver.id;
  profileIds.scheduling = scheduling.id;
  profileIds.output = output.id;
});

afterAll(async () => {
  await cleanupCampaignFixtures(db, {
    campaignIds,
    presetSlugPrefix: `campaign-${PREFIX.toLowerCase()}`,
  });
  if (profileIds.boundary)
    await db
      .delete(boundaryProfiles)
      .where(eq(boundaryProfiles.id, profileIds.boundary));
  if (profileIds.mesh)
    await db.delete(meshProfiles).where(eq(meshProfiles.id, profileIds.mesh));
  if (profileIds.solver)
    await db
      .delete(solverProfiles)
      .where(eq(solverProfiles.id, profileIds.solver));
  if (profileIds.scheduling)
    await db
      .delete(schedulingProfiles)
      .where(eq(schedulingProfiles.id, profileIds.scheduling));
  if (profileIds.output)
    await db
      .delete(outputProfiles)
      .where(eq(outputProfiles.id, profileIds.output));
  if (mediumId) await db.delete(mediums).where(eq(mediums.id, mediumId));
  if (airfoilId) await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
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
});

describe("campaign compose→submit lifecycle boundary", () => {
  it("does not submit a verify job after exact queue-owner binding was lost", async () => {
    const campaignId = await launch("verify-bind-lost", 18.731);
    const setup = await setupFor(campaignId);
    const aoaDeg = 33.333;
    const [precalc] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.4,
        cd: 0.03,
        cm: -0.02,
        converged: true,
        unsteady: true,
      })
      .returning();
    const [verify] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg,
        state: "running",
        backgroundOwner: true,
        precalcResultId: precalc.id,
      })
      .returning();
    const requestPayload = { verifyQueueItemId: verify.id, aoas: [aoaDeg] };
    const [ownerJob, staleJob] = await db
      .insert(simJobs)
      .values([
        {
          airfoilId,
          bcIds: [setup.bcId],
          simulationPresetRevisionId: setup.revisionId,
          jobKind: "verify",
          referenceChordM: CHORD,
          wave: 2,
          status: "running" as const,
          engineJobId: `${PREFIX}-verify-owner-engine`,
          totalCases: 1,
          requestPayload,
        },
        {
          airfoilId,
          bcIds: [setup.bcId],
          simulationPresetRevisionId: setup.revisionId,
          jobKind: "verify",
          referenceChordM: CHORD,
          wave: 2,
          status: "pending" as const,
          totalCases: 1,
          requestPayload,
        },
      ])
      .returning();
    await db
      .update(simUransVerifyQueue)
      .set({ simJobId: ownerJob.id })
      .where(eq(simUransVerifyQueue.id, verify.id));

    let submitCalls = 0;
    const outcome = await submitPendingJobWithLifecycleGuard({
      db,
      engine: {
        submitPolar: async () => {
          submitCalls++;
          throw new Error("must not reach the engine");
        },
      } as unknown as EngineClient,
      jobId: staleJob.id,
      campaignId: null,
      request: {} as PolarRequest,
      connectionErrorPrefix: "unreachable: ",
      submitErrorPrefix: "failed: ",
      ladderSubmitOwner: { verifyQueueId: verify.id },
    });
    expect(outcome.kind).toBe("lifecycle_stopped");
    expect(submitCalls).toBe(0);
    const [stopped] = await db
      .select({ status: simJobs.status })
      .from(simJobs)
      .where(eq(simJobs.id, staleJob.id));
    const [stillOwned] = await db
      .select({
        state: simUransVerifyQueue.state,
        simJobId: simUransVerifyQueue.simJobId,
      })
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, verify.id));
    expect(stopped.status).toBe("cancelled");
    expect(stillOwned).toEqual({ state: "running", simJobId: ownerJob.id });
  });

  it("does not submit a stale RANS batch selected before terminal cancellation", async () => {
    const campaignId = await launch("stale-cancel", 17.137);
    const batch = await findCampaignGapBatch(db, {
      limit: 500,
      campaignIds: [campaignId],
    });
    expect(batch).not.toBeNull();
    await cancelCampaign(db, campaignId);

    const submittedIds: string[] = [];
    const engine = {
      submitPolar: async (): Promise<JobStatus> => {
        submittedIds.push("unexpected");
        return {
          job_id: `${PREFIX}-stale-engine`,
          state: "pending",
          total_cases: ANGLES.length,
          completed_cases: 0,
        };
      },
    } as unknown as EngineClient;

    expect(await submitCampaignBatch(db, engine, batch!, 0, 0)).toBe(false);
    expect(submittedIds).toEqual([]);
    const jobs = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.campaignId, campaignId));
    expect(jobs).toHaveLength(0);
    const claims = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(
        inArray(
          results.simulationPresetRevisionId,
          batch!.entries.map((entry) => entry.revisionId),
        ),
      );
    expect(
      claims.every((row) => row.status === "pending" && row.simJobId === null),
    ).toBe(true);
  }, 120000);

  it("compensates an accepted RANS task when pause commits during submit", async () => {
    const campaignId = await launch("pause-rans", 18.137);
    const batch = await findCampaignGapBatch(db, {
      limit: 500,
      campaignIds: [campaignId],
    });
    expect(batch).not.toBeNull();
    const cancelledEngineIds: string[] = [];
    const engineJobId = `${PREFIX}-pause-rans-engine`;
    const engine = {
      submitPolar: async (): Promise<JobStatus> => {
        await pauseCampaign(db, campaignId);
        return {
          job_id: engineJobId,
          state: "pending",
          total_cases: ANGLES.length,
          completed_cases: 0,
        };
      },
      cancelJob: async (id: string) => {
        cancelledEngineIds.push(id);
        return { job_id: id, cancelled: true };
      },
    } as unknown as EngineClient;

    expect(await submitCampaignBatch(db, engine, batch!, 0, 0)).toBe(false);
    expect(cancelledEngineIds).toEqual([engineJobId]);
    const [job] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.campaignId, campaignId));
    expect(job).toMatchObject({
      status: "cancelled",
      engineJobId,
      engineState: "cancelled",
    });
    const claims = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(
        eq(results.simulationPresetRevisionId, job.simulationPresetRevisionId!),
      );
    expect(
      claims.every((row) => row.status === "pending" && row.simJobId === null),
    ).toBe(true);
  }, 120000);

  it("compensates an accepted wave-2 task when pause commits during submit", async () => {
    const campaignId = await launch("pause-wave2", 19.137);
    const setup = await setupFor(campaignId);
    const aoa = ANGLES[1];
    const [parent] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId,
        jobKind: "sweep",
        referenceChordM: CHORD,
        wave: 1,
        status: "done",
        engineJobId: `${PREFIX}-wave2-parent`,
        totalCases: 1,
        completedCases: 1,
        ingestedAt: new Date(),
        finishedAt: new Date(),
        requestPayload: {
          speedMap: [
            {
              speed: 19.137,
              bcId: setup.bcId,
              presetRevisionId: setup.revisionId,
              mach: 19.137 / 340.3,
            },
          ],
          aoas: [aoa],
        },
      })
      .returning();
    const [failed] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: aoa,
        status: "failed",
        source: "queued",
        regime: "rans",
        fidelity: "rans",
        simJobId: parent.id,
        error: "RANS did not converge",
        converged: false,
        unsteady: false,
        solvedAt: new Date(),
      })
      .returning();
    await db.insert(resultAttempts).values({
      resultId: failed.id,
      airfoilId,
      bcId: setup.bcId,
      simulationPresetRevisionId: setup.revisionId,
      aoaDeg: aoa,
      simJobId: parent.id,
      engineJobId: `${PREFIX}-wave2-parent`,
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
    });
    await db
      .update(simCampaignPoints)
      .set({ state: "terminal", resultId: failed.id })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.conditionId, setup.conditionId),
          eq(simCampaignPoints.aoaDeg, aoa),
        ),
      );
    await db
      .update(simCampaignPoints)
      .set({ state: "terminal" })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.conditionId, setup.conditionId),
          eq(simCampaignPoints.aoaDeg, ANGLES[0]),
        ),
      );
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(false);

    const cancelledEngineIds: string[] = [];
    const engineJobId = `${PREFIX}-pause-wave2-engine`;
    const engine = {
      submitPolar: async (_request: PolarRequest): Promise<JobStatus> => {
        await pauseCampaign(db, campaignId);
        return {
          job_id: engineJobId,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        };
      },
      cancelJob: async (id: string) => {
        cancelledEngineIds.push(id);
        return { job_id: id, cancelled: true };
      },
    } as unknown as EngineClient;

    await submitUransRetryForJob(db, engine, parent);
    expect(cancelledEngineIds).toEqual([engineJobId]);
    const [child] = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
    expect(child).toMatchObject({
      status: "cancelled",
      engineJobId,
      engineState: "cancelled",
    });
    const [released] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, failed.id));
    // The physical obligation, not the canonical RANS row, owns the retry.
    // Pausing before submission must retain the original solver evidence and
    // its producing parent unchanged.
    expect(released).toEqual({ status: "failed", simJobId: parent.id });

    // A sweeper restart while paused must preserve the ownerless wave-2
    // obligation. The immutable failed RANS evidence remains linked to the
    // wave-1 parent and the ordinary campaign gap composer stays closed.
    await resetOrphans(db, {
      jobIds: [child.id],
      resultIds: [failed.id],
    });
    const [afterRestart] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, failed.id));
    expect(afterRestart).toEqual({ status: "failed", simJobId: parent.id });
    expect(
      await findCampaignGapBatch(db, { limit: 500, campaignIds: [campaignId] }),
    ).toBeNull();

    await resumeCampaign(db, campaignId);
    resetUransLadderMemory();
    const resumedRequests: PolarRequest[] = [];
    const resumedEngine = {
      submitPolar: async (request: PolarRequest): Promise<JobStatus> => {
        resumedRequests.push(request);
        return {
          job_id: `${PREFIX}-pause-wave2-resumed-engine`,
          state: "pending",
          total_cases: request.aoa?.angles?.length ?? 0,
          completed_cases: 0,
        };
      },
    } as unknown as EngineClient;
    expect(
      await uransLadderTick(db, resumedEngine, 0, {
        campaignIds: [campaignId],
        requestIds: [],
      }),
    ).toBe(true);
    expect(resumedRequests).toHaveLength(1);
    expect(resumedRequests[0].aoa?.angles).toEqual([aoa]);
    expect(resumedRequests[0].solver).toMatchObject({
      transient_fallback: true,
      force_transient: true,
      urans_fidelity: "precalc",
    });
    const [resumedChild] = await db
      .select()
      .from(simJobs)
      .where(
        and(
          eq(simJobs.parentJobId, parent.id),
          eq(simJobs.engineJobId, `${PREFIX}-pause-wave2-resumed-engine`),
        ),
      );
    expect(resumedChild).toMatchObject({
      wave: 2,
      status: "submitted",
    });
    expect(resumedChild.requestPayload).toMatchObject({
      aoas: [aoa],
      uransFidelity: "precalc",
    });
  }, 120000);

  it("serializes concurrent wave-2 composers by parent and submits exactly one child", async () => {
    const campaignId = await launch("concurrent-wave2", 19.637);
    const setup = await setupFor(campaignId);
    const aoa = ANGLES[1];
    const [parent] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId,
        jobKind: "sweep",
        referenceChordM: CHORD,
        wave: 1,
        status: "done",
        engineJobId: `${PREFIX}-concurrent-wave2-parent`,
        totalCases: 1,
        completedCases: 1,
        ingestedAt: new Date(),
        finishedAt: new Date(),
        requestPayload: {
          speedMap: [
            {
              speed: 19.637,
              bcId: setup.bcId,
              presetRevisionId: setup.revisionId,
              mach: 19.637 / 340.3,
            },
          ],
          aoas: [aoa],
        },
      })
      .returning();
    const [failed] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: aoa,
        status: "failed",
        source: "queued",
        regime: "rans",
        fidelity: "rans",
        simJobId: parent.id,
        error: "RANS did not converge",
        converged: false,
        stalled: true,
        unsteady: false,
        solvedAt: new Date(),
      })
      .returning();
    await db.insert(resultAttempts).values({
      resultId: failed.id,
      airfoilId,
      bcId: setup.bcId,
      simulationPresetRevisionId: setup.revisionId,
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
    });
    await db
      .update(simCampaignPoints)
      .set({ state: "terminal" })
      .where(eq(simCampaignPoints.campaignId, campaignId));
    await db
      .update(simCampaignPoints)
      .set({ resultId: failed.id })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.conditionId, setup.conditionId),
          eq(simCampaignPoints.aoaDeg, aoa),
        ),
      );
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(false);

    const submittedRequests: PolarRequest[] = [];
    const engine = {
      submitPolar: async (request: PolarRequest): Promise<JobStatus> => {
        submittedRequests.push(request);
        // Keep the winner outside the DB transaction briefly so the loser
        // must rely on the durable child recheck, not an in-process flag.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          job_id: `${PREFIX}-concurrent-wave2-engine-${submittedRequests.length}`,
          state: "pending",
          total_cases: request.aoa?.angles?.length ?? 0,
          completed_cases: 0,
        };
      },
    } as unknown as EngineClient;

    await Promise.all([
      submitUransRetryForJob(db, engine, parent),
      submitUransRetryForJob(db, engine, parent),
    ]);

    expect(submittedRequests).toHaveLength(1);
    expect(submittedRequests[0].solver).toMatchObject({
      force_transient: true,
      urans_fidelity: "precalc",
    });
    const children = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ status: "submitted", wave: 2 });
  }, 120000);

  it("does not release claims when another submitter already won pending→submitted", async () => {
    const campaignId = await launch("submit-winner", 20.137);
    const setup = await setupFor(campaignId);
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 1,
        status: "pending",
        totalCases: 1,
      })
      .returning();
    const [claim] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: 42.137,
        status: "queued",
        source: "queued",
        simJobId: job.id,
      })
      .returning();
    const cancelledEngineIds: string[] = [];
    const winnerEngineId = `${PREFIX}-winner-engine`;
    const duplicateEngineId = `${PREFIX}-duplicate-engine`;
    const engine = {
      submitPolar: async (): Promise<JobStatus> => {
        // Simulate a second submitter winning the DB boundary while this
        // caller waits for its own engine response.
        await db
          .update(simJobs)
          .set({
            status: "submitted",
            engineJobId: winnerEngineId,
            engineState: "pending",
            submittedAt: new Date(),
          })
          .where(and(eq(simJobs.id, job.id), eq(simJobs.status, "pending")));
        return {
          job_id: duplicateEngineId,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        };
      },
      cancelJob: async (id: string) => {
        cancelledEngineIds.push(id);
        return { job_id: id, cancelled: true };
      },
    } as unknown as EngineClient;

    const outcome = await submitPendingJobWithLifecycleGuard({
      db,
      engine,
      jobId: job.id,
      campaignId,
      request: {} as PolarRequest,
      connectionErrorPrefix: "unreachable: ",
      submitErrorPrefix: "failed: ",
    });
    expect(outcome.kind).toBe("lifecycle_stopped");
    expect(cancelledEngineIds).toEqual([duplicateEngineId]);
    const [afterJob] = await db
      .select({
        status: simJobs.status,
        engineJobId: simJobs.engineJobId,
      })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(afterJob).toEqual({
      status: "submitted",
      engineJobId: winnerEngineId,
    });
    const [afterClaim] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, claim.id));
    expect(afterClaim).toEqual({ status: "queued", simJobId: job.id });
  }, 120000);

  it("claims the pending job before the external call so a second submitter never reaches the engine", async () => {
    const campaignId = await launch("single-submit-owner", 21.137);
    const setup = await setupFor(campaignId);
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "pending",
        totalCases: 1,
      })
      .returning();

    let releaseFirst!: () => void;
    const firstMayReturn = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let announceFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      announceFirstStarted = resolve;
    });
    const submitCalls: string[] = [];
    const engine = {
      submitPolar: async (): Promise<JobStatus> => {
        submitCalls.push("submit");
        const ordinal = submitCalls.length;
        if (ordinal === 1) {
          announceFirstStarted();
          await firstMayReturn;
        }
        return {
          job_id: `${PREFIX}-single-owner-engine-${ordinal}`,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        };
      },
      cancelJob: async (id: string) => ({ job_id: id, cancelled: true }),
    } as unknown as EngineClient;
    const submit = () =>
      submitPendingJobWithLifecycleGuard({
        db,
        engine,
        jobId: job.id,
        campaignId,
        request: {} as PolarRequest,
        connectionErrorPrefix: "unreachable: ",
        submitErrorPrefix: "failed: ",
      });

    const first = submit();
    await firstStarted;
    const second = await submit();
    releaseFirst();
    const firstOutcome = await first;
    expect(second.kind).toBe("submission_in_progress");
    expect(submitCalls).toEqual(["submit"]);
    expect(firstOutcome.kind).toBe("submitted");
    const [after] = await db
      .select({ status: simJobs.status, engineJobId: simJobs.engineJobId })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(after).toEqual({
      status: "submitted",
      engineJobId: `${PREFIX}-single-owner-engine-1`,
    });
  }, 120000);

  it("retries persisted compensating cancellation even when the engine queue omits the task", async () => {
    const campaignId = await launch("durable-compensation", 22.137);
    const setup = await setupFor(campaignId);
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "pending",
        totalCases: 1,
      })
      .returning();
    const engineJobId = `${PREFIX}-cancel-retry-engine`;
    const foreignEngineJobId = `${PREFIX}-foreign-cancel-retry-engine`;
    const foreignError = "foreign cancellation belongs to another reconciler";
    const [foreignCancellation] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "cancelled",
        engineJobId: foreignEngineJobId,
        engineState: "cancel_pending",
        error: foreignError,
        totalCases: 1,
        finishedAt: new Date(),
      })
      .returning({ id: simJobs.id });
    let cancelAttempts = 0;
    const engine = {
      submitPolar: async (): Promise<JobStatus> => {
        await pauseCampaign(db, campaignId);
        return {
          job_id: engineJobId,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        };
      },
      cancelJob: async (id: string) => {
        expect(id).toBe(engineJobId);
        cancelAttempts += 1;
        if (cancelAttempts === 1)
          throw new Error("temporary cancel transport failure");
        return { job_id: id, cancelled: true };
      },
      // The persisted obligation, not queue visibility, must drive retry.
      getQueue: async () => ({
        active: [],
        reserved: [],
        scheduled: [],
        active_count: 0,
        reserved_count: 0,
        scheduled_count: 0,
        job_ids: [],
        redelivered: [],
      }),
    } as unknown as EngineClient;

    const outcome = await submitPendingJobWithLifecycleGuard({
      db,
      engine,
      jobId: job.id,
      campaignId,
      request: {} as PolarRequest,
      connectionErrorPrefix: "unreachable: ",
      submitErrorPrefix: "failed: ",
    });
    expect(outcome.kind).toBe("lifecycle_stopped");
    const [pendingCancel] = await db
      .select({
        status: simJobs.status,
        engineState: simJobs.engineState,
        engineJobId: simJobs.engineJobId,
      })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(pendingCancel).toEqual({
      status: "cancelled",
      engineState: "cancel_pending",
      engineJobId,
    });

    await reconcile(db, engine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });
    expect(cancelAttempts).toBe(2);
    const [settled] = await db
      .select({ status: simJobs.status, engineState: simJobs.engineState })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(settled).toEqual({ status: "cancelled", engineState: "cancelled" });
    expect(
      await db
        .select({
          engineState: simJobs.engineState,
          error: simJobs.error,
        })
        .from(simJobs)
        .where(eq(simJobs.id, foreignCancellation.id)),
    ).toEqual([{ engineState: "cancel_pending", error: foreignError }]);
    await db.delete(simJobs).where(eq(simJobs.id, foreignCancellation.id));
  }, 120000);

  it("immediately releases already-composed global request and verify jobs when their only owner pauses", async () => {
    const campaignId = await launch("shared-existing-pending-pause", 22.437);
    const setup = await setupFor(campaignId);
    const [precalc] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: ANGLES[0],
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.4,
        cd: 0.02,
        cm: -0.03,
        converged: true,
        unsteady: true,
        solvedAt: new Date(),
      })
      .returning();
    const [request] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg: ANGLES[1],
        fidelity: "precalc",
        state: "running",
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      })
      .returning();
    const [verifyItem] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg: ANGLES[0],
        state: "running",
        precalcResultId: precalc.id,
      })
      .returning();
    await db
      .insert(simUransRequestCampaigns)
      .values({ requestId: request.id, campaignId });
    await db
      .insert(simUransVerifyQueueCampaigns)
      .values({ queueId: verifyItem.id, campaignId });
    const [requestJob, verifyJob] = await db
      .insert(simJobs)
      .values([
        {
          airfoilId,
          bcIds: [setup.bcId],
          simulationPresetRevisionId: setup.revisionId,
          campaignId: null,
          jobKind: "targeted",
          referenceChordM: CHORD,
          wave: 2,
          status: "pending",
          totalCases: 1,
          requestPayload: {
            uransRequestId: request.id,
            uransFidelity: "precalc",
            aoas: [ANGLES[1]],
          },
        },
        {
          airfoilId,
          bcIds: [setup.bcId],
          simulationPresetRevisionId: setup.revisionId,
          campaignId: null,
          jobKind: "verify",
          referenceChordM: CHORD,
          wave: 2,
          status: "pending",
          totalCases: 1,
          requestPayload: {
            verifyQueueItemId: verifyItem.id,
            uransFidelity: "full",
            aoas: [ANGLES[0]],
          },
        },
      ])
      .returning();
    await db
      .update(simUransRequests)
      .set({ simJobId: requestJob.id })
      .where(eq(simUransRequests.id, request.id));

    const paused = await pauseCampaign(db, campaignId);
    expect(paused.cancelledPendingJobs).toBe(2);
    expect(paused.runningJobs).toBe(0);
    const stoppedJobs = await db
      .select({ id: simJobs.id, status: simJobs.status })
      .from(simJobs)
      .where(inArray(simJobs.id, [requestJob.id, verifyJob.id]));
    expect(stoppedJobs.map((job) => job.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    const [releasedRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    const [releasedVerify] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, verifyItem.id));
    expect(releasedRequest).toMatchObject({ state: "pending", simJobId: null });
    expect(releasedVerify.state).toBe("pending");

    // Resume, recreate the already-composed pending boundary, then cancel the
    // sole owner. Terminal lifecycle must release both global compositions
    // immediately and close both physical obligations.
    await resumeCampaign(db, campaignId);
    await db
      .update(simJobs)
      .set({
        status: "pending",
        engineState: null,
        error: null,
        finishedAt: null,
      })
      .where(inArray(simJobs.id, [requestJob.id, verifyJob.id]));
    await db
      .update(simUransRequests)
      .set({ state: "running", simJobId: requestJob.id })
      .where(eq(simUransRequests.id, request.id));
    await db
      .update(simUransVerifyQueue)
      .set({ state: "running" })
      .where(eq(simUransVerifyQueue.id, verifyItem.id));
    const cancelled = await cancelCampaign(db, campaignId);
    expect(cancelled.cancelledPendingJobs).toBe(2);
    const [cancelledRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    const [cancelledVerify] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, verifyItem.id));
    expect(cancelledRequest.state).toBe("cancelled");
    expect(cancelledVerify.state).toBe("cancelled");
  }, 120000);

  it("settles every associated campaign after a campaign_id-null shared job refresh", async () => {
    const campaignA = await launch("shared-settle-a", 22.537);
    const campaignB = await launch("shared-settle-b", 22.537);
    const setupA = await setupFor(campaignA);
    const setupB = await setupFor(campaignB);
    expect(setupB.revisionId).toBe(setupA.revisionId);
    await db
      .update(simCampaignPoints)
      .set({ state: "released" })
      .where(inArray(simCampaignPoints.campaignId, [campaignA, campaignB]));
    const [request] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: setupA.revisionId,
        aoaDeg: ANGLES[0],
        fidelity: "precalc",
        state: "done",
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      })
      .returning();
    await db.insert(simUransRequestCampaigns).values([
      { requestId: request.id, campaignId: campaignA },
      { requestId: request.id, campaignId: campaignB },
    ]);
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setupA.bcId],
        simulationPresetRevisionId: setupA.revisionId,
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "done",
        engineJobId: `${PREFIX}-shared-settle-engine`,
        totalCases: 1,
        completedCases: 1,
        ingestedAt: new Date(),
        finishedAt: new Date(),
        requestPayload: {
          uransRequestId: request.id,
          uransFidelity: "precalc",
          aoas: [ANGLES[0]],
        },
      })
      .returning();

    await settleCampaignAfterRefresh(db, job);
    const settled = await db
      .select({ id: simCampaigns.id, status: simCampaigns.status })
      .from(simCampaigns)
      .where(inArray(simCampaigns.id, [campaignA, campaignB]));
    expect(
      new Map(settled.map((campaign) => [campaign.id, campaign.status])),
    ).toEqual(
      new Map([
        [campaignA, "completed"],
        [campaignB, "completed"],
      ]),
    );
  }, 120000);

  it("turns an accepted shared continuation into one campaign-owned verification without inventing a background owner", async () => {
    const campaignA = await launch("shared-continuation-verify-a", 22.587);
    const campaignB = await launch("shared-continuation-verify-b", 22.587);
    const setupA = await setupFor(campaignA);
    const setupB = await setupFor(campaignB);
    expect(setupB.revisionId).toBe(setupA.revisionId);
    const [accepted] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setupA.bcId,
        simulationPresetRevisionId: setupA.revisionId,
        aoaDeg: ANGLES[0],
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.45,
        cd: 0.022,
        cm: -0.03,
        converged: true,
        unsteady: true,
        solvedAt: new Date(),
      })
      .returning();
    await db.insert(resultClassifications).values({
      resultId: accepted.id,
      airfoilId,
      simulationPresetRevisionId: setupA.revisionId,
      aoaDeg: ANGLES[0],
      regime: "urans",
      classifierVersion: "shared-continuation-accepted-v1",
      state: "accepted",
      reasons: [],
    });
    for (const campaignId of [campaignA, campaignB]) {
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal", resultId: accepted.id })
        .where(
          and(
            eq(simCampaignPoints.campaignId, campaignId),
            eq(simCampaignPoints.aoaDeg, ANGLES[0]),
          ),
        );
    }
    const [request] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: setupA.revisionId,
        aoaDeg: ANGLES[0],
        fidelity: "precalc",
        state: "running",
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      })
      .returning();
    await db.insert(simUransRequestCampaigns).values([
      { requestId: request.id, campaignId: campaignA },
      { requestId: request.id, campaignId: campaignB },
    ]);
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setupA.bcId],
        simulationPresetRevisionId: setupA.revisionId,
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "ingesting",
        engineJobId: `${PREFIX}-shared-continuation-accepted-engine`,
        totalCases: 1,
        completedCases: 1,
        requestPayload: {
          uransRequestId: request.id,
          uransFidelity: "precalc",
          aoas: [ANGLES[0]],
        },
      })
      .returning();

    await enqueueVerificationsForJob(db, job);
    const [item] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.precalcResultId, accepted.id));
    expect(item).toMatchObject({ state: "pending", backgroundOwner: false });
    const owners = await db
      .select({ campaignId: simUransVerifyQueueCampaigns.campaignId })
      .from(simUransVerifyQueueCampaigns)
      .where(eq(simUransVerifyQueueCampaigns.queueId, item.id));
    expect(owners.map((owner) => owner.campaignId).sort()).toEqual(
      [campaignA, campaignB].sort(),
    );
  }, 120000);

  it("submits a shared automatic continuation when one owner cancels mid-submit, but compensates when every owner pauses", async () => {
    const survivorA = await launch("shared-request-survivor-a", 22.637);
    const survivorB = await launch("shared-request-survivor-b", 22.637);
    const survivorSetupA = await setupFor(survivorA);
    const survivorSetupB = await setupFor(survivorB);
    expect(survivorSetupB.revisionId).toBe(survivorSetupA.revisionId);

    const [survivorRequest] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: survivorSetupA.revisionId,
        aoaDeg: ANGLES[0],
        fidelity: "precalc",
        state: "running",
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      })
      .returning();
    await db.insert(simUransRequestCampaigns).values([
      { requestId: survivorRequest.id, campaignId: survivorA },
      { requestId: survivorRequest.id, campaignId: survivorB },
    ]);
    const [survivorJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [survivorSetupA.bcId],
        simulationPresetRevisionId: survivorSetupA.revisionId,
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "pending",
        totalCases: 1,
        requestPayload: {
          uransRequestId: survivorRequest.id,
          uransFidelity: "precalc",
          aoas: [ANGLES[0]],
        },
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({ simJobId: survivorJob.id })
      .where(eq(simUransRequests.id, survivorRequest.id));
    const survivorCancelledEngineIds: string[] = [];
    const survivorEngineId = `${PREFIX}-shared-request-survivor-engine`;
    const survivorEngine = {
      submitPolar: async (): Promise<JobStatus> => {
        await cancelCampaign(db, survivorA);
        return {
          job_id: survivorEngineId,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        };
      },
      cancelJob: async (id: string) => {
        survivorCancelledEngineIds.push(id);
        return { job_id: id, cancelled: true };
      },
    } as unknown as EngineClient;
    const survivorOutcome = await submitPendingJobWithLifecycleGuard({
      db,
      engine: survivorEngine,
      jobId: survivorJob.id,
      campaignId: null,
      request: {} as PolarRequest,
      connectionErrorPrefix: "unreachable: ",
      submitErrorPrefix: "failed: ",
    });
    expect(survivorOutcome.kind).toBe("submitted");
    expect(survivorCancelledEngineIds).toEqual([]);
    const [submittedSharedJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, survivorJob.id));
    expect(submittedSharedJob).toMatchObject({
      campaignId: null,
      status: "submitted",
      engineJobId: survivorEngineId,
    });
    const terminalOwner = await cancelCampaign(db, survivorB);
    expect(terminalOwner.runningJobsFinishing).toBe(1);
    expect(
      await healOrphanedUransRequests(db, { requestIds: [survivorRequest.id] }),
    ).toBe(0);
    const [survivingSubmittedRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, survivorRequest.id));
    const [survivingSubmittedJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, survivorJob.id));
    expect(survivingSubmittedRequest.state).toBe("running");
    expect(survivingSubmittedJob.status).toBe("submitted");

    const pausedA = await launch("shared-request-paused-a", 23.637);
    const pausedB = await launch("shared-request-paused-b", 23.637);
    const pausedSetupA = await setupFor(pausedA);
    const pausedSetupB = await setupFor(pausedB);
    expect(pausedSetupB.revisionId).toBe(pausedSetupA.revisionId);
    const [pausedRequest] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: pausedSetupA.revisionId,
        aoaDeg: ANGLES[1],
        fidelity: "precalc",
        state: "running",
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      })
      .returning();
    await db.insert(simUransRequestCampaigns).values([
      { requestId: pausedRequest.id, campaignId: pausedA },
      { requestId: pausedRequest.id, campaignId: pausedB },
    ]);
    const [pausedJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [pausedSetupA.bcId],
        simulationPresetRevisionId: pausedSetupA.revisionId,
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "pending",
        totalCases: 1,
        requestPayload: {
          uransRequestId: pausedRequest.id,
          uransFidelity: "precalc",
          aoas: [ANGLES[1]],
        },
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({ simJobId: pausedJob.id })
      .where(eq(simUransRequests.id, pausedRequest.id));
    const pausedEngineId = `${PREFIX}-shared-request-paused-engine`;
    const pausedCancelledEngineIds: string[] = [];
    const pausedEngine = {
      submitPolar: async (): Promise<JobStatus> => {
        await pauseCampaign(db, pausedA);
        await pauseCampaign(db, pausedB);
        return {
          job_id: pausedEngineId,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        };
      },
      cancelJob: async (id: string) => {
        pausedCancelledEngineIds.push(id);
        return { job_id: id, cancelled: true };
      },
    } as unknown as EngineClient;
    const pausedOutcome = await submitPendingJobWithLifecycleGuard({
      db,
      engine: pausedEngine,
      jobId: pausedJob.id,
      campaignId: null,
      request: {} as PolarRequest,
      connectionErrorPrefix: "unreachable: ",
      submitErrorPrefix: "failed: ",
    });
    expect(pausedOutcome.kind).toBe("lifecycle_stopped");
    expect(pausedCancelledEngineIds).toEqual([pausedEngineId]);
    await releaseClaimedUransRequest(db, pausedRequest.id);
    const [frozenRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, pausedRequest.id));
    const [cancelledComposition] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, pausedJob.id));
    expect(frozenRequest).toMatchObject({ state: "pending", simJobId: null });
    expect(cancelledComposition).toMatchObject({
      campaignId: null,
      status: "cancelled",
      engineJobId: pausedEngineId,
      engineState: "cancelled",
    });
  }, 120000);

  it("submits a shared verification when one owner cancels mid-submit, but compensates when every owner pauses", async () => {
    const survivorA = await launch("shared-verify-survivor-a", 24.637);
    const survivorB = await launch("shared-verify-survivor-b", 24.637);
    const survivorSetupA = await setupFor(survivorA);
    const survivorSetupB = await setupFor(survivorB);
    expect(survivorSetupB.revisionId).toBe(survivorSetupA.revisionId);
    const [survivorPrecalc] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: survivorSetupA.bcId,
        simulationPresetRevisionId: survivorSetupA.revisionId,
        aoaDeg: ANGLES[0],
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.4,
        cd: 0.02,
        cm: -0.03,
        converged: true,
        unsteady: true,
        solvedAt: new Date(),
      })
      .returning();
    const [survivorItem] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId: survivorSetupA.revisionId,
        aoaDeg: ANGLES[0],
        state: "running",
        precalcResultId: survivorPrecalc.id,
      })
      .returning();
    await db.insert(simUransVerifyQueueCampaigns).values([
      { queueId: survivorItem.id, campaignId: survivorA },
      { queueId: survivorItem.id, campaignId: survivorB },
    ]);
    const [survivorJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [survivorSetupA.bcId],
        simulationPresetRevisionId: survivorSetupA.revisionId,
        campaignId: null,
        jobKind: "verify",
        referenceChordM: CHORD,
        wave: 2,
        status: "pending",
        totalCases: 1,
        requestPayload: {
          verifyQueueItemId: survivorItem.id,
          uransFidelity: "full",
          aoas: [ANGLES[0]],
        },
      })
      .returning();
    await db
      .update(simUransVerifyQueue)
      .set({ simJobId: survivorJob.id })
      .where(eq(simUransVerifyQueue.id, survivorItem.id));
    const survivorEngineId = `${PREFIX}-shared-verify-survivor-engine`;
    const survivorCancelledEngineIds: string[] = [];
    const survivorEngine = {
      submitPolar: async (): Promise<JobStatus> => {
        await cancelCampaign(db, survivorA);
        return {
          job_id: survivorEngineId,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        };
      },
      cancelJob: async (id: string) => {
        survivorCancelledEngineIds.push(id);
        return { job_id: id, cancelled: true };
      },
    } as unknown as EngineClient;
    const survivorOutcome = await submitPendingJobWithLifecycleGuard({
      db,
      engine: survivorEngine,
      jobId: survivorJob.id,
      campaignId: null,
      request: {} as PolarRequest,
      connectionErrorPrefix: "unreachable: ",
      submitErrorPrefix: "failed: ",
    });
    expect(survivorOutcome.kind).toBe("submitted");
    expect(survivorCancelledEngineIds).toEqual([]);
    const terminalOwner = await cancelCampaign(db, survivorB);
    expect(terminalOwner.runningJobsFinishing).toBe(1);
    const [survivingSubmittedItem] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, survivorItem.id));
    const [survivingSubmittedJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, survivorJob.id));
    expect(survivingSubmittedItem.state).toBe("running");
    expect(survivingSubmittedJob.status).toBe("submitted");

    const pausedA = await launch("shared-verify-paused-a", 25.637);
    const pausedB = await launch("shared-verify-paused-b", 25.637);
    const pausedSetupA = await setupFor(pausedA);
    const pausedSetupB = await setupFor(pausedB);
    expect(pausedSetupB.revisionId).toBe(pausedSetupA.revisionId);
    const [pausedPrecalc] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: pausedSetupA.bcId,
        simulationPresetRevisionId: pausedSetupA.revisionId,
        aoaDeg: ANGLES[1],
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.7,
        cd: 0.03,
        cm: -0.04,
        converged: true,
        unsteady: true,
        solvedAt: new Date(),
      })
      .returning();
    const [pausedItem] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId: pausedSetupA.revisionId,
        aoaDeg: ANGLES[1],
        state: "running",
        precalcResultId: pausedPrecalc.id,
      })
      .returning();
    await db.insert(simUransVerifyQueueCampaigns).values([
      { queueId: pausedItem.id, campaignId: pausedA },
      { queueId: pausedItem.id, campaignId: pausedB },
    ]);
    const [pausedJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [pausedSetupA.bcId],
        simulationPresetRevisionId: pausedSetupA.revisionId,
        campaignId: null,
        jobKind: "verify",
        referenceChordM: CHORD,
        wave: 2,
        status: "pending",
        totalCases: 1,
        requestPayload: {
          verifyQueueItemId: pausedItem.id,
          uransFidelity: "full",
          aoas: [ANGLES[1]],
        },
      })
      .returning();
    await db
      .update(simUransVerifyQueue)
      .set({ simJobId: pausedJob.id })
      .where(eq(simUransVerifyQueue.id, pausedItem.id));
    const pausedEngineId = `${PREFIX}-shared-verify-paused-engine`;
    const pausedCancelledEngineIds: string[] = [];
    const pausedEngine = {
      submitPolar: async (): Promise<JobStatus> => {
        await pauseCampaign(db, pausedA);
        await pauseCampaign(db, pausedB);
        return {
          job_id: pausedEngineId,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        };
      },
      cancelJob: async (id: string) => {
        pausedCancelledEngineIds.push(id);
        return { job_id: id, cancelled: true };
      },
    } as unknown as EngineClient;
    const pausedOutcome = await submitPendingJobWithLifecycleGuard({
      db,
      engine: pausedEngine,
      jobId: pausedJob.id,
      campaignId: null,
      request: {} as PolarRequest,
      connectionErrorPrefix: "unreachable: ",
      submitErrorPrefix: "failed: ",
    });
    expect(pausedOutcome.kind).toBe("lifecycle_stopped");
    expect(pausedCancelledEngineIds).toEqual([pausedEngineId]);
    await releaseClaimedVerifyItem(db, pausedItem.id);
    const [frozenItem] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, pausedItem.id));
    const [cancelledComposition] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, pausedJob.id));
    expect(frozenItem).toMatchObject({ state: "pending", simJobId: null });
    expect(cancelledComposition).toMatchObject({
      campaignId: null,
      status: "cancelled",
      engineJobId: pausedEngineId,
      engineState: "cancelled",
    });
  }, 120000);

  it("serializes simultaneous final-owner cancellation and leaves no ownerless ladder composition", async () => {
    const campaignA = await launch("concurrent-final-owner-a", 26.137);
    const campaignB = await launch("concurrent-final-owner-b", 26.137);
    const setupA = await setupFor(campaignA);
    const setupB = await setupFor(campaignB);
    expect(setupB.revisionId).toBe(setupA.revisionId);

    const [precalc] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setupA.bcId,
        simulationPresetRevisionId: setupA.revisionId,
        aoaDeg: ANGLES[1],
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.7,
        cd: 0.03,
        cm: -0.04,
        converged: true,
        unsteady: true,
        solvedAt: new Date(),
      })
      .returning();
    const [request] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: setupA.revisionId,
        aoaDeg: ANGLES[0],
        fidelity: "precalc",
        state: "running",
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      })
      .returning();
    const [verifyItem] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId: setupA.revisionId,
        aoaDeg: ANGLES[1],
        state: "running",
        backgroundOwner: false,
        precalcResultId: precalc.id,
      })
      .returning();
    await db.insert(simUransRequestCampaigns).values([
      { requestId: request.id, campaignId: campaignA },
      { requestId: request.id, campaignId: campaignB },
    ]);
    await db.insert(simUransVerifyQueueCampaigns).values([
      { queueId: verifyItem.id, campaignId: campaignA },
      { queueId: verifyItem.id, campaignId: campaignB },
    ]);
    const [requestJob, verifyJob] = await db
      .insert(simJobs)
      .values([
        {
          airfoilId,
          bcIds: [setupA.bcId],
          simulationPresetRevisionId: setupA.revisionId,
          campaignId: null,
          jobKind: "targeted",
          referenceChordM: CHORD,
          wave: 2,
          status: "pending",
          totalCases: 1,
          requestPayload: {
            uransRequestId: request.id,
            uransFidelity: "precalc",
            aoas: [ANGLES[0]],
          },
        },
        {
          airfoilId,
          bcIds: [setupA.bcId],
          simulationPresetRevisionId: setupA.revisionId,
          campaignId: null,
          jobKind: "verify",
          referenceChordM: CHORD,
          wave: 2,
          status: "pending",
          totalCases: 1,
          requestPayload: {
            verifyQueueItemId: verifyItem.id,
            uransFidelity: "full",
            aoas: [ANGLES[1]],
          },
        },
      ])
      .returning();
    await db
      .update(simUransRequests)
      .set({ simJobId: requestJob.id })
      .where(eq(simUransRequests.id, request.id));

    const outcomes = await Promise.all([
      cancelCampaign(db, campaignA),
      cancelCampaign(db, campaignB),
    ]);
    expect(
      outcomes.reduce((sum, outcome) => sum + outcome.cancelledPendingJobs, 0),
    ).toBe(2);

    const campaigns = await db
      .select({ id: simCampaigns.id, status: simCampaigns.status })
      .from(simCampaigns)
      .where(inArray(simCampaigns.id, [campaignA, campaignB]));
    expect(campaigns.every((campaign) => campaign.status === "cancelled")).toBe(
      true,
    );
    const requestOwners = await db
      .select({ state: simUransRequestCampaigns.state })
      .from(simUransRequestCampaigns)
      .where(eq(simUransRequestCampaigns.requestId, request.id));
    const verifyOwners = await db
      .select({ state: simUransVerifyQueueCampaigns.state })
      .from(simUransVerifyQueueCampaigns)
      .where(eq(simUransVerifyQueueCampaigns.queueId, verifyItem.id));
    expect(requestOwners).toHaveLength(2);
    expect(verifyOwners).toHaveLength(2);
    expect(requestOwners.every((owner) => owner.state === "cancelled")).toBe(
      true,
    );
    expect(verifyOwners.every((owner) => owner.state === "cancelled")).toBe(
      true,
    );

    const [closedRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    const [closedVerify] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, verifyItem.id));
    expect(closedRequest).toMatchObject({ state: "cancelled", simJobId: null });
    expect(closedVerify.state).toBe("cancelled");
    const jobs = await db
      .select({ status: simJobs.status })
      .from(simJobs)
      .where(inArray(simJobs.id, [requestJob.id, verifyJob.id]));
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.status === "cancelled")).toBe(true);
  }, 120000);

  it("keeps association-owned precalc retries in wave 2, suppresses deterministic mesh blockers, and closes a spent retry", async () => {
    const campaignA = await launch("shared-precalc-retry-a", 27.137);
    const campaignB = await launch("shared-precalc-retry-b", 27.137);
    const setupA = await setupFor(campaignA);
    const setupB = await setupFor(campaignB);
    expect(setupB.revisionId).toBe(setupA.revisionId);

    const [transientRequest, meshRequest] = await db
      .insert(simUransRequests)
      .values([
        {
          airfoilId,
          revisionId: setupA.revisionId,
          aoaDeg: ANGLES[0],
          fidelity: "precalc",
          state: "running",
          requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
        },
        {
          airfoilId,
          revisionId: setupA.revisionId,
          aoaDeg: ANGLES[1],
          fidelity: "precalc",
          state: "done",
          requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
        },
      ])
      .returning();
    await db.insert(simUransRequestCampaigns).values(
      [transientRequest.id, meshRequest.id].flatMap((requestId) => [
        { requestId, campaignId: campaignA },
        { requestId, campaignId: campaignB },
      ]),
    );
    const [transientJob, meshJob] = await db
      .insert(simJobs)
      .values([
        {
          airfoilId,
          bcIds: [setupA.bcId],
          simulationPresetRevisionId: setupA.revisionId,
          campaignId: null,
          jobKind: "targeted",
          referenceChordM: CHORD,
          wave: 2,
          status: "failed",
          totalCases: 1,
          requestPayload: {
            uransRequestId: transientRequest.id,
            uransFidelity: "precalc",
            aoas: [ANGLES[0]],
          },
        },
        {
          airfoilId,
          bcIds: [setupA.bcId],
          simulationPresetRevisionId: setupA.revisionId,
          campaignId: null,
          jobKind: "targeted",
          referenceChordM: CHORD,
          wave: 2,
          status: "failed",
          totalCases: 1,
          requestPayload: {
            uransRequestId: meshRequest.id,
            uransFidelity: "precalc",
            aoas: [ANGLES[1]],
          },
        },
      ])
      .returning();
    await db
      .update(simUransRequests)
      .set({ simJobId: transientJob.id })
      .where(eq(simUransRequests.id, transientRequest.id));
    const transientError =
      "OpenFOAMError: transient pimpleFoam process exited unexpectedly";
    const meshError =
      "OpenFOAMError: mesh degenerate at this fidelity tier (max non-orthogonality 88.3 deg): checkMesh max non-orthogonality exceeds 85.0 deg";
    const [transientResult, meshResult] = await db
      .insert(results)
      .values([
        {
          airfoilId,
          bcId: setupA.bcId,
          simulationPresetRevisionId: setupA.revisionId,
          aoaDeg: ANGLES[0],
          status: "failed",
          source: "queued",
          regime: "urans",
          fidelity: "urans_precalc",
          simJobId: transientJob.id,
          error: transientError,
          converged: false,
          unsteady: true,
          solvedAt: new Date(),
        },
        {
          airfoilId,
          bcId: setupA.bcId,
          simulationPresetRevisionId: setupA.revisionId,
          aoaDeg: ANGLES[1],
          status: "failed",
          source: "queued",
          regime: "urans",
          fidelity: "urans_precalc",
          simJobId: meshJob.id,
          error: meshError,
          converged: false,
          unsteady: true,
          solvedAt: new Date(),
        },
      ])
      .returning();
    for (const campaignId of [campaignA, campaignB]) {
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal", resultId: transientResult.id })
        .where(
          and(
            eq(simCampaignPoints.campaignId, campaignId),
            eq(simCampaignPoints.aoaDeg, ANGLES[0]),
          ),
        );
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal", resultId: meshResult.id })
        .where(
          and(
            eq(simCampaignPoints.campaignId, campaignId),
            eq(simCampaignPoints.aoaDeg, ANGLES[1]),
          ),
        );
    }

    // Running jobs can publish partial failures. Do not reopen the shared
    // request until terminal settlement changes it to done, or a duplicate
    // engine submission can race the still-running original.
    const deferred = await autoRetryCrashedResultsForJob(db, transientJob.id);
    expect(deferred.retried).toEqual([]);
    expect(deferred.precalcRouted).toEqual([]);
    expect(deferred.terminalBlocked).toEqual([]);
    const [stillRunningRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, transientRequest.id));
    expect(stillRunningRequest).toMatchObject({
      state: "running",
      simJobId: transientJob.id,
    });
    await db
      .update(simUransRequests)
      .set({ state: "done" })
      .where(eq(simUransRequests.id, transientRequest.id));

    const routed = await autoRetryCrashedResultsForJob(db, transientJob.id);
    expect(routed.retried).toEqual([]);
    expect(routed.precalcRouted.map((cell) => cell.resultId)).toEqual([
      transientResult.id,
    ]);
    expect(routed.terminalBlocked).toEqual([]);
    const suppressed = await autoRetryCrashedResultsForJob(db, meshJob.id);
    expect(suppressed.retried).toEqual([]);
    expect(suppressed.precalcRouted).toEqual([]);
    expect(suppressed.suppressed.map((cell) => cell.resultId)).toEqual([
      meshResult.id,
    ]);

    const [reopenedRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, transientRequest.id));
    const [blockedRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, meshRequest.id));
    expect(reopenedRequest).toMatchObject({ state: "pending", simJobId: null });
    expect(blockedRequest.state).toBe("done");
    const afterFirstFailure = await db
      .select({
        id: results.id,
        status: results.status,
        simJobId: results.simJobId,
        autoRetriedAt: results.autoRetriedAt,
      })
      .from(results)
      .where(inArray(results.id, [transientResult.id, meshResult.id]));
    const byResultId = new Map(
      afterFirstFailure.map((result) => [result.id, result]),
    );
    expect(byResultId.get(transientResult.id)).toMatchObject({
      status: "queued",
      simJobId: null,
    });
    expect(byResultId.get(transientResult.id)?.autoRetriedAt).not.toBeNull();
    expect(byResultId.get(meshResult.id)).toMatchObject({
      status: "failed",
      simJobId: meshJob.id,
    });
    expect(byResultId.get(meshResult.id)?.autoRetriedAt).toBeNull();
    for (const campaignId of [campaignA, campaignB]) {
      expect(
        await findCampaignGapBatch(db, {
          limit: 500,
          campaignIds: [campaignId],
        }),
      ).toBeNull();
      expect(await campaignOpenTierCounts(db, campaignId)).toEqual({
        ransOpen: 0,
        precalcOpen: 1,
        verifyOpen: 0,
      });
    }

    const [secondJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setupA.bcId],
        simulationPresetRevisionId: setupA.revisionId,
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "failed",
        totalCases: 1,
        requestPayload: {
          uransRequestId: transientRequest.id,
          uransFidelity: "precalc",
          aoas: [ANGLES[0]],
        },
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({ state: "done", simJobId: secondJob.id })
      .where(eq(simUransRequests.id, transientRequest.id));
    await db
      .update(results)
      .set({
        status: "failed",
        source: "queued",
        simJobId: secondJob.id,
        error: "OpenFOAMError: transient crashed again after automatic retry",
      })
      .where(eq(results.id, transientResult.id));
    await db
      .update(simCampaignPoints)
      .set({ state: "terminal", resultId: transientResult.id })
      .where(
        and(
          inArray(simCampaignPoints.campaignId, [campaignA, campaignB]),
          eq(simCampaignPoints.aoaDeg, ANGLES[0]),
        ),
      );

    const exhausted = await autoRetryCrashedResultsForJob(db, secondJob.id);
    expect(exhausted.retried).toEqual([]);
    expect(exhausted.precalcRouted).toEqual([]);
    expect(exhausted.escalated.map((cell) => cell.resultId)).toEqual([
      transientResult.id,
    ]);
    const [spentRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, transientRequest.id));
    expect(spentRequest.state).toBe("done");
    for (const campaignId of [campaignA, campaignB]) {
      expect(await campaignOpenTierCounts(db, campaignId)).toEqual({
        ransOpen: 0,
        precalcOpen: 0,
        verifyOpen: 0,
      });
      await probeCampaignCompletion(db, campaignId);
    }
    const finishedCampaigns = await db
      .select({ id: simCampaigns.id, status: simCampaigns.status })
      .from(simCampaigns)
      .where(inArray(simCampaigns.id, [campaignA, campaignB]));
    expect(
      finishedCampaigns.every((campaign) => campaign.status === "attention"),
    ).toBe(true);
  }, 120000);

  it("retains late shared precalc failure after its only campaign owner is cancelled", async () => {
    const campaignId = await launch("cancelled-owner-late-precalc", 28.137);
    const setup = await setupFor(campaignId);
    const [request] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg: ANGLES[0],
        fidelity: "precalc",
        state: "running",
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      })
      .returning();
    await db
      .insert(simUransRequestCampaigns)
      .values({ requestId: request.id, campaignId });
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "submitted",
        engineJobId: `${PREFIX}-cancelled-owner-late-precalc-engine`,
        submittedAt: new Date(),
        totalCases: 1,
        requestPayload: {
          uransRequestId: request.id,
          uransFidelity: "precalc",
          aoas: [ANGLES[0]],
        },
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({ simJobId: job.id })
      .where(eq(simUransRequests.id, request.id));

    const cancelled = await cancelCampaign(db, campaignId);
    expect(cancelled.runningJobsFinishing).toBe(1);
    await db
      .update(simUransRequests)
      .set({ state: "done" })
      .where(eq(simUransRequests.id, request.id));
    await db
      .update(simJobs)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(simJobs.id, job.id));
    const [lateFailure] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: ANGLES[0],
        status: "failed",
        source: "queued",
        regime: "urans",
        fidelity: "urans_precalc",
        simJobId: job.id,
        error: "OpenFOAMError: late transient crash after owner cancellation",
        converged: false,
        unsteady: true,
        solvedAt: new Date(),
      })
      .returning();

    const outcome = await autoRetryCrashedResultsForJob(db, job.id);
    expect(outcome.retried).toEqual([]);
    expect(outcome.precalcRouted).toEqual([]);
    expect(outcome.terminalBlocked.map((cell) => cell.resultId)).toEqual([
      lateFailure.id,
    ]);
    const [retained] = await db
      .select()
      .from(results)
      .where(eq(results.id, lateFailure.id));
    expect(retained).toMatchObject({
      status: "failed",
      simJobId: job.id,
      autoRetriedAt: null,
    });
    const [terminalCampaign] = await db
      .select({ status: simCampaigns.status })
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignId));
    expect(terminalCampaign.status).toBe("cancelled");
    const campaignPoints = await db
      .select({ state: simCampaignPoints.state })
      .from(simCampaignPoints)
      .where(eq(simCampaignPoints.campaignId, campaignId));
    expect(campaignPoints.every((point) => point.state === "released")).toBe(
      true,
    );
    expect(
      await findCampaignGapBatch(db, { limit: 500, campaignIds: [campaignId] }),
    ).toBeNull();
  }, 120000);

  it("keeps a spent bounded continuation terminal instead of reopening it", async () => {
    const campaignId = await launch("spent-bounded-continuation", 28.637);
    const setup = await setupFor(campaignId);
    const [source] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: ANGLES[0],
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.45,
        cd: 0.025,
        cm: -0.03,
        converged: true,
        unsteady: true,
        engineJobId: `${PREFIX}-spent-continuation-source-engine`,
        engineCaseSlug: `${PREFIX}-spent-continuation-source-case`,
        solvedAt: new Date(),
      })
      .returning();
    const [request] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg: ANGLES[0],
        fidelity: "precalc",
        state: "done",
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
        continueFromResultId: source.id,
      })
      .returning();
    await db
      .insert(simUransRequestCampaigns)
      .values({ requestId: request.id, campaignId });
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "failed",
        totalCases: 1,
        requestPayload: {
          uransRequestId: request.id,
          continueFromResultId: source.id,
          uransFidelity: "precalc",
          aoas: [ANGLES[0]],
        },
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({ simJobId: job.id })
      .where(eq(simUransRequests.id, request.id));
    await db
      .update(results)
      .set({
        status: "failed",
        source: "queued",
        simJobId: job.id,
        error: "OpenFOAMError: bounded continuation crashed",
        converged: false,
      })
      .where(eq(results.id, source.id));
    await db
      .update(simCampaignPoints)
      .set({ state: "terminal", resultId: source.id })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.aoaDeg, ANGLES[0]),
        ),
      );
    await db
      .update(simCampaignPoints)
      .set({ state: "released" })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.aoaDeg, ANGLES[1]),
        ),
      );

    const outcome = await autoRetryCrashedResultsForJob(db, job.id);
    expect(outcome.retried).toEqual([]);
    expect(outcome.precalcRouted).toEqual([]);
    expect(outcome.terminalBlocked.map((cell) => cell.resultId)).toEqual([
      source.id,
    ]);
    const [retained] = await db
      .select()
      .from(results)
      .where(eq(results.id, source.id));
    expect(retained).toMatchObject({
      status: "failed",
      simJobId: job.id,
      autoRetriedAt: null,
    });
    expect(await campaignOpenTierCounts(db, campaignId)).toEqual({
      ransOpen: 0,
      precalcOpen: 0,
      verifyOpen: 0,
    });
    await probeCampaignCompletion(db, campaignId);
    const [campaign] = await db
      .select({ status: simCampaigns.status })
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignId));
    expect(campaign.status).toBe("attention");
  }, 120000);

  it("promotes manual reuse of an automatic request to an independent owner through cancellation, verification, and media discovery", async () => {
    const campaignId = await launch("manual-reuses-auto-request", 29.137);
    const setup = await setupFor(campaignId);
    const [automatic] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg: ANGLES[0],
        fidelity: "precalc",
        state: "pending",
        backgroundOwner: false,
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      })
      .returning();
    await db
      .insert(simUransRequestCampaigns)
      .values({ requestId: automatic.id, campaignId });

    const manualReuse = await createUransRequest(db, {
      airfoilId,
      revisionId: setup.revisionId,
      aoaDeg: ANGLES[0],
      fidelity: "precalc",
      requestedBy: `${PREFIX}-admin@airfoils.pro`,
    });
    expect(manualReuse.created).toBe(false);
    expect(manualReuse.request).toMatchObject({
      id: automatic.id,
      state: "pending",
      backgroundOwner: true,
      // Creator provenance is immutable: promotion must not rewrite it to the
      // later administrator who acquired independent ownership.
      requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
    });

    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "pending",
        totalCases: 1,
        requestPayload: {
          uransRequestId: automatic.id,
          uransFidelity: "precalc",
          aoas: [ANGLES[0]],
        },
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({ state: "running", simJobId: job.id })
      .where(eq(simUransRequests.id, automatic.id));

    const cancelled = await cancelCampaign(db, campaignId);
    expect(cancelled.cancelledPendingJobs).toBe(0);
    const [afterCancel] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, automatic.id));
    expect(afterCancel).toMatchObject({
      state: "running",
      simJobId: job.id,
      backgroundOwner: true,
      requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
    });
    const [cancelledAssociation] = await db
      .select({ state: simUransRequestCampaigns.state })
      .from(simUransRequestCampaigns)
      .where(
        and(
          eq(simUransRequestCampaigns.requestId, automatic.id),
          eq(simUransRequestCampaigns.campaignId, campaignId),
        ),
      );
    expect(cancelledAssociation.state).toBe("cancelled");
    const [pendingJob] = await db
      .select({ status: simJobs.status })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(pendingJob.status).toBe("pending");

    const engineJobId = `${PREFIX}-manual-reuse-engine`;
    const submit = await submitPendingJobWithLifecycleGuard({
      db,
      engine: {
        submitPolar: async (): Promise<JobStatus> => ({
          job_id: engineJobId,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        }),
      } as unknown as EngineClient,
      jobId: job.id,
      campaignId: null,
      request: {} as PolarRequest,
      connectionErrorPrefix: "unreachable: ",
      submitErrorPrefix: "failed: ",
    });
    expect(submit.kind).toBe("submitted");

    const [accepted] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: ANGLES[0],
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        simJobId: job.id,
        engineJobId,
        engineCaseSlug: `${PREFIX}-manual-reuse-case`,
        cl: 0.45,
        cd: 0.025,
        cm: -0.03,
        converged: true,
        unsteady: true,
        solvedAt: new Date(),
      })
      .returning();
    const [acceptedAttempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: accepted.id,
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: ANGLES[0],
        status: "done",
        source: "solved",
        regime: "urans",
        simJobId: job.id,
        engineJobId,
        engineCaseSlug: `${PREFIX}-manual-reuse-case`,
        cl: 0.45,
        cd: 0.025,
        cm: -0.03,
        converged: true,
        unsteady: true,
        evidencePayload: { fidelity: "urans_precalc" },
        solvedAt: new Date(),
      })
      .returning({ id: resultAttempts.id });
    await db
      .update(results)
      .set({ currentResultAttemptId: acceptedAttempt.id })
      .where(eq(results.id, accepted.id));
    const manifestSha = "a".repeat(64);
    await db.insert(solverEvidenceArtifacts).values({
      resultId: accepted.id,
      resultAttemptId: acceptedAttempt.id,
      airfoilId,
      simJobId: job.id,
      engineJobId,
      engineCaseSlug: `${PREFIX}-manual-reuse-case`,
      aoaDeg: ANGLES[0],
      kind: "manifest",
      storageKey: `${PREFIX}/manual-reuse/manifest.json`,
      mimeType: "application/json",
      sha256: manifestSha,
      byteSize: 128,
    });
    await db.insert(resultClassifications).values({
      resultId: accepted.id,
      resultAttemptId: acceptedAttempt.id,
      airfoilId,
      simulationPresetRevisionId: setup.revisionId,
      aoaDeg: ANGLES[0],
      regime: "urans",
      classifierVersion: `${PREFIX}-manual-reuse-accepted-v1`,
      state: "accepted",
      reasons: [],
    });
    const [submittedJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    await enqueueVerificationsForJob(db, submittedJob);

    const [verification] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.precalcResultId, accepted.id));
    expect(verification).toMatchObject({
      state: "pending",
      backgroundOwner: true,
    });
    const verificationOwners = await db
      .select()
      .from(simUransVerifyQueueCampaigns)
      .where(eq(simUransVerifyQueueCampaigns.queueId, verification.id));
    expect(verificationOwners).toEqual([]);

    const repairRetryAt = new Date(Date.now() + 60_000);
    await db.insert(resultMediaRepairs).values({
      resultId: accepted.id,
      resultAttemptId: acceptedAttempt.id,
      state: "retry_wait",
      evidenceSignature: `${engineJobId}:${PREFIX}-manual-reuse-case:${manifestSha}`,
      backgroundOwner: false,
      attemptCount: 2,
      nextAttemptAt: repairRetryAt,
      lastError: "campaign-owned repair waiting before manual promotion",
    });
    expect(
      await discoverMissingResultMediaRepairs(db, { resultId: accepted.id }),
    ).toBe(1);
    const [repair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, accepted.id));
    expect(repair).toMatchObject({
      state: "retry_wait",
      backgroundOwner: true,
      attemptCount: 2,
      lastError: "campaign-owned repair waiting before manual promotion",
    });
    expect(repair.nextAttemptAt.toISOString()).toBe(
      repairRetryAt.toISOString(),
    );
  }, 120000);

  it("serializes manual ownership promotion with campaign cancellation", async () => {
    const campaignId = await launch("manual-promotion-cancel-race", 29.637);
    const setup = await setupFor(campaignId);
    const [automatic] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg: ANGLES[0],
        fidelity: "precalc",
        state: "pending",
        backgroundOwner: false,
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      })
      .returning();
    await db
      .insert(simUransRequestCampaigns)
      .values({ requestId: automatic.id, campaignId });

    const [manual] = await Promise.all([
      createUransRequest(db, {
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg: ANGLES[0],
        fidelity: "precalc",
        requestedBy: `${PREFIX}-racing-admin@airfoils.pro`,
      }),
      cancelCampaign(db, campaignId),
    ]);
    expect(manual.request).toMatchObject({
      state: "pending",
      backgroundOwner: true,
    });
    const open = await db
      .select()
      .from(simUransRequests)
      .where(
        and(
          eq(simUransRequests.airfoilId, airfoilId),
          eq(simUransRequests.revisionId, setup.revisionId),
          eq(simUransRequests.aoaDeg, ANGLES[0]),
          eq(simUransRequests.fidelity, "precalc"),
          inArray(simUransRequests.state, ["pending", "running"]),
        ),
      );
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      id: manual.request.id,
      backgroundOwner: true,
    });
    const [campaign] = await db
      .select({ status: simCampaigns.status })
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignId));
    expect(campaign.status).toBe("cancelled");
  }, 120000);

  it("propagates both independent and live campaign ownership to one verification", async () => {
    const campaignId = await launch("dual-owner-verification", 30.137);
    const setup = await setupFor(campaignId);
    const [request] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg: ANGLES[0],
        fidelity: "precalc",
        state: "running",
        backgroundOwner: true,
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      })
      .returning();
    await db
      .insert(simUransRequestCampaigns)
      .values({ requestId: request.id, campaignId });
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "submitted",
        engineJobId: `${PREFIX}-dual-owner-engine`,
        submittedAt: new Date(),
        totalCases: 1,
        requestPayload: {
          uransRequestId: request.id,
          uransFidelity: "precalc",
          aoas: [ANGLES[0]],
        },
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({ simJobId: job.id })
      .where(eq(simUransRequests.id, request.id));
    const [accepted] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: ANGLES[0],
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        simJobId: job.id,
        engineJobId: `${PREFIX}-dual-owner-engine`,
        engineCaseSlug: `${PREFIX}-dual-owner-case`,
        cl: 0.5,
        cd: 0.026,
        cm: -0.03,
        converged: true,
        unsteady: true,
        solvedAt: new Date(),
      })
      .returning();
    await db.insert(resultClassifications).values({
      resultId: accepted.id,
      airfoilId,
      simulationPresetRevisionId: setup.revisionId,
      aoaDeg: ANGLES[0],
      regime: "urans",
      classifierVersion: `${PREFIX}-dual-owner-accepted-v1`,
      state: "accepted",
      reasons: [],
    });
    await db
      .update(simCampaignPoints)
      .set({ state: "terminal", resultId: accepted.id })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.aoaDeg, ANGLES[0]),
        ),
      );

    await enqueueVerificationsForJob(db, job);
    const [verification] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.precalcResultId, accepted.id));
    expect(verification).toMatchObject({
      state: "pending",
      backgroundOwner: true,
    });
    const [owner] = await db
      .select()
      .from(simUransVerifyQueueCampaigns)
      .where(
        and(
          eq(simUransVerifyQueueCampaigns.queueId, verification.id),
          eq(simUransVerifyQueueCampaigns.campaignId, campaignId),
        ),
      );
    expect(owner.state).toBe("active");

    await cancelCampaign(db, campaignId);
    const [afterCancel] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, verification.id));
    const [ownerAfterCancel] = await db
      .select()
      .from(simUransVerifyQueueCampaigns)
      .where(
        and(
          eq(simUransVerifyQueueCampaigns.queueId, verification.id),
          eq(simUransVerifyQueueCampaigns.campaignId, campaignId),
        ),
      );
    expect(afterCancel).toMatchObject({
      state: "pending",
      backgroundOwner: true,
    });
    expect(ownerAfterCancel.state).toBe("cancelled");
  }, 120000);

  it("schedules from background_owner rather than requested_by provenance", async () => {
    const campaignId = await launch("request-owner-not-creator", 30.637);
    const setup = await setupFor(campaignId);
    const [creatorOnly, promotedSystem] = await db
      .insert(simUransRequests)
      .values([
        {
          airfoilId,
          revisionId: setup.revisionId,
          aoaDeg: ANGLES[0],
          fidelity: "precalc",
          state: "pending",
          backgroundOwner: false,
          requestedBy: `${PREFIX}-creator-only-admin@airfoils.pro`,
        },
        {
          airfoilId,
          revisionId: setup.revisionId,
          aoaDeg: ANGLES[1],
          fidelity: "precalc",
          state: "pending",
          backgroundOwner: true,
          requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
        },
      ])
      .returning();

    expect(
      await claimNextPendingUransRequest(db, {
        requestIds: [creatorOnly.id],
      }),
    ).toBeNull();
    const claimed = await claimNextPendingUransRequest(db, {
      requestIds: [promotedSystem.id],
    });
    expect(claimed).toMatchObject({
      id: promotedSystem.id,
      state: "running",
      backgroundOwner: true,
      requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
    });
    await releaseClaimedUransRequest(db, promotedSystem.id);
    const [released] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, promotedSystem.id));
    expect(released.state).toBe("pending");
  }, 120000);

  it("keeps verification ownership scoped per obligation in a mixed campaign/background batch", async () => {
    const campaignId = await launch(
      "mixed-precalc-verification-owners",
      31.737,
    );
    const setup = await setupFor(campaignId);
    const [campaignObligation] = await ensurePrecalcObligations(
      db,
      [
        {
          airfoilId,
          revisionId: setup.revisionId,
          aoaDeg: ANGLES[0],
        },
      ],
      { campaignIds: [campaignId] },
    );
    const [backgroundObligation] = await ensurePrecalcObligations(
      db,
      [
        {
          airfoilId,
          revisionId: setup.revisionId,
          aoaDeg: ANGLES[1],
        },
      ],
      { backgroundOwner: true },
    );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "done",
        totalCases: 2,
        completedCases: 2,
        requestPayload: {
          aoas: ANGLES,
          uransFidelity: "precalc",
          precalcObligationIds: [
            campaignObligation.id,
            backgroundObligation.id,
          ],
        },
      })
      .returning();
    const accepted = await db
      .insert(results)
      .values(
        ANGLES.map((aoaDeg, index) => ({
          airfoilId,
          bcId: setup.bcId,
          simulationPresetRevisionId: setup.revisionId,
          aoaDeg,
          status: "done" as const,
          source: "solved" as const,
          regime: "urans" as const,
          fidelity: "urans_precalc",
          simJobId: job.id,
          cl: 0.4 + index,
          cd: 0.03 + index * 0.01,
          cm: -0.04,
          converged: true,
          unsteady: true,
          solvedAt: new Date(),
        })),
      )
      .returning();
    await db.insert(resultClassifications).values(
      accepted.map((result) => ({
        resultId: result.id,
        airfoilId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: result.aoaDeg,
        regime: "urans" as const,
        classifierVersion: "mixed-owner-verification-v1",
        state: "accepted" as const,
        region: "attached" as const,
        confidence: 1,
        reasons: [],
      })),
    );
    await db
      .update(simCampaignPoints)
      .set({ state: "terminal", resultId: accepted[0].id })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.aoaDeg, ANGLES[0]),
        ),
      );

    await enqueueVerificationsForJob(db, job);
    const queue = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.revisionId, setup.revisionId));
    expect(queue).toHaveLength(2);
    const byAoa = new Map(queue.map((item) => [item.aoaDeg, item]));
    expect(byAoa.get(ANGLES[0])?.backgroundOwner).toBe(false);
    expect(byAoa.get(ANGLES[1])?.backgroundOwner).toBe(true);
    const ownership = await db
      .select()
      .from(simUransVerifyQueueCampaigns)
      .where(
        inArray(
          simUransVerifyQueueCampaigns.queueId,
          queue.map((item) => item.id),
        ),
      );
    expect(ownership).toEqual([
      expect.objectContaining({
        queueId: byAoa.get(ANGLES[0])!.id,
        campaignId,
        state: "active",
      }),
    ]);
    expect(
      await db
        .select()
        .from(simPrecalcObligationCampaigns)
        .where(
          eq(
            simPrecalcObligationCampaigns.obligationId,
            backgroundObligation.id,
          ),
        ),
    ).toHaveLength(0);
  }, 120000);

  it("rolls back a crash between failed-row stamping and campaign settlement, then an expired lease replays atomically", async () => {
    const campaignId = await launch("failed-ingest-atomic-replay", 31.137);
    const setup = await setupFor(campaignId);
    const batch = await findCampaignGapBatch(db, {
      campaignIds: [campaignId],
    });
    expect(batch).toBeTruthy();

    const engineJobId = `${PREFIX}-failed-ingest-atomic-engine`;
    expect(
      await submitCampaignBatch(
        db,
        {
          submitPolar: async (): Promise<JobStatus> => ({
            job_id: engineJobId,
            state: "pending",
            total_cases: ANGLES.length,
            completed_cases: 0,
          }),
        } as unknown as EngineClient,
        batch!,
        0,
        0,
      ),
    ).toBe(true);
    const [job] = await db
      .select()
      .from(simJobs)
      .where(
        and(
          eq(simJobs.campaignId, campaignId),
          eq(simJobs.engineJobId, engineJobId),
        ),
      );
    expect(job).toBeTruthy();
    // This regression is about atomic replay, not the independent one-shot
    // crash retry. Mark it already consumed so the recovered failure remains
    // terminal and its point/progress linkage is directly inspectable.
    await db
      .update(results)
      .set({ autoRetriedAt: new Date() })
      .where(eq(results.simJobId, job.id));

    const failedEngine = {
      getQueue: async () => ({
        active: [],
        reserved: [],
        scheduled: [],
        active_count: 0,
        reserved_count: 0,
        scheduled_count: 0,
        job_ids: [],
        redelivered: [],
      }),
      getJob: async (): Promise<JobStatus> => ({
        job_id: engineJobId,
        state: "failed",
        total_cases: ANGLES.length,
        completed_cases: 0,
        message: "solver process exited before producing a result",
      }),
      getResult: async () => {
        throw new Error("result file unavailable after solver exit");
      },
      cancelJob: async (id: string) => ({ job_id: id, cancelled: true }),
    } as unknown as EngineClient;

    await expect(
      reconcile(db, failedEngine, {
        jobIds: [job.id],
        skipFailedRecovery: true,
        testHooks: {
          afterFailedRowsMarked: () => {
            throw new Error("injected process crash after failed rows");
          },
        },
      }),
    ).rejects.toThrow("injected process crash");

    // The injected failure occurred after the UPDATE in source order, but the
    // transaction makes that intermediate state unobservable: no requested
    // campaign point can be paired with a failed cell.
    expect(await requestedFailedOrphans(campaignId)).toHaveLength(0);
    const afterCrash = await db
      .select({ status: results.status })
      .from(results)
      .where(eq(results.simJobId, job.id));
    expect(afterCrash.map((row) => row.status)).toEqual(["queued", "queued"]);

    await db
      .update(simJobs)
      .set({ ingestLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(simJobs.id, job.id));
    await reconcile(db, failedEngine, {
      jobIds: [job.id],
      skipFailedRecovery: true,
    });

    expect(await requestedFailedOrphans(campaignId)).toHaveLength(0);
    const settledRows = await db
      .select({
        id: results.id,
        status: results.status,
        cl: results.cl,
        cd: results.cd,
      })
      .from(results)
      .where(eq(results.simJobId, job.id));
    expect(settledRows).toHaveLength(ANGLES.length);
    expect(
      settledRows.every(
        (row) => row.status === "failed" && row.cl === null && row.cd === null,
      ),
    ).toBe(true);
    const settledPoints = await db
      .select({
        state: simCampaignPoints.state,
        resultId: simCampaignPoints.resultId,
      })
      .from(simCampaignPoints)
      .where(eq(simCampaignPoints.campaignId, campaignId));
    expect(
      settledPoints.every(
        (point) => point.state === "terminal" && point.resultId !== null,
      ),
    ).toBe(true);
    const [progress] = await db
      .select()
      .from(simCampaignProgress)
      .where(
        and(
          eq(simCampaignProgress.campaignId, campaignId),
          eq(simCampaignProgress.conditionId, setup.conditionId),
          eq(simCampaignProgress.airfoilId, airfoilId),
        ),
      );
    expect(progress).toMatchObject({
      failed: ANGLES.length,
      running: 0,
    });
    const [campaign] = await db
      .select({ status: simCampaigns.status })
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignId));
    expect(campaign.status).toBe("attention");
  }, 120000);

  it("blocks deterministic 422 submit rejection in one pass and exposes no same-cell gap on the next tick", async () => {
    const campaignId = await launch("submit-422-blocked", 32.137);
    const setup = await setupFor(campaignId);
    const batch = await findCampaignGapBatch(db, {
      campaignIds: [campaignId],
    });
    expect(batch).toBeTruthy();
    let submitCalls = 0;
    const engine = {
      submitPolar: async () => {
        submitCalls += 1;
        throw new EngineError("request validation rejected", 422);
      },
    } as unknown as EngineClient;

    expect(await submitCampaignBatch(db, engine, batch!, 0, 0)).toBe(false);
    expect(submitCalls).toBe(1);
    const blocked = await db
      .select({
        id: results.id,
        status: results.status,
        resultJobId: results.simJobId,
        retryState: simResultSubmitRetries.state,
        retryCount: simResultSubmitRetries.attemptCount,
        retryAfter: simResultSubmitRetries.nextAttemptAt,
        cl: results.cl,
        cd: results.cd,
      })
      .from(results)
      .leftJoin(
        simResultSubmitRetries,
        eq(simResultSubmitRetries.resultId, results.id),
      )
      .where(eq(results.simulationPresetRevisionId, setup.revisionId));
    expect(blocked).toHaveLength(ANGLES.length);
    expect(
      blocked.every(
        (row) =>
          row.status === "failed" &&
          row.resultJobId !== null &&
          row.retryState === "blocked" &&
          row.retryCount === 0 &&
          row.retryAfter === null &&
          row.cl === null &&
          row.cd === null,
      ),
    ).toBe(true);
    expect(await requestedFailedOrphans(campaignId)).toHaveLength(0);
    expect(
      await findCampaignGapBatch(db, { campaignIds: [campaignId] }),
    ).toBeNull();
    expect(submitCalls).toBe(1);
    const attempts = await db
      .select({ id: resultAttempts.id })
      .from(resultAttempts)
      .where(
        inArray(
          resultAttempts.resultId,
          blocked.map((row) => row.id),
        ),
      );
    expect(attempts).toHaveLength(0);
  }, 120000);

  it("settles precalc 422/503 policy atomically without rewriting canonical RANS evidence", async () => {
    const campaignId = await launch("precalc-submit-policy", 32.737);
    const setup = await setupFor(campaignId);
    const canonical = await db
      .insert(results)
      .values(
        ANGLES.map((aoaDeg, index) => ({
          airfoilId,
          bcId: setup.bcId,
          simulationPresetRevisionId: setup.revisionId,
          aoaDeg,
          status: "done" as const,
          source: "solved" as const,
          regime: "rans" as const,
          fidelity: "rans",
          cl: 0.2 + index,
          cd: 0.02 + index * 0.01,
          cm: -0.03,
          error: `retained-rans-${aoaDeg}`,
          converged: true,
          solvedAt: new Date(),
        })),
      )
      .returning();
    await db.insert(resultClassifications).values(
      canonical.map((result) => ({
        resultId: result.id,
        airfoilId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: result.aoaDeg,
        regime: "rans" as const,
        classifierVersion: "precalc-submit-policy-v1",
        state: "rejected" as const,
        region: "attached" as const,
        confidence: 1,
        reasons: ["RANS requires unsteady treatment"],
      })),
    );
    for (const result of canonical) {
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal", resultId: result.id })
        .where(
          and(
            eq(simCampaignPoints.campaignId, campaignId),
            eq(simCampaignPoints.aoaDeg, result.aoaDeg),
          ),
        );
    }
    const obligations = await ensurePrecalcObligations(
      db,
      ANGLES.map((aoaDeg, index) => ({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg,
        sourceResultId: canonical[index].id,
      })),
      { campaignIds: [campaignId] },
    );

    const submitFailure = async (
      obligationId: string,
      aoaDeg: number,
      status: number,
      label: string,
      makeDue = false,
    ) => {
      const [job] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [setup.bcId],
          simulationPresetRevisionId: setup.revisionId,
          campaignId: null,
          jobKind: "targeted",
          referenceChordM: CHORD,
          wave: 2,
          status: "pending",
          totalCases: 1,
          requestPayload: {
            aoas: [aoaDeg],
            uransFidelity: "precalc",
            precalcObligationIds: [obligationId],
          },
        })
        .returning();
      await db
        .update(simPrecalcObligations)
        .set({
          latestSimJobId: job.id,
          lastOutcome: "composed",
          ...(makeDue ? { nextSubmitAt: new Date(Date.now() - 1_000) } : {}),
        })
        .where(eq(simPrecalcObligations.id, obligationId));
      const outcome = await submitPendingJobWithLifecycleGuard({
        db,
        engine: {
          submitPolar: async () => {
            throw new EngineError(label, status);
          },
        } as unknown as EngineClient,
        jobId: job.id,
        campaignId: null,
        request: {} as PolarRequest,
        connectionErrorPrefix: "connection: ",
        submitErrorPrefix: "precalc submit: ",
        precalcObligationIds: [obligationId],
      });
      expect(outcome.kind).toBe("submit_failed");
      return job;
    };

    const blockedJob = await submitFailure(
      obligations[0].id,
      ANGLES[0],
      422,
      "request validation rejected",
    );
    await submitFailure(
      obligations[1].id,
      ANGLES[1],
      503,
      "engine admission unavailable",
    );
    let [retryWait] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, obligations[1].id));
    expect(retryWait).toMatchObject({
      state: "pending",
      submitFailureCount: 1,
      lastOutcome: "submit_retry_wait",
    });
    expect(retryWait.nextSubmitAt).not.toBeNull();
    const exhaustedJob = await submitFailure(
      obligations[1].id,
      ANGLES[1],
      503,
      "engine admission unavailable again",
      true,
    );

    const settled = await db
      .select()
      .from(simPrecalcObligations)
      .where(
        inArray(
          simPrecalcObligations.id,
          obligations.map((obligation) => obligation.id),
        ),
      );
    expect(settled.every((obligation) => obligation.state === "blocked")).toBe(
      true,
    );
    expect(
      settled.find((obligation) => obligation.id === obligations[1].id)
        ?.submitFailureCount,
    ).toBe(2);
    const retained = await db
      .select({
        id: results.id,
        status: results.status,
        cl: results.cl,
        cd: results.cd,
        error: results.error,
      })
      .from(results)
      .where(
        inArray(
          results.id,
          canonical.map((result) => result.id),
        ),
      );
    expect(retained).toEqual(
      canonical.map((result, index) => ({
        id: result.id,
        status: "done",
        cl: 0.2 + index,
        cd: 0.02 + index * 0.01,
        error: `retained-rans-${result.aoaDeg}`,
      })),
    );
    expect(
      await db
        .select({ id: resultAttempts.id })
        .from(resultAttempts)
        .where(
          inArray(resultAttempts.simJobId, [blockedJob.id, exhaustedJob.id]),
        ),
    ).toHaveLength(0);
  }, 120000);

  it("MUST-CATCH: a structured mesh-capability 409 releases PRECALC for a fresh capability probe without consuming either budget", async () => {
    const campaignId = await launch("precalc-capability-cutover", 32.937);
    const setup = await setupFor(campaignId);
    const [obligation] = await ensurePrecalcObligations(
      db,
      [{ airfoilId, revisionId: setup.revisionId, aoaDeg: ANGLES[0] }],
      { campaignIds: [campaignId] },
    );

    const compose = async (suffix: string) => {
      const [job] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [setup.bcId],
          simulationPresetRevisionId: setup.revisionId,
          campaignId: null,
          jobKind: "targeted",
          referenceChordM: CHORD,
          wave: 2,
          status: "pending",
          totalCases: 1,
          requestPayload: {
            aoas: [ANGLES[0]],
            uransFidelity: "precalc",
            precalcObligationIds: [obligation.id],
            testSuffix: suffix,
          },
        })
        .returning();
      await db
        .update(simPrecalcObligations)
        .set({ latestSimJobId: job.id, lastOutcome: "composed" })
        .where(eq(simPrecalcObligations.id, obligation.id));
      return job;
    };

    const mismatchedJob = await compose("old-api-race");
    const mismatch = await submitPendingJobWithLifecycleGuard({
      db,
      engine: {
        submitPolar: async () => {
          throw new EngineError(
            "requested mesh recovery v1, API is v2",
            409,
            MESH_RECOVERY_CAPABILITY_MISMATCH_CODE,
          );
        },
      } as unknown as EngineClient,
      jobId: mismatchedJob.id,
      campaignId: null,
      request: {} as PolarRequest,
      connectionErrorPrefix: "connection: ",
      submitErrorPrefix: "precalc submit: ",
      precalcObligationIds: [obligation.id],
    });
    expect(mismatch).toMatchObject({ kind: "capability_mismatch" });

    const [afterMismatch] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, obligation.id));
    expect(afterMismatch).toMatchObject({
      state: "pending",
      attemptCount: 0,
      submitFailureCount: 0,
      lastOutcome: "composed",
    });
    expect(afterMismatch.nextSubmitAt).toBeNull();
    expect(
      await db
        .select({ id: simPrecalcObligationAttempts.id })
        .from(simPrecalcObligationAttempts)
        .where(eq(simPrecalcObligationAttempts.obligationId, obligation.id)),
    ).toHaveLength(0);

    const replacementJob = await compose("fresh-capability-probe");
    const replacement = await submitPendingJobWithLifecycleGuard({
      db,
      engine: {
        submitPolar: async () =>
          ({
            job_id: `${PREFIX}-capability-replacement-engine`,
            state: "pending",
            total_cases: 1,
            completed_cases: 0,
          }) as JobStatus,
      } as unknown as EngineClient,
      jobId: replacementJob.id,
      campaignId: null,
      request: {} as PolarRequest,
      connectionErrorPrefix: "connection: ",
      submitErrorPrefix: "precalc submit: ",
      precalcObligationIds: [obligation.id],
    });
    expect(replacement.kind).toBe("submitted");
    await recordPrecalcObligationSubmission(db, replacementJob.id, [
      obligation.id,
    ]);
    const [afterReplacement] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, obligation.id));
    expect(afterReplacement).toMatchObject({
      state: "running",
      attemptCount: 1,
      submitFailureCount: 0,
      latestSimJobId: replacementJob.id,
      lastOutcome: "submitted",
    });
  }, 120000);

  it("classifies a stationary budget-stopped PRECALC window as nonpublishable and keeps its obligation continuable", async () => {
    const campaignId = await launch("precalc-budget-stop", 33.337);
    const setup = await setupFor(campaignId);
    const aoaDeg = 52.337;
    const [obligation] = await ensurePrecalcObligations(
      db,
      [{ airfoilId, revisionId: setup.revisionId, aoaDeg }],
      { campaignIds: [campaignId] },
    );
    const warning = `${URANS_BUDGET_STOP_MARKER} wall budget reached`;
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "done",
        engineJobId: `${PREFIX}-budget-stop-engine`,
        submittedAt: new Date(),
        totalCases: 1,
        completedCases: 1,
        requestPayload: {
          aoas: [aoaDeg],
          uransFidelity: "precalc",
          precalcObligationIds: [obligation.id],
        },
      })
      .returning();
    await db
      .update(simPrecalcObligations)
      .set({ latestSimJobId: job.id })
      .where(eq(simPrecalcObligations.id, obligation.id));
    await recordPrecalcObligationSubmission(db, job.id, [obligation.id]);
    const frameTrack = { stationary: true, periods_retained: 3 };
    const [result] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        simJobId: job.id,
        engineJobId: job.engineJobId,
        engineCaseSlug: "a52_337",
        cl: 0.81,
        cd: 0.031,
        cm: -0.04,
        clCd: 26.129,
        converged: true,
        unsteady: true,
        stalled: true,
        qualityWarnings: [warning],
        frameTrack,
        solvedAt: new Date(),
      })
      .returning();
    const [attempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: result.id,
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg,
        simJobId: job.id,
        engineJobId: job.engineJobId,
        engineCaseSlug: "a52_337",
        status: "done",
        source: "solved",
        regime: "urans",
        validForPolar: false,
        cl: 0.81,
        cd: 0.031,
        cm: -0.04,
        clCd: 26.129,
        converged: true,
        unsteady: true,
        stalled: true,
        qualityWarnings: [warning],
        evidencePayload: { fidelity: "urans_precalc", frame_track: frameTrack },
        solvedAt: new Date(),
      })
      .returning();
    // An older cache/classifier may have labelled a numerically stationary
    // window accepted even though the engine explicitly said the wall-clock
    // budget stopped the PRECALC solve. Settlement must fail closed on the
    // immutable warning itself, before a cache refresh repairs that stale
    // classification.
    await db.insert(resultClassifications).values({
      resultId: result.id,
      resultAttemptId: attempt.id,
      airfoilId,
      simulationPresetRevisionId: setup.revisionId,
      aoaDeg,
      regime: "urans",
      classifierVersion: `${PREFIX}-legacy-accepted-budget-marker-v1`,
      state: "accepted",
      reasons: [],
    });
    await db.insert(forceHistory).values({
      resultId: result.id,
      t: [0, 1, 2, 3],
      cl: [0.8, 0.82, 0.8, 0.82],
      cd: [0.03, 0.032, 0.03, 0.032],
      sampleCount: 4,
    });
    await db.insert(resultMedia).values({
      resultId: result.id,
      kind: "video",
      field: "velocity_magnitude",
      role: "instantaneous",
      storageKey: `${PREFIX}/budget-stop.mp4`,
      mimeType: "video/mp4",
    });

    await settlePrecalcObligationsForJob(db, job);
    const [afterObligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, obligation.id));
    const [afterLedger] = await db
      .select()
      .from(simPrecalcObligationAttempts)
      .where(eq(simPrecalcObligationAttempts.obligationId, obligation.id));
    expect(afterObligation).toMatchObject({
      state: "pending",
      attemptCount: 1,
      lastOutcome: "rejected",
    });
    expect(afterLedger).toMatchObject({
      state: "rejected",
      resultAttemptId: attempt.id,
    });

    await refreshPolarCacheForRevision(db, airfoilId, setup.revisionId);
    const [classification] = await db
      .select()
      .from(resultClassifications)
      .where(eq(resultClassifications.resultAttemptId, attempt.id));
    expect(classification.state).toBe("rejected");
  }, 120000);

  it("persists one delayed retry for 5xx submit failures, then blocks the second answered failure", async () => {
    const campaignId = await launch("submit-5xx-bounded", 33.137);
    const setup = await setupFor(campaignId);
    let submitCalls = 0;
    const engine = {
      submitPolar: async () => {
        submitCalls += 1;
        throw new EngineError("engine admission service unavailable", 503);
      },
    } as unknown as EngineClient;

    const firstBatch = await findCampaignGapBatch(db, {
      campaignIds: [campaignId],
    });
    expect(firstBatch).toBeTruthy();
    expect(await submitCampaignBatch(db, engine, firstBatch!, 0, 0)).toBe(
      false,
    );
    expect(submitCalls).toBe(1);
    const delayed = await db
      .select({
        id: results.id,
        status: results.status,
        simJobId: results.simJobId,
        retryState: simResultSubmitRetries.state,
        retryCount: simResultSubmitRetries.attemptCount,
        retryAfter: simResultSubmitRetries.nextAttemptAt,
      })
      .from(results)
      .leftJoin(
        simResultSubmitRetries,
        eq(simResultSubmitRetries.resultId, results.id),
      )
      .where(eq(results.simulationPresetRevisionId, setup.revisionId));
    expect(delayed).toHaveLength(ANGLES.length);
    expect(
      delayed.every(
        (row) =>
          row.status === "pending" &&
          row.simJobId === null &&
          row.retryState === "retry_wait" &&
          row.retryCount === 1 &&
          row.retryAfter !== null &&
          row.retryAfter.getTime() > Date.now(),
      ),
    ).toBe(true);
    // The second scheduler tick before the persisted due time cannot reclaim.
    expect(
      await findCampaignGapBatch(db, { campaignIds: [campaignId] }),
    ).toBeNull();

    await db
      .update(simResultSubmitRetries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(
        inArray(
          simResultSubmitRetries.resultId,
          delayed.map((row) => row.id),
        ),
      );
    const retryBatch = await findCampaignGapBatch(db, {
      campaignIds: [campaignId],
    });
    expect(retryBatch).toBeTruthy();
    expect(await submitCampaignBatch(db, engine, retryBatch!, 0, 0)).toBe(
      false,
    );
    expect(submitCalls).toBe(2);

    const blocked = await db
      .select({
        id: results.id,
        status: results.status,
        simJobId: results.simJobId,
        retryState: simResultSubmitRetries.state,
        retryCount: simResultSubmitRetries.attemptCount,
        retryAfter: simResultSubmitRetries.nextAttemptAt,
        cl: results.cl,
        cd: results.cd,
      })
      .from(results)
      .leftJoin(
        simResultSubmitRetries,
        eq(simResultSubmitRetries.resultId, results.id),
      )
      .where(eq(results.simulationPresetRevisionId, setup.revisionId));
    expect(
      blocked.every(
        (row) =>
          row.status === "failed" &&
          row.simJobId !== null &&
          row.retryState === "blocked" &&
          row.retryCount === 1 &&
          row.retryAfter === null &&
          row.cl === null &&
          row.cd === null,
      ),
    ).toBe(true);
    expect(await requestedFailedOrphans(campaignId)).toHaveLength(0);
    expect(
      await findCampaignGapBatch(db, { campaignIds: [campaignId] }),
    ).toBeNull();
    const attempts = await db
      .select({ id: resultAttempts.id })
      .from(resultAttempts)
      .where(
        inArray(
          resultAttempts.resultId,
          blocked.map((row) => row.id),
        ),
      );
    expect(attempts).toHaveLength(0);
  }, 120000);

  it("releases connection failures indefinitely without consuming the answered-submit retry budget", async () => {
    const campaignId = await launch("submit-connection-unbounded", 34.137);
    const setup = await setupFor(campaignId);
    let submitCalls = 0;
    const engine = {
      submitPolar: async () => {
        submitCalls += 1;
        throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
      },
    } as unknown as EngineClient;

    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const batch = await findCampaignGapBatch(db, {
          campaignIds: [campaignId],
        });
        expect(batch).toBeTruthy();
        expect(await submitCampaignBatch(db, engine, batch!, 0, 0)).toBe(false);
        expect(submitCalls).toBe(attempt);
        expect(currentBackoffMs()).toBeGreaterThan(0);

        const released = await db
          .select({
            status: results.status,
            simJobId: results.simJobId,
            retryState: simResultSubmitRetries.state,
          })
          .from(results)
          .leftJoin(
            simResultSubmitRetries,
            eq(simResultSubmitRetries.resultId, results.id),
          )
          .where(eq(results.simulationPresetRevisionId, setup.revisionId));
        expect(released).toHaveLength(ANGLES.length);
        expect(
          released.every(
            (row) =>
              row.status === "pending" &&
              row.simJobId === null &&
              row.retryState === null,
          ),
        ).toBe(true);
        expect(
          await findCampaignGapBatch(db, { campaignIds: [campaignId] }),
        ).toBeTruthy();

        // Model the ordinary connection backoff window elapsing. Transport
        // failures deliberately have no per-cell retry budget.
        resetEngineBackoffForTests();
      }
    } finally {
      await clearEngineUnreachable(db);
    }
  }, 120000);

  it("startup recovery reopens a paused campaign request but settles a terminal campaign request", async () => {
    const pausedCampaignId = await launch("orphan-request-paused", 23.137);
    const terminalCampaignId = await launch("orphan-request-terminal", 24.137);
    const pausedSetup = await setupFor(pausedCampaignId);
    const terminalSetup = await setupFor(terminalCampaignId);
    await pauseCampaign(db, pausedCampaignId);
    await cancelCampaign(db, terminalCampaignId);

    const [pausedRequest, terminalRequest] = await db
      .insert(simUransRequests)
      .values([
        {
          airfoilId,
          revisionId: pausedSetup.revisionId,
          aoaDeg: ANGLES[0],
          fidelity: "precalc",
          state: "running",
          requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
        },
        {
          airfoilId,
          revisionId: terminalSetup.revisionId,
          aoaDeg: ANGLES[0],
          fidelity: "precalc",
          state: "running",
          requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
        },
      ])
      .returning();
    await db.insert(simUransRequestCampaigns).values([
      { requestId: pausedRequest.id, campaignId: pausedCampaignId },
      { requestId: terminalRequest.id, campaignId: terminalCampaignId },
    ]);
    const [pausedJob, terminalJob] = await db
      .insert(simJobs)
      .values([
        {
          airfoilId,
          bcIds: [pausedSetup.bcId],
          simulationPresetRevisionId: pausedSetup.revisionId,
          campaignId: null,
          jobKind: "targeted",
          referenceChordM: CHORD,
          wave: 2,
          status: "pending",
          totalCases: 1,
          requestPayload: {
            uransRequestId: pausedRequest.id,
            uransFidelity: "precalc",
            aoas: [ANGLES[0]],
          },
        },
        {
          airfoilId,
          bcIds: [terminalSetup.bcId],
          simulationPresetRevisionId: terminalSetup.revisionId,
          campaignId: null,
          jobKind: "targeted",
          referenceChordM: CHORD,
          wave: 2,
          status: "pending",
          totalCases: 1,
          requestPayload: {
            uransRequestId: terminalRequest.id,
            uransFidelity: "precalc",
            aoas: [ANGLES[0]],
          },
        },
      ])
      .returning();
    await db
      .update(simUransRequests)
      .set({ simJobId: pausedJob.id })
      .where(eq(simUransRequests.id, pausedRequest.id));
    await db
      .update(simUransRequests)
      .set({ simJobId: terminalJob.id })
      .where(eq(simUransRequests.id, terminalRequest.id));

    await resetOrphans(db, { jobIds: [pausedJob.id, terminalJob.id] });

    const requests = await db
      .select({
        id: simUransRequests.id,
        state: simUransRequests.state,
        simJobId: simUransRequests.simJobId,
      })
      .from(simUransRequests)
      .where(
        inArray(simUransRequests.id, [pausedRequest.id, terminalRequest.id]),
      );
    const byId = new Map(requests.map((request) => [request.id, request]));
    expect(byId.get(pausedRequest.id)).toMatchObject({
      state: "pending",
      simJobId: null,
    });
    expect(byId.get(terminalRequest.id)).toMatchObject({
      state: "cancelled",
      simJobId: terminalJob.id,
    });

    await db
      .delete(simUransRequests)
      .where(
        inArray(simUransRequests.id, [pausedRequest.id, terminalRequest.id]),
      );
  }, 120000);
});
