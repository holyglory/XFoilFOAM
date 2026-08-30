import { eq, inArray, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient } from "../src/client";
import { databaseUrl } from "../src/env";
import { remediatePrecalcEvidenceContract } from "../src/precalc-contract-remediation";
import {
  airfoils,
  resultAttempts,
  resultCanonicalSelections,
  resultClassifications,
  resultInterpretations,
  resultReducerVersions,
  results,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligationRemediations,
  simPrecalcObligations,
  simulationPresetRevisions,
} from "../src/schema";

const { db, sql: client } = createClient({ url: databaseUrl(), max: 2 });
const SOURCE_REVISION = "a".repeat(40);
const obligationIds: string[] = [];
const jobIds: string[] = [];
let exhaustedId = "";
let withinBudgetId = "";
let activeId = "";

beforeAll(async () => {
  const [airfoil] = await db
    .select({ id: airfoils.id })
    .from(airfoils)
    .limit(1);
  const [revision] = await db
    .select({ id: simulationPresetRevisions.id })
    .from(simulationPresetRevisions)
    .limit(1);
  if (!airfoil || !revision) {
    throw new Error("precalc remediation test requires the normal seeded DB");
  }
  const [doneJob] = await db
    .insert(simJobs)
    .values({
      airfoilId: airfoil.id,
      bcIds: [],
      simulationPresetRevisionId: revision.id,
      jobKind: "targeted",
      referenceChordM: 1,
      wave: 2,
      status: "done",
      totalCases: 2,
      completedCases: 2,
      requestPayload: { precalcObligationIds: [] },
    })
    .returning();
  jobIds.push(doneJob.id);
  const obligations = await db
    .insert(simPrecalcObligations)
    .values([
      {
        airfoilId: airfoil.id,
        revisionId: revision.id,
        aoaDeg: 8_000 + (Date.now() % 1000),
        state: "blocked",
        attemptCount: 2,
        maxAttempts: 2,
        backgroundOwner: true,
        lastOutcome: "rejected_exhausted",
        completedAt: new Date(),
      },
      {
        airfoilId: airfoil.id,
        revisionId: revision.id,
        aoaDeg: 9_000 + (Date.now() % 1000),
        state: "blocked",
        attemptCount: 1,
        maxAttempts: 2,
        backgroundOwner: true,
        lastOutcome: "rejected",
        completedAt: new Date(),
      },
      {
        airfoilId: airfoil.id,
        revisionId: revision.id,
        aoaDeg: 10_000 + (Date.now() % 1000),
        state: "blocked",
        attemptCount: 2,
        maxAttempts: 2,
        backgroundOwner: true,
        lastOutcome: "rejected_exhausted",
        completedAt: new Date(),
      },
    ])
    .returning();
  [exhaustedId, withinBudgetId, activeId] = obligations.map((row) => row.id);
  obligationIds.push(...obligations.map((row) => row.id));
  await db.insert(simPrecalcObligationAttempts).values([
    {
      obligationId: exhaustedId,
      simJobId: doneJob.id,
      attemptNumber: 2,
      solverAttemptNumber: 2,
      consumesSolverAttempt: true,
      state: "rejected",
      outcome: "rejected_exhausted",
    },
    {
      obligationId: withinBudgetId,
      simJobId: doneJob.id,
      attemptNumber: 1,
      solverAttemptNumber: 1,
      consumesSolverAttempt: true,
      state: "rejected",
      outcome: "rejected",
    },
  ]);
  const [activeJob] = await db
    .insert(simJobs)
    .values({
      airfoilId: airfoil.id,
      bcIds: [],
      simulationPresetRevisionId: revision.id,
      jobKind: "targeted",
      referenceChordM: 1,
      wave: 2,
      status: "running",
      totalCases: 1,
      completedCases: 0,
      requestPayload: { precalcObligationIds: [activeId] },
    })
    .returning();
  jobIds.push(activeJob.id);
  await db.insert(simPrecalcObligationAttempts).values({
    obligationId: activeId,
    simJobId: activeJob.id,
    attemptNumber: 2,
    solverAttemptNumber: 2,
    consumesSolverAttempt: true,
    state: "submitted",
  });
});

afterAll(async () => {
  if (obligationIds.length) {
    await db
      .delete(simPrecalcObligations)
      .where(inArray(simPrecalcObligations.id, obligationIds));
  }
  if (jobIds.length) {
    await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
  }
  await client.end();
});

const evaluations = () => [
  {
    obligationId: exhaustedId,
    resultAttemptId: null,
    action: "rerun_statistical_mean_contract" as const,
    statisticalMeanScore: 1,
  },
  {
    obligationId: withinBudgetId,
    resultAttemptId: null,
    action: "rerun_conservative_numerics" as const,
    statisticalMeanScore: 0,
  },
  {
    obligationId: activeId,
    resultAttemptId: null,
    action: "rerun_fresh" as const,
    statisticalMeanScore: 0,
  },
];

describe("PRECALC evidence-contract remediation", () => {
  it("dry-runs exact ownership without changing obligation state", async () => {
    const result = await remediatePrecalcEvidenceContract(db, {
      evaluations: evaluations(),
      sourceRevision: SOURCE_REVISION,
      execute: false,
    });
    expect(result).toMatchObject({ eligible: 2, skipped: 1 });
    const rows = await db
      .select({
        id: simPrecalcObligations.id,
        state: simPrecalcObligations.state,
      })
      .from(simPrecalcObligations)
      .where(inArray(simPrecalcObligations.id, obligationIds));
    expect(rows.every((row) => row.state === "blocked")).toBe(true);
  });

  it("uses an existing attempt before granting one exact exhausted owner", async () => {
    const result = await remediatePrecalcEvidenceContract(db, {
      evaluations: evaluations(),
      sourceRevision: SOURCE_REVISION,
      execute: true,
    });
    expect(result.reopenedWithinExistingBudget).toEqual([withinBudgetId]);
    expect(result.grantedAdditionalAttempt).toEqual([exhaustedId]);
    expect(result.skipped).toBe(1);

    const rows = await db
      .select()
      .from(simPrecalcObligations)
      .where(inArray(simPrecalcObligations.id, obligationIds));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(exhaustedId)).toMatchObject({
      state: "pending",
      maxAttempts: 3,
      remediationAttemptsGranted: 1,
      lastOutcome: "aperiodic_contract_retry_pending",
    });
    expect(byId.get(withinBudgetId)).toMatchObject({
      state: "pending",
      maxAttempts: 2,
      remediationAttemptsGranted: 0,
      lastOutcome: "numerical_recovery_pending",
    });
    expect(byId.get(activeId)).toMatchObject({ state: "blocked" });
    const grants = await db
      .select()
      .from(simPrecalcObligationRemediations)
      .where(eq(simPrecalcObligationRemediations.obligationId, exhaustedId));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ sourceRevision: SOURCE_REVISION });
  });

  it("is idempotent for the same source revision", async () => {
    const result = await remediatePrecalcEvidenceContract(db, {
      evaluations: evaluations(),
      sourceRevision: SOURCE_REVISION,
      execute: true,
    });
    expect(result).toMatchObject({ eligible: 0, skipped: 3 });
  });

  it("MUST-CATCH: reruns an accepted live summary but suppresses canonically selected evidence", async () => {
    const [base] = await db
      .select({
        airfoilId: results.airfoilId,
        bcId: results.bcId,
        revisionId: results.simulationPresetRevisionId,
        solverImplementationId:
          simulationPresetRevisions.solverImplementationId,
      })
      .from(results)
      .innerJoin(
        simulationPresetRevisions,
        eq(simulationPresetRevisions.id, results.simulationPresetRevisionId),
      )
      .where(isNotNull(results.simulationPresetRevisionId))
      .limit(1);
    const [reducer] = await db
      .select({ id: resultReducerVersions.id })
      .from(resultReducerVersions)
      .limit(1);
    if (!base?.revisionId || !reducer) {
      throw new Error(
        "canonical remediation regression requires seeded result and reducer rows",
      );
    }

    const [doneJob] = await db
      .insert(simJobs)
      .values({
        airfoilId: base.airfoilId,
        bcIds: [base.bcId],
        simulationPresetRevisionId: base.revisionId,
        jobKind: "targeted",
        referenceChordM: 1,
        wave: 2,
        status: "done",
        totalCases: 2,
        completedCases: 2,
        requestPayload: { precalcObligationIds: [] },
      })
      .returning();
    const createdResultIds: string[] = [];
    const createdObligationIds: string[] = [];
    const aoaBase = 50_000 + process.pid + (Date.now() % 1_000) / 1_000;

    const createFixture = async (canonical: boolean, aoaDeg: number) => {
      const [result] = await db
        .insert(results)
        .values({
          airfoilId: base.airfoilId,
          bcId: base.bcId,
          simulationPresetRevisionId: base.revisionId,
          solverImplementationId: base.solverImplementationId,
          aoaDeg,
          status: "failed",
          source: "solved",
          regime: "urans",
          fidelity: "urans_precalc",
          error: "older rejected generation",
        })
        .returning();
      createdResultIds.push(result.id);
      const [rejectedAttempt] = await db
        .insert(resultAttempts)
        .values({
          resultId: result.id,
          airfoilId: base.airfoilId,
          bcId: base.bcId,
          simulationPresetRevisionId: base.revisionId,
          solverImplementationId: base.solverImplementationId,
          simJobId: doneJob.id,
          engineJobId: `canonical-remediation-rejected-${aoaDeg}`,
          aoaDeg,
          status: "failed",
          source: "solved",
          regime: "urans",
          unsteady: true,
          converged: false,
          error: "rejected FAST evidence",
          evidencePayload: {
            fidelity: "urans_precalc",
            failure_disposition: "hard_solver",
          },
        })
        .returning();
      const [acceptedAttempt] = await db
        .insert(resultAttempts)
        .values({
          resultId: result.id,
          airfoilId: base.airfoilId,
          bcId: base.bcId,
          simulationPresetRevisionId: base.revisionId,
          solverImplementationId: base.solverImplementationId,
          simJobId: doneJob.id,
          engineJobId: `canonical-remediation-accepted-${aoaDeg}`,
          aoaDeg,
          status: "done",
          source: "solved",
          regime: "urans",
          validForPolar: true,
          cl: 0.7,
          cd: 0.02,
          cm: -0.06,
          clCd: 35,
          unsteady: true,
          converged: true,
          evidencePayload: { fidelity: "urans_precalc" },
        })
        .returning();
      await db
        .update(results)
        .set({ currentResultAttemptId: rejectedAttempt.id })
        .where(eq(results.id, result.id));
      await db.insert(resultClassifications).values({
        resultId: result.id,
        resultAttemptId: acceptedAttempt.id,
        airfoilId: base.airfoilId,
        simulationPresetRevisionId: base.revisionId,
        aoaDeg,
        regime: "urans",
        classifierVersion: "canonical-remediation-test-v1",
        state: "accepted",
        region: "unknown",
        reasons: [],
      });
      const [interpretation] = await db
        .insert(resultInterpretations)
        .values({
          resultId: result.id,
          resultAttemptId: acceptedAttempt.id,
          reducerVersionId: reducer.id,
          source: canonical ? "corrective_generation" : "engine_reported",
          inputEvidenceSignature: `canonical-remediation-${canonical}-${aoaDeg}`,
          state: "accepted",
          regime: "periodic",
          selectedWindow: {},
          statistics: {},
          diagnostics: {},
          cl: 0.7,
          cd: 0.02,
          cm: -0.06,
          clCd: 35,
        })
        .returning();
      const [obligation] = await db
        .insert(simPrecalcObligations)
        .values({
          airfoilId: base.airfoilId,
          revisionId: base.revisionId,
          aoaDeg,
          sourceResultId: result.id,
          sourceResultAttemptId: rejectedAttempt.id,
          state: "blocked",
          attemptCount: 2,
          maxAttempts: 2,
          backgroundOwner: true,
          lastOutcome: "rejected_exhausted",
          completedAt: new Date(),
        })
        .returning();
      createdObligationIds.push(obligation.id);
      await db.insert(simPrecalcObligationAttempts).values({
        obligationId: obligation.id,
        simJobId: doneJob.id,
        resultAttemptId: rejectedAttempt.id,
        attemptNumber: 2,
        solverAttemptNumber: 2,
        consumesSolverAttempt: true,
        state: "rejected",
        outcome: "rejected_exhausted",
      });

      if (canonical) {
        const [selection] = await db
          .insert(resultCanonicalSelections)
          .values({
            resultId: result.id,
            resultAttemptId: acceptedAttempt.id,
            resultInterpretationId: interpretation.id,
            selectionNamespace: "canonical-remediation-test-v1",
            reason: "accepted immutable fixture evidence",
            actor: "test",
          })
          .returning();
        await db
          .update(results)
          .set({
            status: "done",
            error: null,
            currentResultAttemptId: acceptedAttempt.id,
            currentResultInterpretationId: interpretation.id,
            currentCanonicalSelectionId: selection.id,
          })
          .where(eq(results.id, result.id));
      }
      return {
        obligationId: obligation.id,
        resultAttemptId: rejectedAttempt.id,
      };
    };

    try {
      const noncanonical = await createFixture(false, aoaBase);
      const canonical = await createFixture(true, aoaBase + 0.001);
      const result = await remediatePrecalcEvidenceContract(db, {
        evaluations: [noncanonical, canonical].map((fixture) => ({
          ...fixture,
          action: "rerun_conservative_numerics" as const,
          statisticalMeanScore: 0,
        })),
        sourceRevision: "b".repeat(40),
        execute: false,
      });

      expect(result).toMatchObject({ eligible: 1, skipped: 1 });
    } finally {
      if (createdObligationIds.length) {
        await db
          .delete(simPrecalcObligations)
          .where(inArray(simPrecalcObligations.id, createdObligationIds));
      }
      if (createdResultIds.length) {
        await db.delete(results).where(inArray(results.id, createdResultIds));
      }
      await db.delete(simJobs).where(eq(simJobs.id, doneJob.id));
    }
  });
});
