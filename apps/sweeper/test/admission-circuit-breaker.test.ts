import {
  airfoils,
  createClient,
  type DB,
  enforceSweeperAdmissionFence,
  resultAttempts,
  resultClassifications,
  results,
  simCampaignConditions,
  simCampaignPlanRevisions,
  simCampaignProgress,
  simCampaignPoints,
  simCampaigns,
  simJobs,
  simPrecalcObligationCampaigns,
  simPrecalcObligations,
  simSolverIncidentCampaigns,
  simSolverIncidents,
  simulationPresetRevisions,
  simulationPresets,
  simUransVerifyQueue,
  simUransVerifyQueueCampaigns,
  simUransRequestCampaigns,
  simUransRequests,
  solverIncidentSummary,
  sweeperState,
} from "@aerodb/db";
import type {
  EngineClient,
  JobStatus,
  PolarRequest,
} from "@aerodb/engine-client";
import { and, eq, inArray, sql as drizzleSql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMinimalSolverFixture,
  type MinimalSolverFixture,
} from "../../../packages/db/test/solver-fixture";
import { tick } from "../src/loop";
import { submitPendingJobWithLifecycleGuard } from "../src/submit-lifecycle";

const { db, sql } = createClient({ max: 3 });
const PREFIX = `admission-breaker-${process.pid}-${Date.now().toString(36)}`;
const AOA = 79 + (process.pid % 1000) / 100_000;

let campaignId = "";
let conditionId = "";
let requestId = "";
let airfoilId = "";
let solverFixture: MinimalSolverFixture;

async function readState(source: DB = db) {
  const [row] = await source
    .select()
    .from(sweeperState)
    .where(eq(sweeperState.id, 1))
    .limit(1);
  if (!row) throw new Error("seeded sweeper_state singleton missing");
  return row;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForLockWait(
  marker: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await db.execute(drizzleSql`
      SELECT pid
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query LIKE ${`%${marker}%`}
      LIMIT 1
    `)) as unknown as Array<{ pid: number }>;
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`query did not wait on the admission lock: ${marker}`);
}

async function expectHazardTransitionWaitsForAdmissionLock(
  marker: string,
  transition: () => Promise<unknown>,
): Promise<void> {
  let transitionSettled = false;
  let transitionPromise: Promise<unknown> | null = null;
  try {
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      await tx.execute(drizzleSql`
        SELECT id FROM sweeper_state WHERE id = 1 FOR UPDATE
      `);
      transitionPromise = transition().finally(() => {
        transitionSettled = true;
      });
      await waitForLockWait(marker);
      expect(transitionSettled).toBe(false);
    });
  } finally {
    if (transitionPromise) await transitionPromise;
  }
}

beforeAll(async () => {
  solverFixture = await createMinimalSolverFixture(db, PREFIX);

  const [airfoil] = await db
    .select({ id: airfoils.id })
    .from(airfoils)
    .limit(1);
  const [setup] = await db
    .select({
      revisionId: simulationPresetRevisions.id,
      presetId: simulationPresets.id,
      flowConditionId: simulationPresets.flowConditionId,
      referenceGeometryProfileId: simulationPresets.referenceGeometryProfileId,
      reynolds: simulationPresetRevisions.reynolds,
      mach: simulationPresetRevisions.mach,
    })
    .from(simulationPresetRevisions)
    .innerJoin(
      simulationPresets,
      eq(simulationPresets.id, simulationPresetRevisions.presetId),
    )
    .where(eq(simulationPresetRevisions.id, solverFixture.revisionId))
    .limit(1);
  if (!airfoil || !setup) throw new Error("seeded solver setup missing");
  airfoilId = airfoil.id;

  const [campaign] = await db
    .insert(simCampaigns)
    .values({
      slug: PREFIX,
      name: PREFIX,
      idempotencyKey: PREFIX,
      status: "active",
      // Start on generation two while the hazard belongs to generation one.
      currentConditionGeneration: 2,
    })
    .returning();
  campaignId = campaign.id;

  const [plan] = await db
    .insert(simCampaignPlanRevisions)
    .values({
      campaignId,
      revisionNumber: 1,
      kind: "initial",
      plan: { test: PREFIX },
      summary: { test: PREFIX },
      createdBy: PREFIX,
    })
    .returning();
  await db
    .update(simCampaigns)
    .set({ currentPlanRevisionId: plan.id })
    .where(eq(simCampaigns.id, campaignId));

  const [condition] = await db
    .insert(simCampaignConditions)
    .values({
      campaignId,
      ord: 0,
      generation: 1,
      flowConditionId: setup.flowConditionId,
      referenceGeometryProfileId: setup.referenceGeometryProfileId,
      presetId: setup.presetId,
      simulationPresetRevisionId: setup.revisionId,
      reynolds: setup.reynolds,
      mach: setup.mach,
      status: "active",
      introducedInPlanRevisionId: plan.id,
    })
    .returning();
  conditionId = condition.id;
  await db.insert(simCampaignPoints).values({
    campaignId,
    conditionId: condition.id,
    airfoilId: airfoil.id,
    aoaDeg: AOA,
    revisionId: setup.revisionId,
    planRevisionNumber: 1,
    state: "requested",
  });

  const [request] = await db
    .insert(simUransRequests)
    .values({
      airfoilId: airfoil.id,
      revisionId: setup.revisionId,
      aoaDeg: AOA,
      fidelity: "precalc",
      state: "blocked",
      requestedBy: PREFIX,
    })
    .returning();
  requestId = request.id;
  await db.insert(simUransRequestCampaigns).values({
    requestId,
    campaignId,
    state: "active",
  });
});

afterAll(async () => {
  if (requestId) {
    await db.delete(simUransRequests).where(eq(simUransRequests.id, requestId));
  }
  if (campaignId) {
    await db.delete(simCampaigns).where(eq(simCampaigns.id, campaignId));
  }
  await solverFixture?.cleanup();
  await sql.end();
});

describe("global solver admission circuit breaker", () => {
  it("keeps every campaign-point hazard lookup on a bounded index path", async () => {
    let statement: SQL | null = null;
    const captureDb = {
      execute: async (query: SQL) => {
        statement = query;
        return [
          {
            active: false,
            fenced_now: false,
            reason: null,
            trigger_key: null,
            campaign_id: null,
            generation: null,
            details: null,
          },
        ];
      },
    } as unknown as DB;
    await enforceSweeperAdmissionFence(captureDb);
    if (!statement)
      throw new Error("admission fence statement was not captured");

    const { plan, progressIndex } = await db.transaction(
      async (transaction) => {
        await transaction.execute(drizzleSql`SET LOCAL enable_seqscan = off`);
        return {
          plan: await transaction.execute(
            drizzleSql`EXPLAIN (COSTS OFF, FORMAT JSON) ${statement}`,
          ),
          progressIndex: await transaction.execute(drizzleSql`
            SELECT indexdef
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'sim_campaign_progress'
              AND indexname = 'sim_campaign_progress_blocked_admission_idx'
          `),
        };
      },
    );

    const nodes: Array<Record<string, unknown>> = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (typeof node["Node Type"] === "string") nodes.push(node);
      Object.values(node).forEach(visit);
    };
    visit(plan);

    const pointNodes = nodes.filter(
      (node) => node["Relation Name"] === "sim_campaign_points",
    );
    expect(pointNodes.length).toBeGreaterThan(0);
    expect(pointNodes.some((node) => node["Node Type"] === "Seq Scan")).toBe(
      false,
    );
    const pointIndexes = new Set(
      nodes
        .map((node) => node["Index Name"])
        .filter(
          (name): name is string =>
            typeof name === "string" && name.startsWith("sim_campaign_points_"),
        ),
    );
    // Planner-equivalent bounded paths vary with fixture cardinality and
    // concurrent ANALYZE statistics: PostgreSQL may choose the composite
    // primary key, result/result-attempt indexes, or the requested-revision
    // partial index. Pin the behavioral contract (indexed point access and no
    // sequential point scan), not one equivalent index name.
    expect(pointIndexes.size).toBeGreaterThan(0);

    const progressNodes = nodes.filter(
      (node) => node["Relation Name"] === "sim_campaign_progress",
    );
    expect(progressNodes.length).toBeGreaterThan(0);
    expect(progressNodes.some((node) => node["Node Type"] === "Seq Scan")).toBe(
      false,
    );
    expect(progressIndex).toHaveLength(1);
    expect(JSON.stringify(progressIndex)).toContain(
      "sim_campaign_progress_blocked_admission_idx",
    );
  });

  it("does not fence ordinary RANS handoff evidence or active FAST preliminary work", async () => {
    const originalState = await readState();
    const ransAoas = [AOA + 0.181, AOA + 0.182];
    let progressCreated = false;
    let originalProgress: typeof simCampaignProgress.$inferSelect | undefined;
    const createdResultIds: string[] = [];
    const createdObligationIds: string[] = [];
    let ransJobId: string | null = null;

    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      await tx.execute(drizzleSql`
        SELECT id FROM sweeper_state WHERE id = 1 FOR UPDATE
      `);
      try {
        await tx
          .update(simCampaigns)
          .set({ currentConditionGeneration: 1 })
          .where(eq(simCampaigns.id, campaignId));
        await tx
          .update(simUransRequests)
          .set({ state: "pending" })
          .where(eq(simUransRequests.id, requestId));
        await tx
          .update(sweeperState)
          .set({
            enabled: true,
            maxConcurrentJobs: 2,
            cpuSlots: 2,
            admissionFenceActive: false,
            lastAdmissionFenceAt: null,
            lastAdmissionFenceReason: null,
            lastAdmissionFenceTriggerKey: null,
            lastAdmissionFenceDetails: null,
          })
          .where(eq(sweeperState.id, 1));

        const [ransJob] = await tx
          .insert(simJobs)
          .values({
            airfoilId,
            bcIds: [solverFixture.bcId],
            simulationPresetRevisionId: solverFixture.revisionId,
            solverImplementationId: solverFixture.solverImplementationId,
            campaignId,
            jobKind: "sweep",
            referenceChordM: 0.987654,
            wave: 1,
            status: "done",
            engineJobId: `${PREFIX}-ordinary-rans-handoff`,
            totalCases: ransAoas.length,
            completedCases: ransAoas.length,
            requestPayload: { aoas: ransAoas },
          })
          .returning({ id: simJobs.id });
        ransJobId = ransJob.id;

        const verdicts = [
          {
            aoaDeg: ransAoas[0],
            state: "rejected" as const,
            reasons: ["not-converged", "solver-stalled"],
            obligationState: "pending" as const,
          },
          {
            aoaDeg: ransAoas[1],
            state: "needs_urans" as const,
            reasons: ["post-stall-shape"],
            obligationState: "running" as const,
          },
        ];
        for (const verdict of verdicts) {
          const [result] = await tx
            .insert(results)
            .values({
              airfoilId,
              bcId: solverFixture.bcId,
              simulationPresetRevisionId: solverFixture.revisionId,
              solverImplementationId: solverFixture.solverImplementationId,
              aoaDeg: verdict.aoaDeg,
              status: "done",
              source: "solved",
              regime: "rans",
              fidelity: "rans",
              simJobId: ransJob.id,
              engineJobId: `${PREFIX}-ordinary-rans-handoff`,
              converged: false,
              stalled: true,
              solvedAt: new Date(),
            })
            .returning({ id: results.id });
          const [attempt] = await tx
            .insert(resultAttempts)
            .values({
              resultId: result.id,
              airfoilId,
              bcId: solverFixture.bcId,
              simulationPresetRevisionId: solverFixture.revisionId,
              solverImplementationId: solverFixture.solverImplementationId,
              aoaDeg: verdict.aoaDeg,
              simJobId: ransJob.id,
              engineJobId: `${PREFIX}-ordinary-rans-handoff`,
              status: "done",
              source: "solved",
              regime: "rans",
              validForPolar: false,
              converged: false,
              stalled: true,
              unsteady: false,
              evidencePayload: { failure_disposition: "hard_solver" },
              solvedAt: new Date(),
            })
            .returning({ id: resultAttempts.id });
          await tx
            .update(results)
            .set({ currentResultAttemptId: attempt.id })
            .where(eq(results.id, result.id));
          await tx.insert(resultClassifications).values({
            resultId: result.id,
            resultAttemptId: attempt.id,
            airfoilId,
            simulationPresetRevisionId: solverFixture.revisionId,
            aoaDeg: verdict.aoaDeg,
            regime: "rans",
            classifierVersion: `${PREFIX}-ordinary-rans-handoff`,
            state: verdict.state,
            reasons: verdict.reasons,
          });
          await tx.insert(simCampaignPoints).values({
            campaignId,
            conditionId,
            airfoilId,
            aoaDeg: verdict.aoaDeg,
            revisionId: solverFixture.revisionId,
            planRevisionNumber: 1,
            state: "requested",
            resultId: result.id,
            resultAttemptId: attempt.id,
          });
          const [obligation] = await tx
            .insert(simPrecalcObligations)
            .values({
              airfoilId,
              revisionId: solverFixture.revisionId,
              aoaDeg: verdict.aoaDeg,
              sourceResultId: result.id,
              sourceResultAttemptId: attempt.id,
              state: verdict.obligationState,
              attemptCount: verdict.obligationState === "running" ? 1 : 0,
              lastOutcome:
                verdict.obligationState === "running"
                  ? "submitted"
                  : "awaiting_precalc",
            })
            .returning({ id: simPrecalcObligations.id });
          await tx.insert(simPrecalcObligationCampaigns).values({
            obligationId: obligation.id,
            campaignId,
            state: "active",
          });
          createdResultIds.push(result.id);
          createdObligationIds.push(obligation.id);
        }

        [originalProgress] = await tx
          .select()
          .from(simCampaignProgress)
          .where(
            and(
              eq(simCampaignProgress.campaignId, campaignId),
              eq(simCampaignProgress.conditionId, conditionId),
              eq(simCampaignProgress.airfoilId, airfoilId),
            ),
          )
          .limit(1);
        if (originalProgress) {
          await tx
            .update(simCampaignProgress)
            .set({ blocked: 0, blockedOther: 0 })
            .where(
              and(
                eq(simCampaignProgress.campaignId, campaignId),
                eq(simCampaignProgress.conditionId, conditionId),
                eq(simCampaignProgress.airfoilId, airfoilId),
              ),
            );
        } else {
          await tx.insert(simCampaignProgress).values({
            campaignId,
            conditionId,
            airfoilId,
            requested: ransAoas.length,
            running: 1,
            blocked: 0,
          });
          progressCreated = true;
        }

        expect(await enforceSweeperAdmissionFence(tx)).toEqual({
          hazardPresent: false,
          fencedNow: false,
          active: false,
          trigger: null,
        });
        expect(await readState(tx)).toMatchObject({
          enabled: true,
          maxConcurrentJobs: 2,
          cpuSlots: 2,
          admissionFenceActive: false,
          lastAdmissionFenceAt: null,
          lastAdmissionFenceReason: null,
          lastAdmissionFenceTriggerKey: null,
          lastAdmissionFenceDetails: null,
        });
      } finally {
        if (createdObligationIds.length) {
          await tx
            .delete(simPrecalcObligations)
            .where(inArray(simPrecalcObligations.id, createdObligationIds));
        }
        await tx
          .delete(simCampaignPoints)
          .where(
            and(
              eq(simCampaignPoints.campaignId, campaignId),
              inArray(simCampaignPoints.aoaDeg, ransAoas),
            ),
          );
        if (createdResultIds.length) {
          await tx.delete(results).where(inArray(results.id, createdResultIds));
        }
        if (ransJobId) {
          await tx.delete(simJobs).where(eq(simJobs.id, ransJobId));
        }
        if (originalProgress) {
          await tx
            .update(simCampaignProgress)
            .set({
              requested: originalProgress.requested,
              solved: originalProgress.solved,
              failed: originalProgress.failed,
              running: originalProgress.running,
              superseded: originalProgress.superseded,
              derived: originalProgress.derived,
              rejected: originalProgress.rejected,
              blocked: originalProgress.blocked,
              precalcMeshRepairing: originalProgress.precalcMeshRepairing,
              blockedMeshQuality: originalProgress.blockedMeshQuality,
              blockedPrecalcExhausted: originalProgress.blockedPrecalcExhausted,
              blockedEngineSubmit: originalProgress.blockedEngineSubmit,
              blockedOther: originalProgress.blockedOther,
            })
            .where(
              and(
                eq(simCampaignProgress.campaignId, campaignId),
                eq(simCampaignProgress.conditionId, conditionId),
                eq(simCampaignProgress.airfoilId, airfoilId),
              ),
            );
        } else if (progressCreated) {
          await tx
            .delete(simCampaignProgress)
            .where(
              and(
                eq(simCampaignProgress.campaignId, campaignId),
                eq(simCampaignProgress.conditionId, conditionId),
                eq(simCampaignProgress.airfoilId, airfoilId),
              ),
            );
        }
        await tx
          .update(simCampaigns)
          .set({ currentConditionGeneration: 2 })
          .where(eq(simCampaigns.id, campaignId));
        await tx
          .update(simUransRequests)
          .set({ state: "blocked" })
          .where(eq(simUransRequests.id, requestId));
        await tx
          .update(sweeperState)
          .set({
            enabled: originalState.enabled,
            maxConcurrentJobs: originalState.maxConcurrentJobs,
            cpuSlots: originalState.cpuSlots,
            pollIntervalMs: originalState.pollIntervalMs,
            submitIntervalMs: originalState.submitIntervalMs,
            admissionFenceActive: originalState.admissionFenceActive,
            lastAdmissionFenceAt: originalState.lastAdmissionFenceAt,
            lastAdmissionFenceReason: originalState.lastAdmissionFenceReason,
            lastAdmissionFenceTriggerKey:
              originalState.lastAdmissionFenceTriggerKey,
            lastAdmissionFenceDetails: originalState.lastAdmissionFenceDetails,
          })
          .where(eq(sweeperState.id, 1));
      }
    });
  });

  it("fences exact blocked/final incident owners with a legacy null pin and ignores a cancelled owner", async () => {
    const originalState = await readState();
    const aoaDeg = AOA + 0.191;
    let createdResultId: string | null = null;
    let createdPoint = false;
    let createdVerificationId: string | null = null;

    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      await tx.execute(drizzleSql`
        SELECT id FROM sweeper_state WHERE id = 1 FOR UPDATE
      `);
      try {
        await tx
          .update(simCampaigns)
          .set({ currentConditionGeneration: 1 })
          .where(eq(simCampaigns.id, campaignId));
        await tx
          .update(simUransRequests)
          .set({ state: "pending" })
          .where(eq(simUransRequests.id, requestId));
        await tx
          .update(sweeperState)
          .set({
            enabled: true,
            maxConcurrentJobs: 2,
            cpuSlots: 2,
            admissionFenceActive: false,
            lastAdmissionFenceAt: null,
            lastAdmissionFenceReason: null,
            lastAdmissionFenceTriggerKey: null,
            lastAdmissionFenceDetails: null,
          })
          .where(eq(sweeperState.id, 1));
        const [result] = await tx
          .insert(results)
          .values({
            airfoilId,
            bcId: solverFixture.bcId,
            simulationPresetRevisionId: solverFixture.revisionId,
            solverImplementationId: solverFixture.solverImplementationId,
            aoaDeg,
            status: "done",
            source: "solved",
            regime: "urans",
            fidelity: "urans_precalc",
            converged: true,
            unsteady: true,
            solvedAt: new Date(),
          })
          .returning({ id: results.id });
        createdResultId = result.id;
        const [attempt] = await tx
          .insert(resultAttempts)
          .values({
            resultId: result.id,
            airfoilId,
            bcId: solverFixture.bcId,
            simulationPresetRevisionId: solverFixture.revisionId,
            solverImplementationId: solverFixture.solverImplementationId,
            aoaDeg,
            status: "done",
            source: "solved",
            regime: "urans",
            validForPolar: true,
            converged: true,
            unsteady: true,
            evidencePayload: { fidelity: "urans_precalc" },
            solvedAt: new Date(),
          })
          .returning({ id: resultAttempts.id });
        await tx
          .update(results)
          .set({ currentResultAttemptId: attempt.id })
          .where(eq(results.id, result.id));
        await tx.insert(resultClassifications).values({
          resultId: result.id,
          resultAttemptId: attempt.id,
          airfoilId,
          simulationPresetRevisionId: solverFixture.revisionId,
          aoaDeg,
          regime: "urans",
          classifierVersion: `${PREFIX}-legacy-point-verify`,
          state: "accepted",
          reasons: [],
        });
        await tx.insert(simCampaignPoints).values({
          campaignId,
          conditionId,
          airfoilId,
          aoaDeg,
          revisionId: solverFixture.revisionId,
          planRevisionNumber: 1,
          state: "terminal",
          resultId: result.id,
          resultAttemptId: null,
        });
        createdPoint = true;
        const [verification] = await tx
          .insert(simUransVerifyQueue)
          .values({
            airfoilId,
            revisionId: solverFixture.revisionId,
            aoaDeg,
            state: "blocked",
            precalcResultId: result.id,
            precalcResultAttemptId: attempt.id,
          })
          .returning({ id: simUransVerifyQueue.id });
        createdVerificationId = verification.id;
        await tx.insert(simUransVerifyQueueCampaigns).values({
          queueId: verification.id,
          campaignId,
          state: "active",
        });

        expect(await enforceSweeperAdmissionFence(tx)).toMatchObject({
          hazardPresent: true,
          fencedNow: true,
          active: true,
          trigger: {
            reason: "blocked_final_urans",
            campaignId,
            generation: 1,
          },
        });
        await tx
          .update(sweeperState)
          .set({
            enabled: true,
            maxConcurrentJobs: 2,
            cpuSlots: 2,
            admissionFenceActive: false,
            lastAdmissionFenceAt: null,
            lastAdmissionFenceReason: null,
            lastAdmissionFenceTriggerKey: null,
            lastAdmissionFenceDetails: null,
          })
          .where(eq(sweeperState.id, 1));
        await tx
          .update(simUransVerifyQueue)
          .set({ state: "pending" })
          .where(eq(simUransVerifyQueue.id, verification.id));

        const [incident] = await tx
          .insert(simSolverIncidents)
          .values({
            stage: "final",
            reason: "legacy-point-final-unavailable",
            severity: "critical",
            status: "open",
            verifyQueueId: verification.id,
            solverImplementationId: solverFixture.solverImplementationId,
            occurrenceKey: `${PREFIX}:legacy-point-final-unavailable`,
            remediationVersion: "breaker-test-v1",
          })
          .returning({ id: simSolverIncidents.id });
        await tx.insert(simSolverIncidentCampaigns).values({
          incidentId: incident.id,
          campaignId,
        });

        expect(
          await solverIncidentSummary(tx, {
            campaignId,
            currentGenerationOnly: true,
          }),
        ).toMatchObject({
          occurrenceCount: 1,
          openCount: 1,
          criticalGroupCount: 1,
          groups: [
            expect.objectContaining({
              reason: "legacy-point-final-unavailable",
            }),
          ],
        });
        expect(await enforceSweeperAdmissionFence(tx)).toMatchObject({
          hazardPresent: true,
          fencedNow: true,
          active: true,
          trigger: {
            reason: "critical_solver_incident",
            campaignId,
            generation: 1,
          },
        });

        await tx
          .update(simUransVerifyQueueCampaigns)
          .set({ state: "cancelled", cancelledAt: new Date() })
          .where(eq(simUransVerifyQueueCampaigns.queueId, verification.id));
        await tx
          .update(sweeperState)
          .set({
            enabled: true,
            maxConcurrentJobs: 2,
            cpuSlots: 2,
            admissionFenceActive: false,
            lastAdmissionFenceAt: null,
            lastAdmissionFenceReason: null,
            lastAdmissionFenceTriggerKey: null,
            lastAdmissionFenceDetails: null,
          })
          .where(eq(sweeperState.id, 1));
        expect(
          await solverIncidentSummary(tx, {
            campaignId,
            currentGenerationOnly: true,
          }),
        ).toMatchObject({
          occurrenceCount: 0,
          openCount: 0,
          criticalGroupCount: 0,
          groups: [],
        });
        expect(await enforceSweeperAdmissionFence(tx)).toEqual({
          hazardPresent: false,
          fencedNow: false,
          active: false,
          trigger: null,
        });
      } finally {
        if (createdVerificationId) {
          await tx
            .delete(simUransVerifyQueue)
            .where(eq(simUransVerifyQueue.id, createdVerificationId));
        }
        if (createdPoint) {
          await tx
            .delete(simCampaignPoints)
            .where(
              and(
                eq(simCampaignPoints.campaignId, campaignId),
                eq(simCampaignPoints.conditionId, conditionId),
                eq(simCampaignPoints.airfoilId, airfoilId),
                eq(simCampaignPoints.aoaDeg, aoaDeg),
              ),
            );
        }
        if (createdResultId) {
          await tx.delete(results).where(eq(results.id, createdResultId));
        }
        await tx
          .update(simUransRequests)
          .set({ state: "blocked" })
          .where(eq(simUransRequests.id, requestId));
        await tx
          .update(simCampaigns)
          .set({ currentConditionGeneration: 2 })
          .where(eq(simCampaigns.id, campaignId));
        await tx
          .update(sweeperState)
          .set({
            enabled: originalState.enabled,
            maxConcurrentJobs: originalState.maxConcurrentJobs,
            cpuSlots: originalState.cpuSlots,
            pollIntervalMs: originalState.pollIntervalMs,
            submitIntervalMs: originalState.submitIntervalMs,
            admissionFenceActive: originalState.admissionFenceActive,
            lastAdmissionFenceAt: originalState.lastAdmissionFenceAt,
            lastAdmissionFenceReason: originalState.lastAdmissionFenceReason,
            lastAdmissionFenceTriggerKey:
              originalState.lastAdmissionFenceTriggerKey,
            lastAdmissionFenceDetails: originalState.lastAdmissionFenceDetails,
          })
          .where(eq(sweeperState.id, 1));
      }
    });
  });

  it("ignores old-generation hazards, atomically fences the current generation, and re-trips before a resumed tick can submit", async () => {
    // Sweeper files run in parallel and several legitimately exercise the
    // singleton. Hold its row lock for this test transaction: concurrent
    // writers wait, ordinary readers keep seeing the last committed state,
    // and this file restores the exact prior row before releasing the lock.
    await db.transaction(async (transaction) => {
      const db = transaction as unknown as DB;
      await db.execute(drizzleSql`
        SELECT id FROM sweeper_state WHERE id = 1 FOR UPDATE
      `);
      const originalState = await readState(db);
      try {
        await db
          .update(sweeperState)
          .set({
            enabled: true,
            maxConcurrentJobs: 7,
            cpuSlots: 6,
            admissionFenceActive: false,
            lastAdmissionFenceAt: null,
            lastAdmissionFenceReason: null,
            lastAdmissionFenceTriggerKey: null,
            lastAdmissionFenceDetails: null,
          })
          .where(eq(sweeperState.id, 1));

        const oldGeneration = await enforceSweeperAdmissionFence(db);
        expect(oldGeneration).toMatchObject({
          hazardPresent: false,
          fencedNow: false,
          active: false,
        });
        expect(await readState(db)).toMatchObject({
          enabled: true,
          maxConcurrentJobs: 7,
          cpuSlots: 6,
          admissionFenceActive: false,
        });

        await db
          .update(simCampaigns)
          .set({ currentConditionGeneration: 1 })
          .where(eq(simCampaigns.id, campaignId));

        const first = await enforceSweeperAdmissionFence(db);
        expect(first).toMatchObject({
          hazardPresent: true,
          fencedNow: true,
          active: true,
          trigger: {
            reason: "blocked_urans_request",
            campaignId,
            generation: 1,
          },
        });
        const tripped = await readState(db);
        expect(tripped).toMatchObject({
          enabled: false,
          maxConcurrentJobs: 0,
          cpuSlots: 0,
          admissionFenceActive: true,
          lastAdmissionFenceReason: "blocked_urans_request",
        });
        expect(tripped.lastAdmissionFenceDetails).toMatchObject({
          requestId,
          previousEnabled: true,
          previousMaxConcurrentJobs: 7,
          previousCpuSlots: 6,
        });

        const firstTripAt = tripped.lastAdmissionFenceAt?.getTime();
        const second = await enforceSweeperAdmissionFence(db);
        expect(second).toMatchObject({
          hazardPresent: true,
          fencedNow: false,
          active: true,
        });
        expect((await readState(db)).lastAdmissionFenceAt?.getTime()).toBe(
          firstTripAt,
        );

        // Critical incident provenance outranks the coarser blocked ledger in the
        // same current physical cell, even though the first trip remains latched.
        const [incident] = await db
          .insert(simSolverIncidents)
          .values({
            stage: "final",
            reason: "repeatable-final-urans-failure",
            severity: "critical",
            status: "open",
            uransRequestId: requestId,
            solverImplementationId: solverFixture.solverImplementationId,
            occurrenceKey: `${PREFIX}:critical`,
            remediationVersion: "breaker-test-v1",
          })
          .returning();
        await db.insert(simSolverIncidentCampaigns).values({
          incidentId: incident.id,
          campaignId,
        });
        expect(await enforceSweeperAdmissionFence(db)).toMatchObject({
          hazardPresent: true,
          fencedNow: false,
          active: true,
          trigger: {
            reason: "critical_solver_incident",
            campaignId,
            generation: 1,
          },
        });

        // Simulate the atomic state produced by Resume. The unresolved durable
        // owner must close it in the tick's PRE-reconcile gate before either local
        // or remote submission gets an admission opportunity.
        await db
          .update(sweeperState)
          .set({
            enabled: true,
            maxConcurrentJobs: 7,
            cpuSlots: 6,
            admissionFenceActive: false,
          })
          .where(eq(sweeperState.id, 1));

        let submissions = 0;
        const engine = {
          baseUrl: "http://breaker.test",
          maintenanceDisk: async () => ({
            total_bytes: 500 * 1024 ** 3,
            free_bytes: 400 * 1024 ** 3,
            used_pct: 20,
          }),
          maintenanceJobs: async () => ({ items: [] }),
          health: async () => true,
          healthDetails: async () => ({ status: "ok" }),
          submitPolar: async () => {
            submissions += 1;
            throw new Error("breaker must stop submission");
          },
          getJob: async () => {
            throw new Error("no scoped job should be fetched");
          },
          cancelJob: async () => ({ status: "cancelled" }),
          getQueue: async () => ({
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
          }),
          cacheStats: async () => ({}),
          getJobRuntimes: async () => ({ jobs: [] }),
          getResult: async () => ({}),
          renderField: async () => ({}),
          computeFieldExtents: async () => ({}),
          renderDefaultMedia: async () => ({}),
          fileUrl: () => "http://breaker.test/file",
        } as unknown as EngineClient;

        await tick(db, engine, {
          jobIds: [crypto.randomUUID()],
          skipFailedRecovery: true,
        });
        expect(submissions).toBe(0);
        expect(await readState(db)).toMatchObject({
          enabled: false,
          maxConcurrentJobs: 0,
          cpuSlots: 0,
          admissionFenceActive: true,
          lastAdmissionFenceReason: "critical_solver_incident",
        });
        const [campaign] = await db
          .select({ status: simCampaigns.status })
          .from(simCampaigns)
          .where(eq(simCampaigns.id, campaignId));
        expect(campaign.status).toBe("active");
      } finally {
        await db
          .update(sweeperState)
          .set({
            enabled: originalState.enabled,
            maxConcurrentJobs: originalState.maxConcurrentJobs,
            cpuSlots: originalState.cpuSlots,
            pollIntervalMs: originalState.pollIntervalMs,
            submitIntervalMs: originalState.submitIntervalMs,
            admissionFenceActive: originalState.admissionFenceActive,
            lastAdmissionFenceAt: originalState.lastAdmissionFenceAt,
            lastAdmissionFenceReason: originalState.lastAdmissionFenceReason,
            lastAdmissionFenceTriggerKey:
              originalState.lastAdmissionFenceTriggerKey,
            lastAdmissionFenceDetails: originalState.lastAdmissionFenceDetails,
          })
          .where(eq(sweeperState.id, 1));
      }
    });
  }, 180_000);

  it("catches a hazard committed after the tick check at both local and remote engine boundaries", async () => {
    const originalState = await readState();
    await db
      .update(simCampaigns)
      .set({ currentConditionGeneration: 2 })
      .where(eq(simCampaigns.id, campaignId));
    await db
      .update(sweeperState)
      .set({
        enabled: true,
        maxConcurrentJobs: 2,
        cpuSlots: 2,
        admissionFenceActive: false,
      })
      .where(eq(sweeperState.id, 1));
    expect(await enforceSweeperAdmissionFence(db)).toMatchObject({
      hazardPresent: false,
      active: false,
    });

    const jobs = await db
      .insert(simJobs)
      .values([
        {
          airfoilId,
          bcIds: [solverFixture.bcId],
          simulationPresetRevisionId: solverFixture.revisionId,
          solverImplementationId: solverFixture.solverImplementationId,
          campaignId,
          jobKind: "targeted",
          referenceChordM: 0.987654,
          wave: 1,
          status: "pending" as const,
          totalCases: 1,
          requestPayload: { aoas: [AOA] },
        },
        {
          airfoilId,
          bcIds: [solverFixture.bcId],
          simulationPresetRevisionId: solverFixture.revisionId,
          solverImplementationId: solverFixture.solverImplementationId,
          jobKind: "sweep",
          referenceChordM: 0.987654,
          wave: 1,
          status: "pending" as const,
          totalCases: 1,
          requestPayload: { remoteSolver: true, aoas: [AOA] },
        },
      ])
      .returning({ id: simJobs.id });
    const [localJob, remoteJob] = jobs;
    if (!localJob || !remoteJob) throw new Error("submit fixtures missing");

    let submitCalls = 0;
    const engine = {
      submitPolar: async () => {
        submitCalls += 1;
        throw new Error("admission permit must stop the engine call");
      },
    } as unknown as EngineClient;
    try {
      // This commit occurs after the coarse tick-level check above.
      await db
        .update(simCampaigns)
        .set({ currentConditionGeneration: 1 })
        .where(eq(simCampaigns.id, campaignId));

      const local = await submitPendingJobWithLifecycleGuard({
        db,
        engine,
        jobId: localJob.id,
        admissionLane: "local",
        campaignId,
        request: {} as PolarRequest,
        connectionErrorPrefix: "unreachable: ",
        submitErrorPrefix: "failed: ",
      });
      expect(local).toMatchObject({ kind: "lifecycle_stopped" });
      expect(local.kind === "lifecycle_stopped" ? local.error : "").toMatch(
        /global admission safety stop/i,
      );

      // Resume between boundaries; the same unresolved hazard must re-trip at
      // the global/remote job boundary before submitPolar.
      await db
        .update(sweeperState)
        .set({
          enabled: true,
          maxConcurrentJobs: 2,
          cpuSlots: 2,
          admissionFenceActive: false,
        })
        .where(eq(sweeperState.id, 1));
      const remote = await submitPendingJobWithLifecycleGuard({
        db,
        engine,
        jobId: remoteJob.id,
        admissionLane: "remote",
        campaignId: null,
        request: {} as PolarRequest,
        connectionErrorPrefix: "unreachable: ",
        submitErrorPrefix: "failed: ",
      });
      expect(remote).toMatchObject({ kind: "lifecycle_stopped" });
      expect(submitCalls).toBe(0);
      const stopped = await db
        .select({ id: simJobs.id, status: simJobs.status })
        .from(simJobs)
        .where(inArray(simJobs.id, [localJob.id, remoteJob.id]));
      expect(stopped).toEqual(
        expect.arrayContaining([
          { id: localJob.id, status: "cancelled" },
          { id: remoteJob.id, status: "cancelled" },
        ]),
      );
    } finally {
      await db.delete(simJobs).where(
        inArray(
          simJobs.id,
          jobs.map((job) => job.id),
        ),
      );
      await db
        .update(simCampaigns)
        .set({ currentConditionGeneration: 2 })
        .where(eq(simCampaigns.id, campaignId));
      await db
        .update(sweeperState)
        .set({
          enabled: originalState.enabled,
          maxConcurrentJobs: originalState.maxConcurrentJobs,
          cpuSlots: originalState.cpuSlots,
          pollIntervalMs: originalState.pollIntervalMs,
          submitIntervalMs: originalState.submitIntervalMs,
          admissionFenceActive: originalState.admissionFenceActive,
          lastAdmissionFenceAt: originalState.lastAdmissionFenceAt,
          lastAdmissionFenceReason: originalState.lastAdmissionFenceReason,
          lastAdmissionFenceTriggerKey:
            originalState.lastAdmissionFenceTriggerKey,
          lastAdmissionFenceDetails: originalState.lastAdmissionFenceDetails,
        })
        .where(eq(sweeperState.id, 1));
    }
  });

  it("serializes transitions into every durable hazard table on the singleton admission lock", async () => {
    const triggerAoa = AOA + 0.271;
    const resultAoa = AOA + 0.272;
    const [obligation] = await db
      .insert(simPrecalcObligations)
      .values({
        airfoilId,
        revisionId: solverFixture.revisionId,
        aoaDeg: triggerAoa,
        state: "pending",
      })
      .returning({ id: simPrecalcObligations.id });
    const [precalcResult] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: solverFixture.bcId,
        simulationPresetRevisionId: solverFixture.revisionId,
        solverImplementationId: solverFixture.solverImplementationId,
        aoaDeg: resultAoa,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
      })
      .returning({ id: results.id });
    const [precalcAttempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: precalcResult.id,
        airfoilId,
        bcId: solverFixture.bcId,
        simulationPresetRevisionId: solverFixture.revisionId,
        solverImplementationId: solverFixture.solverImplementationId,
        aoaDeg: resultAoa,
        status: "done",
        source: "solved",
        regime: "urans",
      })
      .returning({ id: resultAttempts.id });
    const [verification] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId: solverFixture.revisionId,
        aoaDeg: resultAoa,
        state: "pending",
        precalcResultId: precalcResult.id,
        precalcResultAttemptId: precalcAttempt.id,
      })
      .returning({ id: simUransVerifyQueue.id });
    const [incident] = await db
      .insert(simSolverIncidents)
      .values({
        stage: "preliminary",
        reason: "admission-trigger-warning-fixture",
        severity: "warning",
        status: "open",
        precalcObligationId: obligation.id,
        solverImplementationId: solverFixture.solverImplementationId,
        occurrenceKey: `${PREFIX}:trigger-warning`,
        remediationVersion: "admission-trigger-test-v1",
      })
      .returning({ id: simSolverIncidents.id });
    let originalProgress: typeof simCampaignProgress.$inferSelect | undefined;
    let progressCreated = false;
    try {
      [originalProgress] = await db
        .select()
        .from(simCampaignProgress)
        .where(
          drizzleSql`${simCampaignProgress.campaignId} = ${campaignId}
            AND ${simCampaignProgress.conditionId} = ${conditionId}
            AND ${simCampaignProgress.airfoilId} = ${airfoilId}`,
        )
        .limit(1);
      if (originalProgress) {
        await db
          .update(simCampaignProgress)
          .set({ blocked: 0, blockedOther: 0 })
          .where(
            drizzleSql`${simCampaignProgress.campaignId} = ${campaignId}
              AND ${simCampaignProgress.conditionId} = ${conditionId}
              AND ${simCampaignProgress.airfoilId} = ${airfoilId}`,
          );
      } else {
        await db.insert(simCampaignProgress).values({
          campaignId,
          conditionId,
          airfoilId,
          requested: 1,
        });
        progressCreated = true;
      }

      const triggers = (await db.execute(drizzleSql`
        SELECT trigger_name
        FROM information_schema.triggers
        WHERE trigger_schema = 'public'
          AND trigger_name LIKE '%_admission_hazard_%'
        ORDER BY trigger_name
      `)) as unknown as Array<{ trigger_name: string }>;
      expect(triggers.map((row) => row.trigger_name)).toEqual([
        "sim_campaign_conditions_admission_hazard_insert",
        "sim_campaign_conditions_admission_hazard_update",
        "sim_campaign_points_admission_hazard_insert",
        "sim_campaign_points_admission_hazard_update",
        "sim_campaign_progress_admission_hazard_insert",
        "sim_campaign_progress_admission_hazard_update",
        "sim_campaigns_admission_hazard_insert",
        "sim_campaigns_admission_hazard_update",
        "sim_precalc_obligation_campaigns_admission_hazard_insert",
        "sim_precalc_obligation_campaigns_admission_hazard_update",
        "sim_precalc_obligations_admission_hazard_insert",
        "sim_precalc_obligations_admission_hazard_update",
        "sim_solver_incident_campaigns_admission_hazard_insert",
        "sim_solver_incident_campaigns_admission_hazard_update",
        "sim_solver_incidents_admission_hazard_insert",
        "sim_solver_incidents_admission_hazard_update",
        "sim_urans_request_campaigns_admission_hazard_insert",
        "sim_urans_request_campaigns_admission_hazard_update",
        "sim_urans_requests_admission_hazard_insert",
        "sim_urans_requests_admission_hazard_update",
        "sim_urans_verify_queue_admission_hazard_insert",
        "sim_urans_verify_queue_admission_hazard_update",
        "sim_urans_verify_queue_campaigns_admission_hazard_insert",
        "sim_urans_verify_queue_campaigns_admission_hazard_update",
        "sim_urans_verify_queue_requests_admission_hazard_insert",
        "sim_urans_verify_queue_requests_admission_hazard_update",
      ]);

      await expectHazardTransitionWaitsForAdmissionLock(
        "admission-trigger-incident-test",
        () =>
          db.execute(drizzleSql`
            UPDATE sim_solver_incidents
            SET severity = 'critical'
            WHERE id = ${incident.id}
            /* admission-trigger-incident-test */
          `),
      );
      await db
        .update(simSolverIncidents)
        .set({ severity: "warning" })
        .where(eq(simSolverIncidents.id, incident.id));

      await expectHazardTransitionWaitsForAdmissionLock(
        "admission-trigger-precalc-test",
        () =>
          db.execute(drizzleSql`
            UPDATE sim_precalc_obligations
            SET state = 'blocked'
            WHERE id = ${obligation.id}
            /* admission-trigger-precalc-test */
          `),
      );
      await db
        .update(simPrecalcObligations)
        .set({ state: "pending" })
        .where(eq(simPrecalcObligations.id, obligation.id));

      await expectHazardTransitionWaitsForAdmissionLock(
        "admission-trigger-verify-test",
        () =>
          db.execute(drizzleSql`
            UPDATE sim_urans_verify_queue
            SET state = 'blocked'
            WHERE id = ${verification.id}
            /* admission-trigger-verify-test */
          `),
      );
      await db
        .update(simUransVerifyQueue)
        .set({ state: "pending" })
        .where(eq(simUransVerifyQueue.id, verification.id));

      await db
        .update(simUransRequests)
        .set({ state: "pending" })
        .where(eq(simUransRequests.id, requestId));
      await expectHazardTransitionWaitsForAdmissionLock(
        "admission-trigger-request-test",
        () =>
          db.execute(drizzleSql`
            UPDATE sim_urans_requests
            SET state = 'blocked'
            WHERE id = ${requestId}
            /* admission-trigger-request-test */
          `),
      );
      await db
        .update(simUransRequests)
        .set({ state: "pending" })
        .where(eq(simUransRequests.id, requestId));

      await expectHazardTransitionWaitsForAdmissionLock(
        "admission-trigger-progress-test",
        () =>
          db.execute(drizzleSql`
            UPDATE sim_campaign_progress
            SET blocked = 1,
                blocked_other = 1
            WHERE campaign_id = ${campaignId}
              AND condition_id = ${conditionId}
              AND airfoil_id = ${airfoilId}
            /* admission-trigger-progress-test */
          `),
      );
      await db
        .update(simCampaignProgress)
        .set({ blocked: 0, blockedOther: 0 })
        .where(
          drizzleSql`${simCampaignProgress.campaignId} = ${campaignId}
            AND ${simCampaignProgress.conditionId} = ${conditionId}
            AND ${simCampaignProgress.airfoilId} = ${airfoilId}`,
        );
    } finally {
      if (originalProgress) {
        await db
          .update(simCampaignProgress)
          .set({
            requested: originalProgress.requested,
            solved: originalProgress.solved,
            failed: originalProgress.failed,
            running: originalProgress.running,
            superseded: originalProgress.superseded,
            derived: originalProgress.derived,
            rejected: originalProgress.rejected,
            blocked: originalProgress.blocked,
            precalcMeshRepairing: originalProgress.precalcMeshRepairing,
            blockedMeshQuality: originalProgress.blockedMeshQuality,
            blockedPrecalcExhausted: originalProgress.blockedPrecalcExhausted,
            blockedEngineSubmit: originalProgress.blockedEngineSubmit,
            blockedOther: originalProgress.blockedOther,
          })
          .where(
            drizzleSql`${simCampaignProgress.campaignId} = ${campaignId}
              AND ${simCampaignProgress.conditionId} = ${conditionId}
              AND ${simCampaignProgress.airfoilId} = ${airfoilId}`,
          );
      } else if (progressCreated) {
        await db.delete(simCampaignProgress).where(
          drizzleSql`${simCampaignProgress.campaignId} = ${campaignId}
            AND ${simCampaignProgress.conditionId} = ${conditionId}
            AND ${simCampaignProgress.airfoilId} = ${airfoilId}`,
        );
      }
      await db
        .delete(simSolverIncidents)
        .where(eq(simSolverIncidents.id, incident.id));
      await db
        .delete(simUransVerifyQueue)
        .where(eq(simUransVerifyQueue.id, verification.id));
      await db
        .delete(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation.id));
      await db.delete(results).where(eq(results.id, precalcResult.id));
      await db
        .update(simUransRequests)
        .set({ state: "blocked" })
        .where(eq(simUransRequests.id, requestId));
    }
  }, 60_000);

  it("orders global Pause before local engine admission while preserving remote-only admission", async () => {
    const originalState = await readState();
    await db
      .update(simCampaigns)
      .set({ currentConditionGeneration: 2 })
      .where(eq(simCampaigns.id, campaignId));
    await db
      .update(sweeperState)
      .set({
        enabled: true,
        maxConcurrentJobs: 1,
        cpuSlots: 1,
        admissionFenceActive: false,
        lastAdmissionFenceAt: null,
        lastAdmissionFenceReason: null,
        lastAdmissionFenceTriggerKey: null,
        lastAdmissionFenceDetails: null,
      })
      .where(eq(sweeperState.id, 1));

    const jobs = await db
      .insert(simJobs)
      .values([
        {
          airfoilId,
          bcIds: [solverFixture.bcId],
          simulationPresetRevisionId: solverFixture.revisionId,
          solverImplementationId: solverFixture.solverImplementationId,
          campaignId,
          jobKind: "targeted",
          referenceChordM: 0.987654,
          wave: 1,
          status: "pending" as const,
          totalCases: 1,
          requestPayload: { aoas: [AOA] },
        },
        {
          airfoilId,
          bcIds: [solverFixture.bcId],
          simulationPresetRevisionId: solverFixture.revisionId,
          solverImplementationId: solverFixture.solverImplementationId,
          jobKind: "sweep",
          referenceChordM: 0.987654,
          wave: 1,
          status: "pending" as const,
          totalCases: 1,
          requestPayload: { remoteSolver: true, aoas: [AOA] },
        },
      ])
      .returning({ id: simJobs.id });
    const [localJob, remoteJob] = jobs;
    if (!localJob || !remoteJob)
      throw new Error("pause-boundary submit fixtures missing");

    const pauseLocked = deferred<void>();
    const releasePause = deferred<void>();
    let pauseWriter: Promise<unknown> | null = null;
    let localSubmit: Promise<unknown> | null = null;
    let submitCalls = 0;
    const engine = {
      submitPolar: async (): Promise<JobStatus> => {
        submitCalls += 1;
        return {
          job_id: `${PREFIX}-remote-only-engine`,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        };
      },
    } as unknown as EngineClient;

    try {
      pauseWriter = db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as DB;
        await tx.execute(drizzleSql`
          SELECT id
          FROM sweeper_state
          WHERE id = 1
          FOR UPDATE /* admission-race-global-pause-writer */
        `);
        await tx
          .update(sweeperState)
          .set({ enabled: false })
          .where(eq(sweeperState.id, 1));
        pauseLocked.resolve(undefined);
        await releasePause.promise;
      });
      await pauseLocked.promise;

      localSubmit = submitPendingJobWithLifecycleGuard({
        db,
        engine,
        jobId: localJob.id,
        admissionLane: "local",
        campaignId,
        request: {} as PolarRequest,
        connectionErrorPrefix: "unreachable: ",
        submitErrorPrefix: "failed: ",
      });
      await waitForLockWait("submit lifecycle global admission permit");
      expect(submitCalls).toBe(0);
      releasePause.resolve(undefined);
      await pauseWriter;
      const localOutcome = await localSubmit;
      expect(localOutcome).toMatchObject({ kind: "lifecycle_stopped" });
      expect(
        localOutcome &&
          typeof localOutcome === "object" &&
          "error" in localOutcome
          ? String(localOutcome.error)
          : "",
      ).toMatch(/global scheduler is paused/i);
      expect(submitCalls).toBe(0);

      const remoteOutcome = await submitPendingJobWithLifecycleGuard({
        db,
        engine,
        jobId: remoteJob.id,
        admissionLane: "remote",
        campaignId: null,
        request: {} as PolarRequest,
        connectionErrorPrefix: "unreachable: ",
        submitErrorPrefix: "failed: ",
      });
      expect(remoteOutcome).toMatchObject({ kind: "submitted" });
      expect(submitCalls).toBe(1);
    } finally {
      releasePause.resolve(undefined);
      await Promise.allSettled(
        [pauseWriter, localSubmit].filter(
          (item): item is Promise<unknown> => item !== null,
        ),
      );
      await db.delete(simJobs).where(
        inArray(
          simJobs.id,
          jobs.map((job) => job.id),
        ),
      );
      await db
        .update(simCampaigns)
        .set({ currentConditionGeneration: 1 })
        .where(eq(simCampaigns.id, campaignId));
      await db
        .update(sweeperState)
        .set({
          enabled: originalState.enabled,
          maxConcurrentJobs: originalState.maxConcurrentJobs,
          cpuSlots: originalState.cpuSlots,
          pollIntervalMs: originalState.pollIntervalMs,
          submitIntervalMs: originalState.submitIntervalMs,
          admissionFenceActive: originalState.admissionFenceActive,
          lastAdmissionFenceAt: originalState.lastAdmissionFenceAt,
          lastAdmissionFenceReason: originalState.lastAdmissionFenceReason,
          lastAdmissionFenceTriggerKey:
            originalState.lastAdmissionFenceTriggerKey,
          lastAdmissionFenceDetails: originalState.lastAdmissionFenceDetails,
        })
        .where(eq(sweeperState.id, 1));
    }
  }, 60_000);

  it("admits the operator canary only behind an exact paused zero-capacity fence", async () => {
    const originalState = await readState();
    await db
      .update(simCampaigns)
      .set({ currentConditionGeneration: 2 })
      .where(eq(simCampaigns.id, campaignId));
    await db
      .update(sweeperState)
      .set({
        enabled: false,
        maxConcurrentJobs: 0,
        cpuSlots: 0,
        admissionFenceActive: false,
        lastAdmissionFenceAt: null,
        lastAdmissionFenceReason: null,
        lastAdmissionFenceTriggerKey: null,
        lastAdmissionFenceDetails: null,
      })
      .where(eq(sweeperState.id, 1));

    const jobs = await db
      .insert(simJobs)
      .values(
        Array.from({ length: 3 }, () => ({
          airfoilId,
          bcIds: [solverFixture.bcId],
          simulationPresetRevisionId: solverFixture.revisionId,
          solverImplementationId: solverFixture.solverImplementationId,
          jobKind: "targeted" as const,
          referenceChordM: 0.987654,
          wave: 2,
          status: "pending" as const,
          totalCases: 1,
          requestPayload: { aoas: [AOA] },
        })),
      )
      .returning({ id: simJobs.id });
    if (jobs.length !== 3)
      throw new Error("operator-canary submit fixtures missing");

    let submitCalls = 0;
    const engine = {
      submitPolar: async (): Promise<JobStatus> => {
        submitCalls += 1;
        return {
          job_id: `${PREFIX}-operator-canary-${submitCalls}`,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        };
      },
    } as unknown as EngineClient;
    const submit = (jobId: string) =>
      submitPendingJobWithLifecycleGuard({
        db,
        engine,
        jobId,
        admissionLane: "operator_canary",
        campaignId: null,
        request: {} as PolarRequest,
        connectionErrorPrefix: "unreachable: ",
        submitErrorPrefix: "failed: ",
      });

    try {
      const admitted = await submit(jobs[0].id);
      expect(admitted).toMatchObject({ kind: "submitted" });
      expect(submitCalls).toBe(1);

      await db
        .update(sweeperState)
        .set({ enabled: true, maxConcurrentJobs: 0, cpuSlots: 0 })
        .where(eq(sweeperState.id, 1));
      const schedulerOpen = await submit(jobs[1].id);
      expect(schedulerOpen).toMatchObject({ kind: "lifecycle_stopped" });
      expect(
        schedulerOpen.kind === "lifecycle_stopped" ? schedulerOpen.error : "",
      ).toMatch(/operator canary requires a paused scheduler/i);

      await db
        .update(sweeperState)
        .set({ enabled: false, maxConcurrentJobs: 1, cpuSlots: 0 })
        .where(eq(sweeperState.id, 1));
      const capacityOpen = await submit(jobs[2].id);
      expect(capacityOpen).toMatchObject({ kind: "lifecycle_stopped" });
      expect(submitCalls).toBe(1);
    } finally {
      await db.delete(simJobs).where(
        inArray(
          simJobs.id,
          jobs.map((job) => job.id),
        ),
      );
      await db
        .update(simCampaigns)
        .set({ currentConditionGeneration: 1 })
        .where(eq(simCampaigns.id, campaignId));
      await db
        .update(sweeperState)
        .set({
          enabled: originalState.enabled,
          maxConcurrentJobs: originalState.maxConcurrentJobs,
          cpuSlots: originalState.cpuSlots,
          pollIntervalMs: originalState.pollIntervalMs,
          submitIntervalMs: originalState.submitIntervalMs,
          admissionFenceActive: originalState.admissionFenceActive,
          lastAdmissionFenceAt: originalState.lastAdmissionFenceAt,
          lastAdmissionFenceReason: originalState.lastAdmissionFenceReason,
          lastAdmissionFenceTriggerKey:
            originalState.lastAdmissionFenceTriggerKey,
          lastAdmissionFenceDetails: originalState.lastAdmissionFenceDetails,
        })
        .where(eq(sweeperState.id, 1));
    }
  }, 60_000);

  it("denies mixed-mode remote RANS when a concurrent submit fills shared capacity", async () => {
    const originalState = await readState();
    await db
      .update(simCampaigns)
      .set({ currentConditionGeneration: 2 })
      .where(eq(simCampaigns.id, campaignId));
    await db
      .update(sweeperState)
      .set({
        enabled: true,
        maxConcurrentJobs: 1,
        cpuSlots: 1,
        admissionFenceActive: false,
        lastAdmissionFenceAt: null,
        lastAdmissionFenceReason: null,
        lastAdmissionFenceTriggerKey: null,
        lastAdmissionFenceDetails: null,
      })
      .where(eq(sweeperState.id, 1));

    const jobs = await db
      .insert(simJobs)
      .values([
        {
          airfoilId,
          bcIds: [solverFixture.bcId],
          simulationPresetRevisionId: solverFixture.revisionId,
          solverImplementationId: solverFixture.solverImplementationId,
          jobKind: "targeted",
          referenceChordM: 0.987654,
          wave: 1,
          status: "pending" as const,
          totalCases: 1,
          requestPayload: { aoas: [AOA] },
        },
        {
          airfoilId,
          bcIds: [solverFixture.bcId],
          simulationPresetRevisionId: solverFixture.revisionId,
          solverImplementationId: solverFixture.solverImplementationId,
          jobKind: "sweep",
          referenceChordM: 0.987654,
          wave: 1,
          status: "pending" as const,
          totalCases: 1,
          requestPayload: { remoteSolver: true, aoas: [AOA] },
        },
      ])
      .returning({ id: simJobs.id });
    const [capacityJob, remoteJob] = jobs;
    if (!capacityJob || !remoteJob)
      throw new Error("shared-capacity submit fixtures missing");

    const capacityWriterLocked = deferred<void>();
    const releaseCapacityWriter = deferred<void>();
    let capacityWriter: Promise<unknown> | null = null;
    let remoteSubmit: Promise<unknown> | null = null;
    let submitCalls = 0;
    const engine = {
      submitPolar: async () => {
        submitCalls += 1;
        throw new Error("full shared capacity must stop the engine call");
      },
    } as unknown as EngineClient;

    try {
      capacityWriter = db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as DB;
        await tx.execute(drizzleSql`
          SELECT id
          FROM sweeper_state
          WHERE id = 1
          FOR UPDATE /* admission-race-shared-capacity-writer */
        `);
        await tx
          .update(simJobs)
          .set({ status: "submitted" })
          .where(eq(simJobs.id, capacityJob.id));
        capacityWriterLocked.resolve(undefined);
        await releaseCapacityWriter.promise;
      });
      await capacityWriterLocked.promise;

      remoteSubmit = submitPendingJobWithLifecycleGuard({
        db,
        engine,
        jobId: remoteJob.id,
        admissionLane: "remote",
        campaignId: null,
        request: {} as PolarRequest,
        connectionErrorPrefix: "unreachable: ",
        submitErrorPrefix: "failed: ",
      });
      await waitForLockWait("submit lifecycle global admission permit");
      expect(submitCalls).toBe(0);
      releaseCapacityWriter.resolve(undefined);
      await capacityWriter;
      const remoteOutcome = await remoteSubmit;
      expect(remoteOutcome).toMatchObject({ kind: "lifecycle_stopped" });
      expect(
        remoteOutcome &&
          typeof remoteOutcome === "object" &&
          "error" in remoteOutcome
          ? String(remoteOutcome.error)
          : "",
      ).toMatch(/shared scheduler capacity is full \(1\/1\)/i);
      expect(submitCalls).toBe(0);
    } finally {
      releaseCapacityWriter.resolve(undefined);
      await Promise.allSettled(
        [capacityWriter, remoteSubmit].filter(
          (item): item is Promise<unknown> => item !== null,
        ),
      );
      await db.delete(simJobs).where(
        inArray(
          simJobs.id,
          jobs.map((job) => job.id),
        ),
      );
      await db
        .update(simCampaigns)
        .set({ currentConditionGeneration: 1 })
        .where(eq(simCampaigns.id, campaignId));
      await db
        .update(sweeperState)
        .set({
          enabled: originalState.enabled,
          maxConcurrentJobs: originalState.maxConcurrentJobs,
          cpuSlots: originalState.cpuSlots,
          pollIntervalMs: originalState.pollIntervalMs,
          submitIntervalMs: originalState.submitIntervalMs,
          admissionFenceActive: originalState.admissionFenceActive,
          lastAdmissionFenceAt: originalState.lastAdmissionFenceAt,
          lastAdmissionFenceReason: originalState.lastAdmissionFenceReason,
          lastAdmissionFenceTriggerKey:
            originalState.lastAdmissionFenceTriggerKey,
          lastAdmissionFenceDetails: originalState.lastAdmissionFenceDetails,
        })
        .where(eq(sweeperState.id, 1));
    }
  }, 60_000);

  it("orders hazard commit and engine acceptance in both directions across two connections", async () => {
    const originalState = await readState();
    await db
      .delete(simSolverIncidents)
      .where(eq(simSolverIncidents.occurrenceKey, `${PREFIX}:critical`));
    await db
      .update(simCampaigns)
      .set({ currentConditionGeneration: 1 })
      .where(eq(simCampaigns.id, campaignId));
    await db
      .update(simUransRequests)
      .set({ state: "pending" })
      .where(eq(simUransRequests.id, requestId));
    await db
      .update(sweeperState)
      .set({
        enabled: true,
        maxConcurrentJobs: 2,
        cpuSlots: 2,
        admissionFenceActive: false,
        lastAdmissionFenceAt: null,
        lastAdmissionFenceReason: null,
        lastAdmissionFenceTriggerKey: null,
        lastAdmissionFenceDetails: null,
      })
      .where(eq(sweeperState.id, 1));

    const jobs = await db
      .insert(simJobs)
      .values([
        {
          airfoilId,
          bcIds: [solverFixture.bcId],
          simulationPresetRevisionId: solverFixture.revisionId,
          solverImplementationId: solverFixture.solverImplementationId,
          campaignId,
          jobKind: "targeted",
          referenceChordM: 0.987654,
          wave: 1,
          status: "pending" as const,
          totalCases: 1,
          requestPayload: { aoas: [AOA] },
        },
        {
          airfoilId,
          bcIds: [solverFixture.bcId],
          simulationPresetRevisionId: solverFixture.revisionId,
          solverImplementationId: solverFixture.solverImplementationId,
          campaignId,
          jobKind: "targeted",
          referenceChordM: 0.987654,
          wave: 1,
          status: "pending" as const,
          totalCases: 1,
          requestPayload: { aoas: [AOA] },
        },
      ])
      .returning({ id: simJobs.id });
    const [submitFirstJob, hazardFirstJob] = jobs;
    if (!submitFirstJob || !hazardFirstJob)
      throw new Error("admission ordering fixtures missing");

    const acceptedStatus: JobStatus = {
      job_id: `${PREFIX}-serialized-engine`,
      state: "pending",
      total_cases: 1,
      completed_cases: 0,
    };
    const engineEntered = deferred<void>();
    const releaseEngine = deferred<JobStatus>();
    const releaseHazardWriter = deferred<void>();
    const hazardWriterLocked = deferred<void>();
    let submitCalls = 0;
    let firstSubmit: Promise<unknown> | null = null;
    let firstHazard: Promise<unknown> | null = null;
    let secondSubmit: Promise<unknown> | null = null;
    let secondHazard: Promise<unknown> | null = null;
    const engine = {
      submitPolar: async () => {
        submitCalls += 1;
        engineEntered.resolve(undefined);
        return releaseEngine.promise;
      },
      cancelJob: async () => ({ status: "cancelled" }),
    } as unknown as EngineClient;

    try {
      // Engine acceptance owns the singleton first. The terminal writer has
      // already updated its owner row, but its transition trigger cannot
      // commit until the bounded submit call answers and releases the lock.
      firstSubmit = submitPendingJobWithLifecycleGuard({
        db,
        engine,
        jobId: submitFirstJob.id,
        admissionLane: "local",
        campaignId,
        request: {} as PolarRequest,
        connectionErrorPrefix: "unreachable: ",
        submitErrorPrefix: "failed: ",
      });
      await engineEntered.promise;
      let firstHazardCommitted = false;
      firstHazard = db
        .execute(
          drizzleSql`
          UPDATE sim_urans_requests
          SET state = 'blocked'
          WHERE id = ${requestId}
          /* admission-race-submit-first-hazard */
        `,
        )
        .finally(() => {
          firstHazardCommitted = true;
        });
      await waitForLockWait("admission-race-submit-first-hazard");
      expect(firstHazardCommitted).toBe(false);
      releaseEngine.resolve(acceptedStatus);
      const firstOutcome = await firstSubmit;
      await firstHazard;
      expect(firstOutcome).toMatchObject({ kind: "submitted" });
      expect(submitCalls).toBe(1);

      // Reverse the order. The hazard transition owns the singleton and stays
      // uncommitted while the submitter reaches its real permit boundary.
      // Once it commits, the waiter re-reads the hazard and never calls the
      // engine for this second job.
      await db
        .update(simUransRequests)
        .set({ state: "pending" })
        .where(eq(simUransRequests.id, requestId));
      secondHazard = db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as DB;
        await tx.execute(drizzleSql`
          UPDATE sim_urans_requests
          SET state = 'blocked'
          WHERE id = ${requestId}
          /* admission-race-hazard-first-writer */
        `);
        hazardWriterLocked.resolve(undefined);
        await releaseHazardWriter.promise;
      });
      await hazardWriterLocked.promise;
      secondSubmit = submitPendingJobWithLifecycleGuard({
        db,
        engine,
        jobId: hazardFirstJob.id,
        admissionLane: "local",
        campaignId,
        request: {} as PolarRequest,
        connectionErrorPrefix: "unreachable: ",
        submitErrorPrefix: "failed: ",
      });
      await waitForLockWait("submit lifecycle global admission permit");
      expect(submitCalls).toBe(1);
      releaseHazardWriter.resolve(undefined);
      await secondHazard;
      const secondOutcome = await secondSubmit;
      expect(secondOutcome).toMatchObject({ kind: "lifecycle_stopped" });
      expect(submitCalls).toBe(1);
    } finally {
      releaseEngine.resolve(acceptedStatus);
      releaseHazardWriter.resolve(undefined);
      await Promise.allSettled(
        [firstSubmit, firstHazard, secondSubmit, secondHazard].filter(
          (item): item is Promise<unknown> => item !== null,
        ),
      );
      await db
        .update(simCampaigns)
        .set({ currentConditionGeneration: 2 })
        .where(eq(simCampaigns.id, campaignId));
      await db
        .update(simUransRequests)
        .set({ state: "blocked" })
        .where(eq(simUransRequests.id, requestId));
      await db.delete(simJobs).where(
        inArray(
          simJobs.id,
          jobs.map((job) => job.id),
        ),
      );
      await db
        .update(sweeperState)
        .set({
          enabled: originalState.enabled,
          maxConcurrentJobs: originalState.maxConcurrentJobs,
          cpuSlots: originalState.cpuSlots,
          pollIntervalMs: originalState.pollIntervalMs,
          submitIntervalMs: originalState.submitIntervalMs,
          admissionFenceActive: originalState.admissionFenceActive,
          lastAdmissionFenceAt: originalState.lastAdmissionFenceAt,
          lastAdmissionFenceReason: originalState.lastAdmissionFenceReason,
          lastAdmissionFenceTriggerKey:
            originalState.lastAdmissionFenceTriggerKey,
          lastAdmissionFenceDetails: originalState.lastAdmissionFenceDetails,
        })
        .where(eq(sweeperState.id, 1));
    }
  }, 60_000);
});
