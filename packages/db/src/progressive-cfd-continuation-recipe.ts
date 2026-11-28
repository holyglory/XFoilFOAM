import { sql } from "drizzle-orm";
import { progressiveSolverIsTransient, type ProgressiveSolverFamily } from "@aerodb/core";
import { validateProgressiveExecutionScope } from "../../engine-client/src/progressive-execution";
import type { PolarRequest } from "../../engine-client/src/types";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import type { DB } from "./client";
import type { ProgressiveCfdLease } from "./progressive-cfd";
import { normalizeProgressiveMaterialDomainRecoveryRecipe } from "./progressive-cfd-numerical-recovery";
import { assertProgressiveExecutionIdentity } from "./progressive-execution-identity";

/** Only an admitted, exact saved case can retain a historical dispatch choice.
 * New work always uses the sealed recipe; it never inherits this exception. */
export async function progressiveContinuationExecutionRecipe(db: DB, lease: ProgressiveCfdLease) {
  const extension = lease.budgetExtension;
  if (!extension) return { recipe: lease.recipe, continuationRequest: undefined };
  const [source] = await db.execute(sql`
    SELECT job.id, job.engine_job_id, job.request_payload, attempt.token,
      executed.id AS recipe_id, executed.recipe, executed.source_revision_id
    FROM progressive_cfd_budget_extensions extension
    JOIN progressive_cfd_attempts attempt ON attempt.token = extension.source_attempt_token
      AND attempt.unit_id = extension.unit_id
    JOIN progressive_cfd_execution_recipes executed ON executed.id = attempt.execution_recipe_id
    JOIN sim_jobs job ON job.id = attempt.sim_job_id
      AND job.simulation_preset_revision_id = executed.execution_revision_id
    JOIN progressive_cfd_evidence receipt ON receipt.attempt_token = attempt.token
      AND receipt.result_attempt_id = extension.source_result_attempt_id
      AND receipt.evidence_signature = extension.source_evidence_signature
    JOIN result_attempts raw ON raw.id = receipt.result_attempt_id
      AND raw.sim_job_id = job.id AND raw.engine_job_id = job.engine_job_id
      AND raw.simulation_preset_revision_id = executed.execution_revision_id
      AND raw.engine_case_slug = extension.source_engine_case_slug
      AND raw.aoa_deg = ${lease.alpha} AND raw.regime = 'urans'
      AND raw.evidence_payload->>'fidelity' = ${lease.stage === 2 ? "urans_precalc" : "urans_full"}
    JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id = job.id
      AND stopped.engine_job_id = job.engine_job_id AND stopped.epoch_id = ${lease.epochId}::uuid
    WHERE extension.unit_id = ${lease.id}::uuid AND extension.state = 'claimed'
      AND extension.claim_attempt_token = ${lease.token}::uuid
      AND extension.source_result_attempt_id = ${extension.sourceResultAttemptId}::uuid
      AND extension.source_engine_job_id = ${extension.engineJobId}
      AND job.engine_job_id = extension.source_engine_job_id
      AND job.status IN ('done', 'failed', 'cancelled') AND job."ingestedAt" IS NOT NULL
      AND attempt.outcome IN ('failed', 'complete')
  `);
  if (!source || source.source_revision_id !== lease.revisionId ||
      analysisContentHash({ sourceRevisionId: source.source_revision_id, recipe: source.recipe }) !== source.recipe_id ||
      canonicalAnalysisJson(normalizeProgressiveMaterialDomainRecoveryRecipe(source.recipe as Record<string, unknown>)) !==
        canonicalAnalysisJson(normalizeProgressiveMaterialDomainRecoveryRecipe(lease.recipe)))
    throw new Error("Progressive continuation has no exact settled source request");
  assertProgressiveExecutionIdentity(String(source.id), String(source.engine_job_id), source.request_payload);
  const payload = source.request_payload as { engineRequest: PolarRequest; progressive: unknown };
  const request = payload.engineRequest;
  const scope = validateProgressiveExecutionScope(request, payload.progressive);
  if (scope.recipeId !== source.recipe_id || scope.generationId !== lease.generationId ||
      scope.epochId !== lease.epochId || scope.targetId !== lease.targetId || scope.stage !== lease.stage ||
      !scope.units.some(unit => unit.unitId === lease.id && unit.alpha === lease.alpha && unit.token === source.token))
    throw new Error("Progressive continuation source changed its immutable unit scope");
  const family = request.solver?.flow_solver_family;
  const selection = lease.recipe.selection as { solver: ProgressiveSolverFamily };
  if (!family || !["pimpleFoam", "rhoPimpleFoam", "rhoCentralFoam"].includes(family) ||
      request.solver?.force_transient !== true || request.solver.transient_fallback !== true ||
      request.solver.urans_fidelity !== (lease.stage === 2 ? "precalc" : "full") ||
      lease.recipe.timeCoordinate === "local_pseudo_time_iterations" ||
      !progressiveSolverIsTransient(family))
    throw new Error("Progressive continuation requires an original physical-time URANS request");
  if (family === selection.solver)
    return { recipe: lease.recipe, continuationRequest: request };
  // 7f04bf99 dispatched these stage-3 recipes as URANS after materializing a
  // steady revision. Preserve the checkpoint without sharing that incorrect
  // numerical identity with ordinary steady requests or rewriting history.
  if (lease.stage !== 3 ||
      !((selection.solver === "simpleFoam" && family === "pimpleFoam") ||
        (selection.solver === "rhoSimpleFoam" && family === "rhoPimpleFoam")) ||
      lease.recipe.timeCoordinate !== undefined)
    throw new Error("Progressive continuation solver differs from its source recipe");
  return {
    recipe: { ...lease.recipe, selection: { ...selection, solver: family }, timeCoordinate: "physical_time_seconds" },
    continuationRequest: request,
  };
}
