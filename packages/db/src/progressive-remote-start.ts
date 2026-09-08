import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { canonicalAnalysisJson } from "./analysis-target";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";

export type ProgressiveRemoteStartDecision =
  | {
      kind: "authorized";
      executionId: string;
      contentSignature: string;
      authorizedAt: string;
      expiresAt: string;
    }
  | { kind: "wait" | "stop"; reason: string };

export async function authorizeProgressiveRemoteStart(
  db: DB,
  input: { solverId: string; executionId: string; contentSignature: string },
): Promise<ProgressiveRemoteStartDecision> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    const [state] = await connection.execute(sql`
      SELECT enabled, admission_fence_active, disk_admission_blocked FROM sweeper_state WHERE id = 1 FOR UPDATE
    `);
    const [settings] = await connection.execute(sql`
      SELECT enabled, remote_solver_enabled FROM sync_api_settings WHERE id = 1
    `);
    const [solver] = await connection.execute(sql`
      SELECT id, last_heartbeat_at > clock_timestamp() - interval '2 minutes' AS recent
      FROM registered_remote_solvers WHERE id = ${input.solverId}::uuid AND revoked_at IS NULL FOR UPDATE
    `);
    const [dispatch] = await connection.execute(sql`
      SELECT envelope, promise_id, content_signature FROM progressive_remote_dispatches
      WHERE sim_job_id = ${input.executionId}::uuid AND solver_id = ${input.solverId}::uuid FOR UPDATE
    `);
    if (!solver || !dispatch)
      return {
        kind: "stop",
        reason: "The worker does not own this assignment",
      };
    const envelope = verifyProgressiveRemoteExecution(dispatch.envelope, {
      ...input,
      promiseId: String(dispatch.promise_id),
    });
    const [job] = await connection.execute(sql`
      SELECT status, engine_job_id, request_payload, request_payload->'remoteStartAuthorization' AS authorization
      FROM sim_jobs WHERE id = ${input.executionId}::uuid FOR UPDATE
    `);
    const [promise] = await connection.execute(sql`
      SELECT status, "expiresAt" > clock_timestamp() AS active, "expiresAt" AS expires_at
      FROM sync_sweep_promises WHERE id = ${envelope.promiseId}::uuid FOR UPDATE
    `);
    const [stopped] = await connection.execute(sql`
      SELECT sim_job_id FROM progressive_cfd_execution_stops WHERE sim_job_id = ${input.executionId}::uuid
    `);
    if (
      !job ||
      ["done", "failed", "cancelled"].includes(String(job.status)) ||
      stopped ||
      promise?.status !== "active" ||
      !promise.active ||
      epoch?.id !== envelope.scope.epochId
    )
      return {
        kind: "stop",
        reason:
          "The assignment is stopped, expired or belongs to an obsolete calculation",
      };
    const [generation] = await connection.execute(sql`
      SELECT generation.status, generation.stage, campaign.status AS campaign_status,
        generation.plan_revision_id = campaign.current_plan_revision_id AS current_plan
      FROM progressive_generations generation JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      WHERE generation.id = ${envelope.scope.generationId}::uuid AND generation.epoch_id = ${envelope.scope.epochId}::uuid
      FOR UPDATE OF campaign, generation
    `);
    if (
      !generation ||
      generation.status !== "active" ||
      !generation.current_plan ||
      Number(generation.stage) !== envelope.scope.stage ||
      !["active", "attention", "paused"].includes(
        String(generation.campaign_status),
      )
    )
      return {
        kind: "stop",
        reason: "The campaign no longer owns this execution stage",
      };
    const units = await connection.execute(sql`
      SELECT attempt.token, unit.id, unit.aoa_deg, unit.lease_until,
        unit.lease_until > clock_timestamp() AS fresh
      FROM progressive_cfd_attempts attempt
      JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id AND unit.lease_token = attempt.token
      JOIN progressive_work work ON work.id = unit.work_id
      WHERE attempt.sim_job_id = ${input.executionId}::uuid AND attempt.outcome = 'running'
        AND attempt.execution_recipe_id = ${envelope.scope.recipeId} AND unit.state = 'leased'
        AND work.generation_id = ${envelope.scope.generationId}::uuid AND work.stage = ${envelope.scope.stage}
        AND work.target_id = ${envelope.scope.targetId} AND work.state = 'pending'
      ORDER BY attempt.token FOR UPDATE OF work, unit, attempt
    `);
    if (
      canonicalAnalysisJson(units.map((unit) => unit.token)) !==
        canonicalAnalysisJson([...envelope.scope.tokens].sort()) ||
      units.some(
        (unit) =>
          !unit.fresh ||
          !envelope.scope.units.some(
            (expected) =>
              expected.token === unit.token &&
              expected.unitId === unit.id &&
              expected.alpha === Number(unit.aoa_deg),
          ),
      )
    )
      return {
        kind: "stop",
        reason: "The exact case ownership has expired or changed",
      };
    if (
      !state?.enabled ||
      state.admission_fence_active ||
      state.disk_admission_blocked ||
      !settings?.enabled ||
      settings.remote_solver_enabled ||
      !solver.recent ||
      generation.campaign_status === "paused"
    )
      return {
        kind: "wait",
        reason:
          "New remote execution is paused or its authenticated heartbeat is stale",
      };
    const [permissions] = await connection.execute(sql`
      SELECT EXISTS (SELECT 1 FROM sync_api_permissions WHERE data_type = 'sweeps' AND can_fetch) AS fetch,
        EXISTS (SELECT 1 FROM sync_api_permissions WHERE data_type = 'polars' AND can_push) AS push
    `);
    if (!permissions.fetch || !permissions.push)
      return {
        kind: "wait",
        reason: "The existing sweep or polar transfer permission is disabled",
      };
    if (
      canonicalAnalysisJson(
        (job.request_payload as Record<string, unknown>).engineRequest,
      ) !== canonicalAnalysisJson(envelope.request) ||
      canonicalAnalysisJson(
        (job.request_payload as Record<string, unknown>).progressive,
      ) !== canonicalAnalysisJson(envelope.scope)
    )
      return {
        kind: "stop",
        reason: "The registered request differs from the immutable assignment",
      };
    const [clock] = await connection.execute(
      sql`SELECT clock_timestamp() AS now`,
    );
    const now = new Date(clock.now as string | Date);
    if (job.authorization) {
      const authorization = job.authorization as Extract<
        ProgressiveRemoteStartDecision,
        { kind: "authorized" }
      >;
      if (
        authorization.kind !== "authorized" ||
        authorization.executionId !== input.executionId ||
        authorization.contentSignature !== input.contentSignature ||
        Object.keys(authorization).length !== 5 ||
        !Number.isFinite(Date.parse(authorization.authorizedAt)) ||
        Date.parse(authorization.authorizedAt) > now.getTime() ||
        Date.parse(authorization.expiresAt) -
          Date.parse(authorization.authorizedAt) >
          120_000 ||
        !(Date.parse(authorization.expiresAt) > now.getTime())
      )
        return {
          kind: "stop",
          reason: "The original start authorization expired or changed",
        };
      return authorization;
    }
    if (job.status !== "pending" || job.engine_job_id !== null)
      return {
        kind: "stop",
        reason:
          "This assignment already crossed its initial submission boundary",
      };
    const authorization = {
      kind: "authorized" as const,
      executionId: input.executionId,
      contentSignature: input.contentSignature,
      authorizedAt: now.toISOString(),
      expiresAt: new Date(
        Math.min(
          now.getTime() + 120_000,
          new Date(promise.expires_at as string | Date).getTime(),
          ...units.map((unit) =>
            new Date(unit.lease_until as string | Date).getTime(),
          ),
        ),
      ).toISOString(),
    };
    if (Date.parse(authorization.expiresAt) <= now.getTime())
      return {
        kind: "stop",
        reason: "The case lease expired before start authorization",
      };
    await connection.execute(sql`
      UPDATE sim_jobs SET request_payload = jsonb_set(request_payload, '{remoteStartAuthorization}', ${JSON.stringify(authorization)}::jsonb)
      WHERE id = ${input.executionId}::uuid
    `);
    return authorization;
  });
}
