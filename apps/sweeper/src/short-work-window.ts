import { progressiveSolverIsTransient } from "@aerodb/core";
import { progressiveRemoteExecutionSolverFamily } from "./progressive-remote-jobs";
import {
  progressiveSolverProcessesForStage,
  progressivePreciseCaseConcurrency,
} from "./progressive-cfd-jobs";
import { observedProgressiveRemoteCapabilities } from "./progressive-remote-capabilities";
import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import {
  analysisContentHash,
  canonicalAnalysisJson,
} from "@aerodb/db/analysis-target";
import {
  progressiveCfdBatchMaximum,
  progressiveCfdUnitRecipeSql,
  type ProgressiveCfdLease,
} from "@aerodb/db/progressive-cfd";
import { progressiveCfdEffectiveBudgetSql } from "@aerodb/db/progressive-cfd-budget-extension";
import { effectiveProgressiveStageSql } from "@aerodb/db/progressive-execution-policy";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import { engineIdentityForSetup } from "./build-request";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const HOUR = 3600;

export interface ShortWorkSelection {
  solverId: string;
  workId: string;
  pool: string;
  slots?: number;
  maxActiveSeconds: number;
}

interface ShortWorkUnit {
  id: string;
  alpha: number;
  seconds: number;
  attempts: number;
}

export interface ShortWorkPlan extends ShortWorkSelection {
  workerInstanceId: string;
  credentialVersion: number;
  workerBuild: string | null;
  slots: number;
  /** Null preserves a request that uses the native solver-process default. */
  solverProcesses: number | null;
  generationId: string;
  targetId: string;
  stage: number;
  recipeId: string;
  revisionId: string;
  parentId: string | null;
  units: ShortWorkUnit[];
}

function hubOperator() {
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "hub")
    throw new Error(
      "A registered short-work preference requires the configured hub role",
    );
}

function validateSelection(s: ShortWorkSelection) {
  if (
    typeof s.solverId !== "string" ||
    !UUID.test(s.solverId) ||
    typeof s.workId !== "string" ||
    !UUID.test(s.workId) ||
    !/^[a-zA-Z0-9._-]{1,128}$/.test(s.pool) ||
    (s.slots !== undefined &&
      (!Number.isSafeInteger(s.slots) || s.slots < 1)) ||
    !Number.isSafeInteger(s.maxActiveSeconds) ||
    s.maxActiveSeconds < 1 ||
    s.maxActiveSeconds > HOUR
  )
    throw new Error(
      "Invalid registered solver, work, pool, slot count or one-hour active-solver budget",
    );
  return {
    ...s,
    solverId: s.solverId.toLowerCase(),
    workId: s.workId.toLowerCase(),
  };
}

/** Inventory only. The normal claimant rechecks campaign priority, every unit,
 * recovery ownership and the complete resulting batch before an offer can commit. */
export async function previewShortWork(
  db: DB,
  selection: ShortWorkSelection,
): Promise<ShortWorkPlan | null> {
  hubOperator();
  selection = validateSelection(selection);
  const rows = await db.execute(sql`
    SELECT unit.id, unit.aoa_deg, unit.attempts, unit.state, unit.retry_after IS NULL OR unit.retry_after <= clock_timestamp() AS due,
      ${progressiveCfdEffectiveBudgetSql(sql`unit`)} - unit.active_seconds AS seconds,
      EXISTS (SELECT FROM progressive_cfd_budget_extensions x WHERE x.unit_id=unit.id AND x.state='pending') AS extension,
      ${progressiveCfdUnitRecipeSql()} AS recipe, work.stage, work.target_id, work.generation_id, scope.revision_id, target.airfoil_id,
      (SELECT plan.parent_job_id FROM progressive_cfd_recovery_plans plan WHERE plan.unit_id=unit.id ORDER BY plan.ordinal DESC LIMIT 1) AS parent_id
    FROM progressive_work work JOIN progressive_cfd_units unit ON unit.work_id=work.id
    JOIN progressive_generations generation ON generation.id=work.generation_id
    JOIN progressive_generation_targets scope ON scope.generation_id=generation.id AND scope.target_id=work.target_id
    JOIN calculation_epochs epoch ON epoch.id=generation.epoch_id AND epoch.current
    JOIN sim_campaigns campaign ON campaign.id=generation.campaign_id AND campaign.current_plan_revision_id=generation.plan_revision_id
    JOIN polar_analysis_targets target ON target.id=work.target_id
    WHERE work.id=${selection.workId}::uuid AND work.state='pending' AND unit.state IN ('pending','leased')
      AND campaign.status IN ('active','attention') AND generation.status='active' AND target.mach>0 AND target.mach<1
      AND work.stage IN (2,3) AND work.stage=${effectiveProgressiveStageSql()}
      AND (NOT generation.benchmark_only OR work.stage=2)
    ORDER BY unit.aoa_deg, unit.id LIMIT 65
  `);
  const first = rows[0];
  if (!first || rows.length > progressiveCfdBatchMaximum(Number(first.stage)))
    return null;
  const recipeId = analysisContentHash({
    sourceRevisionId: first.revision_id,
    recipe: first.recipe,
  });
  const units: ShortWorkUnit[] = [];
  let total = 0;
  for (const row of rows) {
    const seconds = Number(row.seconds);
    if (
      row.state !== "pending" ||
      !row.due ||
      row.extension ||
      row.parent_id !== first.parent_id ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      analysisContentHash({
        sourceRevisionId: row.revision_id,
        recipe: row.recipe,
      }) !== recipeId
    )
      return null;
    total += seconds;
    units.push({
      id: String(row.id),
      alpha: Number(row.aoa_deg),
      seconds,
      attempts: Number(row.attempts),
    });
  }
  if (total > selection.maxActiveSeconds) return null;
  const [bound] = await db.execute(sql`
    SELECT recipe.execution_revision_id, revision.snapshot, solver.instance_id,solver.credential_version,solver.build_version, least(solver.cpu_capacity,
      CASE WHEN solver.cpu_budget>0 THEN solver.cpu_budget ELSE solver.cpu_capacity END)::int AS capacity,
      jsonb_build_object('progressiveExecution',solver.metadata->'progressiveExecution',
        'progressiveExecutionObservedAt',solver.metadata->'progressiveExecutionObservedAt') AS metadata, clock_timestamp() AS checked_at
    FROM progressive_cfd_execution_recipes recipe JOIN simulation_preset_revisions revision ON revision.id=recipe.execution_revision_id
    JOIN registered_remote_solvers solver ON solver.id=${selection.solverId}::uuid AND solver.revoked_at IS NULL
      AND solver.credential_version>0 AND solver.auth_token_hash IS NOT NULL AND solver.last_heartbeat_at > clock_timestamp()-interval '2 minutes'
      AND (solver.metadata#>'{progressiveExecution,executionPools}') ? ${selection.pool}
    JOIN sync_api_settings cfg ON cfg.id=1 AND cfg.enabled AND NOT cfg.remote_solver_enabled
    WHERE NOT EXISTS (SELECT FROM sync_sweep_promise_points point WHERE point.status='active' AND point.airfoil_id=${first.airfoil_id}::uuid
        AND point.simulation_preset_revision_id=recipe.execution_revision_id
        AND point.aoa_deg=ANY(ARRAY[${sql.join(
          units.map((u) => sql`${u.alpha}::double precision`),
          sql`,`,
        )}]))
      AND (${first.parent_id ?? null}::uuid IS NULL OR EXISTS (
        SELECT FROM sim_jobs parent LEFT JOIN progressive_remote_dispatches d ON d.sim_job_id=parent.id
        JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id=parent.id AND stopped.engine_job_id=parent.engine_job_id
        WHERE parent.id=${first.parent_id ?? null}::uuid AND parent.status IN ('done','failed','cancelled')
          AND (d.solver_id=${selection.solverId}::uuid OR (d.sim_job_id IS NULL AND parent.engine_job_id=parent.id::text))))
      AND recipe.id=${recipeId} AND recipe.source_revision_id=${first.revision_id}::uuid AND recipe.recipe=${JSON.stringify(first.recipe)}::jsonb
      AND (SELECT array_agg(p.routing_key ORDER BY p.id) FROM solver_execution_pools p WHERE p.enabled
        AND p.solver_implementation_id=(revision.snapshot#>>'{engine,implementationId}')::uuid)=ARRAY[${selection.pool}]::text[]
  `);
  if (!bound) return null;
  const setup = bound.snapshot as SimulationSetupSnapshot;
  const stage = Number(first.stage) as 2 | 3;
  const family = setup.solver.flowSolverFamily;
  const capacity = Number(bound.capacity);
  if (!family || !Number.isSafeInteger(capacity) || capacity < 1) return null;
  const executionFamily = progressiveRemoteExecutionSolverFamily(stage, family);
  const transient = progressiveSolverIsTransient(
    executionFamily,
    executionFamily === family ? setup.solver.timeCoordinate : undefined,
  );
  const ranks = progressiveSolverProcessesForStage(
    stage,
    transient,
    capacity,
    setup.scheduling.solverProcesses,
  );
  if (
    (ranks ?? 1) > capacity ||
    (selection.slots !== undefined && (ranks ?? 1) !== selection.slots) ||
    (stage === 3 &&
      transient &&
      setup.scheduling.solverProcesses == null &&
      ranks != null &&
      progressivePreciseCaseConcurrency(capacity, ranks) !== 1)
  )
    return null;
  const capability = observedProgressiveRemoteCapabilities(
    bound.metadata,
    new Date(String(bound.checked_at)),
  );
  if (
    !capability ||
    !capability.executionPools.includes(selection.pool) ||
    canonicalAnalysisJson(capability.engine) !==
      canonicalAnalysisJson(engineIdentityForSetup(setup))
  )
    return null;
  return {
    solverId: selection.solverId,
    workId: selection.workId,
    pool: selection.pool,
    workerInstanceId: String(bound.instance_id),
    credentialVersion: Number(bound.credential_version),
    workerBuild:
      bound.build_version == null ? null : String(bound.build_version),
    slots: ranks ?? 1,
    solverProcesses: ranks,
    maxActiveSeconds: selection.maxActiveSeconds,
    generationId: String(first.generation_id),
    targetId: String(first.target_id),
    stage: Number(first.stage),
    recipeId,
    revisionId: String(bound.execution_revision_id),
    parentId: first.parent_id == null ? null : String(first.parent_id),
    units,
  };
}

export async function enableShortWork(
  db: DB,
  selection: ShortWorkSelection,
  digest: string,
  until: Date,
) {
  hubOperator();
  if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isFinite(until.getTime()))
    throw new Error("Invalid short-work preview digest or deadline");
  return db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    selection = validateSelection(selection);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('short-work:' || ${selection.solverId}::text,0))`,
    );
    await tx.execute(sql`UPDATE registered_short_work_windows SET ended_at=clock_timestamp()
      WHERE solver_id=${selection.solverId}::uuid AND ended_at IS NULL AND expires_at<=clock_timestamp()
        AND EXISTS (SELECT FROM sync_api_settings cfg WHERE cfg.id=1 AND NOT cfg.remote_solver_enabled)`);
    const prior = await shortWorkStatus(tx, selection.solverId);
    if (
      prior?.plan_sha256 === digest &&
      new Date(prior.expires_at as Date | string).getTime() === until.getTime()
    )
      return prior;
    if (prior && !prior.ended_at && prior.current) {
      throw new Error(
        "The registered worker already has an active short-work window",
      );
    }
    const plan = await previewShortWork(tx, selection);
    if (!plan || analysisContentHash(plan) !== digest)
      throw new Error(
        "The complete short-work preview changed or is unavailable",
      );
    const [row] = await tx.execute(sql`INSERT INTO registered_short_work_windows
      (id,solver_id,work_id,plan,plan_sha256,opened_at,expires_at)
      SELECT gen_random_uuid(),${selection.solverId}::uuid,${selection.workId}::uuid,${JSON.stringify(plan)}::jsonb,${digest},now,${until.toISOString()}::timestamptz
      FROM (SELECT clock_timestamp() AS now) clock WHERE ${until.toISOString()}::timestamptz>now AND ${until.toISOString()}::timestamptz <= now+interval '1 hour'
        AND EXISTS (SELECT FROM sync_api_settings cfg JOIN registered_remote_solvers solver ON solver.id=${plan.solverId}::uuid
          WHERE cfg.id=1 AND cfg.enabled AND NOT cfg.remote_solver_enabled AND solver.revoked_at IS NULL
            AND solver.credential_version=${plan.credentialVersion} AND solver.instance_id=${plan.workerInstanceId})
      RETURNING id,solver_id,work_id,plan_sha256,opened_at,expires_at,issued_job_id,ended_at`);
    if (!row)
      throw new Error(
        "The hub registration must still match and the absolute deadline must be in the next hour",
      );
    return row;
  });
}

export async function shortWorkStatus(db: DB, solverId: string) {
  hubOperator();
  if (!UUID.test(solverId)) throw new Error("Invalid registered solver");
  const [row] =
    await db.execute(sql`SELECT id,solver_id,work_id,plan_sha256,opened_at,expires_at,issued_job_id,issued_at,ended_at,
    ended_at IS NULL AND expires_at>clock_timestamp() AS current FROM registered_short_work_windows
    WHERE solver_id=${solverId}::uuid ORDER BY opened_at DESC,id LIMIT 1`);
  return row ?? null;
}

export async function endShortWork(db: DB, solverId: string, windowId: string) {
  hubOperator();
  if (!UUID.test(solverId) || !UUID.test(windowId))
    throw new Error("Invalid solver or window identity");
  const [row] =
    await db.execute(sql`UPDATE registered_short_work_windows w SET ended_at=coalesce(ended_at,clock_timestamp())
    FROM sync_api_settings cfg WHERE cfg.id=1 AND NOT cfg.remote_solver_enabled
      AND w.id=${windowId}::uuid AND w.solver_id=${solverId}::uuid RETURNING w.id,w.ended_at,w.issued_job_id`);
  if (!row) throw new Error("No matching hub-owned admission window");
  return row;
}

export function matchesShortWork(
  plan: ShortWorkPlan,
  leases: ProgressiveCfdLease[],
): boolean {
  return (
    plan.units.length === leases.length &&
    leases.every((lease, i) => {
      const unit = plan.units[i]!;
      return (
        lease.workId === plan.workId &&
        lease.generationId === plan.generationId &&
        lease.targetId === plan.targetId &&
        lease.stage === plan.stage &&
        lease.id === unit.id &&
        lease.alpha === unit.alpha &&
        lease.remainingActiveSeconds === unit.seconds &&
        !lease.budgetExtension &&
        (lease.recoveryParentJobId ?? null) === plan.parentId &&
        analysisContentHash({
          sourceRevisionId: lease.revisionId,
          recipe: lease.recipe,
        }) === plan.recipeId
      );
    })
  );
}

type WindowChoice =
  | { kind: "normal"; headroom?: number }
  | { kind: "wait"; reason: string }
  | { kind: "prefer"; windowId: string; plan: ShortWorkPlan; headroom: number };

export class RetryOrdinaryDispatch extends Error {
  constructor(readonly windowId: string) {
    super("The pinned whole batch is no longer available");
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function observedHeadroom(metadata: unknown, checkedAt: Date): number | null {
  if (!object(metadata) || !object(metadata.health)) return null;
  const health = metadata.health;
  if (
    typeof health.sampledAt !== "string" ||
    !object(health.execution) ||
    !object(health.storage) ||
    typeof health.storage.admissionBlocked !== "boolean"
  )
    return null;
  const age = checkedAt.getTime() - Date.parse(health.sampledAt);
  const { capacityCpuSlots: capacity, reservedCpuSlots: occupied } =
    health.execution;
  if (
    !Number.isFinite(age) ||
    age < -30_000 ||
    age >= 60_000 ||
    typeof capacity !== "number" ||
    typeof occupied !== "number" ||
    !Number.isSafeInteger(capacity) ||
    !Number.isSafeInteger(occupied) ||
    occupied < 0 ||
    capacity < 1 ||
    occupied > capacity
  )
    return null;
  return health.storage.admissionBlocked ? 0 : capacity - occupied;
}

export async function chooseShortWork(
  db: DB,
  solverId: string,
  windowId: string,
  available: number,
  metadata: unknown,
  checkedAt: Date,
  skipId?: string,
): Promise<WindowChoice> {
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "hub")
    return { kind: "normal" };
  const [w] =
    await db.execute(sql`SELECT id,work_id,plan,plan_sha256,issued_job_id FROM registered_short_work_windows
    WHERE id=${windowId}::uuid AND solver_id=${solverId}::uuid AND ended_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`);
  if (!w) return { kind: "normal" };
  // An offer needs actual, fresh worker headroom. An observation is never a
  // permit. The registered /start and both local CPU reservations still follow.
  const normal = { kind: "normal" } as const;
  const [outstanding] = await db.execute(sql`SELECT EXISTS (
    SELECT FROM progressive_remote_dispatches d JOIN sync_sweep_promises p ON p.id=d.promise_id AND p.registered_solver_id=d.solver_id
    JOIN sim_jobs j ON j.id=d.sim_job_id
    WHERE d.solver_id=${solverId}::uuid AND p.status='active' AND p."expiresAt">clock_timestamp()
      AND j.status='pending' AND j.engine_job_id IS NULL
      AND NOT EXISTS (SELECT FROM progressive_cfd_execution_stops s WHERE s.sim_job_id=d.sim_job_id AND s.engine_job_id=d.sim_job_id::text)
      AND EXISTS (SELECT FROM progressive_cfd_attempts a JOIN progressive_cfd_units u ON u.id=a.unit_id AND u.lease_token=a.token
        WHERE a.sim_job_id=d.sim_job_id AND a.outcome='running' AND u.state='leased' AND u.lease_until>clock_timestamp())
      AND coalesce((SELECT r.report#>>'{status,state}' FROM progressive_remote_reports r WHERE r.sim_job_id=d.sim_job_id
        ORDER BY r.sequence DESC LIMIT 1),'pending')='pending'
  ) AS pending`);
  if (outstanding?.pending)
    return {
      kind: "wait",
      reason: "A live registered assignment is awaiting its worker start",
    };
  const reportedFree = observedHeadroom(metadata, checkedAt);
  if (reportedFree === null) return normal;
  const headroom = Math.min(available, reportedFree);
  if (headroom <= 0)
    return {
      kind: "wait",
      reason: "The registered worker reports no vacant CPU slots",
    };
  // A consumed window cannot issue another job, including after refusal,
  // cancellation, case-lease expiry or a sweeper restart.
  if (w.issued_job_id != null || skipId === windowId)
    return { kind: "normal", headroom };
  const plan = w.plan as ShortWorkPlan;
  if (
    !plan ||
    analysisContentHash(plan) !== w.plan_sha256 ||
    plan.solverId !== solverId ||
    plan.workId !== w.work_id
  )
    throw new Error(
      "The registered short-work window has an invalid plan binding",
    );
  if (headroom < plan.slots) return { kind: "normal", headroom };
  const observed = await previewShortWork(db, {
    solverId,
    workId: plan.workId,
    pool: plan.pool,
    slots: plan.slots,
    maxActiveSeconds: plan.maxActiveSeconds,
  });
  if (!observed || analysisContentHash(observed) !== w.plan_sha256)
    return { kind: "normal", headroom };
  return { kind: "prefer", windowId, plan: observed, headroom };
}

/** A new retry, newly initialized angle or foreign in-flight member can race the
 * read-only preview. Recheck the entire live target under the claimant's locks. */
export async function shortWorkStillOwnsWholeGroup(
  db: DB,
  plan: ShortWorkPlan,
  leases: ProgressiveCfdLease[],
) {
  const pinned = sql.join(
    leases.map(
      (l, i) =>
        sql`(${l.id}::uuid,${l.token}::uuid,${plan.units[i]!.attempts + 1}::int)`,
    ),
    sql`,`,
  );
  const [row] =
    await db.execute(sql`WITH pinned(id,token,attempts) AS (VALUES ${pinned})
    SELECT count(*)=${plan.units.length}::int AND bool_and(p.id IS NOT NULL AND u.state='leased' AND u.lease_until>clock_timestamp()) AS exact
    FROM progressive_cfd_units u LEFT JOIN pinned p ON p.id=u.id AND p.token=u.lease_token AND p.attempts=u.attempts
    WHERE u.work_id=${plan.workId}::uuid AND u.state IN ('pending','leased')`);
  return row?.exact === true;
}

export async function recordShortWorkOffer(
  db: DB,
  windowId: string,
  jobId: string,
) {
  const [row] =
    await db.execute(sql`WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS at)
    UPDATE registered_short_work_windows SET issued_job_id=${jobId}::uuid,issued_at=tick.at FROM tick
    WHERE id=${windowId}::uuid AND issued_job_id IS NULL AND ended_at IS NULL AND expires_at>tick.at
      AND EXISTS (SELECT FROM progressive_remote_dispatches d JOIN registered_remote_solvers solver ON solver.id=d.solver_id
        WHERE d.sim_job_id=${jobId}::uuid AND solver.id=registered_short_work_windows.solver_id AND solver.revoked_at IS NULL
          AND solver.instance_id=(plan->>'workerInstanceId') AND solver.credential_version::text=(plan->>'credentialVersion')
          AND solver.build_version IS NOT DISTINCT FROM (plan->>'workerBuild')) RETURNING id`);
  if (!row) throw new RetryOrdinaryDispatch(windowId);
}
