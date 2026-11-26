import { sql, type SQL } from "drizzle-orm";
import { PROGRESSIVE_COMPUTE_POLICY } from "@aerodb/core";
import type { DB } from "./client";
import {
  effectiveProgressiveStageSql,
  progressiveFastTargetSettledSql,
} from "./progressive-execution-policy";
import {
  progressiveCfdBoundedNoEvidenceRecoveryAvailableSql,
  progressiveCfdNoAcceptedHistoryAndSettledSql,
  progressiveCfdOrdinaryAttemptCountSql,
  progressiveCfdCompletionRetryAvailableSql,
  progressiveCfdMaterialPlanAllowsAttemptSql,
  progressiveCfdPreciseVerificationAvailableSql,
} from "./progressive-attempt-budget";
import { progressiveCfdMaterialGapRecoveryAvailableSql, verifyProgressiveCfdMaterialGap } from "./progressive-cfd-material-gap";
import { tryProgressiveAdmissionLock } from "./progressive-admission-lock";
import { STALE_HZ_RESET_REASON } from "./progressive-remote-stale-recovery";
import {
  progressiveCfdBudgetExtensionPendingSql,
  progressiveCfdEffectiveBudgetSql,
} from "./progressive-cfd-budget-extension";
import { recordProgressiveCfdRecoveryPlans } from "./progressive-cfd-numerical-recovery";
import { settleProgressiveCfdExecution } from "./progressive-cfd-settlement";

const TERMINAL_NO_EVIDENCE_REASON =
  "terminal execution has no measured case evidence";
const TERMINAL_NO_EVIDENCE_RETRY_REASON =
  "Retrying after terminal execution without measurable case evidence";
const RECOVERABLE_TERMINAL_GAP_REASONS = [
  TERMINAL_NO_EVIDENCE_REASON,
  "fast pass has no informative accepted evidence",
  "precise evidence remains unresolved",
  "Stale HZ remote execution released during disposable solver reset",
  "obsolete execution physically stopped",
  "unstarted submission retry budget exhausted or history incomplete",
] as const;
const RECOVERABLE_TERMINAL_GAP_REASONS_SQL = sql`(${sql.join(
  RECOVERABLE_TERMINAL_GAP_REASONS.map((reason) => sql`${reason}`),
  sql`, `,
)})`;
const PROGRESSIVE_INACTIVE_RECOVERY_UNITS_PER_PASS = 64;
const PROGRESSIVE_TERMINAL_RECOVERY_UNITS_PER_PASS = 64;

export async function recoverUnboundProgressiveCfdLeases(
  db: DB,
): Promise<{ retried: number; gaps: number }> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const receipt = { retried: 0, gaps: 0 };
    if (!(await tryProgressiveAdmissionLock(connection))) return receipt;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (!epoch) throw new Error("Calculation epoch is missing");
    const [campaign] = await connection.execute(sql`
      SELECT campaign.id FROM sim_campaigns campaign WHERE campaign.status IN ('active', 'attention', 'paused') AND EXISTS (
        SELECT 1 FROM progressive_generations generation JOIN progressive_work work ON work.generation_id = generation.id
        JOIN progressive_cfd_units unit ON unit.work_id = work.id
        JOIN progressive_cfd_attempts attempt ON attempt.token = unit.lease_token AND attempt.unit_id = unit.id
        WHERE generation.campaign_id = campaign.id AND generation.epoch_id = ${epoch.id}
          AND generation.plan_revision_id = campaign.current_plan_revision_id AND generation.status = 'active'
          AND ${effectiveProgressiveStageSql()} = work.stage AND work.state = 'pending'
          AND unit.state = 'leased' AND unit.lease_until <= clock_timestamp()
          AND attempt.outcome = 'running' AND attempt.sim_job_id IS NULL
      ) ORDER BY campaign.priority DESC, campaign."createdAt", campaign.id LIMIT 1 FOR UPDATE SKIP LOCKED
    `);
    if (!campaign) return receipt;
    const units = await connection.execute(sql`
      SELECT unit.id, unit.lease_token, unit.attempts, unit.active_seconds, unit.active_budget_seconds,
        ${progressiveCfdOrdinaryAttemptCountSql()} AS ordinary_attempts,
        ${progressiveCfdMaterialPlanAllowsAttemptSql()} AS material_plan_allows_attempt
      FROM progressive_cfd_units unit JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN progressive_cfd_attempts attempt ON attempt.token = unit.lease_token AND attempt.unit_id = unit.id
      WHERE generation.campaign_id = ${campaign.id} AND generation.epoch_id = ${epoch.id}
        AND generation.plan_revision_id = (SELECT current_plan_revision_id FROM sim_campaigns WHERE id = ${campaign.id})
        AND generation.status = 'active' AND ${effectiveProgressiveStageSql()} = work.stage AND work.state = 'pending'
        AND unit.state = 'leased' AND unit.lease_until <= clock_timestamp()
        AND attempt.outcome = 'running' AND attempt.sim_job_id IS NULL
      ORDER BY unit.lease_until, unit.id LIMIT 64 FOR UPDATE OF work, unit, attempt SKIP LOCKED
    `);
    for (const unit of units) {
      const retry =
        unit.material_plan_allows_attempt === true &&
        Number(unit.ordinary_attempts) < 2 &&
        Number(unit.active_seconds) < Number(unit.active_budget_seconds);
      const reason = retry
        ? "unbound claim expired before engine submission"
        : "bounded unbound claim retries exhausted";
      await connection.execute(sql`
        UPDATE progressive_cfd_attempts SET outcome = 'expired', finished_at = clock_timestamp(), error = ${reason}
        WHERE token = ${unit.lease_token}
      `);
      await connection.execute(sql`
        UPDATE progressive_cfd_units SET state = ${retry ? "pending" : "gap"}, lease_token = NULL,
          lease_owner = NULL, lease_until = NULL, error = ${reason} WHERE id = ${unit.id}
      `);
      if (retry) receipt.retried += 1;
      else receipt.gaps += 1;
    }
    return receipt;
  });
}

export async function recoverInactiveProgressiveRemoteGaps(
  db: DB,
): Promise<number> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    if (!(await tryProgressiveAdmissionLock(connection))) return 0;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (!epoch) throw new Error("Calculation epoch is missing");
    const units = await connection.execute(sql`
      SELECT unit.id, unit.work_id
      FROM progressive_cfd_units unit
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      WHERE generation.epoch_id = ${epoch.id}
        AND generation.status = 'active'
        AND generation.plan_revision_id = campaign.current_plan_revision_id
        AND ${effectiveProgressiveStageSql()} = work.stage
        AND work.state IN ('pending', 'gap')
        AND campaign.status IN ('active', 'attention', 'paused')
        AND unit.state = 'gap'
        AND unit.error = 'Inactive remote delivery has unresolved evidence'
        AND ${progressiveCfdMaterialPlanAllowsAttemptSql()}
        AND unit.attempts < 3
        AND unit.active_seconds < unit.active_budget_seconds
      ORDER BY unit.id
      LIMIT ${PROGRESSIVE_INACTIVE_RECOVERY_UNITS_PER_PASS}
      FOR UPDATE OF work, unit SKIP LOCKED
    `);
    for (const unit of units) {
      await connection.execute(sql`
        UPDATE results result
        SET status = 'pending', source = 'queued', sim_job_id = NULL,
          engine_job_id = NULL, error = NULL, "updatedAt" = clock_timestamp()
        FROM progressive_cfd_attempts attempt
        JOIN progressive_cfd_units previous_unit ON previous_unit.id = attempt.unit_id
        JOIN result_attempts raw ON raw.sim_job_id = attempt.sim_job_id
        JOIN progressive_cfd_execution_stops stopped
          ON stopped.sim_job_id = attempt.sim_job_id
          AND stopped.engine_job_id = attempt.sim_job_id::text
        WHERE attempt.unit_id = ${unit.id}::uuid
          AND previous_unit.work_id = ${unit.work_id}::uuid
          AND attempt.sim_job_id IS NOT NULL
          AND raw.result_id = result.id
          AND result.status = 'queued'
          AND NOT EXISTS (
            SELECT 1 FROM result_classifications classification
            WHERE classification.result_id = result.id
              AND classification.state = 'accepted'
          )
      `);
      await connection.execute(sql`
        UPDATE progressive_cfd_units
        SET state = 'pending', lease_token = NULL, lease_owner = NULL,
          lease_until = NULL, retry_after = NULL,
          error = 'Retrying after inactive remote delivery'
        WHERE id = ${unit.id}::uuid
      `);
    }
    return units.length;
  });
}

const SPENT_MATERIAL_CAMPAIGNS_PER_PASS = 8;

type SpentMaterialPage = { settled: number; busy: boolean; continueAfter?: string };

/** Inspect bounded current campaign keys. Each candidate has its own transaction
 * and only one campaign can commit up to 64 existing gaps in a call. */
export async function settleSpentProgressiveMaterialGaps(db: DB, afterCampaign?: string): Promise<SpentMaterialPage> {
  const campaigns = await db.execute<{ id: string; epoch: string }>(sql`
    SELECT campaign.id, epoch.id AS epoch FROM calculation_epochs epoch CROSS JOIN sim_campaigns campaign
    WHERE epoch.current AND campaign.status IN ('active','attention','paused')
      ${afterCampaign ? sql`AND campaign.id>${afterCampaign}::uuid` : sql``}
      AND EXISTS (SELECT FROM progressive_generations generation WHERE generation.campaign_id=campaign.id
        AND generation.epoch_id=epoch.id AND generation.status='active'
        AND generation.plan_revision_id=campaign.current_plan_revision_id)
    ORDER BY campaign.id LIMIT ${SPENT_MATERIAL_CAMPAIGNS_PER_PASS + 1}
  `);
  let busy = false;
  for (const campaign of campaigns.slice(0, SPENT_MATERIAL_CAMPAIGNS_PER_PASS)) {
    const page = await settleSpentMaterialCampaign(db, campaign.id, campaign.epoch);
    if (page === "admission-busy") return { settled: 0, busy: true, continueAfter: afterCampaign };
    if (page === "campaign-busy") busy = true;
    else if (page) return { settled: page, busy: false, continueAfter: afterCampaign };
  }
  const more = campaigns.length > SPENT_MATERIAL_CAMPAIGNS_PER_PASS;
  return { settled: 0, busy, continueAfter: more ? campaigns[SPENT_MATERIAL_CAMPAIGNS_PER_PASS - 1]!.id : undefined };
}

async function settleSpentMaterialCampaign(db: DB, campaignId: string, epochId: string) {
  // A bound campaign key lets PostgreSQL seek the corresponding generations
  // on a large live ledger. All eligibility facts are checked again after locking.
  const pending = sql`pending_material AS MATERIALIZED (
    SELECT plan.id AS plan_id, unit.id AS unit_id, generation.campaign_id
    FROM progressive_cfd_recovery_plans plan
    JOIN progressive_cfd_units unit ON unit.id=plan.unit_id
    JOIN progressive_work work ON work.id=unit.work_id
    JOIN progressive_generations generation ON generation.id=work.generation_id
    JOIN sim_campaigns campaign ON campaign.id=generation.campaign_id
    WHERE plan.reason='material_domain' AND plan.ordinal=1 AND plan.scope='targeted'
      AND unit.state='pending' AND unit.lease_token IS NULL AND work.state IN ('pending','gap')
      AND generation.epoch_id=${epochId}::uuid AND generation.status='active'
      AND campaign.id=${campaignId}::uuid AND campaign.current_plan_revision_id=generation.plan_revision_id
      AND campaign.status IN ('active','attention','paused')
  )`;
  const key = sql`${campaignId}::uuid`;
  return db.transaction(async tx => {
    const connection = tx as unknown as DB;
    const [candidate] = await connection.execute(sql`
      WITH ${pending} ${spentMaterialUnits(epochId, key, false)} LIMIT 1
    `);
    if (!candidate) return 0;
    const [epoch] = await connection.execute(sql`SELECT id FROM calculation_epochs
      WHERE id=${epochId}::uuid AND current FOR SHARE SKIP LOCKED`);
    if (!epoch || !(await tryProgressiveAdmissionLock(connection))) return "admission-busy";
    const [campaign] = await connection.execute(sql`SELECT id FROM sim_campaigns
      WHERE id=${key} AND status IN ('active','attention','paused') FOR UPDATE SKIP LOCKED`);
    if (!campaign) return "campaign-busy";

    const page = await connection.execute(sql`
      WITH ${pending}, spent_material AS MATERIALIZED (
        ${spentMaterialUnits(epochId, key, true)}
        LIMIT ${PROGRESSIVE_TERMINAL_RECOVERY_UNITS_PER_PASS}
      )
      UPDATE progressive_cfd_units unit SET state='gap', retry_after=NULL, error=spent_material.error
      FROM spent_material WHERE unit.id=spent_material.id AND unit.state='pending' AND unit.lease_token IS NULL
      RETURNING unit.id
    `);
    return page.length || "campaign-busy";
  });
}

function spentMaterialUnits(epochId: string, campaign: SQL, lock: boolean) {
  return sql`SELECT eligible.id, eligible.error
    FROM pending_material material CROSS JOIN LATERAL (
      SELECT unit.id, attempt.error
      FROM progressive_cfd_units unit
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      JOIN progressive_cfd_recovery_claims claim ON claim.recovery_plan_id = material.plan_id
      JOIN progressive_cfd_attempts attempt ON attempt.token = claim.attempt_token AND attempt.unit_id = unit.id
      JOIN sim_jobs job ON job.id = attempt.sim_job_id
      JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id = job.id AND stopped.engine_job_id = job.engine_job_id
      WHERE unit.id=material.unit_id AND generation.epoch_id = ${epochId} AND campaign.id=material.campaign_id
        AND generation.plan_revision_id = campaign.current_plan_revision_id AND generation.status = 'active'
        AND ${effectiveProgressiveStageSql()} = work.stage AND work.state IN ('pending','gap')
        AND unit.state = 'pending' AND unit.lease_token IS NULL AND unit.lease_owner IS NULL AND unit.lease_until IS NULL
        AND attempt.outcome IN ('failed','cancelled') AND attempt.finished_at IS NOT NULL
        AND attempt.error IN ${RECOVERABLE_TERMINAL_GAP_REASONS_SQL}
        AND job.status IN ('done','failed','cancelled') AND job."ingestedAt" IS NOT NULL
        AND NOT EXISTS (SELECT FROM progressive_cfd_attempts later WHERE later.unit_id = unit.id
          AND (later.started_at,later.token) > (attempt.started_at,attempt.token))
        AND NOT ${progressiveCfdMaterialPlanAllowsAttemptSql()}
        AND NOT EXISTS (SELECT FROM progressive_cfd_budget_extensions e WHERE e.unit_id=unit.id AND e.state IN ('pending','claimed'))
        AND NOT EXISTS (SELECT FROM progressive_cfd_evidence_reuses reuse WHERE reuse.successor_unit_id=unit.id)
        AND ${progressiveCfdNoAcceptedHistoryAndSettledSql()}
        -- Ingestion can persist valid evidence before attaching its CFD receipt.
        AND NOT EXISTS (
          SELECT FROM progressive_cfd_attempts history
          JOIN sim_jobs origin ON origin.id=history.sim_job_id
          JOIN result_attempts late ON late.sim_job_id=origin.id AND late.engine_job_id=origin.engine_job_id
            AND late.simulation_preset_revision_id=origin.simulation_preset_revision_id AND late.aoa_deg=unit.aoa_deg
          WHERE history.unit_id=unit.id AND late.status='done' AND late.valid_for_polar
        )
        AND NOT EXISTS (
          SELECT FROM progressive_cfd_evidence e
          JOIN LATERAL (
            SELECT fit.state, fit.model_id FROM neuralfoil_predictions p JOIN progressive_polar_fit_work fit ON fit.prediction_id=p.id
            WHERE p.target_id=work.target_id AND p.epoch_id=generation.epoch_id ORDER BY p.created_at DESC,p.id DESC LIMIT 1
          ) current_fit ON true
          LEFT JOIN progressive_polar_models model ON model.id=current_fit.model_id AND current_fit.state='ready'
          WHERE work.stage=2 AND e.attempt_token=attempt.token AND (current_fit.state IN ('pending','leased')
            OR model.response#>'{estimate,contributors}' @> jsonb_build_array(jsonb_build_object('attempt_id',e.result_attempt_id::text)))
        )
      LIMIT 1 ${lock ? sql`FOR UPDATE OF work, unit, attempt, job SKIP LOCKED` : sql``}
    ) eligible WHERE material.campaign_id=${campaign}`;
}

// Existing callers receive the number of retries. Closing an already-spent
// fallback has never been a retry or an admission.
export async function recoverTerminalProgressiveNoEvidenceGaps(db: DB): Promise<number> {
  let after: string | undefined;
  do {
    const page = await settleSpentProgressiveMaterialGaps(db, after);
    if (page.settled || page.busy) break;
    after = page.continueAfter;
  } while (after);
  return retryTerminalProgressiveNoEvidenceGaps(db);
}

async function recoverLateRhoPimplePreciseGaps(db: DB): Promise<number> {
  const candidates = await db.execute(sql`
    SELECT DISTINCT job.id, job."updatedAt"
    FROM sim_jobs job
    JOIN progressive_cfd_attempts attempt ON attempt.sim_job_id = job.id
    JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
    JOIN progressive_work work ON work.id = unit.work_id
    JOIN progressive_generations generation ON generation.id = work.generation_id
    JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
    JOIN progressive_cfd_evidence evidence ON evidence.attempt_token = attempt.token
    WHERE job.status = 'failed'
      AND job."ingestedAt" <= clock_timestamp() - interval '5 minutes'
      AND job.request_payload->'engineRequest'->'solver'->>'flow_solver_family' = 'rhoPimpleFoam'
      AND work.stage = 3
      AND unit.state = 'gap'
      AND unit.error = 'precise evidence remains unresolved'
      AND NOT EXISTS (
        SELECT 1
        FROM progressive_cfd_attempts fallback_attempt
        JOIN progressive_cfd_execution_recipes fallback_recipe
          ON fallback_recipe.id = fallback_attempt.execution_recipe_id
        WHERE fallback_attempt.sim_job_id = job.id
          AND fallback_recipe.recipe->'selection'->>'reason' = 'bounded_hard_solver_recovery'
      )
      AND generation.status = 'active'
      AND generation.plan_revision_id = campaign.current_plan_revision_id
      AND campaign.status IN ('active', 'attention', 'paused')
    ORDER BY job."updatedAt", job.id
    LIMIT 32
  `);
  let recovered = 0;
  for (const candidate of candidates) {
    try {
      const planned = await recordProgressiveCfdRecoveryPlans(
        db,
        String(candidate.id),
      );
      if (planned) {
        const settled = await settleProgressiveCfdExecution(
          db,
          String(candidate.id),
        );
        recovered += Number(settled.retry ?? planned);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message !== "Obsolete or settled progressive CFD execution scope" &&
        message !== "Numerical recovery requires a progressive parent execution"
      )
        throw error;
    }
  }
  return recovered;
}

export async function retryTerminalProgressiveNoEvidenceGaps(
  db: DB,
): Promise<number> {
  const recovered = await db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (!epoch) throw new Error("Calculation epoch is missing");
    if (!(await tryProgressiveAdmissionLock(connection))) return 0;
    // Campaign control owns the outer mutex, before any unit or job lock.
    const campaigns = await connection.execute(sql`
      SELECT campaign.id FROM sim_campaigns campaign
      WHERE campaign.status IN ('active', 'attention', 'paused') AND EXISTS (
        SELECT 1 FROM progressive_generations generation
        JOIN progressive_work work ON work.generation_id = generation.id
        JOIN progressive_cfd_units unit ON unit.work_id = work.id
        WHERE generation.campaign_id = campaign.id AND generation.epoch_id = ${epoch.id}
          AND generation.status = 'active' AND generation.plan_revision_id = campaign.current_plan_revision_id
          AND work.state IN ('pending', 'gap') AND unit.state IN ('leased', 'gap', 'pending')
      ) ORDER BY campaign.id FOR UPDATE SKIP LOCKED
    `);
    if (!campaigns.length) return 0;
    const campaignIds = sql.join(campaigns.map((campaign) => sql`${campaign.id}::uuid`), sql`, `);
    await connection.execute(sql`
      WITH stranded AS MATERIALIZED (
        SELECT attempt.token, unit.id AS unit_id
        FROM progressive_cfd_attempts attempt
        JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
        JOIN progressive_work work ON work.id = unit.work_id
        JOIN progressive_generations generation ON generation.id = work.generation_id
        JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
        JOIN sim_jobs job ON job.id = attempt.sim_job_id
        JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id = job.id
          AND stopped.engine_job_id = job.engine_job_id
        WHERE generation.epoch_id = ${epoch.id}
          AND generation.campaign_id IN (${campaignIds})
          AND generation.status = 'active'
          AND generation.plan_revision_id = campaign.current_plan_revision_id
          AND ${effectiveProgressiveStageSql()} = work.stage
          AND work.state IN ('pending', 'gap')
          AND campaign.status IN ('active', 'attention', 'paused')
          AND unit.state = 'leased'
          AND attempt.outcome = 'running'
          AND job.status IN ('ingesting', 'done', 'failed', 'cancelled')
          AND job.engine_state IN ('completed', 'failed', 'cancelled')
          AND job."updatedAt" <= clock_timestamp() - interval '15 minutes'
          -- Compaction is never proof that physical evidence was absent. These
          -- terminal jobs must use the exact report/evidence recovery readers.
          AND NOT EXISTS (
            SELECT 1 FROM progressive_remote_reports archived
            WHERE archived.sim_job_id=job.id
              AND (to_jsonb(archived.*)->>'archived_at' IS NOT NULL
                OR to_jsonb(archived.*)->>'archive_bundle_id' IS NOT NULL
                OR archived.report->>'archivedReport'='true')
          )
          AND NOT EXISTS (
            SELECT 1 FROM progressive_cfd_evidence evidence
            WHERE evidence.attempt_token = attempt.token
          )
          AND NOT EXISTS (
            SELECT 1
            FROM progressive_remote_dispatches dispatch
            JOIN LATERAL (
              SELECT report.sequence, report.content_signature, report.report, report.result_payload_hash
              FROM progressive_remote_reports report
              WHERE report.sim_job_id = dispatch.sim_job_id
              ORDER BY report.sequence DESC LIMIT 1
            ) latest ON true
            JOIN progressive_remote_report_inventories inventory
              ON inventory.sim_job_id = dispatch.sim_job_id
              AND inventory.sequence = latest.sequence
              AND inventory.report_content_signature = latest.content_signature
            JOIN progressive_remote_report_sources source
              ON source.sim_job_id = inventory.sim_job_id
              AND source.sequence = inventory.sequence
              AND source.aoa_deg = unit.aoa_deg
            WHERE dispatch.sim_job_id = job.id
              AND job.engine_job_id = dispatch.sim_job_id::text
              AND latest.report->>'assignmentSignature' = dispatch.content_signature
              AND latest.report#>>'{stopProof,execution_stopped}' = 'true'
              AND latest.report#>>'{status,state}' IN ('completed', 'failed', 'cancelled')
              AND latest.report#>>'{result,state}' IN ('completed', 'failed', 'cancelled')
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(public.resolve_progressive_report(latest.report, latest.result_payload_hash)#>'{result,polars}') polar(value)
                CROSS JOIN LATERAL jsonb_array_elements(
                  coalesce(polar.value->'points', '[]'::jsonb)
                  || coalesce(polar.value->'attempts', '[]'::jsonb)
                ) physical_point(value)
                WHERE (physical_point.value->>'aoa_deg')::double precision = source.aoa_deg
                  AND physical_point.value->>'case_slug' IS NOT DISTINCT FROM source.case_slug
                  AND (
                    physical_point.value->>'cl' IS NOT NULL
                    OR physical_point.value->>'cd' IS NOT NULL
                    OR physical_point.value->>'cm' IS NOT NULL
                    OR (
                      jsonb_typeof(physical_point.value->'evidence_artifacts') = 'array'
                      AND physical_point.value->'evidence_artifacts' <> '[]'::jsonb
                    )
                  )
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM progressive_cfd_attempts newer
            WHERE newer.unit_id = unit.id
              AND (newer.started_at, newer.token) > (attempt.started_at, attempt.token)
          )
        ORDER BY unit.id
        LIMIT ${PROGRESSIVE_TERMINAL_RECOVERY_UNITS_PER_PASS}
        FOR UPDATE OF attempt, unit, job SKIP LOCKED
      ), changed AS (
        UPDATE progressive_cfd_attempts attempt
        SET outcome = 'failed', finished_at = clock_timestamp(),
            error = ${TERMINAL_NO_EVIDENCE_REASON}
        FROM stranded
        WHERE attempt.token = stranded.token
        RETURNING stranded.unit_id
      )
      UPDATE progressive_cfd_units unit
      SET state = 'gap', lease_token = NULL, lease_owner = NULL,
          lease_until = NULL, error = ${TERMINAL_NO_EVIDENCE_REASON}
      FROM changed
      WHERE unit.id = changed.unit_id
    `);
    const ordinaryAttempts = progressiveCfdOrdinaryAttemptCountSql();
    const pendingBudgetExtension = progressiveCfdBudgetExtensionPendingSql(
      sql`unit`,
    );
    const publicationRecovery = sql`EXISTS (
      SELECT 1 FROM progressive_publication_recoveries recovery
      WHERE recovery.unit_id = unit.id
        AND recovery.attempts_before = unit.attempts
        AND unit.active_seconds >= recovery.active_seconds
        AND NOT EXISTS (
          SELECT 1 FROM progressive_publication_recovery_claims claimed
          WHERE claimed.unit_id = recovery.unit_id
        )
    )`;
    const attemptAvailable = sql`(
      ${ordinaryAttempts} < 2
      OR ${progressiveCfdCompletionRetryAvailableSql()}
      OR ${publicationRecovery}
      OR (
        ${ordinaryAttempts} = 2
        AND work.stage = 3
        AND unit.policy_version = ${PROGRESSIVE_COMPUTE_POLICY.version}
        AND ${progressiveCfdPreciseVerificationAvailableSql()}
      )
      OR (
        ${ordinaryAttempts} = 2
        AND work.stage = 2
        AND unit.purpose = 'initial'
        AND ${pendingBudgetExtension}
      )
    )`;
    const materialPlanAllowsAttempt = progressiveCfdMaterialPlanAllowsAttemptSql();
    const requeueEligible = sql`${materialPlanAllowsAttempt} AND unit.active_seconds < ${progressiveCfdEffectiveBudgetSql(sql`unit`)}
      AND (unit.attempts = 3 OR ${attemptAvailable})`;
    const claimEligible = sql`${materialPlanAllowsAttempt} AND ${attemptAvailable}
      AND unit.active_seconds < ${progressiveCfdEffectiveBudgetSql(sql`unit`)}`;
    const units = await connection.execute(sql`
      SELECT unit.id, unit.work_id, attempt.token,
        EXISTS (SELECT 1 FROM progressive_cfd_evidence evidence WHERE evidence.attempt_token = attempt.token) AS has_evidence
      FROM progressive_cfd_units unit
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id
      JOIN sim_jobs attempt_job
        ON attempt_job.id = attempt.sim_job_id
        AND attempt_job.campaign_id = campaign.id
      LEFT JOIN progressive_cfd_execution_stops stopped
        ON stopped.sim_job_id = attempt_job.id
        AND stopped.engine_job_id = attempt_job.engine_job_id
      WHERE generation.epoch_id = ${epoch.id}
          AND generation.campaign_id IN (${campaignIds})
        AND generation.status = 'active'
        AND generation.plan_revision_id = campaign.current_plan_revision_id
        AND ${effectiveProgressiveStageSql()} = work.stage
        AND work.state IN ('pending', 'gap')
        AND campaign.status IN ('active', 'attention', 'paused')
        AND unit.state IN ('gap', 'pending')
        AND (work.stage <> 3 OR ${progressiveFastTargetSettledSql()})
        AND (
          (unit.state = 'gap' AND unit.error IN ${RECOVERABLE_TERMINAL_GAP_REASONS_SQL})
          OR (
            unit.state = 'pending'
            AND unit.error = ${TERMINAL_NO_EVIDENCE_RETRY_REASON}
            AND ${materialPlanAllowsAttempt}
          )
        )
        AND unit.lease_token IS NULL
        AND unit.lease_owner IS NULL
        AND unit.lease_until IS NULL
        AND (unit.retry_after IS NULL OR unit.retry_after <= clock_timestamp())
        AND (
          unit.error NOT IN (
            'obsolete execution physically stopped',
            'unstarted submission retry budget exhausted or history incomplete'
          )
          OR NOT EXISTS (
            SELECT 1 FROM registered_remote_solvers remote
            WHERE remote.revoked_at IS NULL
              AND NULLIF(remote.metadata#>>'{health,cpu,loadPct}', '')::double precision >= 90
          )
        )
        AND (
          attempt.outcome = 'failed'
          OR (
            attempt.outcome = 'cancelled'
            AND attempt.active_seconds = 0
            AND stopped.proof->>'ownership_basis' IN (
              'never_started_cancellation_fence',
              'recorded_execution_namespace'
            )
          )
        )
        AND attempt.sim_job_id IS NOT NULL
        AND attempt.error IN ${RECOVERABLE_TERMINAL_GAP_REASONS_SQL}
        AND (
          (unit.state = 'gap' AND attempt.error = unit.error)
          OR (
            unit.state = 'pending'
            AND unit.error = ${TERMINAL_NO_EVIDENCE_RETRY_REASON}
          )
        )
        AND (
          unit.attempts < 3
          OR ${progressiveCfdMaterialGapRecoveryAvailableSql()}
          OR ${progressiveCfdBoundedNoEvidenceRecoveryAvailableSql()}
        )
        AND (
          stopped.sim_job_id IS NOT NULL
          OR (
            attempt.error = ${STALE_HZ_RESET_REASON}
            AND attempt.outcome = 'failed'
            AND attempt_job.status = 'cancelled'
            AND attempt_job.engine_state = 'cancelled'
            AND attempt_job.engine_job_id IS NULL
          )
        )
        AND ${progressiveCfdNoAcceptedHistoryAndSettledSql()}
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_attempts newer
          WHERE newer.unit_id = unit.id
            AND (newer.started_at, newer.token) > (attempt.started_at, attempt.token)
        )
        AND (
          (
            NOT EXISTS (SELECT 1 FROM progressive_cfd_evidence evidence WHERE evidence.attempt_token = attempt.token)
            AND (unit.attempts < 3 OR ${progressiveCfdBoundedNoEvidenceRecoveryAvailableSql()})
            AND ((unit.state = 'gap' AND ${requeueEligible})
              OR (unit.state = 'pending' AND NOT (${claimEligible})))
          )
          OR ${progressiveCfdMaterialGapRecoveryAvailableSql()}
        )
      ORDER BY unit.attempts, unit.id
      LIMIT ${PROGRESSIVE_TERMINAL_RECOVERY_UNITS_PER_PASS}
      FOR UPDATE OF work, unit, attempt, attempt_job SKIP LOCKED
    `);
    let recovered = 0;
    for (const unit of units) {
      if (unit.has_evidence && !(await verifyProgressiveCfdMaterialGap(connection, String(unit.id), String(unit.token)))) continue;
      const [requeued] = await connection.execute(sql`
        UPDATE progressive_cfd_units AS unit
        SET state = 'pending', lease_token = NULL, lease_owner = NULL,
          lease_until = NULL,
          retry_after = CASE WHEN unit.error IN (
            'obsolete execution physically stopped',
            'unstarted submission retry budget exhausted or history incomplete'
          ) THEN clock_timestamp() + interval '5 minutes' ELSE NULL END,
          error = CASE WHEN unit.attempts >= 2
            THEN unit.error ELSE ${TERMINAL_NO_EVIDENCE_RETRY_REASON} END
        FROM progressive_work work
        WHERE unit.id = ${unit.id}::uuid
          AND work.id = unit.work_id
          AND unit.state = 'gap'
          AND ${requeueEligible}
        RETURNING unit.id
      `);
      if (requeued) {
        await connection.execute(sql`
          UPDATE progressive_work
          SET state = 'pending', error = NULL, completed_at = NULL
          WHERE id = ${unit.work_id}::uuid AND state = 'gap'
        `);
        recovered += 1;
        continue;
      }
      await connection.execute(sql`
        UPDATE progressive_cfd_units AS unit
        SET state = 'gap', lease_token = NULL, lease_owner = NULL,
          lease_until = NULL, retry_after = NULL,
          error = ${TERMINAL_NO_EVIDENCE_REASON}
        FROM progressive_work work
        WHERE unit.id = ${unit.id}::uuid
          AND work.id = unit.work_id
          AND unit.state = 'pending'
          AND NOT (${claimEligible})
        RETURNING unit.id
      `);
    }
    return recovered;
  });
  return recovered + (await recoverLateRhoPimplePreciseGaps(db));
}
