import { sql } from "drizzle-orm";
import { PROGRESSIVE_COMPUTE_POLICY } from "@aerodb/core";
import { validateProgressiveExecutionScope } from "../../engine-client/src/progressive-execution";
import type {
  EngineExecutionStopProof,
  PolarRequest,
} from "../../engine-client/src/types";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import {
  attemptDigestColumns,
  matchesOriginalAttemptDigest,
} from "./attempt-evidence-digest";
import type { DB } from "./client";
import { tryProgressiveAdmissionLock } from "./progressive-admission-lock";
import { progressiveCfdNoAcceptedHistoryAndSettledSql } from "./progressive-attempt-budget";
import { progressiveCfdEffectiveBudgetSql } from "./progressive-cfd-budget-extension";
import { progressiveUnsteadyRecipe } from "./progressive-cfd-numerical-recovery";
import { validateProgressiveExecutionStopProof } from "./progressive-cfd-settlement";
import { assertProgressiveExecutionIdentity } from "./progressive-execution-identity";
import {
  effectiveProgressiveStageSql,
  progressiveFastTargetSettledSql,
} from "./progressive-execution-policy";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";

// Maintenance of already receipted evidence only. This does not reopen the
// ingestion scope or settle an attempt again: plan admission and requeueing
// commit together under the same locks used by the ordinary claimant.
export async function recoverLateRhoPimplePreciseExecution(
  db: DB,
  simJobId: string,
): Promise<number> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [parent] = await connection.execute(
      sql`SELECT campaign_id FROM sim_jobs WHERE id=${simJobId}::uuid`,
    );
    if (!parent) return 0;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (!epoch || !(await tryProgressiveAdmissionLock(connection))) return 0;
    const [campaign] =
      await connection.execute(sql`SELECT id,current_plan_revision_id FROM sim_campaigns
      WHERE id=${parent.campaign_id} AND status IN ('active','attention','paused') FOR UPDATE SKIP LOCKED`);
    if (!campaign) return 0;
    const units = await connection.execute(sql`
      SELECT unit.id,unit.aoa_deg,unit.recipe AS unit_recipe,work.id AS work_id,work.target_id,
        generation.id AS generation_id,generation.epoch_id,attempt.token,attempt.execution_recipe_id,
        recipe.recipe,recipe.source_revision_id,
        (work.stage=3 AND ${effectiveProgressiveStageSql()}=3 AND work.state IN ('pending','gap')
          AND ${progressiveFastTargetSettledSql()}
          AND unit.state='gap' AND unit.error='precise evidence remains unresolved'
          AND unit.policy_version=${PROGRESSIVE_COMPUTE_POLICY.version}
          AND unit.lease_token IS NULL AND unit.lease_owner IS NULL AND unit.lease_until IS NULL
          AND (unit.retry_after IS NULL OR unit.retry_after<=clock_timestamp())
          AND unit.active_seconds<${progressiveCfdEffectiveBudgetSql(sql`unit`)}
          AND unit.attempts IN (1,2)
          AND unit.attempts=(SELECT count(*) FROM progressive_cfd_attempts history WHERE history.unit_id=unit.id)
          AND attempt.outcome='failed' AND attempt.finished_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts newer WHERE newer.unit_id=unit.id
            AND (newer.started_at,newer.token)>(attempt.started_at,attempt.token))
          AND NOT EXISTS (SELECT 1 FROM progressive_cfd_recovery_plans plan WHERE plan.unit_id=unit.id)
          AND NOT EXISTS (SELECT 1 FROM progressive_cfd_recovery_claims claim WHERE claim.attempt_token=attempt.token)
          AND ${progressiveCfdNoAcceptedHistoryAndSettledSql()}
          AND NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts history
            JOIN result_attempts raw ON raw.sim_job_id=history.sim_job_id AND raw.aoa_deg=unit.aoa_deg
            WHERE history.unit_id=unit.id AND (raw.valid_for_polar OR EXISTS (
              SELECT 1 FROM result_review_verdicts review WHERE review.result_id=raw.result_id AND review."revokedAt" IS NULL)))
        ) AS eligible
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
      JOIN progressive_work work ON work.id=unit.work_id
      JOIN progressive_generations generation ON generation.id=work.generation_id
      JOIN progressive_cfd_execution_recipes recipe ON recipe.id=attempt.execution_recipe_id
      JOIN progressive_generation_targets scope ON scope.generation_id=generation.id AND scope.target_id=work.target_id
        AND scope.revision_id=recipe.source_revision_id
      WHERE attempt.sim_job_id=${simJobId}::uuid AND generation.campaign_id=${campaign.id}
        AND generation.epoch_id=${epoch.id} AND generation.status='active'
        AND generation.plan_revision_id=${campaign.current_plan_revision_id}
      ORDER BY unit.ordinal,unit.id FOR UPDATE OF generation,work,unit,attempt
    `);
    if (!units.length || units.length > 512) return 0;
    const [job] = await connection.execute(sql`
      SELECT job.engine_job_id,job.airfoil_id,job.simulation_preset_revision_id,job.request_payload,
        stopped.proof,stopped.proof_signature,stopped.epoch_id AS stop_epoch_id,
        dispatch.envelope,dispatch.solver_id,dispatch.promise_id,dispatch.content_signature
      FROM sim_jobs job JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id=job.id
        AND stopped.engine_job_id=job.engine_job_id
      LEFT JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=job.id
      WHERE job.id=${simJobId}::uuid AND job.campaign_id=${campaign.id} AND job.status='failed'
        AND job."ingestedAt"<=clock_timestamp()-interval '5 minutes'
        AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at<=clock_timestamp())
      FOR UPDATE OF job
    `);
    if (!job || job.stop_epoch_id !== epoch.id) return 0;
    const payload = job.request_payload as {
      engineRequest: PolarRequest;
      progressive: unknown;
    };
    try {
      assertProgressiveExecutionIdentity(
        simJobId,
        String(job.engine_job_id),
        payload,
      );
      validateProgressiveExecutionStopProof(
        job.proof as EngineExecutionStopProof,
      );
      const proof = job.proof as EngineExecutionStopProof;
      if (
        proof.job_id !== simJobId ||
        proof.ownership_basis === "never_started_cancellation_fence" ||
        analysisContentHash(proof) !== job.proof_signature ||
        payload.engineRequest.solver?.flow_solver_family !== "rhoPimpleFoam"
      )
        return 0;
      const scope = validateProgressiveExecutionScope(
        payload.engineRequest,
        payload.progressive,
      );
      if (
        scope.stage !== 3 ||
        scope.epochId !== epoch.id ||
        scope.units.length !== units.length ||
        units.some(
          (unit) =>
            scope.generationId !== unit.generation_id ||
            scope.targetId !== unit.target_id ||
            scope.recipeId !== unit.execution_recipe_id ||
            !scope.units.some(
              (owned) =>
                owned.unitId === unit.id &&
                owned.token === unit.token &&
                owned.alpha === unit.aoa_deg,
            ) ||
            canonicalAnalysisJson(unit.recipe) !==
              canonicalAnalysisJson(unit.unit_recipe) ||
            analysisContentHash({
              sourceRevisionId: unit.source_revision_id,
              recipe: unit.recipe,
            }) !== unit.execution_recipe_id,
        )
      )
        return 0;
      if (job.envelope != null) {
        const envelope = verifyProgressiveRemoteExecution(job.envelope, {
          executionId: simJobId,
          solverId: String(job.solver_id),
          promiseId: String(job.promise_id),
          contentSignature: String(job.content_signature),
        });
        if (
          canonicalAnalysisJson(envelope.scope) !==
            canonicalAnalysisJson(payload.progressive) ||
          canonicalAnalysisJson(envelope.request) !==
            canonicalAnalysisJson(payload.engineRequest)
        )
          return 0;
      }
    } catch {
      // Corrupt retained identity is unavailable, never an evidence-free retry.
      return 0;
    }
    const evidence = await connection.execute(sql`
      SELECT attempt.unit_id,raw.id,raw.aoa_deg,raw.airfoil_id,raw.sim_job_id,raw.engine_job_id,
        raw.simulation_preset_revision_id,recipe.execution_revision_id,raw.status,raw.valid_for_polar,raw.regime,
        receipt.evidence_signature,${attemptDigestColumns(sql`raw`, true)}
      FROM progressive_cfd_attempts attempt
      JOIN progressive_cfd_execution_recipes recipe ON recipe.id=attempt.execution_recipe_id
      JOIN progressive_cfd_evidence receipt ON receipt.attempt_token=attempt.token
      JOIN result_attempts raw ON raw.id=receipt.result_attempt_id
      WHERE attempt.sim_job_id=${simJobId}::uuid ORDER BY raw."createdAt",raw.id LIMIT 2049
    `);
    if (
      evidence.length > 2048 ||
      evidence.some(
        (item) => !matchesOriginalAttemptDigest(item, item.evidence_signature),
      )
    )
      return 0;
    let recovered = 0;
    for (const unit of units) {
      if (unit.eligible !== true) continue;
      const sources = evidence.filter((item) => item.unit_id === unit.id);
      if (sources.length !== 1) continue;
      const diagnostic = sources[0];
      if (
        diagnostic.status !== "failed" ||
        diagnostic.valid_for_polar !== false ||
        !["rans", "urans"].includes(String(diagnostic.regime)) ||
        (diagnostic.evidence_payload as Record<string, unknown>)
          ?.failure_disposition !== "hard_solver" ||
        diagnostic.sim_job_id !== simJobId ||
        diagnostic.engine_job_id !== job.engine_job_id ||
        diagnostic.airfoil_id !== job.airfoil_id ||
        diagnostic.aoa_deg !== unit.aoa_deg ||
        diagnostic.simulation_preset_revision_id !==
          diagnostic.execution_revision_id ||
        diagnostic.execution_revision_id !== job.simulation_preset_revision_id
      )
        continue;
      const original = unit.recipe as Record<string, unknown>;
      const recipe = progressiveUnsteadyRecipe(
        {
          ...original,
          selection: {
            ...(original.selection as Record<string, unknown>),
            solver: "rhoPimpleFoam",
          },
        },
        "hard_solver",
      );
      if (!recipe) continue;
      recipe.uransFidelity = "full";
      await connection.execute(sql`INSERT INTO progressive_cfd_recovery_plans
        (unit_id,ordinal,parent_attempt_token,parent_job_id,diagnostic_attempt_id,diagnostic_signature,scope,reason,recipe)
        VALUES (${unit.id},1,${unit.token},${simJobId}::uuid,${diagnostic.id},${diagnostic.evidence_signature},
          'targeted','hard_solver',${canonicalAnalysisJson(recipe)}::jsonb)`);
      await connection.execute(
        sql`UPDATE progressive_cfd_units SET state='pending',retry_after=NULL WHERE id=${unit.id}`,
      );
      await connection.execute(sql`UPDATE progressive_work SET state='pending',error=NULL,completed_at=NULL
        WHERE id=${unit.work_id} AND state='gap'`);
      recovered += 1;
    }
    return recovered;
  });
}
