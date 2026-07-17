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

import "./enabled-engine-pool-fixture";

import {
  RANS_RECOVERY_REMEDIATION_VERSION,
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
  resultAttempts,
  resultClassifications,
  results,
  simCampaignPoints,
  simJobs,
  simPrecalcObligationCampaigns,
  simPrecalcObligationAttempts,
  simPrecalcObligations,
  simRansPolarPromotionPoints,
  simRansPolarPromotions,
  simResultSubmitRetries,
  simSolverIncidents,
  solverProfiles,
  solverIncidentSummary,
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
import { reconcile, submitUransRetryForJob } from "../src/reconcile";
import { resetUransLadderMemory, uransLadderTick } from "../src/urans-ladder";

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
    expect(totals.failed).toBe(0);
    expect(totals.blocked).toBe(ANGLES.length);
    const buckets = await campaignReviewBuckets(db, campaignId);
    expect(buckets.needsReview).toBe(0);
    expect(buckets.awaitingUrans).toBe(0);

    const incidents = await db
      .select()
      .from(simSolverIncidents)
      .where(
        inArray(
          simSolverIncidents.resultId,
          rows.map((row) => row.id),
        ),
      );
    expect(incidents).toHaveLength(ANGLES.length);
    for (const incident of incidents) {
      expect(incident).toMatchObject({
        stage: "rans",
        reason: "solver-execution-failed",
        severity: "critical",
        status: "open",
        remediationVersion: RANS_RECOVERY_REMEDIATION_VERSION,
        simJobId: secondJobId,
        resultAttemptId: null,
      });
      expect(incident.resultId).not.toBeNull();
      expect(incident.occurrenceKey).toBe(
        `rans:${incident.resultId}:${secondJobId}:auto-retry-exhausted`,
      );
    }
    const incidentSummary = await solverIncidentSummary(db, { campaignId });
    expect(incidentSummary).toMatchObject({
      occurrenceCount: ANGLES.length,
      openCount: ANGLES.length,
      criticalGroupCount: 1,
    });
    expect(incidentSummary.groups).toEqual([
      expect.objectContaining({
        stage: "rans",
        reason: "solver-execution-failed",
        occurrenceCount: ANGLES.length,
        openCriticalCount: ANGLES.length,
        requiresInvestigation: true,
      }),
    ]);
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
        mesh_recovery_version: 3,
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
    const replayAttempts = await db
      .select({ evidencePayload: resultAttempts.evidencePayload })
      .from(resultAttempts)
      .where(eq(resultAttempts.simJobId, secondJobId));
    expect(replayAttempts).toHaveLength(ANGLES.length);
    expect(
      replayAttempts.every(
        (attempt) =>
          (
            attempt.evidencePayload as {
              mesh_recovery_version?: number;
            } | null
          )?.mesh_recovery_version === 3,
      ),
    ).toBe(true);
    // And the auto-retry pass still refuses a second retry: everything
    // escalates, nothing requeues.
    const outcome = await autoRetryCrashedResultsForJob(db, secondJobId);
    expect(outcome.retried).toEqual([]);
    expect(outcome.escalated.length).toBe(ANGLES.length);
    expect(
      await db
        .select({ id: simSolverIncidents.id })
        .from(simSolverIncidents)
        .where(
          inArray(
            simSolverIncidents.resultId,
            after.map((row) => row.id),
          ),
        ),
    ).toHaveLength(ANGLES.length);
  }, 240000);

  it("MUST-CATCH: typed hard-solver stays with promotion, infrastructure gets one retry, and deterministic mesh stays terminal", async () => {
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        campaignId,
        jobKind: "sweep",
        referenceChordM: CHORD,
        wave: 1,
        status: "running",
        totalCases: 3,
        requestPayload: {
          aoas: [0.25, 0.5, 0.75],
          ransRetryScope: {
            origin: "continuous-polar",
            requestedAoas: [0.25, 0.5, 0.75],
          },
        },
      })
      .returning();

    const cases = [
      {
        aoaDeg: 0.25,
        disposition: "hard_solver",
        error: "simpleFoam diverged after residual growth",
      },
      {
        aoaDeg: 0.5,
        disposition: "infrastructure",
        error: "OpenMPI reported insufficient slots",
      },
      {
        aoaDeg: 0.75,
        disposition: "deterministic_mesh",
        error: "blockMesh rejected deterministic topology",
      },
    ] as const;
    const seeded: Array<{
      resultId: string;
      aoaDeg: number;
      disposition: (typeof cases)[number]["disposition"];
    }> = [];
    for (const fixture of cases) {
      const [result] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: fixture.aoaDeg,
          status: "failed",
          source: "queued",
          regime: "rans",
          converged: false,
          error: fixture.error,
          simJobId: job.id,
          engineJobId: `${PREFIX}-typed-partial`,
        })
        .returning();
      const [attempt] = await db
        .insert(resultAttempts)
        .values({
          resultId: result.id,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: fixture.aoaDeg,
          simJobId: job.id,
          engineJobId: `${PREFIX}-typed-partial`,
          status: "failed",
          source: "queued",
          regime: "rans",
          validForPolar: false,
          converged: false,
          error: fixture.error,
          evidencePayload: {
            failure_disposition: fixture.disposition,
            ...(fixture.disposition === "deterministic_mesh"
              ? { mesh_recovery_version: 7 }
              : {}),
          },
          solvedAt: new Date(),
        })
        .returning();
      await db
        .update(results)
        .set({ currentResultAttemptId: attempt.id })
        .where(eq(results.id, result.id));
      await db.insert(resultClassifications).values({
        resultId: result.id,
        resultAttemptId: attempt.id,
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: fixture.aoaDeg,
        regime: "rans",
        classifierVersion: "typed-auto-retry-guard:v1",
        state: "rejected",
        reasons: [fixture.error],
      });
      seeded.push({
        resultId: result.id,
        aoaDeg: fixture.aoaDeg,
        disposition: fixture.disposition,
      });
    }

    // Real partial ingestion refreshes classifications before generic retry;
    // rejected hard evidence is intentionally not a selected public pointer.
    // The promotion guard must use exact job-local attempt history, not this
    // mutable projection.
    const pointerNullHard = seeded.find(
      (row) => row.disposition === "hard_solver",
    )!;
    await db
      .update(results)
      .set({ currentResultAttemptId: null })
      .where(eq(results.id, pointerNullHard.resultId));

    const outcome = await autoRetryCrashedResultsForJob(db, job.id);
    const after = await db
      .select({
        id: results.id,
        status: results.status,
        simJobId: results.simJobId,
        autoRetriedAt: results.autoRetriedAt,
      })
      .from(results)
      .where(
        inArray(
          results.id,
          seeded.map((row) => row.resultId),
        ),
      );
    const byId = new Map(after.map((row) => [row.id, row]));
    const hard = seeded.find((row) => row.disposition === "hard_solver")!;
    expect(byId.get(hard.resultId)).toMatchObject({
      status: "failed",
      simJobId: job.id,
      autoRetriedAt: null,
    });
    const infrastructure = seeded.find(
      (row) => row.disposition === "infrastructure",
    )!;
    const deterministic = seeded.find(
      (row) => row.disposition === "deterministic_mesh",
    )!;
    expect(outcome.retried.map((row) => row.resultId)).toEqual([
      infrastructure.resultId,
    ]);
    expect(byId.get(infrastructure.resultId)).toMatchObject({
      status: "pending",
      simJobId: null,
    });
    expect(byId.get(infrastructure.resultId)?.autoRetriedAt).not.toBeNull();
    expect(outcome.suppressed.map((row) => row.resultId)).toEqual([
      deterministic.resultId,
    ]);
    expect(byId.get(deterministic.resultId)).toMatchObject({
      status: "failed",
      simJobId: job.id,
      autoRetriedAt: null,
    });
    const [meshIncident] = await db
      .select()
      .from(simSolverIncidents)
      .where(eq(simSolverIncidents.resultId, deterministic.resultId));
    expect(meshIncident).toMatchObject({
      stage: "rans",
      reason: "mesh-quality-failure",
      severity: "critical",
      status: "open",
      simJobId: job.id,
      resultAttemptId: expect.any(String),
      remediationVersion: "rans-mesh-recovery-v7",
    });
    expect(meshIncident.occurrenceKey).toBe(
      `rans:${deterministic.resultId}:${job.id}:deterministic-mesh:v7`,
    );
    expect(meshIncident.metadata).toMatchObject({ meshRecoveryVersion: 7 });
    expect(
      await db
        .select({ id: simSolverIncidents.id })
        .from(simSolverIncidents)
        .where(
          inArray(simSolverIncidents.resultId, [
            hard.resultId,
            infrastructure.resultId,
          ]),
        ),
    ).toHaveLength(0);
  }, 240000);

  it("MUST-CATCH: completed physical RANS rejection is normal URANS handoff evidence, never a critical preflight incident", async () => {
    const [job] = await db
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
        totalCases: 2,
        requestPayload: { aoas: [26.25, 26.5] },
      })
      .returning();
    const fixtures = [
      {
        aoaDeg: 26.25,
        state: "rejected" as const,
        reasons: ["missing-coefficients"],
      },
      {
        aoaDeg: 26.5,
        state: "needs_urans" as const,
        reasons: ["not-converged", "solver-stalled"],
      },
    ];
    const seeded: Array<{
      resultId: string;
      attemptId: string;
      state: (typeof fixtures)[number]["state"];
    }> = [];
    for (const fixture of fixtures) {
      const [result] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: fixture.aoaDeg,
          status: "done",
          source: "solved",
          regime: "rans",
          fidelity: "rans",
          converged: false,
          simJobId: job.id,
          engineJobId: `${PREFIX}-done-rejected`,
        })
        .returning();
      const [attempt] = await db
        .insert(resultAttempts)
        .values({
          resultId: result.id,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: fixture.aoaDeg,
          simJobId: job.id,
          engineJobId: `${PREFIX}-done-rejected`,
          status: "done",
          source: "solved",
          regime: "rans",
          validForPolar: false,
          converged: false,
          evidencePayload: { fidelity: "rans" },
          solvedAt: new Date(),
        })
        .returning();
      await db
        .update(results)
        .set({ currentResultAttemptId: attempt.id })
        .where(eq(results.id, result.id));
      await db.insert(resultClassifications).values({
        resultId: result.id,
        resultAttemptId: attempt.id,
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: fixture.aoaDeg,
        regime: "rans",
        classifierVersion: "terminal-rans-incident-guard:v1",
        state: fixture.state,
        reasons: fixture.reasons,
      });
      seeded.push({
        resultId: result.id,
        attemptId: attempt.id,
        state: fixture.state,
      });
    }

    await autoRetryCrashedResultsForJob(db, job.id);
    await autoRetryCrashedResultsForJob(db, job.id);

    const incidents = await db
      .select()
      .from(simSolverIncidents)
      .where(
        inArray(
          simSolverIncidents.resultId,
          seeded.map((row) => row.resultId),
        ),
      );
    expect(incidents).toHaveLength(0);
  }, 240000);

  it("MUST-CATCH: durable whole-polar promotion events recover campaign and background parents after a crash before child composition", async () => {
    resetUransLadderMemory();
    const seedRecovery = async (opts: {
      requestedAoas: number[];
      campaignOwned: boolean;
      suffix: string;
      parentState: "done" | "cancelled" | "stale-ingest" | "live-ingest";
      conditionMapEntry?: ConditionMapEntry;
    }): Promise<{
      promotionId: string;
      parentJobId: string;
      triggerAttemptId: string;
      obligationIds: string[];
      ingestLeaseToken: string | null;
    }> => {
      const triggerAoa = opts.requestedAoas[0];
      const ingesting =
        opts.parentState === "stale-ingest" ||
        opts.parentState === "live-ingest";
      const [parent] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          campaignId: opts.campaignOwned ? campaignId : null,
          engineJobId: `${PREFIX}-promotion-parent-${opts.suffix}`,
          jobKind: "sweep",
          referenceChordM: CHORD,
          wave: 1,
          status: ingesting
            ? "ingesting"
            : opts.parentState === "cancelled"
              ? "cancelled"
              : "done",
          totalCases: opts.requestedAoas.length,
          completedCases: 1,
          ...(ingesting
            ? {
                ingestLeaseToken: `${PREFIX}-dead-owner-${opts.suffix}`,
                ingestLeaseClaimedAt: new Date(Date.now() - 120_000),
                ingestLeaseExpiresAt: new Date(
                  Date.now() +
                    (opts.parentState === "live-ingest" ? 120_000 : -60_000),
                ),
              }
            : { ingestedAt: new Date(), finishedAt: new Date() }),
          requestPayload: {
            speedMap: [
              {
                speed: SPEED,
                bcId,
                presetRevisionId: revisionId,
                mach: SPEED / 340.3,
              },
            ],
            aoas: opts.requestedAoas,
            ransRetryScope: {
              origin: "continuous-polar",
              requestedAoas: opts.requestedAoas,
            },
            ...(opts.conditionMapEntry
              ? { conditionMap: [opts.conditionMapEntry] }
              : {}),
          },
        })
        .returning();
      const [triggerResult] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: triggerAoa,
          status: "failed",
          source: "queued",
          regime: "rans",
          converged: false,
          error: "simpleFoam diverged after residual growth",
          simJobId: parent.id,
          engineJobId: parent.engineJobId,
        })
        .returning();
      const [triggerAttempt] = await db
        .insert(resultAttempts)
        .values({
          resultId: triggerResult.id,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: triggerAoa,
          simJobId: parent.id,
          engineJobId: parent.engineJobId,
          status: "failed",
          source: "queued",
          regime: "rans",
          validForPolar: false,
          converged: false,
          error: "simpleFoam diverged after residual growth",
          evidencePayload: { failure_disposition: "hard_solver" },
          solvedAt: new Date(),
        })
        .returning();
      await db
        .update(results)
        .set({ currentResultAttemptId: triggerAttempt.id })
        .where(eq(results.id, triggerResult.id));
      await db.insert(resultClassifications).values({
        resultId: triggerResult.id,
        resultAttemptId: triggerAttempt.id,
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: triggerAoa,
        regime: "rans",
        classifierVersion: "promotion-recovery:v1",
        state: "rejected",
        reasons: ["typed hard solver failure"],
      });
      const obligations = await db
        .insert(simPrecalcObligations)
        .values(
          opts.requestedAoas.map((aoaDeg) => ({
            airfoilId,
            revisionId,
            aoaDeg,
            sourceResultId: aoaDeg === triggerAoa ? triggerResult.id : null,
            sourceResultAttemptId:
              aoaDeg === triggerAoa ? triggerAttempt.id : null,
            state: "pending",
            backgroundOwner: !opts.campaignOwned,
          })),
        )
        .returning();
      if (opts.campaignOwned) {
        await db.insert(simPrecalcObligationCampaigns).values(
          obligations.map((obligation) => ({
            obligationId: obligation.id,
            campaignId,
            state: "active",
          })),
        );
      }
      const [promotion] = await db
        .insert(simRansPolarPromotions)
        .values({
          parentJobId: parent.id,
          airfoilId,
          revisionId,
          conditionId: opts.conditionMapEntry?.conditionId ?? null,
          ownerKind: opts.campaignOwned ? "campaign" : "background",
          campaignId: opts.campaignOwned ? campaignId : null,
          triggerResultAttemptId: triggerAttempt.id,
          triggerAoaDeg: triggerAoa,
          failureDisposition: "hard_solver",
          requestOrigin: "continuous-polar",
        })
        .returning();
      await db.insert(simRansPolarPromotionPoints).values(
        obligations.map((obligation) => ({
          promotionId: promotion.id,
          aoaDeg: obligation.aoaDeg,
          obligationId: obligation.id,
          intentionallyOmittedByRans: obligation.aoaDeg !== triggerAoa,
        })),
      );
      return {
        promotionId: promotion.id,
        parentJobId: parent.id,
        triggerAttemptId: triggerAttempt.id,
        obligationIds: obligations.map((obligation) => obligation.id),
        ingestLeaseToken: ingesting
          ? `${PREFIX}-dead-owner-${opts.suffix}`
          : null,
      };
    };

    const [campaignCondition] = await db
      .select({ conditionId: simCampaignPoints.conditionId })
      .from(simCampaignPoints)
      .where(eq(simCampaignPoints.campaignId, campaignId))
      .limit(1);
    expect(campaignCondition?.conditionId).toBeTruthy();
    const conditionMapEntryFor = (
      requestedAoas: number[],
    ): ConditionMapEntry => ({
      conditionId: campaignCondition!.conditionId,
      revisionId,
      presetId: revisionId,
      speed: SPEED,
      reynolds: 1,
      bcId,
      ransRetryScope: {
        origin: "continuous-polar",
        requestedAoas,
      },
    });

    const campaignPromotion = await seedRecovery({
      requestedAoas: [1, 1.25],
      campaignOwned: true,
      suffix: "campaign",
      parentState: "stale-ingest",
    });
    const backgroundPromotion = await seedRecovery({
      requestedAoas: [2, 2.25],
      campaignOwned: false,
      suffix: "background",
      parentState: "done",
    });
    const liveLeasePromotion = await seedRecovery({
      requestedAoas: [2.5, 2.75],
      campaignOwned: false,
      suffix: "live-lease",
      parentState: "live-ingest",
    });
    const meshBlockedPromotion = await seedRecovery({
      requestedAoas: [4.25, 4.5],
      campaignOwned: true,
      suffix: "mesh-blocked",
      parentState: "done",
      conditionMapEntry: conditionMapEntryFor([4.25, 4.5]),
    });
    const typedMeshBlockedPromotion = await seedRecovery({
      requestedAoas: [4.26, 4.51],
      campaignOwned: true,
      suffix: "typed-mesh-blocked",
      parentState: "done",
      conditionMapEntry: conditionMapEntryFor([4.26, 4.51]),
    });
    const typedInfrastructurePromotion = await seedRecovery({
      requestedAoas: [4.27, 4.52],
      campaignOwned: true,
      suffix: "typed-infrastructure-not-mesh",
      parentState: "done",
      conditionMapEntry: conditionMapEntryFor([4.27, 4.52]),
    });
    const typedPriorChildren = await db
      .insert(simJobs)
      .values(
        [
          {
            promotion: meshBlockedPromotion,
            suffix: "legacy-current-mesh-child",
            aoas: [4.25, 4.5],
            evidenceAoa: 4.25,
            disposition: null,
            error:
              "mesh degenerate at this fidelity tier: max non-orthogonality exceeds threshold",
          },
          {
            promotion: typedMeshBlockedPromotion,
            suffix: "typed-current-mesh-child",
            aoas: [4.26, 4.51],
            evidenceAoa: 4.26,
            disposition: "deterministic_mesh",
            error: "checkMesh found negative-volume cells",
          },
          {
            promotion: typedInfrastructurePromotion,
            suffix: "typed-current-infrastructure-child",
            aoas: [4.27, 4.52],
            evidenceAoa: 4.27,
            disposition: "infrastructure",
            // Typed evidence is authoritative even if an infrastructure
            // diagnostic quotes both legacy deterministic-mesh phrases.
            error:
              "mesh worker connection closed after reporting mesh degenerate at this fidelity tier and max non-orthogonality",
          },
        ].map(({ promotion, suffix, aoas }) => ({
          parentJobId: promotion.parentJobId,
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          campaignId: null,
          jobKind: "targeted" as const,
          referenceChordM: CHORD,
          wave: 2,
          status: "failed" as const,
          engineJobId: `${PREFIX}-${suffix}`,
          submittedAt: new Date(),
          finishedAt: new Date(),
          totalCases: 2,
          requestPayload: {
            aoas,
            conditionId: campaignCondition!.conditionId,
            uransFidelity: "precalc",
            meshRecoveryVersion: 1,
            executedMeshRecoveryVersion: 1,
            precalcObligationIds: promotion.obligationIds,
          },
        })),
      )
      .returning();
    await db.insert(resultAttempts).values(
      typedPriorChildren.map((child, index) => ({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: [4.25, 4.26, 4.27][index],
        simJobId: child.id,
        engineJobId: child.engineJobId,
        status: "failed" as const,
        source: "queued" as const,
        regime: "urans" as const,
        validForPolar: false,
        converged: false,
        error: [
          "mesh degenerate at this fidelity tier: max non-orthogonality exceeds threshold",
          "checkMesh found negative-volume cells",
          "mesh worker connection closed before quality checks",
        ][index],
        evidencePayload: {
          fidelity: "urans_precalc",
          ...(index === 0
            ? {}
            : {
                failure_disposition:
                  index === 1 ? "deterministic_mesh" : "infrastructure",
              }),
        },
        solvedAt: new Date(),
      })),
    );
    const upgradeableMeshBlockedPromotion = await seedRecovery({
      // The first angle is the typed whole-polar trigger and therefore must
      // remain inside the contract's inclusive 0..5 degree range. The
      // replacement scope itself may extend above that range.
      requestedAoas: [4.6, 5.6],
      campaignOwned: true,
      suffix: "mesh-blocked-requested-v1-executed-v0",
      parentState: "done",
      conditionMapEntry: conditionMapEntryFor([4.6, 5.6]),
    });
    const [legacyMeshChild] = await db
      .insert(simJobs)
      .values({
        parentJobId: upgradeableMeshBlockedPromotion.parentJobId,
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "failed",
        engineJobId: `${PREFIX}-requested-v1-executed-v0-mesh-child`,
        submittedAt: new Date(),
        finishedAt: new Date(),
        totalCases: 2,
        requestPayload: {
          aoas: [4.6, 5.6],
          conditionId: campaignCondition!.conditionId,
          uransFidelity: "precalc",
          // The scheduler asked for v1, but the old worker supplied no
          // execution acknowledgement. Requested intent must never masquerade
          // as executed provenance, so immutable attempt truth remains v0 and
          // a real v1 repair is still eligible.
          meshRecoveryVersion: 1,
          executedMeshRecoveryVersion: 0,
          precalcObligationIds: upgradeableMeshBlockedPromotion.obligationIds,
        },
      })
      .returning();
    await db.insert(simPrecalcObligationAttempts).values(
      upgradeableMeshBlockedPromotion.obligationIds.map((obligationId) => ({
        obligationId,
        simJobId: legacyMeshChild.id,
        attemptNumber: 1,
        solverAttemptNumber: null,
        consumesSolverAttempt: false,
        state: "failed" as const,
        outcome: "deterministic_failure",
        error: "checkMesh found negative-volume cells",
        completedAt: new Date(),
      })),
    );
    await db
      .update(simPrecalcObligations)
      .set({
        state: "blocked",
        attemptCount: 0,
        latestSimJobId: legacyMeshChild.id,
        lastOutcome: "deterministic_failure",
        lastError: "checkMesh found negative-volume cells",
        completedAt: new Date(),
      })
      .where(
        inArray(
          simPrecalcObligations.id,
          upgradeableMeshBlockedPromotion.obligationIds,
        ),
      );
    const cancelledBackgroundPromotion = await seedRecovery({
      requestedAoas: [4.75, 5.25],
      campaignOwned: false,
      suffix: "cancelled-background",
      parentState: "cancelled",
    });
    const cancelledParentCampaignOwnedWithBackgroundCoowner =
      await seedRecovery({
        requestedAoas: [3.75, 4],
        campaignOwned: true,
        suffix: "cancelled-parent-campaign-owned-background-coowner",
        parentState: "cancelled",
      });
    // Shared physical ownership is mutable. While the original campaign stays
    // active, this later beneficiary must not change the event's immutable
    // campaign origin into an autonomous background event (which would
    // incorrectly suppress recovery solely because the RANS parent job is
    // cancelled).
    await db
      .update(simPrecalcObligations)
      .set({ backgroundOwner: true })
      .where(
        inArray(
          simPrecalcObligations.id,
          cancelledParentCampaignOwnedWithBackgroundCoowner.obligationIds,
        ),
      );
    const cancelDuringSubmitPromotion = await seedRecovery({
      requestedAoas: [3.25, 3.5],
      campaignOwned: false,
      suffix: "cancel-during-submit",
      parentState: "done",
    });
    const conditionMapEntry = conditionMapEntryFor([3.6, 3.7]);
    const conditionMapPromotion = await seedRecovery({
      requestedAoas: [3.6, 3.7],
      campaignOwned: false,
      suffix: "condition-map-terminal-replay",
      parentState: "live-ingest",
      conditionMapEntry,
    });
    await db
      .update(simPrecalcObligations)
      .set({ lastOutcome: "deterministic_failure" })
      .where(
        eq(simPrecalcObligations.id, meshBlockedPromotion.obligationIds[0]),
      );
    // The normalized event and its exact point→obligation coverage are the
    // recovery authority. A later mutation of mutable parent transport JSON
    // or derived classification must neither shrink nor erase that scope.
    await db
      .update(simJobs)
      .set({
        requestPayload: {
          aoas: [2],
          ransRetryScope: {
            origin: "explicit-targeted",
            requestedAoas: [2],
          },
        },
      })
      .where(eq(simJobs.id, backgroundPromotion.parentJobId));
    await db
      .update(simJobs)
      .set({
        requestPayload: {
          aoas: [4.25],
          ransRetryScope: {
            origin: "explicit-targeted",
            requestedAoas: [4.25],
          },
        },
      })
      .where(eq(simJobs.id, meshBlockedPromotion.parentJobId));
    await db
      .update(simJobs)
      .set({
        requestPayload: {
          aoas: [3.6],
          ransRetryScope: {
            origin: "explicit-targeted",
            requestedAoas: [3.6],
          },
        },
      })
      .where(eq(simJobs.id, conditionMapPromotion.parentJobId));
    await db
      .update(resultClassifications)
      .set({ state: "superseded_by_urans" })
      .where(
        eq(
          resultClassifications.resultAttemptId,
          backgroundPromotion.triggerAttemptId,
        ),
      );
    await db
      .update(resultClassifications)
      .set({ state: "needs_urans" })
      .where(
        eq(
          resultClassifications.resultAttemptId,
          conditionMapPromotion.triggerAttemptId,
        ),
      );
    const [classificationBeforeRecovery] = await db
      .select({ state: resultClassifications.state })
      .from(resultClassifications)
      .where(
        eq(
          resultClassifications.resultAttemptId,
          backgroundPromotion.triggerAttemptId,
        ),
      );
    expect(classificationBeforeRecovery?.state).toBe("superseded_by_urans");
    const submitted: PolarRequest[] = [];
    let engineSequence = 0;
    const engine = {
      healthDetails: async () => ({
        status: "ok",
        version: "test",
        mesh_recovery_version: 1,
      }),
      submitPolar: async (request: PolarRequest): Promise<JobStatus> => {
        submitted.push(request);
        engineSequence += 1;
        return {
          job_id: `${PREFIX}-promotion-child-${engineSequence}`,
          state: "pending",
          total_cases: request.aoa?.angles?.length ?? 0,
          completed_cases: 0,
        };
      },
    } as unknown as EngineClient;
    const [conditionMapParent] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, conditionMapPromotion.parentJobId));
    await submitUransRetryForJob(db, engine, conditionMapParent, {
      ingestLeaseToken: conditionMapPromotion.ingestLeaseToken!,
    });
    expect(submitted).toHaveLength(0);
    expect(
      await db
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(
          and(
            eq(simJobs.parentJobId, conditionMapPromotion.parentJobId),
            eq(simJobs.wave, 2),
          ),
        ),
    ).toHaveLength(0);
    // Mirror the terminal ingester after the event-first replay returned: the
    // normalized event remains the only authority and finalization can clear
    // the lease without composing an unbound targeted child.
    const finalizedConditionMapParent = await db
      .update(simJobs)
      .set({
        status: "done",
        ingestedAt: new Date(),
        finishedAt: new Date(),
        ingestLeaseToken: null,
        ingestLeaseClaimedAt: null,
        ingestLeaseExpiresAt: null,
      })
      .where(
        and(
          eq(simJobs.id, conditionMapPromotion.parentJobId),
          eq(simJobs.status, "ingesting"),
          eq(simJobs.ingestLeaseToken, conditionMapPromotion.ingestLeaseToken!),
        ),
      )
      .returning({ id: simJobs.id });
    expect(finalizedConditionMapParent).toEqual([
      { id: conditionMapPromotion.parentJobId },
    ]);
    const parentJobIds = [
      campaignPromotion.parentJobId,
      backgroundPromotion.parentJobId,
      liveLeasePromotion.parentJobId,
      meshBlockedPromotion.parentJobId,
      typedMeshBlockedPromotion.parentJobId,
      typedInfrastructurePromotion.parentJobId,
      upgradeableMeshBlockedPromotion.parentJobId,
      cancelledBackgroundPromotion.parentJobId,
      cancelledParentCampaignOwnedWithBackgroundCoowner.parentJobId,
      cancelDuringSubmitPromotion.parentJobId,
    ];
    const recoveryScope = (promotionIds: string[]) => ({
      campaignIds: [campaignId],
      parentJobIds,
      promotionIds,
      requestIds: [] as string[],
      verifyIds: [] as string[],
    });
    // A live ingest owner must not be raced by recovery even though its event
    // and obligations are already durable.
    expect(
      await uransLadderTick(
        db,
        engine,
        0,
        recoveryScope([liveLeasePromotion.promotionId]),
      ),
    ).toBe(false);
    expect(submitted).toHaveLength(0);
    const compensatingCancels: string[] = [];
    const cancelDuringSubmitEngine = {
      submitPolar: async (request: PolarRequest): Promise<JobStatus> => {
        await db
          .update(simJobs)
          .set({ status: "cancelled", finishedAt: new Date() })
          .where(eq(simJobs.id, cancelDuringSubmitPromotion.parentJobId));
        return {
          job_id: `${PREFIX}-cancel-during-promotion-submit`,
          state: "pending",
          total_cases: request.aoa?.angles?.length ?? 0,
          completed_cases: 0,
        };
      },
      cancelJob: async (engineJobId: string): Promise<JobStatus> => {
        compensatingCancels.push(engineJobId);
        return {
          job_id: engineJobId,
          state: "cancelled",
          total_cases: 2,
          completed_cases: 0,
        };
      },
    } as unknown as EngineClient;
    expect(
      await uransLadderTick(
        db,
        cancelDuringSubmitEngine,
        0,
        recoveryScope([cancelDuringSubmitPromotion.promotionId]),
      ),
    ).toBe(false);
    expect(compensatingCancels).toEqual([
      `${PREFIX}-cancel-during-promotion-submit`,
    ]);
    expect(
      await uransLadderTick(
        db,
        engine,
        0,
        recoveryScope([cancelledBackgroundPromotion.promotionId]),
      ),
    ).toBe(false);
    expect(submitted).toHaveLength(0);
    expect(
      await uransLadderTick(
        db,
        engine,
        0,
        recoveryScope([meshBlockedPromotion.promotionId]),
      ),
    ).toBe(false);
    // MUST-CATCH: the authoritative event is temporarily ineligible because
    // of immutable deterministic mesh evidence. The same ladder tick must not
    // fall through to the generic gated-parent path, reinterpret the drifted
    // parent scope as a targeted retry, and compose an unbound wave-2 child.
    expect(submitted).toHaveLength(0);
    expect(
      await uransLadderTick(
        db,
        engine,
        0,
        recoveryScope([typedMeshBlockedPromotion.promotionId]),
      ),
    ).toBe(false);
    // Typed deterministic_mesh is authoritative even when the human error text
    // lacks both legacy markers. Typed infrastructure remains schedulable even
    // when its diagnostic happens to contain both legacy marker phrases.
    expect(submitted).toHaveLength(0);
    await db
      .update(simJobs)
      .set({ ingestLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(simJobs.id, liveLeasePromotion.parentJobId));

    const promotionIds = [
      campaignPromotion.promotionId,
      backgroundPromotion.promotionId,
      liveLeasePromotion.promotionId,
      meshBlockedPromotion.promotionId,
      typedMeshBlockedPromotion.promotionId,
      typedInfrastructurePromotion.promotionId,
      upgradeableMeshBlockedPromotion.promotionId,
      cancelledBackgroundPromotion.promotionId,
      cancelledParentCampaignOwnedWithBackgroundCoowner.promotionId,
      cancelDuringSubmitPromotion.promotionId,
    ];

    expect(
      await uransLadderTick(db, engine, 0, recoveryScope(promotionIds)),
    ).toBe(true);
    expect(
      await uransLadderTick(db, engine, 0, recoveryScope(promotionIds)),
    ).toBe(true);
    expect(
      await uransLadderTick(db, engine, 0, recoveryScope(promotionIds)),
    ).toBe(true);
    expect(
      await uransLadderTick(db, engine, 0, recoveryScope(promotionIds)),
    ).toBe(true);
    expect(
      await uransLadderTick(db, engine, 0, recoveryScope(promotionIds)),
    ).toBe(true);
    expect(
      await uransLadderTick(db, engine, 0, recoveryScope(promotionIds)),
    ).toBe(true);
    expect(submitted).toHaveLength(6);
    expect(
      submitted
        .map((request) => request.aoa?.angles)
        .sort((a, b) => (a?.[0] ?? 0) - (b?.[0] ?? 0)),
    ).toEqual([
      [1, 1.25],
      [2, 2.25],
      [2.5, 2.75],
      [3.75, 4],
      [4.27, 4.52],
      [4.6, 5.6],
    ]);
    expect(
      submitted.every(
        (request) =>
          request.solver?.force_transient === true &&
          request.solver?.urans_fidelity === "precalc",
      ),
    ).toBe(true);
    const children = await db
      .select({
        parentJobId: simJobs.parentJobId,
        payload: simJobs.requestPayload,
        status: simJobs.status,
      })
      .from(simJobs)
      .where(
        and(
          inArray(simJobs.parentJobId, [
            campaignPromotion.parentJobId,
            backgroundPromotion.parentJobId,
            liveLeasePromotion.parentJobId,
            meshBlockedPromotion.parentJobId,
            typedMeshBlockedPromotion.parentJobId,
            typedInfrastructurePromotion.parentJobId,
            upgradeableMeshBlockedPromotion.parentJobId,
            cancelledBackgroundPromotion.parentJobId,
            cancelledParentCampaignOwnedWithBackgroundCoowner.parentJobId,
            cancelDuringSubmitPromotion.parentJobId,
          ]),
          eq(simJobs.wave, 2),
        ),
      );
    const submittedChildren = children.filter(
      (child) => child.status === "submitted",
    );
    expect(submittedChildren).toHaveLength(6);
    const upgradedMeshChildren = children.filter(
      (child) =>
        child.parentJobId === upgradeableMeshBlockedPromotion.parentJobId,
    );
    expect(upgradedMeshChildren).toHaveLength(2);
    expect(upgradedMeshChildren.map((child) => child.status).sort()).toEqual([
      "failed",
      "submitted",
    ]);
    expect(
      upgradedMeshChildren.find((child) => child.status === "submitted")
        ?.payload,
    ).toMatchObject({
      aoas: [4.6, 5.6],
      meshRecoveryVersion: 1,
      precalcObligationIds: upgradeableMeshBlockedPromotion.obligationIds,
    });
    const upgradedAttemptLedger = await db
      .select({
        obligationId: simPrecalcObligationAttempts.obligationId,
        attemptNumber: simPrecalcObligationAttempts.attemptNumber,
        state: simPrecalcObligationAttempts.state,
      })
      .from(simPrecalcObligationAttempts)
      .where(
        inArray(
          simPrecalcObligationAttempts.obligationId,
          upgradeableMeshBlockedPromotion.obligationIds,
        ),
      );
    for (const obligationId of upgradeableMeshBlockedPromotion.obligationIds) {
      expect(
        upgradedAttemptLedger
          .filter((attempt) => attempt.obligationId === obligationId)
          .sort((left, right) => left.attemptNumber - right.attemptNumber),
      ).toEqual([
        { obligationId, attemptNumber: 1, state: "failed" },
        { obligationId, attemptNumber: 2, state: "submitted" },
      ]);
    }
    expect(
      children.some(
        (child) =>
          child.parentJobId === meshBlockedPromotion.parentJobId &&
          child.status === "submitted",
      ),
    ).toBe(false);
    expect(
      children.some(
        (child) =>
          child.parentJobId === typedMeshBlockedPromotion.parentJobId &&
          child.status === "submitted",
      ),
    ).toBe(false);
    expect(
      children.some(
        (child) =>
          child.parentJobId === typedInfrastructurePromotion.parentJobId &&
          child.status === "submitted",
      ),
    ).toBe(true);
    expect(
      children.some(
        (child) =>
          child.parentJobId === cancelledBackgroundPromotion.parentJobId,
      ),
    ).toBe(false);
    expect(
      children.some(
        (child) =>
          child.parentJobId === cancelDuringSubmitPromotion.parentJobId &&
          child.status === "cancelled",
      ),
    ).toBe(true);
    expect(
      submittedChildren.every(
        (child) =>
          child.status === "submitted" &&
          Array.isArray(
            (child.payload as { precalcObligationIds?: unknown })
              .precalcObligationIds,
          ),
      ),
    ).toBe(true);
    const promotionByParent = new Map([
      [campaignPromotion.parentJobId, campaignPromotion.promotionId],
      [backgroundPromotion.parentJobId, backgroundPromotion.promotionId],
      [liveLeasePromotion.parentJobId, liveLeasePromotion.promotionId],
      [
        typedInfrastructurePromotion.parentJobId,
        typedInfrastructurePromotion.promotionId,
      ],
      [
        upgradeableMeshBlockedPromotion.parentJobId,
        upgradeableMeshBlockedPromotion.promotionId,
      ],
      [
        cancelledParentCampaignOwnedWithBackgroundCoowner.parentJobId,
        cancelledParentCampaignOwnedWithBackgroundCoowner.promotionId,
      ],
    ]);
    for (const child of submittedChildren) {
      expect(
        (child.payload as { conditionalPromotionId?: string })
          .conditionalPromotionId,
      ).toBe(promotionByParent.get(child.parentJobId!));
    }

    // Live children are the durable duplicate barrier: replaying the recovery
    // scan must neither submit nor compose a second child.
    expect(
      await uransLadderTick(db, engine, 0, recoveryScope(promotionIds)),
    ).toBe(false);
    expect(submitted).toHaveLength(6);
  }, 240000);
});
