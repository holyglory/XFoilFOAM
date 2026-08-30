import { sql } from "drizzle-orm";

import type { DB } from "./client";
import { recomputeProgressForPrecalcObligations } from "./campaign-execution";
import { simPrecalcObligationRemediations } from "./schema";

export type PrecalcContractPhysicalAction =
  | "rerun_statistical_mean_contract"
  | "rerun_conservative_numerics"
  | "rerun_fresh";

export interface PrecalcContractEvaluation {
  obligationId: string;
  resultAttemptId: string | null;
  action: PrecalcContractPhysicalAction;
  statisticalMeanScore: number;
}

export interface PrecalcContractRemediationResult {
  eligible: number;
  reopenedWithinExistingBudget: string[];
  grantedAdditionalAttempt: string[];
  skipped: number;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION = /^[0-9a-f]{40}$/;
const ACTIONS = new Set<PrecalcContractPhysicalAction>([
  "rerun_statistical_mean_contract",
  "rerun_conservative_numerics",
  "rerun_fresh",
]);

/**
 * A live classifier verdict is not publication authority.  Suppress a fresh
 * PRECALC recovery only when the result projection selects an accepted
 * immutable interpretation and its append-only canonical-selection event for
 * the exact URANS attempt.  Both callers use the SQL alias `obligation`.
 */
export const hasCanonicalAcceptedUransForObligationSql = sql`EXISTS (
  SELECT 1
  FROM results accepted_result
  JOIN result_attempts accepted_attempt
    ON accepted_attempt.id = accepted_result.current_result_attempt_id
   AND accepted_attempt.result_id = accepted_result.id
  JOIN result_interpretations accepted_interpretation
    ON accepted_interpretation.id = accepted_result.current_result_interpretation_id
   AND accepted_interpretation.result_id = accepted_result.id
   AND accepted_interpretation.result_attempt_id = accepted_attempt.id
   AND accepted_interpretation.state = 'accepted'
  JOIN result_canonical_selections accepted_selection
    ON accepted_selection.id = accepted_result.current_canonical_selection_id
   AND accepted_selection.result_id = accepted_result.id
   AND accepted_selection.result_attempt_id = accepted_attempt.id
   AND accepted_selection.result_interpretation_id = accepted_interpretation.id
  WHERE accepted_result.airfoil_id = obligation.airfoil_id
    AND accepted_result.simulation_preset_revision_id = obligation.revision_id
    AND accepted_result.aoa_deg = obligation.aoa_deg
    AND accepted_attempt.status = 'done'
    AND accepted_attempt.source = 'solved'
    AND (
      accepted_attempt.regime = 'urans'
      OR accepted_attempt.evidence_payload ->> 'fidelity' IN (
        'urans_precalc', 'urans_full'
      )
    )
)`;

function validateEvaluations(
  evaluations: readonly PrecalcContractEvaluation[],
): PrecalcContractEvaluation[] {
  if (evaluations.length > 5_000) {
    throw new Error(
      "precalc remediation is bounded to 5000 evaluations per run",
    );
  }
  const byObligation = new Map<string, PrecalcContractEvaluation>();
  for (const evaluation of evaluations) {
    if (!UUID.test(evaluation.obligationId)) {
      throw new Error(
        `invalid precalc obligation id ${evaluation.obligationId}`,
      );
    }
    if (
      evaluation.resultAttemptId != null &&
      !UUID.test(evaluation.resultAttemptId)
    ) {
      throw new Error(
        `invalid result-attempt id ${evaluation.resultAttemptId}`,
      );
    }
    if (!ACTIONS.has(evaluation.action)) {
      throw new Error(
        `unsupported precalc recovery action ${evaluation.action}`,
      );
    }
    if (
      !Number.isFinite(evaluation.statisticalMeanScore) ||
      evaluation.statisticalMeanScore < 0 ||
      evaluation.statisticalMeanScore > 1
    ) {
      throw new Error("statistical mean score must be within [0, 1]");
    }
    const prior = byObligation.get(evaluation.obligationId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(evaluation)) {
      throw new Error(
        `conflicting evaluations for obligation ${evaluation.obligationId}`,
      );
    }
    byObligation.set(evaluation.obligationId, evaluation);
  }
  return [...byObligation.values()].sort((left, right) =>
    left.obligationId.localeCompare(right.obligationId),
  );
}

function pendingOutcome(action: PrecalcContractPhysicalAction): string {
  if (action === "rerun_statistical_mean_contract") {
    return "aperiodic_contract_retry_pending";
  }
  if (action === "rerun_conservative_numerics") {
    return "numerical_recovery_pending";
  }
  return "fresh_physical_retry_pending";
}

/**
 * Reopen exact blocked PRECALC cells under the new evidence contract.
 *
 * This is not archive restoration: the immutable failed attempt remains
 * untouched. A non-exhausted cell uses its already-promised retry; only an
 * exhausted cell receives one source-pinned remediation grant. Accepted,
 * ownerless, active, stale-evaluation, or already-remediated cells are skipped.
 */
export async function remediatePrecalcEvidenceContract(
  db: DB,
  input: {
    evaluations: readonly PrecalcContractEvaluation[];
    sourceRevision: string;
    execute: boolean;
  },
): Promise<PrecalcContractRemediationResult> {
  if (!REVISION.test(input.sourceRevision)) {
    throw new Error("source revision must be a lowercase 40-character Git SHA");
  }
  const evaluations = validateEvaluations(input.evaluations);
  if (!evaluations.length) {
    return {
      eligible: 0,
      reopenedWithinExistingBudget: [],
      grantedAdditionalAttempt: [],
      skipped: 0,
    };
  }
  const values = sql.join(
    evaluations.map(
      (evaluation) => sql`(
        ${evaluation.obligationId}::uuid,
        ${evaluation.resultAttemptId}::uuid,
        ${evaluation.action}::text,
        ${evaluation.statisticalMeanScore}::float8
      )`,
    ),
    sql`, `,
  );
  const result = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const candidates = (await tx.execute(sql`
      WITH proposed(
        obligation_id,
        result_attempt_id,
        recovery_action,
        statistical_mean_score
      ) AS (VALUES ${values})
      SELECT
        obligation.id,
        obligation.attempt_count,
        obligation.max_attempts,
        proposed.recovery_action,
        proposed.statistical_mean_score
      FROM proposed
      JOIN sim_precalc_obligations obligation
        ON obligation.id = proposed.obligation_id
      JOIN LATERAL (
        SELECT submission.result_attempt_id
        FROM sim_precalc_obligation_attempts submission
        WHERE submission.obligation_id = obligation.id
        ORDER BY submission.attempt_number DESC
        LIMIT 1
      ) latest ON true
      WHERE obligation.state = 'blocked'
        AND latest.result_attempt_id IS NOT DISTINCT FROM proposed.result_attempt_id
        AND obligation.attempt_count <= obligation.max_attempts
        AND NOT EXISTS (
          SELECT 1
          FROM sim_precalc_obligation_remediations prior
          WHERE prior.obligation_id = obligation.id
            AND prior.source_revision = ${input.sourceRevision}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM sim_jobs active_job
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(active_job.request_payload -> 'precalcObligationIds') = 'array'
              THEN active_job.request_payload -> 'precalcObligationIds'
              ELSE '[]'::jsonb
            END
          ) active_owner(id)
          WHERE active_owner.id = obligation.id::text
            AND active_job.status IN ('pending', 'submitted', 'running', 'ingesting')
        )
        AND NOT (${hasCanonicalAcceptedUransForObligationSql})
        AND (
          obligation.background_owner
          OR EXISTS (
            SELECT 1
            FROM sim_precalc_obligation_campaigns ownership
            JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
            WHERE ownership.obligation_id = obligation.id
              AND ownership.state = 'active'
              AND campaign.status IN ('active', 'attention', 'paused')
          )
          OR EXISTS (
            SELECT 1
            FROM sim_precalc_obligation_requests coverage
            JOIN sim_urans_requests request ON request.id = coverage.request_id
            WHERE coverage.obligation_id = obligation.id
              AND request.background_owner
              AND request.state IN ('pending', 'running', 'blocked')
          )
          OR EXISTS (
            SELECT 1
            FROM sync_sweep_promise_points point
            JOIN sync_sweep_promises promise ON promise.id = point.promise_id
            WHERE point.airfoil_id = obligation.airfoil_id
              AND point.simulation_preset_revision_id = obligation.revision_id
              AND point.aoa_deg = obligation.aoa_deg
              AND point.status = 'active'
              AND promise.status = 'active'
              AND promise."expiresAt" > now()
              AND promise.request_payload ->> 'remoteSolver' = 'true'
          )
        )
      ORDER BY obligation.id
      ${input.execute ? sql`FOR UPDATE OF obligation` : sql``}
    `)) as unknown as Array<{
      id: string;
      attempt_count: number;
      max_attempts: number;
      recovery_action: PrecalcContractPhysicalAction;
      statistical_mean_score: number;
    }>;

    if (!input.execute) {
      return {
        candidates,
        reopened: [] as string[],
        granted: [] as string[],
      };
    }

    const reopened: string[] = [];
    const granted: string[] = [];
    for (const candidate of candidates) {
      const outcome = pendingOutcome(candidate.recovery_action);
      if (candidate.attempt_count < candidate.max_attempts) {
        await tx.execute(sql`
          UPDATE sim_precalc_obligations
          SET state = 'pending',
              last_outcome = ${outcome},
              last_error = NULL,
              next_submit_at = now(),
              completed_at = NULL,
              "updatedAt" = now()
          WHERE id = ${candidate.id}
            AND state = 'blocked'
            AND attempt_count < max_attempts
        `);
        reopened.push(candidate.id);
        continue;
      }
      await tx.insert(simPrecalcObligationRemediations).values({
        obligationId: candidate.id,
        sourceRevision: input.sourceRevision,
        reason:
          `URANS evidence contract v14: ${candidate.recovery_action}; ` +
          `retrospective statistical score=${Number(candidate.statistical_mean_score).toFixed(6)}`,
      });
      await tx.execute(sql`
        UPDATE sim_precalc_obligations
        SET last_outcome = ${outcome},
            "updatedAt" = now()
        WHERE id = ${candidate.id}
          AND state = 'pending'
          AND remediation_source_revision = ${input.sourceRevision}
      `);
      granted.push(candidate.id);
    }
    return { candidates, reopened, granted };
  });

  const affected = [...result.reopened, ...result.granted];
  if (input.execute && affected.length) {
    await recomputeProgressForPrecalcObligations(db, affected);
  }
  return {
    eligible: result.candidates.length,
    reopenedWithinExistingBudget: result.reopened,
    grantedAdditionalAttempt: result.granted,
    skipped: evaluations.length - result.candidates.length,
  };
}
