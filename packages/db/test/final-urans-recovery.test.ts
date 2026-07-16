import {
  FINAL_URANS_OUTCOMES,
  airfoils,
  blockFinalUransVerificationAfterMediaRepair,
  createClient,
  createUransRequest,
  ensureFullUransRequestCoverage,
  ensurePrecalcObligations,
  failClaimedResultMediaRepair,
  healExpiredResultMediaRepairClaims,
  invalidateSatisfiedResultMediaRepair,
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
  simPrecalcObligations,
  simSolverIncidents,
  simUransRequests,
  simUransVerifyQueue,
  simUransVerifyQueueCampaigns,
  simUransVerifyQueueRequests,
} from "@aerodb/db";
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
const here = dirname(fileURLToPath(import.meta.url));

let airfoilId = "";
let bcId = "";
let revisionId = "";
let solverImplementationId = "";
let cleanupSolverFixture: (() => Promise<void>) | null = null;

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
  if (queueIds.length) {
    await db
      .delete(simUransVerifyQueue)
      .where(inArray(simUransVerifyQueue.id, queueIds));
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
  return { queue, attempt, job, precalc };
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
) {
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
      fidelity,
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
      resultId: result.id,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      engineJobId: `${PREFIX}-${label}`,
      engineCaseSlug: `aoa_${aoaDeg}`,
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
    resultId: result.id,
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
  await db
    .update(results)
    .set({ currentResultAttemptId: attempt.id })
    .where(eq(results.id, result.id));
  return { result, attempt };
}

describe("final URANS media-repair recovery", () => {
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
    const { result } = await createAcceptedUransEvidence(
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

  it("MUST-CATCH: repeated final requests reuse accepted exact FULL evidence and its terminal queue projection without rerunning CFD", async () => {
    const aoaDeg = 79.2 + (process.pid % 1000) / 100_000;
    const { result } = await createAcceptedUransEvidence(
      "terminal-full-coverage",
      aoaDeg,
      "urans_full",
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
    queueIds.push(terminalQueueId);
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

  it("MUST-CATCH: a continuation-style final request seeds the ordinary final queue only after an accepted preliminary baseline exists", async () => {
    const aoaDeg = 79.3 + (process.pid % 1000) / 100_000;
    const { result } = await createAcceptedUransEvidence(
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
        qualityWarnings: ["restartable final checkpoint retained"],
        evidencePayload: { fidelity: "urans_full" },
        solvedAt: new Date(),
      })
      .returning();
    attemptIds.push(rejectedFullAttempt.id);
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
    const { request } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg,
      fidelity: "full",
      requestedBy: `${PREFIX}-continuation-final`,
      continueFromResultId: result.id,
      budgetOverrideS: 777,
    });
    requestIds.push(request.id);

    const coverage = await ensureFullUransRequestCoverage(db, {
      requestId: request.id,
      cells: [{ airfoilId, revisionId, aoaDeg }],
    });
    expect(coverage.precalcObligations).toEqual([]);
    expect(coverage.verifyQueueIds).toHaveLength(1);
    queueIds.push(coverage.verifyQueueIds[0]!);
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
    expect(await refreshFullUransRequestState(db, request.id)).toBe("running");
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
        cl: 0.7,
        cd: 0.05,
        cm: -0.03,
        converged: true,
        unsteady: true,
        solvedAt: new Date(),
      })
      .returning();
    resultIds.push(precalc.id);
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
      deltaCl: null,
      deltaCd: null,
      deltaCm: null,
    });
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
