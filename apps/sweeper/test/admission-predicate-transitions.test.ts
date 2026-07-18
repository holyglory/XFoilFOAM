import {
  airfoils,
  createClient,
  type DB,
  enforceSweeperAdmissionFence,
  simCampaignConditions,
  simCampaignPlanRevisions,
  simCampaignPoints,
  simCampaigns,
  simJobs,
  simUransRequestCampaigns,
  simUransRequests,
  simulationPresetRevisions,
  simulationPresets,
  sweeperState,
} from "@aerodb/db";
import type {
  EngineClient,
  JobStatus,
  PolarRequest,
} from "@aerodb/engine-client";
import { eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMinimalSolverFixture,
  type MinimalSolverFixture,
} from "../../../packages/db/test/solver-fixture";
import { submitPendingJobWithLifecycleGuard } from "../src/submit-lifecycle";

const { db, sql } = createClient({ max: 8 });
const PREFIX = `admission-predicates-${process.pid}-${Date.now().toString(36)}`;
const AOA = 81 + (process.pid % 1000) / 100_000;

let originalState: typeof sweeperState.$inferSelect;
let fixture: MinimalSolverFixture;
let campaignId = "";
let conditionId = "";
let airfoilId = "";
let requestId = "";
const jobIds: string[] = [];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForLockWait(marker: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await db.execute(drizzleSql`
      SELECT pid
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND datname = current_database()
      LIMIT 1
    `)) as unknown as Array<{ pid: number }>;
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`query did not wait on the admission lock: ${marker}`);
}

async function resetFence() {
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
}

async function createRemoteJob(label: string) {
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [fixture.bcId],
      simulationPresetRevisionId: fixture.revisionId,
      solverImplementationId: fixture.solverImplementationId,
      jobKind: "targeted",
      referenceChordM: 0.987654,
      wave: 1,
      status: "pending",
      totalCases: 1,
      requestPayload: { remoteSolver: true, aoas: [AOA], test: label },
    })
    .returning({ id: simJobs.id });
  jobIds.push(job.id);
  return job.id;
}

function submit(jobId: string, engine: EngineClient) {
  return submitPendingJobWithLifecycleGuard({
    db,
    engine,
    jobId,
    admissionLane: "remote",
    campaignId: null,
    request: {} as PolarRequest,
    connectionErrorPrefix: "unreachable: ",
    submitErrorPrefix: "failed: ",
  });
}

const acceptedStatus = (label: string): JobStatus => ({
  job_id: `${PREFIX}-${label}`,
  state: "pending",
  total_cases: 1,
  completed_cases: 0,
});

async function setOwnership(active: boolean) {
  await db
    .delete(simUransRequestCampaigns)
    .where(eq(simUransRequestCampaigns.requestId, requestId));
  if (active) {
    await db.insert(simUransRequestCampaigns).values({
      requestId,
      campaignId,
      state: "active",
    });
  }
}

async function expectBlockedRequestHazard() {
  const fence = await enforceSweeperAdmissionFence(db);
  expect(fence).toMatchObject({
    hazardPresent: true,
    active: true,
    trigger: { reason: "blocked_urans_request", campaignId },
  });
}

beforeAll(async () => {
  const [state] = await db
    .select()
    .from(sweeperState)
    .where(eq(sweeperState.id, 1))
    .limit(1);
  if (!state) throw new Error("seeded sweeper_state singleton missing");
  originalState = state;
  fixture = await createMinimalSolverFixture(db, PREFIX);

  const [airfoil] = await db
    .select({ id: airfoils.id })
    .from(airfoils)
    .limit(1);
  const [setup] = await db
    .select({
      presetId: simulationPresets.id,
      revisionId: simulationPresetRevisions.id,
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
    .where(eq(simulationPresetRevisions.id, fixture.revisionId))
    .limit(1);
  if (!airfoil || !setup) throw new Error("seeded solver setup missing");
  airfoilId = airfoil.id;

  const [campaign] = await db
    .insert(simCampaigns)
    .values({
      slug: PREFIX,
      name: PREFIX,
      idempotencyKey: PREFIX,
      status: "paused",
      currentConditionGeneration: 1,
    })
    .returning({ id: simCampaigns.id });
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
    .returning({ id: simCampaignPlanRevisions.id });
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
    .returning({ id: simCampaignConditions.id });
  conditionId = condition.id;
  await db.insert(simCampaignPoints).values({
    campaignId,
    conditionId,
    airfoilId,
    aoaDeg: AOA,
    revisionId: fixture.revisionId,
    planRevisionNumber: 1,
    state: "requested",
  });
  const [request] = await db
    .insert(simUransRequests)
    .values({
      airfoilId,
      revisionId: fixture.revisionId,
      aoaDeg: AOA,
      fidelity: "precalc",
      state: "blocked",
      requestedBy: PREFIX,
    })
    .returning({ id: simUransRequests.id });
  requestId = request.id;
  await setOwnership(true);
  await resetFence();
});

afterAll(async () => {
  if (jobIds.length) {
    await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
  }
  if (requestId) {
    await db.delete(simUransRequests).where(eq(simUransRequests.id, requestId));
  }
  if (campaignId) {
    await db.delete(simCampaigns).where(eq(simCampaigns.id, campaignId));
  }
  await fixture?.cleanup();
  if (originalState) {
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
  await sql.end();
});

describe("migration 0075 predicate-transition admission safety", () => {
  it("installs the complete owner and predicate trigger inventory", async () => {
    const rows = (await db.execute(drizzleSql`
      SELECT event_object_table AS table_name,
             trigger_name,
             event_manipulation AS event,
             action_orientation AS orientation
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
        AND trigger_name LIKE '%_admission_hazard_%'
      ORDER BY event_object_table, trigger_name
    `)) as unknown as Array<{
      table_name: string;
      trigger_name: string;
      event: string;
      orientation: string;
    }>;
    const expectedTables = [
      "sim_campaign_conditions",
      "sim_campaign_points",
      "sim_campaign_progress",
      "sim_campaigns",
      "sim_precalc_obligation_campaigns",
      "sim_precalc_obligations",
      "sim_solver_incident_campaigns",
      "sim_solver_incidents",
      "sim_urans_request_campaigns",
      "sim_urans_requests",
      "sim_urans_verify_queue",
      "sim_urans_verify_queue_campaigns",
      "sim_urans_verify_queue_requests",
    ];
    expect([...new Set(rows.map((row) => row.table_name))]).toEqual(
      expectedTables,
    );
    expect(rows).toHaveLength(expectedTables.length * 2);
    for (const table of expectedTables) {
      const tableRows = rows.filter((row) => row.table_name === table);
      expect(tableRows.map((row) => row.event).sort()).toEqual([
        "INSERT",
        "UPDATE",
      ]);
      expect(tableRows.map((row) => row.trigger_name).sort()).toEqual([
        `${table}_admission_hazard_insert`,
        `${table}_admission_hazard_update`,
      ]);
      expect(new Set(tableRows.map((row) => row.orientation))).toEqual(
        new Set([table === "sim_campaign_points" ? "STATEMENT" : "ROW"]),
      );
    }
  });

  it("orders paused-campaign resume and submit safely in both directions", async () => {
    await setOwnership(true);
    await db
      .update(simCampaigns)
      .set({ status: "paused" })
      .where(eq(simCampaigns.id, campaignId));
    await resetFence();
    expect(await enforceSweeperAdmissionFence(db)).toMatchObject({
      hazardPresent: false,
      active: false,
    });

    const releaseResume = deferred<void>();
    const resumeLocked = deferred<void>();
    let resumeFirst: Promise<unknown> | null = null;
    let deniedSubmit: Promise<unknown> | null = null;
    let submitCalls = 0;
    try {
      resumeFirst = db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as DB;
        await tx.execute(drizzleSql`
          UPDATE sim_campaigns SET status = 'active'
          WHERE id = ${campaignId}
          /* predicate-resume-first */
        `);
        resumeLocked.resolve(undefined);
        await releaseResume.promise;
      });
      await resumeLocked.promise;
      const deniedJob = await createRemoteJob("resume-first-denied");
      deniedSubmit = submit(deniedJob, {
        submitPolar: async () => {
          submitCalls += 1;
          throw new Error("resume-first hazard must deny admission");
        },
      } as unknown as EngineClient);
      await waitForLockWait("submit lifecycle global admission permit");
      expect(submitCalls).toBe(0);
      releaseResume.resolve(undefined);
      await resumeFirst;
      expect(await deniedSubmit).toMatchObject({ kind: "lifecycle_stopped" });
      expect(submitCalls).toBe(0);
    } finally {
      releaseResume.resolve(undefined);
      await Promise.allSettled(
        [resumeFirst, deniedSubmit].filter(
          (value): value is Promise<unknown> => value !== null,
        ),
      );
    }

    await db
      .update(simCampaigns)
      .set({ status: "paused" })
      .where(eq(simCampaigns.id, campaignId));
    await resetFence();
    const submitEntered = deferred<void>();
    const releaseSubmit = deferred<JobStatus>();
    const acceptedJob = await createRemoteJob("submit-first-accepted");
    let acceptedSubmit: Promise<unknown> | null = null;
    let resumeSecond: Promise<unknown> | null = null;
    try {
      acceptedSubmit = submit(acceptedJob, {
        submitPolar: async () => {
          submitCalls += 1;
          submitEntered.resolve(undefined);
          return releaseSubmit.promise;
        },
      } as unknown as EngineClient);
      await submitEntered.promise;
      resumeSecond = Promise.resolve(
        db.execute(drizzleSql`
          UPDATE sim_campaigns SET status = 'active'
          WHERE id = ${campaignId}
          /* predicate-submit-first-resume */
        `),
      );
      await waitForLockWait("predicate-submit-first-resume");
      releaseSubmit.resolve(acceptedStatus("resume-submit-first"));
      expect(await acceptedSubmit).toMatchObject({ kind: "submitted" });
      await resumeSecond;
      expect(submitCalls).toBe(1);

      const nextJob = await createRemoteJob("after-resume-denied");
      const next = await submit(nextJob, {
        submitPolar: async () => {
          submitCalls += 1;
          throw new Error("post-resume hazard must deny the next submit");
        },
      } as unknown as EngineClient);
      expect(next).toMatchObject({ kind: "lifecycle_stopped" });
      expect(submitCalls).toBe(1);
    } finally {
      releaseSubmit.resolve(acceptedStatus("resume-submit-first-cleanup"));
      await Promise.allSettled(
        [acceptedSubmit, resumeSecond].filter(
          (value): value is Promise<unknown> => value !== null,
        ),
      );
      await db
        .update(simCampaigns)
        .set({ status: "paused" })
        .where(eq(simCampaigns.id, campaignId));
      await resetFence();
    }
  }, 60_000);

  it("orders campaign-ownership attachment and submit safely in both directions", async () => {
    await setOwnership(false);
    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, campaignId));
    await resetFence();
    expect(await enforceSweeperAdmissionFence(db)).toMatchObject({
      hazardPresent: false,
      active: false,
    });

    const releaseAttachment = deferred<void>();
    const attachmentLocked = deferred<void>();
    let attachFirst: Promise<unknown> | null = null;
    let deniedSubmit: Promise<unknown> | null = null;
    let submitCalls = 0;
    try {
      attachFirst = db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as DB;
        await tx.execute(drizzleSql`
          INSERT INTO sim_urans_request_campaigns
            (request_id, campaign_id, state)
          VALUES (${requestId}, ${campaignId}, 'active')
          /* predicate-attachment-first */
        `);
        attachmentLocked.resolve(undefined);
        await releaseAttachment.promise;
      });
      await attachmentLocked.promise;
      const deniedJob = await createRemoteJob("attachment-first-denied");
      deniedSubmit = submit(deniedJob, {
        submitPolar: async () => {
          submitCalls += 1;
          throw new Error("attachment-first hazard must deny admission");
        },
      } as unknown as EngineClient);
      await waitForLockWait("submit lifecycle global admission permit");
      releaseAttachment.resolve(undefined);
      await attachFirst;
      expect(await deniedSubmit).toMatchObject({ kind: "lifecycle_stopped" });
      expect(submitCalls).toBe(0);
    } finally {
      releaseAttachment.resolve(undefined);
      await Promise.allSettled(
        [attachFirst, deniedSubmit].filter(
          (value): value is Promise<unknown> => value !== null,
        ),
      );
    }

    await setOwnership(false);
    await resetFence();
    const submitEntered = deferred<void>();
    const releaseSubmit = deferred<JobStatus>();
    const acceptedJob = await createRemoteJob(
      "ownership-submit-first-accepted",
    );
    let acceptedSubmit: Promise<unknown> | null = null;
    let attachSecond: Promise<unknown> | null = null;
    try {
      acceptedSubmit = submit(acceptedJob, {
        submitPolar: async () => {
          submitCalls += 1;
          submitEntered.resolve(undefined);
          return releaseSubmit.promise;
        },
      } as unknown as EngineClient);
      await submitEntered.promise;
      attachSecond = Promise.resolve(
        db.execute(drizzleSql`
          INSERT INTO sim_urans_request_campaigns
            (request_id, campaign_id, state)
          VALUES (${requestId}, ${campaignId}, 'active')
          /* predicate-submit-first-attachment */
        `),
      );
      await waitForLockWait("predicate-submit-first-attachment");
      releaseSubmit.resolve(acceptedStatus("ownership-submit-first"));
      expect(await acceptedSubmit).toMatchObject({ kind: "submitted" });
      await attachSecond;
      expect(submitCalls).toBe(1);

      const nextJob = await createRemoteJob("after-attachment-denied");
      const next = await submit(nextJob, {
        submitPolar: async () => {
          submitCalls += 1;
          throw new Error("attached blocked owner must deny the next submit");
        },
      } as unknown as EngineClient);
      expect(next).toMatchObject({ kind: "lifecycle_stopped" });
      expect(submitCalls).toBe(1);
    } finally {
      releaseSubmit.resolve(acceptedStatus("ownership-submit-cleanup"));
      await Promise.allSettled(
        [acceptedSubmit, attachSecond].filter(
          (value): value is Promise<unknown> => value !== null,
        ),
      );
      await setOwnership(false);
      await db
        .update(simCampaigns)
        .set({ status: "paused" })
        .where(eq(simCampaigns.id, campaignId));
      await resetFence();
    }
  }, 60_000);

  it("does not serialize point release, but serializes reactivation into hazard eligibility", async () => {
    await setOwnership(true);
    await db
      .update(simCampaigns)
      .set({ status: "paused" })
      .where(eq(simCampaigns.id, campaignId));
    await db
      .update(simCampaignPoints)
      .set({ state: "requested" })
      .where(eq(simCampaignPoints.campaignId, campaignId));
    await resetFence();

    const holderEntered = deferred<void>();
    const releaseHolder = deferred<void>();
    const holder = db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      await tx.execute(drizzleSql`
        SELECT id FROM sweeper_state WHERE id = 1 FOR UPDATE
        /* predicate-point-release-holder */
      `);
      holderEntered.resolve(undefined);
      await releaseHolder.promise;
    });
    await holderEntered.promise;
    const releasePoint = db.execute(drizzleSql`
      UPDATE sim_campaign_points SET state = 'released'
      WHERE campaign_id = ${campaignId}
        AND condition_id = ${conditionId}
        AND airfoil_id = ${airfoilId}
        AND aoa_deg = ${AOA}
      /* predicate-point-release-no-wait */
    `);
    try {
      const releasedWithoutSingleton = await Promise.race([
        releasePoint.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 750),
        ),
      ]);
      expect(releasedWithoutSingleton).toBe(true);
    } finally {
      releaseHolder.resolve(undefined);
      await holder;
      await releasePoint;
    }

    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, campaignId));
    await resetFence();
    expect(await enforceSweeperAdmissionFence(db)).toMatchObject({
      hazardPresent: false,
      active: false,
    });

    const secondHolderEntered = deferred<void>();
    const releaseSecondHolder = deferred<void>();
    const secondHolder = db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      await tx.execute(drizzleSql`
        SELECT id FROM sweeper_state WHERE id = 1 FOR UPDATE
        /* predicate-point-enable-holder */
      `);
      secondHolderEntered.resolve(undefined);
      await releaseSecondHolder.promise;
    });
    await secondHolderEntered.promise;
    const enablePoint = Promise.resolve(
      db.execute(drizzleSql`
        UPDATE sim_campaign_points SET state = 'requested'
        WHERE campaign_id = ${campaignId}
          AND condition_id = ${conditionId}
          AND airfoil_id = ${airfoilId}
          AND aoa_deg = ${AOA}
        /* predicate-point-enable-must-wait */
      `),
    );
    try {
      await waitForLockWait("predicate-point-enable-must-wait");
      releaseSecondHolder.resolve(undefined);
      await secondHolder;
      await enablePoint;
      await expectBlockedRequestHazard();
    } finally {
      releaseSecondHolder.resolve(undefined);
      await Promise.allSettled([secondHolder, enablePoint]);
      await setOwnership(false);
      await db
        .update(simCampaigns)
        .set({ status: "paused" })
        .where(eq(simCampaigns.id, campaignId));
      await resetFence();
    }
  }, 30_000);

  it("restores the admission singleton before committing a hazard transition", async () => {
    await setOwnership(false);
    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, campaignId));
    await db.delete(sweeperState).where(eq(sweeperState.id, 1));

    await expect(
      db.insert(simUransRequestCampaigns).values({
        requestId,
        campaignId,
        state: "active",
      }),
    ).resolves.toBeDefined();

    const [restored] = await db
      .select({
        id: sweeperState.id,
        enabled: sweeperState.enabled,
        admissionFenceActive: sweeperState.admissionFenceActive,
      })
      .from(sweeperState)
      .where(eq(sweeperState.id, 1))
      .limit(1);
    expect(restored).toEqual({
      id: 1,
      enabled: false,
      admissionFenceActive: false,
    });
    await expectBlockedRequestHazard();

    await setOwnership(false);
    await db
      .update(simCampaigns)
      .set({ status: "paused" })
      .where(eq(simCampaigns.id, campaignId));
    await resetFence();
  });
});
