// Production-shaped regression for the deterministic precalc mesh-QA loop
// observed in campaign b96594a6: the same immutable revision/mesh failed
// checkMesh at max non-orthogonality 88.2/88.3 degrees, yet the generic
// crash auto-retry path requeued it unchanged. A deterministic mesh blocker
// must stay terminal with its evidence; a genuine transient crash in the
// same job must still receive the normal one automatic retry.

import {
  airfoils,
  autoRetryCrashedResultsForJob,
  boundaryProfiles,
  campaignHasOpenRansGaps,
  campaignProgressTotals,
  campaignReviewBuckets,
  categories,
  createClient,
  ensurePrecalcObligations,
  findCampaignGapBatch,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  outputProfiles,
  pointHistoryPage,
  resultClassifications,
  resultAttempts,
  recordPrecalcObligationSubmission,
  results,
  simCampaignPoints,
  simCampaigns,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligationCampaigns,
  simPrecalcObligations,
  solverProfiles,
  settlePrecalcObligationsForJob,
  sweeperState,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import type {
  EngineClient,
  JobResult,
  JobStatus,
  PolarPoint,
  PolarRequest,
} from "@aerodb/engine-client";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ConditionMapEntry } from "../src/ingest";
import { submitCampaignBatch } from "../src/loop";
import { reconcile } from "../src/reconcile";
import { resetUransLadderMemory, uransLadderTick } from "../src/urans-ladder";
import { withExactManifestEvidence } from "./exact-result-fixture";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-autoretry-mesh-${process.pid}-${Date.now().toString(36)}`;
const ANGLES = [15, 20, 25];
// File-unique physical values prevent canonical registry dedupe from coupling
// this campaign fixture to a concurrently running suite.
const CHORD = 0.271937;
const SPEED = 12.345;
const NU = 1.789e-5 / 1.225;
const MESH_QA_ERROR =
  "OpenFOAMError: mesh degenerate at this fidelity tier (max non-orthogonality 88.3 deg): checkMesh max non-orthogonality exceeds 85.0 deg; see log.checkMesh";
const TRANSIENT_CRASH =
  "OpenFOAMError: transient diverged at t=1e-05: |Cl|=7.07e4, dt=1e-07";

let campaignId = "";
let airfoilId = "";
let categoryId = "";
let mediumId = "";
let revisionId = "";
let bcId = "";
let parentJobId = "";
let childJobId = "";
const profileIds = { boundary: "", mesh: "", solver: "", output: "" };
let restoreSweeperEnabled: boolean | null = null;

const camberedPoints = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

function failedPoint(aoa: number, error: string): PolarPoint {
  return {
    aoa_deg: aoa,
    // A mesh-QA failure occurs before pimpleFoam and therefore echoes the
    // RANS-shaped defaults seen in production. The sibling is a real URANS
    // transient crash; the retry discriminator must use job/setup provenance
    // plus the exact QA class, not the point's fidelity echo alone.
    unsteady: aoa === 20,
    converged: false,
    first_order_fallback: false,
    fidelity: aoa === 20 ? "urans_precalc" : "rans",
    error,
    images: {},
  } as unknown as PolarPoint;
}

function completedRejectedPoint(): PolarPoint {
  return {
    aoa_deg: 25,
    cl: 0.91,
    cd: 0.12,
    cm: -0.07,
    cl_cd: 7.58,
    unsteady: true,
    converged: true,
    first_order_fallback: false,
    fidelity: "urans_precalc",
    // Deliberately no frame track, force-history window, or stored video: the
    // raw solve completed, but the evidence classifier must reject it.
    images: {},
  } as unknown as PolarPoint;
}

function runningPartialPrecalcEngine(engineJobId: string): EngineClient {
  const points = [
    failedPoint(15, MESH_QA_ERROR),
    failedPoint(20, TRANSIENT_CRASH),
    completedRejectedPoint(),
  ];
  return {
    getQueue: async () => {
      throw new Error("queue unavailable in test");
    },
    getJob: async (): Promise<JobStatus> => ({
      job_id: engineJobId,
      state: "running",
      total_cases: points.length,
      completed_cases: points.length,
      message: "partial evidence published before cancellation",
    }),
    getResult: async (): Promise<JobResult> =>
      withExactManifestEvidence({
        job_id: engineJobId,
        state: "running",
        message: "partial evidence published before cancellation",
        polars: [
          {
            speed: SPEED,
            chord: CHORD,
            reynolds: Math.round((SPEED * CHORD) / NU),
            mach: SPEED / 340.3,
            points,
          },
        ],
      }),
  } as unknown as EngineClient;
}

async function rows() {
  return db
    .select({
      id: results.id,
      aoaDeg: results.aoaDeg,
      status: results.status,
      simJobId: results.simJobId,
      autoRetriedAt: results.autoRetriedAt,
      error: results.error,
    })
    .from(results)
    .where(
      and(
        eq(results.airfoilId, airfoilId),
        eq(results.simulationPresetRevisionId, revisionId),
      ),
    )
    .orderBy(asc(results.aoaDeg));
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
    .onConflictDoUpdate({
      target: sweeperState.id,
      set: { enabled: false },
    });

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
      slug: `${PREFIX}-cambered`,
      name: `${PREFIX} cambered`,
      categoryId,
      points: camberedPoints,
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
      kinematicViscosity: NU,
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

  const launch = await materializeCampaignLaunch(db, {
    name: `${PREFIX} deterministic mesh retry campaign`,
    priority: 8,
    idempotencyKey: `${PREFIX}-key`,
    airfoilIds: [airfoilId],
    plan: {
      mediumId,
      ambients: [[288.15, 101325]],
      speedsMps: [SPEED],
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
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await cleanupCampaignFixtures(db, {
    campaignIds: [campaignId].filter(Boolean),
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

describe("deterministic precalc mesh-QA auto-retry suppression", () => {
  it("MUST-CATCH: blocks deterministic and completed-rejected evidence while one transient crash retries once", async () => {
    const batch = await findCampaignGapBatch(db, {
      limit: 500,
      campaignIds: [campaignId],
    });
    expect(batch).not.toBeNull();
    const composeEngine = {
      submitPolar: async (request: PolarRequest): Promise<JobStatus> => ({
        job_id: `${PREFIX}-engine-w1`,
        state: "pending",
        total_cases: request.aoa?.angles?.length ?? ANGLES.length,
        completed_cases: 0,
      }),
    } as unknown as EngineClient;
    expect(await submitCampaignBatch(db, composeEngine, batch!, 0, 0)).toBe(
      true,
    );
    const [parent] = await db
      .select()
      .from(simJobs)
      .where(
        and(
          eq(simJobs.campaignId, campaignId),
          eq(simJobs.engineJobId, `${PREFIX}-engine-w1`),
        ),
      );
    parentJobId = parent.id;
    const entries = ((
      parent.requestPayload as {
        conditionMap?: ConditionMapEntry[];
      }
    )?.conditionMap ?? []) as ConditionMapEntry[];
    expect(entries).toHaveLength(1);
    revisionId = entries[0].revisionId;
    bcId = entries[0].bcId;
    // The wave-1 parent has the real rejected RANS evidence that originally
    // obligated the campaign to create this precalc child. Without this row a
    // replay probe has an empty retry plan and can pass for the wrong reason.
    const ransAttempts = await db
      .insert(resultAttempts)
      .values(
        ANGLES.map((aoaDeg) => ({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg,
          simJobId: parentJobId,
          engineJobId: `${PREFIX}-engine-w1`,
          status: "failed" as const,
          source: "queued" as const,
          regime: "rans" as const,
          validForPolar: false,
          converged: false,
          stalled: true,
          unsteady: false,
          error: "RANS did not converge; precalc escalation required",
          solvedAt: new Date(),
        })),
      )
      .returning({ id: resultAttempts.id, aoaDeg: resultAttempts.aoaDeg });
    const attemptByAoa = new Map(
      ransAttempts.map((attempt) => [attempt.aoaDeg, attempt.id]),
    );
    // The accepted engine response has already made the wave-1 claims
    // terminal before physical PRECALC obligations are routed. A still-
    // queued canonical cell is intentionally owned by the ordinary scheduler
    // and ensurePrecalcObligations must not create a second owner behind it.
    await db
      .update(results)
      .set({
        status: "failed",
        source: "queued",
        regime: "rans",
        fidelity: "rans",
        simJobId: parentJobId,
        engineJobId: `${PREFIX}-engine-w1`,
        converged: false,
        stalled: true,
        error: "RANS did not converge; precalc escalation required",
      })
      .where(eq(results.simJobId, parentJobId));
    expect(
      (await rows()).every(
        (row) => row.status === "failed" && row.simJobId === parentJobId,
      ),
    ).toBe(true);
    const obligations = await ensurePrecalcObligations(
      db,
      ANGLES.map((aoaDeg) => ({
        airfoilId,
        revisionId,
        aoaDeg,
        sourceResultAttemptId: attemptByAoa.get(aoaDeg),
      })),
      { campaignIds: [campaignId] },
    );
    expect(obligations).toHaveLength(ANGLES.length);
    const obligationIds = obligations.map((obligation) => obligation.id);

    const [child] = await db
      .insert(simJobs)
      .values({
        parentJobId,
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        // Physical preliminary work is campaign-neutral. The M:N owner rows
        // below authorize it for this campaign.
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "submitted",
        engineJobId: `${PREFIX}-engine-w2`,
        submittedAt: new Date(),
        totalCases: ANGLES.length,
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
          parentJobId,
          conditionId: entries[0].conditionId,
          precalcObligationIds: obligationIds,
          uransFidelity: "precalc",
        },
      })
      .returning();
    childJobId = child.id;
    await db
      .update(simPrecalcObligations)
      .set({ latestSimJobId: childJobId, lastOutcome: "composed" })
      .where(inArray(simPrecalcObligations.id, obligationIds));
    await recordPrecalcObligationSubmission(db, childJobId, obligationIds);
    await db
      .update(simJobs)
      .set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() })
      .where(eq(simJobs.id, parentJobId));

    expect(child.campaignId).toBeNull();
    expect(
      await db
        .select({
          obligationId: simPrecalcObligationCampaigns.obligationId,
          campaignId: simPrecalcObligationCampaigns.campaignId,
          state: simPrecalcObligationCampaigns.state,
        })
        .from(simPrecalcObligationCampaigns)
        .where(
          inArray(simPrecalcObligationCampaigns.obligationId, obligationIds),
        )
        .orderBy(asc(simPrecalcObligationCampaigns.obligationId)),
    ).toEqual(
      [...obligationIds].sort().map((obligationId) => ({
        obligationId,
        campaignId,
        state: "active",
      })),
    );

    const errSpy = vi.spyOn(console, "error");
    // Two failed cases plus one completed-but-classifier-rejected case are
    // published incrementally while the child is still running. The operator
    // then cancels it: this is the production-shaped partial-ingest → cancel
    // → process-restart boundary.
    await reconcile(db, runningPartialPrecalcEngine(`${PREFIX}-engine-w2`), {
      jobIds: [childJobId],
      skipFailedRecovery: true,
    });

    const resultRows = await rows();
    expect(resultRows).toHaveLength(3);
    const meshBlocked = resultRows.find((row) => row.aoaDeg === 15)!;
    expect(meshBlocked.status).toBe("failed");
    expect(meshBlocked.simJobId).toBe(childJobId);
    expect(meshBlocked.autoRetriedAt).toBeNull();
    expect(meshBlocked.error).toBe(MESH_QA_ERROR);

    const transientCrash = resultRows.find((row) => row.aoaDeg === 20)!;
    expect(transientCrash.status).toBe("failed");
    expect(transientCrash.simJobId).toBe(childJobId);
    expect(transientCrash.autoRetriedAt).toBeNull();
    expect(transientCrash.error).toBe(TRANSIENT_CRASH);

    const completedRejected = resultRows.find((row) => row.aoaDeg === 25)!;
    expect(completedRejected.status).toBe("failed");
    expect(completedRejected.simJobId).toBe(childJobId);
    expect(completedRejected.autoRetriedAt).toBeNull();
    expect(completedRejected.error).toContain("solver evidence rejected:");

    const points = await db
      .select({
        aoaDeg: simCampaignPoints.aoaDeg,
        state: simCampaignPoints.state,
      })
      .from(simCampaignPoints)
      .where(eq(simCampaignPoints.campaignId, campaignId))
      .orderBy(asc(simCampaignPoints.aoaDeg));
    expect(points.find((point) => point.aoaDeg === 15)?.state).toBe("terminal");
    expect(points.find((point) => point.aoaDeg === 20)?.state).toBe("terminal");
    expect(points.find((point) => point.aoaDeg === 25)?.state).toBe("terminal");

    const totals = await campaignProgressTotals(db, campaignId);
    // Physical PRECALC obligations own these machine outcomes, so the active
    // campaign does not surface them as user-review failures.
    expect(totals.failed).toBe(0);
    const buckets = await campaignReviewBuckets(db, campaignId);
    // Deterministic setup blockers stay failed/visible, but no human review
    // can change this verdict; repair requires a different mesh route.
    expect(buckets.needsReview).toBe(0);
    expect(buckets.awaitingUrans).toBe(0);

    // The duplicated Points read-model predicate must agree with the campaign
    // chip: the blocker is still discoverable under Failed/All, but clicking
    // Needs review cannot open a row the chip deliberately excluded.
    const reviewPage = await pointHistoryPage(
      db,
      { campaignId, bucket: "needs_review" },
      { limit: 50 },
    );
    expect(
      reviewPage.items.some((item) => item.resultId === meshBlocked.id),
    ).toBe(false);
    expect(reviewPage.counts.needs_review).toBe(0);
    const failedPage = await pointHistoryPage(
      db,
      { campaignId, bucket: "failed" },
      { limit: 50 },
    );
    expect(
      failedPage.items.find((item) => item.resultId === meshBlocked.id),
    ).toMatchObject({
      bucket: "failed",
      reviewBucket: null,
    });
    expect(failedPage.counts.failed).toBe(3);

    const attempts = await db
      .select({
        aoaDeg: resultAttempts.aoaDeg,
        status: resultAttempts.status,
        regime: resultAttempts.regime,
        evidencePayload: resultAttempts.evidencePayload,
        error: resultAttempts.error,
        classification: resultClassifications.state,
      })
      .from(resultAttempts)
      .leftJoin(
        resultClassifications,
        eq(resultClassifications.resultAttemptId, resultAttempts.id),
      )
      .where(eq(resultAttempts.simJobId, childJobId))
      .orderBy(asc(resultAttempts.aoaDeg));
    expect(attempts).toHaveLength(3);
    expect(attempts.find((attempt) => attempt.aoaDeg === 15)).toMatchObject({
      status: "failed",
      regime: "rans",
      error: MESH_QA_ERROR,
    });
    expect(
      (
        attempts.find((attempt) => attempt.aoaDeg === 15)?.evidencePayload as {
          fidelity?: string;
        }
      )?.fidelity,
    ).toBe("rans");
    expect(attempts.find((attempt) => attempt.aoaDeg === 20)).toMatchObject({
      status: "failed",
      error: TRANSIENT_CRASH,
    });
    // Negative retry guard: classification rejection on a raw status-done
    // solve is physical/evidence judgment, not an execution crash.
    expect(attempts.find((attempt) => attempt.aoaDeg === 25)).toMatchObject({
      status: "done",
      error: null,
      classification: "rejected",
    });

    const retryProbe = await autoRetryCrashedResultsForJob(db, childJobId);
    expect(retryProbe.retried).toEqual([]);
    expect(retryProbe.precalcRouted).toEqual([]);
    expect(retryProbe.escalated).toEqual([]);
    expect(retryProbe.suppressed.map((cell) => cell.aoaDeg)).toEqual([15]);

    const nextBatch = await findCampaignGapBatch(db, {
      limit: 500,
      campaignIds: [campaignId],
    });
    // A routed precalc retry is never visible to the wave-1/RANS gap finder.
    expect(nextBatch).toBeNull();
    expect(
      errSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          "AUTO-RETRY SUPPRESSED: deterministic mesh QA",
        ),
      ),
    ).toBe(true);
    expect(
      errSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          "AUTO-RETRY: precalc crash routed ONCE to the wave-2 ladder",
        ),
      ),
    ).toBe(false);

    // Cancellation after partial ingest retains both immutable result
    // attempts. Settle the accepted engine submission into the 0047 physical
    // ledger: angle 15 blocks deterministically, while angle 20 is the only
    // obligation eligible for its second and final PRECALC submission.
    const [cancelledChild] = await db
      .update(simJobs)
      .set({
        status: "cancelled",
        engineState: "cancelled",
        error: "operator cancelled after partial evidence",
        finishedAt: new Date(),
      })
      .where(eq(simJobs.id, childJobId))
      .returning();
    await settlePrecalcObligationsForJob(db, cancelledChild, {
      terminalError: "operator cancelled after partial evidence",
    });
    const settled = await db
      .select()
      .from(simPrecalcObligations)
      .where(inArray(simPrecalcObligations.id, obligationIds))
      .orderBy(asc(simPrecalcObligations.aoaDeg));
    expect(settled[0]).toMatchObject({
      aoaDeg: 15,
      state: "blocked",
      attemptCount: 1,
      latestSimJobId: childJobId,
      lastOutcome: "deterministic_failure",
      lastError: MESH_QA_ERROR,
    });
    expect(settled[1]).toMatchObject({
      aoaDeg: 20,
      state: "pending",
      attemptCount: 1,
      latestSimJobId: childJobId,
      lastOutcome: "failed",
      lastError: TRANSIENT_CRASH,
    });
    expect(settled[2]).toMatchObject({
      aoaDeg: 25,
      state: "blocked",
      attemptCount: 1,
      latestSimJobId: childJobId,
      lastOutcome: "rejected_exhausted",
      lastError: "operator cancelled after partial evidence",
    });
    const firstLedger = await db
      .select({
        obligationId: simPrecalcObligationAttempts.obligationId,
        simJobId: simPrecalcObligationAttempts.simJobId,
        attemptNumber: simPrecalcObligationAttempts.attemptNumber,
        state: simPrecalcObligationAttempts.state,
        outcome: simPrecalcObligationAttempts.outcome,
      })
      .from(simPrecalcObligationAttempts)
      .where(inArray(simPrecalcObligationAttempts.obligationId, obligationIds));
    expect(firstLedger).toHaveLength(3);
    expect(
      firstLedger.find((attempt) => attempt.obligationId === settled[0].id),
    ).toMatchObject({
      simJobId: childJobId,
      attemptNumber: 1,
      state: "failed",
      outcome: "deterministic_failure",
    });
    expect(
      firstLedger.find((attempt) => attempt.obligationId === settled[1].id),
    ).toMatchObject({
      simJobId: childJobId,
      attemptNumber: 1,
      state: "failed",
      outcome: "failed",
    });
    expect(
      firstLedger.find((attempt) => attempt.obligationId === settled[2].id),
    ).toMatchObject({
      simJobId: childJobId,
      attemptNumber: 1,
      state: "rejected",
      outcome: "rejected_exhausted",
    });

    // The canonical failed PRECALC evidence stays on the producing child;
    // retry ownership never masquerades as a queued result row.
    const afterSettlementRows = await rows();
    expect(afterSettlementRows.find((row) => row.aoaDeg === 15)).toMatchObject({
      status: "failed",
      simJobId: childJobId,
    });
    expect(afterSettlementRows.find((row) => row.aoaDeg === 20)).toMatchObject({
      status: "failed",
      simJobId: childJobId,
    });
    expect(afterSettlementRows.find((row) => row.aoaDeg === 25)).toMatchObject({
      status: "failed",
      simJobId: childJobId,
    });
    expect(await campaignReviewBuckets(db, campaignId)).toEqual({
      needsReview: 0,
      awaitingUrans: 0,
    });
    expect(
      await findCampaignGapBatch(db, { limit: 500, campaignIds: [campaignId] }),
    ).toBeNull();

    const childrenBeforeRestart = await db
      .select({ id: simJobs.id })
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parentJobId), eq(simJobs.wave, 2)));
    expect(childrenBeforeRestart).toHaveLength(1);
    resetUransLadderMemory();
    const replayedRequests: PolarRequest[] = [];
    const replayEngine = {
      submitPolar: async (request: PolarRequest): Promise<JobStatus> => {
        replayedRequests.push(request);
        return {
          job_id: `${PREFIX}-transient-precalc-retry`,
          state: "pending",
          total_cases: request.aoa?.angles?.length ?? 0,
          completed_cases: 0,
        };
      },
    } as unknown as EngineClient;
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(false);
    expect(
      await uransLadderTick(db, replayEngine, 0, {
        campaignIds: [campaignId],
        requestIds: [],
      }),
    ).toBe(true);
    expect(replayedRequests).toHaveLength(1);
    expect(replayedRequests[0].aoa?.angles).toEqual([20]);
    expect(replayedRequests[0].solver).toMatchObject({
      transient_fallback: true,
      force_transient: true,
      urans_fidelity: "precalc",
    });

    const childrenAfterRetry = await db
      .select({
        id: simJobs.id,
        campaignId: simJobs.campaignId,
        wave: simJobs.wave,
        status: simJobs.status,
        requestPayload: simJobs.requestPayload,
      })
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parentJobId), eq(simJobs.wave, 2)))
      .orderBy(asc(simJobs.createdAt));
    expect(childrenAfterRetry).toHaveLength(2);
    expect(childrenAfterRetry[1]).toMatchObject({
      campaignId: null,
      wave: 2,
      status: "submitted",
    });
    expect(childrenAfterRetry[1].requestPayload).toMatchObject({
      aoas: [20],
      precalcObligationIds: [settled[1].id],
      uransFidelity: "precalc",
    });
    const [retriedObligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, settled[1].id));
    expect(retriedObligation).toMatchObject({
      state: "running",
      attemptCount: 2,
      latestSimJobId: childrenAfterRetry[1].id,
      lastOutcome: "submitted",
    });
    const retryLedger = await db
      .select({
        simJobId: simPrecalcObligationAttempts.simJobId,
        attemptNumber: simPrecalcObligationAttempts.attemptNumber,
        state: simPrecalcObligationAttempts.state,
      })
      .from(simPrecalcObligationAttempts)
      .where(
        eq(simPrecalcObligationAttempts.obligationId, retriedObligation.id),
      )
      .orderBy(asc(simPrecalcObligationAttempts.attemptNumber));
    expect(retryLedger).toEqual([
      { simJobId: childJobId, attemptNumber: 1, state: "failed" },
      {
        simJobId: childrenAfterRetry[1].id,
        attemptNumber: 2,
        state: "submitted",
      },
    ]);
    const afterRetryRows = await rows();
    expect(afterRetryRows.find((row) => row.aoaDeg === 15)).toMatchObject({
      status: "failed",
      simJobId: childJobId,
      error: MESH_QA_ERROR,
    });
    expect(afterRetryRows.find((row) => row.aoaDeg === 20)).toMatchObject({
      status: "failed",
      simJobId: childJobId,
      error: TRANSIENT_CRASH,
    });

    // A second process restart sees the active wave-2 child and submits
    // nothing. Most importantly, the cancelled child's angle 15 never reappears.
    resetUransLadderMemory();
    expect(
      await uransLadderTick(db, replayEngine, 0, {
        campaignIds: [campaignId],
        requestIds: [],
      }),
    ).toBe(false);
    const childrenAfterRestart = await db
      .select({ id: simJobs.id })
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parentJobId), eq(simJobs.wave, 2)))
      .orderBy(asc(simJobs.createdAt));
    expect(childrenAfterRestart.map((child) => child.id)).toEqual(
      childrenAfterRetry.map((child) => child.id),
    );
    expect(replayedRequests).toHaveLength(1);
  }, 240000);

  it("never satisfies an exact PRECALC obligation from accepted RANS-shaped evidence", async () => {
    const aoaDeg = 30;
    const [obligation] = await ensurePrecalcObligations(
      db,
      [{ airfoilId, revisionId, aoaDeg }],
      { backgroundOwner: true },
    );
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "cancelled",
        engineJobId: `${PREFIX}-accepted-rans-echo`,
        submittedAt: new Date(),
        finishedAt: new Date(),
        totalCases: 1,
        completedCases: 1,
        requestPayload: {
          aoas: [aoaDeg],
          uransFidelity: "precalc",
          precalcObligationIds: [obligation.id],
        },
      })
      .returning();
    let attemptId = "";
    try {
      await db
        .update(simPrecalcObligations)
        .set({ latestSimJobId: job.id, lastOutcome: "composed" })
        .where(eq(simPrecalcObligations.id, obligation.id));
      await recordPrecalcObligationSubmission(db, job.id, [obligation.id]);
      const [attempt] = await db
        .insert(resultAttempts)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg,
          simJobId: job.id,
          engineJobId: job.engineJobId,
          status: "done",
          source: "solved",
          regime: "rans",
          validForPolar: true,
          cl: 0.82,
          cd: 0.08,
          cm: -0.04,
          clCd: 10.25,
          converged: true,
          stalled: false,
          unsteady: false,
          evidencePayload: { fidelity: "rans" },
          solvedAt: new Date(),
        })
        .returning();
      attemptId = attempt.id;
      await db.insert(resultClassifications).values({
        resultAttemptId: attempt.id,
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        regime: "rans",
        classifierVersion: "accepted-rans-fallback-guard-v1",
        state: "accepted",
        region: "attached",
        confidence: 1,
        reasons: [],
      });

      await settlePrecalcObligationsForJob(db, job, {
        terminalError: "precalc job ended without eligible URANS evidence",
      });
      const [settled] = await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation.id));
      expect(settled).toMatchObject({
        state: "pending",
        attemptCount: 1,
        latestSimJobId: job.id,
        lastOutcome: "failed",
        lastError: "precalc job ended without eligible URANS evidence",
      });
      expect(settled.state).not.toBe("satisfied");
      const [ledger] = await db
        .select()
        .from(simPrecalcObligationAttempts)
        .where(eq(simPrecalcObligationAttempts.obligationId, obligation.id));
      expect(ledger).toMatchObject({
        state: "failed",
        outcome: "failed",
        resultAttemptId: null,
      });
      const [retainedClassification] = await db
        .select({ state: resultClassifications.state })
        .from(resultClassifications)
        .where(eq(resultClassifications.resultAttemptId, attempt.id));
      expect(retainedClassification.state).toBe("accepted");
    } finally {
      await db
        .delete(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation.id));
      if (attemptId) {
        await db.delete(resultAttempts).where(eq(resultAttempts.id, attemptId));
      }
      await db.delete(simJobs).where(eq(simJobs.id, job.id));
    }
  }, 60000);
});
