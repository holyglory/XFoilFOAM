import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import { progressiveCfdMaterialDomainRecoveryAvailableSql } from "./progressive-attempt-budget";
import { progressiveMaterialDomainRecipe } from "./progressive-cfd-numerical-recovery";
import { validateProgressiveExecutionStopProof } from "./progressive-cfd-settlement";
import { assertProgressiveExecutionIdentity } from "./progressive-execution-identity";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import { validateProgressiveExecutionScope } from "../../engine-client/src/progressive-execution";
import type { EngineExecutionStopProof, PolarRequest } from "../../engine-client/src/types";

// This exception belongs only to maintenance of an evidence-bearing precise
// gap. Ordinary claiming and the legacy no-evidence retry policy stay separate.
// The caller supplies current scope, settled FAST/history, latest attempt and
// exclusive ownership checks before locking the candidate.
export function progressiveCfdMaterialGapRecoveryAvailableSql() {
  return sql`(
    work.stage = 3 AND unit.state = 'gap'
    AND unit.error = 'precise evidence remains unresolved'
    AND unit.attempts IN (2, 3)
    AND unit.attempts = (SELECT count(*) FROM progressive_cfd_attempts history WHERE history.unit_id = unit.id)
    AND unit.active_seconds < unit.active_budget_seconds
    AND attempt.outcome = 'failed' AND attempt.finished_at IS NOT NULL
    AND attempt_job.status IN ('done', 'failed', 'cancelled')
    AND attempt_job."ingestedAt" IS NOT NULL
    AND (attempt_job.ingest_lease_token IS NULL OR attempt_job.ingest_lease_expires_at <= clock_timestamp())
    AND NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts running
      WHERE running.unit_id = unit.id AND running.outcome = 'running')
    AND ${progressiveCfdMaterialDomainRecoveryAvailableSql()}
    AND EXISTS (
      SELECT 1 FROM progressive_cfd_recovery_plans plan
      JOIN progressive_cfd_execution_recipes recipe ON recipe.id = attempt.execution_recipe_id
      JOIN progressive_generation_targets scope ON scope.generation_id = generation.id AND scope.target_id = work.target_id
        AND scope.revision_id = recipe.source_revision_id
      JOIN polar_analysis_targets target ON target.id = work.target_id AND target.airfoil_id = attempt_job.airfoil_id
      JOIN progressive_cfd_execution_stops stop ON stop.sim_job_id = attempt_job.id
        AND stop.engine_job_id = attempt_job.engine_job_id AND stop.epoch_id = generation.epoch_id
      JOIN result_attempts raw ON raw.id = plan.diagnostic_attempt_id
        AND raw.sim_job_id = attempt_job.id AND raw.engine_job_id = attempt_job.engine_job_id
        AND raw.airfoil_id = target.airfoil_id AND raw.aoa_deg = unit.aoa_deg
        AND raw.simulation_preset_revision_id = recipe.execution_revision_id
        AND raw.status = 'failed' AND NOT raw.valid_for_polar AND raw.regime = 'rans'
        AND raw.evidence_payload->>'failure_disposition' = 'material_domain'
      JOIN progressive_cfd_evidence evidence ON evidence.result_attempt_id = raw.id
        AND evidence.attempt_token = attempt.token AND evidence.evidence_signature = plan.diagnostic_signature
      WHERE plan.unit_id = unit.id AND plan.ordinal = 1 AND plan.scope = 'targeted'
        AND plan.reason = 'material_domain' AND plan.diagnostic_point_content_signature IS NULL
        AND plan.parent_attempt_token = attempt.token AND plan.parent_job_id = attempt_job.id
        AND attempt_job.simulation_preset_revision_id = recipe.execution_revision_id
        AND NOT EXISTS (SELECT 1 FROM progressive_cfd_recovery_plans successor
          WHERE successor.unit_id = unit.id AND successor.ordinal > plan.ordinal)
        AND NOT EXISTS (SELECT 1 FROM progressive_cfd_recovery_claims claimed
          WHERE claimed.recovery_plan_id = plan.id OR claimed.attempt_token = attempt.token)
    )
  )`;
}

// Run after epoch -> admission -> campaign -> unit/attempt/job locks. Hashes
// use the same canonical JSON as plan registration, never PostgreSQL JSON text.
export async function verifyProgressiveCfdMaterialGap(db: DB, unitId: string, attemptToken: string): Promise<boolean> {
  const [row] = await db.execute(sql`
    SELECT unit.id, unit.aoa_deg, unit.recipe AS unit_recipe, work.target_id,
      generation.id AS generation_id, generation.epoch_id,
      plan.recipe AS recovery_recipe, plan.diagnostic_signature,
      attempt.token, attempt.execution_recipe_id, recipe.source_revision_id, recipe.recipe,
      raw.evidence_payload, evidence.evidence_signature,
      attempt_job.id AS job_id, attempt_job.engine_job_id, attempt_job.request_payload,
      stop.proof, stop.proof_signature,
      dispatch.envelope, dispatch.solver_id, dispatch.promise_id, dispatch.content_signature
    FROM progressive_cfd_units unit JOIN progressive_work work ON work.id = unit.work_id
    JOIN progressive_generations generation ON generation.id = work.generation_id
    JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id AND attempt.token = ${attemptToken}::uuid
    JOIN sim_jobs attempt_job ON attempt_job.id = attempt.sim_job_id
    JOIN progressive_cfd_recovery_plans plan ON plan.unit_id = unit.id AND plan.ordinal = 1
    JOIN progressive_cfd_execution_recipes recipe ON recipe.id = attempt.execution_recipe_id
    JOIN result_attempts raw ON raw.id = plan.diagnostic_attempt_id
    JOIN progressive_cfd_evidence evidence ON evidence.result_attempt_id = raw.id AND evidence.attempt_token = attempt.token
    JOIN progressive_cfd_execution_stops stop ON stop.sim_job_id = attempt_job.id
    LEFT JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id = attempt_job.id
    WHERE unit.id = ${unitId}::uuid AND ${progressiveCfdMaterialGapRecoveryAvailableSql()}
  `);
  if (!row) return false;
  try {
    const expected = progressiveMaterialDomainRecipe(row.recipe as Record<string, unknown>, 3);
    if (!expected || canonicalAnalysisJson(expected) !== canonicalAnalysisJson(row.recovery_recipe) ||
      canonicalAnalysisJson(row.recipe) !== canonicalAnalysisJson(row.unit_recipe) ||
      analysisContentHash({ sourceRevisionId: row.source_revision_id, recipe: row.recipe }) !== row.execution_recipe_id ||
      analysisContentHash(row.evidence_payload) !== row.evidence_signature ||
      row.evidence_signature !== row.diagnostic_signature || analysisContentHash(row.proof) !== row.proof_signature)
      return false;
    assertProgressiveExecutionIdentity(String(row.job_id), String(row.engine_job_id), row.request_payload);
    const proof = row.proof as EngineExecutionStopProof;
    validateProgressiveExecutionStopProof(proof);
    if (proof.job_id !== row.engine_job_id || proof.ownership_basis === "never_started_cancellation_fence") return false;
    const payload = row.request_payload as { engineRequest: PolarRequest; progressive: unknown };
    const scope = validateProgressiveExecutionScope(payload.engineRequest, payload.progressive);
    if (scope.epochId !== row.epoch_id || scope.generationId !== row.generation_id || scope.targetId !== row.target_id ||
      scope.stage !== 3 || scope.recipeId !== row.execution_recipe_id || !scope.tokens.includes(String(row.token)) ||
      !scope.units.some((unit) => unit.unitId === row.id && unit.token === row.token && unit.alpha === row.aoa_deg)) return false;
    if (row.envelope != null) {
      const envelope = verifyProgressiveRemoteExecution(row.envelope, {
        executionId: String(row.job_id), solverId: String(row.solver_id),
        promiseId: String(row.promise_id), contentSignature: String(row.content_signature),
      });
      if (canonicalAnalysisJson(envelope.scope) !== canonicalAnalysisJson(payload.progressive) ||
        canonicalAnalysisJson(envelope.request) !== canonicalAnalysisJson(payload.engineRequest)) return false;
    }
    return true;
  } catch {
    // Invalid retained identity leaves this gap unavailable; it must never
    // fall through to the evidence-free retry branch or rewrite its history.
    return false;
  }
}
