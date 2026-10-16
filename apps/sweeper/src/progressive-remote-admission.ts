import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  bindProgressiveRemoteDispatch,
  canonicalAnalysisJson,
  claimProgressiveCfdBatch,
  clearHubWorkerPayloadFields,
  progressiveRemoteAdmissionReservedSlots,
  progressiveRemoteActivePromiseCount,
  PROGRESSIVE_REMOTE_START_LEASE_SECONDS,
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

const PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT = 10_000;

export interface ProgressiveRemoteCapabilities {
  localTimeStepVersion?: number | null;
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
    (raw.localTimeStepVersion != null &&
      (!Number.isSafeInteger(raw.localTimeStepVersion) ||
        Number(raw.localTimeStepVersion) < 0)) ||
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
    ...(raw.localTimeStepVersion != null
      ? { localTimeStepVersion: Number(raw.localTimeStepVersion) }
      : {}),
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
  let admissionPhase = "start";
  try {
    return await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      admissionPhase = "transaction setup";
      await connection.execute(
        sql`SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '15s'`,
      );
      const [epoch] = await connection.execute(
        sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
      );
      if (!epoch)
        throw new RemoteProgressiveAdmissionWait(
          "No current campaign calculation epoch",
        );
      const [state] = await connection.execute(sql`
        SELECT enabled, admission_fence_active, disk_admission_blocked FROM sweeper_state WHERE id = 1
      `);
      const [settings] = await connection.execute(sql`
        SELECT enabled, remote_solver_enabled, upstream_base_url
        FROM sync_api_settings WHERE id = 1
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
        capacity -
        (await progressiveRemoteAdmissionReservedSlots(connection, solverId));
      if (!Number.isSafeInteger(available) || available < 1)
        throw new RemoteProgressiveAdmissionWait(
          "The worker has no unreserved CPU slots",
        );
      const [admissionGate] = await connection.execute(sql`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended('progressive-cfd-admission', 0)
        ) AS acquired
      `);
      if (!admissionGate?.acquired)
        throw new RemoteProgressiveAdmissionWait(
          "Progressive admission is busy with another campaign maintenance pass",
        );
      admissionPhase = "claim";
      const leases = await claimProgressiveCfdBatch(connection, {
        owner: `remote-progressive-${solverId}`,
        remoteSolverId: solverId,
        leaseSeconds: PROGRESSIVE_REMOTE_START_LEASE_SECONDS,
        requireSweeperEnabled: true,
        solverBudgetVersion: 2,
        localTimeStepVersion: capabilities.localTimeStepVersion,
        allowPhysicalTime:
          capabilities.uransRecoveryVersion ===
          REQUIRED_PRECALC_EVIDENCE_RECOVERY_VERSION,
        campaignLockMode: "skip",
      });
      if (!leases.length)
        throw new RemoteProgressiveAdmissionWait(
          "No eligible campaign cases are ready",
        );
      admissionPhase = "compose";
      const composed = await composeProgressiveCfdJob(connection, leases, {
        cpuSlots: available,
        meshRecoveryVersion: capabilities.meshRecoveryVersion,
        uransRecoveryVersion: capabilities.uransRecoveryVersion,
        solverBudgetVersion: 2,
        localTimeStepVersion: capabilities.localTimeStepVersion,
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
        VALUES (${promiseId}::uuid, NULL, ${solver.instance_id}, ${solver.instance_name}, ${settings.upstream_base_url},
          ${job.airfoil_id}::uuid, ${job.simulation_preset_revision_id}::uuid, ${leases.length}, clock_timestamp() + interval '1 hour',
          ${JSON.stringify({ solverId, progressiveExecutionId: composed.jobId, executionContract: "progressive-cfd-v1" })}::jsonb)
      `);
      for (const lease of leases)
        await connection.execute(sql`
          INSERT INTO sync_sweep_promise_points (promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg)
          VALUES (${promiseId}::uuid, ${job.airfoil_id}::uuid, ${job.simulation_preset_revision_id}::uuid, ${lease.alpha})
        `);
      admissionPhase = "bind";
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
    if (
      ["55P03", "57014"].includes(String((error as { code?: unknown }).code)) ||
      (error instanceof Error && /lock timeout/i.test(error.message))
    )
      return {
        kind: "waiting",
        reason: `Campaign admission is waiting for a short-lived database lock during ${admissionPhase}`,
      };
    throw error;
  }
}

function remoteAdmissionsPerTick(
  raw = process.env.SWEEPER_REMOTE_MAX_ADMISSIONS_PER_TICK,
): number {
  if (raw == null || raw.trim() === "") return 64;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 64;
  return Math.min(parsed, 64);
}

async function prepareProgressiveRemoteFleetRun(db: DB) {
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
  console.log(
    JSON.stringify({
      component: "progressive-remote-admission-cycle",
      solvers: solvers.length,
    }),
  );
  const receipt = {
    prepared: 0,
    deferred: 0,
    waiting: 0,
    waitingReasons: [] as Array<{ solverId: string; reason: string }>,
    errors: [] as Array<{ solverId: string; reason: string }>,
  };
  const unappliedReports = await db.execute(sql`
    SELECT report.sim_job_id, report.sequence
    FROM progressive_remote_reports report
    LEFT JOIN progressive_remote_progress_receipts receipt
      ON receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence
    LEFT JOIN progressive_remote_report_inventories inventory
      ON inventory.sim_job_id = report.sim_job_id AND inventory.sequence = report.sequence
    WHERE receipt.sim_job_id IS NULL OR inventory.sim_job_id IS NULL
    ORDER BY report.received_at, report.sim_job_id, report.sequence
    LIMIT ${PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT}
  `);
  if (unappliedReports.length >= PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT) {
    for (const solver of solvers) {
      receipt.waiting += 1;
      receipt.waitingReasons.push({
        solverId: String(solver.id),
        reason:
          "Remote report reconciliation backlog is throttling new admissions",
      });
    }
    return receipt;
  }
  const maxAdmissionsPerTick = remoteAdmissionsPerTick();
  for (const solver of solvers) {
    const solverId = String(solver.id);
    const capacity = Number(solver.capacity);
    if (!Number.isSafeInteger(capacity) || capacity < 1) continue;
    for (
      let admitted = 0;
      admitted < Math.min(capacity, maxAdmissionsPerTick);
      admitted += 1
    ) {
      try {
        const result = await prepareProgressiveRemoteDispatch(db, solverId);
        if (result.kind === "waiting" && result.deferredUnits !== undefined) {
          receipt.deferred += result.deferredUnits;
          if (!result.deferredUnits) {
            receipt.waiting += 1;
            receipt.waitingReasons.push({
              solverId,
              reason:
                "Remote claim lost all exact result-cell ownership during dispatch binding",
            });
            break;
          }
          continue;
        }
        if (result.kind === "waiting") {
          receipt.waiting += 1;
          receipt.waitingReasons.push({ solverId, reason: result.reason });
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
  const cleanedHubPayloads = await clearHubWorkerPayloadFields(db);
  if (cleanedHubPayloads)
    console.log(
      JSON.stringify({
        component: "progressive-hub-dispatch-cleanup",
        cleaned: cleanedHubPayloads,
      }),
    );
  console.log(
    JSON.stringify({
      component: "progressive-remote-admission-cycle-result",
      prepared: receipt.prepared,
      deferred: receipt.deferred,
      waiting: receipt.waiting,
      waitingReasons: receipt.waitingReasons.slice(0, 4),
      errors: receipt.errors.length,
    }),
  );
  return receipt;
}

const pendingProgressiveRemoteFleets = new WeakMap<
  DB,
  ReturnType<typeof prepareProgressiveRemoteFleetRun>
>();

export function prepareProgressiveRemoteFleet(
  db: DB,
): ReturnType<typeof prepareProgressiveRemoteFleetRun> {
  const existing = pendingProgressiveRemoteFleets.get(db);
  if (existing) return existing;
  const operation = prepareProgressiveRemoteFleetRun(db);
  pendingProgressiveRemoteFleets.set(db, operation);
  const clear = () => {
    if (pendingProgressiveRemoteFleets.get(db) === operation)
      pendingProgressiveRemoteFleets.delete(db);
  };
  void operation.then(clear, clear);
  return operation;
}
