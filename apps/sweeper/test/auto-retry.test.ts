// MUST-CATCH suite for auto-retry-once (approved design c19fd74a, amendment
// B): a crash-class failed point (results.status='failed') gets exactly ONE
// automatic requeue before it counts as needs_review.
//
// Shaped like the real-world breakage class it guards: an engine job that
// dies with "All cases failed" and an EMPTY result payload (no points, no
// attempt evidence) — the true-crash branch of ingestFailedEngineJob — driven
// through the same reconcile() surface production runs.
//
//   1. FIRST crash  → every claimed cell auto-requeues (result → pending with
//      the auto_retried_at marker, campaign point → requested, failed counter
//      0) — and the pass is idempotent (a second sweep retries nothing).
//   2. SECOND crash → the marker escalates: rows STAY failed, points terminal,
//      needs_review counts them, awaiting_urans does not.
//   3. RE-INGEST of the same failed job (natural-key upsert) must NOT clear
//      the marker — a re-ingested crash never earns a second silent retry.
//
// Live shared-DB pattern (worker-restart-orphan.test.ts harness): scoped rows,
// file-unique chord, shared guarded cleanup.

import {
  airfoils,
  autoRetryCrashedResultsForJob,
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
  results,
  simCampaignPoints,
  simJobs,
  simResultSubmitRetries,
  solverProfiles,
  sweeperState,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import type {
  EngineClient,
  JobResult,
  JobStatus,
  PolarRequest,
} from "@aerodb/engine-client";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConditionMapEntry } from "../src/ingest";
import { ingestResult } from "../src/ingest";
import { submitCampaignBatch } from "../src/loop";
import { reconcile } from "../src/reconcile";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-autoretry-${process.pid}-${Date.now().toString(36)}`;

const ANGLES = [3, 4, 5];
// File-unique chord (F9 rule): reference_geometry_profiles dedupe on canonical
// physical keys — no other campaign-launching suite may share this chord.
const CHORD = 0.23;
const SPEED = 9;
const NU = 1.789e-5 / 1.225;
const CRASH_MESSAGE = "All cases failed";

let campaignId = "";
let airfoilId = "";
let categoryId = "";
let mediumId = "";
let revisionId = "";
let bcId = "";
let firstJobId = "";
let secondJobId = "";
const profileIds = { boundary: "", mesh: "", solver: "", output: "" };
let restoreSweeperEnabled: boolean | null = null;

const camberedPoints = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

function crashEngine(engineJobId: string): EngineClient {
  return {
    getQueue: async () => {
      throw new Error("queue unavailable in test");
    },
    getJob: async (): Promise<JobStatus> => ({
      job_id: engineJobId,
      state: "failed",
      total_cases: ANGLES.length,
      completed_cases: 0,
      message: CRASH_MESSAGE,
    }),
    getResult: async (): Promise<JobResult> => ({
      job_id: engineJobId,
      state: "failed",
      message: CRASH_MESSAGE,
      polars: [],
    }),
  } as unknown as EngineClient;
}

async function composeAndSubmit(engineJobId: string): Promise<string> {
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
  bcId = entries[0].bcId;
  revisionId = entries[0].revisionId;
  return job.id;
}

async function cellRows() {
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
      slug: `${PREFIX}-cambered`,
      name: `${PREFIX} cambered`,
      categoryId: cat.id,
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
    name: `${PREFIX} auto-retry campaign`,
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

describe("auto-retry-once for crash-class failed points (amendment B)", () => {
  it("MUST-CATCH: the first crash auto-requeues every cell exactly once (marker stamped, points reopen, failed counter 0)", async () => {
    firstJobId = await composeAndSubmit(`${PREFIX}-engine-1`);
    const claimedBeforeCrash = await cellRows();
    await db.insert(simResultSubmitRetries).values(
      claimedBeforeCrash.map((row) => ({
        resultId: row.id,
        state: "blocked",
        attemptCount: 1,
        lastHttpStatus: 503,
        lastError: "stale pre-submit retry fence",
      })),
    );
    await reconcile(db, crashEngine(`${PREFIX}-engine-1`), {
      jobIds: [firstJobId],
      skipFailedRecovery: true,
    });

    const rows = await cellRows();
    expect(rows.length).toBe(ANGLES.length);
    for (const row of rows) {
      expect(row.status).toBe("pending"); // re-claimable, NOT failed
      expect(row.autoRetriedAt).not.toBeNull(); // the one-shot marker
      expect(row.simJobId).toBeNull();
      expect(row.error).toBe(CRASH_MESSAGE); // crash evidence kept
    }
    expect(
      await db
        .select({ resultId: simResultSubmitRetries.resultId })
        .from(simResultSubmitRetries)
        .where(
          inArray(
            simResultSubmitRetries.resultId,
            rows.map((row) => row.id),
          ),
        ),
    ).toHaveLength(0);

    const points = await db
      .select({ state: simCampaignPoints.state })
      .from(simCampaignPoints)
      .where(eq(simCampaignPoints.campaignId, campaignId));
    expect(points.every((p) => p.state === "requested")).toBe(true);

    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals.failed).toBe(0);

    // Idempotence: a second pass over the same job retries NOTHING (the rows
    // are pending now) and escalates nothing.
    const again = await autoRetryCrashedResultsForJob(db, firstJobId);
    expect(again.retried).toEqual([]);
    expect(again.escalated).toEqual([]);
  }, 240000);

  it("MUST-CATCH: the second crash escalates to unavailable without assigning human review", async () => {
    // The pending rows are ordinary gaps again: the next tick re-claims them.
    secondJobId = await composeAndSubmit(`${PREFIX}-engine-2`);
    expect(secondJobId).not.toBe(firstJobId);
    await reconcile(db, crashEngine(`${PREFIX}-engine-2`), {
      jobIds: [secondJobId],
      skipFailedRecovery: true,
    });

    const rows = await cellRows();
    for (const row of rows) {
      expect(row.status).toBe("failed"); // escalated, no second silent retry
      expect(row.autoRetriedAt).not.toBeNull();
    }
    const points = await db
      .select({ state: simCampaignPoints.state })
      .from(simCampaignPoints)
      .where(eq(simCampaignPoints.campaignId, campaignId));
    expect(points.every((p) => p.state === "terminal")).toBe(true);

    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals.failed).toBe(ANGLES.length);
    const buckets = await campaignReviewBuckets(db, campaignId);
    expect(buckets.needsReview).toBe(0);
    expect(buckets.awaitingUrans).toBe(0);
  }, 240000);

  it("MUST-CATCH: re-ingesting the same failed job preserves the marker (no second retry from an ingest replay)", async () => {
    const before = await cellRows();
    const markerBefore = before[0].autoRetriedAt;
    expect(markerBefore).not.toBeNull();

    // Replay the failed shipment through the REAL ingest upsert (the exact
    // natural-key SET list production runs) — e.g. a markIngestRetry recovery
    // re-reading the same result file.
    const ingested = await ingestResult({
      db,
      engine: { baseUrl: "http://engine.test" } as unknown as EngineClient,
      engineJobId: `${PREFIX}-engine-2`,
      simJobId: secondJobId,
      airfoilId,
      speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId }],
      failedPointErrorFallback: CRASH_MESSAGE,
      result: {
        job_id: `${PREFIX}-engine-2`,
        state: "failed",
        message: CRASH_MESSAGE,
        polars: [
          {
            speed: SPEED,
            chord: CHORD,
            reynolds: Math.round((SPEED * CHORD) / NU),
            mach: SPEED / 340.3,
            points: ANGLES.map((aoa) => ({
              aoa_deg: aoa,
              unsteady: false,
              converged: false,
              first_order_fallback: false,
              error: CRASH_MESSAGE,
              images: {},
            })),
          },
        ],
      } as JobResult,
    });
    expect(ingested.points).toBe(ANGLES.length);

    const after = await cellRows();
    for (const row of after) {
      expect(row.status).toBe("failed");
      expect(row.autoRetriedAt).not.toBeNull(); // marker SURVIVED the upsert
    }
    // And the auto-retry pass still refuses a second retry: everything
    // escalates, nothing requeues.
    const outcome = await autoRetryCrashedResultsForJob(db, secondJobId);
    expect(outcome.retried).toEqual([]);
    expect(outcome.escalated.length).toBe(ANGLES.length);
  }, 240000);
});
