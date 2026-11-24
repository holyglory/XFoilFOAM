import {
  chooseShortWork,
  matchesShortWork,
  recordShortWorkOffer,
  shortWorkStillOwnsWholeGroup,
  RetryOrdinaryDispatch,
} from "./short-work-window";
import { progressiveAdmissionReportPressureSql } from "./progressive-progress-selection";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import {
  bindProgressiveRemoteDispatch,
  canonicalAnalysisJson,
  claimProgressiveCfdBatch,
  clearHubWorkerPayloadFields,
  progressiveRemoteAdmissionReservedSlots,
  progressiveRemoteAdmissionReservedSlotsSql,
  progressiveRemoteActivePromiseCount,
  PROGRESSIVE_REMOTE_START_LEASE_SECONDS,
  ProgressiveCfdAdmissionBusy,
  type DB,
  type ProgressiveCfdLease,
  type ProgressiveRemoteExecutionEnvelope,
} from "@aerodb/db";
import { observedProgressiveRemoteCapabilities } from "./progressive-remote-capabilities";
export {
  parseProgressiveRemoteCapabilities,
  type ProgressiveRemoteCapabilities,
} from "./progressive-remote-capabilities";
import { composeProgressiveCfdJob } from "./progressive-cfd-jobs";
import {
  deferProgressiveClaim,
  ProgressiveEvidenceCellOwned,
} from "./progressive-claim-deferral";
import { REQUIRED_PRECALC_EVIDENCE_RECOVERY_VERSION } from "./build-request";
import { retireSettledProgressivePromise } from "./progressive-remote-lease-retirement";

const PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT = 2_000;
const NO_UNRESERVED_CPU_SLOTS = "The worker has no unreserved CPU slots";

class RemoteProgressiveAdmissionWait extends Error {}

function admissionDatabaseFailure(error: unknown) {
  let cause = error;
  for (let depth = 0; depth < 4 && cause && typeof cause === "object"; depth++) {
    const detail = cause as { code?: unknown; message?: unknown; cause?: unknown };
    const message = typeof detail.message === "string" ? detail.message : "";
    switch (detail.code) {
      case "55P03":
        return { sqlstate: detail.code, reason: /lock timeout/i.test(message) ? "lock_timeout" : "lock_not_available" } as const;
      case "40P01":
        return { sqlstate: detail.code, reason: "deadlock" } as const;
      case "57014":
        if (/due to statement timeout/i.test(message)) return { sqlstate: detail.code, reason: "statement_timeout" } as const;
        if (/due to user request/i.test(message)) return { sqlstate: detail.code, reason: "user_cancellation" } as const;
        return { sqlstate: detail.code, reason: "query_cancellation" } as const;
    }
    if (!detail.cause && !detail.code && /lock timeout/i.test(message))
      return { sqlstate: null, reason: "lock_timeout" } as const;
    cause = detail.cause;
  }
}

const admissionDatabaseMessages = {
  lock_timeout: "timed out waiting for a database lock",
  lock_not_available: "could not acquire a database lock",
  deadlock: "was rolled back by PostgreSQL after a deadlock",
  statement_timeout: "reached its SQL statement deadline",
  user_cancellation: "was cancelled by request",
  query_cancellation: "was cancelled by PostgreSQL",
} as const;

function isActivePromisePointConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === "23505" &&
    candidate.constraint === "sync_sweep_promise_points_active_uq"
  );
}

function exactAdmissionAngles(leases: readonly ProgressiveCfdLease[]) {
  return sql`ARRAY[${sql.join(
    leases.map((lease) => sql`${lease.alpha}::double precision`),
    sql`, `,
  )}]::double precision[]`;
}

async function retireSettledAdmissionOwners(
  db: DB,
  input: {
    airfoilId: string;
    simulationPresetRevisionId: string;
    leases: readonly ProgressiveCfdLease[];
  },
) {
  const owners = await db.execute(sql`
    SELECT DISTINCT dispatch.sim_job_id
    FROM sync_sweep_promise_points point
    JOIN sync_sweep_promises promise ON promise.id = point.promise_id
    JOIN progressive_remote_dispatches dispatch ON dispatch.promise_id = promise.id
    JOIN sim_jobs job ON job.id = dispatch.sim_job_id
    JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id = job.id
      AND stopped.engine_job_id = job.engine_job_id
    WHERE point.status = 'active'
      AND promise.status IN ('active', 'expired', 'cancelled')
      AND job.status IN ('done', 'failed', 'cancelled')
      AND (job."ingestedAt" IS NOT NULL OR job.status = 'cancelled')
      AND point.airfoil_id = ${input.airfoilId}::uuid
      AND point.simulation_preset_revision_id = ${input.simulationPresetRevisionId}::uuid
      AND point.aoa_deg = ANY(${exactAdmissionAngles(input.leases)})
    ORDER BY dispatch.sim_job_id
  `);
  for (const owner of owners)
    await retireSettledProgressivePromise(db, String(owner.sim_job_id));
}

async function findAdmissionCellConflicts(
  db: DB,
  input: {
    airfoilId: string;
    simulationPresetRevisionId: string;
    leases: readonly ProgressiveCfdLease[];
  },
) {
  return db.execute(sql`
    SELECT point.aoa_deg
    FROM sync_sweep_promise_points point
    JOIN sync_sweep_promises promise ON promise.id = point.promise_id
    WHERE point.status = 'active'
      AND point.airfoil_id = ${input.airfoilId}::uuid
      AND point.simulation_preset_revision_id = ${input.simulationPresetRevisionId}::uuid
      AND point.aoa_deg = ANY(${exactAdmissionAngles(input.leases)})
    ORDER BY point.aoa_deg
    FOR UPDATE OF point, promise
  `);
}

type RemoteDispatchOutcome =
  | { kind: "prepared"; envelope: ProgressiveRemoteExecutionEnvelope }
  | { kind: "waiting"; reason: string; deferredUnits?: number; retryableContention?: true };

export async function prepareProgressiveRemoteDispatch(
  db: DB,
  solverId: string,
): Promise<RemoteDispatchOutcome> {
  try {
    return await prepareRemoteDispatch(db, solverId);
  } catch (error) {
    if (!(error instanceof RetryOrdinaryDispatch)) throw error;
    // The preferred transaction rolled back every unit, job and promise.
    // Resume ordinary selection once with fresh capacity and authority checks.
    return prepareRemoteDispatch(db, solverId, error.windowId);
  }
}

async function prepareRemoteDispatch(
  db: DB,
  solverId: string,
  skipWindowId?: string,
): Promise<RemoteDispatchOutcome> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      solverId,
    )
  )
    throw new Error(
      "Remote admission requires an exact registered solver identity",
    );
  let admissionPhase = "start";
  let lockMode: "skip" | "wait" | undefined;
  let backendPid: number | undefined;
  const started = performance.now();
  let claimedLeases: ProgressiveCfdLease[] = [];
  let attemptedWindow: string | undefined;
  try {
    return await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      admissionPhase = "transaction setup";
      await connection.execute(
        sql`SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '15s'; SET LOCAL jit = off`,
      );
      const [epoch] = await connection.execute(
        sql`SELECT id, pg_backend_pid() AS backend_pid FROM calculation_epochs WHERE current FOR SHARE`,
      );
      if (epoch && typeof epoch.backend_pid === "number") backendPid = epoch.backend_pid;
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
        SELECT id, instance_id, instance_name, public_endpoint, cpu_capacity, cpu_budget, max_active_polar_promises, metadata, clock_timestamp() AS checked_at,
          (SELECT w.id FROM registered_short_work_windows w WHERE w.solver_id=registered_remote_solvers.id
            AND w.ended_at IS NULL AND w.expires_at>clock_timestamp()) AS short_window_id
        FROM registered_remote_solvers WHERE id = ${solverId}::uuid AND revoked_at IS NULL
          AND auth_token_hash IS NOT NULL AND credential_version > 0
          AND last_heartbeat_at > clock_timestamp() - interval '2 minutes'
      `);
      if (!solver)
        throw new RemoteProgressiveAdmissionWait(
          "The registered worker has no recent authenticated heartbeat",
        );
      const capabilities = observedProgressiveRemoteCapabilities(
        solver.metadata,
        new Date(String(solver.checked_at)),
      );
      if (!capabilities)
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
        throw new RemoteProgressiveAdmissionWait(NO_UNRESERVED_CPU_SLOTS);
      if (solver.short_window_id) {
        // A scoped offer still serializes its selection with ordinary admission.
        const [admissionGate] = await connection.execute(sql`SELECT pg_try_advisory_xact_lock(
          hashtextextended('progressive-cfd-admission', 0)
        ) AS acquired`);
        if (!admissionGate?.acquired) throw new ProgressiveCfdAdmissionBusy(
          "Progressive admission is busy with another campaign maintenance pass",
        );
      }
      admissionPhase = "claim";
      const choice = solver.short_window_id
        ? await chooseShortWork(
            connection,
            solverId,
            String(solver.short_window_id),
            available,
            solver.metadata,
            new Date(String(solver.checked_at)),
            skipWindowId,
          )
        : ({ kind: "normal" } as const);
      if (choice.kind === "wait")
        throw new RemoteProgressiveAdmissionWait(choice.reason);
      if (choice.kind === "prefer") attemptedWindow = choice.windowId;
      const claimInput = {
        ...(choice.kind === "prefer"
          ? { preferredWorkId: choice.plan.workId }
          : {}),
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
        acquireAdmissionAfterCampaign: !solver.short_window_id,
      } as const;
      lockMode = "skip";
      let leases = await claimProgressiveCfdBatch(connection, claimInput);
      if (!leases.length) {
        // Keep the transaction's 10s lock bound: normal scoped settlement can
        // hold the campaign mutex longer than a subsecond fallback would allow.
        lockMode = "wait";
        leases = await claimProgressiveCfdBatch(connection, {
          ...claimInput,
          campaignLockMode: "wait",
        });
      }
      // An empty SKIP LOCKED read may only mean the winning campaign is
      // settling another job. Give this same preference the ordinary bounded
      // campaign-lock wait before deciding that the complete group changed.
      if (
        choice.kind === "prefer" &&
        (!matchesShortWork(choice.plan, leases) ||
          !(await shortWorkStillOwnsWholeGroup(
            connection,
            choice.plan,
            leases,
          )))
      )
        throw new RetryOrdinaryDispatch(choice.windowId);
      if (!leases.length)
        throw new RemoteProgressiveAdmissionWait(
          "No eligible campaign cases are ready",
        );
      claimedLeases = leases;
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
        SELECT airfoil_id, simulation_preset_revision_id, admission_cpu_slots FROM sim_jobs WHERE id = ${composed.jobId}::uuid
      `);
      if (
        "headroom" in choice &&
        choice.headroom != null &&
        Number(job.admission_cpu_slots) > choice.headroom
      )
        throw new RemoteProgressiveAdmissionWait(
          "The complete request exceeds the registered worker's observed free slots",
        );
      if (
        choice.kind === "prefer" &&
        (job.simulation_preset_revision_id !== choice.plan.revisionId ||
          Number(job.admission_cpu_slots) !== choice.plan.slots ||
          (composed.request.resources?.solver_processes ?? null) !==
            choice.plan.solverProcesses ||
          composed.request.resources?.case_concurrency !== 1 ||
          composed.request.solver?.warm_start !== true ||
          composed.request.expected_execution_pool !== choice.plan.pool)
      )
        throw new RetryOrdinaryDispatch(choice.windowId);
      await retireSettledAdmissionOwners(connection, {
        airfoilId: String(job.airfoil_id),
        simulationPresetRevisionId: String(job.simulation_preset_revision_id),
        leases,
      });
      const conflicts = await findAdmissionCellConflicts(connection, {
        airfoilId: String(job.airfoil_id),
        simulationPresetRevisionId: String(job.simulation_preset_revision_id),
        leases,
      });
      if (conflicts.length) {
        const conflictingAngles = new Set(
          conflicts.map((conflict) => Number(conflict.aoa_deg)),
        );
        const conflictingLeases = leases.filter((lease) =>
          conflictingAngles.has(Number(lease.alpha)),
        );
        throw new ProgressiveEvidenceCellOwned(
          conflictingLeases.length ? conflictingLeases : leases,
        );
      }
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
      if (choice.kind === "prefer")
        await recordShortWorkOffer(connection, choice.windowId, composed.jobId);
      return { kind: "prepared" as const, envelope: bound.envelope };
    });
  } catch (error) {
    if (
      attemptedWindow &&
      (error instanceof ProgressiveEvidenceCellOwned ||
        isActivePromisePointConflict(error))
    )
      throw new RetryOrdinaryDispatch(attemptedWindow);
    if (error instanceof ProgressiveEvidenceCellOwned)
      return {
        kind: "waiting" as const,
        reason:
          "Owned result cells deferred for another preparation opportunity",
        deferredUnits: await deferProgressiveClaim(db, error),
      };
    if (isActivePromisePointConflict(error) && claimedLeases.length)
      return {
        kind: "waiting" as const,
        reason: "Exact result cells became owned during remote promise binding",
        deferredUnits: await deferProgressiveClaim(
          db,
          new ProgressiveEvidenceCellOwned(claimedLeases),
        ),
      };
    if (error instanceof ProgressiveCfdAdmissionBusy)
      return { kind: "waiting", reason: error.message, retryableContention: true };
    if (error instanceof RemoteProgressiveAdmissionWait)
      return { kind: "waiting", reason: error.message };
    const failure = admissionDatabaseFailure(error);
    if (failure) {
      // Only enumerated causes leave this boundary. Driver messages can contain
      // SQL, bound values or credentials and must never go into a fleet event.
      console.warn(JSON.stringify({
        component: "progressive-remote-admission-database-wait", solverId,
        phase: admissionPhase, claimLockMode: lockMode, postgresBackendPid: backendPid,
        elapsedMs: Math.round(performance.now() - started), ...failure,
      }));
      return {
        kind: "waiting",
        reason: `Campaign admission ${admissionDatabaseMessages[failure.reason]} during ${admissionPhase}`,
        ...(["lock_timeout", "lock_not_available", "deadlock"].includes(failure.reason)
          ? { retryableContention: true as const } : {}),
      };
    }
    throw error;
  }
}

function remoteAdmissionsPerTick(
  raw = process.env.SWEEPER_REMOTE_MAX_ADMISSIONS_PER_TICK,
): number {
  if (raw == null || raw.trim() === "") return 8;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 8;
  return Math.min(parsed, 64);
}

async function prepareProgressiveRemoteFleetRun(db: DB) {
  const cleanedHubPayloadsAfter = await clearHubWorkerPayloadFields(db);
  if (cleanedHubPayloadsAfter)
    console.log(
      JSON.stringify({
        component: "progressive-hub-dispatch-cleanup",
        cleaned: cleanedHubPayloadsAfter,
      }),
    );
  const solvers = await db.execute(sql`
    SELECT solver.id, least(solver.cpu_capacity, CASE WHEN solver.cpu_budget > 0 THEN solver.cpu_budget ELSE solver.cpu_capacity END)::integer AS capacity,
      (${progressiveRemoteAdmissionReservedSlotsSql(sql`solver.id`)}) AS reserved
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
  // A fleet with no free slots cannot admit work in this pass. Only scan
  // report history when at least one registered worker could actually claim.
  const hasCapacity = solvers.some(
    (solver) => Number(solver.capacity) > Number(solver.reserved),
  );
  const [pressure] = hasCapacity
    ? await db.execute(
        progressiveAdmissionReportPressureSql(
          PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT,
        ),
      )
    : [];
  if (pressure?.throttled === true) {
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
    if (Number(solver.reserved) >= capacity) {
      receipt.waiting += 1;
      receipt.waitingReasons.push({
        solverId,
        reason: NO_UNRESERVED_CPU_SLOTS,
      });
      continue;
    }
    let retriedContention = false;
    for (
      let admitted = 0;
      admitted < Math.min(capacity, maxAdmissionsPerTick);
      admitted += 1
    ) {
      try {
        let result = await prepareProgressiveRemoteDispatch(db, solverId);
        if (result.kind === "waiting" && result.retryableContention && !retriedContention) {
          // One fresh attempt per solver per existing fleet pass. The failed
          // transaction has released its locks, and every control and capacity
          // check runs again. Cancellation and statement timeouts do not retry.
          retriedContention = true;
          console.info(JSON.stringify({ component: "progressive-remote-admission-contention-retry",
            solverId, reason: result.reason, delayMs: 250 }));
          await delay(250);
          result = await prepareProgressiveRemoteDispatch(db, solverId);
        }
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
