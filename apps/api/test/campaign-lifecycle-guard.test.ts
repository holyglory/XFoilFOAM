// Campaign lifecycle MUST-CATCH coverage for the production-20260710 stop:
// paused/cancelled verification work must not leak back into the scheduler,
// cancellation retains queue/evidence history, and a late admin cancel must
// never relabel a job that already reached a terminal state.

import {
  AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
  addCampaignAirfoils,
  airfoils,
  archiveCampaign,
  boundaryProfiles,
  campaignOpenTierCounts,
  cancelCampaign,
  categories,
  claimNextPendingUransRequest,
  claimNextPendingVerifyItem,
  closeCampaignWithFailures,
  createClient,
  enqueuePrecalcVerifications,
  ensurePrecalcObligations,
  deriveCampaignPhase,
  healOrphanedVerifyItems,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  outputProfiles,
  pauseCampaign,
  precalcRequestStateFromObligations,
  previewAddCampaignAirfoils,
  probeCampaignCompletion,
  releaseClaimedUransRequest,
  releaseClaimedVerifyItem,
  recordPrecalcObligationSubmission,
  resultAttempts,
  resultClassifications,
  results,
  resumeCampaign,
  simCampaignConditions,
  simCampaignPoints,
  simCampaigns,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligations,
  simulationPresets,
  simUransRequestCampaigns,
  simUransRequests,
  simUransVerifyQueue,
  simUransVerifyQueueCampaigns,
  solverProfiles,
  type DB,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import {
  EngineClient,
  type EngineQueueState,
  type JobRuntimeSummary,
} from "@aerodb/engine-client";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db, sql as pgClient } from "../src/db";
import { buildServer } from "../src/server";

const PREFIX = `api-campaign-life-${process.pid}-${Date.now().toString(36)}`;
// File-unique physical value: campaign registries dedupe by canonical values
// across parallel Vitest files, so common chords would entangle cleanup.
const CHORD = 0.7317;
const SPEEDS = {
  active: 37.137,
  paused: 38.137,
  cancelled: 39.137,
  shared: 40.137,
} as const;

const points = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

let app: Awaited<ReturnType<typeof buildServer>>;
let airfoilId = "";
let categoryId = "";
let mediumId = "";
const profileIds = { boundary: "", mesh: "", solver: "", output: "" };
const campaignIds: string[] = [];
const extraAirfoilIds: string[] = [];
const campaigns = {
  active: "",
  paused: "",
  cancelled: "",
  sharedA: "",
  sharedB: "",
};

function verifyScope() {
  return {
    campaignIds: [
      campaigns.active,
      campaigns.paused,
      campaigns.cancelled,
      campaigns.sharedA,
      campaigns.sharedB,
    ],
  };
}

interface CampaignSetup {
  revisionId: string;
  bcId: string;
}

async function launchCampaign(label: string, speed: number): Promise<string> {
  const launch = await materializeCampaignLaunch(db, {
    name: `${PREFIX} ${label}`,
    priority: 5,
    idempotencyKey: `${PREFIX}-${label}`,
    airfoilIds: [airfoilId],
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
        listDeg: [0, 1, 2, 3],
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
  campaignIds.push(launch.campaign.id);
  return launch.campaign.id;
}

async function campaignSetup(campaignId: string): Promise<CampaignSetup> {
  const [row] = await db
    .select({
      revisionId: simCampaignConditions.simulationPresetRevisionId,
      bcId: simulationPresets.legacyBoundaryConditionId,
    })
    .from(simCampaignConditions)
    .innerJoin(
      simulationPresets,
      eq(simulationPresets.id, simCampaignConditions.presetId),
    )
    .where(eq(simCampaignConditions.campaignId, campaignId))
    .limit(1);
  if (!row?.bcId)
    throw new Error(`campaign ${campaignId} has no legacy bc bridge`);
  return { revisionId: row.revisionId, bcId: row.bcId };
}

async function insertPrecalc(setup: CampaignSetup, aoaDeg: number) {
  const [row] = await db
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
      cl: 0.4 + aoaDeg * 0.1,
      cd: 0.02,
      cm: -0.03,
      unsteady: true,
      converged: true,
      solvedAt: new Date(),
    })
    .returning();
  return row;
}

type SettledOperation =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown };

function settleOperation(
  work: () => Promise<unknown>,
): Promise<SettledOperation> {
  return work().then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

/** Hold the canonical campaign row while two real lifecycle operations queue.
 * The first operation is the intended winner; the second has already performed
 * its pre-fix stale read by the time both sessions are lock-waiting. Releasing
 * the holder gives PostgreSQL's lock queue a deterministic commit order. */
async function raceCampaignOperations(
  campaignId: string,
  first: (operationDb: DB) => Promise<unknown>,
  second: (operationDb: DB) => Promise<unknown>,
): Promise<[SettledOperation, SettledOperation]> {
  let outcomes:
    | [Promise<SettledOperation>, Promise<SettledOperation>]
    | undefined;
  const barrierClient = createClient({ max: 1 });
  const firstClient = createClient({ max: 1 });
  const secondClient = createClient({ max: 1 });
  try {
    // Establish all three dedicated sessions before taking the barrier lock;
    // postgres-js opens sockets lazily and must not make connection startup
    // part of the ordering assertion.
    await Promise.all([
      barrierClient.sql`SELECT 1`,
      firstClient.sql`SELECT 1`,
      secondClient.sql`SELECT 1`,
    ]);
    await barrierClient.sql.begin(async (holder) => {
      const [{ pid: holderPid }] = await holder<{ pid: number }[]>`
        SELECT pg_backend_pid()::int AS pid
      `;
      await holder`
        SELECT id FROM sim_campaigns WHERE id = ${campaignId} FOR UPDATE
      `;

      let firstSettled: SettledOperation | undefined;
      const firstOutcome = settleOperation(() => first(firstClient.db)).then(
        (outcome) => {
          firstSettled = outcome;
          return outcome;
        },
      );
      const waitForBlockedSessions = async (minimum: number) => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const observed = await holder<{ n: number }[]>`
            WITH RECURSIVE queued(pid) AS (
              SELECT activity.pid
              FROM pg_stat_activity activity
              WHERE activity.datname = current_database()
                AND ${holderPid} = ANY(pg_blocking_pids(activity.pid))
              UNION
              SELECT activity.pid
              FROM pg_stat_activity activity
              JOIN queued blocker
                ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
              WHERE activity.datname = current_database()
            )
            SELECT count(*)::int AS n FROM queued
          `;
          if (Number(observed[0]?.n ?? 0) >= minimum) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const activity = await holder`
          SELECT pid, state, wait_event_type, wait_event,
                 pg_blocking_pids(pid) AS blockers, left(query, 200) AS query
          FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
          ORDER BY pid
        `;
        throw new Error(
          `timed out waiting for ${minimum} campaign lifecycle lock waiter(s): activity=${JSON.stringify(activity)} first=${JSON.stringify(firstSettled)}`,
        );
      };
      await waitForBlockedSessions(1);
      const secondOutcome = settleOperation(() => second(secondClient.db));
      await waitForBlockedSessions(2);
      outcomes = [firstOutcome, secondOutcome];
    });
    if (!outcomes)
      throw new Error("campaign lifecycle operations were not started");
    return await Promise.all(outcomes);
  } finally {
    await Promise.all([
      barrierClient.sql.end(),
      firstClient.sql.end(),
      secondClient.sql.end(),
    ]);
  }
}

async function createExtraAirfoil(label: string): Promise<string> {
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-${label}`,
      name: `${PREFIX} ${label}`,
      categoryId,
      points,
      isSymmetric: false,
    })
    .returning({ id: airfoils.id });
  extraAirfoilIds.push(airfoil.id);
  return airfoil.id;
}

beforeAll(async () => {
  app = await buildServer();
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
  profileIds.boundary = boundary.id;
  profileIds.mesh = mesh.id;
  profileIds.solver = solver.id;
  profileIds.output = output.id;

  campaigns.active = await launchCampaign("active", SPEEDS.active);
  campaigns.paused = await launchCampaign("paused", SPEEDS.paused);
  campaigns.cancelled = await launchCampaign("cancelled", SPEEDS.cancelled);
  campaigns.sharedA = await launchCampaign("shared-a", SPEEDS.shared);
  campaigns.sharedB = await launchCampaign("shared-b", SPEEDS.shared);
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
  if (profileIds.output)
    await db
      .delete(outputProfiles)
      .where(eq(outputProfiles.id, profileIds.output));
  if (mediumId) await db.delete(mediums).where(eq(mediums.id, mediumId));
  if (extraAirfoilIds.length)
    await db.delete(airfoils).where(inArray(airfoils.id, extraAirfoilIds));
  if (airfoilId) await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
  if (categoryId)
    await db.delete(categories).where(eq(categories.id, categoryId));
  await app.close();
  await pgClient.end();
});

describe("campaign verification lifecycle guard", () => {
  let pausedQueueId = "";
  let cancelledPendingId = "";
  let cancelledRunningId = "";
  let cancelledHistoryId = "";
  let cancelledPendingJobId = "";

  it("deduplicates shared verification and automatic continuation work while attaching every campaign owner", async () => {
    const setupA = await campaignSetup(campaigns.sharedA);
    const setupB = await campaignSetup(campaigns.sharedB);
    expect(setupB.revisionId).toBe(setupA.revisionId);
    await db
      .update(simCampaignPoints)
      .set({ state: "released" })
      .where(
        and(
          inArray(simCampaignPoints.campaignId, [
            campaigns.sharedA,
            campaigns.sharedB,
          ]),
          eq(simCampaignPoints.aoaDeg, 3),
        ),
      );

    const accepted = await insertPrecalc(setupA, 0);
    await db.insert(resultClassifications).values({
      resultId: accepted.id,
      airfoilId,
      simulationPresetRevisionId: setupA.revisionId,
      aoaDeg: 0,
      regime: "urans",
      classifierVersion: "shared-owner-accepted-v1",
      state: "accepted",
      reasons: [],
    });
    const rejected = await insertPrecalc(setupA, 2);
    await db
      .update(results)
      .set({
        engineJobId: `${PREFIX}-shared-continuation-source`,
        engineCaseSlug: "aoa_2.00",
        qualityWarnings: [
          "URANS integration stopped by the wall-clock budget guard: retained 1.2 of 3 periods (budget)",
        ],
      })
      .where(eq(results.id, rejected.id));
    await db.insert(resultClassifications).values({
      resultId: rejected.id,
      airfoilId,
      simulationPresetRevisionId: setupA.revisionId,
      aoaDeg: 2,
      regime: "urans",
      classifierVersion: "shared-owner-rejected-v1",
      state: "rejected",
      reasons: ["insufficient-periods"],
    });
    for (const campaignId of [campaigns.sharedA, campaigns.sharedB]) {
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal", resultId: accepted.id })
        .where(
          and(
            eq(simCampaignPoints.campaignId, campaignId),
            eq(simCampaignPoints.aoaDeg, 0),
          ),
        );
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal", resultId: rejected.id })
        .where(
          and(
            eq(simCampaignPoints.campaignId, campaignId),
            eq(simCampaignPoints.aoaDeg, 2),
          ),
        );
    }

    const created = await Promise.all([
      enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId: setupA.revisionId,
        campaignId: campaigns.sharedA,
      }),
      enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId: setupA.revisionId,
        campaignId: campaigns.sharedB,
      }),
    ]);
    expect(created.reduce((sum, count) => sum + count, 0)).toBe(1);

    const [verifyItem] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.precalcResultId, accepted.id));
    const [request] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.continueFromResultId, rejected.id));
    expect(verifyItem).toMatchObject({
      state: "pending",
      backgroundOwner: false,
    });
    expect(request).toMatchObject({
      state: "pending",
      requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
    });
    const verifyOwners = await db
      .select({ campaignId: simUransVerifyQueueCampaigns.campaignId })
      .from(simUransVerifyQueueCampaigns)
      .where(eq(simUransVerifyQueueCampaigns.queueId, verifyItem.id));
    const requestOwners = await db
      .select({ campaignId: simUransRequestCampaigns.campaignId })
      .from(simUransRequestCampaigns)
      .where(eq(simUransRequestCampaigns.requestId, request.id));
    expect(verifyOwners.map((owner) => owner.campaignId).sort()).toEqual(
      [campaigns.sharedA, campaigns.sharedB].sort(),
    );
    expect(requestOwners.map((owner) => owner.campaignId).sort()).toEqual(
      [campaigns.sharedA, campaigns.sharedB].sort(),
    );
    await db
      .update(results)
      .set({ status: "queued", source: "queued" })
      .where(eq(results.id, rejected.id));
    for (const campaignId of [campaigns.sharedA, campaigns.sharedB]) {
      const tiers = await campaignOpenTierCounts(db, campaignId);
      expect(tiers.verifyOpen).toBe(1);
      expect(tiers.precalcOpen).toBe(1);
    }
    await db
      .update(results)
      .set({ status: "done", source: "solved" })
      .where(eq(results.id, rejected.id));

    const [ransRejected] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setupA.bcId,
        simulationPresetRevisionId: setupA.revisionId,
        aoaDeg: 1,
        status: "done",
        source: "solved",
        regime: "rans",
        fidelity: "rans",
        cl: 0.5,
        cd: 0.03,
        cm: -0.03,
        converged: false,
        stalled: true,
        unsteady: false,
        solvedAt: new Date(),
      })
      .returning();
    await db.insert(resultClassifications).values({
      resultId: ransRejected.id,
      airfoilId,
      simulationPresetRevisionId: setupA.revisionId,
      aoaDeg: 1,
      regime: "rans",
      classifierVersion: "shared-owner-rans-rejected-v1",
      state: "rejected",
      reasons: ["rans-rejected"],
    });
    for (const campaignId of [campaigns.sharedA, campaigns.sharedB]) {
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal", resultId: ransRejected.id })
        .where(
          and(
            eq(simCampaignPoints.campaignId, campaignId),
            eq(simCampaignPoints.aoaDeg, 1),
          ),
        );
      const tiers = await campaignOpenTierCounts(db, campaignId);
      expect(tiers.ransOpen).toBe(0);
      expect(tiers.precalcOpen).toBe(2);
      expect(deriveCampaignPhase("active", tiers)).toBe("running_precalc");
      await probeCampaignCompletion(db, campaignId);
    }
    const liveSharedCampaigns = await db
      .select({ id: simCampaigns.id, status: simCampaigns.status })
      .from(simCampaigns)
      .where(inArray(simCampaigns.id, [campaigns.sharedA, campaigns.sharedB]));
    expect(
      liveSharedCampaigns.every((campaign) => campaign.status === "active"),
    ).toBe(true);

    // A later campaign reuses the rejected RANS evidence but has no campaign
    // wave-1 parent for it. Launch reconciliation must create one exact fresh
    // precalc request and attach every live campaign sharing the physical
    // cell, rather than leaving the new campaign stuck in running_precalc.
    const reusedCampaignId = await launchCampaign(
      "shared-reused-rans",
      SPEEDS.shared,
    );
    const reusedSetup = await campaignSetup(reusedCampaignId);
    expect(reusedSetup.revisionId).toBe(setupA.revisionId);
    await db
      .update(simCampaignPoints)
      .set({ state: "released" })
      .where(
        and(
          eq(simCampaignPoints.campaignId, reusedCampaignId),
          eq(simCampaignPoints.aoaDeg, 3),
        ),
      );
    const [reusedPoint] = await db
      .select({
        state: simCampaignPoints.state,
        resultId: simCampaignPoints.resultId,
      })
      .from(simCampaignPoints)
      .where(
        and(
          eq(simCampaignPoints.campaignId, reusedCampaignId),
          eq(simCampaignPoints.aoaDeg, 1),
        ),
      );
    expect(reusedPoint).toEqual({
      state: "terminal",
      resultId: ransRejected.id,
    });
    const [freshRequest] = await db
      .select()
      .from(simUransRequests)
      .where(
        and(
          eq(simUransRequests.airfoilId, airfoilId),
          eq(simUransRequests.revisionId, setupA.revisionId),
          eq(simUransRequests.aoaDeg, 1),
          eq(simUransRequests.fidelity, "precalc"),
          eq(simUransRequests.state, "pending"),
        ),
      );
    expect(freshRequest).toMatchObject({
      requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      continueFromResultId: null,
    });
    const freshOwners = await db
      .select({ campaignId: simUransRequestCampaigns.campaignId })
      .from(simUransRequestCampaigns)
      .where(eq(simUransRequestCampaigns.requestId, freshRequest.id));
    expect(freshOwners.map((owner) => owner.campaignId).sort()).toEqual(
      [campaigns.sharedA, campaigns.sharedB, reusedCampaignId].sort(),
    );
    const reusedTiers = await campaignOpenTierCounts(db, reusedCampaignId);
    expect(reusedTiers.precalcOpen).toBeGreaterThanOrEqual(1);
    expect(deriveCampaignPhase("active", reusedTiers)).toBe("running_precalc");
    const [reusedCampaign] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, reusedCampaignId));
    expect(reusedCampaign.status).toBe("active");

    // Background catalog verification is an independent owner of the same
    // physical item, not a second queue row.
    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId: setupA.revisionId,
      }),
    ).toBe(0);
    const [backgroundOwned] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, verifyItem.id));
    expect(backgroundOwned.backgroundOwner).toBe(true);

    // One completed physical continuation spends the bounded attempt globally
    // for its source evidence; another campaign refresh cannot create another.
    await db
      .update(simUransRequests)
      .set({ state: "done" })
      .where(eq(simUransRequests.id, request.id));
    await enqueuePrecalcVerifications(db, {
      airfoilId,
      revisionId: setupA.revisionId,
      campaignId: campaigns.sharedB,
    });
    expect(
      await db
        .select({ id: simUransRequests.id })
        .from(simUransRequests)
        .where(eq(simUransRequests.continueFromResultId, rejected.id)),
    ).toHaveLength(1);

    const [retryableReuse] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setupA.bcId,
        simulationPresetRevisionId: setupA.revisionId,
        aoaDeg: 3,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.8,
        cd: 0.05,
        cm: -0.05,
        converged: true,
        unsteady: true,
        engineJobId: `${PREFIX}-retryable-reuse-source`,
        engineCaseSlug: "aoa_3.00",
        qualityWarnings: [
          "URANS integration stopped by the wall-clock budget guard: retained 1.1 of 3 periods (budget)",
        ],
        solvedAt: new Date(),
      })
      .returning();
    await db.insert(resultClassifications).values({
      resultId: retryableReuse.id,
      airfoilId,
      simulationPresetRevisionId: setupA.revisionId,
      aoaDeg: 3,
      regime: "urans",
      classifierVersion: "shared-owner-retryable-reuse-v1",
      state: "rejected",
      reasons: ["insufficient-periods"],
    });
    for (const campaignId of [
      campaigns.sharedA,
      campaigns.sharedB,
      reusedCampaignId,
    ]) {
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal", resultId: retryableReuse.id })
        .where(
          and(
            eq(simCampaignPoints.campaignId, campaignId),
            eq(simCampaignPoints.aoaDeg, 3),
          ),
        );
    }
    const [cancelledPreSubmit] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: setupA.revisionId,
        aoaDeg: 3,
        fidelity: "precalc",
        state: "cancelled",
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
        continueFromResultId: retryableReuse.id,
        budgetOverrideS: 7200,
      })
      .returning();
    await db.insert(simUransRequestCampaigns).values({
      requestId: cancelledPreSubmit.id,
      campaignId: campaigns.sharedA,
    });
    await db
      .update(simUransVerifyQueue)
      .set({ state: "cancelled" })
      .where(eq(simUransVerifyQueue.id, verifyItem.id));

    const futureCampaignId = await launchCampaign(
      "shared-reused-after-history",
      SPEEDS.shared,
    );
    const futureSetup = await campaignSetup(futureCampaignId);
    expect(futureSetup.revisionId).toBe(setupA.revisionId);
    const verifyHistory = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.precalcResultId, accepted.id));
    expect(verifyHistory.map((item) => item.state).sort()).toEqual([
      "cancelled",
      "pending",
    ]);
    const replacementVerify = verifyHistory.find(
      (item) => item.state === "pending",
    )!;
    expect(replacementVerify.backgroundOwner).toBe(false);
    const replacementVerifyOwners = await db
      .select({ campaignId: simUransVerifyQueueCampaigns.campaignId })
      .from(simUransVerifyQueueCampaigns)
      .where(eq(simUransVerifyQueueCampaigns.queueId, replacementVerify.id));
    expect(
      replacementVerifyOwners.map((owner) => owner.campaignId).sort(),
    ).toEqual(
      [
        campaigns.sharedA,
        campaigns.sharedB,
        reusedCampaignId,
        futureCampaignId,
      ].sort(),
    );

    const retryHistory = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.continueFromResultId, retryableReuse.id));
    expect(retryHistory.map((item) => item.state).sort()).toEqual([
      "cancelled",
      "pending",
    ]);
    const replacementContinuation = retryHistory.find(
      (item) => item.state === "pending",
    )!;
    expect(replacementContinuation).toMatchObject({
      budgetOverrideS: 7200,
      continueFromResultId: retryableReuse.id,
      requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
    });
    const retryOwners = await db
      .select({ campaignId: simUransRequestCampaigns.campaignId })
      .from(simUransRequestCampaigns)
      .where(
        eq(simUransRequestCampaigns.requestId, replacementContinuation.id),
      );
    expect(retryOwners.map((owner) => owner.campaignId).sort()).toEqual(
      [
        campaigns.sharedA,
        campaigns.sharedB,
        reusedCampaignId,
        futureCampaignId,
      ].sort(),
    );
    expect(
      await db
        .select({ id: simUransRequests.id })
        .from(simUransRequests)
        .where(eq(simUransRequests.continueFromResultId, rejected.id)),
    ).toHaveLength(1);
    await db
      .update(simUransVerifyQueue)
      .set({ state: "done" })
      .where(eq(simUransVerifyQueue.id, replacementVerify.id));
    await db
      .update(simUransRequests)
      .set({ state: "done" })
      .where(
        inArray(simUransRequests.id, [
          freshRequest.id,
          replacementContinuation.id,
        ]),
      );
  }, 120000);

  it("reopens a completed campaign with owned verify and request work when add-airfoil reuses preliminary evidence", async () => {
    const completedCampaignId = await launchCampaign(
      "completed-add-reuse",
      41.137,
    );
    const setup = await campaignSetup(completedCampaignId);

    for (const aoaDeg of [0, 1, 2, 3]) {
      const [accepted] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId: setup.bcId,
          simulationPresetRevisionId: setup.revisionId,
          aoaDeg,
          status: "done",
          source: "solved",
          regime: "rans",
          fidelity: "rans",
          cl: 0.2 + aoaDeg * 0.1,
          cd: 0.02,
          cm: -0.02,
          converged: true,
          unsteady: false,
          solvedAt: new Date(),
        })
        .returning();
      await db.insert(resultClassifications).values({
        resultId: accepted.id,
        airfoilId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg,
        regime: "rans",
        classifierVersion: "completed-add-source-accepted-v1",
        state: "accepted",
        reasons: [],
      });
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal", resultId: accepted.id })
        .where(
          and(
            eq(simCampaignPoints.campaignId, completedCampaignId),
            eq(simCampaignPoints.aoaDeg, aoaDeg),
          ),
        );
    }
    await probeCampaignCompletion(db, completedCampaignId);
    let [campaign] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, completedCampaignId));
    expect(campaign.status).toBe("completed");

    const [addedAirfoil] = await db
      .insert(airfoils)
      .values({
        slug: `${PREFIX}-completed-add-foil`,
        name: `${PREFIX} completed add foil`,
        categoryId,
        points,
        isSymmetric: false,
      })
      .returning();
    extraAirfoilIds.push(addedAirfoil.id);

    const evidence = async (input: {
      aoaDeg: number;
      fidelity: "rans" | "urans_precalc";
      state: "accepted" | "rejected";
      continuable?: boolean;
    }) => {
      const [row] = await db
        .insert(results)
        .values({
          airfoilId: addedAirfoil.id,
          bcId: setup.bcId,
          simulationPresetRevisionId: setup.revisionId,
          aoaDeg: input.aoaDeg,
          status: "done",
          source: "solved",
          regime: input.fidelity === "rans" ? "rans" : "urans",
          fidelity: input.fidelity,
          cl: 0.3 + input.aoaDeg * 0.1,
          cd: 0.03,
          cm: -0.03,
          converged: input.state === "accepted",
          stalled: input.fidelity === "rans" && input.state === "rejected",
          unsteady: input.fidelity === "urans_precalc",
          engineJobId: input.continuable
            ? `${PREFIX}-completed-add-continuation-source`
            : null,
          engineCaseSlug: input.continuable ? `aoa_${input.aoaDeg}.00` : null,
          qualityWarnings: input.continuable
            ? [
                "URANS integration stopped by the wall-clock budget guard: retained 1.1 of 3 periods (budget)",
              ]
            : [],
          solvedAt: new Date(),
        })
        .returning();
      await db.insert(resultClassifications).values({
        resultId: row.id,
        airfoilId: addedAirfoil.id,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: input.aoaDeg,
        regime: input.fidelity === "rans" ? "rans" : "urans",
        classifierVersion: `completed-add-${input.aoaDeg}-v1`,
        state: input.state,
        reasons: input.state === "rejected" ? ["fixture-rejected"] : [],
      });
      return row;
    };
    const acceptedPrecalc = await evidence({
      aoaDeg: 0,
      fidelity: "urans_precalc",
      state: "accepted",
    });
    await evidence({ aoaDeg: 1, fidelity: "rans", state: "rejected" });
    const rejectedPrecalc = await evidence({
      aoaDeg: 2,
      fidelity: "urans_precalc",
      state: "rejected",
      continuable: true,
    });
    await evidence({ aoaDeg: 3, fidelity: "rans", state: "accepted" });

    const preview = await previewAddCampaignAirfoils(db, completedCampaignId, [
      addedAirfoil.id,
    ]);
    const applied = await addCampaignAirfoils(
      db,
      completedCampaignId,
      [addedAirfoil.id],
      preview.diffHash,
    );
    expect(applied).toMatchObject({ status: "applied", addedAirfoils: 1 });
    [campaign] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, completedCampaignId));
    expect(campaign.status).toBe("active");

    const [verifyItem] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(
        and(
          eq(simUransVerifyQueue.precalcResultId, acceptedPrecalc.id),
          eq(simUransVerifyQueue.state, "pending"),
        ),
      );
    expect(verifyItem).toMatchObject({ backgroundOwner: false });
    expect(
      await db
        .select({ campaignId: simUransVerifyQueueCampaigns.campaignId })
        .from(simUransVerifyQueueCampaigns)
        .where(
          and(
            eq(simUransVerifyQueueCampaigns.queueId, verifyItem.id),
            eq(simUransVerifyQueueCampaigns.campaignId, completedCampaignId),
            eq(simUransVerifyQueueCampaigns.state, "active"),
          ),
        ),
    ).toHaveLength(1);

    const requests = await db
      .select()
      .from(simUransRequests)
      .where(
        and(
          eq(simUransRequests.airfoilId, addedAirfoil.id),
          eq(simUransRequests.revisionId, setup.revisionId),
          eq(simUransRequests.state, "pending"),
        ),
      );
    expect(requests.map((request) => request.aoaDeg).sort()).toEqual([1, 2]);
    expect(requests.find((request) => request.aoaDeg === 1)).toMatchObject({
      continueFromResultId: null,
      requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
    });
    expect(requests.find((request) => request.aoaDeg === 2)).toMatchObject({
      continueFromResultId: rejectedPrecalc.id,
      budgetOverrideS: 7200,
      requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
    });
    for (const request of requests) {
      expect(
        await db
          .select({ campaignId: simUransRequestCampaigns.campaignId })
          .from(simUransRequestCampaigns)
          .where(
            and(
              eq(simUransRequestCampaigns.requestId, request.id),
              eq(simUransRequestCampaigns.campaignId, completedCampaignId),
              eq(simUransRequestCampaigns.state, "active"),
            ),
          ),
      ).toHaveLength(1);
    }

    await db
      .update(simUransVerifyQueue)
      .set({ state: "done" })
      .where(eq(simUransVerifyQueue.id, verifyItem.id));
    await db
      .update(simUransRequests)
      .set({ state: "done" })
      .where(
        inArray(
          simUransRequests.id,
          requests.map((request) => request.id),
        ),
      );
  }, 120000);

  it("claims active verification work while an older paused item stays frozen", async () => {
    const activeSetup = await campaignSetup(campaigns.active);
    const pausedSetup = await campaignSetup(campaigns.paused);
    const pausedResult = await insertPrecalc(pausedSetup, 0);
    const activeResult = await insertPrecalc(activeSetup, 0);
    await pauseCampaign(db, campaigns.paused);

    const [pausedItem] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId: pausedSetup.revisionId,
        aoaDeg: 0,
        state: "pending",
        precalcResultId: pausedResult.id,
        createdAt: new Date(Date.now() - 60_000),
      })
      .returning();
    pausedQueueId = pausedItem.id;
    const [activeItem] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId: activeSetup.revisionId,
        aoaDeg: 0,
        state: "pending",
        precalcResultId: activeResult.id,
      })
      .returning();
    await db.insert(simUransVerifyQueueCampaigns).values([
      { queueId: pausedItem.id, campaignId: campaigns.paused },
      { queueId: activeItem.id, campaignId: campaigns.active },
    ]);

    const claimed = await claimNextPendingVerifyItem(db, verifyScope());
    expect(claimed?.id).toBe(activeItem.id);
    expect(claimed?.state).toBe("running");
    const [stillPaused] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, pausedQueueId));
    expect(stillPaused.state).toBe("pending");

    // This fixture claim represents an in-flight item; settle it so only the
    // paused/cancelled cases remain eligible for the following assertions.
    await db
      .update(simUransVerifyQueue)
      .set({ state: "done" })
      .where(eq(simUransVerifyQueue.id, activeItem.id));
  });

  it("freezes a campaign-owned automatic continuation while paused and releases an in-flight claim back to pending", async () => {
    const setup = await campaignSetup(campaigns.paused);
    const source = await insertPrecalc(setup, 2);
    await db
      .update(results)
      .set({
        engineJobId: `${PREFIX}-paused-continuation-source`,
        engineCaseSlug: "aoa_2.00",
        qualityWarnings: [
          "URANS integration stopped by the wall-clock budget guard: retained 1.2 of 3 periods (budget)",
        ],
      })
      .where(eq(results.id, source.id));
    await db.insert(resultClassifications).values({
      resultId: source.id,
      airfoilId,
      simulationPresetRevisionId: setup.revisionId,
      aoaDeg: 2,
      regime: "urans",
      classifierVersion: "paused-auto-continuation-v1",
      state: "rejected",
      reasons: ["insufficient-periods"],
    });
    await db
      .update(simCampaignPoints)
      .set({ state: "terminal", resultId: source.id })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaigns.paused),
          eq(simCampaignPoints.aoaDeg, 2),
        ),
      );

    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId: setup.revisionId,
        campaignId: campaigns.paused,
      }),
    ).toBe(0);
    const [request] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.continueFromResultId, source.id));
    expect(request).toMatchObject({
      state: "pending",
      requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
    });
    expect(
      await db
        .select({ campaignId: simUransRequestCampaigns.campaignId })
        .from(simUransRequestCampaigns)
        .where(eq(simUransRequestCampaigns.requestId, request.id)),
    ).toEqual([{ campaignId: campaigns.paused }]);

    expect(
      await claimNextPendingUransRequest(db, { requestIds: [request.id] }),
    ).toBeNull();
    await resumeCampaign(db, campaigns.paused);
    const claimed = await claimNextPendingUransRequest(db, {
      requestIds: [request.id],
    });
    expect(claimed).toMatchObject({ id: request.id, state: "running" });

    // A lifecycle change racing the engine submit must retain the durable
    // work item but freeze it until the owner explicitly resumes.
    await pauseCampaign(db, campaigns.paused);
    await releaseClaimedUransRequest(db, request.id);
    const [frozen] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    expect(frozen.state).toBe("pending");
    expect(
      await claimNextPendingUransRequest(db, { requestIds: [request.id] }),
    ).toBeNull();

    await db
      .update(simUransRequests)
      .set({ state: "cancelled" })
      .where(eq(simUransRequests.id, request.id));
  });

  it("cancels pending verification rows transactionally while retaining in-flight and completed history", async () => {
    const setup = await campaignSetup(campaigns.cancelled);
    const pendingResult = await insertPrecalc(setup, 0);
    const historyResult = await insertPrecalc(setup, 1);
    const runningResult = await insertPrecalc(setup, 2);
    const [pending, history, running] = await db
      .insert(simUransVerifyQueue)
      .values([
        {
          airfoilId,
          revisionId: setup.revisionId,
          aoaDeg: 0,
          state: "pending",
          precalcResultId: pendingResult.id,
        },
        {
          airfoilId,
          revisionId: setup.revisionId,
          aoaDeg: 1,
          state: "done",
          precalcResultId: historyResult.id,
          verifyResultId: historyResult.id,
          deltaCl: 0.012,
          deltaCd: 0.001,
        },
        {
          airfoilId,
          revisionId: setup.revisionId,
          aoaDeg: 2,
          state: "running",
          precalcResultId: runningResult.id,
        },
      ])
      .returning();
    await db.insert(simUransVerifyQueueCampaigns).values(
      [pending, history, running].map((item) => ({
        queueId: item.id,
        campaignId: campaigns.cancelled,
      })),
    );
    const [pendingContinuation] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg: 3,
        fidelity: "precalc",
        state: "pending",
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
        budgetOverrideS: 7200,
      })
      .returning();
    await db.insert(simUransRequestCampaigns).values({
      requestId: pendingContinuation.id,
      campaignId: campaigns.cancelled,
    });
    // A process may die after releasing a failed precalc cell to the durable
    // queued/no-owner ladder route. Terminal campaign cancellation must settle
    // that exact routed shape instead of leaving it queued forever.
    await db
      .update(results)
      .set({
        status: "queued",
        source: "queued",
        autoRetriedAt: new Date(),
        error: "transient precalc crash awaiting wave-2 retry",
      })
      .where(eq(results.id, pendingResult.id));
    await db.insert(resultAttempts).values({
      resultId: pendingResult.id,
      airfoilId,
      bcId: setup.bcId,
      simulationPresetRevisionId: setup.revisionId,
      aoaDeg: 0,
      status: "failed",
      source: "queued",
      regime: "urans",
      fidelity: "urans_precalc",
      validForPolar: false,
      converged: false,
      stalled: false,
      unsteady: true,
      error: "transient precalc crash awaiting wave-2 retry",
      solvedAt: new Date(),
    });
    cancelledPendingId = pending.id;
    cancelledHistoryId = history.id;
    cancelledRunningId = running.id;
    const [pendingComposition] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: campaigns.cancelled,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 1,
        status: "pending",
        totalCases: 1,
        requestPayload: { aoas: [0] },
      })
      .returning({ id: simJobs.id });
    cancelledPendingJobId = pendingComposition.id;

    const outcome = await cancelCampaign(db, campaigns.cancelled);
    expect(outcome.campaign.status).toBe("cancelled");
    expect(outcome.cancelledPendingVerifications).toBe(3);
    expect(outcome.cancelledPendingUransRequests).toBe(1);
    expect(outcome.cancelledPendingJobs).toBe(1);
    expect(outcome.staledPendingResults).toBeGreaterThanOrEqual(1);
    const [settledRoutedResult] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, pendingResult.id));
    expect(settledRoutedResult).toEqual({ status: "stale", simJobId: null });
    const [cancelledComposition] = await db
      .select({ status: simJobs.status, error: simJobs.error })
      .from(simJobs)
      .where(eq(simJobs.id, cancelledPendingJobId));
    expect(cancelledComposition.status).toBe("cancelled");
    expect(cancelledComposition.error).toContain(
      "campaign cancelled before engine submission",
    );
    const [cancelledContinuation] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, pendingContinuation.id));
    expect(cancelledContinuation.state).toBe("cancelled");

    const rows = await db
      .select()
      .from(simUransVerifyQueue)
      .where(
        inArray(simUransVerifyQueue.id, [
          cancelledPendingId,
          cancelledRunningId,
          cancelledHistoryId,
        ]),
      );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(cancelledPendingId)).toMatchObject({
      state: "cancelled",
      precalcResultId: pendingResult.id,
    });
    expect(byId.get(cancelledRunningId)).toMatchObject({
      state: "running",
      precalcResultId: runningResult.id,
    });
    expect(byId.get(cancelledHistoryId)).toMatchObject({
      state: "done",
      precalcResultId: historyResult.id,
      verifyResultId: historyResult.id,
      deltaCl: 0.012,
      deltaCd: 0.001,
    });

    // Production cancellation can leave the queue claim running while its job
    // is cancelled. The orphan healer must apply the same lifecycle decision
    // as an immediate pre-submit release, never resurrect terminal campaign
    // work into an unschedulable pending row.
    await db
      .update(simUransVerifyQueue)
      .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(simUransVerifyQueue.id, cancelledRunningId));
    expect(await healOrphanedVerifyItems(db)).toBeGreaterThanOrEqual(1);
    const [releasedRunning] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, cancelledRunningId));
    expect(releasedRunning.state).toBe("cancelled");

    // A hidden pending orphan would also monopolize the partial unique cell
    // key forever. Once healed terminally, later legitimate work for the same
    // physical cell can acquire a fresh queue row.
    const replacement = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg: 2,
        backgroundOwner: true,
        state: "pending",
        precalcResultId: runningResult.id,
      })
      .onConflictDoNothing()
      .returning({ id: simUransVerifyQueue.id });
    expect(replacement).toHaveLength(1);
    await db
      .update(simUransVerifyQueue)
      .set({ state: "cancelled" })
      .where(eq(simUransVerifyQueue.id, replacement[0].id));

    // With only paused/cancelled campaign items left, nothing is schedulable.
    expect(await claimNextPendingVerifyItem(db, verifyScope())).toBeNull();
  });

  it("makes frozen verification work eligible again only after explicit resume", async () => {
    await resumeCampaign(db, campaigns.paused);
    const firstClaim = await claimNextPendingVerifyItem(db, verifyScope());
    expect(firstClaim?.id).toBe(pausedQueueId);
    expect(firstClaim?.state).toBe("running");

    // A transient submit failure racing with a later pause freezes the item
    // back to pending; it becomes claimable again only after another resume.
    await pauseCampaign(db, campaigns.paused);
    await releaseClaimedVerifyItem(db, pausedQueueId);
    const [frozen] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, pausedQueueId));
    expect(frozen.state).toBe("pending");
    expect(await claimNextPendingVerifyItem(db, verifyScope())).toBeNull();

    await resumeCampaign(db, campaigns.paused);
    const secondClaim = await claimNextPendingVerifyItem(db, verifyScope());
    expect(secondClaim?.id).toBe(pausedQueueId);
    expect(secondClaim?.state).toBe("running");
  });

  it("settles a process-death verify composition but leaves a fresh submit lease untouched", async () => {
    const setup = await campaignSetup(campaigns.active);
    const orphanResult = await insertPrecalc(setup, 1);
    const freshResult = await insertPrecalc(setup, 2);
    const staleAt = new Date(Date.now() - 10 * 60_000);
    const [orphanItem, freshItem] = await db
      .insert(simUransVerifyQueue)
      .values([
        {
          airfoilId,
          revisionId: setup.revisionId,
          aoaDeg: 1,
          state: "running",
          precalcResultId: orphanResult.id,
          updatedAt: staleAt,
        },
        {
          airfoilId,
          revisionId: setup.revisionId,
          aoaDeg: 2,
          state: "running",
          precalcResultId: freshResult.id,
          // Deliberately old queue claim but a fresh composition lease below:
          // the healer must not race a valid in-flight submit.
          updatedAt: staleAt,
        },
      ])
      .returning();
    await db.insert(simUransVerifyQueueCampaigns).values([
      { queueId: orphanItem.id, campaignId: campaigns.active },
      { queueId: freshItem.id, campaignId: campaigns.active },
    ]);
    const [orphanJob, freshJob] = await db
      .insert(simJobs)
      .values([
        {
          airfoilId,
          bcIds: [setup.bcId],
          simulationPresetRevisionId: setup.revisionId,
          campaignId: null,
          jobKind: "verify",
          referenceChordM: CHORD,
          wave: 2,
          status: "pending",
          engineState: "submitting",
          totalCases: 1,
          requestPayload: {
            verifyQueueItemId: orphanItem.id,
            aoas: [1],
            uransFidelity: "full",
          },
          updatedAt: staleAt,
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
          engineState: "submitting",
          totalCases: 1,
          requestPayload: {
            verifyQueueItemId: freshItem.id,
            aoas: [2],
            uransFidelity: "full",
          },
        },
      ])
      .returning();
    // The queue row is the normalized execution owner. Request-payload ids are
    // provenance only and must never authorize healing or submission by
    // themselves. Preserve the deliberately stale queue timestamps while
    // installing each exact composed-job owner.
    await db
      .update(simUransVerifyQueue)
      .set({ simJobId: orphanJob.id, updatedAt: staleAt })
      .where(eq(simUransVerifyQueue.id, orphanItem.id));
    await db
      .update(simUransVerifyQueue)
      .set({ simJobId: freshJob.id, updatedAt: staleAt })
      .where(eq(simUransVerifyQueue.id, freshItem.id));

    expect(await healOrphanedVerifyItems(db)).toBeGreaterThanOrEqual(1);
    const [afterOrphanItem] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, orphanItem.id));
    const [afterFreshItem] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, freshItem.id));
    const [afterOrphanJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, orphanJob.id));
    const [afterFreshJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, freshJob.id));
    expect(afterOrphanJob.status).toBe("cancelled");
    expect(afterOrphanItem).toMatchObject({ state: "pending", simJobId: null });
    expect(afterFreshJob.status).toBe("pending");
    expect(afterFreshItem).toMatchObject({
      state: "running",
      simJobId: freshJob.id,
    });
  });
});

describe("terminal verification ownership healing", () => {
  it("does not reopen completed historical owners and cancels legacy pending orphans", async () => {
    const speed = 42.437;
    const historicalId = await launchCampaign(
      "completed-verification-history",
      speed,
    );
    const setup = await campaignSetup(historicalId);
    const acceptedPrecalc = await insertPrecalc(setup, 0);
    await db.insert(resultClassifications).values({
      resultId: acceptedPrecalc.id,
      airfoilId,
      simulationPresetRevisionId: setup.revisionId,
      aoaDeg: 0,
      regime: "urans",
      classifierVersion: "completed-owner-regression-v1",
      state: "accepted",
      reasons: [],
    });
    const solved = [acceptedPrecalc];
    for (const aoaDeg of [1, 2, 3]) {
      const [row] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId: setup.bcId,
          simulationPresetRevisionId: setup.revisionId,
          aoaDeg,
          status: "done",
          source: "solved",
          regime: "rans",
          fidelity: "rans",
          cl: 0.3 + aoaDeg * 0.1,
          cd: 0.02,
          cm: -0.03,
          unsteady: false,
          converged: true,
          solvedAt: new Date(),
        })
        .returning();
      await db.insert(resultClassifications).values({
        resultId: row.id,
        airfoilId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg,
        regime: "rans",
        classifierVersion: "completed-owner-regression-v1",
        state: "accepted",
        reasons: [],
      });
      solved.push(row);
    }
    for (const row of solved) {
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal", resultId: row.id })
        .where(
          and(
            eq(simCampaignPoints.campaignId, historicalId),
            eq(simCampaignPoints.aoaDeg, row.aoaDeg),
          ),
        );
    }
    await probeCampaignCompletion(db, historicalId);
    let [historical] = await db
      .select({ status: simCampaigns.status })
      .from(simCampaigns)
      .where(eq(simCampaigns.id, historicalId));
    expect(historical.status).toBe("completed");

    const liveId = await launchCampaign("live-verification-reuse", speed);
    const [verifyItem] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(
        and(
          eq(simUransVerifyQueue.precalcResultId, acceptedPrecalc.id),
          eq(simUransVerifyQueue.state, "pending"),
        ),
      );
    const owners = await db
      .select({ campaignId: simUransVerifyQueueCampaigns.campaignId })
      .from(simUransVerifyQueueCampaigns)
      .where(eq(simUransVerifyQueueCampaigns.queueId, verifyItem.id));
    expect(owners.map((owner) => owner.campaignId)).toEqual([liveId]);

    // Simulate a legacy active association left on a completed campaign. It is
    // audit history, not current ownership, so cancelling the last live owner
    // must terminate the physical pending item immediately.
    await db.insert(simUransVerifyQueueCampaigns).values({
      queueId: verifyItem.id,
      campaignId: historicalId,
      state: "active",
    });
    await cancelCampaign(db, liveId);
    const [afterCancel] = await db
      .select({ state: simUransVerifyQueue.state })
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, verifyItem.id));
    expect(afterCancel.state).toBe("cancelled");

    const legacyResult = await insertPrecalc(setup, 9);
    const [legacyPending] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg: 9,
        state: "pending",
        backgroundOwner: false,
        precalcResultId: legacyResult.id,
      })
      .returning();
    await db.insert(simUransVerifyQueueCampaigns).values({
      queueId: legacyPending.id,
      campaignId: historicalId,
      state: "active",
    });
    expect(
      await healOrphanedVerifyItems(db, { campaignIds: [historicalId] }),
    ).toBeGreaterThanOrEqual(1);
    const [healed] = await db
      .select({ state: simUransVerifyQueue.state })
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, legacyPending.id));
    expect(healed.state).toBe("cancelled");
    [historical] = await db
      .select({ status: simCampaigns.status })
      .from(simCampaigns)
      .where(eq(simCampaigns.id, historicalId));
    expect(historical.status).toBe("completed");
  }, 120000);
});

describe("campaign lifecycle transition serialization", () => {
  it("lets cancellation win before a queued resume can revalidate", async () => {
    const campaignId = await launchCampaign("resume-v-cancel", 42.137);
    await pauseCampaign(db, campaignId);

    const [cancelled, resumed] = await raceCampaignOperations(
      campaignId,
      (operationDb) => cancelCampaign(operationDb, campaignId),
      (operationDb) => resumeCampaign(operationDb, campaignId),
    );
    expect(cancelled.ok).toBe(true);
    expect(resumed.ok).toBe(false);
    expect(
      resumed.ok ? "" : String((resumed.error as Error).message),
    ).toContain("status: cancelled");
    const [campaign] = await db
      .select({ status: simCampaigns.status })
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignId));
    expect(campaign.status).toBe("cancelled");
  }, 120000);

  it("does not close a campaign from a stale attention read after growth", async () => {
    const campaignId = await launchCampaign("close-v-growth", 42.237);
    await db
      .update(simCampaigns)
      .set({ status: "attention" })
      .where(eq(simCampaigns.id, campaignId));
    const addedAirfoilId = await createExtraAirfoil("close-v-growth-foil");
    const preview = await previewAddCampaignAirfoils(db, campaignId, [
      addedAirfoilId,
    ]);

    const [grown, closed] = await raceCampaignOperations(
      campaignId,
      (operationDb) =>
        addCampaignAirfoils(
          operationDb,
          campaignId,
          [addedAirfoilId],
          preview.diffHash,
        ),
      (operationDb) => closeCampaignWithFailures(operationDb, campaignId),
    );
    expect(grown.ok).toBe(true);
    expect(closed.ok).toBe(false);
    expect(closed.ok ? "" : String((closed.error as Error).message)).toContain(
      "only attention campaigns",
    );
    const [campaign] = await db
      .select({ status: simCampaigns.status })
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignId));
    expect(campaign.status).toBe("active");
  }, 120000);

  it("does not archive a campaign from a stale completed read after growth", async () => {
    const campaignId = await launchCampaign("archive-v-growth", 42.337);
    await db
      .update(simCampaigns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(simCampaigns.id, campaignId));
    const addedAirfoilId = await createExtraAirfoil("archive-v-growth-foil");
    const preview = await previewAddCampaignAirfoils(db, campaignId, [
      addedAirfoilId,
    ]);

    const [grown, archived] = await raceCampaignOperations(
      campaignId,
      (operationDb) =>
        addCampaignAirfoils(
          operationDb,
          campaignId,
          [addedAirfoilId],
          preview.diffHash,
        ),
      (operationDb) => archiveCampaign(operationDb, campaignId),
    );
    expect(grown.ok).toBe(true);
    expect(archived.ok).toBe(false);
    expect(
      archived.ok ? "" : String((archived.error as Error).message),
    ).toContain("only completed/cancelled campaigns");
    const [campaign] = await db
      .select({ status: simCampaigns.status })
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignId));
    expect(campaign.status).toBe("active");
  }, 120000);
});

describe("admin job cancellation race guard", () => {
  it("projects exhausted PRECALC request coverage as blocked, never done", async () => {
    const setup = await campaignSetup(campaigns.active);
    const aoaDeg = 40.099;
    const [request] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg,
        fidelity: "precalc",
        state: "pending",
        requestedBy: `${PREFIX}-blocked-projection`,
        backgroundOwner: true,
      })
      .returning();
    const [obligation] = await ensurePrecalcObligations(
      db,
      [{ airfoilId, revisionId: setup.revisionId, aoaDeg }],
      { requestIds: [request.id] },
    );
    await db
      .update(simPrecalcObligations)
      .set({
        state: "blocked",
        attemptCount: 2,
        lastOutcome: "failed_exhausted",
      })
      .where(eq(simPrecalcObligations.id, obligation.id));
    expect(await precalcRequestStateFromObligations(db, request.id)).toBe(
      "blocked",
    );
  });

  it("recover-stale leaves a live slow ingest lease and the tokenless compatibility grace untouched", async () => {
    const setup = await campaignSetup(campaigns.active);
    const claimedAt = new Date(Date.now() - 60_000);
    const expiresAt = new Date(Date.now() + 8 * 60_000);
    const engineJobId = `${PREFIX}-live-slow-ingest`;
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: campaigns.active,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "ingesting",
        engineState: "completed",
        engineJobId,
        submittedAt: new Date(Date.now() - 2 * 60 * 60_000),
        polledAt: new Date(Date.now() - 5 * 60_000),
        totalCases: 1,
        completedCases: 1,
        ingestLeaseToken: `${PREFIX}-live-token`,
        ingestLeaseClaimedAt: claimedAt,
        ingestLeaseExpiresAt: expiresAt,
        error: "slow evidence/media ingest is still running",
        updatedAt: claimedAt,
      })
      .returning();
    const [legacyGraceJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: campaigns.active,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "ingesting",
        engineState: "completed",
        engineJobId: `${PREFIX}-legacy-tokenless-grace`,
        submittedAt: new Date(Date.now() - 2 * 60 * 60_000),
        polledAt: new Date(Date.now() - 5 * 60_000),
        totalCases: 1,
        completedCases: 1,
        error: "pre-migration ingest is inside compatibility grace",
        updatedAt: claimedAt,
      })
      .returning();

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/jobs/recover-stale",
      payload: {
        olderThanMinutes: 30,
        jobIds: [job.id, legacyGraceJob.id],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      recovered: 0,
      requeued: 0,
      ingestReady: 0,
      markedIngesting: 0,
      unchanged: 0,
    });

    const [after] = await db
      .select({
        status: simJobs.status,
        engineState: simJobs.engineState,
        error: simJobs.error,
        ingestLeaseToken: simJobs.ingestLeaseToken,
        ingestLeaseClaimedAt: simJobs.ingestLeaseClaimedAt,
        ingestLeaseExpiresAt: simJobs.ingestLeaseExpiresAt,
        updatedAt: simJobs.updatedAt,
      })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(after).toMatchObject({
      status: "ingesting",
      engineState: "completed",
      error: "slow evidence/media ingest is still running",
      ingestLeaseToken: `${PREFIX}-live-token`,
    });
    expect(after.ingestLeaseClaimedAt?.getTime()).toBe(claimedAt.getTime());
    expect(after.ingestLeaseExpiresAt?.getTime()).toBe(expiresAt.getTime());
    expect(after.updatedAt.getTime()).toBe(claimedAt.getTime());

    const [legacyAfter] = await db
      .select({
        status: simJobs.status,
        error: simJobs.error,
        ingestLeaseToken: simJobs.ingestLeaseToken,
        ingestLeaseExpiresAt: simJobs.ingestLeaseExpiresAt,
        updatedAt: simJobs.updatedAt,
      })
      .from(simJobs)
      .where(eq(simJobs.id, legacyGraceJob.id));
    expect(legacyAfter).toMatchObject({
      status: "ingesting",
      error: "pre-migration ingest is inside compatibility grace",
      ingestLeaseToken: null,
      ingestLeaseExpiresAt: null,
    });
    expect(legacyAfter.updatedAt.getTime()).toBe(claimedAt.getTime());
  });

  it("recover-stale leaves result-ready work claimable and recovers an expired ingest lease", async () => {
    const setup = await campaignSetup(campaigns.active);
    const readyEngineJobId = `${PREFIX}-result-ready-no-tokenless-claim`;
    const expiredEngineJobId = `${PREFIX}-expired-ingest-recovery`;
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    const [readyJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: campaigns.active,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "submitted",
        engineState: "completed",
        engineJobId: readyEngineJobId,
        submittedAt: old,
        polledAt: old,
        totalCases: 1,
        completedCases: 1,
      })
      .returning();
    const [expiredJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: campaigns.active,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 1,
        status: "ingesting",
        engineState: "missing",
        engineJobId: expiredEngineJobId,
        submittedAt: old,
        polledAt: old,
        totalCases: 1,
        ingestLeaseToken: `${PREFIX}-expired-token`,
        ingestLeaseClaimedAt: old,
        ingestLeaseExpiresAt: new Date(Date.now() - 60_000),
        updatedAt: old,
      })
      .returning();
    const [readyResult] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: 13.271,
        status: "running",
        source: "queued",
        simJobId: readyJob.id,
        engineJobId: readyEngineJobId,
      })
      .returning();
    const [expiredResult] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: 13.272,
        status: "running",
        source: "queued",
        simJobId: expiredJob.id,
        engineJobId: expiredEngineJobId,
      })
      .returning();

    const emptyQueue: EngineQueueState = {
      queue_depth: 0,
      active: [],
      reserved: [],
      scheduled: [],
      active_count: 0,
      reserved_count: 0,
      scheduled_count: 0,
      job_ids: [],
      duplicates: {},
      redelivered: [],
    };
    const readyRuntime: JobRuntimeSummary = {
      job_id: readyEngineJobId,
      exists: true,
      cancelled: false,
      process_count: 0,
      status_readable: true,
      status_state: "completed",
      result_readable: true,
      has_result: true,
      result_state: "completed",
    };
    const queueSpy = vi
      .spyOn(EngineClient.prototype, "getQueue")
      .mockResolvedValue(emptyQueue);
    const runtimeSpy = vi
      .spyOn(EngineClient.prototype, "getJobRuntimes")
      .mockResolvedValue({ jobs: [readyRuntime] });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/jobs/recover-stale",
        payload: {
          olderThanMinutes: 30,
          jobIds: [readyJob.id, expiredJob.id],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        recovered: 2,
        requeued: 1,
        requeuedResults: 1,
        ingestReady: 1,
        markedIngesting: 0,
      });
    } finally {
      queueSpy.mockRestore();
      runtimeSpy.mockRestore();
    }

    const [readyAfter] = await db
      .select({
        status: simJobs.status,
        engineState: simJobs.engineState,
        ingestLeaseToken: simJobs.ingestLeaseToken,
        ingestLeaseExpiresAt: simJobs.ingestLeaseExpiresAt,
      })
      .from(simJobs)
      .where(eq(simJobs.id, readyJob.id));
    const [readyResultAfter] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, readyResult.id));
    expect(readyAfter).toEqual({
      status: "submitted",
      engineState: "completed",
      ingestLeaseToken: null,
      ingestLeaseExpiresAt: null,
    });
    expect(readyResultAfter).toEqual({
      status: "running",
      simJobId: readyJob.id,
    });

    const [expiredAfter] = await db
      .select({
        status: simJobs.status,
        engineState: simJobs.engineState,
        ingestLeaseToken: simJobs.ingestLeaseToken,
        ingestLeaseClaimedAt: simJobs.ingestLeaseClaimedAt,
        ingestLeaseExpiresAt: simJobs.ingestLeaseExpiresAt,
      })
      .from(simJobs)
      .where(eq(simJobs.id, expiredJob.id));
    const [expiredResultAfter] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, expiredResult.id));
    expect(expiredAfter).toEqual({
      status: "cancelled",
      engineState: "missing",
      ingestLeaseToken: null,
      ingestLeaseClaimedAt: null,
      ingestLeaseExpiresAt: null,
    });
    expect(expiredResultAfter).toEqual({ status: "pending", simJobId: null });
  });

  it("returns 409 and preserves a job that already completed", async () => {
    const setup = await campaignSetup(campaigns.active);
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: campaigns.active,
        jobKind: "targeted",
        referenceChordM: CHORD,
        status: "done",
        totalCases: 1,
        completedCases: 1,
        finishedAt: new Date(),
      })
      .returning();

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/jobs/${job.id}/cancel`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "job_not_active",
      status: "done",
    });
    const [after] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(after.status).toBe("done");
  });

  it("atomically cancels an active job and releases only its open result claims", async () => {
    const setup = await campaignSetup(campaigns.active);
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: campaigns.active,
        jobKind: "targeted",
        referenceChordM: CHORD,
        status: "submitted",
        totalCases: 1,
      })
      .returning();
    const [claimedResult] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: 9,
        status: "queued",
        source: "queued",
        simJobId: job.id,
      })
      .returning();

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/jobs/${job.id}/cancel`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      cancelled: true,
      engineCancelled: false,
      engineCancelError: null,
    });
    const [afterJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(afterJob.status).toBe("cancelled");
    const [afterResult] = await db
      .select()
      .from(results)
      .where(
        and(eq(results.id, claimedResult.id), eq(results.airfoilId, airfoilId)),
      );
    expect(afterResult).toMatchObject({
      status: "pending",
      simJobId: null,
      engineJobId: null,
      engineCaseSlug: null,
    });
  });

  it("recover-stale releases an accepted physical PRECALC attempt and its request for retry", async () => {
    const setup = await campaignSetup(campaigns.active);
    const engineJobId = `${PREFIX}-recover-wave2`;
    const aoa = 12.371;
    const [ladderRequest] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg: aoa,
        fidelity: "precalc",
        state: "running",
        requestedBy: `${PREFIX}-recover-precalc`,
        backgroundOwner: true,
      })
      .returning();
    const [obligation] = await ensurePrecalcObligations(
      db,
      [{ airfoilId, revisionId: setup.revisionId, aoaDeg: aoa }],
      { campaignIds: [campaigns.active], requestIds: [ladderRequest.id] },
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
        status: "running",
        engineState: "missing",
        engineJobId,
        submittedAt: new Date(Date.now() - 2 * 60 * 60_000),
        polledAt: new Date(Date.now() - 2 * 60 * 60_000),
        totalCases: 1,
        requestPayload: {
          aoas: [aoa],
          uransFidelity: "precalc",
          uransRequestId: ladderRequest.id,
          precalcObligationIds: [obligation.id],
        },
      })
      .returning();
    await db
      .update(simPrecalcObligations)
      .set({ latestSimJobId: job.id })
      .where(eq(simPrecalcObligations.id, obligation.id));
    await db
      .update(simUransRequests)
      .set({ simJobId: job.id })
      .where(eq(simUransRequests.id, ladderRequest.id));
    await recordPrecalcObligationSubmission(db, job.id, [obligation.id]);
    const [claimed] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: aoa,
        status: "running",
        source: "queued",
        regime: "rans",
        fidelity: "rans",
        simJobId: job.id,
        engineJobId,
        converged: false,
        stalled: true,
        error: "RANS did not converge; precalc still owed",
      })
      .returning();
    await db.insert(resultClassifications).values({
      resultId: claimed.id,
      airfoilId,
      simulationPresetRevisionId: setup.revisionId,
      aoaDeg: aoa,
      regime: "rans",
      classifierVersion: "api-recover-wave2-v1",
      state: "rejected",
      reasons: ["RANS did not converge"],
    });

    const emptyQueue: EngineQueueState = {
      queue_depth: 0,
      active: [],
      reserved: [],
      scheduled: [],
      active_count: 0,
      reserved_count: 0,
      scheduled_count: 0,
      job_ids: [],
      duplicates: {},
      redelivered: [],
    };
    const queueSpy = vi
      .spyOn(EngineClient.prototype, "getQueue")
      .mockResolvedValue(emptyQueue);
    const runtimeSpy = vi
      .spyOn(EngineClient.prototype, "getJobRuntimes")
      .mockResolvedValue({ jobs: [] });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/jobs/recover-stale",
        payload: { olderThanMinutes: 30, jobIds: [job.id] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        recovered: 1,
        requeued: 1,
        requeuedResults: 1,
      });
    } finally {
      queueSpy.mockRestore();
      runtimeSpy.mockRestore();
    }

    const [afterJob] = await db
      .select({ status: simJobs.status, engineState: simJobs.engineState })
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    const [afterResult] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, claimed.id));
    expect(afterJob).toEqual({ status: "cancelled", engineState: "missing" });
    expect(afterResult).toEqual({ status: "queued", simJobId: null });
    const [afterObligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, obligation.id));
    const [afterAttempt] = await db
      .select()
      .from(simPrecalcObligationAttempts)
      .where(eq(simPrecalcObligationAttempts.obligationId, obligation.id));
    const [afterRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, ladderRequest.id));
    expect(afterObligation).toMatchObject({
      state: "pending",
      attemptCount: 1,
      lastOutcome: "failed",
    });
    expect(afterAttempt).toMatchObject({ state: "failed", outcome: "failed" });
    expect(afterRequest).toMatchObject({ state: "pending", simJobId: null });
  });

  it("cancels a durable pending composition and releases its claims without an engine call", async () => {
    const setup = await campaignSetup(campaigns.active);
    const [ladderRequest] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg: 10,
        fidelity: "precalc",
        state: "running",
        requestedBy: `${PREFIX}-admin-cancel`,
      })
      .returning();
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: campaigns.active,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "pending",
        totalCases: 1,
        requestPayload: {
          uransRequestId: ladderRequest.id,
          uransFidelity: "precalc",
          aoas: [10],
        },
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({ simJobId: job.id })
      .where(eq(simUransRequests.id, ladderRequest.id));
    const [claimedResult] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: 10,
        status: "queued",
        source: "queued",
        simJobId: job.id,
      })
      .returning();

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/jobs/${job.id}/cancel`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      cancelled: true,
      engineCancelled: false,
      engineCancelError: null,
    });
    const [afterJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(afterJob).toMatchObject({ status: "cancelled", engineJobId: null });
    const [afterResult] = await db
      .select()
      .from(results)
      .where(eq(results.id, claimedResult.id));
    expect(afterResult).toMatchObject({ status: "pending", simJobId: null });
    const [afterRequest] = await db
      .select({
        state: simUransRequests.state,
        simJobId: simUransRequests.simJobId,
      })
      .from(simUransRequests)
      .where(eq(simUransRequests.id, ladderRequest.id));
    expect(afterRequest).toEqual({ state: "cancelled", simJobId: job.id });
  });

  it("settles accepted PRECALC admin cancellation against the exact surviving owners", async () => {
    const setup = await campaignSetup(campaigns.active);
    const runCase = async (aoaDeg: number, campaignSurvives: boolean) => {
      const [request] = await db
        .insert(simUransRequests)
        .values({
          airfoilId,
          revisionId: setup.revisionId,
          aoaDeg,
          fidelity: "precalc",
          state: "running",
          requestedBy: `${PREFIX}-accepted-admin-cancel-${aoaDeg}`,
          backgroundOwner: true,
        })
        .returning();
      const [obligation] = await ensurePrecalcObligations(
        db,
        [{ airfoilId, revisionId: setup.revisionId, aoaDeg }],
        {
          requestIds: [request.id],
          campaignIds: campaignSurvives ? [campaigns.active] : [],
        },
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
          status: "submitted",
          submittedAt: new Date(),
          totalCases: 1,
          requestPayload: {
            aoas: [aoaDeg],
            uransFidelity: "precalc",
            uransRequestId: request.id,
            precalcObligationIds: [obligation.id],
          },
        })
        .returning();
      await db
        .update(simPrecalcObligations)
        .set({ latestSimJobId: job.id })
        .where(eq(simPrecalcObligations.id, obligation.id));
      await db
        .update(simUransRequests)
        .set({ simJobId: job.id })
        .where(eq(simUransRequests.id, request.id));
      await recordPrecalcObligationSubmission(db, job.id, [obligation.id]);

      const response = await app.inject({
        method: "POST",
        url: `/api/admin/jobs/${job.id}/cancel`,
      });
      expect(response.statusCode).toBe(200);
      const [afterRequest] = await db
        .select()
        .from(simUransRequests)
        .where(eq(simUransRequests.id, request.id));
      const [afterObligation] = await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation.id));
      const [afterAttempt] = await db
        .select()
        .from(simPrecalcObligationAttempts)
        .where(eq(simPrecalcObligationAttempts.obligationId, obligation.id));
      expect(afterRequest.state).toBe("cancelled");
      expect(afterObligation).toMatchObject({
        state: campaignSurvives ? "pending" : "cancelled",
        attemptCount: 1,
        lastOutcome: campaignSurvives ? "cancelled" : "ownerless",
      });
      expect(afterAttempt).toMatchObject({
        state: "cancelled",
        outcome: campaignSurvives ? "cancelled" : "ownerless",
      });
    };

    await runCase(40.101, false);
    await runCase(40.102, true);
  });

  it("rejects cancellation after ingestion owns the job and preserves its claims", async () => {
    const setup = await campaignSetup(campaigns.active);
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [setup.bcId],
        simulationPresetRevisionId: setup.revisionId,
        campaignId: campaigns.active,
        jobKind: "targeted",
        referenceChordM: CHORD,
        status: "ingesting",
        engineJobId: `${PREFIX}-ingest-owned-engine`,
        totalCases: 1,
      })
      .returning();
    const [claimedResult] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: 11,
        status: "running",
        source: "queued",
        simJobId: job.id,
        engineJobId: `${PREFIX}-ingest-owned-engine`,
      })
      .returning();

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/jobs/${job.id}/cancel`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "job_not_active",
      status: "ingesting",
    });
    const [afterJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(afterJob.status).toBe("ingesting");
    const [afterResult] = await db
      .select()
      .from(results)
      .where(eq(results.id, claimedResult.id));
    expect(afterResult).toMatchObject({ status: "running", simJobId: job.id });
  });
});
