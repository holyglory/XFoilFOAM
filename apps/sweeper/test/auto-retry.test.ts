// MUST-CATCH suite for clean failed-generation restart: an unexplained
// crash-class point is discarded and returned to ordinary scheduling. A later
// independent crash follows the same path; deterministic mesh, continuation,
// and accepted canonical cases stay on their explicit typed paths.
//
// Shaped like the real-world breakage class it guards: an engine job that
// dies with "All cases failed" and an EMPTY result payload (no points, no
// attempt evidence) — the true-crash branch of ingestFailedEngineJob — driven
// through the same reconcile() surface production runs.
//
//   1. FIRST crash  → every claimed cell is cleanly requeued (result → pending
//      with a last-restart marker, campaign point → requested, failed counter
//      0) — and the same job replay is idempotent.
//   2. SECOND crash → exactly the same clean restart; no cell/fleet incident
//      is created just because a prior generation also failed.
//   3. RE-INGEST of an abandoned failed job must not recreate its discarded
//      attempt/artifacts or re-claim the restarted cell.
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
  remoteAssetReferences,
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
  syncRemoteHubBindingReceipts,
  syncRemoteResultDeliveries,
  syncSweepPromisePoints,
  syncSweepPromises,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import type {
  EngineClient,
  JobResult,
  JobStatus,
  PolarRequest,
} from "@aerodb/engine-client";
import { and, asc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConditionMapEntry } from "../src/ingest";
import { ingestResult } from "../src/ingest";
import { submitCampaignBatch } from "../src/loop";
import { reconcile, submitUransRetryForJob } from "../src/reconcile";
import { resetUransLadderMemory, uransLadderTick } from "../src/urans-ladder";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-autoretry-${process.pid}-${Date.now().toString(36)}`;

// Keep the crash-only cells outside the low-AoA whole-polar promotion fixtures
// below. The tests deliberately share one immutable revision, so overlapping
// angles would let an unrelated promotion claim a crash-chain cell and make
// this file order-dependent.
const ANGLES = [31, 32, 33];
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
let crashCellIds: string[] = [];
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(",")}}`;
}

function crashEngine(
  engineJobId: string,
  reportedStatus: "failed" | "running" | Array<"failed" | "running"> = "failed",
): EngineClient {
  let statusCalls = 0;
  return {
    getQueue: async () => {
      throw new Error("queue unavailable in test");
    },
    getJob: async (): Promise<JobStatus> => {
      const state = Array.isArray(reportedStatus)
        ? reportedStatus[Math.min(statusCalls++, reportedStatus.length - 1)]
        : reportedStatus;
      return {
        job_id: engineJobId,
        state,
        total_cases: ANGLES.length,
        completed_cases: 0,
        message: CRASH_MESSAGE,
      };
    },
    getResult: async (): Promise<JobResult> => ({
      job_id: engineJobId,
      state: "failed",
      message: CRASH_MESSAGE,
      polars: [],
    }),
    deleteJob: async (jobId: string) => {
      deletedEngineJobIds.push(jobId);
      return { bytes_freed: 4_096 };
    },
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

async function crashCellRows() {
  expect(crashCellIds).toHaveLength(ANGLES.length);
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
    .where(inArray(results.id, crashCellIds))
    .orderBy(asc(results.aoaDeg));
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

describe("clean restart for crash-class failed points", () => {
  it("MUST-CATCH: the first crash discards its generation and requeues every cell (marker stamped, points reopen, failed counter 0)", async () => {
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
    crashCellIds = rows.map((row) => row.id);
    for (const row of rows) {
      expect(row.status).toBe("pending"); // re-claimable, NOT failed
      expect(row.autoRetriedAt).not.toBeNull(); // last clean-restart marker
      expect(row.simJobId).toBeNull();
      expect(row.error).toBeNull(); // failed generation projection discarded
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
    expect(deletedEngineJobIds).toContain(`${PREFIX}-engine-1`);
    const [stripped] = await db
      .select({
        strippedAt: simJobs.strippedAt,
        stripReport: simJobs.stripReport,
      })
      .from(simJobs)
      .where(eq(simJobs.id, firstJobId));
    expect(stripped.strippedAt).not.toBeNull();
    expect(stripped.stripReport).toMatchObject({
      bytes_freed: 4_096,
      note: "discarded failed generation after clean restart",
    });

    // Idempotence: a second pass over the same job retries NOTHING because its
    // cells are already pending under the fresh scheduler lifecycle.
    const again = await autoRetryCrashedResultsForJob(db, firstJobId);
    expect(again.retried).toEqual([]);
    expect(again.escalated).toEqual([]);
  }, 240000);

  it("MUST-CATCH: a terminal database retry never deletes an engine directory that still reports running", async () => {
    const engineJobId = `${PREFIX}-engine-still-running`;
    const jobId = await composeAndSubmit(engineJobId);

    // The failed result payload may have been published before the engine's
    // status endpoint catches up. The cells can be safely requeued, but the
    // directory must remain until both sources say terminal.
    await reconcile(db, crashEngine(engineJobId, ["failed", "running"]), {
      jobIds: [jobId],
      skipFailedRecovery: true,
    });

    const [job] = await db
      .select({ status: simJobs.status, strippedAt: simJobs.strippedAt })
      .from(simJobs)
      .where(eq(simJobs.id, jobId));
    expect(job.status).toBe("failed");
    expect(job.strippedAt).toBeNull();
    expect(deletedEngineJobIds).not.toContain(engineJobId);
    for (const row of await crashCellRows()) {
      expect(row.status).toBe("pending");
      expect(row.simJobId).toBeNull();
    }
  }, 240000);

  const registerTerminalSecondCrash = () =>
    it("MUST-CATCH: a second unexplained crash discards that generation too and reopens the cells", async () => {
      // The pending rows are ordinary gaps again: the next tick re-claims them.
      secondJobId = await composeAndSubmit(`${PREFIX}-engine-2`);
      expect(secondJobId).not.toBe(firstJobId);
      await reconcile(db, crashEngine(`${PREFIX}-engine-2`), {
        jobIds: [secondJobId],
        skipFailedRecovery: true,
      });

      const rows = await crashCellRows();
      for (const row of rows) {
        expect(row.status).toBe("pending");
        expect(row.autoRetriedAt).not.toBeNull();
        expect(row.error).toBeNull();
      }
      const points = await db
        .select({ state: simCampaignPoints.state })
        .from(simCampaignPoints)
        .where(eq(simCampaignPoints.campaignId, campaignId));
      expect(points.every((p) => p.state === "requested")).toBe(true);

      const totals = await campaignProgressTotals(db, campaignId);
      expect(totals.failed).toBe(0);
      expect(totals.blocked).toBe(0);
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
      expect(incidents).toHaveLength(0);
      const incidentSummary = await solverIncidentSummary(db, { campaignId });
      expect(incidentSummary).toMatchObject({
        occurrenceCount: 0,
        openCount: 0,
        criticalGroupCount: 0,
      });
      expect(incidentSummary.groups).toEqual([]);
    }, 240000);

  const registerTerminalReingest = () =>
    it("MUST-CATCH: re-ingesting an abandoned failed job cannot recreate the discarded generation", async () => {
      const before = await crashCellRows();
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

      const after = await crashCellRows();
      for (const row of after) {
        expect(row.status).toBe("pending");
        expect(row.autoRetriedAt).not.toBeNull();
        expect(row.error).toBeNull();
      }
      const replayAttempts = await db
        .select({ evidencePayload: resultAttempts.evidencePayload })
        .from(resultAttempts)
        .where(eq(resultAttempts.simJobId, secondJobId));
      expect(replayAttempts).toHaveLength(0);
      // The stale payload is ignored: it cannot turn a cleanly restarted cell
      // back into a terminal result or create replacement forensic attempts.
      const outcome = await autoRetryCrashedResultsForJob(db, secondJobId);
      expect(outcome.retried).toEqual([]);
      expect(outcome.escalated).toEqual([]);
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
      ).toHaveLength(0);
    }, 240000);

  const registerTerminalTypedRecovery = () =>
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
      const pointerNullInfrastructure = seeded.find(
        (row) => row.disposition === "infrastructure",
      )!;
      await db
        .update(results)
        .set({ currentResultAttemptId: null })
        .where(
          inArray(results.id, [
            pointerNullHard.resultId,
            pointerNullInfrastructure.resultId,
          ]),
        );

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
      // A deterministic mesh/configuration failure remains on its typed block
      // path; it does not manufacture a generic crash-retry incident.
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

  it("MUST-CATCH: an accepted canonical generation is never discarded or requeued with a later failed job", async () => {
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        campaignId: null,
        jobKind: "sweep",
        referenceChordM: CHORD,
        wave: 1,
        status: "failed",
        totalCases: 1,
      })
      .returning();
    const [result] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 0.875,
        // The failed outer job must never destroy an already selected exact
        // generation, even if an inconsistent legacy projection says failed.
        status: "failed",
        source: "solved",
        regime: "rans",
        cl: 0.41,
        cd: 0.018,
        simJobId: job.id,
        error: "later correction job crashed",
      })
      .returning();
    const [acceptedAttempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: result.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 0.875,
        simJobId: job.id,
        status: "done",
        source: "solved",
        regime: "rans",
        validForPolar: true,
        cl: 0.41,
        cd: 0.018,
        converged: true,
        evidencePayload: { fidelity: "rans" },
      })
      .returning();
    // A historical repair may have cleared mutable result pointers while the
    // append-only classification still declares the exact attempt accepted.
    // The clean-restart candidate must read this direct ownership relation,
    // rather than treating pointer-null as disposable.
    await db.insert(resultClassifications).values({
      resultId: result.id,
      resultAttemptId: acceptedAttempt.id,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 0.875,
      regime: "rans",
      classifierVersion: "auto-retry-pointer-null-accepted",
      state: "accepted",
      reasons: [],
    });

    const outcome = await autoRetryCrashedResultsForJob(db, job.id);
    expect(outcome.retried).toEqual([]);
    expect(outcome.precalcRouted).toEqual([]);
    expect(outcome.discardedFailedAttemptCount).toBe(0);

    const [preserved] = await db
      .select({
        status: results.status,
        simJobId: results.simJobId,
        currentResultAttemptId: results.currentResultAttemptId,
        cl: results.cl,
        cd: results.cd,
      })
      .from(results)
      .where(eq(results.id, result.id));
    expect(preserved).toEqual({
      status: "failed",
      simJobId: job.id,
      currentResultAttemptId: null,
      cl: 0.41,
      cd: 0.018,
    });
    expect(
      await db
        .select({ id: resultAttempts.id })
        .from(resultAttempts)
        .where(eq(resultAttempts.id, acceptedAttempt.id)),
    ).toHaveLength(1);
  }, 240000);

  it("MUST-CATCH: clean restart unlinks only disposable campaign/precalc/promise references before deleting the failed attempt", async () => {
    const aoaDeg = 301.337;
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "sweep",
        referenceChordM: CHORD,
        wave: 1,
        status: "failed",
        totalCases: 1,
      })
      .returning();
    const [result] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        status: "failed",
        source: "solved",
        regime: "rans",
        simJobId: job.id,
        error: "unexplained clean-restart fixture",
      })
      .returning();
    const [attempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: result.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        simJobId: job.id,
        status: "failed",
        source: "solved",
        regime: "rans",
        error: "unexplained clean-restart fixture",
        evidencePayload: { fixture: "clean-restart-disposable-owners" },
      })
      .returning();
    const [obligation] = await db
      .insert(simPrecalcObligations)
      .values({
        airfoilId,
        revisionId,
        aoaDeg,
        // A cancelled, unspent obligation is not a precalc route fence; it
        // simply models stale scheduling metadata that names this attempt.
        state: "cancelled",
        sourceResultId: result.id,
        sourceResultAttemptId: attempt.id,
      })
      .returning();
    const [promise] = await db
      .insert(syncSweepPromises)
      .values({
        sourceInstanceId: "clean-restart-fixture",
        sourceInstanceName: "Clean restart fixture",
        sourceBaseUrl: "https://fixture.invalid/sync",
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    const [promisePoint] = await db
      .insert(syncSweepPromisePoints)
      .values({
        promiseId: promise.id,
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        resultId: result.id,
        resultAttemptId: attempt.id,
      })
      .returning();
    await db.insert(remoteAssetReferences).values({
      localKind: "solver_evidence",
      localStorageKey: `${PREFIX}-discard-${attempt.id}`,
      resultId: result.id,
      resultAttemptId: attempt.id,
      remoteDownloadUrl: "https://fixture.invalid/evidence.tar.zst",
      mimeType: "application/zstd",
    });

    const outcome = await autoRetryCrashedResultsForJob(db, job.id);
    expect(outcome.retried.map((cell) => cell.resultId)).toEqual([result.id]);
    expect(outcome.discardedFailedAttemptCount).toBe(1);

    const [reopened] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, result.id));
    expect(reopened).toEqual({ status: "pending", simJobId: null });
    expect(
      await db
        .select({ id: resultAttempts.id })
        .from(resultAttempts)
        .where(eq(resultAttempts.id, attempt.id)),
    ).toEqual([]);
    const [unlinkedObligation] = await db
      .select({
        sourceResultId: simPrecalcObligations.sourceResultId,
        sourceResultAttemptId: simPrecalcObligations.sourceResultAttemptId,
      })
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, obligation.id));
    expect(unlinkedObligation).toEqual({
      sourceResultId: null,
      sourceResultAttemptId: null,
    });
    const [unlinkedPromise] = await db
      .select({
        resultId: syncSweepPromisePoints.resultId,
        resultAttemptId: syncSweepPromisePoints.resultAttemptId,
      })
      .from(syncSweepPromisePoints)
      .where(eq(syncSweepPromisePoints.id, promisePoint.id));
    expect(unlinkedPromise).toEqual({
      resultId: result.id,
      resultAttemptId: null,
    });
    expect(
      await db
        .select({ id: remoteAssetReferences.id })
        .from(remoteAssetReferences)
        .where(eq(remoteAssetReferences.resultId, result.id)),
    ).toEqual([]);
  }, 240000);

  it("MUST-CATCH: a pointer-null hub-bound remote generation is refused, not unlinked or discarded", async () => {
    const aoaDeg = 302.337;
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "sweep",
        referenceChordM: CHORD,
        wave: 1,
        status: "failed",
        totalCases: 1,
      })
      .returning();
    const [result] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        status: "failed",
        source: "solved",
        regime: "rans",
        simJobId: job.id,
        error: "legacy pointer-null hub fixture",
      })
      .returning();
    const [attempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: result.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        simJobId: job.id,
        status: "done",
        source: "solved",
        regime: "rans",
        evidencePayload: { fixture: "hub-binding-owner" },
      })
      .returning();
    const [promise] = await db
      .insert(syncSweepPromises)
      .values({
        sourceInstanceId: "hub-binding-fixture",
        sourceInstanceName: "Hub binding fixture",
        sourceBaseUrl: "https://fixture.invalid/sync",
        status: "cancelled",
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
        cancelledAt: new Date(),
      })
      .returning();
    await db.insert(syncSweepPromisePoints).values({
      promiseId: promise.id,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      status: "fulfilled",
      resultId: result.id,
      resultAttemptId: attempt.id,
    });
    const [delivery] = await db
      .insert(syncRemoteResultDeliveries)
      .values({
        promiseId: promise.id,
        simJobId: job.id,
        resultId: result.id,
        resultAttemptId: attempt.id,
        aoaDeg,
        generationKey: attempt.id,
        state: "delivered",
      })
      .returning();
    const brokeredUploadId = randomUUID();
    const receipt = {
      schemaVersion: 1,
      kind: "hub-canonical-evidence-binding",
      promiseId: promise.id,
      remoteResultId: result.id,
      remoteResultAttemptId: attempt.id,
      brokeredUploadId,
      aoaDeg,
      bindingState: "bound",
      promisePointState: "fulfilled",
    };
    const [binding] = await db
      .insert(syncRemoteHubBindingReceipts)
      .values({
        deliveryId: delivery.id,
        promiseId: promise.id,
        simJobId: job.id,
        resultId: result.id,
        resultAttemptId: attempt.id,
        aoaDeg,
        brokeredUploadId,
        receiptCanonical: canonicalJson(receipt),
        receipt,
        receiptHmac: "a".repeat(64),
      })
      .returning();

    const outcome = await autoRetryCrashedResultsForJob(db, job.id);
    expect(outcome.retried).toEqual([]);
    expect(outcome.discardedFailedAttemptCount).toBe(0);
    const [preserved] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, result.id));
    expect(preserved).toEqual({ status: "failed", simJobId: job.id });
    expect(
      await db
        .select({ id: syncRemoteHubBindingReceipts.id })
        .from(syncRemoteHubBindingReceipts)
        .where(eq(syncRemoteHubBindingReceipts.id, binding.id)),
    ).toHaveLength(1);

    // This leaves no restrict-owned fixture behind for the shared cleanup.
    await db
      .delete(syncRemoteHubBindingReceipts)
      .where(eq(syncRemoteHubBindingReceipts.id, binding.id));
    await db
      .delete(syncRemoteResultDeliveries)
      .where(eq(syncRemoteResultDeliveries.id, delivery.id));
    await db
      .delete(syncSweepPromises)
      .where(eq(syncSweepPromises.id, promise.id));
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
        archive_reduction_version: 4,
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

  // These scenarios intentionally leave current-generation critical state.
  // Register them only after every test which expects another engine
  // admission. The production-global latch must remain effective throughout
  // the terminal chain; file cleanup removes its owned campaign before the
  // exclusive lease restores the pre-file singleton.
  registerTerminalSecondCrash();
  registerTerminalReingest();
  registerTerminalTypedRecovery();
});
