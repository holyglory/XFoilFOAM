import { nextFastAnchor, PROGRESSIVE_COMPUTE_POLICY } from "@aerodb/core";
import type { ProgressivePolarEstimate } from "../../engine-client/src/progressive-polar";
import { sql } from "drizzle-orm";
import { canonicalAnalysisJson } from "./analysis-target";
import type { DB } from "./client";
import { advanceGeneration } from "./progressive-campaigns";

async function finishCampaigns(db: DB, epochId: string): Promise<number> {
  const completed = await db.execute(sql`
    WITH settled AS (
      SELECT campaign.id, CASE WHEN EXISTS (
        SELECT 1 FROM progressive_generations generation WHERE generation.campaign_id = campaign.id
          AND generation.epoch_id = ${epochId} AND generation.plan_revision_id = campaign.current_plan_revision_id
          AND generation.status = 'attention'
      ) THEN 'attention' ELSE 'completed' END AS status
      FROM sim_campaigns campaign WHERE campaign.status IN ('active', 'attention')
        AND (campaign.status = 'active' OR NOT EXISTS (SELECT 1 FROM progressive_generations generation
          WHERE generation.campaign_id = campaign.id AND generation.epoch_id = ${epochId}
            AND generation.plan_revision_id = campaign.current_plan_revision_id AND generation.status = 'attention'))
        AND EXISTS (SELECT 1 FROM progressive_generations generation WHERE generation.campaign_id = campaign.id
          AND generation.epoch_id = ${epochId} AND generation.plan_revision_id = campaign.current_plan_revision_id
          AND generation.status IN ('complete', 'attention'))
        AND NOT EXISTS (SELECT 1 FROM progressive_generations generation WHERE generation.campaign_id = campaign.id
          AND generation.epoch_id = ${epochId} AND generation.plan_revision_id = campaign.current_plan_revision_id AND generation.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM progressive_scope_requests request WHERE request.campaign_id = campaign.id
          AND (request.requested_version > request.processed_version OR request.error IS NOT NULL))
      ORDER BY campaign.priority DESC, campaign."createdAt", campaign.id LIMIT 32 FOR UPDATE SKIP LOCKED
    ) UPDATE sim_campaigns campaign SET status = settled.status, "updatedAt" = clock_timestamp(),
      "completedAt" = CASE WHEN settled.status = 'completed' THEN clock_timestamp() ELSE NULL END
      FROM settled WHERE campaign.id = settled.id AND campaign.status <> settled.status RETURNING campaign.id
  `);
  return completed.length;
}

export async function advanceProgressiveCfdStages(db: DB) {
  const hasEvidence = sql`EXISTS (
    SELECT 1 FROM progressive_cfd_evidence evidence JOIN progressive_cfd_attempts source_attempt ON source_attempt.token = evidence.attempt_token
    JOIN progressive_cfd_units source_unit ON source_unit.id = source_attempt.unit_id
    JOIN progressive_work source_work ON source_work.id = source_unit.work_id
    JOIN progressive_generations source_generation ON source_generation.id = source_work.generation_id
    WHERE source_work.target_id = work.target_id AND source_generation.epoch_id = generation.epoch_id
  )`;
  const ready = sql`
    NOT EXISTS (
      SELECT 1 FROM progressive_cfd_units unit JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id
      LEFT JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id = attempt.sim_job_id
      WHERE unit.work_id = work.id AND (attempt.outcome = 'running'
        OR (attempt.sim_job_id IS NOT NULL AND stopped.sim_job_id IS NULL))
    ) AND (work.stage = 3 OR (
      NOT EXISTS (
        SELECT 1 FROM progressive_work sibling WHERE sibling.generation_id = generation.id AND sibling.stage = 2
          AND sibling.state NOT IN ('complete', 'gap') AND (
            NOT EXISTS (SELECT 1 FROM progressive_cfd_units unit WHERE unit.work_id = sibling.id AND unit.purpose = 'initial')
            OR EXISTS (SELECT 1 FROM progressive_cfd_units unit WHERE unit.work_id = sibling.id AND unit.purpose = 'initial' AND unit.state NOT IN ('complete', 'gap'))
          )
      ) AND NOT EXISTS (
        SELECT 1 FROM progressive_work baseline JOIN progressive_prediction_links link ON link.work_id = baseline.id
        JOIN progressive_polar_fit_work fit ON fit.prediction_id = link.prediction_id
        WHERE baseline.generation_id = generation.id AND baseline.target_id = work.target_id AND baseline.stage = 1
          AND fit.state IN ('pending', 'leased') AND ${hasEvidence}
      )
    ))
  `;
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const receipt = {
      admitted: 0,
      closed: 0,
      waiting: 0,
      campaignsCompleted: 0,
    };
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (!epoch) throw new Error("Calculation epoch is missing");
    const [campaign] = await connection.execute(sql`
      SELECT campaign.id FROM sim_campaigns campaign
      WHERE campaign.status IN ('active', 'attention', 'paused') AND EXISTS (
        SELECT 1 FROM progressive_generations generation JOIN progressive_work work ON work.generation_id = generation.id
        WHERE generation.campaign_id = campaign.id AND generation.epoch_id = ${epoch.id}
          AND generation.plan_revision_id = campaign.current_plan_revision_id AND generation.status = 'active'
          AND generation.stage IN (2, 3) AND work.stage = generation.stage AND work.state = 'pending'
          AND EXISTS (SELECT 1 FROM progressive_cfd_units unit WHERE unit.work_id = work.id)
          AND NOT EXISTS (SELECT 1 FROM progressive_cfd_units unit WHERE unit.work_id = work.id AND unit.state NOT IN ('complete', 'gap'))
          AND ${ready}
      ) ORDER BY campaign.priority DESC, campaign."createdAt", campaign.id LIMIT 1 FOR UPDATE SKIP LOCKED
    `);
    if (!campaign) {
      receipt.campaignsCompleted = await finishCampaigns(
        connection,
        String(epoch.id),
      );
      return receipt;
    }
    const scopes = await connection.execute(sql`
      SELECT work.id, work.generation_id, work.target_id, work.stage, scope.angles,
        ${hasEvidence} AS has_cfd_evidence,
        fit.state AS fit_state, model.id AS model_id, model.response,
        NOT EXISTS (
          SELECT 1 FROM progressive_work sibling WHERE sibling.generation_id = generation.id AND sibling.stage = 2
            AND sibling.state NOT IN ('complete', 'gap')
            AND (NOT EXISTS (SELECT 1 FROM progressive_cfd_units unit WHERE unit.work_id = sibling.id AND unit.purpose = 'initial')
              OR EXISTS (SELECT 1 FROM progressive_cfd_units unit WHERE unit.work_id = sibling.id AND unit.purpose = 'initial'
                AND unit.state NOT IN ('complete', 'gap')))
        ) AS initial_coverage_complete
      FROM progressive_work work JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN progressive_generation_targets scope ON scope.generation_id = generation.id AND scope.target_id = work.target_id
      LEFT JOIN progressive_work baseline ON baseline.generation_id = generation.id AND baseline.target_id = work.target_id AND baseline.stage = 1
      LEFT JOIN progressive_prediction_links link ON link.work_id = baseline.id
      LEFT JOIN progressive_polar_fit_work fit ON fit.prediction_id = link.prediction_id
      LEFT JOIN progressive_polar_models model ON model.id = fit.model_id AND fit.state = 'ready'
      WHERE generation.campaign_id = ${campaign.id} AND generation.epoch_id = ${epoch.id}
        AND generation.plan_revision_id = (SELECT current_plan_revision_id FROM sim_campaigns WHERE id = ${campaign.id})
        AND generation.status = 'active' AND generation.stage IN (2, 3) AND work.stage = generation.stage AND work.state = 'pending'
        AND EXISTS (SELECT 1 FROM progressive_cfd_units unit WHERE unit.work_id = work.id)
        AND NOT EXISTS (SELECT 1 FROM progressive_cfd_units unit WHERE unit.work_id = work.id AND unit.state NOT IN ('complete', 'gap'))
        AND ${ready}
      ORDER BY generation.created_at, generation.id, work.target_id LIMIT 32 FOR UPDATE OF generation, work SKIP LOCKED
    `);
    for (const scope of scopes) {
      const units = await connection.execute(sql`
        SELECT unit.id, unit.aoa_deg, unit.ordinal, unit.recipe, unit.state,
          EXISTS (SELECT 1 FROM progressive_cfd_attempts attempt
            LEFT JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id = attempt.sim_job_id
            WHERE attempt.unit_id = unit.id AND (attempt.outcome = 'running' OR
              (attempt.sim_job_id IS NOT NULL AND stopped.sim_job_id IS NULL))) AS unsettled
        FROM progressive_cfd_units unit WHERE unit.work_id = ${scope.id} ORDER BY unit.ordinal FOR UPDATE OF unit
      `);
      if (
        !units.length ||
        units.some(
          (unit) =>
            unit.unsettled || !["complete", "gap"].includes(String(unit.state)),
        )
      ) {
        receipt.waiting += 1;
        continue;
      }
      const requestedAngles = scope.angles as number[];
      let alpha: number | null = null;
      let reason = "precise_requested_grid_complete";
      let costId: string | null = null;
      let costSeconds: number | null = null;
      let modelId: string | null = null;
      let candidates: Array<{
        alpha: number;
        integratedVarianceReductionFraction: number;
        expectedActiveSeconds: number;
        modelId: string;
        costEvidenceId: string;
      }> = [];
      if (Number(scope.stage) === 2) {
        if (!scope.initial_coverage_complete) {
          receipt.waiting += 1;
          continue;
        }
        if (
          scope.has_cfd_evidence &&
          ["pending", "leased"].includes(String(scope.fit_state))
        ) {
          receipt.waiting += 1;
          continue;
        }
        const model = (
          scope.response as { estimate?: ProgressivePolarEstimate } | null
        )?.estimate;
        if (
          !model ||
          model.version !== "progressive-polar-gp-v2" ||
          model.target_signature !== scope.target_id ||
          model.acquisition?.version !== "fixed-posterior-coverage-v1"
        ) {
          if (
            scope.fit_state === "gap" ||
            units.every((unit) => unit.state === "gap")
          )
            reason = "fast_model_unavailable_after_bounded_work";
          else {
            receipt.waiting += 1;
            continue;
          }
        } else if (!model.contributors.length) {
          reason = "fast_evidence_uninformative";
          modelId = String(scope.model_id);
        } else {
          modelId = String(scope.model_id);
          const costs = await connection.execute(sql`
            SELECT measured.result_attempt_id, measured.solver_active_seconds FROM (
            SELECT DISTINCT ON (attempt.token) evidence.result_attempt_id, evidence.solver_active_seconds FROM progressive_cfd_evidence evidence
            JOIN progressive_cfd_attempts attempt ON attempt.token = evidence.attempt_token
            JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
            WHERE unit.work_id = ${scope.id} AND evidence.solver_active_seconds > 0
              AND evidence.solver_active_seconds < 'Infinity'::double precision
            ORDER BY attempt.token, evidence.solver_active_seconds DESC, evidence.result_attempt_id
            ) measured ORDER BY measured.solver_active_seconds, measured.result_attempt_id
          `);
          if (costs.length) {
            const cost = costs[Math.floor(costs.length / 2)];
            costId = String(cost.result_attempt_id);
            costSeconds = Number(cost.solver_active_seconds);
            candidates = model.acquisition.candidates
              .filter((candidate) => requestedAngles.includes(candidate.alpha))
              .map((candidate) => ({
                alpha: candidate.alpha,
                integratedVarianceReductionFraction:
                  candidate.integrated_variance_reduction_fraction,
                expectedActiveSeconds: costSeconds!,
                modelId: modelId!,
                costEvidenceId: costId!,
              }));
          }
          const decision = nextFastAnchor({
            requestedAngles,
            attemptedAngles: units.map((unit) => Number(unit.aoa_deg)),
            initialCoverageComplete: true,
            candidates,
          });
          if (decision.reason === "no_measured_candidate") {
            const unobserved = new Set(
              model.acquisition.candidates.map((candidate) => candidate.alpha),
            );
            if (
              requestedAngles.every(
                (angle) =>
                  model.alpha.includes(angle) && !unobserved.has(angle),
              )
            )
              reason = "requested_grid_already_observed";
            else {
              receipt.waiting += 1;
              continue;
            }
          } else {
            alpha = decision.alpha;
            reason = decision.reason;
          }
        }
      } else if (
        requestedAngles.length !== units.length ||
        units.some((unit) => !requestedAngles.includes(Number(unit.aoa_deg)))
      ) {
        throw new Error(
          "Precise CFD closure does not cover the sealed requested angle list",
        );
      } else if (units.some((unit) => unit.state === "gap")) {
        reason = "precise_requested_grid_with_gaps";
      }
      const ordinal =
        Math.max(...units.map((unit) => Number(unit.ordinal))) + 1;
      const summary = {
        policyVersion: PROGRESSIVE_COMPUTE_POLICY.version,
        modelId,
        costEvidenceId: costId,
        expectedActiveSeconds: costSeconds,
        costPolicy: costId ? "observed_upper_median_same_target" : null,
        attemptedAngles: units.map((unit) => Number(unit.aoa_deg)),
        candidates,
      };
      await connection.execute(sql`
        INSERT INTO progressive_cfd_stage_decisions(work_id, ordinal, kind, reason, model_id, cost_evidence_id, candidate_alpha, summary)
        VALUES (${scope.id}, ${ordinal}, ${alpha !== null ? "adaptive" : Number(scope.stage) === 2 ? "close_fast" : "close_precise"},
          ${reason}, ${modelId}, ${costId}, ${alpha}, ${canonicalAnalysisJson(summary)}::jsonb)
      `);
      if (alpha !== null) {
        await connection.execute(sql`
          INSERT INTO progressive_cfd_units(work_id, aoa_deg, ordinal, purpose, recipe, reason, active_budget_seconds, policy_version)
          VALUES (${scope.id}, ${alpha}, ${ordinal}, 'adaptive', ${canonicalAnalysisJson(units[0].recipe)}::jsonb,
            ${reason}, ${PROGRESSIVE_COMPUTE_POLICY.fastAnchorActiveSeconds}, ${PROGRESSIVE_COMPUTE_POLICY.version})
        `);
        receipt.admitted += 1;
      } else {
        const gap =
          units.some((unit) => unit.state === "gap") ||
          reason.startsWith("fast_model_unavailable") ||
          reason === "fast_evidence_uninformative";
        await connection.execute(sql`
          UPDATE progressive_work SET state = ${gap ? "gap" : "complete"}, error = ${gap ? reason : null}, completed_at = clock_timestamp()
          WHERE id = ${scope.id}
        `);
        await advanceGeneration(connection, String(scope.generation_id));
        receipt.closed += 1;
      }
    }
    receipt.campaignsCompleted = await finishCampaigns(
      connection,
      String(epoch.id),
    );
    return receipt;
  });
}
