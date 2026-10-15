import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  claimProgressiveCfdBatch,
  progressiveRemoteAdmissionReservedSlots,
  type DB,
} from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import {
  admissionCpuSlotsForRequest,
  REQUIRED_PRECALC_EVIDENCE_RECOVERY_VERSION,
} from "./build-request";
import { composeProgressiveCfdJob } from "./progressive-cfd-jobs";
import { effectiveMaxConcurrentJobs } from "./solver-capacity";
import {
  deferProgressiveClaim,
  ProgressiveEvidenceCellOwned,
} from "./progressive-claim-deferral";
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
    localTimeStepVersion?: number | null;
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
      const [role] = await connection.execute(
        sql`SELECT remote_solver_enabled FROM sync_api_settings LIMIT 1`,
      );
      if (role?.remote_solver_enabled) return null;
      const [epoch] = await connection.execute(
        sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
      );
      if (!epoch) throw new Error("Progressive calculation epoch is missing");
      const [state] =
        await connection.execute(sql`SELECT enabled, cpu_slots, max_concurrent_jobs,
        admission_fence_active, disk_admission_blocked FROM sweeper_state WHERE id = 1`);
      if (
        !state?.enabled ||
        state.admission_fence_active ||
        state.disk_admission_blocked
      )
        return null;
      const [remoteSolver] = await connection.execute(sql`
        SELECT solver.id,
          least(solver.cpu_capacity, CASE WHEN solver.cpu_budget > 0 THEN solver.cpu_budget ELSE solver.cpu_capacity END)::integer AS capacity
        FROM registered_remote_solvers solver
        JOIN sync_api_settings settings ON settings.id = 1
        JOIN sweeper_state remote_state ON remote_state.id = 1
        WHERE settings.enabled AND NOT settings.remote_solver_enabled
          AND remote_state.enabled AND NOT remote_state.admission_fence_active
          AND NOT remote_state.disk_admission_blocked
          AND solver.revoked_at IS NULL AND solver.auth_token_hash IS NOT NULL
          AND solver.credential_version > 0
          AND solver.last_heartbeat_at > clock_timestamp() - interval '2 minutes'
          AND solver.metadata->'progressiveExecution' IS NOT NULL
        ORDER BY solver.last_heartbeat_at, solver.id LIMIT 1
      `);
      if (remoteSolver) {
        const reserved = await progressiveRemoteAdmissionReservedSlots(
          connection,
          String(remoteSolver.id),
        );
        if (Number(remoteSolver.capacity) - reserved > 0) return null;
      }
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
        localTimeStepVersion: input.localTimeStepVersion,
        allowPhysicalTime:
          input.uransRecoveryVersion ===
          REQUIRED_PRECALC_EVIDENCE_RECOVERY_VERSION,
        campaignLockMode: "skip",
      });
      if (!leases.length) return null;
      const composed = await composeProgressiveCfdJob(connection, leases, {
        cpuSlots: available,
        meshRecoveryVersion: input.meshRecoveryVersion,
        uransRecoveryVersion: input.uransRecoveryVersion,
        solverBudgetVersion: input.solverBudgetVersion,
        localTimeStepVersion: input.localTimeStepVersion,
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
    if (error instanceof ProgressiveEvidenceCellOwned)
      return {
        kind: "deferred" as const,
        units: await deferProgressiveClaim(db, error),
      };
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
