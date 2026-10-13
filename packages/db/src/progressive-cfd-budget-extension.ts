import { sql, type SQL } from "drizzle-orm";
import { PROGRESSIVE_COMPUTE_POLICY } from "@aerodb/core";
import type { DB } from "./client";

export const PROGRESSIVE_FAST_BUDGET_EXTENSION_POLICY =
  "progressive-fast-budget-extension-v1" as const;

export const PROGRESSIVE_FAST_BUDGET_EXTENSION_SECONDS =
  PROGRESSIVE_COMPUTE_POLICY.fastBudgetExtensionSeconds;

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
    SELECT unit.id, receipt.result_attempt_id, receipt.evidence_signature,
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
      AND work.stage = 2 AND unit.purpose = 'initial'
      AND generation.status = 'active'
      AND source_attempt.outcome IN ('running', 'failed')
      AND source_attempt.active_seconds > 0
      AND unit.attempts = 2
      AND unit.active_seconds >= unit.active_budget_seconds
      AND raw.evidence_payload->>'fidelity' = 'urans_precalc'
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
  const [inserted] = await db.execute(sql`
    INSERT INTO progressive_cfd_budget_extensions
      (unit_id, source_attempt_token, source_result_attempt_id, source_evidence_signature,
       source_engine_job_id, source_engine_case_slug, extension_seconds, policy_version)
    VALUES (${candidate.id}::uuid, ${input.attemptToken}::uuid,
      ${candidate.result_attempt_id}::uuid, ${candidate.evidence_signature},
      ${candidate.engine_job_id}, ${candidate.engine_case_slug},
      ${PROGRESSIVE_FAST_BUDGET_EXTENSION_SECONDS},
      ${PROGRESSIVE_FAST_BUDGET_EXTENSION_POLICY})
    ON CONFLICT (unit_id) DO NOTHING
    RETURNING unit_id
  `);
  return Boolean(inserted);
}
