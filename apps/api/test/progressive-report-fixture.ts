import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  progressiveRemoteDispatches,
  sealProgressiveRemoteExecution,
  simJobs,
  type ProgressiveRemoteReport,
} from "@aerodb/db";
import {
  OPENCFD_2606_ENGINE,
  type ProgressiveExecutionScope,
} from "@aerodb/engine-client";
import { db } from "../src/db";

export async function createProgressiveReportFixture(input: {
  solverId: string;
  promiseId: string;
  airfoilId: string;
  revisionId: string;
  bcId: string;
  alpha: number;
}) {
  const executionId = randomUUID();
  const token = randomUUID();
  const scope: ProgressiveExecutionScope = {
    executionContract: "progressive-cfd-v1",
    executionId,
    epochId: randomUUID(),
    generationId: randomUUID(),
    targetId: "a".repeat(64),
    recipeId: "b".repeat(64),
    stage: 2,
    tokens: [token],
    units: [
      {
        unitId: randomUUID(),
        token,
        alpha: input.alpha,
        activeBudgetSeconds: 900,
      },
    ],
  };
  const envelope = sealProgressiveRemoteExecution({
    solverId: input.solverId,
    promiseId: input.promiseId,
    scope,
    request: {
      execution_id: executionId,
      expected_engine: { ...OPENCFD_2606_ENGINE },
      expected_execution_pool: "isolated-report-test",
      expected_mesh_recovery_version: 1,
      expected_solver_budget_version: 2,
      airfoil: { name: "isolated non-executing report fixture" },
      chord_lengths: [1],
      speeds: [30],
      aoa: { angles: [input.alpha] },
      solver: { warm_start: true },
      resources: { case_concurrency: 1, case_solver_budget_seconds: 900 },
    },
  });
  await db.insert(simJobs).values({
    id: executionId,
    airfoilId: input.airfoilId,
    simulationPresetRevisionId: input.revisionId,
    bcIds: [input.bcId],
    referenceChordM: 1,
    status: "pending",
    totalCases: 1,
    admissionCpuSlots: 1,
    requestPayload: { progressive: scope, engineRequest: envelope.request },
  });
  try {
    await db.insert(progressiveRemoteDispatches).values({
      simJobId: executionId,
      solverId: input.solverId,
      promiseId: input.promiseId,
      cpuSlots: 1,
      contentSignature: envelope.contentSignature,
      envelope: envelope as unknown as Record<string, unknown>,
    });
  } catch (error) {
    await db.delete(simJobs).where(eq(simJobs.id, executionId));
    throw error;
  }
  const report: ProgressiveRemoteReport = {
    version: 1,
    solverId: input.solverId,
    promiseId: input.promiseId,
    executionId,
    assignmentSignature: envelope.contentSignature,
    sequence: 1,
    status: {
      job_id: executionId,
      state: "pending",
      total_cases: 1,
      completed_cases: 0,
    },
    result: null,
    stopProof: null,
  };
  return {
    executionId,
    envelope,
    report,
    cleanup: async () => {
      await db
        .delete(progressiveRemoteDispatches)
        .where(eq(progressiveRemoteDispatches.simJobId, executionId));
      await db.delete(simJobs).where(eq(simJobs.id, executionId));
    },
  };
}
