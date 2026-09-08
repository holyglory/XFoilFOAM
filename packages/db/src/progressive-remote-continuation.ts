import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { canonicalAnalysisJson } from "./analysis-target";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";

export async function readProgressiveRemoteContinuation(
  db: DB,
  input: { solverId: string; executionId: string; contentSignature: string },
): Promise<{ kind: "continue" | "stop"; reason: string }> {
  return db.transaction(
    async (transaction) => {
      const connection = transaction as unknown as DB;
      const [epoch] = await connection.execute(
        sql`SELECT id, clock_timestamp() AS checked_at FROM calculation_epochs WHERE current`,
      );
      const [dispatch] = await connection.execute(sql`
      SELECT dispatch.envelope, dispatch.promise_id FROM progressive_remote_dispatches dispatch
      JOIN registered_remote_solvers solver ON solver.id = dispatch.solver_id AND solver.revoked_at IS NULL
      WHERE dispatch.sim_job_id = ${input.executionId}::uuid AND dispatch.solver_id = ${input.solverId}::uuid
    `);
      if (!dispatch)
        return {
          kind: "stop",
          reason: "The worker no longer owns this execution",
        };
      const envelope = verifyProgressiveRemoteExecution(dispatch.envelope, {
        ...input,
        promiseId: String(dispatch.promise_id),
      });
      const [generation] = await connection.execute(sql`
      SELECT generation.status, generation.stage, generation.plan_revision_id, campaign.current_plan_revision_id,
        campaign.status AS campaign_status
      FROM progressive_generations generation JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      WHERE generation.id = ${envelope.scope.generationId}::uuid AND generation.epoch_id = ${envelope.scope.epochId}::uuid
    `);
      if (
        epoch?.id !== envelope.scope.epochId ||
        generation?.status !== "active" ||
        Number(generation.stage) !== envelope.scope.stage ||
        generation.plan_revision_id !== generation.current_plan_revision_id ||
        !["active", "attention", "paused"].includes(
          String(generation.campaign_status),
        )
      )
        return {
          kind: "stop",
          reason:
            "The campaign or calculation stage no longer owns this execution",
        };
      const [job] = await connection.execute(sql`
      SELECT job.status, job.engine_job_id, job.request_payload,
        promise.status AS promise_status, promise."expiresAt" > clock_timestamp() AS promise_live,
        EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped WHERE stopped.sim_job_id = job.id) AS stopped
      FROM sim_jobs job JOIN sync_sweep_promises promise ON promise.id = ${envelope.promiseId}::uuid
      WHERE job.id = ${input.executionId}::uuid
    `);
      if (
        !job ||
        job.stopped ||
        ["done", "failed", "cancelled"].includes(String(job.status)) ||
        (job.engine_job_id !== null &&
          job.engine_job_id !== input.executionId) ||
        job.promise_status !== "active" ||
        !job.promise_live
      )
        return {
          kind: "stop",
          reason: "The assigned execution is stopped, cancelled or expired",
        };
      const payload = job.request_payload as Record<string, unknown>;
      const authorization = payload.remoteStartAuthorization as
        | Record<string, unknown>
        | undefined;
      const authorizedAt =
        typeof authorization?.authorizedAt === "string"
          ? Date.parse(authorization.authorizedAt)
          : NaN;
      const expiresAt =
        typeof authorization?.expiresAt === "string"
          ? Date.parse(authorization.expiresAt)
          : NaN;
      if (
        !authorization ||
        Object.keys(authorization).length !== 5 ||
        authorization.kind !== "authorized" ||
        authorization.executionId !== input.executionId ||
        authorization.contentSignature !== input.contentSignature ||
        !Number.isFinite(authorizedAt) ||
        !Number.isFinite(expiresAt) ||
        authorizedAt > new Date(epoch.checked_at as string | Date).getTime() ||
        expiresAt <= authorizedAt ||
        expiresAt - authorizedAt > 120000 ||
        canonicalAnalysisJson(payload.engineRequest) !==
          canonicalAnalysisJson(envelope.request) ||
        canonicalAnalysisJson(payload.progressive) !==
          canonicalAnalysisJson(envelope.scope)
      )
        return {
          kind: "stop",
          reason: "The execution has no unchanged original start authorization",
        };
      const units = await connection.execute(sql`
      SELECT attempt.token, attempt.outcome, attempt.execution_recipe_id, unit.id, unit.aoa_deg, unit.lease_token,
        work.generation_id, work.target_id, work.stage
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
      JOIN progressive_work work ON work.id = unit.work_id
      WHERE attempt.sim_job_id = ${input.executionId}::uuid ORDER BY attempt.token
    `);
      if (
        units.length !== envelope.scope.units.length ||
        units.some(
          (unit) =>
            unit.execution_recipe_id !== envelope.scope.recipeId ||
            unit.generation_id !== envelope.scope.generationId ||
            unit.target_id !== envelope.scope.targetId ||
            Number(unit.stage) !== envelope.scope.stage ||
            (unit.outcome === "running" && unit.lease_token !== unit.token) ||
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
          reason: "The execution no longer owns its exact case attempts",
        };
      return {
        kind: "continue",
        reason:
          "The original assigned execution remains owned; this is not permission to start another execution",
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
