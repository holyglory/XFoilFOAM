import { sql, type SQL } from "drizzle-orm";
import { PROGRESSIVE_COMPUTE_POLICY } from "@aerodb/core";
import type { DB } from "./client";

export const PROGRESSIVE_FAST_BUDGET_EXTENSION_POLICY =
  "progressive-fast-budget-extension-v1" as const;

export const PROGRESSIVE_FAST_BUDGET_EXTENSION_SECONDS =
  PROGRESSIVE_COMPUTE_POLICY.fastBudgetExtensionSeconds;
export const PROGRESSIVE_PRECISE_BUDGET_EXTENSION_SECONDS =
  PROGRESSIVE_COMPUTE_POLICY.preciseInitialActiveSeconds;
export const PROGRESSIVE_URANS_CONTINUATION_MAX_SECONDS =
  PROGRESSIVE_PRECISE_BUDGET_EXTENSION_SECONDS;

const PROGRESSIVE_FAST_BUDGET_RECOVERY_MAX_UNITS = 512;
const PROGRESSIVE_FAST_BUDGET_RECOVERY_REASON =
  "bounded URANS budget continuation admitted";
const PROGRESSIVE_PRECISE_LEGACY_RECOVERY_REASON =
  "bounded precise URANS continuation admitted from retained wall-clock evidence";

export type ProgressiveFastBudgetExtensionRecovery = {
  campaignId: string;
  expectedCount: number;
};

export type ProgressiveFastBudgetExtensionRecoveryResult = {
  candidateCount: number;
  reopenedUnitIds: string[];
  sourceAttemptTokens: string[];
  sourceResultAttemptIds: string[];
};

export function progressiveCfdEffectiveBudgetSql(unit: SQL): SQL {
  return sql`${unit}.active_budget_seconds + COALESCE((
    SELECT extension.extension_seconds
    FROM progressive_cfd_budget_extensions extension
    WHERE extension.unit_id = ${unit}.id
      AND extension.state IN ('pending', 'claimed', 'consumed')
  ), 0)`;
}

export function progressiveCfdBudgetExtensionPendingSql(unit: SQL): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM progressive_cfd_budget_extensions extension
    WHERE extension.unit_id = ${unit}.id AND extension.state = 'pending'
  )`;
}

export async function admitProgressiveCfdBudgetExtension(
  db: DB,
  input: { unitId: string; attemptToken: string },
): Promise<boolean> {
  const [candidate] = await db.execute(sql`
    SELECT unit.id, work.stage, receipt.result_attempt_id, receipt.evidence_signature,
      raw.engine_job_id, raw.engine_case_slug
    FROM progressive_cfd_units unit
    JOIN progressive_work work ON work.id = unit.work_id
    JOIN progressive_generations generation ON generation.id = work.generation_id
    JOIN progressive_cfd_attempts source_attempt
      ON source_attempt.token = ${input.attemptToken}::uuid
      AND source_attempt.unit_id = unit.id
    JOIN progressive_cfd_evidence receipt
      ON receipt.attempt_token = source_attempt.token
    JOIN result_attempts raw ON raw.id = receipt.result_attempt_id
      AND raw.sim_job_id = source_attempt.sim_job_id
    WHERE unit.id = ${input.unitId}::uuid
      AND (
        (work.stage = 2 AND unit.purpose = 'initial'
          AND raw.evidence_payload->>'fidelity' = 'urans_precalc')
        OR
        (work.stage = 3 AND unit.purpose = 'precise'
          AND raw.evidence_payload->>'fidelity' = 'urans_full')
      )
      AND generation.status = 'active'
      AND source_attempt.outcome IN ('running', 'failed')
      AND source_attempt.active_seconds > 0
      AND unit.attempts = 2
      AND unit.active_seconds >= unit.active_budget_seconds
      AND raw.engine_job_id IS NOT NULL
      AND raw.engine_case_slug IS NOT NULL
      AND (
        raw.error ILIKE '%stopped by the wall-clock budget guard%'
        OR raw.quality_warnings @> ARRAY['stopped by the wall-clock budget guard']::text[]
      )
      AND jsonb_typeof(raw.evidence_payload->'force_history') = 'object'
      AND NOT EXISTS (
        SELECT 1 FROM progressive_cfd_budget_extensions existing
        WHERE existing.unit_id = unit.id
      )
    ORDER BY raw."createdAt" DESC, raw.id DESC
    LIMIT 1
    FOR UPDATE OF unit, source_attempt
  `);
  if (!candidate) return false;
  const extensionSeconds =
    Number(candidate.stage) === 3
      ? PROGRESSIVE_PRECISE_BUDGET_EXTENSION_SECONDS
      : PROGRESSIVE_FAST_BUDGET_EXTENSION_SECONDS;
  const policyVersion =
    Number(candidate.stage) === 3
      ? "progressive-precise-budget-extension-v1"
      : PROGRESSIVE_FAST_BUDGET_EXTENSION_POLICY;
  const [inserted] = await db.execute(sql`
    INSERT INTO progressive_cfd_budget_extensions
      (unit_id, source_attempt_token, source_result_attempt_id, source_evidence_signature,
       source_engine_job_id, source_engine_case_slug, extension_seconds, policy_version)
    VALUES (${candidate.id}::uuid, ${input.attemptToken}::uuid,
      ${candidate.result_attempt_id}::uuid, ${candidate.evidence_signature},
      ${candidate.engine_job_id}, ${candidate.engine_case_slug},
      ${extensionSeconds}, ${policyVersion})
    ON CONFLICT (unit_id) DO NOTHING
    RETURNING unit_id
  `);
  return Boolean(inserted);
}

export async function recoverProgressiveFastBudgetExtensions(
  db: DB,
  input: ProgressiveFastBudgetExtensionRecovery,
): Promise<ProgressiveFastBudgetExtensionRecoveryResult> {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.campaignId) ||
    !Number.isSafeInteger(input.expectedCount) ||
    input.expectedCount < 1 ||
    input.expectedCount > PROGRESSIVE_FAST_BUDGET_RECOVERY_MAX_UNITS
  )
    throw new Error(
      "FAST budget recovery requires an exact campaign UUID and bounded expected count",
    );

  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const candidates = await connection.execute(sql`
      SELECT unit.id, unit.work_id, source.attempt_token, source.result_attempt_id
      FROM progressive_cfd_units unit
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      JOIN polar_analysis_targets target ON target.id = work.target_id
      JOIN LATERAL (
        SELECT source_attempt.token AS attempt_token,
          receipt.result_attempt_id,
          source_attempt.outcome,
          source_attempt.active_seconds AS attempt_active_seconds,
          raw.engine_job_id,
          raw.engine_case_slug,
          raw.error AS raw_error,
          raw.quality_warnings,
          raw.evidence_payload
        FROM progressive_cfd_attempts source_attempt
        JOIN progressive_cfd_evidence receipt
          ON receipt.attempt_token = source_attempt.token
        JOIN result_attempts raw
          ON raw.id = receipt.result_attempt_id
          AND raw.sim_job_id = source_attempt.sim_job_id
        WHERE source_attempt.unit_id = unit.id
          AND NOT EXISTS (
            SELECT 1
            FROM progressive_cfd_attempts newer
            WHERE newer.unit_id = source_attempt.unit_id
              AND (newer.started_at, newer.token) >
                (source_attempt.started_at, source_attempt.token)
          )
        ORDER BY raw."createdAt" DESC, raw.id DESC
        LIMIT 1
      ) source ON true
      LEFT JOIN progressive_cfd_budget_extensions existing
        ON existing.unit_id = unit.id
      WHERE generation.campaign_id = ${input.campaignId}::uuid
        AND epoch.current
        AND generation.status = 'active'
        AND generation.plan_revision_id = campaign.current_plan_revision_id
        AND campaign.status IN ('active', 'attention', 'paused')
        AND work.stage = 2
        AND work.state IN ('pending', 'gap')
        AND target.mach < 1.0
        AND unit.purpose = 'initial'
        AND unit.state = 'gap'
        AND unit.error = 'active compute budget exhausted'
        AND source.outcome IN ('running', 'failed')
        AND source.attempt_active_seconds > 0
        AND unit.attempts = 2
        AND unit.active_seconds >= unit.active_budget_seconds
        AND source.engine_job_id IS NOT NULL
        AND source.engine_case_slug IS NOT NULL
        AND source.evidence_payload->>'fidelity' = 'urans_precalc'
        AND (
          source.raw_error ILIKE '%stopped by the wall-clock budget guard%'
          OR source.quality_warnings @> ARRAY['stopped by the wall-clock budget guard']::text[]
        )
        AND jsonb_typeof(source.evidence_payload->'force_history') = 'object'
        AND existing.unit_id IS NULL
      ORDER BY unit.id
      FOR UPDATE OF unit
    `);
    if (candidates.length !== input.expectedCount)
      throw new Error(
        `FAST budget recovery candidate count changed: expected ${input.expectedCount}, found ${candidates.length}`,
      );

    const reopenedUnitIds: string[] = [];
    const sourceAttemptTokens: string[] = [];
    const sourceResultAttemptIds: string[] = [];
    for (const candidate of candidates) {
      const unitId = String(candidate.id);
      const attemptToken = String(candidate.attempt_token);
      const admitted = await admitProgressiveCfdBudgetExtension(connection, {
        unitId,
        attemptToken,
      });
      if (!admitted)
        throw new Error(
          `FAST budget recovery candidate changed before extension admission: ${unitId}`,
        );
      const [reopened] = await connection.execute(sql`
        UPDATE progressive_cfd_units
        SET state = 'pending', retry_after = NULL,
          lease_token = NULL, lease_owner = NULL, lease_until = NULL,
          error = ${PROGRESSIVE_FAST_BUDGET_RECOVERY_REASON}
        WHERE id = ${unitId}::uuid
          AND state = 'gap'
          AND error = 'active compute budget exhausted'
        RETURNING id
      `);
      if (!reopened)
        throw new Error(
          `FAST budget recovery unit changed before requeue: ${unitId}`,
        );
      await connection.execute(sql`
        UPDATE progressive_work
        SET state = 'pending', error = NULL, completed_at = NULL
        WHERE id = ${candidate.work_id}::uuid AND state = 'gap'
      `);
      reopenedUnitIds.push(unitId);
      sourceAttemptTokens.push(attemptToken);
      sourceResultAttemptIds.push(String(candidate.result_attempt_id));
    }
    return {
      candidateCount: candidates.length,
      reopenedUnitIds,
      sourceAttemptTokens,
      sourceResultAttemptIds,
    };
  });
}

export async function recoverProgressivePreciseBudgetExtensions(
  db: DB,
  input: { campaignId: string; expectedCount: number },
) {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.campaignId) ||
    !Number.isSafeInteger(input.expectedCount) ||
    input.expectedCount < 1 ||
    input.expectedCount > 512
  )
    throw new Error(
      "Precise budget recovery requires an exact campaign UUID and bounded expected count",
    );

  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const candidates = await connection.execute(sql`
      SELECT unit.id, work.id AS work_id, source.attempt_token,
        source.result_attempt_id, source.evidence_signature,
        source.engine_job_id, source.engine_case_slug
      FROM progressive_cfd_units unit
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      JOIN LATERAL (
        SELECT source_attempt.token AS attempt_token,
          receipt.result_attempt_id, receipt.evidence_signature,
          raw.engine_job_id, raw.engine_case_slug,
          source_attempt.started_at
        FROM progressive_cfd_attempts source_attempt
        JOIN progressive_cfd_evidence receipt
          ON receipt.attempt_token = source_attempt.token
        JOIN result_attempts raw
          ON raw.id = receipt.result_attempt_id
          AND raw.sim_job_id = source_attempt.sim_job_id
        JOIN sim_jobs source_job ON source_job.id = source_attempt.sim_job_id
        WHERE source_attempt.unit_id = unit.id
          AND source_attempt.outcome = 'failed'
          AND source_job.status IN ('done', 'failed', 'cancelled')
          AND source_job."ingestedAt" IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM progressive_cfd_execution_stops stopped
            WHERE stopped.sim_job_id = source_job.id
              AND stopped.engine_job_id = source_job.engine_job_id
          )
          AND raw.evidence_payload->>'fidelity' = 'urans_full'
          AND raw.engine_job_id IS NOT NULL
          AND raw.engine_case_slug IS NOT NULL
          AND (
            raw.error ILIKE '%stopped by the wall-clock budget guard%'
            OR raw.quality_warnings @> ARRAY['stopped by the wall-clock budget guard']::text[]
          )
          AND jsonb_typeof(raw.evidence_payload->'force_history') = 'object'
          AND NOT EXISTS (
            SELECT 1 FROM result_classifications classification
            WHERE classification.result_attempt_id = raw.id
              AND classification.state = 'accepted'
          )
        ORDER BY source_attempt.started_at DESC, source_attempt.token DESC
        LIMIT 1
      ) source ON true
      WHERE campaign.id = ${input.campaignId}::uuid
        AND epoch.current AND generation.status = 'active'
        AND generation.plan_revision_id = campaign.current_plan_revision_id
        AND campaign.status IN ('active', 'attention', 'paused')
        AND work.stage = 3 AND work.state IN ('pending', 'gap')
        AND unit.purpose = 'precise' AND unit.state = 'gap'
        AND unit.attempts BETWEEN 2 AND 4
        AND unit.lease_token IS NULL AND unit.lease_owner IS NULL
        AND unit.lease_until IS NULL AND source.attempt_token IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_budget_extensions existing
          WHERE existing.unit_id = unit.id
        )
      ORDER BY unit.id
      FOR UPDATE OF unit
    `);
    if (candidates.length !== input.expectedCount)
      throw new Error(
        `Precise budget recovery candidate count changed: expected ${input.expectedCount}, found ${candidates.length}`,
      );
    const reopenedUnitIds: string[] = [];
    for (const candidate of candidates) {
      const unitId = String(candidate.id);
      await connection.execute(sql`
        INSERT INTO progressive_cfd_budget_extensions
          (unit_id, source_attempt_token, source_result_attempt_id,
           source_evidence_signature, source_engine_job_id, source_engine_case_slug,
           extension_seconds, policy_version)
        VALUES (${unitId}::uuid, ${candidate.attempt_token}::uuid,
          ${candidate.result_attempt_id}::uuid, ${candidate.evidence_signature},
          ${candidate.engine_job_id}, ${candidate.engine_case_slug},
          ${PROGRESSIVE_PRECISE_BUDGET_EXTENSION_SECONDS},
          'progressive-precise-budget-legacy-recovery-v1')
        ON CONFLICT (unit_id) DO NOTHING
      `);
      const [reopened] = await connection.execute(sql`
        UPDATE progressive_cfd_units
        SET state = 'pending', retry_after = NULL,
          lease_token = NULL, lease_owner = NULL, lease_until = NULL,
          error = ${PROGRESSIVE_PRECISE_LEGACY_RECOVERY_REASON}
        WHERE id = ${unitId}::uuid AND state = 'gap'
        RETURNING id
      `);
      if (!reopened)
        throw new Error(`Precise budget recovery unit changed before requeue: ${unitId}`);
      await connection.execute(sql`
        UPDATE progressive_work SET state = 'pending', error = NULL, completed_at = NULL
        WHERE id = ${candidate.work_id}::uuid AND state = 'gap'
      `);
      reopenedUnitIds.push(unitId);
    }
    return { candidateCount: candidates.length, reopenedUnitIds };
  });
}
