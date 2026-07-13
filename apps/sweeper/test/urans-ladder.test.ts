// URANS fidelity-ladder integration (contracts 3–7, migration 0034):
// schema pin, durable partial-route recording, wave-2 re-attempt at precalc
// fidelity, idempotent verify-queue enqueue,
// tier ordering (pending admin request ⇒ no verify consume), verify solve +
// disagreement path, request-URANS idempotency, phase derivation and
// completion blocking. Live shared-DB pattern (scoped rows, full cleanup).

import {
  AUTO_PRECALC_CONTINUATION_BUDGET_S,
  AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
  UransRequestCoverageConflict,
  airfoils,
  boundaryProfiles,
  campaignHasOpenRansGaps,
  campaignOpenTierCounts,
  campaignSummary,
  categories,
  claimNextPendingUransRequest,
  createClient,
  createUransRequest,
  deriveCampaignPhase,
  enqueuePrecalcVerifications,
  ensurePrecalcObligations,
  hasOpenCampaignLadderWork,
  healOrphanedUransRequests,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  outputProfiles,
  probeCampaignCompletion,
  resultAttempts,
  resultClassifications,
  results,
  schedulingProfiles,
  simCampaignConditions,
  simCampaignPoints,
  simCampaigns,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligationCampaigns,
  simPrecalcObligations,
  simulationPresetRevisions,
  simulationPresets,
  simUransRequestCampaigns,
  simUransRequests,
  simUransVerifyQueue,
  simUransVerifyQueueCampaigns,
  solverProfiles,
  sweeperState,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import {
  type EngineClient,
  type JobResult,
  type JobStatus,
  type PolarPoint,
  type PolarRequest,
} from "@aerodb/engine-client";
import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reconcile, submitUransRetryForJob } from "../src/reconcile";
import { resetUransLadderMemory, uransLadderTick } from "../src/urans-ladder";
import { withExactManifestEvidence } from "./exact-result-fixture";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-ladder-${process.pid}-${Date.now().toString(36)}`;
const mediaRoot = resolve("/tmp", `${PREFIX}-media`);
const previousMediaDir = process.env.MEDIA_DIR;
process.env.MEDIA_DIR = mediaRoot;

const here = dirname(fileURLToPath(import.meta.url));
const frameTrackFixture = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(resolve(here, "fixtures/frame-track-contract.json"), "utf8"),
  );

const ANGLES = [4, 8];
const SPEED = 20;
const CHORD = 0.253719;
const REJECTED_AOA = 8;

let campaignId = "";
let airfoilId = "";
let categoryId = "";
let mediumId = "";
let conditionId = "";
let revisionId = "";
let bcId = "";
let parentJobId = "";
const profileIds = {
  boundary: "",
  mesh: "",
  solver: "",
  scheduling: "",
  output: "",
};
let restoreSweeperEnabled: boolean | null = null;

const points = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

function stubEngine(
  capture: PolarRequest[],
  engineJobId: string,
): EngineClient {
  return {
    submitPolar: async (request: PolarRequest): Promise<JobStatus> => {
      capture.push(request);
      return {
        job_id: engineJobId,
        state: "pending",
        total_cases: request.aoa?.angles?.length ?? 0,
        completed_cases: 0,
      };
    },
  } as unknown as EngineClient;
}

/** Closed scheduler scope for this file's physical fixtures. Vitest files run
 * in parallel against one database; campaign scoping alone still permits tier
 * 2b to claim another file's global/admin request. */
async function ladderScope(): Promise<{
  campaignIds: string[];
  requestIds: string[];
  verifyIds: string[];
}> {
  const ownedRequests =
    airfoilId && revisionId
      ? await db
          .select({ id: simUransRequests.id })
          .from(simUransRequests)
          .where(
            and(
              eq(simUransRequests.airfoilId, airfoilId),
              eq(simUransRequests.revisionId, revisionId),
            ),
          )
      : [];
  const ownedVerifyItems =
    airfoilId && revisionId
      ? await db
          .select({ id: simUransVerifyQueue.id })
          .from(simUransVerifyQueue)
          .where(
            and(
              eq(simUransVerifyQueue.airfoilId, airfoilId),
              eq(simUransVerifyQueue.revisionId, revisionId),
            ),
          )
      : [];
  return {
    campaignIds: campaignId ? [campaignId] : [],
    requestIds: ownedRequests.map((row) => row.id),
    verifyIds: ownedVerifyItems.map((row) => row.id),
  };
}

beforeAll(async () => {
  resetUransLadderMemory();
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

  const [cat] = await db
    .insert(categories)
    .values({
      slug: `${PREFIX}-cat`,
      name: `${PREFIX} cat`,
      path: `${PREFIX}-cat`,
      depth: 0,
    })
    .returning();
  categoryId = cat.id;
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-foil`,
      name: `${PREFIX} foil`,
      categoryId: cat.id,
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

  const launch = await materializeCampaignLaunch(db, {
    name: `${PREFIX} ladder campaign`,
    priority: 7,
    idempotencyKey: `${PREFIX}-idem`,
    airfoilIds: [airfoilId],
    schedulingProfileId: profileIds.scheduling,
    plan: {
      mediumId,
      ambients: [[288.15, 101325]],
      speedsMps: [SPEED],
      chordsM: [CHORD],
      spanM: 1,
      areaMode: "derived",
      excludedConditions: [],
      baseSweep: { fromDeg: null, toDeg: null, stepDeg: null, listDeg: ANGLES },
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
  campaignId = launch.campaign.id;
  const [condition] = await db
    .select()
    .from(simCampaignConditions)
    .where(eq(simCampaignConditions.campaignId, campaignId));
  conditionId = condition.id;
  revisionId = condition.simulationPresetRevisionId;
  const [preset] = await db
    .select({
      legacyBoundaryConditionId: simulationPresets.legacyBoundaryConditionId,
    })
    .from(simulationPresets)
    .where(eq(simulationPresets.id, condition.presetId))
    .limit(1);
  bcId = preset!.legacyBoundaryConditionId!;
});

afterAll(async () => {
  await cleanupCampaignFixtures(db, {
    campaignIds: [campaignId],
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
  rmSync(mediaRoot, { recursive: true, force: true });
  if (previousMediaDir == null) delete process.env.MEDIA_DIR;
  else process.env.MEDIA_DIR = previousMediaDir;
});

describe("migration 0034 schema pin", () => {
  it("results carries fidelity + steady_history; ladder tables match the pinned contract columns", async () => {
    const resultCols = (await db.execute(dsql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'results' AND column_name IN ('fidelity', 'steady_history')
    `)) as unknown as { column_name: string }[];
    expect(resultCols.map((c) => c.column_name).sort()).toEqual([
      "fidelity",
      "steady_history",
    ]);

    const verifyCols = (await db.execute(dsql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'sim_urans_verify_queue'
    `)) as unknown as { column_name: string }[];
    // Contract 4 plus migration 0056's exact execution-owner column, pinned
    // exactly. JSON request provenance never substitutes for sim_job_id.
    expect(verifyCols.map((c) => c.column_name).sort()).toEqual(
      [
        "id",
        "airfoil_id",
        "revision_id",
        "aoa_deg",
        "campaign_id",
        "background_owner",
        "sim_job_id",
        "state",
        "precalc_result_id",
        "verify_result_id",
        "delta_cl",
        "delta_cd",
        "delta_cm",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
    const requestCols = (await db.execute(dsql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'sim_urans_requests'
    `)) as unknown as { column_name: string }[];
    expect(requestCols.map((c) => c.column_name)).toContain("fidelity");
    expect(requestCols.map((c) => c.column_name)).toContain("sim_job_id");
    expect(requestCols.map((c) => c.column_name)).toContain("background_owner");
    expect(requestCols.map((c) => c.column_name)).not.toContain("campaign_id");

    const verifyOwnerCols = (await db.execute(dsql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'sim_urans_verify_queue_campaigns'
    `)) as unknown as { column_name: string }[];
    expect(verifyOwnerCols.map((c) => c.column_name).sort()).toEqual(
      [
        "queue_id",
        "campaign_id",
        "state",
        "cancelled_at",
        "createdAt",
        "updatedAt",
      ].sort(),
    );

    const requestOwnerCols = (await db.execute(dsql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'sim_urans_request_campaigns'
    `)) as unknown as { column_name: string }[];
    expect(requestOwnerCols.map((c) => c.column_name).sort()).toEqual(
      [
        "request_id",
        "campaign_id",
        "state",
        "cancelled_at",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
  });
});

describe("fidelity ladder end-to-end (gating → precalc retry → verify queue → completion)", () => {
  it("MUST-CATCH: open RANS gaps defer inline submission but persist the campaign's precalc route", async () => {
    // Parent: a done wave-1 campaign job whose only evidence is a REJECTED
    // RANS attempt at REJECTED_AOA (single-revision path).
    const [parent] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        campaignId,
        jobKind: "sweep",
        referenceChordM: CHORD,
        wave: 1,
        status: "done",
        engineJobId: `${PREFIX}-parent`,
        totalCases: ANGLES.length,
        completedCases: ANGLES.length,
        ingestedAt: new Date(),
        finishedAt: new Date(),
        requestPayload: {
          speedMap: [
            {
              speed: SPEED,
              bcId,
              presetRevisionId: revisionId,
              mach: SPEED / 340.3,
            },
          ],
          aoas: ANGLES,
        },
      })
      .returning();
    parentJobId = parent.id;
    await db.insert(resultAttempts).values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: REJECTED_AOA,
      simJobId: parent.id,
      engineJobId: `${PREFIX}-parent`,
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

    // Campaign points are all still 'requested' with no results rows — open
    // RANS gaps. The inline path must not start a child outside scheduler
    // capacity, but it must persist the exact preliminary route.
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(true);
    const requests: PolarRequest[] = [];
    await submitUransRetryForJob(
      db,
      stubEngine(requests, `${PREFIX}-should-not-exist`),
      parent,
    );
    expect(requests.length).toBe(0);
    const children = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
    expect(children.length).toBe(0);
    expect(
      await db
        .select({ id: simPrecalcObligations.id })
        .from(simPrecalcObligations)
        .where(
          and(
            eq(simPrecalcObligations.airfoilId, airfoilId),
            eq(simPrecalcObligations.revisionId, revisionId),
            eq(simPrecalcObligations.aoaDeg, REJECTED_AOA),
          ),
        ),
    ).toHaveLength(1);

    const tiers = await campaignOpenTierCounts(db, campaignId);
    expect(tiers.ransOpen).toBe(ANGLES.length);
    expect(deriveCampaignPhase("active", tiers)).toBe("running_rans");
  }, 60000);

  it("the ladder tick submits the deferred wave-2 retry at PRECALC fidelity", async () => {
    // Terminal-close every campaign point (the RANS tier is settled).
    await db
      .update(simCampaignPoints)
      .set({ state: "terminal" })
      .where(eq(simCampaignPoints.campaignId, campaignId));
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(false);

    const requests: PolarRequest[] = [];
    const submitted = await uransLadderTick(
      db,
      stubEngine(requests, `${PREFIX}-precalc-child`),
      0,
      await ladderScope(),
    );
    expect(submitted).toBe(true);
    expect(requests.length).toBe(1);
    expect(requests[0].solver?.urans_fidelity).toBe("precalc");
    expect(requests[0].solver?.force_transient).toBe(true);
    expect(requests[0].aoa?.angles).toEqual([REJECTED_AOA]);

    const [child] = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parentJobId), eq(simJobs.wave, 2)));
    expect(child).toBeTruthy();
    expect(child.jobKind).toBe("targeted");
    expect(child.campaignId).toBeNull();
    expect(
      (child.requestPayload as { uransFidelity?: string }).uransFidelity,
    ).toBe("precalc");
    const childObligationIds = (
      child.requestPayload as { precalcObligationIds?: string[] }
    ).precalcObligationIds;
    expect(childObligationIds).toHaveLength(1);
    expect(
      await db
        .select({ campaignId: simPrecalcObligationCampaigns.campaignId })
        .from(simPrecalcObligationCampaigns)
        .where(
          eq(
            simPrecalcObligationCampaigns.obligationId,
            childObligationIds![0],
          ),
        ),
    ).toEqual([{ campaignId }]);
    // Settle through the real ingest/classification path. This pins the
    // replace/ledger contract rather than faking a terminal child row.
    const acceptedPrecalc: JobResult = {
      job_id: `${PREFIX}-precalc-child`,
      state: "completed",
      polars: [
        {
          speed: SPEED,
          chord: CHORD,
          reynolds: Math.round((SPEED * CHORD) / (1.789e-5 / 1.225)),
          mach: SPEED / 340.3,
          points: [
            {
              aoa_deg: REJECTED_AOA,
              cl: 1.01,
              cd: 0.051,
              cm: -0.06,
              cl_cd: 1.01 / 0.051,
              unsteady: true,
              converged: true,
              first_order_fallback: false,
              fidelity: "urans_precalc",
              frame_track:
                frameTrackFixture() as unknown as PolarPoint["frame_track"],
              images: {},
              video: {
                velocity_magnitude: `/jobs/${PREFIX}-precalc-child/files/cases/a0/images/velocity_magnitude.mp4`,
              },
              force_history: {
                t: [0, 0.1, 0.2, 0.3],
                cl: [0.99, 1.03, 0.98, 1.04],
                cd: [0.05, 0.052, 0.05, 0.052],
                cm: [-0.05, -0.07, -0.05, -0.07],
                shedding_freq_hz: 7.1,
                samples: 240,
              },
            } as PolarPoint,
          ],
        },
      ],
    };
    const ingestEngine = {
      getQueue: async () => {
        throw new Error("queue unavailable in test");
      },
      getJob: async (): Promise<JobStatus> => ({
        job_id: `${PREFIX}-precalc-child`,
        state: "completed",
        total_cases: 1,
        completed_cases: 1,
      }),
      getResult: async () => withExactManifestEvidence(acceptedPrecalc),
      fileUrl: (id: string, relPath: string) =>
        `http://engine.test/jobs/${id}/files/${relPath}`,
    } as unknown as EngineClient;
    await reconcile(db, ingestEngine, {
      jobIds: [child.id],
      skipFailedRecovery: true,
    });
    const [settledObligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, airfoilId),
          eq(simPrecalcObligations.revisionId, revisionId),
          eq(simPrecalcObligations.aoaDeg, REJECTED_AOA),
        ),
      );
    expect(settledObligation).toMatchObject({
      state: "satisfied",
      attemptCount: 1,
    });
    expect(
      await db
        .select({ id: simPrecalcObligationAttempts.id })
        .from(simPrecalcObligationAttempts)
        .where(
          eq(simPrecalcObligationAttempts.obligationId, settledObligation.id),
        ),
    ).toHaveLength(1);

    // The next sequential contract reuses this accepted physical evidence but
    // expects to prove verification enqueue itself, so remove only the queue
    // item produced by terminal ingest.
    await db
      .delete(simUransVerifyQueue)
      .where(
        and(
          eq(simUransVerifyQueue.revisionId, revisionId),
          eq(simUransVerifyQueue.aoaDeg, REJECTED_AOA),
        ),
      );
    await db
      .update(simCampaigns)
      .set({ status: "active", completedAt: null })
      .where(eq(simCampaigns.id, campaignId));
  }, 60000);

  it("automatically queues exactly one durable continuation and leaves media-only rejection to renderer repair", async () => {
    const aoa = ANGLES[0];
    const [source] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: aoa,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        reynolds: Math.round((SPEED * CHORD) / (1.789e-5 / 1.225)),
        speed: SPEED,
        chord: CHORD,
        cl: 0.7,
        cd: 0.04,
        cm: -0.04,
        unsteady: true,
        converged: true,
        engineJobId: `${PREFIX}-auto-continuation-source`,
        engineCaseSlug: "aoa_4.00",
        qualityWarnings: [
          "URANS integration stopped by the wall-clock budget guard: retained 1.4 of 3 periods (budget)",
        ],
        solvedAt: new Date(),
      })
      .returning();
    await db.insert(resultClassifications).values({
      resultId: source.id,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: aoa,
      regime: "urans",
      classifierVersion: "auto-continuation-test-v1",
      state: "rejected",
      region: "post_stall",
      confidence: 0.8,
      reasons: ["insufficient-periods"],
    });
    await db
      .update(simCampaignPoints)
      .set({ state: "terminal", resultId: source.id })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.aoaDeg, aoa),
        ),
      );

    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId,
        campaignId,
      }),
    ).toBe(0);
    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId,
        campaignId,
      }),
    ).toBe(0);
    let requests = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.continueFromResultId, source.id));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      state: "pending",
      requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      continueFromResultId: source.id,
      budgetOverrideS: AUTO_PRECALC_CONTINUATION_BUDGET_S,
    });
    expect(
      await db
        .select({
          campaignId: simUransRequestCampaigns.campaignId,
          state: simUransRequestCampaigns.state,
        })
        .from(simUransRequestCampaigns)
        .where(eq(simUransRequestCampaigns.requestId, requests[0].id)),
    ).toEqual([{ campaignId, state: "active" }]);
    const tiers = await campaignOpenTierCounts(db, campaignId);
    expect(tiers.precalcOpen).toBeGreaterThanOrEqual(1);

    // A campaign already surfaced as attention must not look settled while
    // its automatic continuation is still open.
    await db
      .update(simCampaigns)
      .set({ status: "attention" })
      .where(eq(simCampaigns.id, campaignId));
    await probeCampaignCompletion(db, campaignId);
    let [campaign] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignId));
    expect(campaign.status).toBe("attention");

    // A settled request remains durable history and suppresses another after
    // a process restart/repeated cache refresh.
    await db
      .update(simUransRequests)
      .set({ state: "done" })
      .where(eq(simUransRequests.id, requests[0].id));
    await enqueuePrecalcVerifications(db, {
      airfoilId,
      revisionId,
      campaignId,
    });
    requests = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.continueFromResultId, source.id));
    expect(requests).toHaveLength(1);

    // Once the continued evidence is accepted and no automatic work remains,
    // the same probe is allowed to close an attention campaign cleanly.
    await db
      .update(resultClassifications)
      .set({ state: "accepted", reasons: [] })
      .where(eq(resultClassifications.resultId, source.id));
    await probeCampaignCompletion(db, campaignId);
    [campaign] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignId));
    expect(campaign.status).toBe("completed");
    await db
      .update(simCampaigns)
      .set({ status: "active", completedAt: null })
      .where(eq(simCampaigns.id, campaignId));

    // A cancelled pre-submit composition did not spend the bounded solve. It
    // remains history, but one fresh automatic request is allowed because no
    // physical solver attempt crossed the engine boundary.
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, requests[0].id));
    const [cancelledBeforeSubmit] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: aoa,
        fidelity: "precalc",
        state: "cancelled",
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
        continueFromResultId: source.id,
        budgetOverrideS: AUTO_PRECALC_CONTINUATION_BUDGET_S,
      })
      .returning();
    await db.insert(simUransRequestCampaigns).values({
      requestId: cancelledBeforeSubmit.id,
      campaignId,
      state: "active",
    });
    await db
      .update(resultClassifications)
      .set({ state: "rejected", reasons: ["insufficient-periods"] })
      .where(eq(resultClassifications.resultId, source.id));
    await enqueuePrecalcVerifications(db, {
      airfoilId,
      revisionId,
      campaignId,
    });
    requests = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.continueFromResultId, source.id));
    expect(requests).toHaveLength(2);
    expect(
      requests.find((request) => request.id !== cancelledBeforeSubmit.id)
        ?.state,
    ).toBe("pending");

    // Even if the previous request history were removed, an otherwise
    // restartable row rejected ONLY for missing video belongs to bounded media
    // repair. It must not spend another solver budget.
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.continueFromResultId, source.id));
    await db
      .update(resultClassifications)
      .set({ state: "rejected", reasons: ["missing-urans-video"] })
      .where(eq(resultClassifications.resultId, source.id));
    await enqueuePrecalcVerifications(db, {
      airfoilId,
      revisionId,
      campaignId,
    });
    expect(
      await db
        .select({ id: simUransRequests.id })
        .from(simUransRequests)
        .where(eq(simUransRequests.continueFromResultId, source.id)),
    ).toHaveLength(0);

    await db
      .update(simCampaignPoints)
      .set({ resultId: null })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.aoaDeg, aoa),
        ),
      );
    await db.delete(results).where(eq(results.id, source.id));
  }, 60000);

  it("enqueues ONE verify item per precalc-accepted point, including steady-equivalent no-shedding evidence", async () => {
    // A no-shedding URANS result is physically steady and therefore carries
    // regime='rans', but fidelity still records that the preliminary URANS
    // tier produced it. Contract 4 keys verification on that fidelity.
    const [row] = await db
      .update(results)
      .set({
        regime: "rans",
        fidelity: "urans_precalc",
        cl: 1.0,
        cd: 0.05,
        cm: -0.06,
        unsteady: false,
        converged: true,
      })
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, revisionId),
          eq(results.aoaDeg, REJECTED_AOA),
        ),
      )
      .returning();
    await db
      .update(resultClassifications)
      .set({
        regime: "rans",
        classifierVersion: "fidelity-ladder-v4",
        state: "accepted",
        region: "post_stall",
        confidence: 0.9,
        reasons: [],
      })
      .where(eq(resultClassifications.resultId, row.id));
    // Link the campaign point so completion/tier logic sees the cell.
    await db
      .update(simCampaignPoints)
      .set({ resultId: row.id })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.aoaDeg, REJECTED_AOA),
        ),
      );

    const first = await enqueuePrecalcVerifications(db, {
      airfoilId,
      revisionId,
      campaignId,
    });
    expect(first).toBe(1);
    const second = await enqueuePrecalcVerifications(db, {
      airfoilId,
      revisionId,
      campaignId,
    });
    expect(second).toBe(0);
    const items = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.revisionId, revisionId));
    expect(items.length).toBe(1);
    expect(items[0].state).toBe("pending");
    expect(items[0].campaignId).toBeNull();
    expect(items[0].backgroundOwner).toBe(false);
    expect(items[0].precalcResultId).toBe(row.id);
    expect(
      await db
        .select({
          campaignId: simUransVerifyQueueCampaigns.campaignId,
          state: simUransVerifyQueueCampaigns.state,
        })
        .from(simUransVerifyQueueCampaigns)
        .where(eq(simUransVerifyQueueCampaigns.queueId, items[0].id)),
    ).toEqual([{ campaignId, state: "active" }]);

    // Phase: no RANS gaps, no precalc obligations left, one open verify item.
    const tiers = await campaignOpenTierCounts(db, campaignId);
    expect(tiers.verifyOpen).toBe(1);
    expect(deriveCampaignPhase("active", tiers)).toBe("running_refinement");
    const summary = await campaignSummary(db, campaignId);
    expect(summary.tierCounts.verifyOpen).toBe(1);
    expect(summary.phase).toBe("running_refinement");
  }, 60000);

  it("VERIFY ORDER MUST-CATCH: a pending admin request (precalc rank) consumes BEFORE any verify item", async () => {
    const { request, created } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: REJECTED_AOA,
      fidelity: "full",
      requestedBy: "test@airfoils.pro",
    });
    expect(created).toBe(true);

    const captured: PolarRequest[] = [];
    const submitted = await uransLadderTick(
      db,
      stubEngine(captured, `${PREFIX}-request-job`),
      0,
      await ladderScope(),
    );
    expect(submitted).toBe(true);
    expect(captured.length).toBe(1);
    // PAYLOAD-SHAPE PIN (prod job e89be2bb class): ladder-composed admin
    // requests are URANS-by-definition — solver.force_transient MUST ship, or
    // the engine treats the URANS stage as a steady fallback on the FULL mesh
    // at the tier's budget (effective_mesh_params requires force_transient).
    expect(captured[0].solver).toMatchObject({
      force_transient: true,
      transient_fallback: true,
      warm_start: false,
      urans_fidelity: "full",
    });
    expect(captured[0].expected_mesh_recovery_version).toBeUndefined();
    const [afterRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    expect(afterRequest.state).toBe("running");
    expect(afterRequest.simJobId).toBeTruthy();
    // The verify item was NOT consumed while precalc-rank work existed.
    const [item] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.revisionId, revisionId));
    expect(item.state).toBe("pending");

    // Settle the request job so the verify tier can open up.
    await db
      .update(simJobs)
      .set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() })
      .where(eq(simJobs.id, afterRequest.simJobId!));
    await db
      .update(simUransRequests)
      .set({ state: "done" })
      .where(eq(simUransRequests.id, request.id));
    // Subsequent admin-request contract tests intentionally reuse this exact
    // immutable cell. Their explicit-request semantics are independent of the
    // direct-ingest obligation proven above.
    await db
      .delete(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, airfoilId),
          eq(simPrecalcObligations.revisionId, revisionId),
          eq(simPrecalcObligations.aoaDeg, REJECTED_AOA),
        ),
      );
  }, 60000);

  it("LADDER PAYLOAD MUST-CATCH: an admin PRECALC request ships force_transient + precalc fidelity (full mesh requested; half-res derivation is engine-side)", async () => {
    const { request, created } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: REJECTED_AOA,
      fidelity: "precalc",
      requestedBy: "test@airfoils.pro",
    });
    expect(created).toBe(true);

    const captured: PolarRequest[] = [];
    let requestStateAtEngineCall: string | null = null;
    const engine = {
      submitPolar: async (polarRequest: PolarRequest): Promise<JobStatus> => {
        const [owned] = await db
          .select({ state: simUransRequests.state })
          .from(simUransRequests)
          .where(eq(simUransRequests.id, request.id));
        requestStateAtEngineCall = owned?.state ?? null;
        captured.push(polarRequest);
        return {
          job_id: `${PREFIX}-precalc-request-job`,
          state: "pending",
          total_cases: polarRequest.aoa?.angles?.length ?? 0,
          completed_cases: 0,
        };
      },
    } as unknown as EngineClient;
    const submitted = await uransLadderTick(db, engine, 0, await ladderScope());
    expect(submitted).toBe(true);
    expect(captured.length).toBe(1);
    expect(requestStateAtEngineCall).toBe("running");
    // PAYLOAD-SHAPE PIN (prod job e89be2bb, 2026-07-07): a ladder request that
    // ships WITHOUT solver.force_transient runs URANS on the FULL mesh at
    // precalc budgets — the engine's half-mesh derivation
    // (src/airfoilfoam/models.py effective_mesh_params) engages only when
    // force_transient && urans_fidelity == precalc — structurally guaranteeing
    // insufficient-periods (budget) rejections. A regression here must fail
    // loudly on the exact composed payload.
    expect(captured[0].solver).toMatchObject({
      force_transient: true,
      transient_fallback: true,
      warm_start: false,
      urans_fidelity: "precalc",
    });
    expect(captured[0].expected_mesh_recovery_version).toBe(0);
    expect(captured[0].aoa?.angles).toEqual([REJECTED_AOA]);
    expect(captured[0].speeds).toEqual([SPEED]);
    // The node NEVER downscales the mesh: the composed request carries the
    // revision's FULL-resolution grid and the engine derives the half-res
    // precalc mesh from the flags pinned above.
    const [revision] = await db
      .select()
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, revisionId))
      .limit(1);
    const snapshotMesh = (
      revision!.snapshot as {
        mesh: { nSurface: number; nRadial: number; nWake: number };
      }
    ).mesh;
    expect(captured[0].mesh?.n_surface).toBe(snapshotMesh.nSurface);
    expect(captured[0].mesh?.n_radial).toBe(snapshotMesh.nRadial);
    expect(captured[0].mesh?.n_wake).toBe(snapshotMesh.nWake);

    const [afterRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    expect(afterRequest.state).toBe("running");
    expect(afterRequest.simJobId).toBeTruthy();
    const [job] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, afterRequest.simJobId!));
    expect(job.wave).toBe(2);
    expect(job.jobKind).toBe("targeted");
    const payload = job.requestPayload as {
      uransFidelity?: string;
      uransRequestId?: string;
    };
    expect(payload.uransFidelity).toBe("precalc");
    expect(payload.uransRequestId).toBe(request.id);

    // Settle so the later verify-tier tests see a quiet machine.
    await db
      .update(simJobs)
      .set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() })
      .where(eq(simJobs.id, afterRequest.simJobId!));
    await db
      .update(simUransRequests)
      .set({ state: "done" })
      .where(eq(simUransRequests.id, request.id));
    await db
      .delete(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, airfoilId),
          eq(simPrecalcObligations.revisionId, revisionId),
          eq(simPrecalcObligations.aoaDeg, REJECTED_AOA),
        ),
      );
  }, 60000);

  it("CAPABILITY GATE MUST-CATCH: malformed PRECALC capability skips older PRECALC but still submits FULL admin work", async () => {
    const precalc = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: 41,
      fidelity: "precalc",
      requestedBy: `${PREFIX}-capability-precalc`,
    });
    const full = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: 42,
      fidelity: "full",
      requestedBy: `${PREFIX}-capability-full`,
    });
    const captured: PolarRequest[] = [];
    const submitted = await uransLadderTick(
      db,
      stubEngine(captured, `${PREFIX}-capability-full-job`),
      0,
      {
        campaignIds: [],
        parentJobIds: [],
        promotionIds: [],
        requestIds: [precalc.request.id, full.request.id],
        verifyIds: [],
        meshRecoveryVersion: null,
      },
    );
    expect(submitted).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].solver?.urans_fidelity).toBe("full");
    expect(captured[0].aoa?.angles).toEqual([42]);
    expect(captured[0].expected_mesh_recovery_version).toBeUndefined();
    const requests = await db
      .select({ id: simUransRequests.id, state: simUransRequests.state })
      .from(simUransRequests)
      .where(
        inArray(simUransRequests.id, [precalc.request.id, full.request.id]),
      );
    expect(requests).toEqual(
      expect.arrayContaining([
        { id: precalc.request.id, state: "pending" },
        { id: full.request.id, state: "running" },
      ]),
    );
    const [fullJob] = await db
      .select({ id: simJobs.id })
      .from(simJobs)
      .where(dsql`request_payload ->> 'uransRequestId' = ${full.request.id}`);
    if (fullJob) {
      await db
        .update(simJobs)
        .set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() })
        .where(eq(simJobs.id, fullJob.id));
    }
    await db
      .delete(simUransRequests)
      .where(
        inArray(simUransRequests.id, [precalc.request.id, full.request.id]),
      );
  }, 60000);

  it("CAPABILITY GATE MUST-CATCH: orphan healing runs before a closed PRECALC capability gate", async () => {
    const created = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: 43,
      fidelity: "precalc",
      requestedBy: `${PREFIX}-capability-orphan`,
    });
    const claimed = await claimNextPendingUransRequest(db, {
      requestIds: [created.request.id],
    });
    expect(claimed?.id).toBe(created.request.id);
    const [orphanJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "pending",
        engineState: "submitting",
        totalCases: 1,
        requestPayload: {
          uransRequestId: created.request.id,
          uransFidelity: "precalc",
          aoas: [43],
        },
        updatedAt: new Date(Date.now() - 10 * 60_000),
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({
        state: "running",
        simJobId: orphanJob.id,
        updatedAt: new Date(Date.now() - 10 * 60_000),
      })
      .where(eq(simUransRequests.id, created.request.id));

    const captured: PolarRequest[] = [];
    expect(
      await uransLadderTick(
        db,
        stubEngine(captured, `${PREFIX}-must-not-submit-precalc`),
        0,
        {
          campaignIds: [],
          parentJobIds: [],
          promotionIds: [],
          requestIds: [created.request.id],
          verifyIds: [],
          meshRecoveryVersion: null,
        },
      ),
    ).toBe(false);
    expect(captured).toHaveLength(0);
    const [healed] = await db
      .select({
        state: simUransRequests.state,
        simJobId: simUransRequests.simJobId,
      })
      .from(simUransRequests)
      .where(eq(simUransRequests.id, created.request.id));
    expect(healed).toEqual({ state: "pending", simJobId: null });
    const [cancelledJob] = await db
      .select({ status: simJobs.status })
      .from(simJobs)
      .where(eq(simJobs.id, orphanJob.id));
    expect(cancelledJob?.status).toBe("cancelled");
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, created.request.id));
  }, 60000);

  it("request-URANS is idempotent per (cell, fidelity), whole-polar included", async () => {
    const a = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: null,
      fidelity: "precalc",
    });
    expect(a.created).toBe(true);
    const b = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: null,
      fidelity: "precalc",
    });
    expect(b.created).toBe(false);
    expect(b.request.id).toBe(a.request.id);
    // A different fidelity is a DIFFERENT work item.
    const c = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: null,
      fidelity: "full",
    });
    expect(c.created).toBe(true);
    expect(c.request.id).not.toBe(a.request.id);
    // Clean these up so they do not feed the verify-order checks below.
    await db
      .delete(simUransRequests)
      .where(inArray(simUransRequests.id, [a.request.id, c.request.id]));
  }, 60000);

  it("serializes exact/whole coverage in both orders and never leaves overlapping open requests", async () => {
    const exactFirst = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: 31,
      fidelity: "precalc",
    });
    await expect(
      createUransRequest(db, {
        airfoilId,
        revisionId,
        aoaDeg: null,
        fidelity: "precalc",
      }),
    ).rejects.toBeInstanceOf(UransRequestCoverageConflict);
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, exactFirst.request.id));

    const wholeFirst = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: null,
      fidelity: "full",
    });
    const coveredExact = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: 32,
      fidelity: "full",
    });
    expect(coveredExact).toMatchObject({ created: false });
    expect(coveredExact.request.id).toBe(wholeFirst.request.id);
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, wholeFirst.request.id));

    async function assertConcurrentOrder(
      fidelity: "precalc" | "full",
      aoaDeg: number,
      wholeFirstInCallOrder: boolean,
    ) {
      const exact = () =>
        createUransRequest(db, { airfoilId, revisionId, aoaDeg, fidelity });
      const whole = () =>
        createUransRequest(db, {
          airfoilId,
          revisionId,
          aoaDeg: null,
          fidelity,
        });
      const settled = await Promise.allSettled(
        wholeFirstInCallOrder ? [whole(), exact()] : [exact(), whole()],
      );
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          expect(outcome.reason).toBeInstanceOf(UransRequestCoverageConflict);
        }
      }
      const open = await db
        .select()
        .from(simUransRequests)
        .where(
          and(
            eq(simUransRequests.airfoilId, airfoilId),
            eq(simUransRequests.revisionId, revisionId),
            eq(simUransRequests.fidelity, fidelity),
            inArray(simUransRequests.state, ["pending", "running"]),
            dsql`(${simUransRequests.aoaDeg} IS NULL OR ${simUransRequests.aoaDeg} = ${aoaDeg})`,
          ),
        );
      expect(open).toHaveLength(1);
      expect(open[0].aoaDeg == null || open[0].aoaDeg === aoaDeg).toBe(true);
      await db
        .delete(simUransRequests)
        .where(eq(simUransRequests.id, open[0].id));
    }

    await assertConcurrentOrder("precalc", 33, false);
    await assertConcurrentOrder("full", 34, true);
  }, 60000);

  it("atomically claims one admin request owner and heals its process-death pending composition", async () => {
    const created = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: ANGLES[0],
      fidelity: "full",
      requestedBy: `${PREFIX}-claim-owner`,
    });
    expect(created.created).toBe(true);
    const scope = { requestIds: [created.request.id] };
    const [first, second] = await Promise.all([
      claimNextPendingUransRequest(db, scope),
      claimNextPendingUransRequest(db, scope),
    ]);
    expect([first?.id, second?.id].filter(Boolean)).toEqual([
      created.request.id,
    ]);
    const claimed = first ?? second!;
    expect(
      await hasOpenCampaignLadderWork(db, { requestIds: [created.request.id] }),
    ).toBe(true);

    const [orphanJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "pending",
        engineState: "submitting",
        totalCases: 1,
        requestPayload: {
          uransRequestId: claimed.id,
          uransFidelity: "full",
          aoas: [ANGLES[0]],
        },
        updatedAt: new Date(Date.now() - 10 * 60_000),
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({ state: "done", simJobId: orphanJob.id })
      .where(eq(simUransRequests.id, claimed.id));
    expect(
      await hasOpenCampaignLadderWork(db, { requestIds: [created.request.id] }),
    ).toBe(true);
    await db
      .update(simUransRequests)
      .set({
        state: "running",
        simJobId: orphanJob.id,
        updatedAt: new Date(Date.now() - 10 * 60_000),
      })
      .where(eq(simUransRequests.id, claimed.id));

    expect(await healOrphanedUransRequests(db, scope)).toBe(1);
    const [afterRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, claimed.id));
    const [afterJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, orphanJob.id));
    expect(afterRequest).toMatchObject({ state: "pending", simJobId: null });
    expect(afterJob.status).toBe("cancelled");
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, claimed.id));
  }, 60000);

  it("settles a request when the process dies after a terminal submit/job boundary", async () => {
    const rejected = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: ANGLES[0],
      fidelity: "precalc",
      requestedBy: `${PREFIX}-rejected-submit`,
    });
    const rejectedClaim = await claimNextPendingUransRequest(db, {
      requestIds: [rejected.request.id],
    });
    expect(rejectedClaim?.state).toBe("running");
    const [rejectedJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "failed",
        engineJobId: null,
        totalCases: 1,
        error: "ladder submit failed: engine rejected request",
        requestPayload: {
          uransRequestId: rejected.request.id,
          uransFidelity: "precalc",
          aoas: [ANGLES[0]],
        },
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({ simJobId: rejectedJob.id })
      .where(eq(simUransRequests.id, rejected.request.id));

    const completed = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: ANGLES[1],
      fidelity: "full",
      requestedBy: `${PREFIX}-terminal-job`,
    });
    const completedClaim = await claimNextPendingUransRequest(db, {
      requestIds: [completed.request.id],
    });
    expect(completedClaim?.state).toBe("running");
    const [completedJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "done",
        engineJobId: `${PREFIX}-terminal-engine`,
        totalCases: 1,
        completedCases: 1,
        ingestedAt: new Date(),
        finishedAt: new Date(),
        requestPayload: {
          uransRequestId: completed.request.id,
          uransFidelity: "full",
          aoas: [ANGLES[1]],
        },
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({ simJobId: completedJob.id })
      .where(eq(simUransRequests.id, completed.request.id));

    expect(
      await healOrphanedUransRequests(db, {
        requestIds: [rejected.request.id, completed.request.id],
      }),
    ).toBe(2);
    const terminalRequests = await db
      .select({ id: simUransRequests.id, state: simUransRequests.state })
      .from(simUransRequests)
      .where(
        inArray(simUransRequests.id, [
          rejected.request.id,
          completed.request.id,
        ]),
      );
    expect(new Map(terminalRequests.map((row) => [row.id, row.state]))).toEqual(
      new Map([
        [rejected.request.id, "cancelled"],
        [completed.request.id, "done"],
      ]),
    );
  }, 60000);

  it("consumes the verify item at FULL fidelity once no campaign RANS/precalc work exists, then records a DISAGREEMENT at ingest", async () => {
    // Production's verify gate is machine-wide. This live-DB test supplies a
    // closed request/campaign scope so it proves this fixture's tier ordering
    // without waiting on or consuming another parallel file's legitimate work.
    // Keep one unrelated background obligation open deliberately: without the
    // campaign side of the test scope, this row reproduces the full-parallel
    // failure where another suite's preliminary work blocked this verify item.
    const [unrelatedObligation] = await db
      .insert(simPrecalcObligations)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: 77.125,
        state: "pending",
        backgroundOwner: true,
      })
      .returning({ id: simPrecalcObligations.id });
    const captured: PolarRequest[] = [];
    let submitted = false;
    try {
      submitted = await uransLadderTick(
        db,
        stubEngine(captured, `${PREFIX}-verify-job`),
        0,
        await ladderScope(),
      );
    } finally {
      await db
        .delete(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, unrelatedObligation.id));
    }
    expect(submitted).toBe(true);
    expect(captured.length).toBe(1);
    // PAYLOAD-SHAPE PIN (prod job e89be2bb class): verify items re-solve at
    // FULL fidelity and are URANS-by-definition — force_transient MUST ship
    // or the full-tier budget wraps a steady-fallback solve.
    expect(captured[0].solver).toMatchObject({
      force_transient: true,
      transient_fallback: true,
      warm_start: false,
      urans_fidelity: "full",
    });
    expect(captured[0].aoa?.angles).toEqual([REJECTED_AOA]);

    const [item] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.revisionId, revisionId));
    expect(item.state).toBe("running");
    const [verifyJob] = await db
      .select()
      .from(simJobs)
      .where(dsql`request_payload ->> 'verifyQueueItemId' = ${item.id}`);
    expect(verifyJob).toBeTruthy();
    expect(verifyJob.jobKind).toBe("verify");
    expect(item.simJobId).toBe(verifyJob.id);
    expect(
      (verifyJob.requestPayload as { verifyPrecalc?: { cl?: number } })
        .verifyPrecalc?.cl,
    ).toBe(1.0);

    // Completion blocking (contract 7): every cell terminal, but the open
    // verify item must keep the campaign from flipping completed.
    await probeCampaignCompletion(db, campaignId);
    const [beforeCampaign] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignId));
    expect(beforeCampaign.status).toBe("active");

    // Verified full-fidelity solve disagrees on Cl: 1.2 vs precalc 1.0.
    // Evidence-complete payload, like a real full-tier engine solve: frame
    // track (stationary, 6 retained periods >= the full-tier bar of 5), video
    // and force history shipped — it must pre-classify ACCEPT so the ingest
    // replace guard (gate incident 2026-07-07) lets it supersede the accepted
    // precalc row; a would-REJECT verify solve keeps the precalc evidence and
    // cancels the item instead (covered by the replace-guard suite).
    const verified: JobResult = {
      job_id: `${PREFIX}-verify-job`,
      state: "completed",
      polars: [
        {
          speed: SPEED,
          chord: CHORD,
          reynolds: Math.round((SPEED * CHORD) / (1.789e-5 / 1.225)),
          mach: SPEED / 340.3,
          points: [
            {
              aoa_deg: REJECTED_AOA,
              cl: 1.2,
              cd: 0.055,
              cm: -0.05,
              cl_cd: 1.2 / 0.055,
              unsteady: true,
              converged: true,
              first_order_fallback: false,
              fidelity: "urans_full",
              frame_track:
                frameTrackFixture() as unknown as PolarPoint["frame_track"],
              images: {},
              video: {
                velocity_magnitude: `/jobs/${PREFIX}-verify-job/files/cases/a0/images/velocity_magnitude.mp4`,
              },
              force_history: {
                t: [0, 0.1, 0.2, 0.3],
                cl: [1.1, 1.3, 1.15, 1.25],
                cd: [0.05, 0.06, 0.05, 0.06],
                cm: [-0.04, -0.06, -0.05, -0.05],
                shedding_freq_hz: 7.3,
                samples: 240,
              },
            } as PolarPoint,
          ],
        },
      ],
    };
    const verifyEngine = {
      getQueue: async () => {
        throw new Error("queue unavailable in test");
      },
      getJob: async (): Promise<JobStatus> => ({
        job_id: `${PREFIX}-verify-job`,
        state: "completed",
        total_cases: 1,
        completed_cases: 1,
      }),
      getResult: async () => withExactManifestEvidence(verified),
      fileUrl: (id: string, relPath: string) =>
        `http://engine.test/jobs/${id}/files/${relPath}`,
    } as unknown as EngineClient;
    await reconcile(db, verifyEngine, {
      jobIds: [verifyJob.id],
      skipFailedRecovery: true,
    });

    const [settled] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, item.id));
    expect(settled.state).toBe("disagreed");
    expect(settled.deltaCl).toBeCloseTo(0.2, 6);
    expect(settled.deltaCd).toBeCloseTo(0.005, 6);
    expect(settled.verifyResultId).toBeTruthy();

    // The classification stays on the selected VERIFIED attempt (now the
    // full-fidelity projection). Machine disagreement belongs to the queue
    // state/deltas above; immutable solver-attempt warnings are not rewritten.
    const [verifiedRow] = await db
      .select()
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, revisionId),
          eq(results.aoaDeg, REJECTED_AOA),
        ),
      );
    expect(verifiedRow.fidelity).toBe("urans_full");
    expect(verifiedRow.cl).toBeCloseTo(1.2, 6);
    // No re-enqueue: the cell is full-fidelity now, so the enqueue predicate
    // no longer matches.
    const itemsAfter = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.revisionId, revisionId));
    expect(itemsAfter.length).toBe(1);

    // All three tiers terminal now → the completion probe may settle the
    // campaign (the verified row classifies at refresh; whatever the verdict,
    // the ladder no longer blocks).
    const tiers = await campaignOpenTierCounts(db, campaignId);
    expect(tiers.verifyOpen).toBe(0);
  }, 300000);
});

describe("tier-2a scan-window starvation MUST-CATCH (adversarial review 2026-07-07)", () => {
  // Production shape: a campaign's batched parents mostly need NO gated retry
  // (their cells all landed accepted), and the parents that DO need a retry
  // finish LAST (the gate stays closed until the final RANS gap closes). The
  // buggy scan fetched a fixed finishedAt-ASC window with no retry-need or
  // settled-parent exclusion in SQL, so >window no-retry parents permanently
  // occupied the window and the needy parent was never fetched → its
  // needs_urans cell never re-solved → phase stuck running_precalc forever.
  it("reaches a needy parent ranked past the first finishedAt window despite 13 earlier no-retry parents", async () => {
    // The verify test above ends with every tier terminal and the aoa-8 cell
    // ACCEPTED at full fidelity, so the completion probe settles the shared
    // fixture campaign to 'completed'. This scenario needs a LIVE mid-ladder
    // campaign (the gate just opened, gated retries still owed) — reactivate.
    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, campaignId));
    const [unrelatedOpenObligation] = await ensurePrecalcObligations(
      db,
      [
        {
          airfoilId,
          revisionId,
          aoaDeg: 3.875,
        },
      ],
      { campaignIds: [campaignId] },
    );
    expect(unrelatedOpenObligation).toMatchObject({ state: "pending" });
    const base = Date.now() - 60 * 60 * 1000;
    const scopedParentIds: string[] = [];
    // 13 completed, ingested, childless wave-1 parents with EMPTY retry plans
    // (no attempts at all) — one more than the old 12-slot scan window.
    for (let i = 0; i < 13; i++) {
      const [filler] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          campaignId,
          jobKind: "sweep",
          referenceChordM: CHORD,
          wave: 1,
          status: "done",
          engineJobId: `${PREFIX}-starve-filler-${i}`,
          totalCases: 1,
          completedCases: 1,
          ingestedAt: new Date(base + i * 1000),
          finishedAt: new Date(base + i * 1000),
          requestPayload: {
            speedMap: [
              {
                speed: SPEED,
                bcId,
                presetRevisionId: revisionId,
                mach: SPEED / 340.3,
              },
            ],
            aoas: [4],
          },
        })
        .returning({ id: simJobs.id });
      scopedParentIds.push(filler.id);
    }
    // The needy parent finishes LAST and carries a failed RANS attempt at
    // aoa 4 (classifies rejected at refresh → non-empty targeted retry plan).
    const [needy] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        campaignId,
        jobKind: "sweep",
        referenceChordM: CHORD,
        wave: 1,
        status: "done",
        engineJobId: `${PREFIX}-starve-needy`,
        totalCases: 1,
        completedCases: 1,
        ingestedAt: new Date(base + 999_000),
        finishedAt: new Date(base + 999_000),
        requestPayload: {
          speedMap: [
            {
              speed: SPEED,
              bcId,
              presetRevisionId: revisionId,
              mach: SPEED / 340.3,
            },
          ],
          aoas: [4],
        },
      })
      .returning();
    scopedParentIds.push(needy.id);
    await db.insert(resultAttempts).values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 4,
      simJobId: needy.id,
      engineJobId: `${PREFIX}-starve-needy`,
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
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(false);

    // Bounded ticks: the scan MUST slide past the settled no-retry parents
    // and reach the needy parent. The buggy window never advances, so no
    // number of ticks ever creates the child.
    let child: typeof simJobs.$inferSelect | undefined;
    for (let tick = 0; tick < 10 && !child; tick++) {
      const requests: PolarRequest[] = [];
      const scope = await ladderScope();
      await uransLadderTick(
        db,
        stubEngine(requests, `${PREFIX}-starve-child-${tick}`),
        0,
        { ...scope, parentJobIds: scopedParentIds },
      );
      [child] = await db
        .select()
        .from(simJobs)
        .where(and(eq(simJobs.parentJobId, needy.id), eq(simJobs.wave, 2)));
    }
    await db
      .delete(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, unrelatedOpenObligation.id));
    expect(child).toBeTruthy();
    expect(child!.jobKind).toBe("targeted");
    expect(
      (child!.requestPayload as { uransFidelity?: string }).uransFidelity,
    ).toBe("precalc");
    expect((child!.requestPayload as { aoas?: number[] }).aoas).toEqual([4]);
    // Free the slot so nothing lingers in-flight for other suites.
    await db
      .update(simJobs)
      .set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() })
      .where(eq(simJobs.id, child!.id));
  }, 180000);

  it("recovers a cancelled wave-1 parent's partially-ingested rejected cell instead of losing its URANS obligation", async () => {
    resetUransLadderMemory();
    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, campaignId));
    const cancelledAoa = 9.125;
    const [cancelledParent] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        campaignId,
        jobKind: "sweep",
        referenceChordM: CHORD,
        wave: 1,
        status: "cancelled",
        engineJobId: `${PREFIX}-cancelled-ingested-parent`,
        totalCases: 2,
        completedCases: 1,
        // Running-partial ingestion stores attempt evidence but deliberately
        // does not stamp the terminal-ingest timestamp. Admin cancellation
        // must not make that truthful partial evidence invisible to the ladder.
        ingestedAt: null,
        finishedAt: new Date(1),
        requestPayload: {
          speedMap: [
            {
              speed: SPEED,
              bcId,
              presetRevisionId: revisionId,
              mach: SPEED / 340.3,
            },
          ],
          aoas: [cancelledAoa, cancelledAoa + 1],
        },
      })
      .returning();
    expect(cancelledParent.ingestedAt).toBeNull();
    await db.insert(resultAttempts).values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: cancelledAoa,
      simJobId: cancelledParent.id,
      engineJobId: `${PREFIX}-cancelled-ingested-parent`,
      status: "failed",
      source: "queued",
      regime: "rans",
      validForPolar: false,
      converged: false,
      stalled: true,
      unsteady: false,
      error: "RANS did not converge before the remaining sweep was cancelled",
      evidencePayload: { failure_disposition: "hard_solver" },
      solvedAt: new Date(),
    });
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(false);

    const requests: PolarRequest[] = [];
    const submitted = await uransLadderTick(
      db,
      stubEngine(requests, `${PREFIX}-cancelled-parent-child`),
      0,
      await ladderScope(),
    );

    expect(submitted).toBe(true);
    const [child] = await db
      .select()
      .from(simJobs)
      .where(
        and(eq(simJobs.parentJobId, cancelledParent.id), eq(simJobs.wave, 2)),
      );
    expect(child).toBeTruthy();
    expect((child!.requestPayload as { aoas?: number[] }).aoas).toEqual([
      cancelledAoa,
    ]);
    expect(requests[0]?.solver?.urans_fidelity).toBe("precalc");
    await db
      .update(simJobs)
      .set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() })
      .where(eq(simJobs.id, child!.id));
  }, 180000);
});

describe("continuation work items (amendment C): budget-stopped URANS resumes from saved case state", () => {
  const CONTINUE_AOA = 12;
  let sourceResultId = "";

  it("CONTINUATION PAYLOAD MUST-CATCH: the ladder tick composes continue_from + budget_override_s and pins them on the sim_job payload", async () => {
    // Quiet slate for tier 2b: earlier tests settled their requests; make sure
    // nothing pending remains scoped to this revision.
    await db
      .update(simUransRequests)
      .set({ state: "cancelled" })
      .where(
        and(
          eq(simUransRequests.revisionId, revisionId),
          inArray(simUransRequests.state, ["pending", "running"]),
        ),
      );

    // The budget-stopped source: a REJECTED precalc URANS row whose engine
    // case ids address the saved case state on the volume, quality warning
    // carrying the engine's wall-clock budget-guard sentence.
    const [source] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: CONTINUE_AOA,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        reynolds: Math.round((SPEED * CHORD) / (1.789e-5 / 1.225)),
        speed: SPEED,
        chord: CHORD,
        cl: 0.9,
        cd: 0.08,
        cm: -0.05,
        unsteady: true,
        converged: true,
        engineJobId: `${PREFIX}-budget-stopped-job`,
        engineCaseSlug: "aoa_12.00",
        qualityWarnings: [
          "URANS integration stopped by the wall-clock budget guard: retained 1.4 of 3 periods (budget); projected 3.2h continuation exceeds 80% of the 2.0h solver timeout",
        ],
        solvedAt: new Date(),
      })
      .returning();
    sourceResultId = source.id;

    const { request, created } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: CONTINUE_AOA,
      fidelity: "precalc",
      requestedBy: "test@airfoils.pro",
      continueFromResultId: sourceResultId,
      budgetOverrideS: 21600, // the +6h choice
    });
    expect(created).toBe(true);
    expect(request.continueFromResultId).toBe(sourceResultId);
    expect(request.budgetOverrideS).toBe(21600);

    const captured: PolarRequest[] = [];
    const submitted = await uransLadderTick(
      db,
      stubEngine(captured, `${PREFIX}-continuation-job`),
      0,
      await ladderScope(),
    );
    expect(submitted).toBe(true);
    expect(captured.length).toBe(1);
    // ENGINE-REQUEST SHAPE PIN (amendment C contract): the engine copies/links
    // the prior case dir and restarts the transient from latestTime, merging
    // coefficient history — addressed EXACTLY by these two fields.
    expect(captured[0].continue_from).toEqual({
      engine_job_id: `${PREFIX}-budget-stopped-job`,
      case_slug: "aoa_12.00",
    });
    expect(captured[0].budget_override_s).toBe(21600);
    // Still URANS-by-definition (prod job e89be2bb class).
    expect(captured[0].solver).toMatchObject({
      force_transient: true,
      transient_fallback: true,
      urans_fidelity: "precalc",
    });
    expect(captured[0].aoa?.angles).toEqual([CONTINUE_AOA]);

    const [afterRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    expect(afterRequest.state).toBe("running");
    expect(afterRequest.simJobId).toBeTruthy();
    const [job] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, afterRequest.simJobId!));
    expect(job.wave).toBe(2);
    expect(job.jobKind).toBe("targeted");
    const payload = job.requestPayload as {
      uransRequestId?: string;
      continueFromResultId?: string;
      budgetOverrideS?: number;
    };
    expect(payload.uransRequestId).toBe(request.id);
    expect(payload.continueFromResultId).toBe(sourceResultId);
    expect(payload.budgetOverrideS).toBe(21600);

    // Settle (continuation results ingest normally — same cell upsert; the
    // ingest path itself is covered by the ladder ingest tests above).
    await db
      .update(simJobs)
      .set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() })
      .where(eq(simJobs.id, job.id));
    await db
      .update(simUransRequests)
      .set({ state: "done" })
      .where(eq(simUransRequests.id, request.id));
  }, 120000);

  it("cancels a continuation whose source lost its saved case state instead of faking a fresh solve as a resume", async () => {
    const [orphanSource] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 13,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.8,
        cd: 0.07,
        unsteady: true,
        converged: true,
        // engineJobId / engineCaseSlug DELIBERATELY absent: no case state.
        solvedAt: new Date(),
      })
      .returning();
    const { request } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: 13,
      fidelity: "precalc",
      continueFromResultId: orphanSource.id,
      budgetOverrideS: 7200,
    });
    const captured: PolarRequest[] = [];
    const submitted = await uransLadderTick(
      db,
      stubEngine(captured, `${PREFIX}-orphan-continuation`),
      0,
      await ladderScope(),
    );
    expect(submitted).toBe(false);
    expect(captured.length).toBe(0);
    const [afterRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    expect(afterRequest.state).toBe("cancelled");
  }, 120000);
});
