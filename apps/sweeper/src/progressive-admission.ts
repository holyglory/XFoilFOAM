import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { claimProgressiveCfdBatch, type DB } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import {
  admissionCpuSlotsForRequest,
  REQUIRED_PRECALC_EVIDENCE_RECOVERY_VERSION,
} from "./build-request";
import { composeProgressiveCfdJob } from "./progressive-cfd-jobs";
import { effectiveMaxConcurrentJobs } from "./solver-capacity";
import {
  solverQueuePressure,
  submitPendingJobWithLifecycleGuard,
} from "./submit-lifecycle";

class ProgressiveCapacityUnavailable extends Error {}

export async function admitProgressiveCfdBatch(
  db: DB,
  engine: EngineClient,
  input: {
    meshRecoveryVersion: number;
    uransRecoveryVersion?: number | null;
    solverBudgetVersion?: number | null;
    owner?: string;
  },
) {
  if (
    !Number.isInteger(input.meshRecoveryVersion) ||
    input.meshRecoveryVersion < 0
  )
    throw new Error(
      "Progressive admission requires a known mesh-recovery capability",
    );
  let prepared;
  if (input.solverBudgetVersion !== 2)
    return {
      kind: "capability_wait" as const,
      capability: "solver_budget_v2" as const,
    };
  try {
    prepared = await db.transaction(async (raw) => {
      const connection = raw as unknown as DB;
      const [epoch] = await connection.execute(
        sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
      );
      if (!epoch) throw new Error("Progressive calculation epoch is missing");
      const [state] =
        await connection.execute(sql`SELECT enabled, cpu_slots, max_concurrent_jobs,
        admission_fence_active, disk_admission_blocked FROM sweeper_state WHERE id = 1 FOR UPDATE`);
      const [role] = await connection.execute(
        sql`SELECT remote_solver_enabled FROM sync_api_settings LIMIT 1`,
      );
      if (
        !state?.enabled ||
        state.admission_fence_active ||
        state.disk_admission_blocked ||
        role?.remote_solver_enabled
      )
        return null;
      const capacity = effectiveMaxConcurrentJobs(
        Number(state.max_concurrent_jobs),
        Number(state.cpu_slots),
      );
      const available = capacity - (await solverQueuePressure(connection));
      if (available < 1) return null;
      const leases = await claimProgressiveCfdBatch(connection, {
        owner: input.owner ?? `progressive-cfd-${randomUUID()}`,
        leaseSeconds: 120,
        requireSweeperEnabled: true,
        solverBudgetVersion: input.solverBudgetVersion,
        allowPhysicalTime:
          input.uransRecoveryVersion ===
          REQUIRED_PRECALC_EVIDENCE_RECOVERY_VERSION,
      });
      if (!leases.length) return null;
      const composed = await composeProgressiveCfdJob(connection, leases, {
        cpuSlots: available,
        meshRecoveryVersion: input.meshRecoveryVersion,
        solverBudgetVersion: input.solverBudgetVersion,
      });
      if (admissionCpuSlotsForRequest(composed.request) > available)
        throw new ProgressiveCapacityUnavailable(
          "The next immutable solver allocation exceeds the available CPU slots",
        );
      return {
        ...composed,
        campaignId: leases[0].campaignId,
        stage: leases[0].stage,
      };
    });
  } catch (error) {
    if (error instanceof ProgressiveCapacityUnavailable)
      return { kind: "capacity_wait" as const, error: error.message };
    throw error;
  }
  if (!prepared) return { kind: "idle" as const };
  const outcome = await submitPendingJobWithLifecycleGuard({
    db,
    engine,
    jobId: prepared.jobId,
    campaignId: prepared.campaignId,
    request: prepared.request,
    connectionErrorPrefix: "Progressive engine connection: ",
    submitErrorPrefix: "Progressive submission: ",
  });
  return {
    kind: "attempted" as const,
    jobId: prepared.jobId,
    stage: prepared.stage,
    outcome,
  };
}
