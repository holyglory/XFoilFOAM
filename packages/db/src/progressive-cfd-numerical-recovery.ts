import { sql } from "drizzle-orm";
import { PROGRESSIVE_COMPUTE_POLICY } from "@aerodb/core";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import type { DB } from "./client";
import { assertProgressiveCfdEvidenceJob } from "./progressive-cfd-evidence";

export interface ProgressiveRansPromotion {
  revisionId: string;
  triggerResultAttemptId: string;
  triggerAoaDeg: number;
  attemptedAoas: number[];
  intentionallyOmittedAoas: number[];
}

interface RecoveryUnit {
  id: string;
  token: string;
  aoa_deg: number;
  recipe: Record<string, unknown>;
  execution_revision_id: string;
  recovery_plan_id: string | null;
  stage: number;
  policy_version: string;
  recovery_ordinal: number | null;
  recovery_scope: string | null;
  recovery_recipe: Record<string, unknown> | null;
}

interface RecoveryEvidence {
  id: string;
  attempt_token: string;
  aoa_deg: number;
  regime: string;
  classification: string | null;
  evidence_payload: Record<string, unknown>;
  evidence_signature: string;
  accepted: boolean;
}

export function progressiveUnsteadyRecipe(
  recipe: Record<string, unknown>,
  reason: "hard_solver" | "needs_urans",
): Record<string, unknown> | null {
  const selection = recipe.selection as Record<string, unknown> | undefined;
  const family = selection?.solver;
  const localDensity =
    family === "rhoCentralFoam" &&
    recipe.timeCoordinate === "local_pseudo_time_iterations";
  if (family !== "simpleFoam" && family !== "rhoSimpleFoam" && !localDensity)
    return null;
  return {
    ...recipe,
    ...(localDensity ? { timeCoordinate: "physical_time_seconds" } : {}),
    selection: {
      ...selection,
      solver: localDensity
        ? "rhoCentralFoam"
        : family === "simpleFoam"
          ? "pimpleFoam"
          : "rhoPimpleFoam",
      reason: `bounded_${reason}_recovery`,
    },
  };
}

export async function recordProgressiveCfdRecoveryPlans(
  db: DB,
  simJobId: string,
  promotions: ProgressiveRansPromotion[] = [],
): Promise<number> {
  if (promotions.length > 1)
    throw new Error(
      "Progressive recovery requires one exact physical condition",
    );
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [job] = await connection.execute(sql`
      SELECT job.engine_job_id, job.request_payload->'engineRequest' AS request,
        EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped
          WHERE stopped.sim_job_id = job.id AND stopped.engine_job_id = job.engine_job_id) AS stopped
      FROM sim_jobs job WHERE job.id = ${simJobId}
    `);
    if (!job?.stopped || typeof job.engine_job_id !== "string")
      throw new Error(
        "Numerical recovery requires a physically stopped parent execution",
      );
    if (
      !(await assertProgressiveCfdEvidenceJob(
        connection,
        simJobId,
        job.engine_job_id,
      ))
    )
      throw new Error(
        "Numerical recovery requires a progressive parent execution",
      );
    const units = (await connection.execute(sql`
      SELECT unit.id, attempt.token, unit.aoa_deg, unit.recipe, recipe.execution_revision_id,
        claim.recovery_plan_id, work.stage, unit.policy_version, recovery.ordinal AS recovery_ordinal,
        recovery.scope AS recovery_scope, recovery.recipe AS recovery_recipe
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_cfd_execution_recipes recipe ON recipe.id = attempt.execution_recipe_id
      LEFT JOIN progressive_cfd_recovery_claims claim ON claim.attempt_token = attempt.token
      LEFT JOIN progressive_cfd_recovery_plans recovery ON recovery.id = claim.recovery_plan_id
      WHERE attempt.sim_job_id = ${simJobId} ORDER BY unit.ordinal, unit.id
    `)) as unknown as RecoveryUnit[];
    if (!units.length || units.length > 512)
      throw new Error("Numerical recovery has no bounded parent unit scope");
    if (units.some((unit) => unit.recovery_plan_id)) {
      if (promotions.length)
        throw new Error("An unsteady recovery cannot promote another sweep");
      if (units.some((unit) => !unit.recovery_plan_id))
        throw new Error(
          "Numerical recovery mixes base and replacement ownership",
        );
    }
    const evidence = (await connection.execute(sql`
      SELECT raw.id, receipt.attempt_token, raw.aoa_deg, raw.regime, raw.evidence_payload,
        receipt.evidence_signature, classification.state AS classification,
        (raw.status = 'done' AND raw.valid_for_polar AND classification.state = 'accepted'
          AND coalesce((SELECT review.verdict FROM result_review_verdicts review WHERE review.result_id = raw.result_id
            AND review."revokedAt" IS NULL ORDER BY review."createdAt" DESC, review.id DESC LIMIT 1), '') NOT IN ('exclude', 'defer')) AS accepted
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_evidence receipt ON receipt.attempt_token = attempt.token
      JOIN result_attempts raw ON raw.id = receipt.result_attempt_id
      LEFT JOIN result_classifications classification ON classification.result_attempt_id = raw.id
      WHERE attempt.sim_job_id = ${simJobId} ORDER BY raw."createdAt", raw.id LIMIT 2049
    `)) as unknown as RecoveryEvidence[];
    if (
      evidence.length > 2048 ||
      evidence.some(
        (item) =>
          analysisContentHash(item.evidence_payload) !==
          item.evidence_signature,
      )
    )
      throw new Error(
        "Numerical recovery has changed or unbounded diagnostic evidence",
      );
    const promotion = promotions[0];
    let trigger: RecoveryEvidence | undefined;
    if (promotion) {
      const request = job.request as {
        aoa?: { angles?: number[] };
        solver?: { rans_failure_policy?: string };
      };
      const requested = request?.aoa?.angles;
      const angles = units
        .map((unit) => unit.aoa_deg)
        .sort((left, right) => left - right);
      const ordered = angles.includes(0)
        ? [
            0,
            ...angles.filter((angle) => angle > 0),
            ...angles.filter((angle) => angle < 0).reverse(),
          ]
        : angles;
      const triggerIndex = ordered.indexOf(promotion.triggerAoaDeg);
      const attempted = ordered.slice(0, triggerIndex + 1);
      const omitted = angles.filter((angle) => !attempted.includes(angle));
      trigger = evidence.find(
        (item) => item.id === promotion.triggerResultAttemptId,
      );
      const triggerUnit = units.find(
        (unit) => unit.token === trigger?.attempt_token,
      );
      if (
        units.length < 2 ||
        !requested ||
        requested.length !== units.length ||
        canonicalAnalysisJson(
          [...requested].sort((left, right) => left - right),
        ) !== canonicalAnalysisJson(angles) ||
        request.solver?.rans_failure_policy !== "abort_for_precalc" ||
        !trigger ||
        trigger.regime !== "rans" ||
        trigger.aoa_deg !== promotion.triggerAoaDeg ||
        trigger.evidence_payload.failure_disposition !== "hard_solver" ||
        promotion.triggerAoaDeg < 0 ||
        promotion.triggerAoaDeg > 5 ||
        triggerIndex < 0 ||
        triggerUnit?.execution_revision_id !== promotion.revisionId ||
        canonicalAnalysisJson(promotion.attemptedAoas) !==
          canonicalAnalysisJson(attempted) ||
        canonicalAnalysisJson(promotion.intentionallyOmittedAoas) !==
          canonicalAnalysisJson(omitted) ||
        canonicalAnalysisJson(
          [...new Set(evidence.map((item) => item.aoa_deg))].sort(
            (left, right) => left - right,
          ),
        ) !==
          canonicalAnalysisJson(
            [...attempted].sort((left, right) => left - right),
          )
      )
        throw new Error(
          "Numerical recovery changed the exact original RANS promotion scope",
        );
    }
    let inserted = 0;
    for (const unit of units) {
      const verification = unit.recovery_plan_id !== null;
      if (
        verification &&
        (unit.stage !== 3 ||
          unit.policy_version !== PROGRESSIVE_COMPUTE_POLICY.version ||
          unit.recovery_ordinal !== 1 ||
          unit.recovery_scope !== "original_sweep" ||
          unit.recovery_recipe?.uransFidelity !== "precalc")
      )
        continue;
      const diagnostic = verification
        ? evidence.find(
            (item) =>
              item.attempt_token === unit.token &&
              item.regime === "urans" &&
              item.accepted === true &&
              item.evidence_payload.fidelity === "urans_precalc",
          )
        : (trigger ??
          evidence.find(
            (item) =>
              item.attempt_token === unit.token &&
              item.regime === "rans" &&
              ![
                "infrastructure",
                "deterministic_mesh",
                "material_domain",
              ].includes(String(item.evidence_payload.failure_disposition)) &&
              (item.evidence_payload.failure_disposition === "hard_solver" ||
                item.classification === "needs_urans"),
          ));
      if (!diagnostic) continue;
      const reason = verification
        ? "accepted_precalc"
        : diagnostic.evidence_payload.failure_disposition === "hard_solver"
          ? "hard_solver"
          : "needs_urans";
      const recipe = verification
        ? { ...unit.recovery_recipe!, uransFidelity: "full" }
        : progressiveUnsteadyRecipe(
            unit.recipe,
            reason as "hard_solver" | "needs_urans",
          );
      if (!recipe) continue;
      if (!verification)
        recipe.uransFidelity = trigger || unit.stage === 2 ? "precalc" : "full";
      const scope = trigger || verification ? "original_sweep" : "targeted";
      const ordinal = verification ? 2 : 1;
      const values = {
        unit_id: unit.id,
        ordinal,
        parent_attempt_token: unit.token,
        parent_job_id: simJobId,
        diagnostic_attempt_id: diagnostic.id,
        diagnostic_signature: diagnostic.evidence_signature,
        scope,
        reason,
        recipe,
      };
      const [existing] = await connection.execute(sql`
        SELECT unit_id, ordinal, parent_attempt_token, parent_job_id, diagnostic_attempt_id, diagnostic_signature, scope, reason, recipe
        FROM progressive_cfd_recovery_plans WHERE unit_id = ${unit.id} AND ordinal = ${ordinal}
      `);
      if (existing) {
        if (canonicalAnalysisJson(existing) !== canonicalAnalysisJson(values))
          throw new Error(
            "Numerical recovery conflicts with the immutable existing plan",
          );
        continue;
      }
      await connection.execute(sql`
        INSERT INTO progressive_cfd_recovery_plans
          (unit_id, ordinal, parent_attempt_token, parent_job_id, diagnostic_attempt_id, diagnostic_signature, scope, reason, recipe)
        VALUES (${unit.id}, ${ordinal}, ${unit.token}, ${simJobId}, ${diagnostic.id}, ${diagnostic.evidence_signature},
          ${scope}, ${reason}, ${canonicalAnalysisJson(recipe)}::jsonb)
      `);
      inserted += 1;
    }
    return inserted;
  });
}

export async function supersedeProgressivePriorEvidence(
  db: DB,
  airfoilId: string,
  revisionId: string,
): Promise<void> {
  await db.execute(sql`
    WITH replacements AS (
      SELECT DISTINCT ON (prior.id) prior.id AS prior_id, prior.result_id AS prior_result_id,
        prior_cell.current_result_attempt_id AS current_prior_id, newer.result_id AS replacement_id
      FROM result_attempts prior
      JOIN results prior_cell ON prior_cell.id = prior.result_id
      JOIN progressive_cfd_evidence prior_receipt ON prior_receipt.result_attempt_id = prior.id
      JOIN progressive_cfd_attempts prior_execution ON prior_execution.token = prior_receipt.attempt_token
      JOIN progressive_cfd_attempts newer_execution ON newer_execution.unit_id = prior_execution.unit_id
      JOIN progressive_cfd_recovery_claims claim ON claim.attempt_token = newer_execution.token
      JOIN progressive_cfd_recovery_plans plan ON plan.id = claim.recovery_plan_id AND plan.unit_id = newer_execution.unit_id
      JOIN progressive_cfd_evidence newer_receipt ON newer_receipt.attempt_token = newer_execution.token
      JOIN result_attempts newer ON newer.id = newer_receipt.result_attempt_id
      JOIN result_classifications accepted ON accepted.result_attempt_id = newer.id
      WHERE prior.airfoil_id = ${airfoilId} AND prior.simulation_preset_revision_id = ${revisionId}
        AND newer.airfoil_id = prior.airfoil_id AND newer.aoa_deg = prior.aoa_deg AND newer.id <> prior.id
        AND newer.regime = 'urans' AND newer.status = 'done' AND newer.valid_for_polar AND accepted.state = 'accepted'
        AND newer.evidence_payload->>'fidelity' IN ('urans_precalc', 'urans_full')
        AND (prior.regime = 'rans' OR (prior.regime = 'urans' AND prior.evidence_payload->>'fidelity' = 'urans_precalc'
          AND newer.evidence_payload->>'fidelity' = 'urans_full' AND plan.ordinal = 2))
        AND coalesce((SELECT review.verdict FROM result_review_verdicts review WHERE review.result_id = newer.result_id
          AND review."revokedAt" IS NULL ORDER BY review."createdAt" DESC, review.id DESC LIMIT 1), '') NOT IN ('exclude', 'defer')
      ORDER BY prior.id, CASE WHEN newer.evidence_payload->>'fidelity' = 'urans_full' THEN 0 ELSE 1 END,
        newer_execution.started_at DESC, newer."createdAt" DESC, newer.id
    )
    UPDATE result_classifications classification SET state = 'superseded_by_urans',
      superseded_by_result_id = replacements.replacement_id,
      reasons = array(SELECT DISTINCT unnest(classification.reasons || ARRAY['progressive-urans-replacement']::text[])),
      "updatedAt" = clock_timestamp()
    FROM replacements WHERE (classification.result_attempt_id = replacements.prior_id
      OR (classification.result_attempt_id IS NULL AND classification.result_id = replacements.prior_result_id
        AND replacements.current_prior_id = replacements.prior_id))
      AND classification.state IN ('accepted', 'needs_urans', 'superseded_by_urans')
  `);
}

export async function progressiveParentRevisionIds(
  db: DB,
  airfoilId: string,
  revisionId: string,
): Promise<string[]> {
  const parents = await db.execute(sql`
    SELECT DISTINCT parent_recipe.execution_revision_id AS id
    FROM progressive_cfd_execution_recipes child_recipe
    JOIN progressive_cfd_attempts child ON child.execution_recipe_id = child_recipe.id
    JOIN sim_jobs child_job ON child_job.id = child.sim_job_id
    JOIN progressive_cfd_recovery_claims child_claim ON child_claim.attempt_token = child.token
    JOIN progressive_cfd_recovery_plans child_plan ON child_plan.id = child_claim.recovery_plan_id AND child_plan.unit_id = child.unit_id
    JOIN progressive_cfd_attempts parent ON parent.token = child_plan.parent_attempt_token AND parent.unit_id = child.unit_id
    JOIN progressive_cfd_execution_recipes parent_recipe ON parent_recipe.id = parent.execution_recipe_id
    LEFT JOIN progressive_cfd_recovery_claims parent_claim ON parent_claim.attempt_token = parent.token
    LEFT JOIN progressive_cfd_recovery_plans parent_plan ON parent_plan.id = parent_claim.recovery_plan_id
    WHERE child_recipe.execution_revision_id = ${revisionId} AND child_job.airfoil_id = ${airfoilId}
      AND coalesce(parent_plan.ordinal, 0) < child_plan.ordinal
      AND parent_recipe.execution_revision_id <> child_recipe.execution_revision_id
    ORDER BY parent_recipe.execution_revision_id LIMIT 17
  `);
  if (parents.length > 16)
    throw new Error("Progressive cache recovery ancestry is unbounded");
  return parents.map((parent) => String(parent.id));
}
