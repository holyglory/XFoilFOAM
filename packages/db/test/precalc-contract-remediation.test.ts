import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient } from "../src/client";
import { databaseUrl } from "../src/env";
import { remediatePrecalcEvidenceContract } from "../src/precalc-contract-remediation";
import {
  airfoils,
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
});
