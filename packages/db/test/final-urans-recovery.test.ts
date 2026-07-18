import { URANS_CONTINUATION_REQUIRED_MARKER } from "@aerodb/core";
import {
  FINAL_URANS_OUTCOMES,
  airfoils,
  blockFinalUransVerificationAfterMediaRepair,
  cancelCampaign,
  createClient,
  createUransRequest,
  enqueuePrecalcVerifications,
  ensureFullUransRequestCoverage,
  ensurePrecalcObligations,
  failClaimedResultMediaRepair,
  finalUransRecoveryPlanForVerifyItem,
  healExpiredResultMediaRepairClaims,
  invalidateSatisfiedResultMediaRepair,
  precalcSnapshotForVerifyItem,
  precalcContinuationsForObligations,
  reconcileBlockedFinalMediaRepairVerifications,
  recordSolverIncident,
  refreshFullUransRequestState,
  resultAttempts,
  resultClassifications,
  resultMediaRepairs,
  results,
  settleFinalUransVerificationAfterMediaRepair,
  simCampaigns,
  simJobs,
  simLadderSubmitRetries,
  simPrecalcObligationCampaigns,
  simPrecalcObligationRequests,
  simPrecalcObligations,
  simSolverIncidents,
  simUransRequests,
  simUransRequestCampaigns,
  simUransVerifyQueue,
  simUransVerifyQueueCampaigns,
  simUransVerifyQueueRequests,
  solverEvidenceArchives,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
} from "@aerodb/db";
import { createVerifiedRestartArchiveFixture } from "@aerodb/db/test-fixtures";
import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMinimalSolverFixture } from "./solver-fixture";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `final-urans-recovery-${process.pid}-${Date.now().toString(36)}`;
const queueIds: string[] = [];
const resultIds: string[] = [];
const attemptIds: string[] = [];
const jobIds: string[] = [];
const campaignIds: string[] = [];
const obligationIds: string[] = [];
const requestIds: string[] = [];
const evidenceBlobIds: string[] = [];
const here = dirname(fileURLToPath(import.meta.url));

let airfoilId = "";
let bcId = "";
let revisionId = "";
let solverImplementationId = "";
let cleanupSolverFixture: (() => Promise<void>) | null = null;

type SettledOperation =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown };

const settleOperation = (
  work: () => Promise<unknown>,
): Promise<SettledOperation> =>
  work().then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );

/** Queue cancellation before request coverage behind one real campaign-row
 * barrier. Coverage completes its optimistic association lookup, then blocks
 * on the same campaign lock; releasing the barrier deterministically proves
 * it revalidates request/owner authority after cancellation commits. */
async function raceCancellationBeforeCoverage(
  campaignId: string,
  requestId: string,
  cells: Array<{ airfoilId: string; revisionId: string; aoaDeg: number }>,
): Promise<[SettledOperation, SettledOperation]> {
  const barrier = createClient({ max: 1 });
  const cancelClient = createClient({ max: 1 });
  const coverageClient = createClient({ max: 1 });
  let outcomes:
    | [Promise<SettledOperation>, Promise<SettledOperation>]
    | undefined;
  try {
    await Promise.all([
      barrier.sql`SELECT 1`,
      cancelClient.sql`SELECT 1`,
      coverageClient.sql`SELECT 1`,
    ]);
    await barrier.sql.begin(async (holder) => {
      const [{ pid: holderPid }] = await holder<{ pid: number }[]>`
        SELECT pg_backend_pid()::int AS pid
      `;
      await holder`
        SELECT id FROM sim_campaigns WHERE id = ${campaignId} FOR UPDATE
      `;
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
        throw new Error(
          `timed out waiting for ${minimum} lifecycle lock waiter(s)`,
        );
      };
      const cancelled = settleOperation(() =>
        cancelCampaign(cancelClient.db, campaignId),
      );
      await waitForBlockedSessions(1);
      const covered = settleOperation(() =>
        ensureFullUransRequestCoverage(coverageClient.db, {
          requestId,
          cells,
        }),
      );
      await waitForBlockedSessions(2);
      outcomes = [cancelled, covered];
    });
    if (!outcomes) throw new Error("coverage race was not started");
    return await Promise.all(outcomes);
  } finally {
    await Promise.all([
      barrier.sql.end(),
      cancelClient.sql.end(),
      coverageClient.sql.end(),
    ]);
  }
}

/** Hold the lexically-low generation lock while coverage takes the polar lock,
 * then start the all-candidate enqueue whose result UUID order is deliberately
 * the inverse of generation UUID order. The recursive two-waiter chain proves
 * both paths use polar -> sorted generation ordering; the old multi-candidate
 * transaction held the high generation while waiting on low and deadlocked. */
async function raceInvertedGenerationCoverageAndEnqueue(
  lowGenerationId: string,
  requestId: string,
  cells: Array<{ airfoilId: string; revisionId: string; aoaDeg: number }>,
): Promise<[SettledOperation, SettledOperation]> {
  const barrier = createClient({ max: 1 });
  const coverageClient = createClient({ max: 1 });
  const enqueueClient = createClient({ max: 1 });
  let outcomes:
    | [Promise<SettledOperation>, Promise<SettledOperation>]
    | undefined;
  try {
    await Promise.all([
      barrier.sql`SELECT 1`,
      coverageClient.sql`SELECT 1`,
      enqueueClient.sql`SELECT 1`,
    ]);
    await barrier.sql.begin(async (holder) => {
      const [{ pid: holderPid }] = await holder<{ pid: number }[]>`
        SELECT pg_backend_pid()::int AS pid
      `;
      await holder`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${"final-verify-generation:" + lowGenerationId}, 0)
        )
      `;
      const waitForRecursiveWaiters = async (minimum: number) => {
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
        throw new Error(
          `timed out waiting for ${minimum} inverted-generation waiter(s)`,
        );
      };
      const covered = settleOperation(() =>
        ensureFullUransRequestCoverage(coverageClient.db, {
          requestId,
          cells,
        }),
      );
      await waitForRecursiveWaiters(1);
      const enqueued = settleOperation(() =>
        enqueuePrecalcVerifications(enqueueClient.db, {
          airfoilId,
          revisionId,
        }),
      );
      await waitForRecursiveWaiters(2);
      outcomes = [covered, enqueued];
    });
    if (!outcomes) throw new Error("inverted generation race was not started");
    return await Promise.all(outcomes);
  } finally {
    await Promise.all([
      barrier.sql.end(),
      coverageClient.sql.end(),
      enqueueClient.sql.end(),
    ]);
  }
}

async function insertExactManifest(args: {
  resultId: string;
  resultAttemptId: string;
  aoaDeg: number;
  engineJobId: string;
  engineCaseSlug?: string;
  simJobId?: string | null;
}) {
  await db.insert(solverEvidenceArtifacts).values({
    resultId: args.resultId,
    resultAttemptId: args.resultAttemptId,
    airfoilId,
    simJobId: args.simJobId ?? null,
    engineJobId: args.engineJobId,
    engineCaseSlug: args.engineCaseSlug ?? `aoa_${args.aoaDeg}`,
    aoaDeg: args.aoaDeg,
    kind: "manifest",
    storageKey: `${PREFIX}/manifest/${args.resultAttemptId}.json`,
    mimeType: "application/json",
    sha256: "b".repeat(64),
    byteSize: 1,
  });
}

beforeAll(async () => {
  const [airfoil] = await db
    .select({ id: airfoils.id })
    .from(airfoils)
    .limit(1);
  if (!airfoil) throw new Error("seeded airfoil fixture is required");
  const solverFixture = await createMinimalSolverFixture(db, PREFIX);
  airfoilId = airfoil.id;
  revisionId = solverFixture.revisionId;
  solverImplementationId = solverFixture.solverImplementationId;
  bcId = solverFixture.bcId;
  cleanupSolverFixture = solverFixture.cleanup;
});

afterAll(async () => {
  if (queueIds.length) {
    await db
      .delete(simUransVerifyQueue)
      .where(inArray(simUransVerifyQueue.id, queueIds));
  }
  if (requestIds.length) {
    await db
      .delete(simUransRequests)
      .where(inArray(simUransRequests.id, requestIds));
  }
  if (obligationIds.length) {
    await db
      .delete(simPrecalcObligations)
      .where(inArray(simPrecalcObligations.id, obligationIds));
  }
  if (attemptIds.length) {
    await db
      .delete(resultClassifications)
      .where(inArray(resultClassifications.resultAttemptId, attemptIds));
  }
  if (resultIds.length) {
    await db
      .update(results)
      .set({ currentResultAttemptId: null })
      .where(inArray(results.id, resultIds));
  }
  if (attemptIds.length) {
    await db
      .delete(resultAttempts)
      .where(inArray(resultAttempts.id, attemptIds));
  }
  if (resultIds.length) {
    await db.delete(results).where(inArray(results.id, resultIds));
  }
  if (jobIds.length) {
    await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
  }
  if (campaignIds.length) {
    await db.delete(simCampaigns).where(inArray(simCampaigns.id, campaignIds));
  }
  if (evidenceBlobIds.length) {
    await db
      .delete(solverEvidenceBlobs)
      .where(inArray(solverEvidenceBlobs.id, evidenceBlobIds));
  }
  await cleanupSolverFixture?.();
  await sql.end();
});

async function createMediaPendingFixture(label: string, aoaDeg: number) {
  const [precalc] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      status: "done",
      source: "solved",
      regime: "urans",
      fidelity: "urans_precalc",
      cl: 0.72,
      cd: 0.052,
      cm: -0.031,
      clCd: 0.72 / 0.052,
      converged: true,
      unsteady: true,
      solvedAt: new Date(),
    })
    .returning();
  resultIds.push(precalc.id);
  const [precalcAttempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: precalc.id,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      engineJobId: `${PREFIX}-${label}-precalc`,
      engineCaseSlug: `aoa_${aoaDeg}_precalc`,
      solverImplementationId,
      status: "done",
      source: "solved",
      regime: "urans",
      validForPolar: true,
      cl: precalc.cl,
      cd: precalc.cd,
      cm: precalc.cm,
      clCd: precalc.clCd,
      converged: true,
      unsteady: true,
      evidencePayload: { fidelity: "urans_precalc" },
      solvedAt: new Date(),
    })
    .returning();
  attemptIds.push(precalcAttempt.id);
  await db.insert(resultClassifications).values({
    resultId: precalc.id,
    resultAttemptId: precalcAttempt.id,
    airfoilId,
    simulationPresetRevisionId: revisionId,
    aoaDeg,
    regime: "urans",
    classifierVersion: "final-media-repair-precalc-test-v1",
    state: "accepted",
    region: "post_stall",
    confidence: 1,
    reasons: [],
  });
  await db
    .update(results)
    .set({ currentResultAttemptId: precalcAttempt.id })
    .where(eq(results.id, precalc.id));
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      solverImplementationId,
      methodKey: "openfoam.urans",
      jobKind: "verify",
      referenceChordM: 0.1,
      wave: 2,
      status: "done",
      engineJobId: `${PREFIX}-${label}`,
      totalCases: 1,
      completedCases: 1,
      submittedAt: new Date(),
      finishedAt: new Date(),
      requestPayload: {
        aoas: [aoaDeg],
        uransFidelity: "full",
        verifyPrecalcResultAttemptId: precalcAttempt.id,
        verifyPrecalc: { cl: 0.72, cd: 0.052, cm: -0.031 },
      },
    })
    .returning();
  jobIds.push(job.id);
  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: precalc.id,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      simJobId: job.id,
      engineJobId: job.engineJobId,
      engineCaseSlug: `aoa_${aoaDeg}`,
      solverImplementationId,
      status: "done",
      source: "solved",
      regime: "urans",
      validForPolar: false,
      cl: 0.74,
      cd: 0.054,
      cm: -0.032,
      clCd: 0.74 / 0.054,
      converged: true,
      unsteady: true,
      evidencePayload: { fidelity: "urans_full" },
      solvedAt: new Date(),
    })
    .returning();
  attemptIds.push(attempt.id);
  await db.insert(resultClassifications).values({
    resultAttemptId: attempt.id,
    airfoilId,
    simulationPresetRevisionId: revisionId,
    aoaDeg,
    regime: "urans",
    classifierVersion: "final-media-repair-test-v1",
    state: "rejected",
    region: "post_stall",
    confidence: 1,
    reasons: ["missing-urans-video"],
  });
  const [queue] = await db
    .insert(simUransVerifyQueue)
    .values({
      airfoilId,
      revisionId,
      aoaDeg,
      state: "pending",
      precalcResultId: precalc.id,
      precalcResultAttemptId: precalcAttempt.id,
      backgroundOwner: true,
      freshAttemptCount: 1,
      continuationAttemptCount: 0,
      latestResultAttemptId: attempt.id,
      lastOutcome: FINAL_URANS_OUTCOMES.mediaRepairPending,
      lastError: "missing-urans-video",
    })
    .returning();
  queueIds.push(queue.id);
  await db
    .update(simJobs)
    .set({
      requestPayload: {
        ...(job.requestPayload as Record<string, unknown>),
        verifyQueueItemId: queue.id,
      },
    })
    .where(eq(simJobs.id, job.id));
  return { queue, attempt, job, precalc, precalcAttempt };
}

async function linkFullRequest(queueId: string, aoaDeg: number, label: string) {
  const { request } = await createUransRequest(db, {
    airfoilId,
    revisionId,
    aoaDeg,
    fidelity: "full",
    requestedBy: `${PREFIX}-${label}`,
  });
  requestIds.push(request.id);
  await db
    .update(simUransRequests)
    .set({ state: "running" })
    .where(eq(simUransRequests.id, request.id));
  await db
    .insert(simUransVerifyQueueRequests)
    .values({ queueId, requestId: request.id })
    .onConflictDoNothing();
  return request;
}

async function createAcceptedUransEvidence(
  label: string,
  aoaDeg: number,
  fidelity: "urans_precalc" | "urans_full",
  ids?: { resultId: string; resultAttemptId: string },
  opts: { restartArchive?: boolean } = {},
) {
  const [result] = await db
    .insert(results)
    .values({
      ...(ids ? { id: ids.resultId } : {}),
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      status: "done",
      source: "solved",
      regime: "urans",
      fidelity,
      methodKey: "openfoam.urans",
      solverImplementationId,
      cl: 0.65,
      cd: 0.045,
      cm: -0.03,
      converged: true,
      unsteady: true,
      solvedAt: new Date(),
    })
    .returning();
  resultIds.push(result.id);
  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      ...(ids ? { id: ids.resultAttemptId } : {}),
      resultId: result.id,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      engineJobId: `${PREFIX}-${label}`,
      engineCaseSlug: `aoa_${aoaDeg}`,
      methodKey: "openfoam.urans",
      solverImplementationId,
      status: "done",
      source: "solved",
      regime: "urans",
      validForPolar: true,
      cl: result.cl,
      cd: result.cd,
      cm: result.cm,
      converged: true,
      unsteady: true,
      evidencePayload: { fidelity },
      solvedAt: new Date(),
    })
    .returning();
  attemptIds.push(attempt.id);
  await db.insert(resultClassifications).values({
    resultAttemptId: attempt.id,
    airfoilId,
    simulationPresetRevisionId: revisionId,
    aoaDeg,
    regime: "urans",
    classifierVersion: "full-request-coverage-test-v1",
    state: "accepted",
    region: "attached",
    confidence: 1,
    reasons: [],
  });
  await db.insert(resultClassifications).values({
    resultId: result.id,
    airfoilId,
    simulationPresetRevisionId: revisionId,
    aoaDeg,
    regime: "urans",
    classifierVersion: "full-request-coverage-result-test-v1",
    state: "accepted",
    region: "attached",
    confidence: 1,
    reasons: [],
  });
  await db
    .update(results)
    .set({ currentResultAttemptId: attempt.id })
    .where(eq(results.id, result.id));
  await insertExactManifest({
    resultId: result.id,
    resultAttemptId: attempt.id,
    aoaDeg,
    engineJobId: attempt.engineJobId!,
  });
  if (opts.restartArchive !== false) {
    const archive = await createVerifiedRestartArchiveFixture(db, {
      resultId: result.id,
      resultAttemptId: attempt.id,
    });
    evidenceBlobIds.push(archive.blobId);
  }
  return { result, attempt };
}

async function promoteAcceptedPrecalcToAcceptedFull(
  label: string,
  aoaDeg: number,
  fixture: Awaited<ReturnType<typeof createAcceptedUransEvidence>>,
) {
  const [queue] = await db
    .insert(simUransVerifyQueue)
    .values({
      airfoilId,
      revisionId,
      aoaDeg,
      state: "pending",
      precalcResultId: fixture.result.id,
      precalcResultAttemptId: fixture.attempt.id,
      backgroundOwner: false,
    })
    .returning();
  queueIds.push(queue.id);
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      solverImplementationId,
      methodKey: "openfoam.urans",
      jobKind: "verify",
      referenceChordM: 0.1,
      wave: 2,
      status: "done",
      engineJobId: `${PREFIX}-${label}`,
      totalCases: 1,
      completedCases: 1,
      submittedAt: new Date(),
      finishedAt: new Date(),
      requestPayload: {
        aoas: [aoaDeg],
        uransFidelity: "full",
        verifyQueueItemId: queue.id,
        verifyPrecalcResultAttemptId: fixture.attempt.id,
      },
    })
    .returning();
  jobIds.push(job.id);
  const [fullAttempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: fixture.result.id,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      simJobId: job.id,
      engineJobId: job.engineJobId,
      engineCaseSlug: `aoa_${aoaDeg}_full`,
      methodKey: "openfoam.urans",
      solverImplementationId,
      status: "done",
      source: "solved",
      regime: "urans",
      validForPolar: true,
      cl: 0.69,
      cd: 0.047,
      cm: -0.032,
      converged: true,
      unsteady: true,
      evidencePayload: { fidelity: "urans_full" },
      solvedAt: new Date(),
    })
    .returning();
  attemptIds.push(fullAttempt.id);
  await db.insert(resultClassifications).values({
    resultAttemptId: fullAttempt.id,
    airfoilId,
    simulationPresetRevisionId: revisionId,
    aoaDeg,
    regime: "urans",
    classifierVersion: "full-request-linked-generation-test-v1",
    state: "accepted",
    region: "attached",
    confidence: 1,
    reasons: [],
  });
  await db
    .update(resultClassifications)
    .set({
      state: "superseded_by_urans",
      supersededByResultId: fixture.result.id,
    })
    .where(eq(resultClassifications.resultAttemptId, fixture.attempt.id));
  await insertExactManifest({
    resultId: fixture.result.id,
    resultAttemptId: fullAttempt.id,
    aoaDeg,
    simJobId: job.id,
    engineJobId: fullAttempt.engineJobId!,
    engineCaseSlug: fullAttempt.engineCaseSlug!,
  });
  await db
    .update(results)
    .set({
      currentResultAttemptId: fullAttempt.id,
      status: "done",
      source: "solved",
      regime: "urans",
      fidelity: "urans_full",
      methodKey: "openfoam.urans",
      solverImplementationId,
      cl: fullAttempt.cl,
      cd: fullAttempt.cd,
      cm: fullAttempt.cm,
    })
    .where(eq(results.id, fixture.result.id));
  await db
    .update(simUransVerifyQueue)
    .set({
      state: "done",
      simJobId: job.id,
      verifyResultId: fixture.result.id,
      deltaCl: Number(fullAttempt.cl) - Number(fixture.attempt.cl),
      deltaCd: Number(fullAttempt.cd) - Number(fixture.attempt.cd),
      deltaCm: Number(fullAttempt.cm) - Number(fixture.attempt.cm),
      freshAttemptCount: 1,
      latestResultAttemptId: fullAttempt.id,
      lastOutcome: FINAL_URANS_OUTCOMES.accepted,
    })
    .where(eq(simUransVerifyQueue.id, queue.id));
  return { ...fixture, fullAttempt, job, queue };
}

describe("final URANS media-repair recovery", () => {
  it("MUST-CATCH: accepted FAST evidence cannot seed FINAL until its exact GCS/Zstd restart archive is verified", async () => {
    const aoaDeg = 78.905 + (process.pid % 1000) / 100_000;
    const fixture = await createAcceptedUransEvidence(
      "final-seed-storage-gate",
      aoaDeg,
      "urans_precalc",
      undefined,
      { restartArchive: false },
    );

    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId,
        aoaDeg,
      }),
    ).toBe(0);
    expect(
      await db
        .select({ id: simUransVerifyQueue.id })
        .from(simUransVerifyQueue)
        .where(
          eq(simUransVerifyQueue.precalcResultAttemptId, fixture.attempt.id),
        ),
    ).toEqual([]);

    const archive = await createVerifiedRestartArchiveFixture(db, {
      resultId: fixture.result.id,
      resultAttemptId: fixture.attempt.id,
    });
    evidenceBlobIds.push(archive.blobId);
    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId,
        aoaDeg,
      }),
    ).toBe(1);
    const [queue] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(
        eq(simUransVerifyQueue.precalcResultAttemptId, fixture.attempt.id),
      );
    expect(queue).toMatchObject({ state: "pending" });
    queueIds.push(queue!.id);
    await db
      .delete(solverEvidenceArchives)
      .where(eq(solverEvidenceArchives.id, archive.archiveId));
    await expect(
      finalUransRecoveryPlanForVerifyItem(db, queue!),
    ).resolves.toMatchObject({
      mode: "exhausted",
      reason: expect.stringContaining("restart archive"),
    });
  });

  it("MUST-CATCH: inverted result/generation UUID order cannot deadlock coverage against enqueue", async () => {
    const uuidTail = (): string => randomUUID().slice(9);
    const firstAoa = 78.91 + (process.pid % 1000) / 100_000;
    const secondAoa = 78.92 + (process.pid % 1000) / 100_000;
    const first = await createAcceptedUransEvidence(
      "inverted-generation-high",
      firstAoa,
      "urans_precalc",
      {
        resultId: `10000000-${uuidTail()}`,
        resultAttemptId: `f0000000-${uuidTail()}`,
      },
    );
    const second = await createAcceptedUransEvidence(
      "inverted-generation-low",
      secondAoa,
      "urans_precalc",
      {
        resultId: `e0000000-${uuidTail()}`,
        resultAttemptId: `00000001-${uuidTail()}`,
      },
    );
    expect(first.result.id < second.result.id).toBe(true);
    expect(first.attempt.id > second.attempt.id).toBe(true);
    const { request } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      fidelity: "full",
      requestedBy: `${PREFIX}-inverted-generation-race`,
    });
    requestIds.push(request.id);
    const cells = [
      { airfoilId, revisionId, aoaDeg: firstAoa },
      { airfoilId, revisionId, aoaDeg: secondAoa },
    ];
    const [covered, enqueued] = await raceInvertedGenerationCoverageAndEnqueue(
      second.attempt.id,
      request.id,
      cells,
    );
    expect(covered.ok).toBe(true);
    expect(enqueued.ok).toBe(true);
    const exactQueues = await db
      .select()
      .from(simUransVerifyQueue)
      .where(
        inArray(simUransVerifyQueue.precalcResultAttemptId, [
          first.attempt.id,
          second.attempt.id,
        ]),
      );
    expect(exactQueues).toHaveLength(2);
    queueIds.push(...exactQueues.map((queue) => queue.id));
    expect(
      await db
        .select()
        .from(simUransVerifyQueueRequests)
        .where(eq(simUransVerifyQueueRequests.requestId, request.id)),
    ).toHaveLength(2);
    // This whole-polar owner was created only to exercise lock composition.
    // Retire it so later exact-angle cases in this file cannot legitimately
    // reuse its broad scope.
    await db
      .update(simUransRequests)
      .set({ state: "cancelled", simJobId: null })
      .where(eq(simUransRequests.id, request.id));
  });

  it("MUST-CATCH: campaign cancellation wins before stale full-request coverage can create physical ownership", async () => {
    const aoaDeg = 79.075 + (process.pid % 1000) / 100_000;
    await createAcceptedUransEvidence(
      "coverage-cancel-race-precalc",
      aoaDeg,
      "urans_precalc",
    );
    const [campaign] = await db
      .insert(simCampaigns)
      .values({
        slug: `${PREFIX}-coverage-cancel-race`,
        name: `${PREFIX} coverage cancel race`,
        idempotencyKey: `${PREFIX}-coverage-cancel-race`,
        status: "active",
      })
      .returning();
    campaignIds.push(campaign.id);
    const [request] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId,
        aoaDeg,
        fidelity: "full",
        state: "pending",
        backgroundOwner: false,
        requestedBy: `${PREFIX}-coverage-cancel-race`,
      })
      .returning();
    requestIds.push(request.id);
    await db.insert(simUransRequestCampaigns).values({
      requestId: request.id,
      campaignId: campaign.id,
      state: "active",
    });

    const [cancelled, covered] = await raceCancellationBeforeCoverage(
      campaign.id,
      request.id,
      [{ airfoilId, revisionId, aoaDeg }],
    );
    expect(cancelled.ok).toBe(true);
    expect(covered.ok).toBe(false);
    expect(
      covered.ok ? "" : String((covered.error as Error).message),
    ).toContain("already cancelled");
    const [requestAfter] = await db
      .select({ state: simUransRequests.state })
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    expect(requestAfter?.state).toBe("cancelled");
    const [ownerAfter] = await db
      .select({ state: simUransRequestCampaigns.state })
      .from(simUransRequestCampaigns)
      .where(eq(simUransRequestCampaigns.requestId, request.id));
    expect(ownerAfter?.state).toBe("cancelled");
    expect(
      await db
        .select({ queueId: simUransVerifyQueueRequests.queueId })
        .from(simUransVerifyQueueRequests)
        .where(eq(simUransVerifyQueueRequests.requestId, request.id)),
    ).toEqual([]);
    expect(
      await db
        .select({ obligationId: simPrecalcObligationRequests.obligationId })
        .from(simPrecalcObligationRequests)
        .where(eq(simPrecalcObligationRequests.requestId, request.id)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: simUransVerifyQueue.id })
        .from(simUransVerifyQueue)
        .where(
          and(
            eq(simUransVerifyQueue.airfoilId, airfoilId),
            eq(simUransVerifyQueue.revisionId, revisionId),
            eq(simUransVerifyQueue.aoaDeg, aoaDeg),
          ),
        ),
    ).toEqual([]);
  }, 120_000);

  it("MUST-CATCH: the 0070 rolling-cutover fence rejects legacy direct FULL jobs but permits PRECALC and verify-owned FULL jobs", async () => {
    const { request } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: 79 + (process.pid % 1000) / 100_000,
      fidelity: "full",
      requestedBy: `${PREFIX}-direct-full-fence`,
    });
    requestIds.push(request.id);
    const common = {
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      solverImplementationId,
      methodKey: "openfoam.urans",
      referenceChordM: 0.1,
      wave: 2,
      status: "pending" as const,
      totalCases: 1,
    };

    await expect(
      db.insert(simJobs).values({
        ...common,
        jobKind: "targeted",
        requestPayload: {
          aoas: [request.aoaDeg],
          uransRequestId: request.id,
          uransFidelity: "full",
        },
      }),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      readFileSync(
        resolve(here, "../migrations/0070_full_request_verify_ownership.sql"),
        "utf8",
      ),
    ).toContain('ADD CONSTRAINT "sim_jobs_no_direct_full_request_check"');

    const allowed = await db
      .insert(simJobs)
      .values([
        {
          ...common,
          jobKind: "targeted",
          requestPayload: {
            aoas: [request.aoaDeg],
            uransRequestId: request.id,
            uransFidelity: "precalc",
          },
        },
        {
          ...common,
          jobKind: "verify",
          requestPayload: {
            aoas: [request.aoaDeg],
            uransRequestId: request.id,
            uransFidelity: "full",
            verifyQueueItemId: randomUUID(),
          },
        },
      ])
      .returning({ id: simJobs.id });
    expect(allowed).toHaveLength(2);
    jobIds.push(...allowed.map((job) => job.id));
  });

  it("MUST-CATCH: a final request reuses a critically blocked per-point verification and ignores the removed direct-submit retry ledger", async () => {
    const aoaDeg = 79.1 + (process.pid % 1000) / 100_000;
    const { result, attempt } = await createAcceptedUransEvidence(
      "blocked-coverage-precalc",
      aoaDeg,
      "urans_precalc",
    );
    const [queue] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId,
        aoaDeg,
        state: "blocked",
        precalcResultId: result.id,
        precalcResultAttemptId: attempt.id,
        backgroundOwner: false,
        freshAttemptCount: 2,
        maxFreshAttempts: 2,
        continuationAttemptCount: 1,
        lastOutcome: FINAL_URANS_OUTCOMES.recoveryExhausted,
        lastError: "bounded final recovery exhausted",
      })
      .returning();
    queueIds.push(queue.id);
    const { request } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg,
      fidelity: "full",
      requestedBy: `${PREFIX}-blocked-coverage`,
    });
    requestIds.push(request.id);
    await db.insert(simLadderSubmitRetries).values({
      uransRequestId: request.id,
      state: "blocked",
      attemptCount: 1,
      nextAttemptAt: null,
      lastHttpStatus: 503,
      lastError: "legacy direct-full submit retry exhausted",
    });

    const coverage = await ensureFullUransRequestCoverage(db, {
      requestId: request.id,
      cells: [{ airfoilId, revisionId, aoaDeg }],
    });
    expect(coverage).toMatchObject({
      totalCells: 1,
      precalcObligations: [],
      verifyQueueIds: [queue.id],
    });
    expect(
      await db
        .select()
        .from(simUransVerifyQueue)
        .where(
          and(
            eq(simUransVerifyQueue.airfoilId, airfoilId),
            eq(simUransVerifyQueue.revisionId, revisionId),
            eq(simUransVerifyQueue.aoaDeg, aoaDeg),
          ),
        ),
    ).toHaveLength(1);
    expect(await refreshFullUransRequestState(db, request.id)).toBe("blocked");
    const [projected] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    expect(projected).toMatchObject({ state: "blocked", simJobId: null });
  });

  it("MUST-CATCH: blocked final generation A cannot spend or compare generation B on the same result row", async () => {
    const aoaDeg = 79.15 + (process.pid % 1000) / 100_000;
    const { result, attempt: attemptA } = await createAcceptedUransEvidence(
      "generation-a-precalc",
      aoaDeg,
      "urans_precalc",
    );
    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId,
        aoaDeg,
      }),
    ).toBe(1);
    const [queueA] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.precalcResultAttemptId, attemptA.id));
    queueIds.push(queueA.id);
    await db
      .update(simUransVerifyQueue)
      .set({
        state: "blocked",
        freshAttemptCount: 2,
        maxFreshAttempts: 2,
        continuationAttemptCount: 1,
        lastOutcome: FINAL_URANS_OUTCOMES.recoveryExhausted,
        lastError: "generation A exhausted",
      })
      .where(eq(simUransVerifyQueue.id, queueA.id));

    const [attemptB] = await db
      .insert(resultAttempts)
      .values({
        resultId: result.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        engineJobId: `${PREFIX}-generation-b-precalc`,
        engineCaseSlug: `aoa_${aoaDeg}_precalc_b`,
        solverImplementationId,
        status: "done",
        source: "solved",
        regime: "urans",
        validForPolar: true,
        cl: 0.91,
        cd: 0.037,
        cm: -0.021,
        clCd: 0.91 / 0.037,
        converged: true,
        unsteady: true,
        evidencePayload: { fidelity: "urans_precalc" },
        solvedAt: new Date(),
      })
      .returning();
    attemptIds.push(attemptB.id);
    await insertExactManifest({
      resultId: result.id,
      resultAttemptId: attemptB.id,
      aoaDeg,
      engineJobId: attemptB.engineJobId!,
      engineCaseSlug: attemptB.engineCaseSlug!,
    });
    evidenceBlobIds.push(
      (
        await createVerifiedRestartArchiveFixture(db, {
          resultId: result.id,
          resultAttemptId: attemptB.id,
        })
      ).blobId,
    );
    await db.insert(resultClassifications).values({
      resultAttemptId: attemptB.id,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      regime: "urans",
      classifierVersion: "verify-generation-owner-test-v1",
      state: "accepted",
      region: "attached",
      confidence: 1,
      reasons: [],
    });
    await db
      .update(results)
      .set({
        currentResultAttemptId: attemptB.id,
        fidelity: "urans_precalc",
        cl: attemptB.cl,
        cd: attemptB.cd,
        cm: attemptB.cm,
        clCd: attemptB.clCd,
      })
      .where(eq(results.id, result.id));

    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId,
        aoaDeg,
      }),
    ).toBe(1);
    const generationQueues = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.precalcResultId, result.id));
    expect(generationQueues).toHaveLength(2);
    const queueB = generationQueues.find(
      (queue) => queue.precalcResultAttemptId === attemptB.id,
    );
    expect(queueB).toMatchObject({
      state: "pending",
      freshAttemptCount: 0,
      continuationAttemptCount: 0,
      precalcResultId: result.id,
      precalcResultAttemptId: attemptB.id,
    });
    queueIds.push(queueB!.id);

    expect(await precalcSnapshotForVerifyItem(db, queueB!)).toEqual({
      resultAttemptId: attemptB.id,
      cl: attemptB.cl,
      cd: attemptB.cd,
      cm: attemptB.cm,
    });
    // Simulate the natural-cell projection being overwritten after B was
    // queued. The immutable queue owner and comparison coefficients stay B.
    await db
      .update(results)
      .set({ fidelity: "urans_full", cl: 9.9, cd: 8.8, cm: 7.7 })
      .where(eq(results.id, result.id));
    expect(await precalcSnapshotForVerifyItem(db, queueB!)).toEqual({
      resultAttemptId: attemptB.id,
      cl: attemptB.cl,
      cd: attemptB.cd,
      cm: attemptB.cm,
    });
    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId,
        aoaDeg,
      }),
    ).toBe(0);
  });

  it("MUST-CATCH: repeated final requests reuse accepted exact FULL evidence and its terminal queue projection without rerunning CFD", async () => {
    const aoaDeg = 79.2 + (process.pid % 1000) / 100_000;
    const precalc = await createAcceptedUransEvidence(
      "terminal-full-coverage",
      aoaDeg,
      "urans_precalc",
    );
    const { result, queue: linkedQueue } =
      await promoteAcceptedPrecalcToAcceptedFull(
        "terminal-full-coverage",
        aoaDeg,
        precalc,
      );
    const first = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg,
      fidelity: "full",
      requestedBy: `${PREFIX}-terminal-full-first`,
    });
    requestIds.push(first.request.id);
    const firstCoverage = await ensureFullUransRequestCoverage(db, {
      requestId: first.request.id,
      cells: [{ airfoilId, revisionId, aoaDeg }],
    });
    expect(firstCoverage.verifyQueueIds).toHaveLength(1);
    const terminalQueueId = firstCoverage.verifyQueueIds[0]!;
    expect(terminalQueueId).toBe(linkedQueue.id);
    const [terminalQueue] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, terminalQueueId));
    expect(terminalQueue).toMatchObject({
      state: "done",
      precalcResultId: result.id,
      verifyResultId: result.id,
      lastOutcome: FINAL_URANS_OUTCOMES.accepted,
    });
    expect(terminalQueue.deltaCl).toBeCloseTo(0.04);
    expect(terminalQueue.deltaCd).toBeCloseTo(0.002);
    expect(terminalQueue.deltaCm).toBeCloseTo(-0.002);
    expect(await refreshFullUransRequestState(db, first.request.id)).toBe(
      "done",
    );

    const second = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg,
      fidelity: "full",
      requestedBy: `${PREFIX}-terminal-full-second`,
    });
    requestIds.push(second.request.id);
    const secondCoverage = await ensureFullUransRequestCoverage(db, {
      requestId: second.request.id,
      cells: [{ airfoilId, revisionId, aoaDeg }],
    });
    expect(secondCoverage.verifyQueueIds).toEqual([terminalQueueId]);
    expect(await refreshFullUransRequestState(db, second.request.id)).toBe(
      "done",
    );
    expect(
      await db
        .select()
        .from(simUransVerifyQueue)
        .where(
          and(
            eq(simUransVerifyQueue.airfoilId, airfoilId),
            eq(simUransVerifyQueue.revisionId, revisionId),
            eq(simUransVerifyQueue.aoaDeg, aoaDeg),
          ),
        ),
    ).toHaveLength(1);
  });

  it("MUST-CATCH: late accepted FULL reuses blocked/cancelled exact queues and resolves incidents", async () => {
    for (const [offset, priorState] of ["blocked", "cancelled"].entries()) {
      const aoaDeg = 79.22 + offset / 100 + (process.pid % 1000) / 100_000;
      const precalc = await createAcceptedUransEvidence(
        `late-full-${priorState}`,
        aoaDeg,
        "urans_precalc",
      );
      const { queue } = await promoteAcceptedPrecalcToAcceptedFull(
        `late-full-${priorState}`,
        aoaDeg,
        precalc,
      );
      await db
        .update(simUransVerifyQueue)
        .set({ state: priorState, lastError: `fixture-${priorState}` })
        .where(eq(simUransVerifyQueue.id, queue.id));
      let incidentId: string | null = null;
      if (priorState === "blocked") {
        const incident = await recordSolverIncident(db, {
          stage: "final",
          reason: "fixture-blocked-before-late-full",
          severity: "critical",
          owner: { verifyQueueId: queue.id },
          solverImplementationId,
          occurrenceKey: `final:${queue.id}:fixture-blocked-before-late-full`,
        });
        incidentId = incident.id;
      }
      const { request } = await createUransRequest(db, {
        airfoilId,
        revisionId,
        aoaDeg,
        fidelity: "full",
        requestedBy: `${PREFIX}-late-full-${priorState}`,
      });
      requestIds.push(request.id);
      const coverage = await ensureFullUransRequestCoverage(db, {
        requestId: request.id,
        cells: [{ airfoilId, revisionId, aoaDeg }],
      });
      expect(coverage.verifyQueueIds).toEqual([queue.id]);
      const exactQueues = await db
        .select()
        .from(simUransVerifyQueue)
        .where(
          and(
            eq(simUransVerifyQueue.airfoilId, airfoilId),
            eq(simUransVerifyQueue.revisionId, revisionId),
            eq(simUransVerifyQueue.aoaDeg, aoaDeg),
            eq(simUransVerifyQueue.precalcResultAttemptId, precalc.attempt.id),
          ),
        );
      expect(exactQueues).toHaveLength(1);
      expect(exactQueues[0]).toMatchObject({
        id: queue.id,
        state: "done",
        lastOutcome: FINAL_URANS_OUTCOMES.accepted,
        lastError: null,
      });
      if (incidentId) {
        const [incident] = await db
          .select({ resolvedAt: simSolverIncidents.resolvedAt })
          .from(simSolverIncidents)
          .where(eq(simSolverIncidents.id, incidentId));
        expect(incident?.resolvedAt).not.toBeNull();
      }
    }
  });

  it("MUST-CATCH: rejected/unpublishable current FULL falls back to its exact accepted FAST baseline", async () => {
    const aoaDeg = 79.25 + (process.pid % 1000) / 100_000;
    const precalc = await createAcceptedUransEvidence(
      "classification-only-full",
      aoaDeg,
      "urans_precalc",
    );
    const { fullAttempt, queue } = await promoteAcceptedPrecalcToAcceptedFull(
      "classification-only-full",
      aoaDeg,
      precalc,
    );
    await db
      .delete(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.resultAttemptId, fullAttempt.id));
    await db
      .delete(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, queue.id));
    const { request } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg,
      fidelity: "full",
      requestedBy: `${PREFIX}-classification-only-full`,
    });
    requestIds.push(request.id);
    const coverage = await ensureFullUransRequestCoverage(db, {
      requestId: request.id,
      cells: [{ airfoilId, revisionId, aoaDeg }],
    });
    expect(coverage.precalcObligations).toEqual([]);
    expect(coverage.verifyQueueIds).toHaveLength(1);
    queueIds.push(coverage.verifyQueueIds[0]!);
    const matchingQueues = await db
      .select()
      .from(simUransVerifyQueue)
      .where(
        and(
          eq(simUransVerifyQueue.airfoilId, airfoilId),
          eq(simUransVerifyQueue.revisionId, revisionId),
          eq(simUransVerifyQueue.aoaDeg, aoaDeg),
        ),
      );
    expect(matchingQueues).toHaveLength(1);
    expect(matchingQueues[0]).toMatchObject({
      id: coverage.verifyQueueIds[0],
      state: "pending",
      precalcResultId: precalc.result.id,
      precalcResultAttemptId: precalc.attempt.id,
      verifyResultId: null,
    });
  });

  it("MUST-CATCH: a FULL payload naming a nonexistent queue cannot claim the FAST generation", async () => {
    const aoaDeg = 79.28 + (process.pid % 1000) / 100_000;
    const precalc = await createAcceptedUransEvidence(
      "corrupt-full-queue-owner",
      aoaDeg,
      "urans_precalc",
    );
    const { queue, job, fullAttempt } =
      await promoteAcceptedPrecalcToAcceptedFull(
        "corrupt-full-queue-owner",
        aoaDeg,
        precalc,
      );
    const nonexistentQueueId = randomUUID();
    await db
      .update(simJobs)
      .set({
        requestPayload: {
          aoas: [aoaDeg],
          uransFidelity: "full",
          verifyQueueItemId: nonexistentQueueId,
          verifyPrecalcResultAttemptId: precalc.attempt.id,
        },
      })
      .where(eq(simJobs.id, job.id));
    await db
      .update(simUransVerifyQueue)
      .set({
        state: "pending",
        simJobId: null,
        verifyResultId: null,
        deltaCl: null,
        deltaCd: null,
        deltaCm: null,
        freshAttemptCount: 0,
        latestResultAttemptId: null,
        lastOutcome: null,
        lastError: null,
      })
      .where(eq(simUransVerifyQueue.id, queue.id));
    const { request } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg,
      fidelity: "full",
      requestedBy: `${PREFIX}-corrupt-full-queue-owner`,
    });
    requestIds.push(request.id);
    const coverage = await ensureFullUransRequestCoverage(db, {
      requestId: request.id,
      cells: [{ airfoilId, revisionId, aoaDeg }],
    });
    expect(coverage.precalcObligations).toEqual([]);
    expect(coverage.verifyQueueIds).toEqual([queue.id]);
    const [after] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, queue.id));
    expect(after).toMatchObject({
      state: "pending",
      precalcResultAttemptId: precalc.attempt.id,
      verifyResultId: null,
      latestResultAttemptId: null,
      lastOutcome: null,
    });
    expect(after?.latestResultAttemptId).not.toBe(fullAttempt.id);
  });

  it("MUST-CATCH: a continuation-style final request seeds the ordinary final queue only after an accepted preliminary baseline exists", async () => {
    const aoaDeg = 79.3 + (process.pid % 1000) / 100_000;
    const { result, attempt: precalcAttempt } =
      await createAcceptedUransEvidence(
        "continuation-baseline",
        aoaDeg,
        "urans_precalc",
      );
    const [rejectedFullAttempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: result.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        engineJobId: `${PREFIX}-continuation-full-source`,
        engineCaseSlug: `aoa_${aoaDeg}_full`,
        solverImplementationId,
        status: "done",
        source: "solved",
        regime: "urans",
        validForPolar: false,
        cl: 0.66,
        cd: 0.046,
        cm: -0.031,
        converged: true,
        unsteady: true,
        qualityWarnings: [
          `URANS continuation ${URANS_CONTINUATION_REQUIRED_MARKER}: restartable final checkpoint retained`,
        ],
        evidencePayload: { fidelity: "urans_full" },
        solvedAt: new Date(),
      })
      .returning();
    attemptIds.push(rejectedFullAttempt.id);
    await insertExactManifest({
      resultId: result.id,
      resultAttemptId: rejectedFullAttempt.id,
      aoaDeg,
      engineJobId: rejectedFullAttempt.engineJobId!,
      engineCaseSlug: rejectedFullAttempt.engineCaseSlug!,
    });
    await db.insert(resultClassifications).values({
      resultAttemptId: rejectedFullAttempt.id,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      regime: "urans",
      classifierVersion: "full-request-continuation-test-v1",
      state: "rejected",
      region: "post_stall",
      confidence: 1,
      reasons: ["non-stationary"],
    });
    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId,
        aoaDeg,
      }),
    ).toBe(1);
    const [baselineQueue] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.precalcResultAttemptId, precalcAttempt.id));
    expect(baselineQueue).toBeDefined();
    queueIds.push(baselineQueue!.id);
    const [continuationJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        solverImplementationId,
        methodKey: "openfoam.urans",
        jobKind: "verify",
        referenceChordM: 0.1,
        wave: 2,
        status: "failed",
        engineJobId: rejectedFullAttempt.engineJobId,
        totalCases: 1,
        completedCases: 1,
        submittedAt: new Date(),
        finishedAt: new Date(),
        requestPayload: {
          aoas: [aoaDeg],
          uransFidelity: "full",
          verifyQueueItemId: baselineQueue!.id,
          verifyPrecalcResultAttemptId: precalcAttempt.id,
        },
      })
      .returning();
    jobIds.push(continuationJob.id);
    await db
      .update(resultAttempts)
      .set({ simJobId: continuationJob.id })
      .where(eq(resultAttempts.id, rejectedFullAttempt.id));
    await db
      .update(solverEvidenceArtifacts)
      .set({ simJobId: continuationJob.id })
      .where(
        eq(solverEvidenceArtifacts.resultAttemptId, rejectedFullAttempt.id),
      );
    evidenceBlobIds.push(
      (
        await createVerifiedRestartArchiveFixture(db, {
          resultId: result.id,
          resultAttemptId: rejectedFullAttempt.id,
        })
      ).blobId,
    );
    const { request } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg,
      fidelity: "full",
      requestedBy: `${PREFIX}-continuation-final`,
      continueFromResultId: result.id,
      continueFromResultAttemptId: rejectedFullAttempt.id,
      budgetOverrideS: 777,
    });
    requestIds.push(request.id);

    const coverage = await ensureFullUransRequestCoverage(db, {
      requestId: request.id,
      cells: [{ airfoilId, revisionId, aoaDeg }],
    });
    expect(coverage.precalcObligations).toEqual([]);
    expect(coverage.verifyQueueIds).toHaveLength(1);
    expect(coverage.verifyQueueIds[0]).toBe(baselineQueue!.id);
    const [queue] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, coverage.verifyQueueIds[0]!));
    expect(queue).toMatchObject({
      state: "pending",
      precalcResultId: result.id,
      latestResultAttemptId: rejectedFullAttempt.id,
      freshAttemptCount: 1,
      continuationAttemptCount: 0,
      continuationBudgetOverrideS: 777,
      lastOutcome: FINAL_URANS_OUTCOMES.continuationPending,
    });
    const retryAt = new Date(Date.now() + 60_000);
    await db
      .update(simUransVerifyQueue)
      .set({
        continuationAttemptCount: 1,
        continuationNoProgressCount: 1,
        nextSubmitAt: retryAt,
        lastOutcome: FINAL_URANS_OUTCOMES.continuationRetryWait,
        lastError: "measured continuation made no progress; backoff retained",
      })
      .where(eq(simUransVerifyQueue.id, queue.id));
    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId,
        aoaDeg,
        requestId: request.id,
      }),
    ).toBe(0);
    const [afterReplay] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, queue.id));
    expect(afterReplay).toMatchObject({
      latestResultAttemptId: rejectedFullAttempt.id,
      freshAttemptCount: 1,
      continuationAttemptCount: 1,
      continuationNoProgressCount: 1,
      continuationBudgetOverrideS: 777,
      lastOutcome: FINAL_URANS_OUTCOMES.continuationRetryWait,
      lastError: "measured continuation made no progress; backoff retained",
    });
    expect(afterReplay.nextSubmitAt?.getTime()).toBe(retryAt.getTime());
    expect(await refreshFullUransRequestState(db, request.id)).toBe("running");
  });

  it("keeps the latest exact productive final trajectory continuable beyond the former one-segment cap", async () => {
    const aoaDeg = 79.4 + (process.pid % 1000) / 100_000;
    const { result, attempt } = await createAcceptedUransEvidence(
      "productive-final-baseline",
      aoaDeg,
      "urans_precalc",
    );
    const [source] = await db
      .insert(resultAttempts)
      .values({
        resultId: result.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        engineJobId: `${PREFIX}-productive-final-source`,
        engineCaseSlug: `aoa_${aoaDeg}_full`,
        solverImplementationId,
        status: "done",
        source: "solved",
        regime: "urans",
        validForPolar: false,
        converged: true,
        unsteady: true,
        qualityWarnings: [
          `URANS continuation ${URANS_CONTINUATION_REQUIRED_MARKER}: productive full trajectory retained`,
        ],
        evidencePayload: {
          fidelity: "urans_full",
          frame_track: {
            period_s: 0.01,
            periods_retained: 8,
            stationary: false,
            drift_frac: 0.08,
            window: { t_start: 0.12, t_end: 0.2 },
          },
        },
        solvedAt: new Date(),
      })
      .returning();
    attemptIds.push(source.id);
    await db.insert(resultClassifications).values({
      resultAttemptId: source.id,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      regime: "urans",
      classifierVersion: `${PREFIX}-productive-full-source`,
      state: "rejected",
      region: "post_stall",
      confidence: 1,
      reasons: ["non-stationary"],
    });
    await insertExactManifest({
      resultId: result.id,
      resultAttemptId: source.id,
      aoaDeg,
      engineJobId: source.engineJobId!,
      engineCaseSlug: source.engineCaseSlug!,
    });
    evidenceBlobIds.push(
      (
        await createVerifiedRestartArchiveFixture(db, {
          resultId: result.id,
          resultAttemptId: source.id,
        })
      ).blobId,
    );
    const [queue] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId,
        aoaDeg,
        state: "pending",
        precalcResultId: result.id,
        precalcResultAttemptId: attempt.id,
        backgroundOwner: true,
        freshAttemptCount: 1,
        continuationAttemptCount: 7,
        continuationNoProgressCount: 0,
        latestResultAttemptId: source.id,
        lastOutcome: FINAL_URANS_OUTCOMES.continuationPending,
      })
      .returning();
    queueIds.push(queue.id);

    await expect(
      finalUransRecoveryPlanForVerifyItem(db, queue),
    ).resolves.toMatchObject({
      mode: "continuation",
      resultAttemptId: source.id,
      engineJobId: source.engineJobId,
      engineCaseSlug: source.engineCaseSlug,
    });
  });

  it("MUST-CATCH: migration projects accepted exact URANS evidence before preliminary exhaustion or incident backfill", async () => {
    const [campaign] = await db
      .insert(simCampaigns)
      .values({
        slug: `${PREFIX}-accepted-projection-owner`,
        name: `${PREFIX} accepted projection owner`,
        idempotencyKey: `${PREFIX}-accepted-projection-owner`,
        status: "active",
      })
      .returning();
    campaignIds.push(campaign.id);
    const cells = [
      79.5 + (process.pid % 1000) / 100_000,
      79.6 + (process.pid % 1000) / 100_000,
    ];
    const obligations = await ensurePrecalcObligations(
      db,
      cells.map((aoaDeg) => ({ airfoilId, revisionId, aoaDeg })),
      { campaignIds: [campaign.id] },
    );
    obligationIds.push(...obligations.map((obligation) => obligation.id));
    await db
      .update(simPrecalcObligations)
      .set({
        state: "pending",
        continuationSegmentCount: 4,
        continuationNoProgressCount: 2,
        lastOutcome: "continuation_pending",
      })
      .where(eq(simPrecalcObligations.id, obligations[0]!.id));
    await db
      .update(simPrecalcObligations)
      .set({
        state: "blocked",
        continuationSegmentCount: 4,
        continuationNoProgressCount: 2,
        lastOutcome: "continuation_segment_exhausted",
        completedAt: new Date(),
      })
      .where(eq(simPrecalcObligations.id, obligations[1]!.id));

    const acceptedEvidence: Array<{
      resultId: string;
      attemptId: string;
    }> = [];
    for (const [index, aoaDeg] of cells.entries()) {
      const [result] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg,
          status: "done",
          source: "solved",
          regime: "urans",
          fidelity: index === 0 ? "urans_full" : "urans_precalc",
          cl: 0.6 + index * 0.1,
          cd: 0.04 + index * 0.01,
          cm: -0.03,
          converged: true,
          unsteady: true,
          solvedAt: new Date(),
        })
        .returning();
      resultIds.push(result.id);
      const [attempt] = await db
        .insert(resultAttempts)
        .values({
          resultId: result.id,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg,
          solverImplementationId,
          status: "done",
          source: "solved",
          regime: "urans",
          validForPolar: true,
          cl: result.cl,
          cd: result.cd,
          cm: result.cm,
          converged: true,
          unsteady: true,
          evidencePayload: {
            fidelity: index === 0 ? "urans_full" : "urans_precalc",
          },
          solvedAt: new Date(),
        })
        .returning();
      attemptIds.push(attempt.id);
      await db.insert(resultClassifications).values({
        resultAttemptId: attempt.id,
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        regime: "urans",
        classifierVersion: "accepted-projection-migration-test-v1",
        state: "accepted",
        region: "attached",
        confidence: 1,
        reasons: [],
      });
      await db
        .update(results)
        .set({ currentResultAttemptId: attempt.id })
        .where(eq(results.id, result.id));
      acceptedEvidence.push({ resultId: result.id, attemptId: attempt.id });
    }

    const migration = readFileSync(
      resolve(here, "../migrations/0069_solver_incident_progress.sql"),
      "utf8",
    );
    const statementStart = migration.indexOf("WITH accepted AS");
    const statementEnd = migration.indexOf(
      "\n--> statement-breakpoint",
      statementStart,
    );
    expect(statementStart).toBeGreaterThanOrEqual(0);
    expect(statementEnd).toBeGreaterThan(statementStart);
    const projectionStatement = migration.slice(statementStart, statementEnd);

    await db.execute(drizzleSql.raw(projectionStatement));
    await db.execute(drizzleSql.raw(projectionStatement));
    const projected = await db
      .select()
      .from(simPrecalcObligations)
      .where(
        inArray(
          simPrecalcObligations.id,
          obligations.map((obligation) => obligation.id),
        ),
      );
    expect(projected).toHaveLength(2);
    for (const [index, obligation] of projected
      .sort((a, b) => a.aoaDeg - b.aoaDeg)
      .entries()) {
      expect(obligation).toMatchObject({
        state: "satisfied",
        sourceResultId: acceptedEvidence[index]!.resultId,
        sourceResultAttemptId: acceptedEvidence[index]!.attemptId,
        nextSubmitAt: null,
        lastOutcome: "accepted",
        lastError: null,
      });
    }
    expect(
      await precalcContinuationsForObligations(
        db,
        obligations.map((obligation) => obligation.id),
      ),
    ).toEqual([]);
    const ensuredAgain = await ensurePrecalcObligations(
      db,
      cells.map((aoaDeg) => ({ airfoilId, revisionId, aoaDeg })),
      { campaignIds: [campaign.id] },
    );
    expect(
      ensuredAgain.every((obligation) => obligation.state === "satisfied"),
    ).toBe(true);
    expect(
      await db
        .select()
        .from(simSolverIncidents)
        .where(
          inArray(
            simSolverIncidents.precalcObligationId,
            obligations.map((obligation) => obligation.id),
          ),
        ),
    ).toHaveLength(0);
    expect(
      (
        await db
          .select()
          .from(simPrecalcObligationCampaigns)
          .where(
            inArray(
              simPrecalcObligationCampaigns.obligationId,
              obligations.map((obligation) => obligation.id),
            ),
          )
      ).every(
        (owner) => owner.campaignId === campaign.id && owner.state === "active",
      ),
    ).toBe(true);
  });

  it("MUST-CATCH: migration elects one same-cell recovery target and conserves every live owner", async () => {
    const aoaDeg = 80.5 + (process.pid % 1000) / 100_000;
    const { result: precalc, attempt: precalcAttempt } =
      await createAcceptedUransEvidence(
        "recovery-election-precalc",
        aoaDeg,
        "urans_precalc",
      );
    const campaigns = await db
      .insert(simCampaigns)
      .values([
        {
          slug: `${PREFIX}-migration-owner-a`,
          name: `${PREFIX} migration owner A`,
          idempotencyKey: `${PREFIX}-migration-owner-a`,
          status: "active",
        },
        {
          slug: `${PREFIX}-migration-owner-b`,
          name: `${PREFIX} migration owner B`,
          idempotencyKey: `${PREFIX}-migration-owner-b`,
          status: "paused",
        },
      ])
      .returning();
    campaignIds.push(...campaigns.map((campaign) => campaign.id));
    const jobs = await db
      .insert(simJobs)
      .values(
        [0, 1].map((index) => ({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          solverImplementationId,
          methodKey: "openfoam.urans",
          jobKind: "verify",
          referenceChordM: 0.1,
          wave: 2,
          status: "done" as const,
          engineJobId: `${PREFIX}-migration-duplicate-${index}`,
          totalCases: 1,
          completedCases: 1,
          submittedAt: new Date(Date.now() - (2 - index) * 60_000),
          finishedAt: new Date(Date.now() - (2 - index) * 30_000),
          requestPayload: {
            aoas: [aoaDeg],
            uransFidelity: "full",
          },
        })),
      )
      .returning();
    jobIds.push(...jobs.map((job) => job.id));
    const attempts = [];
    for (const [index, job] of jobs.entries()) {
      const [attempt] = await db
        .insert(resultAttempts)
        .values({
          resultId: precalc.id,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg,
          simJobId: job.id,
          engineJobId: job.engineJobId,
          engineCaseSlug: `aoa_${aoaDeg}_${index}`,
          solverImplementationId,
          status: "done",
          source: "solved",
          regime: "urans",
          validForPolar: false,
          cl: 0.71 + index * 0.01,
          cd: 0.051 + index * 0.001,
          cm: -0.031,
          converged: true,
          unsteady: true,
          evidencePayload: { fidelity: "urans_full" },
          solvedAt: new Date(Date.now() - (2 - index) * 60_000),
        })
        .returning();
      attempts.push(attempt);
      attemptIds.push(attempt.id);
      await db.insert(resultClassifications).values({
        resultAttemptId: attempt.id,
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        regime: "urans",
        classifierVersion: "final-recovery-migration-test-v1",
        state: "rejected",
        region: "post_stall",
        confidence: 1,
        reasons: ["missing-urans-video"],
      });
    }
    const queues = await db
      .insert(simUransVerifyQueue)
      .values([
        {
          airfoilId,
          revisionId,
          aoaDeg,
          state: "cancelled",
          precalcResultId: precalc.id,
          precalcResultAttemptId: precalcAttempt.id,
          backgroundOwner: false,
          freshAttemptCount: 1,
          maxFreshAttempts: 2,
          continuationAttemptCount: 0,
          latestResultAttemptId: attempts[0]!.id,
        },
        {
          airfoilId,
          revisionId,
          aoaDeg,
          state: "cancelled",
          precalcResultId: precalc.id,
          precalcResultAttemptId: precalcAttempt.id,
          backgroundOwner: true,
          freshAttemptCount: 1,
          maxFreshAttempts: 2,
          continuationAttemptCount: 0,
          latestResultAttemptId: attempts[1]!.id,
        },
      ])
      .returning();
    queueIds.push(...queues.map((queue) => queue.id));
    await db.insert(simUransVerifyQueueCampaigns).values([
      { queueId: queues[0]!.id, campaignId: campaigns[0]!.id },
      { queueId: queues[1]!.id, campaignId: campaigns[1]!.id },
    ]);

    const migration = readFileSync(
      resolve(here, "../migrations/0068_final_urans_recovery.sql"),
      "utf8",
    );
    const statementStart = migration.indexOf("WITH recoverable AS");
    const statementEnd = migration.indexOf(
      "\n--> statement-breakpoint",
      statementStart,
    );
    expect(statementStart).toBeGreaterThanOrEqual(0);
    expect(statementEnd).toBeGreaterThan(statementStart);
    const reopenStatement = migration.slice(statementStart, statementEnd);

    await db.execute(drizzleSql.raw(reopenStatement));
    const afterFirst = await db
      .select()
      .from(simUransVerifyQueue)
      .where(
        inArray(
          simUransVerifyQueue.id,
          queues.map((queue) => queue.id),
        ),
      );
    const open = afterFirst.filter((queue) => queue.state === "pending");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      id: queues[1]!.id,
      backgroundOwner: true,
      lastOutcome: FINAL_URANS_OUTCOMES.mediaRepairPending,
    });
    expect(afterFirst.find((queue) => queue.id === queues[0]!.id)?.state).toBe(
      "cancelled",
    );
    const mergedOwners = await db
      .select()
      .from(simUransVerifyQueueCampaigns)
      .where(eq(simUransVerifyQueueCampaigns.queueId, open[0]!.id));
    expect(
      mergedOwners
        .filter((owner) => owner.state === "active")
        .map((owner) => owner.campaignId)
        .sort(),
    ).toEqual(campaigns.map((campaign) => campaign.id).sort());

    await expect(
      db
        .update(simUransVerifyQueue)
        .set({ state: "pending" })
        .where(eq(simUransVerifyQueue.id, queues[0]!.id)),
    ).rejects.toMatchObject({ code: "23505" });

    await db.execute(drizzleSql.raw(reopenStatement));
    const afterReplay = await db
      .select()
      .from(simUransVerifyQueue)
      .where(
        inArray(
          simUransVerifyQueue.id,
          queues.map((queue) => queue.id),
        ),
      );
    expect(
      afterReplay.filter((queue) => queue.state === "pending"),
    ).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(simUransVerifyQueueCampaigns)
          .where(eq(simUransVerifyQueueCampaigns.queueId, open[0]!.id))
      ).filter((owner) => owner.state === "active"),
    ).toHaveLength(2);
  });

  it("settles the exact repaired full attempt and resolves its pending warning incident", async () => {
    const fixture = await createMediaPendingFixture(
      "media-success",
      81 + (process.pid % 1000) / 100_000,
    );
    const request = await linkFullRequest(
      fixture.queue.id,
      fixture.queue.aoaDeg,
      "media-success-request",
    );
    const warning = await recordSolverIncident(db, {
      stage: "final",
      reason: "missing-urans-video",
      severity: "warning",
      owner: { verifyQueueId: fixture.queue.id },
      solverImplementationId,
      occurrenceKey: `final:${fixture.queue.id}:${fixture.attempt.id}:${FINAL_URANS_OUTCOMES.mediaRepairPending}`,
      simJobId: fixture.job.id,
      resultAttemptId: fixture.attempt.id,
    });
    await db
      .update(resultClassifications)
      .set({ state: "accepted", reasons: [] })
      .where(eq(resultClassifications.resultAttemptId, fixture.attempt.id));

    expect(
      await settleFinalUransVerificationAfterMediaRepair(
        db,
        fixture.attempt.id,
      ),
    ).toBe(1);
    const [queue] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, fixture.queue.id));
    expect(queue).toMatchObject({
      state: "done",
      verifyResultId: fixture.precalc.id,
      lastOutcome: FINAL_URANS_OUTCOMES.accepted,
      lastError: null,
    });
    expect(queue.deltaCl).toBeCloseTo(0.02, 12);
    expect(queue.deltaCd).toBeCloseTo(0.002, 12);
    const [resolved] = await db
      .select()
      .from(simSolverIncidents)
      .where(eq(simSolverIncidents.id, warning.id));
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    const [settledRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    expect(settledRequest).toMatchObject({
      state: "done",
      simJobId: null,
    });
  });

  it("settles accepted repaired evidence after producing job provenance has been retained away", async () => {
    const fixture = await createMediaPendingFixture(
      "media-success-without-job",
      81.5 + (process.pid % 1000) / 100_000,
    );
    await db
      .update(resultClassifications)
      .set({ state: "accepted", reasons: [] })
      .where(eq(resultClassifications.resultAttemptId, fixture.attempt.id));
    await db
      .update(resultAttempts)
      .set({ simJobId: null })
      .where(eq(resultAttempts.id, fixture.attempt.id));

    expect(
      await settleFinalUransVerificationAfterMediaRepair(
        db,
        fixture.attempt.id,
      ),
    ).toBe(1);
    const [queue] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, fixture.queue.id));
    expect(queue).toMatchObject({
      state: "done",
      verifyResultId: fixture.precalc.id,
      lastOutcome: FINAL_URANS_OUTCOMES.accepted,
    });
    expect(queue.deltaCl).toBeCloseTo(0.02, 12);
    expect(queue.deltaCd).toBeCloseTo(0.002, 12);
    expect(queue.deltaCm).toBeCloseTo(-0.001, 12);
  });

  it("marks exhausted media recovery critical with exact job, attempt, implementation, and stable outcome", async () => {
    const fixture = await createMediaPendingFixture(
      "media-exhausted",
      82 + (process.pid % 1000) / 100_000,
    );
    const request = await linkFullRequest(
      fixture.queue.id,
      fixture.queue.aoaDeg,
      "media-exhausted-request",
    );
    expect(
      await blockFinalUransVerificationAfterMediaRepair(
        db,
        fixture.attempt.id,
        "raw evidence unavailable after bounded media repair",
      ),
    ).toBe(1);
    const [queue] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, fixture.queue.id));
    expect(queue).toMatchObject({
      state: "blocked",
      lastOutcome: FINAL_URANS_OUTCOMES.recoveryExhausted,
      lastError: "raw evidence unavailable after bounded media repair",
    });
    const [incident] = await db
      .select()
      .from(simSolverIncidents)
      .where(
        and(
          eq(simSolverIncidents.verifyQueueId, fixture.queue.id),
          eq(simSolverIncidents.severity, "critical"),
        ),
      );
    expect(incident).toMatchObject({
      stage: "final",
      status: "open",
      reason: "missing-urans-video",
      solverImplementationId,
      simJobId: fixture.job.id,
      resultAttemptId: fixture.attempt.id,
      occurrenceKey: `final:${fixture.queue.id}:${fixture.attempt.id}:${FINAL_URANS_OUTCOMES.recoveryExhausted}`,
    });
    const [blockedRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    expect(blockedRequest).toMatchObject({
      state: "blocked",
      simJobId: null,
    });
  });

  it("heals an exhausted critical final incident when trusted media later makes the exact attempt accepted", async () => {
    const fixture = await createMediaPendingFixture(
      "late-trusted-media",
      83 + (process.pid % 1000) / 100_000,
    );
    expect(
      await blockFinalUransVerificationAfterMediaRepair(
        db,
        fixture.attempt.id,
        "automatic media repair exhausted before trusted media import",
      ),
    ).toBe(1);
    await db
      .update(resultClassifications)
      .set({ state: "accepted", reasons: [] })
      .where(eq(resultClassifications.resultAttemptId, fixture.attempt.id));

    expect(
      await settleFinalUransVerificationAfterMediaRepair(
        db,
        fixture.attempt.id,
      ),
    ).toBe(1);
    const [queue] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, fixture.queue.id));
    expect(queue).toMatchObject({
      state: "done",
      verifyResultId: fixture.precalc.id,
      lastOutcome: FINAL_URANS_OUTCOMES.accepted,
      lastError: null,
    });
    const [incident] = await db
      .select()
      .from(simSolverIncidents)
      .where(eq(simSolverIncidents.verifyQueueId, fixture.queue.id));
    expect(incident).toMatchObject({
      status: "resolved",
      resultAttemptId: fixture.attempt.id,
    });
    expect(incident.resolvedAt).toBeInstanceOf(Date);
  });

  it("atomically propagates every terminal media-repair path and reconciles legacy partial state", async () => {
    const claimFailure = await createMediaPendingFixture(
      "atomic-claim-failure",
      84 + (process.pid % 1000) / 100_000,
    );
    const claimToken = randomUUID();
    const [claimRepair] = await db
      .insert(resultMediaRepairs)
      .values({
        resultId: claimFailure.precalc.id,
        resultAttemptId: claimFailure.attempt.id,
        state: "running",
        evidenceSignature: `${PREFIX}:atomic-claim-failure`,
        attemptCount: 3,
        maxAttempts: 3,
        claimToken,
        claimedAt: new Date(),
        claimExpiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    expect(
      await failClaimedResultMediaRepair(
        db,
        claimRepair,
        "renderer failed on the final bounded attempt",
      ),
    ).toBe("blocked");

    const expired = await createMediaPendingFixture(
      "atomic-expired-claim",
      85 + (process.pid % 1000) / 100_000,
    );
    const expiredAt = new Date(Date.now() - 60_000);
    await db.insert(resultMediaRepairs).values({
      resultId: expired.precalc.id,
      resultAttemptId: expired.attempt.id,
      state: "running",
      evidenceSignature: `${PREFIX}:atomic-expired-claim`,
      attemptCount: 3,
      maxAttempts: 3,
      claimToken: randomUUID(),
      claimedAt: new Date(expiredAt.getTime() - 60_000),
      claimExpiresAt: expiredAt,
    });
    const healed = await healExpiredResultMediaRepairClaims(db, {
      now: new Date(),
    });
    expect(healed.blocked).toBeGreaterThanOrEqual(1);

    const invalidated = await createMediaPendingFixture(
      "atomic-byte-invalidation",
      86 + (process.pid % 1000) / 100_000,
    );
    const invalidatedSignature = `${PREFIX}:atomic-byte-invalidation`;
    const [invalidatedRepair] = await db
      .insert(resultMediaRepairs)
      .values({
        resultId: invalidated.precalc.id,
        resultAttemptId: invalidated.attempt.id,
        state: "done",
        evidenceSignature: invalidatedSignature,
        attemptCount: 3,
        maxAttempts: 3,
        completedAt: new Date(),
      })
      .returning();
    expect(
      await invalidateSatisfiedResultMediaRepair(
        db,
        invalidatedRepair.id,
        invalidated.attempt.id,
        invalidatedSignature,
        "stored video checksum no longer matches",
      ),
    ).toBe("blocked");

    const legacy = await createMediaPendingFixture(
      "legacy-blocked-gap",
      87 + (process.pid % 1000) / 100_000,
    );
    await db.insert(resultMediaRepairs).values({
      resultId: legacy.precalc.id,
      resultAttemptId: legacy.attempt.id,
      state: "blocked",
      evidenceSignature: `${PREFIX}:legacy-blocked-gap`,
      attemptCount: 3,
      maxAttempts: 3,
      lastError: "legacy process stopped after blocking the repair row",
    });
    expect(
      await reconcileBlockedFinalMediaRepairVerifications(db, {
        resultId: legacy.precalc.id,
      }),
    ).toBe(1);

    for (const fixture of [claimFailure, expired, invalidated, legacy]) {
      const [queue] = await db
        .select()
        .from(simUransVerifyQueue)
        .where(eq(simUransVerifyQueue.id, fixture.queue.id));
      expect(queue).toMatchObject({
        state: "blocked",
        lastOutcome: FINAL_URANS_OUTCOMES.recoveryExhausted,
      });
      const incidents = await db
        .select()
        .from(simSolverIncidents)
        .where(
          and(
            eq(simSolverIncidents.verifyQueueId, fixture.queue.id),
            eq(simSolverIncidents.status, "open"),
            eq(simSolverIncidents.severity, "critical"),
          ),
        );
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        resultAttemptId: fixture.attempt.id,
        solverImplementationId,
      });
    }
  });
});
