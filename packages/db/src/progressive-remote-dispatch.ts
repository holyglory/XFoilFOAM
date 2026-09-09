import { sql } from "drizzle-orm";
import type { PolarRequest } from "../../engine-client/src/types";
import type { DB } from "./client";
import { canonicalAnalysisJson } from "./analysis-target";
import {
  sealProgressiveRemoteExecution,
  verifyProgressiveRemoteExecution,
  type ProgressiveRemoteExecutionEnvelope,
} from "./progressive-remote-execution";

export async function progressiveRemoteReservedSlots(
  db: DB,
  solverId: string,
): Promise<number> {
  const [row] = await db.execute(sql`
    SELECT coalesce(sum(dispatch.cpu_slots), 0)::integer AS reserved
    FROM progressive_remote_dispatches dispatch
    WHERE dispatch.solver_id = ${solverId}::uuid
      AND NOT EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped
        WHERE stopped.sim_job_id = dispatch.sim_job_id AND stopped.engine_job_id = dispatch.sim_job_id::text)
  `);
  return Number(row.reserved);
}

export async function progressiveRemoteActivePromiseCount(
  db: DB,
  solverId: string,
): Promise<number> {
  const [row] = await db.execute(sql`
    SELECT count(*)::integer AS count FROM sync_sweep_promises promise
    WHERE promise.registered_solver_id = ${solverId}::uuid
      AND promise.status = 'active' AND promise."expiresAt" > clock_timestamp()
      AND NOT EXISTS (
        SELECT 1 FROM progressive_remote_dispatches dispatch
        JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id = dispatch.sim_job_id
          AND stopped.engine_job_id = dispatch.sim_job_id::text
        WHERE dispatch.promise_id = promise.id AND dispatch.solver_id = promise.registered_solver_id
      )
  `);
  return Number(row.count);
}

export async function bindProgressiveRemoteDispatch(
  db: DB,
  input: { simJobId: string; promiseId: string; solverId: string },
): Promise<{
  replayed: boolean;
  envelope: ProgressiveRemoteExecutionEnvelope;
}> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [state] = await connection.execute(sql`
      SELECT enabled, admission_fence_active, disk_admission_blocked FROM sweeper_state WHERE id = 1 FOR UPDATE
    `);
    const [role] = await connection.execute(
      sql`SELECT remote_solver_enabled FROM sync_api_settings LIMIT 1`,
    );
    if (
      !state?.enabled ||
      state.admission_fence_active ||
      state.disk_admission_blocked ||
      role?.remote_solver_enabled
    )
      throw new Error(
        "The hub does not currently admit remote campaign dispatch",
      );
    const [solver] = await connection.execute(sql`
      SELECT id, cpu_capacity, cpu_budget, max_active_polar_promises FROM registered_remote_solvers
      WHERE id = ${input.solverId}::uuid AND revoked_at IS NULL FOR UPDATE
    `);
    if (!solver)
      throw new Error("Remote execution owner is missing or revoked");
    const [existing] = await connection.execute(sql`
      SELECT * FROM progressive_remote_dispatches WHERE sim_job_id = ${input.simJobId}::uuid
    `);
    if (existing)
      return {
        replayed: true,
        envelope: verifyProgressiveRemoteExecution(existing.envelope, {
          solverId: input.solverId,
          promiseId: input.promiseId,
          executionId: input.simJobId,
          contentSignature: String(existing.content_signature),
        }),
      };
    const [job] = await connection.execute(sql`
      SELECT job.airfoil_id, job.simulation_preset_revision_id, job.admission_cpu_slots, job.request_payload
      FROM sim_jobs job WHERE job.id = ${input.simJobId}::uuid
        AND job.status = 'pending' AND job.engine_job_id IS NULL AND job.engine_state IS NULL
      FOR UPDATE
    `);
    if (!job)
      throw new Error("Remote dispatch requires an unsubmitted hub execution");
    const payload = job.request_payload as {
      engineRequest: PolarRequest;
      progressive: unknown;
    };
    const envelope = sealProgressiveRemoteExecution({
      solverId: input.solverId,
      promiseId: input.promiseId,
      request: payload.engineRequest,
      scope: payload.progressive,
    });
    if (envelope.scope.executionId !== input.simJobId)
      throw new Error(
        "Remote dispatch cannot replace the hub execution identity",
      );
    const [promise] = await connection.execute(sql`
      SELECT promise.id, promise.aoa_count FROM sync_sweep_promises promise
      WHERE promise.id = ${input.promiseId}::uuid AND promise.registered_solver_id = ${input.solverId}::uuid
        AND promise.airfoil_id = ${job.airfoil_id}::uuid
        AND promise.simulation_preset_revision_id = ${job.simulation_preset_revision_id}::uuid
        AND promise.status = 'active' AND promise."expiresAt" > clock_timestamp()
      FOR UPDATE
    `);
    if (!promise)
      throw new Error(
        "Remote dispatch promise does not own the exact active execution scope",
      );
    const promised = await connection.execute(sql`
      SELECT aoa_deg FROM sync_sweep_promise_points WHERE promise_id = ${input.promiseId}::uuid
        AND airfoil_id = ${job.airfoil_id}::uuid AND simulation_preset_revision_id = ${job.simulation_preset_revision_id}::uuid
        AND status = 'active' ORDER BY aoa_deg FOR UPDATE
    `);
    const angles = envelope.scope.units
      .map((unit) => unit.alpha)
      .sort((left, right) => left - right);
    if (
      Number(promise.aoa_count) !== angles.length ||
      canonicalAnalysisJson(promised.map((row) => row.aoa_deg)) !==
        canonicalAnalysisJson(angles)
    )
      throw new Error(
        "Remote dispatch promise changes the exact owned angle list",
      );
    const current = await connection.execute(sql`
      SELECT attempt.token, unit.id AS unit_id, unit.aoa_deg,
        unit.active_budget_seconds - unit.active_seconds AS remaining_seconds
      FROM progressive_cfd_attempts attempt
      JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id AND unit.lease_token = attempt.token
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id AND epoch.current
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      WHERE attempt.sim_job_id = ${input.simJobId}::uuid AND attempt.outcome = 'running'
        AND attempt.execution_recipe_id = ${envelope.scope.recipeId}
        AND unit.state = 'leased' AND unit.lease_until > clock_timestamp()
        AND generation.id = ${envelope.scope.generationId}::uuid AND epoch.id = ${envelope.scope.epochId}::uuid
        AND generation.status = 'active' AND generation.stage = work.stage AND work.stage = ${envelope.scope.stage}
        AND work.target_id = ${envelope.scope.targetId} AND work.state = 'pending'
        AND generation.plan_revision_id = campaign.current_plan_revision_id AND campaign.status IN ('active', 'attention')
      ORDER BY attempt.token FOR UPDATE OF generation, work, unit, attempt
    `);
    const [attemptCount] = await connection.execute(sql`
      SELECT count(*)::integer AS count FROM progressive_cfd_attempts WHERE sim_job_id = ${input.simJobId}::uuid
    `);
    if (
      Number(attemptCount.count) !== current.length ||
      canonicalAnalysisJson(current.map((row) => row.token)) !==
        canonicalAnalysisJson([...envelope.scope.tokens].sort())
    )
      throw new Error(
        "Remote dispatch no longer owns the current campaign execution attempts",
      );
    for (const unit of envelope.scope.units) {
      const owned = current.find((row) => row.token === unit.token);
      if (
        !owned ||
        owned.unit_id !== unit.unitId ||
        Number(owned.aoa_deg) !== unit.alpha ||
        Number(owned.remaining_seconds) !== unit.activeBudgetSeconds
      )
        throw new Error(
          "Remote dispatch changed an owned physical unit or remaining allocation",
        );
    }
    const slots = Number(job.admission_cpu_slots);
    const capacity =
      Number(solver.cpu_budget) > 0
        ? Math.min(Number(solver.cpu_budget), Number(solver.cpu_capacity))
        : Number(solver.cpu_capacity);
    const requestedProcesses =
      envelope.request.resources?.solver_processes ?? 1;
    if (
      !Number.isSafeInteger(slots) ||
      slots < 1 ||
      slots !== requestedProcesses ||
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      slots +
        (await progressiveRemoteReservedSlots(connection, input.solverId)) >
        capacity
    )
      throw new Error(
        "Remote execution exceeds the exact available CPU reservation",
      );
    const active = await progressiveRemoteActivePromiseCount(
      connection,
      input.solverId,
    );
    if (active > Number(solver.max_active_polar_promises))
      throw new Error("Remote execution exceeds the registered promise policy");
    await connection.execute(sql`
      INSERT INTO progressive_remote_dispatches (sim_job_id, promise_id, solver_id, cpu_slots, content_signature, envelope)
      VALUES (${input.simJobId}::uuid, ${input.promiseId}::uuid, ${input.solverId}::uuid, ${slots},
        ${envelope.contentSignature}, ${JSON.stringify(envelope)}::jsonb)
    `);
    return { replayed: false, envelope };
  });
}
