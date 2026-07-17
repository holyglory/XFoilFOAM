import { isAutomaticRansPrecalcHandoffEvidence } from "@aerodb/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { DB } from "./client";
import {
  onResultIngested,
  type CampaignLaneKey,
  type ResultIngestSignal,
} from "./campaign-execution";
import { ensurePrecalcObligationsInTransaction } from "./precalc-obligations";
import {
  resultAttempts,
  resultClassifications,
  results,
  simCampaignConditions,
  simCampaignPoints,
  simCampaigns,
  simPrecalcObligationCampaigns,
} from "./schema";

export interface CampaignResultHandoffSignal extends ResultIngestSignal {
  /** Exact physical job which produced the attempt. Result ids are stable
   * cells and may carry older generations from other jobs. */
  simJobId?: string | null;
  /** Exact generation settled by ingest. Rejected RANS generations are
   * deliberately pointer-null, so current_result_attempt_id is insufficient. */
  resultAttemptId?: string | null;
}

export interface CampaignResultHandoffHooks {
  /** Test-only visibility seam. A separate connection invoked here must still
   * observe the pre-transition campaign state because both the PRECALC owner
   * and terminal progress settlement remain uncommitted. */
  afterPrecalcAttachedBeforeProgress?: () => Promise<void>;
}

interface RansHandoffAttempt {
  id: string;
  state: string;
  failureDisposition: string | null;
  status: string;
  source: string;
  error: string | null;
}

function isAutomaticRansHandoff(attempt: RansHandoffAttempt): boolean {
  return isAutomaticRansPrecalcHandoffEvidence({
    classificationState: attempt.state,
    failureDisposition: attempt.failureDisposition,
    status: attempt.status,
    source: attempt.source,
    error: attempt.error,
  });
}

async function exactRansHandoffAttempt(
  tx: DB,
  signal: CampaignResultHandoffSignal,
): Promise<RansHandoffAttempt | null> {
  if (!signal.revisionId) return null;
  const filters = [
    eq(resultAttempts.resultId, signal.resultId),
    eq(resultAttempts.regime, "rans"),
  ];
  if (signal.resultAttemptId) {
    filters.push(eq(resultAttempts.id, signal.resultAttemptId));
  }
  if (signal.simJobId) {
    filters.push(eq(resultAttempts.simJobId, signal.simJobId));
  }
  const [attempt] = await tx
    .select({
      id: resultAttempts.id,
      state: resultClassifications.state,
      failureDisposition: sql<
        string | null
      >`${resultAttempts.evidencePayload} ->> 'failure_disposition'`,
      status: resultAttempts.status,
      source: resultAttempts.source,
      error: resultAttempts.error,
    })
    .from(resultAttempts)
    .innerJoin(results, eq(results.id, resultAttempts.resultId))
    .innerJoin(
      resultClassifications,
      eq(resultClassifications.resultAttemptId, resultAttempts.id),
    )
    .where(
      and(
        ...filters,
        eq(results.airfoilId, signal.airfoilId),
        eq(results.simulationPresetRevisionId, signal.revisionId),
        eq(results.aoaDeg, signal.aoaDeg),
        eq(resultAttempts.airfoilId, signal.airfoilId),
        eq(resultAttempts.simulationPresetRevisionId, signal.revisionId),
        eq(resultAttempts.aoaDeg, signal.aoaDeg),
        sql`${resultAttempts.simJobId} IS NOT DISTINCT FROM ${results.simJobId}`,
        signal.simJobId
          ? eq(results.simJobId, signal.simJobId)
          : sql`${results.simJobId} IS NULL`,
        sql`NOT EXISTS (
          SELECT 1
          FROM result_attempts newer_attempt
          WHERE newer_attempt.result_id = ${resultAttempts.resultId}
            AND newer_attempt.sim_job_id
                  IS NOT DISTINCT FROM ${resultAttempts.simJobId}
            AND (
              newer_attempt."createdAt" > ${resultAttempts.createdAt}
              OR (
                newer_attempt."createdAt" = ${resultAttempts.createdAt}
                AND newer_attempt.id > ${resultAttempts.id}
              )
            )
        )`,
      ),
    )
    .orderBy(desc(resultAttempts.createdAt), desc(resultAttempts.id))
    .limit(1);
  return attempt && isAutomaticRansHandoff(attempt) ? attempt : null;
}

async function campaignOwnersForCell(
  tx: DB,
  signal: CampaignResultHandoffSignal,
): Promise<string[]> {
  if (!signal.revisionId) return [];
  const rows = await tx
    .selectDistinct({ campaignId: simCampaignPoints.campaignId })
    .from(simCampaignPoints)
    .innerJoin(simCampaigns, eq(simCampaigns.id, simCampaignPoints.campaignId))
    .innerJoin(
      simCampaignConditions,
      eq(simCampaignConditions.id, simCampaignPoints.conditionId),
    )
    .where(
      and(
        eq(simCampaignPoints.airfoilId, signal.airfoilId),
        eq(simCampaignPoints.revisionId, signal.revisionId),
        eq(simCampaignPoints.aoaDeg, signal.aoaDeg),
        eq(simCampaignPoints.derivedBySymmetry, false),
        eq(simCampaignPoints.state, "requested"),
        sql`${simCampaigns.status} IN ('active', 'attention', 'paused')`,
        eq(
          simCampaignConditions.generation,
          simCampaigns.currentConditionGeneration,
        ),
        sql`${simCampaignConditions.status} IN ('active', 'kept')`,
      ),
    );
  return rows.map((row) => row.campaignId).sort();
}

/**
 * Commit the per-point RANS → preliminary-URANS handoff and campaign terminal
 * settlement as one visibility boundary.
 *
 * The obligation helper owns the global owner → natural-cell lock order. Only
 * after it has attached every live campaign owner do we link the terminal
 * result and recompute progress. No engine call occurs inside this transaction;
 * the capacity-bounded ladder submits the durable obligation afterwards.
 */
export async function onResultIngestedWithAutomaticPrecalcHandoff(
  db: DB,
  signal: CampaignResultHandoffSignal,
  hooks: CampaignResultHandoffHooks = {},
): Promise<CampaignLaneKey[]> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const terminal = signal.status === "done" || signal.status === "failed";
    const attempt = terminal ? await exactRansHandoffAttempt(tx, signal) : null;
    if (attempt && signal.revisionId) {
      const campaignIds = await campaignOwnersForCell(tx, signal);
      if (campaignIds.length) {
        const obligations = await ensurePrecalcObligationsInTransaction(
          tx,
          [
            {
              airfoilId: signal.airfoilId,
              revisionId: signal.revisionId,
              aoaDeg: signal.aoaDeg,
              sourceResultId: signal.resultId,
              sourceResultAttemptId: attempt.id,
            },
          ],
          { campaignIds },
        );
        if (obligations.length !== 1) {
          throw new Error(
            `failed to attach automatic PRECALC handoff for ${signal.resultId}: ${campaignIds.length} live campaign owner(s), ${obligations.length} obligation(s)`,
          );
        }
        const attachedOwners = await tx
          .selectDistinct({
            campaignId: simPrecalcObligationCampaigns.campaignId,
          })
          .from(simPrecalcObligationCampaigns)
          .where(
            and(
              eq(simPrecalcObligationCampaigns.obligationId, obligations[0].id),
              inArray(simPrecalcObligationCampaigns.campaignId, campaignIds),
              eq(simPrecalcObligationCampaigns.state, "active"),
            ),
          );
        if (attachedOwners.length !== campaignIds.length) {
          throw new Error(
            `failed to attach every automatic PRECALC owner for ${signal.resultId}: expected ${campaignIds.length}, attached ${attachedOwners.length}`,
          );
        }
        await hooks.afterPrecalcAttachedBeforeProgress?.();
      }
    }
    return onResultIngested(tx, signal);
  });
}
