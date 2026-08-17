// MUST-CATCH suite for the clean-restart ROUTE GAP (live incident
// 2026-07-08, prod campaign 495d78e0, s1223 −5° @ 100 m/s / 1.0 m): the
// divergence watchdog kills a case at t≈1e-05 and the engine's marched path
// ships the failed point in the RUNNING partial result while sibling angles
// keep marching — so the point terminalized as a machine failure through
// ingestRunningPartialJob, a route that had NO auto-retry hook, and sat with
// auto_retried_at NULL and zero log lines for the rest of the job.
//
// Shapes pinned here (all driven through the same reconcile() surface
// production runs):
//   1. PRECALC WAVE-2 CHILD ships a diverged failed point in a RUNNING
//      partial → the clean-restart route fires immediately (queued-without-owner +
//      marker + campaign point requested + loud log), while the wave-1 gap
//      finder deliberately does NOT pick it.
//   2. The SAME job's terminal failed ingest re-ships the identical failed
//      case → the released-cell guard keeps the released row untouched (no
//      stale failed evidence) while the job's other still-claimed rows get
//      their own clean restart.
//   3. SECOND crash through the same running-partial path → same clean
//      restart, without a fixed cap or human-review chore.
//   4. BATCHED-PARTIAL shape: one crashed point inside an otherwise-COMPLETED
//      multi-point campaign job → same clean restart (regression pin for
//      the ingestCompletedJob hook).
//
// Live shared-DB pattern (auto-retry.test.ts harness): scoped rows,
// file-unique chord, shared guarded cleanup.

import "./enabled-engine-pool-fixture";

import {
  airfoils,
  boundaryProfiles,
  campaignProgressTotals,
  campaignReviewBuckets,
  categories,
  createClient,
  findCampaignGapBatch,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  outputProfiles,
  resultAttempts,
  results,
  solverEvidenceArtifacts,
  simCampaignPoints,
  simJobs,
  solverProfiles,
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
import { and, asc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
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
import { ingestResult } from "../src/ingest";
import { submitCampaignBatch } from "../src/loop";
import { reconcile } from "../src/reconcile";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-autoretry-partial-${process.pid}-${Date.now().toString(36)}`;

const ANGLES = [-5, 0, 5];
// File-unique chord (F9 rule): reference_geometry_profiles dedupe on canonical
// physical keys — no other campaign-launching suite may share this chord.
const CHORD = 0.21;
const SPEED_A = 9.5;
const SPEED_B = 11;
const NU = 1.789e-5 / 1.225;
const DIVERGENCE_MESSAGE =
  "transient diverged at t=1e-05: |Cl|=7.07e4, dt=1e-07";
const CRASH_MESSAGE = "All cases failed";

let campaignAId = "";
let campaignBId = "";
let airfoilId = "";
let airfoil2Id = "";
let categoryId = "";
let mediumId = "";
let revisionAId = "";
let bcAId = "";
let wave1JobId = "";
let childJobId = "";
let child2JobId = "";
let firstMarker: Date | null = null;
const deletedEngineJobIds: string[] = [];
const profileIds = { boundary: "", mesh: "", solver: "", output: "" };
let restoreSweeperState:
  | {
      enabled: boolean;
      maxConcurrentJobs: number;
      cpuSlots: number;
      admissionFenceActive: boolean;
      lastAdmissionFenceAt: Date | null;
      lastAdmissionFenceReason: string | null;
      lastAdmissionFenceTriggerKey: string | null;
      lastAdmissionFenceDetails: Record<string, unknown> | null;
      maintenanceDrainToken: string | null;
      maintenanceDrainStartedAt: Date | null;
    }
  | undefined;

const camberedPoints = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

function divergedPrecalcPoint(aoa: number): PolarPoint {
  // The incident's exact point shape: URANS precalc case condemned by the
  // divergence watchdog — error set, no coefficients, no frame track.
  return {
    aoa_deg: aoa,
    unsteady: true,
    converged: false,
    first_order_fallback: false,
    error: DIVERGENCE_MESSAGE,
    fidelity: "urans_precalc",
    images: {},
  } as unknown as PolarPoint;
}

function solvedRansPoint(aoa: number): PolarPoint {
  return {
    aoa_deg: aoa,
    unsteady: false,
    converged: true,
    first_order_fallback: false,
    cl: 0.2 + aoa * 0.05,
    cd: 0.012,
    cm: -0.04,
    cl_cd: (0.2 + aoa * 0.05) / 0.012,
    images: {},
  } as unknown as PolarPoint;
}

function withExactManifest(engineJobId: string, point: PolarPoint): PolarPoint {
  const caseSlug = `aoa_${String(point.aoa_deg).replace("-", "m")}`;
  return {
    ...point,
    case_slug: caseSlug,
    evidence_artifacts: [
      ...(point.evidence_artifacts ?? []),
      {
        kind: "manifest",
        path: `/jobs/${engineJobId}/files/evidence/${caseSlug}/evidence_manifest.json`,
        url: `/jobs/${engineJobId}/files/evidence/${caseSlug}/evidence_manifest.json`,
        mime_type: "application/json",
        sha256: createHash("sha256")
          .update(`${PREFIX}:${engineJobId}:${caseSlug}:manifest`)
          .digest("hex"),
        byte_size: 512,
        metadata: { evidenceBase: `evidence/${caseSlug}` },
      },
    ],
  } as PolarPoint;
}

function reynoldsOf(speed: number): number {
  return Math.round((speed * CHORD) / NU);
}

/** Engine mid-run: the diverged case already sits in the RUNNING partial
 *  result (jobs.py record_outcome → write_partial_result_locked) while the
 *  remaining angles keep marching. */
function runningPartialEngine(
  engineJobId: string,
  speed: number,
  points: PolarPoint[],
  totalCases: number,
): EngineClient {
  return {
    getQueue: async () => {
      throw new Error("queue unavailable in test");
    },
    getJob: async (): Promise<JobStatus> => ({
      job_id: engineJobId,
      state: "running",
      total_cases: totalCases,
      completed_cases: points.length,
      message: "URANS solving polar",
    }),
    getResult: async (): Promise<JobResult> => ({
      job_id: engineJobId,
      state: "running",
      polars: [
        {
          speed,
          chord: CHORD,
          reynolds: reynoldsOf(speed),
          mach: speed / 340.3,
          points: points.map((point) => withExactManifest(engineJobId, point)),
        },
      ],
    }),
    deleteJob: async (jobId: string) => {
      deletedEngineJobIds.push(jobId);
      return { bytes_freed: 4_096 };
    },
  } as unknown as EngineClient;
}

function terminalEngine(
  engineJobId: string,
  state: "completed" | "failed",
  speed: number,
  points: PolarPoint[],
  message?: string,
): EngineClient {
  return {
    getQueue: async () => {
      throw new Error("queue unavailable in test");
    },
    getJob: async (): Promise<JobStatus> => ({
      job_id: engineJobId,
      state,
      total_cases: points.length,
      completed_cases: points.length,
      message: message ?? null,
    }),
    getResult: async (): Promise<JobResult> => ({
      job_id: engineJobId,
      state,
      message: message ?? undefined,
      polars: [
        {
          speed,
          chord: CHORD,
          reynolds: reynoldsOf(speed),
          mach: speed / 340.3,
          points: points.map((point) => withExactManifest(engineJobId, point)),
        },
      ],
    }),
    deleteJob: async (jobId: string) => {
      deletedEngineJobIds.push(jobId);
      return { bytes_freed: 4_096 };
    },
  } as unknown as EngineClient;
}

async function composeCampaignJob(
  campaignId: string,
  engineJobId: string,
): Promise<{ jobId: string; entries: ConditionMapEntry[]; airfoilId: string }> {
  const batch = (await findCampaignGapBatch(db, {
    limit: 500,
    campaignIds: [campaignId],
  }))!;
  expect(batch).not.toBeNull();
  const composeEngine = {
    submitPolar: async (request: PolarRequest): Promise<JobStatus> => ({
      job_id: engineJobId,
      state: "pending",
      total_cases: request.aoa?.angles?.length ?? ANGLES.length,
      completed_cases: 0,
    }),
  } as unknown as EngineClient;
  expect(await submitCampaignBatch(db, composeEngine, batch, 0, 0)).toBe(true);
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
  const entries = ((
    job.requestPayload as { conditionMap?: ConditionMapEntry[] }
  )?.conditionMap ?? []) as ConditionMapEntry[];
  expect(entries.length).toBe(1);
  return { jobId: job.id, entries, airfoilId: job.airfoilId };
}

async function cellRows(revisionId: string, forAirfoilId = airfoilId) {
  return db
    .select({
      aoaDeg: results.aoaDeg,
      status: results.status,
      simJobId: results.simJobId,
      autoRetriedAt: results.autoRetriedAt,
      currentResultAttemptId: results.currentResultAttemptId,
      cl: results.cl,
      error: results.error,
    })
    .from(results)
    .where(
      and(
        eq(results.airfoilId, forAirfoilId),
        eq(results.simulationPresetRevisionId, revisionId),
      ),
    )
    .orderBy(asc(results.aoaDeg));
}

async function pointStates(campaignId: string, forAirfoilId: string) {
  return db
    .select({
      aoaDeg: simCampaignPoints.aoaDeg,
      state: simCampaignPoints.state,
    })
    .from(simCampaignPoints)
    .where(
      and(
        eq(simCampaignPoints.campaignId, campaignId),
        eq(simCampaignPoints.airfoilId, forAirfoilId),
      ),
    )
    .orderBy(asc(simCampaignPoints.aoaDeg));
}

function launchPlan(speed: number) {
  return {
    mediumId,
    ambients: [[288.15, 101325]] as [number, number][],
    speedsMps: [speed],
    chordsM: [CHORD],
    spanM: 1,
    areaMode: "derived" as const,
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
  };
}

beforeAll(async () => {
  const [state] = await db
    .select({
      enabled: sweeperState.enabled,
      maxConcurrentJobs: sweeperState.maxConcurrentJobs,
      cpuSlots: sweeperState.cpuSlots,
      admissionFenceActive: sweeperState.admissionFenceActive,
      lastAdmissionFenceAt: sweeperState.lastAdmissionFenceAt,
      lastAdmissionFenceReason: sweeperState.lastAdmissionFenceReason,
      lastAdmissionFenceTriggerKey: sweeperState.lastAdmissionFenceTriggerKey,
      lastAdmissionFenceDetails: sweeperState.lastAdmissionFenceDetails,
      maintenanceDrainToken: sweeperState.maintenanceDrainToken,
      maintenanceDrainStartedAt: sweeperState.maintenanceDrainStartedAt,
    })
    .from(sweeperState)
    .where(eq(sweeperState.id, 1))
    .limit(1);
  restoreSweeperState = state;
  await db
    .insert(sweeperState)
    .values({
      id: 1,
      enabled: true,
      maxConcurrentJobs: 64,
      cpuSlots: 64,
      admissionFenceActive: false,
    })
    .onConflictDoUpdate({
      target: sweeperState.id,
      set: {
        enabled: true,
        maxConcurrentJobs: 64,
        cpuSlots: 64,
        admissionFenceActive: false,
        lastAdmissionFenceAt: null,
        lastAdmissionFenceReason: null,
        lastAdmissionFenceTriggerKey: null,
        lastAdmissionFenceDetails: null,
        maintenanceDrainToken: null,
        maintenanceDrainStartedAt: null,
      },
    });

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
      slug: `${PREFIX}-cambered-a`,
      name: `${PREFIX} cambered a`,
      categoryId: cat.id,
      points: camberedPoints,
      isSymmetric: false,
    })
    .returning();
  airfoilId = airfoil.id;
  const [airfoil2] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-cambered-b`,
      name: `${PREFIX} cambered b`,
      categoryId: cat.id,
      points: camberedPoints,
      isSymmetric: false,
    })
    .returning();
  airfoil2Id = airfoil2.id;
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

  const launchA = await materializeCampaignLaunch(db, {
    name: `${PREFIX} partial-retry campaign A`,
    priority: 8,
    idempotencyKey: `${PREFIX}-key-a`,
    airfoilIds: [airfoilId],
    plan: launchPlan(SPEED_A),
  });
  campaignAId = launchA.campaign.id;
  // Campaign B keeps OPEN RANS gaps on a second airfoil so the ladder gate
  // defers the wave-2 retry at ingest time — the crashed point must fall to
  // the clean-restart pass, exactly like a mid-campaign prod batch.
  const launchB = await materializeCampaignLaunch(db, {
    name: `${PREFIX} partial-retry campaign B`,
    priority: 8,
    idempotencyKey: `${PREFIX}-key-b`,
    airfoilIds: [airfoilId, airfoil2Id],
    plan: launchPlan(SPEED_B),
  });
  campaignBId = launchB.campaign.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanupCampaignFixtures(db, {
    campaignIds: [campaignAId, campaignBId].filter(Boolean),
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
  if (airfoil2Id) await db.delete(airfoils).where(eq(airfoils.id, airfoil2Id));
  if (categoryId)
    await db.delete(categories).where(eq(categories.id, categoryId));
  if (restoreSweeperState) {
    await db
      .insert(sweeperState)
      .values({ id: 1, ...restoreSweeperState })
      .onConflictDoUpdate({
        target: sweeperState.id,
        set: restoreSweeperState,
      });
  }
  await sql.end();
});

describe("clean restart on the running-partial ingest route", () => {
  it("MUST-CATCH: a precalc wave-2 child's diverged point in a RUNNING partial discards that generation and routes cleanly to the wave-2 ladder", async () => {
    const errSpy = vi.spyOn(console, "error");
    const composed = await composeCampaignJob(
      campaignAId,
      `${PREFIX}-engine-w1`,
    );
    wave1JobId = composed.jobId;
    bcAId = composed.entries[0].bcId;
    revisionAId = composed.entries[0].revisionId;

    // Hand the claimed cells to a precalc wave-2 child exactly like
    // submitCampaignUransRetries does (single-revision child, uransFidelity
    // precalc, rows queued under the child), then terminalize the parent.
    const [child] = await db
      .insert(simJobs)
      .values({
        parentJobId: wave1JobId,
        airfoilId,
        bcIds: [bcAId],
        simulationPresetRevisionId: revisionAId,
        campaignId: campaignAId,
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
              speed: SPEED_A,
              bcId: bcAId,
              presetRevisionId: revisionAId,
              mach: SPEED_A / 340.3,
            },
          ],
          aoas: ANGLES,
          parentJobId: wave1JobId,
          uransFidelity: "precalc",
        },
      })
      .returning({ id: simJobs.id });
    childJobId = child.id;
    await db
      .update(results)
      .set({ simJobId: childJobId })
      .where(eq(results.simJobId, wave1JobId));
    await db
      .update(simJobs)
      .set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() })
      .where(eq(simJobs.id, wave1JobId));

    // The divergence watchdog killed the −5° case at t≈1e-05; the job is
    // STILL RUNNING its other angles when the sweeper polls.
    await reconcile(
      db,
      runningPartialEngine(
        `${PREFIX}-engine-w2`,
        SPEED_A,
        [divergedPrecalcPoint(-5)],
        ANGLES.length,
      ),
      {
        jobIds: [childJobId],
        skipFailedRecovery: true,
      },
    );

    const rows = await cellRows(revisionAId);
    expect(rows.length).toBe(ANGLES.length);
    const crashed = rows.find((r) => r.aoaDeg === -5)!;
    expect(crashed.status).toBe("queued"); // durable wave-2 obligation, NOT a wave-1 gap
    expect(crashed.autoRetriedAt).not.toBeNull(); // last clean-restart marker
    expect(crashed.simJobId).toBeNull();
    expect(crashed.error).toBeNull();
    firstMarker = crashed.autoRetriedAt;
    for (const row of rows.filter((r) => r.aoaDeg !== -5)) {
      expect(row.status).toBe("queued"); // untouched: still marching in the child
      expect(row.simJobId).toBe(childJobId);
      expect(row.autoRetriedAt).toBeNull();
    }

    const points = await pointStates(campaignAId, airfoilId);
    expect(points.find((p) => Number(p.aoaDeg) === -5)?.state).toBe(
      "requested",
    ); // reopened
    const totals = await campaignProgressTotals(db, campaignAId);
    expect(totals.failed).toBe(0);

    // The first partial ingest shipped a manifest, so this proves the clean
    // restart removes not only the failed result projection but its exact
    // attempt-owned artifact graph too.
    expect(
      await db
        .select({ id: resultAttempts.id })
        .from(resultAttempts)
        .where(eq(resultAttempts.simJobId, childJobId)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: solverEvidenceArtifacts.id })
        .from(solverEvidenceArtifacts)
        .where(eq(solverEvidenceArtifacts.simJobId, childJobId)),
    ).toEqual([]);

    // The child stays alive — the retry must not disturb the running job.
    const [childRow] = await db
      .select({ status: simJobs.status })
      .from(simJobs)
      .where(eq(simJobs.id, childJobId));
    expect(childRow.status).toBe("running");
    // One failed partial point is detached, but its sibling angles are still
    // executing. The clean-restart cleanup must never delete this live engine
    // directory merely because no failed-attempt rows remain.
    expect(deletedEngineJobIds).not.toContain(`${PREFIX}-engine-w2`);
    const [unstrippedChild] = await db
      .select({ strippedAt: simJobs.strippedAt })
      .from(simJobs)
      .where(eq(simJobs.id, childJobId));
    expect(unstrippedChild.strippedAt).toBeNull();

    // The ordinary campaign gap finder is wave-1 RANS by definition and must
    // never downgrade this precalc retry. The gated parent rescan owns it.
    const rePick = await findCampaignGapBatch(db, {
      limit: 500,
      campaignIds: [campaignAId],
    });
    expect(rePick).toBeNull();

    // Loud by contract: the fidelity-preserving route announces itself.
    expect(
      errSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          "CLEAN RESTART: discarded failed precalc generation and routed its cell to the wave-2 ladder",
        ),
      ),
    ).toBe(true);
  }, 240000);

  it("MUST-CATCH: terminal re-delivery from the abandoned job cannot recreate its discarded generation", async () => {
    const errSpy = vi.spyOn(console, "error");
    expect(firstMarker).not.toBeNull();

    // The child eventually dies wholesale. Its stale terminal file now claims
    // that the already-discarded -5° generation converged successfully. This
    // must not bypass cleanup merely because failedForPoint() is false.
    const staleSuccessfulReplay = {
      ...solvedRansPoint(-5),
      unsteady: true,
      fidelity: "urans_precalc",
    } as unknown as PolarPoint;
    await reconcile(
      db,
      terminalEngine(
        `${PREFIX}-engine-w2`,
        "failed",
        SPEED_A,
        [staleSuccessfulReplay],
        CRASH_MESSAGE,
      ),
      {
        jobIds: [childJobId],
        skipFailedRecovery: true,
      },
    );

    const rows = await cellRows(revisionAId);
    const crashed = rows.find((r) => r.aoaDeg === -5)!;
    // The released-cell guard held: ownership is not reclaimed and its clean
    // restart marker stays unchanged.
    expect(crashed.status).toBe("queued");
    expect(crashed.simJobId).toBeNull();
    expect(crashed.autoRetriedAt?.getTime()).toBe(firstMarker!.getTime());
    expect(crashed.currentResultAttemptId).toBeNull();
    expect(crashed.cl).toBeNull();
    expect(
      errSpy.mock.calls.some((call) =>
        String(call[0]).includes("RELEASED-CELL GUARD"),
      ),
    ).toBe(true);
    // The stale job cannot open an exhausted-retry outcome.
    expect(
      errSpy.mock.calls.some((call) =>
        String(call[0]).includes("AUTO-RETRY EXHAUSTED"),
      ),
    ).toBe(false);

    // The job's OTHER claimed rows crash with the terminal job and receive
    // the same clean-restart route.
    for (const row of rows.filter((r) => r.aoaDeg !== -5)) {
      expect(row.status).toBe("queued");
      expect(row.autoRetriedAt).not.toBeNull();
      expect(row.simJobId).toBeNull();
      expect(row.error).toBeNull();
    }

    const points = await pointStates(campaignAId, airfoilId);
    expect(points.every((p) => p.state === "requested")).toBe(true);
    const buckets = await campaignReviewBuckets(db, campaignAId);
    expect(buckets.needsReview).toBe(0);

    // No attempt from the stale successful-looking shipment survives: the
    // clean restart must not recreate the evidence/artifacts it discarded.
    const attempts = await db
      .select({ id: resultAttempts.id })
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.simJobId, childJobId),
          eq(resultAttempts.aoaDeg, -5),
        ),
      );
    expect(attempts).toEqual([]);
    expect(
      await db
        .select({ id: solverEvidenceArtifacts.id })
        .from(solverEvidenceArtifacts)
        .where(
          and(
            eq(solverEvidenceArtifacts.simJobId, childJobId),
            eq(solverEvidenceArtifacts.aoaDeg, -5),
          ),
        ),
    ).toEqual([]);

    const [childRow] = await db
      .select({ status: simJobs.status })
      .from(simJobs)
      .where(eq(simJobs.id, childJobId));
    expect(childRow.status).toBe("failed");
    expect(deletedEngineJobIds).toContain(`${PREFIX}-engine-w2`);
    const [stripped] = await db
      .select({
        strippedAt: simJobs.strippedAt,
        stripReport: simJobs.stripReport,
      })
      .from(simJobs)
      .where(eq(simJobs.id, childJobId));
    expect(stripped.strippedAt).not.toBeNull();
    expect(stripped.stripReport).toMatchObject({
      bytes_freed: 4_096,
      note: "discarded failed generation after clean restart",
    });
  }, 240000);

  it("FALSE-POSITIVE-GUARD: an ordinary late-owner race without a clean-restart marker retains exact attempt history", async () => {
    const aoaDeg = 8.75;
    const [currentOwner] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcAId],
        simulationPresetRevisionId: revisionAId,
        campaignId: campaignAId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 1,
        status: "running",
        engineJobId: `${PREFIX}-history-owner`,
        totalCases: 1,
      })
      .returning();
    const [lateJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcAId],
        simulationPresetRevisionId: revisionAId,
        campaignId: campaignAId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 1,
        status: "failed",
        engineState: "failed",
        engineJobId: `${PREFIX}-history-late`,
        totalCases: 1,
      })
      .returning();
    const [cell] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: bcAId,
        simulationPresetRevisionId: revisionAId,
        aoaDeg,
        status: "running",
        source: "queued",
        simJobId: currentOwner.id,
        autoRetriedAt: null,
      })
      .returning();

    await ingestResult({
      db,
      engine: {} as EngineClient,
      engineJobId: lateJob.engineJobId!,
      simJobId: lateJob.id,
      airfoilId,
      speedMap: [
        { speed: SPEED_A, bcId: bcAId, presetRevisionId: revisionAId },
      ],
      result: {
        job_id: lateJob.engineJobId!,
        state: "failed",
        message: "late historical shipment",
        polars: [
          {
            speed: SPEED_A,
            chord: CHORD,
            reynolds: reynoldsOf(SPEED_A),
            mach: SPEED_A / 340.3,
            points: [solvedRansPoint(aoaDeg)],
          },
        ],
      },
    });

    const retainedAttempts = await db
      .select({ id: resultAttempts.id })
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.resultId, cell.id),
          eq(resultAttempts.simJobId, lateJob.id),
        ),
      );
    expect(retainedAttempts).toHaveLength(1);
    const [unchangedCell] = await db
      .select({
        status: results.status,
        simJobId: results.simJobId,
        currentResultAttemptId: results.currentResultAttemptId,
        autoRetriedAt: results.autoRetriedAt,
      })
      .from(results)
      .where(eq(results.id, cell.id));
    expect(unchangedCell).toEqual({
      status: "running",
      simJobId: currentOwner.id,
      currentResultAttemptId: null,
      autoRetriedAt: null,
    });
  }, 240000);

  it("MUST-CATCH: a later unexplained crash through the same running-partial path starts another clean generation", async () => {
    const errSpy = vi.spyOn(console, "error");
    // The wave-2 ladder re-claimed the routed cell into a fresh precalc child
    // (inserted directly here so this test can isolate second-crash behavior).
    const [child2] = await db
      .insert(simJobs)
      .values({
        parentJobId: wave1JobId,
        airfoilId,
        bcIds: [bcAId],
        simulationPresetRevisionId: revisionAId,
        campaignId: campaignAId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "submitted",
        engineJobId: `${PREFIX}-engine-w2b`,
        submittedAt: new Date(),
        totalCases: 1,
        requestPayload: {
          speedMap: [
            {
              speed: SPEED_A,
              bcId: bcAId,
              presetRevisionId: revisionAId,
              mach: SPEED_A / 340.3,
            },
          ],
          aoas: [-5],
          parentJobId: wave1JobId,
          uransFidelity: "precalc",
        },
      })
      .returning({ id: simJobs.id });
    child2JobId = child2.id;
    await db
      .update(results)
      .set({ status: "queued", source: "queued", simJobId: child2JobId })
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, revisionAId),
          eq(results.aoaDeg, -5),
        ),
      );

    await reconcile(
      db,
      runningPartialEngine(
        `${PREFIX}-engine-w2b`,
        SPEED_A,
        [divergedPrecalcPoint(-5)],
        1,
      ),
      {
        jobIds: [child2JobId],
        skipFailedRecovery: true,
      },
    );

    const rows = await cellRows(revisionAId);
    const crashed = rows.find((r) => r.aoaDeg === -5)!;
    expect(crashed.status).toBe("queued");
    expect(crashed.autoRetriedAt).not.toBeNull();
    expect(crashed.simJobId).toBeNull();
    expect(crashed.error).toBeNull();

    const points = await pointStates(campaignAId, airfoilId);
    expect(points.find((p) => Number(p.aoaDeg) === -5)?.state).toBe(
      "requested",
    );
    const totals = await campaignProgressTotals(db, campaignAId);
    expect(totals.failed).toBe(0);
    const buckets = await campaignReviewBuckets(db, campaignAId);
    expect(buckets.needsReview).toBe(0);
    expect(buckets.awaitingUrans).toBe(0);

    expect(
      errSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          "CLEAN RESTART: discarded failed precalc generation and routed its cell to the wave-2 ladder",
        ),
      ),
    ).toBe(true);
  }, 240000);

  it("MUST-CATCH: one crashed point inside an otherwise-COMPLETED multi-point campaign job is cleanly requeued (batched-partial shape)", async () => {
    const errSpy = vi.spyOn(console, "error");
    const composed = await composeCampaignJob(
      campaignBId,
      `${PREFIX}-engine-b1`,
    );
    const revisionBId = composed.entries[0].revisionId;
    const claimedAirfoilId = composed.airfoilId;

    await reconcile(
      db,
      terminalEngine(`${PREFIX}-engine-b1`, "completed", SPEED_B, [
        solvedRansPoint(0),
        solvedRansPoint(5),
        {
          ...solvedRansPoint(-5),
          converged: false,
          cl: undefined,
          cd: undefined,
          cm: undefined,
          cl_cd: undefined,
          unsteady: false,
          error: DIVERGENCE_MESSAGE,
        } as unknown as PolarPoint,
      ]),
      { jobIds: [composed.jobId], skipFailedRecovery: true },
    );

    const rows = await cellRows(revisionBId, claimedAirfoilId);
    expect(rows.length).toBe(ANGLES.length);
    const crashed = rows.find((r) => r.aoaDeg === -5)!;
    expect(crashed.status).toBe("pending"); // the one-shot requeue fired
    expect(crashed.autoRetriedAt).not.toBeNull();
    expect(crashed.simJobId).toBeNull();
    expect(crashed.error).toBeNull();
    for (const row of rows.filter((r) => r.aoaDeg !== -5)) {
      expect(row.status).toBe("done"); // solved evidence untouched
      expect(row.autoRetriedAt).toBeNull();
    }

    const points = await pointStates(campaignBId, claimedAirfoilId);
    expect(points.find((p) => Number(p.aoaDeg) === -5)?.state).toBe(
      "requested",
    );
    const totals = await campaignProgressTotals(db, campaignBId);
    expect(totals.failed).toBe(0);

    expect(
      errSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          "CLEAN RESTART: discarded crash-class failed generation and requeued its cell",
        ),
      ),
    ).toBe(true);
  }, 240000);
});
