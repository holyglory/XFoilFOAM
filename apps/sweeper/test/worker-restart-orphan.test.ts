// MUST-CATCH suite for the 2026-07-04 production incident: the engine's
// worker-boot orphan reconciliation (src/airfoilfoam/storage.py) marks jobs
// killed by a worker-container restart as state=failed with the pinned
// message "worker restarted mid-solve; task lost". The sweeper's failed-job
// ingest then terminal-failed 12 campaign points (+3 symmetry mirrors) with
// EMPTY error text — infrastructure interruption presented as fake failure
// evidence ("15 failed", errorClass 'unknown').
//
// Scenario A (orphan): a batched campaign job dies mid-solve with a partial
// result (1 solved case, 2 unsolved). Required behavior: the solved case
// ingests as real done evidence, the unsolved claims are RELEASED back to
// pending (re-claimable next tick), ZERO results rows are failed, the
// campaign failed counter stays 0, and the sim_job terminates 'cancelled'
// with a truthful message.
//
// Scenario B (genuine repeated failure): the same batched shape but a REAL
// engine failure must retain the failed evidence and message. After the one
// automatic retry is exhausted it becomes a grouped critical screening
// incident, not a user-terminal failed point or manual-requeue item.
//
// Follows the campaign-batching.test.ts live-DB pattern (scoped rows, full
// cleanup in afterAll).

import "./enabled-engine-pool-fixture";

import {
  airfoils,
  boundaryProfiles,
  campaignFailures,
  categories,
  createClient,
  findCampaignGapBatch,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  outputProfiles,
  polarFitSets,
  resultAttempts,
  resultClassifications,
  results,
  simCampaignPoints,
  simCampaignProgress,
  simJobs,
  simPrecalcObligations,
  simUransVerifyQueue,
  solverIncidentSummary,
  solverProfiles,
  sweeperState,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import {
  WORKER_RESTART_ORPHAN_MESSAGE,
  type EngineClient,
  type JobResult,
  type JobStatus,
  type PolarRequest,
} from "@aerodb/engine-client";
import { and, asc, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConditionMapEntry } from "../src/ingest";
import { drainArchiveReductionQueue } from "../src/archive-reduction-queue";
import { runLoop, submitCampaignBatch } from "../src/loop";
import {
  guardedReceiptCandidateDigest,
  LEGACY_GATEWAY_AFFECTED_RUNTIME,
  repairGuardedReceiptRetryRollback,
  reconcileGuardedEngineReceipt,
  type GuardedEngineReceipt,
} from "../src/maintenance-receipt-reconcile-cli";
import { reconcile, resetOrphans } from "../src/reconcile";
import { transferRemoteSolverTick } from "../src/remote-solver";
import { withExactManifestEvidence } from "./exact-result-fixture";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-orphan-${process.pid}-${Date.now().toString(36)}`;

const ANGLES = [6, 7, 8];
// File-unique chord: reference_geometry_profiles dedupe on canonical physical
// keys, so sharing 0.2/1 with campaign-batching.test.ts entangles the two
// parallel files' fixture graphs (the F9 flake). Every campaign-launching
// suite must pick a chord no other suite uses.
const CHORD = 0.19;
const SOLVED_AOA = 6;
const NU = 1.789e-5 / 1.225;

let orphanCampaignId = "";
let genuineCampaignId = "";
let receiptCampaignId = "";
let unrelatedReceiptCampaignId = "";
let cancelledReceiptCampaignId = "";
let orphanReceiptCampaignId = "";
let startupDrainCampaignId = "";
let receiptRouteFenceCampaignId = "";
let receiptMessageSemanticsCampaignId = "";
let receiptExpiredLegacyLeaseCampaignId = "";
let receiptRetryRollbackRepairCampaignId = "";
let airfoilId = "";
let categoryId = "";
let mediumId = "";
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

/** The shared Vitest DB can contain unrelated active jobs or a fence emitted
 * by a previous test in this suite. These tests exercise evidence ingestion,
 * not global admission policy, so establish a bounded fixture-local envelope
 * and restore its complete fence shape afterwards. */
async function resumeSuiteAdmissionEnvelope(): Promise<void> {
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
        maintenanceDrainToken: null,
        maintenanceDrainStartedAt: null,
      },
    });
}

async function enterReceiptMaintenanceDrain(token: string): Promise<void> {
  await db
    .insert(sweeperState)
    .values({
      id: 1,
      enabled: false,
      maxConcurrentJobs: 0,
      cpuSlots: 0,
      admissionFenceActive: false,
      maintenanceDrainToken: token,
      maintenanceDrainStartedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: sweeperState.id,
      set: {
        enabled: false,
        maxConcurrentJobs: 0,
        cpuSlots: 0,
        admissionFenceActive: false,
        maintenanceDrainToken: token,
        maintenanceDrainStartedAt: new Date(),
      },
    });
}

function guardedReceipt(
  maintenanceToken: string,
  candidates: GuardedEngineReceipt["candidates"],
): GuardedEngineReceipt {
  return {
    schemaVersion: 1,
    maintenanceToken,
    affectedRuntime: LEGACY_GATEWAY_AFFECTED_RUNTIME,
    authoritativeObservedAt: "2026-08-02T12:00:00.000Z",
    candidates,
    candidateDigest: guardedReceiptCandidateDigest(candidates),
  };
}

const camberedPoints = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

function conditionMapOf(payload: unknown): ConditionMapEntry[] {
  return ((payload as { conditionMap?: ConditionMapEntry[] })?.conditionMap ??
    []) as ConditionMapEntry[];
}

async function launchCampaign(
  name: string,
  speed: number,
  idemKey: string,
): Promise<string> {
  const launch = await materializeCampaignLaunch(db, {
    name,
    priority: 8,
    idempotencyKey: idemKey,
    airfoilIds: [airfoilId],
    plan: {
      mediumId,
      ambients: [[288.15, 101325]],
      speedsMps: [speed],
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
  return launch.campaign.id;
}

async function composeAndSubmit(
  campaignId: string,
  engineJobId: string,
): Promise<{ jobId: string; entry: ConditionMapEntry }> {
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
  const submitted = await submitCampaignBatch(db, composeEngine, batch, 0, 0);
  expect(submitted).toBe(true);
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
  const entries = conditionMapOf(job.requestPayload);
  expect(entries.length).toBe(1);
  return { jobId: job.id, entry: entries[0] };
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
  await resumeSuiteAdmissionEnvelope();

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
});

afterAll(async () => {
  // Campaign fixture graph (evidence → jobs → campaigns → presets → guarded
  // find-or-create registry rows → sweeps) is owned by the shared helper —
  // registry rows are canonical-key deduped and can be referenced by parallel
  // suites, so hand-rolled unconditional deletes flake (DecisionHistory F9).
  await cleanupCampaignFixtures(db, {
    campaignIds: [
      orphanCampaignId,
      genuineCampaignId,
      receiptCampaignId,
      unrelatedReceiptCampaignId,
      cancelledReceiptCampaignId,
      orphanReceiptCampaignId,
      startupDrainCampaignId,
      receiptRouteFenceCampaignId,
      receiptMessageSemanticsCampaignId,
      receiptExpiredLegacyLeaseCampaignId,
      receiptRetryRollbackRepairCampaignId,
    ].filter(Boolean),
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

describe("worker-restart orphan: interrupted campaign points release, never fail", () => {
  it("MUST-CATCH: a maintenance receipt fences direct and startup orphan recovery", async () => {
    const DRAIN_TOKEN = "d7625b77-d089-4dd9-b8a2-b3897fe67ea0";
    startupDrainCampaignId = await launchCampaign(
      `${PREFIX} startup drain fence`,
      29,
      `${PREFIX}-startup-drain-fence`,
    );
    const { jobId } = await composeAndSubmit(
      startupDrainCampaignId,
      `${PREFIX}-startup-drain-engine-job`,
    );
    await db
      .update(simJobs)
      .set({ status: "pending", engineState: "submitting" })
      .where(eq(simJobs.id, jobId));

    await enterReceiptMaintenanceDrain(DRAIN_TOKEN);
    try {
      // A direct caller must be inert while the private receipt owns the
      // drain. This covers recovery helpers invoked outside `runLoop`.
      await resetOrphans(db, { jobIds: [jobId] });
      let [afterDirect] = await db
        .select({ status: simJobs.status, engineState: simJobs.engineState })
        .from(simJobs)
        .where(eq(simJobs.id, jobId));
      expect(afterDirect).toEqual({
        status: "pending",
        engineState: "submitting",
      });

      // A pre-aborted loop executes its startup branch but no tick. The
      // pending composition must stay untouched: restart recovery cannot
      // race the receipt's exclusive canonical ownership.
      const controller = new AbortController();
      controller.abort();
      await runLoop(db, {} as EngineClient, controller.signal);
      [afterDirect] = await db
        .select({ status: simJobs.status, engineState: simJobs.engineState })
        .from(simJobs)
        .where(eq(simJobs.id, jobId));
      expect(afterDirect).toEqual({
        status: "pending",
        engineState: "submitting",
      });

      // Receipt ownership also fences every ordinary background writer. Those
      // drains otherwise can create publication receipts or mutate remote
      // promise delivery/cancellation rows while the private reconciliation
      // owns canonical settlement.
      await expect(
        drainArchiveReductionQueue(db, {} as EngineClient, {
          archiveReductionVersion: 1,
        }),
      ).resolves.toMatchObject({
        scanned: 0,
        enqueued: 0,
        processed: 0,
        admittedResultAttemptIds: [],
      });
      await expect(
        transferRemoteSolverTick(db, {} as EngineClient),
      ).resolves.toBe(false);
    } finally {
      await resumeSuiteAdmissionEnvelope();
    }
  }, 120000);

  it("MUST-CATCH: a receipt token replacement stops failed RANS follow-on recovery", async () => {
    const DRAIN_TOKEN = "17d4d3b8-5689-43c2-a1d9-1bbd8871ad44";
    const REPLACEMENT_TOKEN = "9505907f-28df-4a62-bc94-f99af77abcef";
    const ENGINE_JOB = "0a20f209-6b5a-4ab9-ae36-33277b475688";
    const FAILURE = "All cases failed";
    receiptRouteFenceCampaignId = await launchCampaign(
      `${PREFIX} receipt route fence`,
      28,
      `${PREFIX}-receipt-route-fence`,
    );
    const { jobId, entry } = await composeAndSubmit(
      receiptRouteFenceCampaignId,
      ENGINE_JOB,
    );
    await db
      .update(simJobs)
      .set({ status: "running", engineState: "running" })
      .where(eq(simJobs.id, jobId));

    const failedResult = withExactManifestEvidence({
      job_id: ENGINE_JOB,
      state: "failed" as const,
      message: FAILURE,
      polars: [
        {
          speed: 28,
          chord: CHORD,
          reynolds: Math.round((28 * CHORD) / NU),
          mach: 28 / 340.3,
          points: [],
          attempts: ANGLES.map((aoaDeg) => ({
            aoa_deg: aoaDeg,
            cl: 0.5,
            cd: 0.03,
            cm: -0.04,
            cl_cd: 16.67,
            unsteady: false,
            converged: false,
            first_order_fallback: false,
            failure_disposition: "hard_solver" as const,
            images: {},
          })),
        },
      ],
    });
    const candidate: GuardedEngineReceipt["candidates"][number] = {
      jobId,
      engineJobId: ENGINE_JOB,
      databaseStatus: "running",
      engineStatus: "failed",
      engineMessage: FAILURE,
      statusSha256: "7".repeat(64),
      resultSha256: "8".repeat(64),
      settlementAction: "ingest",
    };
    const engine = {
      getJob: async (): Promise<JobStatus> => ({
        job_id: ENGINE_JOB,
        state: "failed",
        message: FAILURE,
        total_cases: ANGLES.length,
        completed_cases: 0,
        failure_disposition: "hard_solver",
      }),
      getResult: async (): Promise<JobResult> => failedResult,
      submitPolar: async () => {
        throw new Error("receipt scope must never submit CFD");
      },
    } as unknown as EngineClient;

    await enterReceiptMaintenanceDrain(DRAIN_TOKEN);
    try {
      const initialRoutes = await db
        .select({ id: simPrecalcObligations.id })
        .from(simPrecalcObligations)
        .where(
          and(
            eq(simPrecalcObligations.airfoilId, airfoilId),
            eq(simPrecalcObligations.revisionId, entry.revisionId),
          ),
        );
      expect(initialRoutes).toEqual([]);
      let followOnGuards = 0;
      await expect(
        reconcile(db, engine, {
          jobIds: [jobId],
          receiptScopedMaintenance: {
            maintenanceToken: DRAIN_TOKEN,
            candidates: [candidate],
          },
          testHooks: {
            // Retire the receipt at the first follow-on guard. It runs before
            // the cache re-fit and before any durable FAST obligation.
            beforeReceiptRouteMutation: async () => {
              followOnGuards += 1;
              if (followOnGuards === 1) {
                await enterReceiptMaintenanceDrain(REPLACEMENT_TOKEN);
              }
            },
          },
        }),
      ).rejects.toThrow("ingest lease");
      expect(followOnGuards).toBe(1);

      // The initial exact campaign handoff is part of the evidence publication
      // that occurred under the still-live receipt, so its three direct FAST
      // routes may remain. Once the token flips, though, the later
      // cache/route pass cannot complete the parent or compose a child.
      const routes = await db
        .select({ aoaDeg: simPrecalcObligations.aoaDeg })
        .from(simPrecalcObligations)
        .where(
          and(
            eq(simPrecalcObligations.airfoilId, airfoilId),
            eq(simPrecalcObligations.revisionId, entry.revisionId),
          ),
        );
      expect(routes.map((route) => route.aoaDeg).sort((a, b) => a - b)).toEqual(
        ANGLES,
      );
      const children = await db
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(eq(simJobs.parentJobId, jobId));
      expect(children).toEqual([]);
      const [after] = await db
        .select({
          status: simJobs.status,
          engineState: simJobs.engineState,
          ingestLeaseToken: simJobs.ingestLeaseToken,
        })
        .from(simJobs)
        .where(eq(simJobs.id, jobId));
      expect(after.status).toBe("ingesting");
      expect(after.engineState).toBe("running");
      expect(after.ingestLeaseToken).not.toBeNull();
    } finally {
      await resumeSuiteAdmissionEnvelope();
    }
  }, 120000);

  it("MUST-CATCH: a hash-pinned failed result may omit status.json's message, while receipt drift remains non-mutating", async () => {
    // This is the exact legacy production shape: status.json has the
    // operator-visible terminal reason, while result.json is independently
    // hash-pinned but leaves its optional message null. Engine job IDs are
    // lower-case 32-hex (not database UUIDs).
    const DRAIN_TOKEN = "6098271d-329d-4b1e-9f9e-20e6270c6e64";
    const ENGINE_JOB = "1696efb95ef24e6890af87870248e78d";
    const FAILURE = "All cases failed";
    receiptMessageSemanticsCampaignId = await launchCampaign(
      `${PREFIX} receipt message semantics`,
      27,
      `${PREFIX}-receipt-message-semantics`,
    );
    const { jobId } = await composeAndSubmit(
      receiptMessageSemanticsCampaignId,
      ENGINE_JOB,
    );
    await db
      .update(simJobs)
      .set({ status: "running", engineState: "running" })
      .where(eq(simJobs.id, jobId));

    const candidate: GuardedEngineReceipt["candidates"][number] = {
      jobId,
      engineJobId: ENGINE_JOB,
      databaseStatus: "running",
      engineStatus: "failed",
      engineMessage: FAILURE,
      statusSha256: "c".repeat(64),
      resultSha256: "d".repeat(64),
      settlementAction: "ingest",
    };
    const failedResult = withExactManifestEvidence({
      job_id: ENGINE_JOB,
      state: "failed" as const,
      // The result payload is an independent document: it may intentionally
      // omit this status-owned message and must not be rejected for that.
      message: null,
      polars: [
        {
          speed: 27,
          chord: CHORD,
          reynolds: Math.round((27 * CHORD) / NU),
          mach: 27 / 340.3,
          points: [],
          attempts: ANGLES.map((aoaDeg) => ({
            aoa_deg: aoaDeg,
            cl: 0.5,
            cd: 0.03,
            cm: -0.04,
            cl_cd: 16.67,
            unsteady: false,
            converged: false,
            first_order_fallback: false,
            failure_disposition: "hard_solver" as const,
            images: {},
          })),
        },
      ],
    });
    const receipt = guardedReceipt(DRAIN_TOKEN, [candidate]);
    const status = (message = FAILURE): JobStatus => ({
      job_id: ENGINE_JOB,
      state: "failed",
      message,
      total_cases: ANGLES.length,
      completed_cases: 0,
      failure_disposition: "hard_solver",
    });

    const [initialJob] = await db
      .select({
        status: simJobs.status,
        engineState: simJobs.engineState,
        error: simJobs.error,
        ingestedAt: simJobs.ingestedAt,
        finishedAt: simJobs.finishedAt,
        ingestLeaseToken: simJobs.ingestLeaseToken,
        ingestLeaseClaimedAt: simJobs.ingestLeaseClaimedAt,
        ingestLeaseExpiresAt: simJobs.ingestLeaseExpiresAt,
      })
      .from(simJobs)
      .where(eq(simJobs.id, jobId));
    const initialProjection = await db
      .select({
        aoaDeg: results.aoaDeg,
        status: results.status,
        source: results.source,
        simJobId: results.simJobId,
        engineJobId: results.engineJobId,
        currentResultAttemptId: results.currentResultAttemptId,
        error: results.error,
      })
      .from(results)
      .where(eq(results.simJobId, jobId))
      .orderBy(asc(results.aoaDeg));

    const assertNoCanonicalSettlement = async () => {
      const [job] = await db
        .select({
          status: simJobs.status,
          engineState: simJobs.engineState,
          error: simJobs.error,
          ingestedAt: simJobs.ingestedAt,
          finishedAt: simJobs.finishedAt,
          ingestLeaseToken: simJobs.ingestLeaseToken,
          ingestLeaseClaimedAt: simJobs.ingestLeaseClaimedAt,
          ingestLeaseExpiresAt: simJobs.ingestLeaseExpiresAt,
        })
        .from(simJobs)
        .where(eq(simJobs.id, jobId));
      expect(job).toEqual(initialJob);
      const projection = await db
        .select({
          aoaDeg: results.aoaDeg,
          status: results.status,
          source: results.source,
          simJobId: results.simJobId,
          engineJobId: results.engineJobId,
          currentResultAttemptId: results.currentResultAttemptId,
          error: results.error,
        })
        .from(results)
        .where(eq(results.simJobId, jobId))
        .orderBy(asc(results.aoaDeg));
      expect(projection).toEqual(initialProjection);
      const attempts = await db
        .select({ id: resultAttempts.id })
        .from(resultAttempts)
        .where(eq(resultAttempts.simJobId, jobId));
      expect(attempts).toEqual([]);
    };

    await enterReceiptMaintenanceDrain(DRAIN_TOKEN);
    try {
      let resultReads = 0;
      await expect(
        reconcileGuardedEngineReceipt(
          db,
          {
            getJob: async (_engineJobId: string, opts?: unknown) => {
              expect(
                (opts as { expectedPayloadSha256?: string } | undefined)
                  ?.expectedPayloadSha256,
              ).toBe(candidate.statusSha256);
              return status("a changed status message");
            },
            getResult: async () => {
              resultReads += 1;
              return failedResult;
            },
          } as unknown as EngineClient,
          receipt,
        ),
      ).rejects.toThrow("engine identity, terminal state, or message drifted");
      expect(resultReads).toBe(0);
      await assertNoCanonicalSettlement();

      await expect(
        reconcileGuardedEngineReceipt(
          db,
          {
            getJob: async (_engineJobId: string, opts?: unknown) => {
              expect(
                (opts as { expectedPayloadSha256?: string } | undefined)
                  ?.expectedPayloadSha256,
              ).toBe(candidate.statusSha256);
              return status();
            },
            getResult: async (_engineJobId: string, opts?: unknown) => {
              expect(
                (opts as { expectedPayloadSha256?: string } | undefined)
                  ?.expectedPayloadSha256,
              ).toBe(candidate.resultSha256);
              // EngineClient rejects before parsing when this raw-document
              // digest differs; the receipt path must leave DB truth alone.
              throw new Error("engine result source digest changed");
            },
          } as unknown as EngineClient,
          receipt,
        ),
      ).rejects.toThrow("source digest changed");
      await assertNoCanonicalSettlement();

      for (const result of [
        // The result can never identify a different engine job, even when
        // its raw document digest was authenticated by the engine client.
        { ...failedResult, job_id: "2696efb95ef24e6890af87870248e78d" },
        // Nor can a completed result replace the receipt's failed terminal
        // state simply because it shares the expected result digest.
        { ...failedResult, state: "completed" as const },
      ] as const) {
        await expect(
          reconcileGuardedEngineReceipt(
            db,
            {
              getJob: async () => status(),
              getResult: async (_engineJobId: string, opts?: unknown) => {
                expect(
                  (opts as { expectedPayloadSha256?: string } | undefined)
                    ?.expectedPayloadSha256,
                ).toBe(candidate.resultSha256);
                return result;
              },
            } as unknown as EngineClient,
            receipt,
          ),
        ).rejects.toThrow("result identity or terminal state drifted");
        await assertNoCanonicalSettlement();
      }

      const report = await reconcileGuardedEngineReceipt(
        db,
        {
          getJob: async (_engineJobId: string, opts?: unknown) => {
            expect(
              (opts as { expectedPayloadSha256?: string } | undefined)
                ?.expectedPayloadSha256,
            ).toBe(candidate.statusSha256);
            return status();
          },
          getResult: async (_engineJobId: string, opts?: unknown) => {
            expect(
              (opts as { expectedPayloadSha256?: string } | undefined)
                ?.expectedPayloadSha256,
            ).toBe(candidate.resultSha256);
            return failedResult;
          },
          submitPolar: async () => {
            throw new Error("receipt scope must never submit CFD");
          },
        } as unknown as EngineClient,
        receipt,
      );
      expect(report).toMatchObject({
        terminalJobIds: [jobId],
        activeJobIds: [],
        nonterminalJobIds: [],
      });
      const [settledJob] = await db
        .select({
          status: simJobs.status,
          engineState: simJobs.engineState,
          error: simJobs.error,
          ingestedAt: simJobs.ingestedAt,
        })
        .from(simJobs)
        .where(eq(simJobs.id, jobId));
      expect(settledJob).toMatchObject({
        status: "failed",
        engineState: "failed",
        error: FAILURE,
      });
      expect(settledJob.ingestedAt).not.toBeNull();
      const attempts = await db
        .select({ id: resultAttempts.id })
        .from(resultAttempts)
        .where(eq(resultAttempts.simJobId, jobId));
      expect(attempts).toHaveLength(ANGLES.length);
    } finally {
      await resumeSuiteAdmissionEnvelope();
    }
  }, 120000);

  it("MUST-CATCH: a failed receipt read restores an expired legacy ingesting candidate for an immediate identical retry", async () => {
    const ENGINE_JOB = "f6bc6ab5f9f94a09907b4d2a9c6e8134";
    const DRAIN_TOKEN = "b469bead-95d8-4cee-aad1-9ee64bf478e1";
    receiptExpiredLegacyLeaseCampaignId = await launchCampaign(
      `${PREFIX} receipt expired legacy lease`,
      35,
      `${PREFIX}-receipt-expired-legacy-lease`,
    );
    const { jobId } = await composeAndSubmit(
      receiptExpiredLegacyLeaseCampaignId,
      ENGINE_JOB,
    );
    const legacyUpdatedAt = new Date(Date.now() - 11 * 60_000);
    await db
      .update(simJobs)
      .set({
        status: "ingesting",
        engineState: "running",
        ingestLeaseToken: null,
        ingestLeaseClaimedAt: null,
        ingestLeaseExpiresAt: null,
        updatedAt: legacyUpdatedAt,
      })
      .where(eq(simJobs.id, jobId));

    const candidate: GuardedEngineReceipt["candidates"][number] = {
      jobId,
      engineJobId: ENGINE_JOB,
      databaseStatus: "ingesting",
      engineStatus: "completed",
      engineMessage: null,
      statusSha256: "a".repeat(64),
      resultSha256: "b".repeat(64),
      settlementAction: "ingest",
    };
    const receipt = guardedReceipt(DRAIN_TOKEN, [candidate]);
    const completedResult = withExactManifestEvidence({
      job_id: ENGINE_JOB,
      state: "completed" as const,
      polars: [
        {
          speed: 35,
          chord: CHORD,
          reynolds: Math.round((35 * CHORD) / NU),
          mach: 35 / 340.3,
          points: ANGLES.map((aoaDeg) => ({
            aoa_deg: aoaDeg,
            cl: 0.45 + aoaDeg / 100,
            cd: 0.025,
            cm: -0.035,
            cl_cd: 20,
            stalled: false,
            unsteady: false,
            converged: true,
            first_order_fallback: false,
            fidelity: "rans" as const,
            images: {},
          })),
        },
      ],
    });
    let resultReads = 0;
    const engine = {
      getJob: async (
        _engineJobId: string,
        opts?: unknown,
      ): Promise<JobStatus> => {
        expect(
          (opts as { expectedPayloadSha256?: string } | undefined)
            ?.expectedPayloadSha256,
        ).toBe(candidate.statusSha256);
        return {
          job_id: ENGINE_JOB,
          state: "completed",
          total_cases: ANGLES.length,
          completed_cases: ANGLES.length,
        };
      },
      getResult: async (
        _engineJobId: string,
        opts?: unknown,
      ): Promise<JobResult> => {
        expect(
          (opts as { expectedPayloadSha256?: string } | undefined)
            ?.expectedPayloadSha256,
        ).toBe(candidate.resultSha256);
        resultReads += 1;
        if (resultReads === 1) {
          throw new Error("legacy result certificate read failed");
        }
        return completedResult;
      },
      submitPolar: async () => {
        throw new Error("receipt scope must never submit CFD");
      },
    } as unknown as EngineClient;

    await enterReceiptMaintenanceDrain(DRAIN_TOKEN);
    try {
      await expect(
        reconcileGuardedEngineReceipt(db, engine, receipt),
      ).rejects.toThrow("legacy result certificate read failed");

      const [restored] = await db
        .select({
          status: simJobs.status,
          engineState: simJobs.engineState,
          ingestLeaseToken: simJobs.ingestLeaseToken,
          ingestLeaseClaimedAt: simJobs.ingestLeaseClaimedAt,
          ingestLeaseExpiresAt: simJobs.ingestLeaseExpiresAt,
          updatedAt: simJobs.updatedAt,
          // Keep this predicate byte-for-byte equivalent in meaning to the
          // production receipt preflight. A freshly updated tokenless legacy
          // row would incorrectly be live without the explicit expiry marker.
          ingestLeaseLive: drizzleSql<boolean>`(
            ${simJobs.status} = 'ingesting'
            AND (
              ${simJobs.ingestLeaseExpiresAt} > now()
              OR (
                ${simJobs.ingestLeaseExpiresAt} IS NULL
                AND ${simJobs.updatedAt} > now() - (600000 * interval '1 millisecond')
              )
            )
          )`,
        })
        .from(simJobs)
        .where(eq(simJobs.id, jobId));
      expect(restored).toMatchObject({
        status: "ingesting",
        engineState: "running",
        ingestLeaseToken: null,
        ingestLeaseClaimedAt: null,
        ingestLeaseLive: false,
      });
      expect(restored.ingestLeaseExpiresAt?.getTime()).toBe(0);
      expect(restored.updatedAt.getTime()).toBeGreaterThan(
        legacyUpdatedAt.getTime(),
      );

      // No grace-period wait or row rewrite: the exact same watcher receipt
      // immediately reclaims the explicitly expired marker and settles.
      const report = await reconcileGuardedEngineReceipt(db, engine, receipt);
      expect(report).toMatchObject({
        terminalJobIds: [jobId],
        activeJobIds: [],
        nonterminalJobIds: [],
      });
      expect(resultReads).toBe(2);

      // A completed identical retry is also a read-free no-op.
      const idempotentReport = await reconcileGuardedEngineReceipt(
        db,
        engine,
        receipt,
      );
      expect(idempotentReport).toEqual(report);
      expect(resultReads).toBe(2);
    } finally {
      await resumeSuiteAdmissionEnvelope();
    }
  }, 120000);

  it("MUST-CATCH: repairs only the receipt-bound pre-fix running rollback and leaves it immediately reclaimable", async () => {
    const ENGINE_JOB = "f6bc6ab5f9f94a09907b4d2a9c6e8134";
    const DRAIN_TOKEN = "79aa3f33-96b2-46e9-8151-698e1f1de606";
    receiptRetryRollbackRepairCampaignId = await launchCampaign(
      `${PREFIX} receipt retry rollback repair`,
      36,
      `${PREFIX}-receipt-retry-rollback-repair`,
    );
    const { jobId } = await composeAndSubmit(
      receiptRetryRollbackRepairCampaignId,
      ENGINE_JOB,
    );
    // Exact state left by the old receipt failure path: the immutable receipt
    // originally captured an ingesting/completed row, but a failed legacy
    // result read cleared its lease and returned it to running.
    await db
      .update(simJobs)
      .set({
        status: "running",
        engineState: "completed",
        error: "legacy result certificate read failed",
        ingestedAt: null,
        finishedAt: null,
        ingestLeaseToken: null,
        ingestLeaseClaimedAt: null,
        ingestLeaseExpiresAt: null,
      })
      .where(eq(simJobs.id, jobId));
    const candidate: GuardedEngineReceipt["candidates"][number] = {
      jobId,
      engineJobId: ENGINE_JOB,
      databaseStatus: "ingesting",
      engineStatus: "completed",
      engineMessage: null,
      statusSha256: "c".repeat(64),
      resultSha256: "d".repeat(64),
      settlementAction: "ingest",
    };
    const receipt = guardedReceipt(DRAIN_TOKEN, [candidate]);

    await enterReceiptMaintenanceDrain(DRAIN_TOKEN);
    try {
      await expect(
        repairGuardedReceiptRetryRollback(db, receipt),
      ).resolves.toEqual({
        schemaVersion: 1,
        mode: "receipt-retry-rollback-repair",
        repairedJobIds: [jobId],
        alreadyRestoredJobIds: [],
      });

      const [restored] = await db
        .select({
          status: simJobs.status,
          engineState: simJobs.engineState,
          error: simJobs.error,
          ingestedAt: simJobs.ingestedAt,
          finishedAt: simJobs.finishedAt,
          ingestLeaseToken: simJobs.ingestLeaseToken,
          ingestLeaseClaimedAt: simJobs.ingestLeaseClaimedAt,
          ingestLeaseExpiresAt: simJobs.ingestLeaseExpiresAt,
          ingestLeaseLive: drizzleSql<boolean>`(
            ${simJobs.status} = 'ingesting'
            AND (
              ${simJobs.ingestLeaseExpiresAt} > now()
              OR (
                ${simJobs.ingestLeaseExpiresAt} IS NULL
                AND ${simJobs.updatedAt} > now() - (600000 * interval '1 millisecond')
              )
            )
          )`,
        })
        .from(simJobs)
        .where(eq(simJobs.id, jobId));
      expect(restored).toMatchObject({
        status: "ingesting",
        engineState: "completed",
        error: "legacy result certificate read failed",
        ingestedAt: null,
        finishedAt: null,
        ingestLeaseToken: null,
        ingestLeaseClaimedAt: null,
        ingestLeaseLive: false,
      });
      expect(restored.ingestLeaseExpiresAt?.getTime()).toBe(0);

      // The same preconditioned operation cannot broaden the repair scope or
      // rewrite this restored row on a repeat invocation.
      await expect(
        repairGuardedReceiptRetryRollback(db, receipt),
      ).resolves.toEqual({
        schemaVersion: 1,
        mode: "receipt-retry-rollback-repair",
        repairedJobIds: [],
        alreadyRestoredJobIds: [jobId],
      });

      // Older safe restores used the just-expired original lease timestamp
      // rather than the epoch marker. That row is already reclaimable, so the
      // receipt-bound repair must leave it untouched instead of refusing the
      // whole recovery window.
      const [drain] = await db
        .select({ startedAt: sweeperState.maintenanceDrainStartedAt })
        .from(sweeperState)
        .where(eq(sweeperState.id, 1));
      if (!drain?.startedAt) {
        throw new Error("test maintenance drain is missing its start time");
      }
      const drainStartedAt = drain.startedAt;
      const legacyExpiredLease = new Date(drainStartedAt.getTime() - 1);
      await db
        .update(simJobs)
        .set({ ingestLeaseExpiresAt: legacyExpiredLease })
        .where(eq(simJobs.id, jobId));
      await expect(
        repairGuardedReceiptRetryRollback(db, receipt),
      ).resolves.toEqual({
        schemaVersion: 1,
        mode: "receipt-retry-rollback-repair",
        repairedJobIds: [],
        alreadyRestoredJobIds: [jobId],
      });
      const [legacyRestored] = await db
        .select({ ingestLeaseExpiresAt: simJobs.ingestLeaseExpiresAt })
        .from(simJobs)
        .where(eq(simJobs.id, jobId));
      expect(legacyRestored.ingestLeaseExpiresAt?.getTime()).toBe(
        legacyExpiredLease.getTime(),
      );

      // Even an already-expired lease acquired after the owned drain began is
      // not a retry-safe legacy state. Refusing it proves the compatibility
      // path does not weaken ownership fencing during maintenance.
      await db
        .update(simJobs)
        .set({
          ingestLeaseExpiresAt: new Date(drainStartedAt.getTime() + 1),
        })
        .where(eq(simJobs.id, jobId));
      await expect(
        repairGuardedReceiptRetryRollback(db, receipt),
      ).rejects.toThrow("is not the exact known rollback shape");

      // A candidate whose original receipt says `running` cannot be repaired
      // by this command, even if its current row happens to be terminal-ish.
      const wrongReceipt = guardedReceipt(DRAIN_TOKEN, [
        { ...candidate, databaseStatus: "running" },
      ]);
      await expect(
        repairGuardedReceiptRetryRollback(db, wrongReceipt),
      ).rejects.toThrow("contains no completed ingesting candidate");
    } finally {
      await resumeSuiteAdmissionEnvelope();
    }
  }, 120000);

  it("ingests solved partial evidence, releases the rest, fails NOTHING, campaign failed counter stays 0", async () => {
    orphanCampaignId = await launchCampaign(
      `${PREFIX} orphan campaign`,
      10,
      `${PREFIX}-orphan-key`,
    );
    const { jobId, entry } = await composeAndSubmit(
      orphanCampaignId,
      `${PREFIX}-orphan-engine-job`,
    );

    // The engine's worker-boot reconciliation shape: status AND result both
    // state=failed with the pinned orphan message; the partial result keeps
    // the one case solved before the restart (jobs.py writes points only for
    // reached cases — the two unsolved angles simply are not in the file).
    const partial: JobResult = {
      job_id: `${PREFIX}-orphan-engine-job`,
      state: "failed",
      message: WORKER_RESTART_ORPHAN_MESSAGE,
      polars: [
        {
          speed: 10,
          chord: CHORD,
          reynolds: Math.round((10 * CHORD) / NU),
          mach: 10 / 340.3,
          points: [
            {
              aoa_deg: SOLVED_AOA,
              cl: 0.5,
              cd: 0.02,
              cm: -0.02,
              cl_cd: 25,
              unsteady: false,
              converged: true,
              first_order_fallback: false,
              images: {},
            },
          ],
        },
      ],
    };
    const orphanEngine = {
      getQueue: async () => {
        throw new Error("queue unavailable in test");
      },
      getJob: async (): Promise<JobStatus> => ({
        job_id: `${PREFIX}-orphan-engine-job`,
        state: "failed",
        total_cases: ANGLES.length,
        completed_cases: 1,
        message: WORKER_RESTART_ORPHAN_MESSAGE,
      }),
      getResult: async () => withExactManifestEvidence(partial),
    } as unknown as EngineClient;

    await reconcile(db, orphanEngine, {
      jobIds: [jobId],
      skipFailedRecovery: true,
    });

    // Solved case: real evidence, kept.
    const rows = await db
      .select({
        aoaDeg: results.aoaDeg,
        status: results.status,
        simJobId: results.simJobId,
        engineJobId: results.engineJobId,
        cl: results.cl,
        error: results.error,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, entry.revisionId),
        ),
      )
      .orderBy(asc(results.aoaDeg));
    expect(rows.map((r) => r.aoaDeg)).toEqual(ANGLES);
    const solved = rows[0];
    expect(solved.status).toBe("done");
    expect(solved.cl).toBeCloseTo(0.5, 8);
    // Unsolved claims: RELEASED (pending, refs nulled) — re-claimable, not failed.
    for (const released of rows.slice(1)) {
      expect(released.status).toBe("pending");
      expect(released.simJobId).toBeNull();
      expect(released.engineJobId).toBeNull();
      expect(released.cl).toBeNull();
    }
    // The incident invariant: ZERO failed evidence rows from a worker restart.
    expect(rows.filter((r) => r.status === "failed").length).toBe(0);

    // The sim_job terminates truthfully: cancelled with the release message,
    // never 'failed' — infrastructure interruption is not failure evidence.
    const [job] = await db
      .select({
        status: simJobs.status,
        engineState: simJobs.engineState,
        error: simJobs.error,
        finishedAt: simJobs.finishedAt,
      })
      .from(simJobs)
      .where(eq(simJobs.id, jobId));
    expect(job.status).toBe("cancelled");
    expect(job.engineState).toBe("cancelled");
    expect(job.error).toBe(
      "worker restarted mid-solve; points released for re-solve",
    );
    expect(job.finishedAt).not.toBeNull();

    // Campaign points: solved angle terminal-linked, interrupted angles stay
    // 'requested' (the "15 failed" incident showed them terminal-failed).
    const points = await db
      .select({
        aoaDeg: simCampaignPoints.aoaDeg,
        state: simCampaignPoints.state,
        resultId: simCampaignPoints.resultId,
      })
      .from(simCampaignPoints)
      .where(eq(simCampaignPoints.campaignId, orphanCampaignId))
      .orderBy(asc(simCampaignPoints.aoaDeg));
    expect(points.length).toBe(ANGLES.length);
    expect(points[0].state).toBe("terminal");
    expect(points[0].resultId).not.toBeNull();
    for (const point of points.slice(1)) {
      expect(point.state).toBe("requested");
    }

    // Campaign counters: failed MUST be 0 (it read 15 in prod), solved 1.
    const [progress] = await db
      .select()
      .from(simCampaignProgress)
      .where(
        and(
          eq(simCampaignProgress.campaignId, orphanCampaignId),
          eq(simCampaignProgress.airfoilId, airfoilId),
        ),
      );
    expect(progress).toBeTruthy();
    expect(progress.failed).toBe(0);
    expect(progress.solved).toBe(1);
    expect(progress.requested).toBe(ANGLES.length);

    // And the failures endpoint agrees: nothing failed for this campaign.
    const failures = await campaignFailures(db, orphanCampaignId);
    expect(failures.total).toBe(0);

    // Recall check: the released points are re-claimable on the next tick.
    const rebatch = await findCampaignGapBatch(db, {
      limit: 500,
      campaignIds: [orphanCampaignId],
    });
    expect(rebatch).not.toBeNull();
    expect(rebatch!.angles).toEqual(ANGLES.slice(1));
  }, 120000);

  it("MUST-CATCH: a token-bound receipt records only its own URANS routes and never submits or composes a child", async () => {
    const TARGET_ENGINE_JOB = "b62121e7-3430-4f4e-b70b-f0c21c769fac";
    const UNRELATED_ENGINE_JOB = "d5c392db-0045-4de0-8a6e-275ea547bc27";
    const DRAIN_TOKEN = "5c2e6674-2620-4f72-8caf-b55473fbbb67";
    receiptCampaignId = await launchCampaign(
      `${PREFIX} receipt target`,
      31,
      `${PREFIX}-receipt-target`,
    );
    unrelatedReceiptCampaignId = await launchCampaign(
      `${PREFIX} receipt unrelated`,
      32,
      `${PREFIX}-receipt-unrelated`,
    );
    const { jobId: targetJobId, entry } = await composeAndSubmit(
      receiptCampaignId,
      TARGET_ENGINE_JOB,
    );
    const { jobId: unrelatedJobId } = await composeAndSubmit(
      unrelatedReceiptCampaignId,
      UNRELATED_ENGINE_JOB,
    );
    const campaignProjectionBeforeReceipt = await db
      .select({
        aoaDeg: simCampaignPoints.aoaDeg,
        state: simCampaignPoints.state,
        resultId: simCampaignPoints.resultId,
        resultAttemptId: simCampaignPoints.resultAttemptId,
      })
      .from(simCampaignPoints)
      .where(eq(simCampaignPoints.campaignId, receiptCampaignId))
      .orderBy(asc(simCampaignPoints.aoaDeg));
    await db
      .update(simJobs)
      .set({ status: "running", engineState: "running" })
      .where(eq(simJobs.id, targetJobId));
    await db
      .update(simJobs)
      .set({ status: "running", engineState: "running" })
      .where(eq(simJobs.id, unrelatedJobId));

    const submitted: string[] = [];
    const polled: string[] = [];
    let queueCalls = 0;
    const targetResult: JobResult = withExactManifestEvidence({
      job_id: TARGET_ENGINE_JOB,
      state: "completed",
      polars: [
        {
          speed: 31,
          chord: CHORD,
          reynolds: Math.round((31 * CHORD) / NU),
          mach: 31 / 340.3,
          points: ANGLES.map((aoaDeg) => ({
            aoa_deg: aoaDeg,
            cl: 0.55 + aoaDeg / 100,
            cd: 0.03,
            cm: -0.04,
            cl_cd: 20,
            stalled: true,
            unsteady: false,
            converged: false,
            first_order_fallback: false,
            fidelity: "rans" as const,
            images: {},
          })),
        },
      ],
    });
    const receiptEngine = {
      getQueue: async () => {
        queueCalls += 1;
        throw new Error("receipt scope must not enumerate the global queue");
      },
      getJobRuntimes: async () => ({ jobs: [] }),
      getJob: async (
        engineJobId: string,
        opts?: unknown,
      ): Promise<JobStatus> => {
        polled.push(engineJobId);
        expect(
          (opts as { expectedPayloadSha256?: string } | undefined)
            ?.expectedPayloadSha256,
        ).toBe("1".repeat(64));
        if (engineJobId !== TARGET_ENGINE_JOB) {
          throw new Error(`unrelated engine job was polled: ${engineJobId}`);
        }
        return {
          job_id: engineJobId,
          state: "completed",
          total_cases: ANGLES.length,
          completed_cases: ANGLES.length,
        };
      },
      getResult: async (
        engineJobId: string,
        opts?: unknown,
      ): Promise<JobResult> => {
        expect(
          (opts as { expectedPayloadSha256?: string } | undefined)
            ?.expectedPayloadSha256,
        ).toBe("2".repeat(64));
        if (engineJobId !== TARGET_ENGINE_JOB) {
          throw new Error(`unrelated engine result was read: ${engineJobId}`);
        }
        return targetResult;
      },
      submitPolar: async (): Promise<JobStatus> => {
        submitted.push("unexpected");
        throw new Error("receipt scope must never submit CFD");
      },
    } as unknown as EngineClient;

    const targetCandidate: GuardedEngineReceipt["candidates"][number] = {
      jobId: targetJobId,
      engineJobId: TARGET_ENGINE_JOB,
      databaseStatus: "running",
      engineStatus: "completed",
      engineMessage: null,
      statusSha256: "1".repeat(64),
      resultSha256: "2".repeat(64),
      settlementAction: "ingest",
    };

    // A copied or stale receipt fails at the durable-token gate before it can
    // even inspect the named sim_job or engine job.
    let mismatchGetJobCalls = 0;
    const mismatchedTokenEngine = {
      getJob: async () => {
        mismatchGetJobCalls += 1;
        throw new Error("the token gate must run before engine access");
      },
    } as unknown as EngineClient;
    await expect(
      reconcileGuardedEngineReceipt(
        db,
        mismatchedTokenEngine,
        guardedReceipt("5ec73956-67fa-41ff-b2c8-543efff38c67", [
          targetCandidate,
        ]),
      ),
    ).rejects.toThrow("does not own the current durable maintenance drain");
    expect(mismatchGetJobCalls).toBe(0);

    await enterReceiptMaintenanceDrain(DRAIN_TOKEN);
    try {
      const drainFlipEngine = {
        getJob: async (): Promise<JobStatus> => {
          // Simulate a watcher restart replacing the token after the CLI's
          // first drain check but before this candidate reaches settlement.
          await resumeSuiteAdmissionEnvelope();
          return {
            job_id: TARGET_ENGINE_JOB,
            state: "completed",
            total_cases: ANGLES.length,
            completed_cases: ANGLES.length,
          };
        },
      } as unknown as EngineClient;
      await expect(
        reconcileGuardedEngineReceipt(
          db,
          drainFlipEngine,
          guardedReceipt(DRAIN_TOKEN, [targetCandidate]),
        ),
      ).rejects.toThrow("lost its durable maintenance drain");
      const [afterDrainFlip] = await db
        .select({
          status: simJobs.status,
          ingestLeaseToken: simJobs.ingestLeaseToken,
        })
        .from(simJobs)
        .where(eq(simJobs.id, targetJobId));
      expect(afterDrainFlip).toEqual({
        status: "running",
        ingestLeaseToken: null,
      });

      await enterReceiptMaintenanceDrain(DRAIN_TOKEN);
      const changedResultEngine = {
        getJob: async (
          _engineJobId: string,
          opts?: unknown,
        ): Promise<JobStatus> => {
          expect(
            (opts as { expectedPayloadSha256?: string } | undefined)
              ?.expectedPayloadSha256,
          ).toBe("1".repeat(64));
          return {
            job_id: TARGET_ENGINE_JOB,
            state: "completed",
            total_cases: ANGLES.length,
            completed_cases: ANGLES.length,
          };
        },
        getResult: async (
          _engineJobId: string,
          opts?: unknown,
        ): Promise<JobResult> => {
          // The engine client rejects this before it returns a parsed object
          // when the raw result.json source-digest header differs. Same job
          // id/state/message is deliberately insufficient.
          expect(
            (opts as { expectedPayloadSha256?: string } | undefined)
              ?.expectedPayloadSha256,
          ).toBe("2".repeat(64));
          throw new Error("engine result source digest changed");
        },
      } as unknown as EngineClient;
      await expect(
        reconcileGuardedEngineReceipt(
          db,
          changedResultEngine,
          guardedReceipt(DRAIN_TOKEN, [targetCandidate]),
        ),
      ).rejects.toThrow("source digest changed");
      const [afterResultDigestDrift] = await db
        .select({
          status: simJobs.status,
          engineState: simJobs.engineState,
          ingestedAt: simJobs.ingestedAt,
          ingestLeaseToken: simJobs.ingestLeaseToken,
        })
        .from(simJobs)
        .where(eq(simJobs.id, targetJobId));
      expect(afterResultDigestDrift).toEqual({
        status: "running",
        engineState: "running",
        ingestedAt: null,
        ingestLeaseToken: null,
      });

      // The pre-ingest renewal is only a preliminary liveness check.  Swap
      // the token immediately after it succeeds and before ingest's first
      // canonical mutation: the token-locked mutation transaction must
      // reject the stale receipt without creating a result shell, selecting
      // an attempt, linking campaign state, or terminalizing the parent.
      await enterReceiptMaintenanceDrain(DRAIN_TOKEN);
      await expect(
        reconcile(db, receiptEngine, {
          jobIds: [targetJobId],
          receiptScopedMaintenance: {
            maintenanceToken: DRAIN_TOKEN,
            candidates: [targetCandidate],
          },
          testHooks: {
            beforeReceiptIngestMutation: async () => {
              await enterReceiptMaintenanceDrain(
                "ed39c3e0-089b-49a9-8425-cdc602f790d8",
              );
            },
          },
        }),
      ).rejects.toThrow("ingest lease");
      const [afterPreMutationTokenSwap] = await db
        .select({
          status: simJobs.status,
          engineState: simJobs.engineState,
          ingestedAt: simJobs.ingestedAt,
        })
        .from(simJobs)
        .where(eq(simJobs.id, targetJobId));
      expect(afterPreMutationTokenSwap).toEqual({
        // The earlier receipt-authorized claim remains recoverable, but no
        // canonical settlement or selection can occur under the replacement.
        status: "ingesting",
        engineState: "running",
        ingestedAt: null,
      });
      const attemptsAfterPreMutationTokenSwap = await db
        .select({ id: resultAttempts.id })
        .from(resultAttempts)
        .where(eq(resultAttempts.simJobId, targetJobId));
      expect(attemptsAfterPreMutationTokenSwap).toEqual([]);
      const [unpublishedAfterPreMutationTokenSwap] = await db
        .select({
          status: results.status,
          currentResultAttemptId: results.currentResultAttemptId,
        })
        .from(results)
        .where(
          and(
            eq(results.airfoilId, airfoilId),
            eq(results.simulationPresetRevisionId, entry.revisionId),
            eq(results.aoaDeg, SOLVED_AOA),
          ),
        );
      expect(unpublishedAfterPreMutationTokenSwap).toEqual({
        status: "queued",
        currentResultAttemptId: null,
      });
      const preMutationRoutes = await db
        .select({ id: simPrecalcObligations.id })
        .from(simPrecalcObligations)
        .where(
          and(
            eq(simPrecalcObligations.airfoilId, airfoilId),
            eq(simPrecalcObligations.revisionId, entry.revisionId),
          ),
        );
      expect(preMutationRoutes).toEqual([]);

      // The stale receipt deliberately cannot release this lease after the
      // swap. Reset only the isolated fixture row before the next independent
      // retirement interleaving.
      await db
        .update(simJobs)
        .set({
          status: "running",
          engineState: "running",
          ingestLeaseToken: null,
          ingestLeaseClaimedAt: null,
          ingestLeaseExpiresAt: null,
        })
        .where(eq(simJobs.id, targetJobId));

      // The drain can be retired after source-pinned result fetch but before
      // canonical publication. Immutable attempts may remain as truthful
      // history, but the stale receipt must not select them, refresh a polar,
      // create a PRECALC route/verify queue, compose a child, or terminalize
      // the parent. This specifically catches a token flip *mid-ingest*, not
      // merely before a receipt claim.
      await enterReceiptMaintenanceDrain(DRAIN_TOKEN);
      await expect(
        reconcile(db, receiptEngine, {
          jobIds: [targetJobId],
          receiptScopedMaintenance: {
            maintenanceToken: DRAIN_TOKEN,
            candidates: [targetCandidate],
          },
          testHooks: {
            afterReceiptEvidenceStaged: async () => {
              await resumeSuiteAdmissionEnvelope();
            },
          },
        }),
      ).rejects.toThrow("ingest lease");
      const [afterMidIngestTokenFlip] = await db
        .select({
          status: simJobs.status,
          engineState: simJobs.engineState,
          ingestedAt: simJobs.ingestedAt,
          ingestLeaseToken: simJobs.ingestLeaseToken,
        })
        .from(simJobs)
        .where(eq(simJobs.id, targetJobId));
      expect(afterMidIngestTokenFlip).toMatchObject({
        status: "ingesting",
        engineState: "running",
        ingestedAt: null,
      });
      expect(afterMidIngestTokenFlip.ingestLeaseToken).not.toBeNull();
      const stagedAttempts = await db
        .select({ id: resultAttempts.id })
        .from(resultAttempts)
        .where(eq(resultAttempts.simJobId, targetJobId));
      expect(stagedAttempts).toHaveLength(ANGLES.length);
      const stagedAttemptIds = stagedAttempts.map((attempt) => attempt.id);
      const postRetirementClassifications = await db
        .select({ id: resultClassifications.id })
        .from(resultClassifications)
        .where(
          inArray(resultClassifications.resultAttemptId, stagedAttemptIds),
        );
      // Classifications are publication-derived canonical projections, not
      // immutable solver evidence. Retiring the receipt after staging must
      // leave every retained attempt unclassified until a new owner resumes.
      expect(postRetirementClassifications).toEqual([]);
      const postRetirementFits = await db
        .select({ id: polarFitSets.id })
        .from(polarFitSets)
        .where(
          and(
            eq(polarFitSets.airfoilId, airfoilId),
            eq(polarFitSets.simulationPresetRevisionId, entry.revisionId),
            eq(polarFitSets.isCurrent, true),
          ),
        );
      expect(postRetirementFits).toEqual([]);
      const [unpublished] = await db
        .select({
          status: results.status,
          currentResultAttemptId: results.currentResultAttemptId,
        })
        .from(results)
        .where(
          and(
            eq(results.airfoilId, airfoilId),
            eq(results.simulationPresetRevisionId, entry.revisionId),
            eq(results.aoaDeg, SOLVED_AOA),
          ),
        );
      expect(unpublished).toEqual({
        // Result claims remain at their original queued projection: the
        // receipt staged immutable attempts but never published a canonical
        // result before its token was retired.
        status: "queued",
        currentResultAttemptId: null,
      });
      const midIngestRoutes = await db
        .select({ id: simPrecalcObligations.id })
        .from(simPrecalcObligations)
        .where(
          and(
            eq(simPrecalcObligations.airfoilId, airfoilId),
            eq(simPrecalcObligations.revisionId, entry.revisionId),
          ),
        );
      expect(midIngestRoutes).toEqual([]);
      const midIngestVerify = await db
        .select({ id: simUransVerifyQueue.id })
        .from(simUransVerifyQueue)
        .where(eq(simUransVerifyQueue.revisionId, entry.revisionId));
      expect(midIngestVerify).toEqual([]);
      const midIngestChildren = await db
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(eq(simJobs.parentJobId, targetJobId));
      expect(midIngestChildren).toEqual([]);
      const postRetirementCampaignPoints = await db
        .select({
          aoaDeg: simCampaignPoints.aoaDeg,
          state: simCampaignPoints.state,
          resultId: simCampaignPoints.resultId,
          resultAttemptId: simCampaignPoints.resultAttemptId,
        })
        .from(simCampaignPoints)
        .where(eq(simCampaignPoints.campaignId, receiptCampaignId))
        .orderBy(asc(simCampaignPoints.aoaDeg));
      expect(postRetirementCampaignPoints).toEqual(
        campaignProjectionBeforeReceipt,
      );

      // The retired receipt owns neither lease release nor recovery. A fresh
      // watcher would wait for expiry; this fixture resets only its synthetic
      // row so the same test can prove a clean, replacement receipt succeeds.
      await db
        .update(simJobs)
        .set({
          status: "running",
          engineState: "running",
          ingestLeaseToken: null,
          ingestLeaseClaimedAt: null,
          ingestLeaseExpiresAt: null,
        })
        .where(eq(simJobs.id, targetJobId));
      await enterReceiptMaintenanceDrain(DRAIN_TOKEN);

      const report = await reconcileGuardedEngineReceipt(
        db,
        receiptEngine,
        guardedReceipt(DRAIN_TOKEN, [targetCandidate]),
      );

      expect(report).toEqual({
        schemaVersion: 1,
        mode: "receipt-scoped-maintenance",
        jobIds: [targetJobId],
        terminalJobIds: [targetJobId],
        activeJobIds: [],
        nonterminalJobIds: [],
      });
      expect(queueCalls).toBe(0);
      const attemptsAfterReplacementReceipt = await db
        .select({ id: resultAttempts.id })
        .from(resultAttempts)
        .where(eq(resultAttempts.simJobId, targetJobId))
        .orderBy(resultAttempts.id);
      // A new valid receipt may project the retained evidence, but it must
      // replay those immutable attempt identities rather than manufacture a
      // replacement history after the retired receipt's interruption.
      expect(
        attemptsAfterReplacementReceipt.map((attempt) => attempt.id),
      ).toEqual([...stagedAttemptIds].sort());
      // The mid-ingest token-fence probe legitimately reads the same exact
      // receipt candidate before the replacement receipt completes it. The
      // important scope guarantee is that no unrelated engine job is ever
      // polled.
      expect(polled.length).toBeGreaterThan(0);
      expect(
        polled.every((engineJobId) => engineJobId === TARGET_ENGINE_JOB),
      ).toBe(true);
      expect(submitted).toEqual([]);

      // Routes are durable and exact to the named job's compatibility cell.
      const routes = await db
        .select({ aoaDeg: simPrecalcObligations.aoaDeg })
        .from(simPrecalcObligations)
        .where(
          and(
            eq(simPrecalcObligations.airfoilId, airfoilId),
            eq(simPrecalcObligations.revisionId, entry.revisionId),
          ),
        )
        .orderBy(asc(simPrecalcObligations.aoaDeg));
      expect(routes.map((route) => route.aoaDeg)).toEqual(ANGLES);

      // No physical child was composed, and the unlisted receipt member
      // remains untouched. A normal sweeper tick owns later admission of the
      // recorded route after guarded maintenance has restored writers.
      const children = await db
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(eq(simJobs.parentJobId, targetJobId));
      expect(children).toEqual([]);
      const [unrelated] = await db
        .select({ status: simJobs.status, engineJobId: simJobs.engineJobId })
        .from(simJobs)
        .where(eq(simJobs.id, unrelatedJobId));
      expect(unrelated).toEqual({
        status: "running",
        engineJobId: UNRELATED_ENGINE_JOB,
      });
    } finally {
      await resumeSuiteAdmissionEnvelope();
    }
  }, 120000);

  it("releases only explicitly authorised cancellation and worker-restart-orphan candidates", async () => {
    const CANCELLED_ENGINE_JOB = "7a73cbda-21bc-4149-8c98-491b2ec9e034";
    const ORPHAN_ENGINE_JOB = "7ee42217-3a0f-4a77-93d3-a0651f2904a9";
    const DRAIN_TOKEN = "a1fd3333-50e9-48a3-b505-6f8a0939cbfc";
    cancelledReceiptCampaignId = await launchCampaign(
      `${PREFIX} receipt cancelled`,
      33,
      `${PREFIX}-receipt-cancelled`,
    );
    orphanReceiptCampaignId = await launchCampaign(
      `${PREFIX} receipt orphan`,
      34,
      `${PREFIX}-receipt-orphan`,
    );
    const { jobId: cancelledJobId } = await composeAndSubmit(
      cancelledReceiptCampaignId,
      CANCELLED_ENGINE_JOB,
    );
    const { jobId: orphanJobId } = await composeAndSubmit(
      orphanReceiptCampaignId,
      ORPHAN_ENGINE_JOB,
    );
    await db
      .update(simJobs)
      .set({ status: "running", engineState: "running" })
      .where(eq(simJobs.id, cancelledJobId));
    await db
      .update(simJobs)
      .set({ status: "running", engineState: "running" })
      .where(eq(simJobs.id, orphanJobId));

    const cancelledCandidate: GuardedEngineReceipt["candidates"][number] = {
      jobId: cancelledJobId,
      engineJobId: CANCELLED_ENGINE_JOB,
      databaseStatus: "running",
      engineStatus: "cancelled",
      engineMessage: "cancelled by engine",
      statusSha256: "3".repeat(64),
      resultSha256: "4".repeat(64),
      settlementAction: "release_cancelled",
    };
    const orphanCandidate: GuardedEngineReceipt["candidates"][number] = {
      jobId: orphanJobId,
      engineJobId: ORPHAN_ENGINE_JOB,
      databaseStatus: "running",
      engineStatus: "failed",
      engineMessage: WORKER_RESTART_ORPHAN_MESSAGE,
      statusSha256: "5".repeat(64),
      resultSha256: "6".repeat(64),
      settlementAction: "release_worker_restart_orphan",
    };
    const submitted: string[] = [];
    const cancelled: string[] = [];
    let orphanResultAvailable = false;
    const polled: string[] = [];
    const engine = {
      getQueue: async () => {
        throw new Error("receipt scope must not enumerate the global queue");
      },
      getJob: async (
        engineJobId: string,
        opts?: unknown,
      ): Promise<JobStatus> => {
        polled.push(engineJobId);
        expect(
          (opts as { expectedPayloadSha256?: string } | undefined)
            ?.expectedPayloadSha256,
        ).toBe(
          engineJobId === CANCELLED_ENGINE_JOB
            ? "3".repeat(64)
            : "5".repeat(64),
        );
        if (engineJobId === CANCELLED_ENGINE_JOB) {
          return {
            job_id: engineJobId,
            state: "cancelled",
            message: "cancelled by engine",
            total_cases: ANGLES.length,
            completed_cases: 0,
          };
        }
        if (engineJobId === ORPHAN_ENGINE_JOB) {
          return {
            job_id: engineJobId,
            state: "failed",
            message: WORKER_RESTART_ORPHAN_MESSAGE,
            total_cases: ANGLES.length,
            completed_cases: 0,
          };
        }
        throw new Error(`unexpected engine job ${engineJobId}`);
      },
      getResult: async (
        engineJobId: string,
        opts?: unknown,
      ): Promise<JobResult> => {
        expect(
          (opts as { expectedPayloadSha256?: string } | undefined)
            ?.expectedPayloadSha256,
        ).toBe("6".repeat(64));
        expect(engineJobId).toBe(ORPHAN_ENGINE_JOB);
        if (!orphanResultAvailable) {
          throw new Error(
            "temporary result read failure after cancellation settled",
          );
        }
        return {
          job_id: engineJobId,
          state: "failed",
          message: WORKER_RESTART_ORPHAN_MESSAGE,
          polars: [],
        };
      },
      submitPolar: async () => {
        submitted.push("unexpected");
        throw new Error("receipt scope must never submit CFD");
      },
      cancelJob: async (engineJobId: string) => {
        cancelled.push(engineJobId);
        throw new Error("receipt scope must never cancel CFD");
      },
    } as unknown as EngineClient;

    await enterReceiptMaintenanceDrain(DRAIN_TOKEN);
    try {
      const receipt = guardedReceipt(DRAIN_TOKEN, [
        cancelledCandidate,
        orphanCandidate,
      ]);
      // The receipt's outer guard has already read the old token. Replacing it
      // immediately before cancellation must fail inside the cancellation
      // transaction, before either the job or its claimed points can change.
      // This proves the transaction locks and rechecks the drain generation,
      // rather than relying only on the first sim_jobs UPDATE predicate.
      await expect(
        reconcile(db, engine, {
          jobIds: [cancelledJobId],
          receiptScopedMaintenance: {
            maintenanceToken: DRAIN_TOKEN,
            candidates: [cancelledCandidate],
          },
          testHooks: {
            beforeReceiptSettlementMutation: async () => {
              await enterReceiptMaintenanceDrain(
                "a03f9b17-17f3-4f5e-93d1-11319711d0b1",
              );
            },
          },
        }),
      ).rejects.toThrow("lost its durable maintenance drain before mutation");
      const [afterTokenReplacement] = await db
        .select({
          status: simJobs.status,
          engineState: simJobs.engineState,
          ingestLeaseToken: simJobs.ingestLeaseToken,
        })
        .from(simJobs)
        .where(eq(simJobs.id, cancelledJobId));
      expect(afterTokenReplacement).toEqual({
        status: "running",
        engineState: "running",
        ingestLeaseToken: null,
      });
      polled.length = 0;
      await enterReceiptMaintenanceDrain(DRAIN_TOKEN);
      // A partial pass settles the first action, then fails before the second
      // reads its result. The receipt retry must skip the already-cancelled
      // job and finish only the still-active orphan candidate.
      await expect(
        reconcileGuardedEngineReceipt(db, engine, receipt),
      ).rejects.toThrow("temporary result read failure");
      const [firstAfterInterruptedPass] = await db
        .select({ status: simJobs.status })
        .from(simJobs)
        .where(eq(simJobs.id, cancelledJobId));
      expect(firstAfterInterruptedPass).toEqual({ status: "cancelled" });
      const [secondAfterInterruptedPass] = await db
        .select({
          status: simJobs.status,
          ingestLeaseToken: simJobs.ingestLeaseToken,
        })
        .from(simJobs)
        .where(eq(simJobs.id, orphanJobId));
      expect(secondAfterInterruptedPass).toEqual({
        status: "running",
        ingestLeaseToken: null,
      });

      orphanResultAvailable = true;
      const report = await reconcileGuardedEngineReceipt(db, engine, receipt);
      expect(report.terminalJobIds).toEqual([cancelledJobId, orphanJobId]);
      expect(submitted).toEqual([]);
      expect(cancelled).toEqual([]);
      expect(polled.filter((id) => id === CANCELLED_ENGINE_JOB)).toEqual([
        CANCELLED_ENGINE_JOB,
      ]);
      const terminalJobs = await db
        .select({ id: simJobs.id, status: simJobs.status })
        .from(simJobs)
        .where(and(eq(simJobs.id, cancelledJobId)));
      expect(terminalJobs).toEqual([
        { id: cancelledJobId, status: "cancelled" },
      ]);
      const [orphanJob] = await db
        .select({ status: simJobs.status })
        .from(simJobs)
        .where(eq(simJobs.id, orphanJobId));
      expect(orphanJob).toEqual({ status: "cancelled" });
    } finally {
      await resumeSuiteAdmissionEnvelope();
    }
  }, 120000);

  it("discards each repeated genuine engine failure and keeps the cells schedulable", async () => {
    const MSG = "MeshError: snappyHexMesh exited 1 during layer addition";
    genuineCampaignId = await launchCampaign(
      `${PREFIX} genuine campaign`,
      20,
      `${PREFIX}-genuine-key`,
    );
    const { jobId, entry } = await composeAndSubmit(
      genuineCampaignId,
      `${PREFIX}-genuine-engine-job`,
    );

    const genuineEngine = (engineJobId: string): EngineClient =>
      ({
        getQueue: async () => {
          throw new Error("queue unavailable in test");
        },
        getJob: async (): Promise<JobStatus> => ({
          job_id: engineJobId,
          state: "failed",
          total_cases: ANGLES.length,
          completed_cases: 0,
          message: MSG,
        }),
        // tasks.py exception path: failed result with a message and no polars.
        getResult: async (): Promise<JobResult> => ({
          job_id: engineJobId,
          state: "failed",
          message: MSG,
          polars: [],
        }),
      }) as unknown as EngineClient;

    await reconcile(db, genuineEngine(`${PREFIX}-genuine-engine-job`), {
      jobIds: [jobId],
      skipFailedRecovery: true,
    });

    // The first crash discards its generation and returns every cell to
    // ordinary scheduling; only the compact restart marker remains.
    const firstRows = await db
      .select({
        status: results.status,
        error: results.error,
        autoRetriedAt: results.autoRetriedAt,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, entry.revisionId),
        ),
      );
    expect(firstRows.length).toBe(ANGLES.length);
    for (const row of firstRows) {
      expect(row.status).toBe("pending");
      expect(row.autoRetriedAt).not.toBeNull();
      expect(row.error).toBeNull();
    }

    // A later crash gets the same clean restart; no fixed retry cap creates a
    // fleet-wide incident or blocks an otherwise schedulable point.
    const { jobId: secondJobId } = await composeAndSubmit(
      genuineCampaignId,
      `${PREFIX}-genuine-engine-job-2`,
    );
    await reconcile(db, genuineEngine(`${PREFIX}-genuine-engine-job-2`), {
      jobIds: [secondJobId],
      skipFailedRecovery: true,
    });

    const rows = await db
      .select({ status: results.status, error: results.error })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, entry.revisionId),
        ),
      );
    expect(rows.length).toBe(ANGLES.length);
    for (const row of rows) {
      expect(row.status).toBe("pending");
      expect(row.error).toBeNull();
    }

    const [progress] = await db
      .select()
      .from(simCampaignProgress)
      .where(
        and(
          eq(simCampaignProgress.campaignId, genuineCampaignId),
          eq(simCampaignProgress.airfoilId, airfoilId),
        ),
      );
    expect(progress.failed).toBe(0);
    expect(progress.blocked).toBe(0);

    // The legacy failure/requeue surface remains URANS-only.
    const failures = await campaignFailures(db, genuineCampaignId);
    expect(failures.total).toBe(0);

    const incidents = await solverIncidentSummary(db, {
      campaignId: genuineCampaignId,
    });
    expect(incidents).toMatchObject({
      occurrenceCount: 0,
      openCount: 0,
      criticalGroupCount: 0,
      groups: [],
    });
  }, 120000);
});
