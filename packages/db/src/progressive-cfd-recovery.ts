import { sql } from "drizzle-orm";
import { PROGRESSIVE_COMPUTE_POLICY } from "@aerodb/core";
import type { DB } from "./client";
import { effectiveProgressiveStageSql } from "./progressive-execution-policy";
import {
  progressiveCfdOrdinaryAttemptCountSql,
  progressiveCfdCompletionRetryAvailableSql,
  progressiveCfdPreciseVerificationAvailableSql,
} from "./progressive-attempt-budget";
import { acquireProgressiveAdmissionLock } from "./progressive-admission-lock";
import {
  progressiveCfdBudgetExtensionPendingSql,
  progressiveCfdEffectiveBudgetSql,
} from "./progressive-cfd-budget-extension";

const TERMINAL_NO_EVIDENCE_REASON =
  "terminal execution has no measured case evidence";
const TERMINAL_NO_EVIDENCE_RETRY_REASON =
  "Retrying after terminal execution without measurable case evidence";
const RECOVERABLE_TERMINAL_GAP_REASONS = [
  TERMINAL_NO_EVIDENCE_REASON,
  "fast pass has no informative accepted evidence",
  "precise evidence remains unresolved",
  "Stale HZ remote execution released during disposable solver reset",
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
    await acquireProgressiveAdmissionLock(connection);
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
        ${progressiveCfdOrdinaryAttemptCountSql()} AS ordinary_attempts
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
    await acquireProgressiveAdmissionLock(connection);
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

export async function recoverTerminalProgressiveNoEvidenceGaps(
  db: DB,
): Promise<number> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await acquireProgressiveAdmissionLock(connection);
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (!epoch) throw new Error("Calculation epoch is missing");
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
          AND NOT EXISTS (
            SELECT 1 FROM progressive_cfd_evidence evidence
            WHERE evidence.attempt_token = attempt.token
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
    const claimEligible = sql`${attemptAvailable}
      AND unit.active_seconds < ${progressiveCfdEffectiveBudgetSql(sql`unit`)}`;
    const units = await connection.execute(sql`
      SELECT unit.id, unit.work_id
      FROM progressive_cfd_units unit
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id
      JOIN progressive_cfd_execution_stops stopped
        ON stopped.sim_job_id = attempt.sim_job_id
        AND stopped.engine_job_id = attempt.sim_job_id::text
      WHERE generation.epoch_id = ${epoch.id}
        AND generation.status = 'active'
        AND generation.plan_revision_id = campaign.current_plan_revision_id
        AND ${effectiveProgressiveStageSql()} = work.stage
        AND work.state IN ('pending', 'gap')
        AND campaign.status IN ('active', 'attention', 'paused')
        AND unit.state IN ('gap', 'pending')
        AND (
          (unit.state = 'gap' AND unit.error IN ${RECOVERABLE_TERMINAL_GAP_REASONS_SQL})
          OR (
            unit.state = 'pending'
            AND unit.error = ${TERMINAL_NO_EVIDENCE_RETRY_REASON}
          )
        )
        AND unit.attempts < 3
        AND unit.lease_token IS NULL
        AND unit.lease_owner IS NULL
        AND unit.lease_until IS NULL
        AND attempt.outcome = 'failed'
        AND attempt.sim_job_id IS NOT NULL
        AND attempt.error IN ${RECOVERABLE_TERMINAL_GAP_REASONS_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_attempts newer
          WHERE newer.unit_id = unit.id
            AND (newer.started_at, newer.token) > (attempt.started_at, attempt.token)
        )
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_attempts active
          WHERE active.unit_id = unit.id AND active.outcome = 'running'
        )
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_attempts unsettled
          LEFT JOIN progressive_cfd_execution_stops unsettled_stop
            ON unsettled_stop.sim_job_id = unsettled.sim_job_id
          WHERE unsettled.unit_id = unit.id
            AND unsettled.sim_job_id IS NOT NULL
            AND unsettled_stop.sim_job_id IS NULL
        )
      ORDER BY unit.attempts, unit.id
      LIMIT ${PROGRESSIVE_TERMINAL_RECOVERY_UNITS_PER_PASS}
      FOR UPDATE OF work, unit, attempt SKIP LOCKED
    `);
    let recovered = 0;
    for (const unit of units) {
      const [requeued] = await connection.execute(sql`
        UPDATE progressive_cfd_units AS unit
        SET state = 'pending', lease_token = NULL, lease_owner = NULL,
          lease_until = NULL, retry_after = NULL,
          error = ${TERMINAL_NO_EVIDENCE_RETRY_REASON}
        FROM progressive_work work
        WHERE unit.id = ${unit.id}::uuid
          AND work.id = unit.work_id
          AND unit.state = 'gap'
          AND ${claimEligible}
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
}
