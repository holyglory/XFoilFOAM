import { URANS_CONTINUATION_REQUIRED_MARKER } from "@aerodb/core";
import {
  MAX_PRECALC_CONTINUATION_SEGMENTS,
  MAX_PRECALC_NO_PROGRESS_SEGMENTS,
  airfoils,
  createClient,
  ensurePrecalcObligations,
  precalcContinuationMadeProgress,
  precalcContinuationProgressFromEvidence,
  precalcContinuationsForObligations,
  recordPrecalcObligationSubmission,
  requeueRestartablePrecalcContinuations,
  resultAttempts,
  resultClassifications,
  settlePrecalcObligationsForJob,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligations,
  simSolverIncidents,
} from "@aerodb/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMinimalSolverFixture,
  type MinimalSolverFixture,
} from "./solver-fixture";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `precalc-progress-${process.pid}-${Date.now().toString(36)}`;
const jobIds: string[] = [];
const resultAttemptIds: string[] = [];
const obligationIds: string[] = [];
let airfoilId = "";
let bcId = "";
let revisionId = "";
let solverImplementationId = "";
let obligationId = "";
let fixture: MinimalSolverFixture;
const aoaDeg = 80 + (process.pid % 1000) / 100_000;

const frameTrack = {
  period_s: 2,
  periods_retained: 1,
  stationary: false,
  drift_frac: 0.4,
  window: { t_start: 8, t_end: 10 },
};

beforeAll(async () => {
  const [airfoil] = await db
    .select({ id: airfoils.id })
    .from(airfoils)
    .limit(1);
  if (!airfoil) throw new Error("seeded airfoil fixture missing");
  fixture = await createMinimalSolverFixture(db, PREFIX);
  airfoilId = airfoil.id;
  bcId = fixture.bcId;
  revisionId = fixture.revisionId;
  solverImplementationId = fixture.solverImplementationId;
  const [obligation] = await ensurePrecalcObligations(
    db,
    [{ airfoilId, revisionId, aoaDeg }],
    { backgroundOwner: true },
  );
  if (!obligation) throw new Error("precalc obligation was not created");
  obligationId = obligation.id;
  obligationIds.push(obligation.id);
});

afterAll(async () => {
  if (obligationIds.length) {
    await db
      .delete(simPrecalcObligations)
      .where(inArray(simPrecalcObligations.id, obligationIds));
  }
  if (resultAttemptIds.length) {
    await db
      .delete(resultClassifications)
      .where(inArray(resultClassifications.resultAttemptId, resultAttemptIds));
    await db
      .delete(resultAttempts)
      .where(inArray(resultAttempts.id, resultAttemptIds));
  }
  if (jobIds.length) {
    await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
  }
  await fixture?.cleanup();
  await sql.end();
});

async function completeRejectedSegment(input: {
  suffix: string;
  continueFromResultAttemptId?: string;
  targetObligationId?: string;
  targetAoaDeg?: number;
  track?: typeof frameTrack;
}) {
  const targetObligationId = input.targetObligationId ?? obligationId;
  const targetAoaDeg = input.targetAoaDeg ?? aoaDeg;
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      solverImplementationId,
      jobKind: "targeted",
      referenceChordM: 1,
      wave: 2,
      status: "submitted",
      engineJobId: `${PREFIX}-${input.suffix}`,
      submittedAt: new Date(),
      totalCases: 1,
      completedCases: 1,
      requestPayload: {
        aoas: [targetAoaDeg],
        uransFidelity: "precalc",
        precalcObligationIds: [targetObligationId],
        ...(input.continueFromResultAttemptId
          ? {
              continueFromResultAttemptId: input.continueFromResultAttemptId,
            }
          : {}),
      },
    })
    .returning();
  jobIds.push(job.id);
  await db
    .update(simPrecalcObligations)
    .set({ latestSimJobId: job.id, state: "pending" })
    .where(eq(simPrecalcObligations.id, targetObligationId));
  await recordPrecalcObligationSubmission(db, job.id, [targetObligationId]);

  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      solverImplementationId,
      aoaDeg: targetAoaDeg,
      simJobId: job.id,
      engineJobId: job.engineJobId,
      engineCaseSlug: "aoa_80",
      status: "done",
      source: "solved",
      regime: "urans",
      validForPolar: false,
      converged: true,
      unsteady: true,
      qualityWarnings: [
        `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: retained restartable latestTime state`,
      ],
      evidencePayload: {
        fidelity: "urans_precalc",
        frame_track: input.track ?? frameTrack,
      },
      solvedAt: new Date(),
    })
    .returning();
  resultAttemptIds.push(attempt.id);
  await db.insert(resultClassifications).values({
    resultAttemptId: attempt.id,
    airfoilId,
    simulationPresetRevisionId: revisionId,
    aoaDeg: targetAoaDeg,
    regime: "urans",
    classifierVersion: PREFIX,
    state: "rejected",
    region: "post_stall",
    confidence: 1,
    reasons: ["non-stationary"],
  });
  const [completedJob] = await db
    .update(simJobs)
    .set({ status: "done", finishedAt: new Date() })
    .where(eq(simJobs.id, job.id))
    .returning();
  await settlePrecalcObligationsForJob(db, completedJob);
  return attempt;
}

describe("cross-segment preliminary URANS progress", () => {
  it("requires measured phase/time improvement instead of a heartbeat", () => {
    const baseline = precalcContinuationProgressFromEvidence({
      frame_track: frameTrack,
    });
    expect(precalcContinuationMadeProgress(baseline, baseline)).toBe(false);
    expect(
      precalcContinuationMadeProgress(baseline, {
        ...baseline,
        periodsRetained: 1.25,
      }),
    ).toBe(true);
    expect(
      precalcContinuationMadeProgress(baseline, {
        ...baseline,
        driftFrac: 0.35,
      }),
    ).toBe(true);
  });

  it("blocks after repeated no-progress continuations and records one replay-stable critical incident", async () => {
    const initial = await completeRejectedSegment({ suffix: "initial" });
    let obligation = (
      await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligationId))
    )[0]!;
    expect(obligation).toMatchObject({
      state: "pending",
      continuationSegmentCount: 0,
      continuationNoProgressCount: 0,
    });

    let checkpoint = initial;
    for (
      let segment = 1;
      segment <= MAX_PRECALC_NO_PROGRESS_SEGMENTS;
      segment += 1
    ) {
      checkpoint = await completeRejectedSegment({
        suffix: `continuation-${segment}`,
        continueFromResultAttemptId: checkpoint.id,
      });
    }

    obligation = (
      await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligationId))
    )[0]!;
    expect(obligation).toMatchObject({
      state: "blocked",
      lastOutcome: "continuation_no_progress_exhausted",
      continuationSegmentCount: MAX_PRECALC_NO_PROGRESS_SEGMENTS,
      continuationNoProgressCount: MAX_PRECALC_NO_PROGRESS_SEGMENTS,
    });
    expect(
      await precalcContinuationsForObligations(db, [obligationId]),
    ).toEqual([]);
    expect(
      await requeueRestartablePrecalcContinuations(db, {
        obligationIds: [obligationId],
      }),
    ).toEqual({
      obligationIds: [],
      campaignIds: [],
      requestIds: [],
      repairedSubmissionIds: [],
    });

    const ledger = await db
      .select()
      .from(simPrecalcObligationAttempts)
      .where(eq(simPrecalcObligationAttempts.obligationId, obligationId));
    expect(
      ledger.filter((entry) => entry.continuationSegmentNumber != null),
    ).toHaveLength(MAX_PRECALC_NO_PROGRESS_SEGMENTS);
    expect(
      ledger.filter((entry) => entry.continuationProgressed === false),
    ).toHaveLength(MAX_PRECALC_NO_PROGRESS_SEGMENTS);

    let incidents = await db
      .select()
      .from(simSolverIncidents)
      .where(eq(simSolverIncidents.precalcObligationId, obligationId));
    expect(
      incidents.filter((incident) => incident.severity === "critical"),
    ).toEqual([
      expect.objectContaining({
        reason: "continuation-no-progress",
        status: "open",
      }),
    ]);

    const [latestJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, jobIds.at(-1)!));
    await settlePrecalcObligationsForJob(db, latestJob);
    incidents = await db
      .select()
      .from(simSolverIncidents)
      .where(eq(simSolverIncidents.precalcObligationId, obligationId));
    expect(
      incidents.filter((incident) => incident.severity === "critical"),
    ).toHaveLength(1);
  }, 120_000);

  it("stops a trajectory that keeps changing but never becomes publishable at the total continuation cap", async () => {
    const cappedAoaDeg = aoaDeg + 0.1;
    const [cappedObligation] = await ensurePrecalcObligations(
      db,
      [{ airfoilId, revisionId, aoaDeg: cappedAoaDeg }],
      { backgroundOwner: true },
    );
    if (!cappedObligation) throw new Error("capped obligation was not created");
    obligationIds.push(cappedObligation.id);

    let checkpoint = await completeRejectedSegment({
      suffix: "cap-initial",
      targetObligationId: cappedObligation.id,
      targetAoaDeg: cappedAoaDeg,
    });
    for (
      let segment = 1;
      segment <= MAX_PRECALC_CONTINUATION_SEGMENTS;
      segment += 1
    ) {
      checkpoint = await completeRejectedSegment({
        suffix: `cap-continuation-${segment}`,
        continueFromResultAttemptId: checkpoint.id,
        targetObligationId: cappedObligation.id,
        targetAoaDeg: cappedAoaDeg,
        track: {
          ...frameTrack,
          periods_retained: frameTrack.periods_retained + segment * 0.3,
          window: {
            ...frameTrack.window,
            t_end: frameTrack.window.t_end + segment,
          },
        },
      });
    }

    const [settled] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, cappedObligation.id));
    expect(settled).toMatchObject({
      state: "blocked",
      lastOutcome: "continuation_segment_exhausted",
      continuationSegmentCount: MAX_PRECALC_CONTINUATION_SEGMENTS,
      continuationNoProgressCount: 0,
    });
    expect(
      await precalcContinuationsForObligations(db, [cappedObligation.id]),
    ).toEqual([]);

    const incidents = await db
      .select()
      .from(simSolverIncidents)
      .where(eq(simSolverIncidents.precalcObligationId, cappedObligation.id));
    expect(
      incidents.filter((incident) => incident.severity === "critical"),
    ).toEqual([
      expect.objectContaining({
        reason: "continuation-segment-limit",
        status: "open",
      }),
    ]);

    await db
      .update(simPrecalcObligations)
      .set({ lastOutcome: "rejected_exhausted" })
      .where(eq(simPrecalcObligations.id, cappedObligation.id));
    expect(
      await requeueRestartablePrecalcContinuations(db, {
        obligationIds: [cappedObligation.id],
      }),
    ).toEqual({
      obligationIds: [],
      campaignIds: [],
      requestIds: [],
      repairedSubmissionIds: [],
    });
    const [stillBlocked] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, cappedObligation.id));
    expect(stillBlocked.state).toBe("blocked");

    const [legacyActiveJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        solverImplementationId,
        jobKind: "targeted",
        referenceChordM: 1,
        wave: 2,
        status: "submitted",
        engineJobId: `${PREFIX}-cap-legacy-active`,
        submittedAt: new Date(),
        totalCases: 1,
        requestPayload: {
          aoas: [cappedAoaDeg],
          uransFidelity: "precalc",
          precalcObligationIds: [cappedObligation.id],
          continueFromResultAttemptId: checkpoint.id,
        },
      })
      .returning();
    jobIds.push(legacyActiveJob.id);
    await db
      .update(simPrecalcObligations)
      .set({
        state: "pending",
        latestSimJobId: legacyActiveJob.id,
        lastOutcome: "continuation_recovery_pending",
      })
      .where(eq(simPrecalcObligations.id, cappedObligation.id));
    await recordPrecalcObligationSubmission(db, legacyActiveJob.id, [
      cappedObligation.id,
    ]);
    const [failedLegacyJob] = await db
      .update(simJobs)
      .set({
        status: "failed",
        error: "temporary continuation transport interruption",
        finishedAt: new Date(),
      })
      .where(eq(simJobs.id, legacyActiveJob.id))
      .returning();
    await settlePrecalcObligationsForJob(db, failedLegacyJob, {
      terminalError: failedLegacyJob.error,
      terminalFailureDisposition: "infrastructure",
      terminalContinuationFailureKind: "transient",
      cancellation: "transient",
    });
    const [legacySettlement] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, cappedObligation.id));
    expect(legacySettlement).toMatchObject({
      state: "blocked",
      lastOutcome: "continuation_segment_exhausted",
      continuationSegmentCount: MAX_PRECALC_CONTINUATION_SEGMENTS,
    });
  }, 120_000);
});
