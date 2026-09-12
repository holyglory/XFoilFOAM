import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  bindProgressiveRemoteDispatch,
  canonicalAnalysisJson,
  claimProgressiveCfdBatch,
  progressiveRemoteReservedSlots,
  progressiveRemoteActivePromiseCount,
  type DB,
  type ProgressiveRemoteExecutionEnvelope,
} from "@aerodb/db";
import { isEngineIdentity, type EngineIdentity } from "@aerodb/engine-client";
import { composeProgressiveCfdJob } from "./progressive-cfd-jobs";
import {
  deferProgressiveClaim,
  ProgressiveEvidenceCellOwned,
} from "./progressive-claim-deferral";
import { REQUIRED_PRECALC_EVIDENCE_RECOVERY_VERSION } from "./build-request";

export interface ProgressiveRemoteCapabilities {
  version: 1;
  solverBudgetVersion: 2;
  meshRecoveryVersion: number;
  uransRecoveryVersion: number | null;
  engine: EngineIdentity;
  executionPools: string[];
}

export function parseProgressiveRemoteCapabilities(
  value: unknown,
): ProgressiveRemoteCapabilities | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    raw.solverBudgetVersion !== 2 ||
    !Number.isSafeInteger(raw.meshRecoveryVersion) ||
    Number(raw.meshRecoveryVersion) < 0 ||
    !(
      raw.uransRecoveryVersion === null ||
      (Number.isSafeInteger(raw.uransRecoveryVersion) &&
        Number(raw.uransRecoveryVersion) >= 0)
    ) ||
    !isEngineIdentity(raw.engine) ||
    !Array.isArray(raw.executionPools) ||
    raw.executionPools.length < 1 ||
    raw.executionPools.length > 16 ||
    raw.executionPools.some(
      (pool) => typeof pool !== "string" || !pool.trim() || pool.length > 128,
    ) ||
    new Set(raw.executionPools).size !== raw.executionPools.length
  )
    return null;
  return {
    version: 1,
    solverBudgetVersion: 2,
    meshRecoveryVersion: Number(raw.meshRecoveryVersion),
    uransRecoveryVersion: raw.uransRecoveryVersion as number | null,
    engine: { ...raw.engine },
    executionPools: [...raw.executionPools] as string[],
  };
}

class RemoteProgressiveAdmissionWait extends Error {}

export async function prepareProgressiveRemoteDispatch(
  db: DB,
  solverId: string,
): Promise<
  | { kind: "prepared"; envelope: ProgressiveRemoteExecutionEnvelope }
  | { kind: "waiting"; reason: string; deferredUnits?: number }
> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      solverId,
    )
  )
    throw new Error(
      "Remote admission requires an exact registered solver identity",
    );
  try {
    return await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const [epoch] = await connection.execute(
        sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
      );
      if (!epoch)
        throw new RemoteProgressiveAdmissionWait(
          "No current campaign calculation epoch",
        );
      const [state] = await connection.execute(sql`
        SELECT enabled, admission_fence_active, disk_admission_blocked FROM sweeper_state WHERE id = 1 FOR UPDATE
      `);
      const [settings] = await connection.execute(sql`
        SELECT enabled, remote_solver_enabled FROM sync_api_settings WHERE id = 1
      `);
      const [permission] = await connection.execute(
        sql`SELECT can_fetch FROM sync_api_permissions WHERE data_type = 'sweeps'`,
      );
      if (
        !state?.enabled ||
        state.admission_fence_active ||
        state.disk_admission_blocked ||
        !settings?.enabled ||
        settings.remote_solver_enabled ||
        !permission?.can_fetch
      )
        throw new RemoteProgressiveAdmissionWait(
          "Hub campaign dispatch is paused or unavailable",
        );
      const [solver] = await connection.execute(sql`
        SELECT id, instance_id, instance_name, public_endpoint, cpu_capacity, cpu_budget, max_active_polar_promises, metadata, clock_timestamp() AS checked_at
        FROM registered_remote_solvers WHERE id = ${solverId}::uuid AND revoked_at IS NULL
          AND auth_token_hash IS NOT NULL AND credential_version > 0
          AND last_heartbeat_at > clock_timestamp() - interval '2 minutes'
        FOR UPDATE
      `);
      if (!solver)
        throw new RemoteProgressiveAdmissionWait(
          "The registered worker has no recent authenticated heartbeat",
        );
      const capabilities = parseProgressiveRemoteCapabilities(
        (solver.metadata as Record<string, unknown> | null)
          ?.progressiveExecution,
      );
      const observedAt = (solver.metadata as Record<string, unknown> | null)
        ?.progressiveExecutionObservedAt;
      const observationAge =
        typeof observedAt === "string"
          ? new Date(String(solver.checked_at)).getTime() -
            Date.parse(observedAt)
          : NaN;
      if (
        !capabilities ||
        !Number.isFinite(observationAge) ||
        observationAge < -30000 ||
        observationAge >= 60000
      )
        throw new RemoteProgressiveAdmissionWait(
          "The worker has not advertised the exact progressive execution contract",
        );
      const active = await progressiveRemoteActivePromiseCount(
        connection,
        solverId,
      );
      if (active >= Number(solver.max_active_polar_promises))
        throw new RemoteProgressiveAdmissionWait(
          "The worker has reached its assigned polar limit",
        );
      const capacity =
        Number(solver.cpu_budget) > 0
          ? Math.min(Number(solver.cpu_budget), Number(solver.cpu_capacity))
          : Number(solver.cpu_capacity);
      const available =
        capacity - (await progressiveRemoteReservedSlots(connection, solverId));
      if (!Number.isSafeInteger(available) || available < 1)
        throw new RemoteProgressiveAdmissionWait(
          "The worker has no unreserved CPU slots",
        );
      const leases = await claimProgressiveCfdBatch(connection, {
        owner: `remote-progressive-${solverId}`,
        remoteSolverId: solverId,
        leaseSeconds: 120,
        requireSweeperEnabled: true,
        solverBudgetVersion: 2,
        allowPhysicalTime:
          capabilities.uransRecoveryVersion ===
          REQUIRED_PRECALC_EVIDENCE_RECOVERY_VERSION,
      });
      if (!leases.length)
        throw new RemoteProgressiveAdmissionWait(
          "No eligible campaign cases are ready",
        );
      const composed = await composeProgressiveCfdJob(connection, leases, {
        cpuSlots: available,
        meshRecoveryVersion: capabilities.meshRecoveryVersion,
        solverBudgetVersion: 2,
      });
      if (
        canonicalAnalysisJson(composed.request.expected_engine) !==
          canonicalAnalysisJson(capabilities.engine) ||
        !capabilities.executionPools.includes(
          composed.request.expected_execution_pool!,
        )
      )
        throw new RemoteProgressiveAdmissionWait(
          "The worker does not execute this exact engine and numerical pool",
        );
      const [job] = await connection.execute(sql`
        SELECT airfoil_id, simulation_preset_revision_id FROM sim_jobs WHERE id = ${composed.jobId}::uuid
      `);
      const promiseId = randomUUID();
      await connection.execute(sql`
        INSERT INTO sync_sweep_promises (id, registered_solver_id, source_instance_id, source_instance_name, source_base_url,
          airfoil_id, simulation_preset_revision_id, aoa_count, "expiresAt", request_payload)
        VALUES (${promiseId}::uuid, ${solverId}::uuid, ${solver.instance_id}, ${solver.instance_name}, ${solver.public_endpoint},
          ${job.airfoil_id}::uuid, ${job.simulation_preset_revision_id}::uuid, ${leases.length}, clock_timestamp() + interval '1 hour',
          ${JSON.stringify({ solverId, progressiveExecutionId: composed.jobId, executionContract: "progressive-cfd-v1" })}::jsonb)
      `);
      for (const lease of leases)
        await connection.execute(sql`
          INSERT INTO sync_sweep_promise_points (promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg)
          VALUES (${promiseId}::uuid, ${job.airfoil_id}::uuid, ${job.simulation_preset_revision_id}::uuid, ${lease.alpha})
        `);
      const bound = await bindProgressiveRemoteDispatch(connection, {
        simJobId: composed.jobId,
        promiseId,
        solverId,
      });
      return { kind: "prepared" as const, envelope: bound.envelope };
    });
  } catch (error) {
    if (error instanceof ProgressiveEvidenceCellOwned)
      return {
        kind: "waiting" as const,
        reason:
          "Owned result cells deferred for another preparation opportunity",
        deferredUnits: await deferProgressiveClaim(db, error),
      };
    if (error instanceof RemoteProgressiveAdmissionWait)
      return { kind: "waiting", reason: error.message };
    throw error;
  }
}

export async function prepareProgressiveRemoteFleet(db: DB) {
  const solvers = await db.execute(sql`
    SELECT solver.id, least(solver.cpu_capacity, CASE WHEN solver.cpu_budget > 0 THEN solver.cpu_budget ELSE solver.cpu_capacity END)::integer AS capacity
    FROM registered_remote_solvers solver JOIN sync_api_settings settings ON settings.id = 1
    JOIN sweeper_state state ON state.id = 1
    WHERE settings.enabled AND NOT settings.remote_solver_enabled AND state.enabled
      AND NOT state.admission_fence_active AND NOT state.disk_admission_blocked
      AND solver.revoked_at IS NULL AND solver.auth_token_hash IS NOT NULL AND solver.credential_version > 0
      AND solver.last_heartbeat_at > clock_timestamp() - interval '2 minutes'
      AND solver.metadata->'progressiveExecution' IS NOT NULL
    ORDER BY solver.last_heartbeat_at, solver.id
  `);
  const receipt = {
    prepared: 0,
    deferred: 0,
    waiting: 0,
    errors: [] as Array<{ solverId: string; reason: string }>,
  };
  for (const solver of solvers) {
    const solverId = String(solver.id);
    const capacity = Number(solver.capacity);
    if (!Number.isSafeInteger(capacity) || capacity < 1) continue;
    for (let admitted = 0; admitted < capacity; admitted += 1) {
      try {
        const result = await prepareProgressiveRemoteDispatch(db, solverId);
        if (result.kind === "waiting" && result.deferredUnits !== undefined) {
          receipt.deferred += result.deferredUnits;
          if (!result.deferredUnits) break;
          continue;
        }
        if (result.kind === "waiting") {
          receipt.waiting += 1;
          break;
        }
        receipt.prepared += 1;
      } catch (error) {
        receipt.errors.push({
          solverId,
          reason: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
  }
  return receipt;
}
